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

class GameServer {
  constructor(roomManager) {
    this.roomManager = roomManager;
    // Reliable-delivery store: `${targetId}:${feedbackId}` ->
    //   { to, from, message }
    this.pending = new Map();
    // Recently processed uploadFile feedback ids (dedupe resends)
    this.processedUploads = new Map(); // id -> timestamp
    this.wss = null;
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
      const seen = this.processedUploads.get(feedback);
      if (seen && Date.now() - seen < 10 * 60 * 1000) return;
      this.processedUploads.set(feedback, Date.now());
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
    const relayed = ["ping", [idOrCount, ws.latency || 0]];
    if (ws.meta.isHost) {
      for (const playerWs of room.players.values()) {
        send(playerWs, ...relayed);
      }
    } else if (room.hasActiveHost()) {
      send(room.host, ...relayed);
    }
  }

  _broadcast(room, ws, envelope) {
    if (room.host && room.host !== ws) send(room.host, ...envelope);
    for (const playerWs of room.players.values()) {
      if (playerWs !== ws) send(playerWs, ...envelope);
    }
  }

  _onClose(ws, room) {
    if (ws.meta.isHost && room.host === ws) {
      this.roomManager.dropHost(room);
    } else if (!ws.meta.isHostCandidate) {
      this.roomManager.removePlayer(room, ws.meta.playerId);
      if (room.hasActiveHost()) {
        send(room.host, "bye", ws.meta.playerId);
      }
    }
    // drop pending records that can no longer be delivered or acknowledged
    for (const [key, record] of this.pending) {
      if (record.from === ws.meta.playerId) this.pending.delete(key);
    }
  }
}

module.exports = GameServer;
