/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * Game WebSocket server - protocol-compatible with the frontend's
 * LiveSession class (src/store/socket.js).
 *
 * Responsibilities:
 *  - room membership and host authorization (stSecret)
 *  - admission checks: request/checkAllowHost, request/checkAllowJoin
 *  - message routing: direct (unicast, possibly multi-target), request
 *    (server commands), broadcast (everything else)
 *  - reliable-delivery bookkeeping: stores messages carrying a feedback id
 *    and forwards "feedback" acknowledgements for request/deleteMessage
 *  - latency measurement and ping relay
 *  - avatar upload over WebSocket (uploadFile/uploadAvatar)
 *
 * It holds NO game state; all game logic lives on the clients.
 */
const { WebSocketServer } = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  GAME_PORT,
  PING_INTERVAL_MS,
  WS_MAX_PAYLOAD,
  AVATAR_DIR,
  MAX_AVATAR_BASE64_LENGTH,
  RESERVED_IDS,
} = require("./config");
const { saveAvatar } = require("./avatarStore");

function send(ws, command, params, feedback = false) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify([command, params, feedback]));
  }
}

// Send a pre-serialized payload: use when the same message goes to several
// clients so JSON.stringify runs once instead of once per recipient.
function sendRaw(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(data);
  }
}

class GameServer {
  constructor(roomManager, kook = null) {
    this.roomManager = roomManager;
    // Reliable-delivery store: `${targetId}:${feedbackId}` ->
    //   { to, from, message }
    this.pending = new Map();
    // Recently processed uploadFile feedback ids (dedupe resends)
    this.processedUploads = new Map(); // id -> timestamp
    this.wss = null;
    // KOOK voice integration (optional KookService; may be null/disabled)
    this.kook = kook;
    // roomId -> { voice, listener } for rooms bound to a KOOK guild
    this._kookRooms = new Map();
    this.roomManager.on("roomRemoved", (id) => this._detachKook(id));
  }

  /**
   * Create the WebSocketServer in noServer mode so it can be attached to
   * any HTTP server (own port via start(), or shared via standalone.js).
   */
  createWss() {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: WS_MAX_PAYLOAD,
    });
    this.wss.on("connection", (ws, req) => this._onConnection(ws, req));

    // measure latency of every connection with protocol-level pings
    const interval = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.pingSentAt = Date.now();
        ws.ping();
      }
    }, PING_INTERVAL_MS);
    this.wss.on("close", () => clearInterval(interval));
    return this.wss;
  }

  /** Attach this WSS to an upgrade event of an existing HTTP server. */
  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  start(port = GAME_PORT) {
    this.createWss();
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head)
    );
    server.listen(port, () => {
      console.log(`[game] WebSocket server listening on :${port}`);
    });
    return this.wss;
  }

  _onConnection(ws, req) {
    const url = new URL(req.url, "http://localhost");
    // accept both "/{channel}/{playerId}[...]" and "/ws/{channel}/{playerId}[...]"
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments[0] === "ws") segments.shift();
    const [channel, playerId, roleSegment] = segments;
    const isHostPath = roleSegment === "host";
    const stSecret = url.searchParams.get("auth") || "";

    // --- validate -------------------------------------------------------
    const channelNum = Number(channel);
    if (
      !channel ||
      !Number.isInteger(channelNum) ||
      channelNum < 1 ||
      channelNum > 10000 ||
      !playerId ||
      RESERVED_IDS.has(playerId) ||
      (isHostPath && !stSecret)
    ) {
      // close with 1000 so the frontend does not auto-reconnect (it only
      // reconnects on codes other than 1000) and displays `reason`
      ws.close(1000, "无效的房间号或玩家ID");
      return;
    }

    ws.isAlive = true;
    ws.pingSentAt = 0;
    ws.latency = 0;
    ws.on("pong", () => {
      ws.isAlive = true;
      if (ws.pingSentAt) ws.latency = Date.now() - ws.pingSentAt;
    });
    ws.on("error", (err) => {
      // a single misbehaving client must never crash the process
      console.error(`[game] ws error (${playerId}@${channel}):`, err.message);
    });

    const room = this.roomManager.getOrCreate(channel);
    ws.meta = {
      roomId: channel,
      playerId,
      isHost: false,
      isHostCandidate: isHostPath,
      stSecret,
    };

    if (isHostPath) {
      // promote immediately when possible; otherwise stay connected as a
      // candidate so checkAllowHost can be answered
      this.roomManager.claimHost(room, ws, playerId, stSecret);
      ws.meta.isHost = room.host === ws;
    } else {
      this.roomManager.addPlayer(room, playerId, ws);
      // redeliver any stored messages for this player
      for (const [key, record] of this.pending) {
        if (record.to === playerId && record.message) {
          send(ws, ...record.message);
          this.pending.set(key, { ...record, message: null });
        }
      }
    }

    // KOOK voice state is server-held: push it to every new connection
    this._pushKookState(ws, room);

    ws.on("message", (data) => {
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch (err) {
        return; // ignore malformed messages
      }
      if (!Array.isArray(parsed)) return;
      const [command, params, feedback] = parsed;
      try {
        this._onMessage(ws, room, command, params, feedback);
      } catch (err) {
        console.error(`[game] error handling "${command}":`, err);
      }
    });

    ws.on("close", () => this._onClose(ws, room));
  }

  _onMessage(ws, room, command, params, feedback) {
    switch (command) {
      case "direct":
        return this._handleDirect(room, ws, params, feedback);
      case "request":
        return this._handleRequest(room, ws, params);
      case "uploadFile":
        return this._handleUploadFile(room, ws, params, feedback);
      case "ping":
        return this._handlePing(room, ws, params);
      default:
        // everything else is a room broadcast (excluding the sender)
        return this._broadcast(room, ws, [command, params, feedback]);
    }
  }

  // --- direct: { targetId: [command, params], ... } ---------------------
  // "host" resolves to the room's host. Each entry is unwrapped and
  // delivered to its target as [command, params, feedback].
  _handleDirect(room, ws, payload, feedback) {
    if (!payload || typeof payload !== "object") return;
    const from = ws.meta.playerId;
    for (const [target, message] of Object.entries(payload)) {
      if (!Array.isArray(message)) continue;
      const [command, params] = message;
      const targetId = target === "host" ? room.hostPlayerId : target;
      const targetWs =
        target === "host"
          ? room.host
          : room.hostPlayerId === target
          ? room.host
          : room.players.get(target);
      const envelope = [command, params, feedback];
      const delivered = targetWs && targetWs.readyState === 1;
      if (delivered) {
        send(targetWs, ...envelope);
      }
      if (feedback && targetId) {
        // Track the message so that request/deleteMessage from the target
        // can acknowledge the sender; if the target is offline, keep the
        // envelope for redelivery on reconnect.
        this.pending.set(`${targetId}:${feedback}`, {
          to: targetId,
          from,
          message: delivered ? null : envelope,
        });
        // bound the store, evict oldest entries first
        if (this.pending.size > 1000) {
          const oldest = this.pending.keys().next().value;
          this.pending.delete(oldest);
        }
      }
    }
  }

  // --- request: { command: [playerId, params] } --------------------------
  _handleRequest(room, ws, payload) {
    if (!payload || typeof payload !== "object") return;
    const [command, data] = Object.entries(payload)[0] || [];
    if (!command) return;
    const [, reqParams] = Array.isArray(data) ? data : [];
    switch (command) {
      case "checkAllowHost": {
        let allow = room.host === ws;
        if (!allow && ws.meta.isHostCandidate) {
          allow = this.roomManager.claimHost(
            room,
            ws,
            ws.meta.playerId,
            ws.meta.stSecret
          );
          ws.meta.isHost = allow;
        }
        send(ws, "allowHost", allow);
        break;
      }
      case "checkAllowJoin": {
        send(ws, "allowJoin", room.hasActiveHost());
        break;
      }
      case "deleteMessage": {
        // params: [queueType, feedbackId] sent by the acknowledging client
        const [, feedbackId] = Array.isArray(reqParams) ? reqParams : [];
        if (!feedbackId) return;
        const key = `${ws.meta.playerId}:${feedbackId}`;
        const record = this.pending.get(key);
        if (!record) return;
        this.pending.delete(key);
        // tell the original sender it can stop resending
        const sender =
          record.from === room.hostPlayerId
            ? room.host
            : room.players.get(record.from);
        send(sender, "feedback", feedbackId);
        break;
      }
      case "dissolveRoom":
        return this._dissolveRoom(room, ws);
      // --- KOOK voice integration ---------------------------------------
      case "kookBind":
        return this._kookBind(room, ws, reqParams);
      case "kookUnbind":
        return this._kookUnbind(room, ws);
      case "kookBindUser":
        return this._kookBindUser(room, ws, reqParams);
      case "kookUnbindUser":
        return this._kookUnbindUser(room, ws);
      case "kookMove":
        return this._kookMove(room, ws, reqParams);
      case "kookMoveAll":
        return this._kookMoveAll(room, ws, reqParams);
      case "kookMute":
        return this._kookMute(room, ws, reqParams);
      case "kookSetCategory":
        return this._kookSetCategory(room, ws, reqParams);
      case "kookSetMainChannel":
        return this._kookSetMainChannel(room, ws, reqParams);
      case "kookInvite":
        return this._kookInvite(room, ws, reqParams);
      case "kookSetToken":
        return this._kookSetToken(room, ws, reqParams);
      case "kookSync":
        return this._pushKookState(ws, room);
      default:
        // unknown server-side request: ignore
        break;
    }
  }

  // --- uploadFile: { "uploadAvatar": [playerId, dataUrl] } ---------------
  _handleUploadFile(room, ws, payload, feedback) {
    if (!payload || typeof payload !== "object") return;
    const [command, data] = Object.entries(payload)[0] || [];
    if (command !== "uploadAvatar" || !Array.isArray(data)) return;
    const [playerId, dataUrl] = data;
    if (playerId !== ws.meta.playerId || typeof dataUrl !== "string") return;
    if (feedback) {
      const now = Date.now();
      const seen = this.processedUploads.get(feedback);
      if (seen && now - seen < 10 * 60 * 1000) return;
      this.processedUploads.set(feedback, now);
      // bound the dedupe store: sweep expired entries once it grows large
      if (this.processedUploads.size > 1000) {
        const cutoff = now - 10 * 60 * 1000;
        for (const [id, ts] of this.processedUploads) {
          if (ts < cutoff) this.processedUploads.delete(id);
        }
      }
    }
    if (dataUrl.length > MAX_AVATAR_BASE64_LENGTH + 64) return;
    const filename = saveAvatar(playerId, dataUrl);
    if (filename) send(ws, "avatarReceived", filename, feedback);
  }

  // --- ping: [playerIdOrCount, "latency"] --------------------------------
  // Player pings are relayed to the host only, host pings to all players.
  // The "latency" placeholder is replaced with the measured latency of the
  // sender's connection.
  _handlePing(room, ws, params) {
    const [idOrCount] = Array.isArray(params) ? params : [0];
    send(ws, "pong");
    // serialize once for all relay targets
    const relayed = JSON.stringify(["ping", [idOrCount, ws.latency || 0]]);
    if (ws.meta.isHost) {
      for (const playerWs of room.players.values()) {
        sendRaw(playerWs, relayed);
      }
    } else if (room.hasActiveHost()) {
      sendRaw(room.host, relayed);
    }
  }

  _broadcast(room, ws, envelope) {
    // serialize once for the whole room instead of once per recipient
    const data = JSON.stringify(envelope);
    if (room.host && room.host !== ws) sendRaw(room.host, data);
    for (const playerWs of room.players.values()) {
      if (playerWs !== ws) sendRaw(playerWs, data);
    }
  }

  /** Broadcast an envelope to everyone in the room, sender included. */
  _broadcastRoom(room, envelope) {
    const data = JSON.stringify(envelope);
    if (room.host) sendRaw(room.host, data);
    for (const playerWs of room.players.values()) {
      sendRaw(playerWs, data);
    }
  }

  // --- KOOK voice integration -------------------------------------------

  _kookVoiceOf(room) {
    if (!room.kookGuildId || !this.kook) return null;
    return this.kook.voices.get(room.kookGuildId) || null;
  }

  /** Push the current KOOK binding + voice state to one connection. */
  _pushKookState(ws, room) {
    const voice = this._kookVoiceOf(room);
    if (!voice) return;
    send(ws, "kookBound", {
      guildId: room.kookGuildId,
      guildName: voice.name,
      guildIcon: voice.icon,
      categoryId: room.kookCategoryId,
      mainChannelId: room.kookMainChannelId,
    });
    send(ws, "kookBindings", Object.fromEntries(room.kookBindings));
    // remind the client of its own binding (e.g. after a page refresh)
    const boundId = room.kookBindings.get(ws.meta.playerId);
    if (boundId) {
      const u = voice.users.get(boundId);
      send(ws, "kookBoundUser", {
        id: boundId,
        username: (u && u.username) || "",
        nickname: (u && u.nickname) || "",
        avatar: (u && u.avatar) || "",
        identify_num: (u && u.identify_num) || "",
      });
    }
    if (voice.ready) send(ws, "kookVoice", voice.snapshot(room.kookCategoryId));
  }

  _detachKook(roomId) {
    const entry = this._kookRooms.get(roomId);
    if (!entry) return;
    entry.voice.off("change", entry.listener);
    this._kookRooms.delete(roomId);
  }

  /** request/kookBind: { guildId } - bind the room to a KOOK guild. */
  async _kookBind(room, ws, params) {
    if (!ws.meta.isHost) {
      return send(ws, "kookError", {
        op: "bind",
        message: "仅说书人可以绑定 KOOK 服务器",
      });
    }
    if (!this.kook || !this.kook.enabled()) {
      return send(ws, "kookError", {
        op: "bind",
        code: "NO_TOKEN",
        message: "后端未配置 KOOK_BOT_TOKEN",
      });
    }
    const guildId = String((params && params.guildId) || "").trim();
    if (!guildId) {
      return send(ws, "kookError", { op: "bind", message: "缺少 KOOK 服务器 ID" });
    }
    try {
      const voice = await this.kook.getVoice(guildId);
      this._detachKook(room.id);
      room.kookGuildId = guildId;
      room.kookCategoryId = null;
      room.kookMainChannelId = null;
      room.kookAutoMoved.clear();
      const listener = () => {
        if (voice.ready) {
          this._broadcastRoom(room, [
            "kookVoice",
            voice.snapshot(room.kookCategoryId),
          ]);
          this._kookAutoPull(room, voice);
        }
      };
      voice.on("change", listener);
      this._kookRooms.set(room.id, { voice, listener });
      this._broadcastRoom(room, [
        "kookBound",
        {
          guildId,
          guildName: voice.name,
          guildIcon: voice.icon,
          categoryId: null,
          mainChannelId: null,
        },
      ]);
      this._broadcastRoom(room, [
        "kookBindings",
        Object.fromEntries(room.kookBindings),
      ]);
      listener();
    } catch (err) {
      send(ws, "kookError", { op: "bind", message: `绑定失败:${err.message}` });
    }
  }

  /** request/dissolveRoom - the active storyteller dissolves the room. */
  _dissolveRoom(room, ws) {
    if (!ws.meta.isHost || room.host !== ws) return;
    this.roomManager.dissolve(room);
  }

  /** request/kookUnbind - remove the room's KOOK binding. */
  _kookUnbind(room, ws) {
    if (!ws.meta.isHost) {
      return send(ws, "kookError", { op: "unbind", message: "仅说书人可以解绑" });
    }
    this._detachKook(room.id);
    room.kookGuildId = null;
    room.kookCategoryId = null;
    room.kookMainChannelId = null;
    room.kookAutoMoved.clear();
    room.kookBindings.clear();
    this._broadcastRoom(room, ["kookBound", null]);
  }

  /**
   * request/kookSetToken: { token } - set/replace the server-wide KOOK bot
   * token from the web UI (host only). The token never leaves the backend:
   * the ack only reports whether a token is configured and whether it could
   * be verified against the KOOK API. An empty token disables the
   * integration.
   */
  async _kookSetToken(room, ws, params) {
    if (!ws.meta.isHost) {
      return send(ws, "kookError", {
        op: "setToken",
        message: "仅说书人可以设置机器人 Token",
      });
    }
    const token = String((params && params.token) || "").trim();
    if (token.length > 128) {
      return send(ws, "kookError", { op: "setToken", message: "Token 长度异常" });
    }
    try {
      const result = await this.kook.setToken(token);
      send(ws, "kookTokenSet", result);
    } catch (err) {
      send(ws, "kookError", {
        op: "setToken",
        message: `Token 校验失败:${err.message}`,
      });
    }
  }

  /**
   * request/kookSetCategory: { categoryId } - restrict this room's voice
   * panel and voice operations to channels under one category (host).
   * Empty/null lifts the restriction.
   */
  _kookSetCategory(room, ws, params) {
    if (!ws.meta.isHost) {
      return send(ws, "kookError", {
        op: "setCategory",
        message: "仅说书人可以设置分组",
      });
    }
    const voice = this._kookVoiceOf(room);
    if (!voice) {
      return send(ws, "kookError", {
        op: "setCategory",
        message: "房间尚未绑定 KOOK 服务器",
      });
    }
    const categoryId = String((params && params.categoryId) || "") || null;
    if (categoryId) {
      const cat = voice.channels.get(categoryId);
      if (!cat || !cat.isCategory) {
        return send(ws, "kookError", {
          op: "setCategory",
          message: "目标分组不存在",
        });
      }
    }
    room.kookCategoryId = categoryId;
    // the main channel belongs to the category; drop it when the category
    // is lifted or changed to one the main channel is not part of
    if (room.kookMainChannelId) {
      const main = voice.channels.get(room.kookMainChannelId);
      if (!categoryId || !main || main.parentId !== categoryId) {
        room.kookMainChannelId = null;
      }
    }
    this._broadcastRoom(room, [
      "kookBound",
      {
        guildId: room.kookGuildId,
        guildName: voice.name,
        guildIcon: voice.icon,
        categoryId,
        mainChannelId: room.kookMainChannelId,
      },
    ]);
    if (voice.ready) {
      this._broadcastRoom(room, ["kookVoice", voice.snapshot(categoryId)]);
    }
  }

  /**
   * request/kookSetMainChannel: { channelId } - designate the main voice
   * channel of the selected category (host). Newly bound players entering a
   * voice channel of the category are auto-pulled into it. Empty/null clears
   * the designation.
   */
  _kookSetMainChannel(room, ws, params) {
    if (!ws.meta.isHost) {
      return send(ws, "kookError", {
        op: "setMainChannel",
        message: "仅说书人可以设置主频道",
      });
    }
    const voice = this._kookVoiceOf(room);
    if (!voice) {
      return send(ws, "kookError", {
        op: "setMainChannel",
        message: "房间尚未绑定 KOOK 服务器",
      });
    }
    if (!room.kookCategoryId) {
      return send(ws, "kookError", {
        op: "setMainChannel",
        message: "请先选择频道分组",
      });
    }
    const channelId = String((params && params.channelId) || "") || null;
    if (channelId) {
      const channel = voice.channels.get(channelId);
      if (!channel || channel.isCategory) {
        return send(ws, "kookError", {
          op: "setMainChannel",
          message: "目标语音频道不存在",
        });
      }
      if (channel.parentId !== room.kookCategoryId) {
        return send(ws, "kookError", {
          op: "setMainChannel",
          message: "主频道必须属于所选分组",
        });
      }
    }
    room.kookMainChannelId = channelId;
    this._broadcastRoom(room, [
      "kookBound",
      {
        guildId: room.kookGuildId,
        guildName: voice.name,
        guildIcon: voice.icon,
        categoryId: room.kookCategoryId,
        mainChannelId: channelId,
      },
    ]);
    // pull bound users who are already inside the category but never got
    // pulled (e.g. they joined a sub-channel before the main channel existed)
    if (channelId) this._kookAutoPull(room, voice);
  }

  /**
   * Pull every bound user who enters a voice channel of the selected
   * category into the main channel - once per binding (the first entry).
   */
  _kookAutoPull(room, voice) {
    if (!room.kookMainChannelId || !room.kookCategoryId) return;
    for (const kookId of new Set(room.kookBindings.values())) {
      if (room.kookAutoMoved.has(kookId)) continue;
      const cid = voice.channelOfUser(kookId);
      if (!cid) continue; // not in any voice channel yet
      const channel = voice.channels.get(cid);
      if (!channel || channel.parentId !== room.kookCategoryId) continue;
      room.kookAutoMoved.add(kookId);
      if (cid === room.kookMainChannelId) continue; // already in the main channel
      this.kook.api
        .moveUsers(room.kookMainChannelId, [kookId])
        .then(() => voice.moveLocal(kookId, room.kookMainChannelId))
        .catch((err) =>
          console.error("[kook] auto-pull to main channel failed:", err.message)
        );
    }
  }

  /**
   * request/kookInvite: { channelId, playerIds } - invite players who are
   * currently in the main channel to another channel of the category. Every
   * invitee receives a "kookInvite" message naming the inviter, the channel
   * and all fellow invitees; accepting simply moves the invitee there.
   */
  _kookInvite(room, ws, params) {
    const voice = this._kookVoiceOf(room);
    if (!voice) {
      return send(ws, "kookError", {
        op: "invite",
        message: "房间尚未绑定 KOOK 服务器",
      });
    }
    const fromKookId = room.kookBindings.get(ws.meta.playerId);
    if (!fromKookId) {
      return send(ws, "kookError", {
        op: "invite",
        message: "请先绑定你的 KOOK 账号",
      });
    }
    if (!room.kookMainChannelId) {
      return send(ws, "kookError", {
        op: "invite",
        message: "说书人尚未设置主频道",
      });
    }
    const channelId = String((params && params.channelId) || "");
    const channel = voice.channels.get(channelId);
    if (!channel || channel.isCategory) {
      return send(ws, "kookError", { op: "invite", message: "目标语音频道不存在" });
    }
    if (room.kookCategoryId && channel.parentId !== room.kookCategoryId) {
      return send(ws, "kookError", {
        op: "invite",
        message: "该频道不在本局分组内",
      });
    }
    const targetIds = Array.isArray(params && params.playerIds)
      ? [...new Set(params.playerIds.map(String))].slice(0, 20)
      : [];
    // only bound players currently inside the main channel can be invited
    const targets = [];
    for (const pid of targetIds) {
      if (pid === ws.meta.playerId) continue;
      const kookId = room.kookBindings.get(pid);
      if (!kookId || voice.channelOfUser(kookId) !== room.kookMainChannelId) {
        continue;
      }
      const targetWs =
        pid === room.hostPlayerId ? room.host : room.players.get(pid);
      if (targetWs && targetWs.readyState === 1) targets.push({ pid, kookId });
    }
    if (!targets.length) {
      return send(ws, "kookError", {
        op: "invite",
        message: "主频道中没有可邀请的玩家",
      });
    }
    const fromUser = voice.users.get(fromKookId) || {};
    const payload = {
      channelId,
      channelName: channel.name,
      from: {
        name: fromUser.nickname || fromUser.username || fromKookId,
        avatar: fromUser.avatar || "",
      },
      invitees: targets.map((t) => {
        const u = voice.users.get(t.kookId) || {};
        return u.nickname || u.username || t.kookId;
      }),
    };
    for (const t of targets) {
      const targetWs =
        t.pid === room.hostPlayerId ? room.host : room.players.get(t.pid);
      send(targetWs, "kookInvite", payload);
    }
  }

  /**
   * request/kookBindUser: { query } - bind the sender's own KOOK account,
   * looked up by "用户名#识别号" within the bound guild.
   */
  async _kookBindUser(room, ws, params) {
    const voice = this._kookVoiceOf(room);
    if (!voice) {
      return send(ws, "kookError", {
        op: "bindUser",
        message: "房间尚未绑定 KOOK 服务器",
      });
    }
    const query = String((params && params.query) || "").trim();
    const match = /^(.+?)#(\d{4})$/.exec(query);
    if (!match) {
      return send(ws, "kookError", {
        op: "bindUser",
        message: "格式应为:KOOK用户名#识别号(如 张三#1234)",
      });
    }
    let found;
    try {
      const members = await this.kook.api.guildUserList(
        room.kookGuildId,
        match[1]
      );
      found = members.find((u) => u.identify_num === match[2]) || null;
    } catch (err) {
      return send(ws, "kookError", { op: "bindUser", message: err.message });
    }
    if (!found) {
      return send(ws, "kookError", {
        op: "bindUser",
        message: "该 KOOK 服务器中找不到此用户",
      });
    }
    room.kookBindings.set(ws.meta.playerId, found.id);
    voice.upsertUser(found);
    this._broadcastRoom(room, [
      "kookBindings",
      Object.fromEntries(room.kookBindings),
    ]);
    // a freshly bound user already inside the category is pulled to the
    // main channel right away instead of waiting for a voice event
    this._kookAutoPull(room, voice);
    send(ws, "kookBoundUser", {
      id: found.id,
      username: found.username,
      nickname: found.nickname || "",
      avatar: found.avatar || "",
      identify_num: found.identify_num || "",
    });
  }

  /** request/kookUnbindUser - remove the sender's own KOOK binding. */
  _kookUnbindUser(room, ws) {
    const kookId = room.kookBindings.get(ws.meta.playerId);
    if (!room.kookBindings.delete(ws.meta.playerId)) {
      return send(ws, "kookError", {
        op: "unbindUser",
        message: "你尚未绑定 KOOK 账号",
      });
    }
    room.kookAutoMoved.delete(kookId);
    this._broadcastRoom(room, [
      "kookBindings",
      Object.fromEntries(room.kookBindings),
    ]);
  }

  /** request/kookMove: { channelId } - move the sender's own KOOK user. */
  _kookMove(room, ws, params) {
    const voice = this._kookVoiceOf(room);
    if (!voice) {
      return send(ws, "kookError", {
        op: "move",
        message: "房间尚未绑定 KOOK 服务器",
      });
    }
    const kookId = room.kookBindings.get(ws.meta.playerId);
    if (!kookId) {
      return send(ws, "kookError", {
        op: "move",
        message: "请先绑定你的 KOOK 账号",
      });
    }
    const channelId = String((params && params.channelId) || "");
    const channel = voice.channels.get(channelId);
    if (!channel || channel.isCategory) {
      return send(ws, "kookError", { op: "move", message: "目标语音频道不存在" });
    }
    if (room.kookCategoryId && channel.parentId !== room.kookCategoryId) {
      return send(ws, "kookError", {
        op: "move",
        message: "该频道不在本局分组内",
      });
    }
    // KOOK can only move users who are already in a voice channel
    if (!voice.channelOfUser(kookId)) {
      return send(ws, "kookError", {
        op: "move",
        message: "请先在 KOOK 客户端中进入任意语音频道",
      });
    }
    this.kook.api
      .moveUsers(channelId, [kookId])
      .then(() => voice.moveLocal(kookId, channelId))
      .catch((err) =>
        send(ws, "kookError", { op: "move", message: err.message })
      );
  }

  /** request/kookMoveAll: { channelId } - move every bound in-voice player. */
  _kookMoveAll(room, ws, params) {
    if (!ws.meta.isHost) {
      return send(ws, "kookError", {
        op: "moveAll",
        message: "仅说书人可以全员移动",
      });
    }
    const voice = this._kookVoiceOf(room);
    if (!voice) {
      return send(ws, "kookError", {
        op: "moveAll",
        message: "房间尚未绑定 KOOK 服务器",
      });
    }
    const channelId = String((params && params.channelId) || "");
    const channel = voice.channels.get(channelId);
    if (!channel || channel.isCategory) {
      return send(ws, "kookError", {
        op: "moveAll",
        message: "目标语音频道不存在",
      });
    }
    if (room.kookCategoryId && channel.parentId !== room.kookCategoryId) {
      return send(ws, "kookError", {
        op: "moveAll",
        message: "该频道不在本局分组内",
      });
    }
    const userIds = [...new Set(room.kookBindings.values())].filter((id) =>
      voice.channelOfUser(id)
    );
    if (!userIds.length) {
      return send(ws, "kookError", {
        op: "moveAll",
        message: "没有已绑定且处于语音中的玩家",
      });
    }
    this.kook.api
      .moveUsers(channelId, userIds)
      .then(() => {
        for (const id of userIds) voice.moveLocal(id, channelId);
      })
      .catch((err) =>
        send(ws, "kookError", { op: "moveAll", message: err.message })
      );
  }

  /**
   * request/kookMute: { userIds?, mute?, type? } - server-wide mute of the
   * given (or all bound) KOOK users; type 1 = mic, 2 = headset.
   */
  async _kookMute(room, ws, params) {
    if (!ws.meta.isHost) {
      return send(ws, "kookError", {
        op: "mute",
        message: "仅说书人可以设置静音",
      });
    }
    const voice = this._kookVoiceOf(room);
    if (!voice) {
      return send(ws, "kookError", {
        op: "mute",
        message: "房间尚未绑定 KOOK 服务器",
      });
    }
    const mute = !params || params.mute !== false;
    const type = params && params.type === 2 ? 2 : 1;
    const userIds =
      Array.isArray(params && params.userIds) && params.userIds.length
        ? params.userIds
        : [...new Set(room.kookBindings.values())];
    if (!userIds.length) {
      return send(ws, "kookError", {
        op: "mute",
        message: "没有已绑定 KOOK 的玩家",
      });
    }
    // sequential calls to stay clear of rate limits
    for (const id of userIds) {
      try {
        if (mute) {
          await this.kook.api.muteUser(room.kookGuildId, id, type);
        } else {
          await this.kook.api.unmuteUser(room.kookGuildId, id, type);
        }
        voice.setMuteLocal(id, type, mute);
      } catch (err) {
        return send(ws, "kookError", { op: "mute", message: err.message });
      }
    }
  }

  _onClose(ws, room) {
    if (ws.meta.isHost && room.host === ws) {
      this.roomManager.dropHost(room);
    } else if (!ws.meta.isHostCandidate) {
      // pass the socket so the stale close of a superseded connection
      // cannot remove a fresh one that reconnected with the same playerId
      const removed = this.roomManager.removePlayer(
        room,
        ws.meta.playerId,
        ws
      );
      if (removed) {
        if (room.hasActiveHost()) {
          send(room.host, "bye", ws.meta.playerId);
        }
        // drop the KOOK binding of a player who really left the room
        const leftKookId = room.kookBindings.get(ws.meta.playerId);
        if (room.kookBindings.delete(ws.meta.playerId)) {
          room.kookAutoMoved.delete(leftKookId);
          this._broadcastRoom(room, [
            "kookBindings",
            Object.fromEntries(room.kookBindings),
          ]);
        }
      }
    }
    // drop pending records that can no longer be delivered or acknowledged
    for (const [key, record] of this.pending) {
      if (record.from === ws.meta.playerId) this.pending.delete(key);
    }
  }
}

module.exports = GameServer;
