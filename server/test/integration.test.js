/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 */
/**
 * Integration test: spins up the real servers on ephemeral ports and drives
 * them with protocol-level clients that mimic the frontend's LiveSession /
 * LiveLobby behavior.
 *
 * Run with: npm test
 */
const assert = require("assert");
const WebSocket = require("ws");
const RoomManager = require("../src/rooms");
const GameServer = require("../src/gameServer");
const LobbyServer = require("../src/lobbyServer");
const HttpApi = require("../src/httpApi");

process.env.AVATAR_DIR = require("path").join(__dirname, ".tmp-avatars");

const GAME_PORT = 18081;
const LOBBY_PORT = 18082;
const API_PORT = 18083;
const GAME_URL = `ws://127.0.0.1:${GAME_PORT}`;
const LOBBY_URL = `ws://127.0.0.1:${LOBBY_PORT}`;
const API_URL = `http://127.0.0.1:${API_PORT}`;

// ---------------------------------------------------------------- helpers
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    // buffer every incoming message so tests never race the server
    ws.inbox = [];
    ws.on("message", (data) => {
      try {
        ws.inbox.push(JSON.parse(data));
      } catch (err) {
        /* ignore non-JSON */
      }
    });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

/** Wait for a buffered message matching predicate, with timeout. */
function nextMessage(ws, predicate, label, timeoutMs = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const idx = ws.inbox.findIndex(predicate);
      if (idx >= 0) {
        const [msg] = ws.inbox.splice(idx, 1);
        return resolve(msg);
      }
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timeout waiting for ${label}`));
      }
      setTimeout(check, 10);
    };
    check();
  });
}

function send(ws, command, params, feedback = false) {
  ws.send(JSON.stringify([command, params, feedback]));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------- tests
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("host can claim a room via checkAllowHost", async () => {
  const host = await connect(`${GAME_URL}/9001/hostA/host?auth=secret1`);
  send(host, "request", { checkAllowHost: ["hostA", null] });
  const msg = await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  assert.strictEqual(msg[1], true);
  host.close();
});

test("second host with wrong secret is rejected", async () => {
  const host = await connect(`${GAME_URL}/9002/hostB/host?auth=secret2`);
  send(host, "request", { checkAllowHost: ["hostB", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");

  const intruder = await connect(`${GAME_URL}/9002/hostC/host?auth=wrong`);
  send(intruder, "request", { checkAllowHost: ["hostC", null] });
  const msg = await nextMessage(intruder, ([c]) => c === "allowHost", "allowHost");
  assert.strictEqual(msg[1], false);
  host.close();
  intruder.close();
});

test("join requires an active host", async () => {
  // player joins a room that does not exist yet
  const early = await connect(`${GAME_URL}/9003/playerX`);
  send(early, "request", { checkAllowJoin: ["playerX", null] });
  let msg = await nextMessage(early, ([c]) => c === "allowJoin", "allowJoin");
  assert.strictEqual(msg[1], false);
  early.close();

  // now a host appears
  const host = await connect(`${GAME_URL}/9003/hostD/host?auth=secret3`);
  send(host, "request", { checkAllowHost: ["hostD", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");

  const player = await connect(`${GAME_URL}/9003/playerY`);
  send(player, "request", { checkAllowJoin: ["playerY", null] });
  msg = await nextMessage(player, ([c]) => c === "allowJoin", "allowJoin");
  assert.strictEqual(msg[1], true);
  host.close();
  player.close();
});

test("direct messages are unwrapped and routed to host / players", async () => {
  const host = await connect(`${GAME_URL}/9004/hostE/host?auth=secret4`);
  send(host, "request", { checkAllowHost: ["hostE", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const player = await connect(`${GAME_URL}/9004/playerZ`);

  // player -> host (getGamestate)
  const hostGot = nextMessage(
    host,
    ([c, p]) => c === "getGamestate" && p === "playerZ",
    "getGamestate"
  );
  send(player, "direct", { host: ["getGamestate", "playerZ"] });
  await hostGot;

  // host -> specific player (gs)
  const playerGot = nextMessage(
    player,
    ([c, p]) => c === "gs" && p.gamestate.length === 2,
    "gs"
  );
  send(host, "direct", {
    playerZ: ["gs", { gamestate: [{ name: "a" }, { name: "b" }] }],
  });
  await playerGot;
  host.close();
  player.close();
});

test("multi-target direct (distributeRoles shape) reaches each target", async () => {
  const host = await connect(`${GAME_URL}/9005/hostF/host?auth=secret5`);
  send(host, "request", { checkAllowHost: ["hostF", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const p1 = await connect(`${GAME_URL}/9005/p1`);
  const p2 = await connect(`${GAME_URL}/9005/p2`);

  const got1 = nextMessage(p1, ([c, p]) => c === "player" && p.index === 0, "role p1");
  const got2 = nextMessage(p2, ([c, p]) => c === "player" && p.index === 1, "role p2");
  send(host, "direct", {
    p1: ["player", { index: 0, property: "role", value: "washerwoman" }],
    p2: ["player", { index: 1, property: "role", value: "imp" }],
  });
  await got1;
  await got2;
  host.close();
  p1.close();
  p2.close();
});

test("broadcasts reach everyone except the sender", async () => {
  const host = await connect(`${GAME_URL}/9006/hostG/host?auth=secret6`);
  send(host, "request", { checkAllowHost: ["hostG", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const p1 = await connect(`${GAME_URL}/9006/p1`);
  const p2 = await connect(`${GAME_URL}/9006/p2`);

  // host broadcast (nomination) -> both players, host must NOT get a copy
  const got1 = nextMessage(p1, ([c]) => c === "nomination", "nomination p1");
  const got2 = nextMessage(p2, ([c]) => c === "nomination", "nomination p2");
  let hostEcho = false;
  host.on("message", (d) => {
    const [c] = JSON.parse(d);
    if (c === "nomination") hostEcho = true;
  });
  send(host, "nomination", [0, 1]);
  await got1;
  await got2;
  await sleep(200);
  assert.strictEqual(hostEcho, false);

  // player broadcast (vote) -> host + other player
  const hostGot = nextMessage(host, ([c]) => c === "vote", "vote on host");
  const p2Got = nextMessage(p2, ([c]) => c === "vote", "vote on p2");
  send(p1, "vote", [2, true, false]);
  await hostGot;
  await p2Got;
  host.close();
  p1.close();
  p2.close();
});

test("feedback/deleteMessage acknowledges the original sender", async () => {
  const host = await connect(`${GAME_URL}/9007/hostH/host?auth=secret7`);
  send(host, "request", { checkAllowHost: ["hostH", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const player = await connect(`${GAME_URL}/9007/p9`);

  // host sends a queued chat message (feedback id 12345) to the player
  const playerGot = nextMessage(
    player,
    ([c, p, f]) => c === "chat" && f === 12345,
    "chat"
  );
  send(host, "direct", { p9: ["chat", { message: "hi" }] }, 12345);
  await playerGot;

  // player acknowledges -> host should receive ["feedback", 12345]
  const hostGot = nextMessage(
    host,
    ([c, p]) => c === "feedback" && p === 12345,
    "feedback"
  );
  send(player, "request", { deleteMessage: ["p9", ["direct", 12345]] });
  await hostGot;
  host.close();
  player.close();
});

test("pings are relayed with measured latency (player->host, host->players)", async () => {
  const host = await connect(`${GAME_URL}/9008/hostI/host?auth=secret8`);
  send(host, "request", { checkAllowHost: ["hostI", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const player = await connect(`${GAME_URL}/9008/p10`);

  // player ping goes to host
  const hostGot = nextMessage(
    host,
    ([c, p]) => c === "ping" && p[0] === "p10" && typeof p[1] === "number",
    "player ping on host"
  );
  send(player, "ping", ["p10", "latency"]);
  await hostGot;

  // host ping (player count) goes to players, pong returns to sender
  const playerGot = nextMessage(
    player,
    ([c, p]) => c === "ping" && p[0] === 1,
    "host ping on player"
  );
  const pong = nextMessage(host, ([c]) => c === "pong", "pong");
  send(host, "ping", [1, "latency"]);
  await playerGot;
  await pong;
  host.close();
  player.close();
});

test("host is notified with bye when a player disconnects", async () => {
  const host = await connect(`${GAME_URL}/9009/hostJ/host?auth=secret9`);
  send(host, "request", { checkAllowHost: ["hostJ", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const player = await connect(`${GAME_URL}/9009/p11`);
  await sleep(100);

  const bye = nextMessage(
    host,
    ([c, p]) => c === "bye" && p === "p11",
    "bye"
  );
  player.close();
  await bye;
  host.close();
});

test("stale close after same-id reconnect must not evict the fresh socket", async () => {
  const host = await connect(`${GAME_URL}/9013/hostM/host?auth=secret13`);
  send(host, "request", { checkAllowHost: ["hostM", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");

  // player connects, then reconnects with the same playerId (flaky network)
  const stale = await connect(`${GAME_URL}/9013/p13`);
  const fresh = await connect(`${GAME_URL}/9013/p13`);
  await sleep(100);

  // the stale socket's close must NOT produce a bye nor remove the fresh one
  let byeReceived = false;
  host.on("message", (d) => {
    const [c, p] = JSON.parse(d);
    if (c === "bye" && p === "p13") byeReceived = true;
  });
  stale.close();
  await sleep(300);
  assert.strictEqual(byeReceived, false);

  // the fresh connection is still in the room and receives broadcasts
  const freshGot = nextMessage(
    fresh,
    ([c]) => c === "nomination",
    "nomination on fresh socket"
  );
  send(host, "nomination", [0, 1]);
  await freshGot;
  host.close();
  fresh.close();
});

test("host can reclaim with the same secret after disconnect", async () => {
  let host = await connect(`${GAME_URL}/9010/hostK/host?auth=secret10`);
  send(host, "request", { checkAllowHost: ["hostK", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const player = await connect(`${GAME_URL}/9010/p12`);
  host.close();
  await sleep(100);

  // reclaim with same secret works while the room is alive
  host = await connect(`${GAME_URL}/9010/hostK2/host?auth=secret10`);
  send(host, "request", { checkAllowHost: ["hostK2", null] });
  const msg = await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  assert.strictEqual(msg[1], true);
  host.close();
  player.close();
});

test("lobby: setRooms on connect, addRoom/removeRoom on host gain/loss", async () => {
  const lobby = await connect(`${LOBBY_URL}/watcher1`);
  const initial = await nextMessage(lobby, ([c]) => c === "setRooms", "setRooms");
  assert.ok(Array.isArray(initial[1]));

  const added = nextMessage(
    lobby,
    ([c, p]) => c === "addRoom" && p === "9011",
    "addRoom"
  );
  const host = await connect(`${GAME_URL}/9011/hostL/host?auth=secret11`);
  send(host, "request", { checkAllowHost: ["hostL", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  await added;

  const removed = nextMessage(
    lobby,
    ([c, p]) => c === "removeRoom" && p === "9011",
    "removeRoom"
  );
  host.close();
  await removed;
  lobby.close();
});

test("HTTP API: avatar upload + retrieval, /dynamic/init", async () => {
  // 1x1 transparent PNG
  const dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const upload = await fetch(`${API_URL}/upload/avatar`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerId: "tester1", uploadContent: dataUrl }),
  });
  assert.strictEqual(upload.status, 200);
  const result = await upload.json();
  assert.strictEqual(result.status, "success");
  // avatar filenames carry a content hash: {playerId}-{hash8}.{ext}
  assert.ok(/^tester1-[0-9a-f]{8}\.png$/.test(result.avatarUrl));

  const avatar = await fetch(`${API_URL}/avatars/${result.avatarUrl}`);
  assert.strictEqual(avatar.status, 200);
  assert.strictEqual(avatar.headers.get("content-type"), "image/png");

  const init = await fetch(`${API_URL}/dynamic/init`);
  const initBody = await init.json();
  assert.ok(initBody.payload.version);
});

test("invalid connections are rejected", async () => {
  const expectClose = async (url, label) => {
    const ws = await connect(url).catch(() => null);
    if (!ws) return; // handshake-level rejection is also acceptable
    const code = await new Promise((resolve) => ws.on("close", resolve));
    assert.ok(
      code === 1000 || code >= 4000,
      `${label}: unexpected close code ${code}`
    );
  };
  await expectClose(`${GAME_URL}/0/badchannel`, "bad channel");
  await expectClose(`${GAME_URL}/9012/host`, "reserved id");
  await expectClose(`${GAME_URL}/9012/someone/host`, "missing auth");
});

// ---------------------------------------------------------- fake KOOK service
// Stubbed KookService: no network, records mutating calls, emits "change"
// from the fake voice cache so the GameServer broadcast path is exercised.
function makeFakeKook() {
  const EventEmitter = require("events");
  class FakeVoice extends EventEmitter {
    constructor() {
      super();
      this.name = "测试服务器";
      this.icon = "https://img.kookapp.cn/icons/guild.png";
      this.ready = true;
      this.channels = new Map([
        ["cat1", { id: "cat1", name: "测试分组", isCategory: true, level: 0 }],
        ["vc1", { id: "vc1", name: "主房间", isCategory: false, level: 1, limitAmount: 99, parentId: "cat1" }],
        ["vc2", { id: "vc2", name: "夜晚房", isCategory: false, level: 2, limitAmount: 2, parentId: "cat1" }],
        ["vc9", { id: "vc9", name: "别局房间", isCategory: false, level: 3, limitAmount: 25, parentId: "" }],
      ]);
      this.users = new Map([
        ["kook1", { id: "kook1", username: "玩家一", nickname: "小三" }],
        ["kook2", { id: "kook2", username: "玩家二", nickname: "二丫" }],
      ]);
      this.occupancy = new Map([["vc1", new Set(["kook1"])], ["vc2", new Set()]]);
      this.muted = new Set();
    }
    snapshot(categoryId = null) {
      let channels = [...this.channels.values()];
      let occupancy = this.occupancy;
      if (categoryId) {
        channels = channels.filter(
          (c) => c.isCategory || c.parentId === categoryId
        );
        const ids = new Set(channels.map((c) => c.id));
        occupancy = new Map([...this.occupancy].filter(([cid]) => ids.has(cid)));
      }
      return {
        guildId: "g1",
        name: this.name,
        icon: this.icon,
        ready: this.ready,
        channels,
        users: Object.fromEntries(this.users),
        occupancy: Object.fromEntries(
          [...occupancy].map(([k, v]) => [k, [...v]])
        ),
        muted: [...this.muted],
        deafened: [],
      };
    }
    channelOfUser(id) {
      for (const [cid, set] of this.occupancy) if (set.has(id)) return cid;
      return null;
    }
    moveLocal(id, cid) {
      const from = this.channelOfUser(id);
      if (from) this.occupancy.get(from).delete(id);
      if (!this.occupancy.has(cid)) this.occupancy.set(cid, new Set());
      this.occupancy.get(cid).add(id);
      this.emit("change", this.snapshot());
    }
    setMuteLocal(id, type, on) {
      if (on) this.muted.add(id);
      else this.muted.delete(id);
      this.emit("change", this.snapshot());
    }
    upsertUser(u) {
      this.users.set(u.id, u);
    }
  }
  const voice = new FakeVoice();
  const calls = { moveUsers: [], muteUser: [], unmuteUser: [], setToken: [] };
  return {
    calls,
    _voice: voice,
    enabled: () => true,
    voices: new Map([["g1", voice]]),
    async getVoice() {
      return voice;
    },
    async setToken(token) {
      calls.setToken.push(token);
      return { configured: !!token, verified: false };
    },
    api: {
      async guildUserList(guildId, search) {
        const byName = {
          玩家一: { id: "kook1", username: "玩家一", nickname: "小三", identify_num: "1234" },
          玩家二: { id: "kook2", username: "玩家二", nickname: "二丫", identify_num: "5678" },
        };
        return byName[search] ? [byName[search]] : [];
      },
      async moveUsers(cid, ids) {
        calls.moveUsers.push([cid, ids]);
      },
      async muteUser(g, id, type) {
        calls.muteUser.push([id, type]);
      },
      async unmuteUser(g, id, type) {
        calls.unmuteUser.push([id, type]);
      },
    },
  };
}

test("kook: category selection filters voice state and constrains moves", async () => {
  const host = await connect(`${GAME_URL}/9022/hostP/host?auth=secret22`);
  send(host, "request", { checkAllowHost: ["hostP", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  send(host, "request", { kookBind: ["hostP", { guildId: "g1" }] });
  await nextMessage(host, ([c]) => c === "kookBound", "kookBound");
  await nextMessage(host, ([c]) => c === "kookVoice", "initial kookVoice");

  // select the 测试分组 category
  const boundWithCat = nextMessage(
    host,
    ([c, p]) => c === "kookBound" && p.categoryId === "cat1",
    "kookBound with categoryId"
  );
  const filtered = nextMessage(
    host,
    ([c, p]) =>
      c === "kookVoice" &&
      !p.channels.some((ch) => ch.id === "vc9") &&
      p.channels.some((ch) => ch.id === "vc1"),
    "filtered kookVoice"
  );
  send(host, "request", { kookSetCategory: ["hostP", { categoryId: "cat1" }] });
  await boundWithCat;
  await filtered;

  // moving to a channel outside the category is rejected
  const err = nextMessage(
    host,
    ([c, p]) => c === "kookError" && p.op === "moveAll",
    "kookError moveAll outside category"
  );
  send(host, "request", { kookMoveAll: ["hostP", { channelId: "vc9" }] });
  await err;
  host.close();
});

test("kook: host binds guild; voice state is pushed to room members", async () => {
  const host = await connect(`${GAME_URL}/9020/hostN/host?auth=secret20`);
  send(host, "request", { checkAllowHost: ["hostN", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");

  const bound = nextMessage(
    host,
    ([c, p]) =>
      c === "kookBound" && p.guildName === "测试服务器" && !!p.guildIcon,
    "kookBound"
  );
  const voiceMsg = nextMessage(host, ([c]) => c === "kookVoice", "kookVoice");
  send(host, "request", { kookBind: ["hostN", { guildId: "g1" }] });
  await bound;
  await voiceMsg;

  // a player joining later gets the full kook state pushed
  const player = await connect(`${GAME_URL}/9020/p20`);
  await nextMessage(player, ([c]) => c === "kookBound", "kookBound on join");
  await nextMessage(player, ([c]) => c === "kookVoice", "kookVoice on join");
  await nextMessage(player, ([c]) => c === "kookBindings", "kookBindings on join");
  host.close();
  player.close();
});

test("kook: bind user, self move, moveAll/mute host-only guards", async () => {
  const host = await connect(`${GAME_URL}/9021/hostO/host?auth=secret21`);
  send(host, "request", { checkAllowHost: ["hostO", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  send(host, "request", { kookBind: ["hostO", { guildId: "g1" }] });
  await nextMessage(host, ([c]) => c === "kookBound", "kookBound");
  await nextMessage(host, ([c]) => c === "kookVoice", "initial kookVoice");
  const player = await connect(`${GAME_URL}/9021/p21`);
  await nextMessage(player, ([c]) => c === "kookBound", "kookBound");

  // moving before binding is rejected
  const errNoBind = nextMessage(
    player,
    ([c, p]) => c === "kookError" && p.op === "move",
    "kookError before binding"
  );
  send(player, "request", { kookMove: ["p21", { channelId: "vc2" }] });
  await errNoBind;

  // player binds own KOOK account by 用户名#识别号
  const boundUser = nextMessage(
    player,
    ([c, p]) =>
      c === "kookBoundUser" && p.id === "kook1" && p.identify_num === "1234",
    "kookBoundUser"
  );
  const bindingsOnHost = nextMessage(
    host,
    ([c, p]) => c === "kookBindings" && p.p21 === "kook1",
    "kookBindings on host"
  );
  send(player, "request", { kookBindUser: ["p21", { query: "玩家一#1234" }] });
  await boundUser;
  await bindingsOnHost;

  // non-host cannot moveAll
  const errNotHost = nextMessage(
    player,
    ([c, p]) => c === "kookError" && p.op === "moveAll",
    "kookError moveAll"
  );
  send(player, "request", { kookMoveAll: ["p21", { channelId: "vc2" }] });
  await errNotHost;

  // player moves self (kook1 is in vc1 per the fake occupancy)
  const voiceAfterMove = nextMessage(
    player,
    ([c, p]) => c === "kookVoice" && (p.occupancy.vc2 || []).includes("kook1"),
    "kookVoice after self move"
  );
  const voiceAfterMoveHost = nextMessage(
    host,
    ([c, p]) => c === "kookVoice" && (p.occupancy.vc2 || []).includes("kook1"),
    "kookVoice after self move on host"
  );
  send(player, "request", { kookMove: ["p21", { channelId: "vc2" }] });
  await voiceAfterMove;
  await voiceAfterMoveHost;

  // host moves everyone back to vc1, then mutes all bound users
  const backOnVc1 = nextMessage(
    host,
    ([c, p]) => c === "kookVoice" && (p.occupancy.vc1 || []).includes("kook1"),
    "kookVoice after moveAll"
  );
  send(host, "request", { kookMoveAll: ["hostO", { channelId: "vc1" }] });
  await backOnVc1;

  const mutedMsg = nextMessage(
    player,
    ([c, p]) => c === "kookVoice" && (p.muted || []).includes("kook1"),
    "kookVoice after mute"
  );
  send(host, "request", { kookMute: ["hostO", { mute: true }] });
  await mutedMsg;
  host.close();
  player.close();
});

test("kook: unbindUser removes the sender's binding", async () => {
  const host = await connect(`${GAME_URL}/9023/hostQ/host?auth=secret23`);
  send(host, "request", { checkAllowHost: ["hostQ", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  send(host, "request", { kookBind: ["hostQ", { guildId: "g1" }] });
  await nextMessage(host, ([c]) => c === "kookBound", "kookBound");
  const player = await connect(`${GAME_URL}/9023/p23`);
  await nextMessage(player, ([c]) => c === "kookBound", "kookBound");
  // drain the join-time (empty) bindings push
  await nextMessage(player, ([c]) => c === "kookBindings", "initial kookBindings");

  const bound = nextMessage(
    player,
    ([c, p]) => c === "kookBindings" && p.p23 === "kook1",
    "bindings after bind"
  );
  send(player, "request", { kookBindUser: ["p23", { query: "玩家一#1234" }] });
  await bound;

  const cleared = nextMessage(
    player,
    ([c, p]) => c === "kookBindings" && !p.p23,
    "bindings after unbind"
  );
  send(player, "request", { kookUnbindUser: ["p23", null] });
  await cleared;

  // unbinding again reports an error
  const err = nextMessage(
    player,
    ([c, p]) => c === "kookError" && p.op === "unbindUser",
    "kookError unbindUser"
  );
  send(player, "request", { kookUnbindUser: ["p23", null] });
  await err;
  host.close();
  player.close();
});

test("kook: setToken is host-only and acknowledges the configured state", async () => {
  const host = await connect(`${GAME_URL}/9023/hostT/host?auth=secret23`);
  send(host, "request", { checkAllowHost: ["hostT", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const player = await connect(`${GAME_URL}/9023/p24`);

  // a regular player may not touch the bot token
  const denied = nextMessage(
    player,
    ([c, p]) => c === "kookError" && p.op === "setToken",
    "kookError setToken"
  );
  send(player, "request", { kookSetToken: ["p24", { token: "player-token" }] });
  await denied;

  // the host sets the token; the ack carries no token, only the state
  const ack = nextMessage(
    host,
    ([c, p]) =>
      c === "kookTokenSet" &&
      p.configured === true &&
      !String(JSON.stringify(p)).includes("bot-token-123"),
    "kookTokenSet"
  );
  send(host, "request", { kookSetToken: ["hostT", { token: "bot-token-123" }] });
  await ack;

  host.close();
  player.close();
});

test("room: dissolveRoom kicks players and destroys the room", async () => {
  const host = await connect(`${GAME_URL}/9024/hostD/host?auth=secret24`);
  send(host, "request", { checkAllowHost: ["hostD", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  const player = await connect(`${GAME_URL}/9024/p25`);

  // a player may not dissolve the room
  send(player, "request", { dissolveRoom: ["p25", null] });
  await sleep(200);

  // the host dissolves: the player is notified and dropped, the room dies
  const alert = nextMessage(player, ([c]) => c === "alertPopup", "alertPopup");
  const closed = new Promise((resolve) => player.on("close", resolve));
  send(host, "request", { dissolveRoom: ["hostD", null] });
  await alert;
  await closed;

  // the same channel id is immediately available for a fresh room
  const host2 = await connect(`${GAME_URL}/9024/hostE/host?auth=secret25`);
  send(host2, "request", { checkAllowHost: ["hostE", null] });
  await nextMessage(
    host2,
    ([c, p]) => c === "allowHost" && p === true,
    "allowHost on fresh room"
  );
  host.close();
  host2.close();
});

test("kook: main channel designation and auto-pull on first entry", async () => {
  const host = await connect(`${GAME_URL}/9030/hostM/host?auth=secret30`);
  send(host, "request", { checkAllowHost: ["hostM", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  send(host, "request", { kookBind: ["hostM", { guildId: "g1" }] });
  await nextMessage(host, ([c]) => c === "kookBound", "kookBound");
  send(host, "request", { kookSetCategory: ["hostM", { categoryId: "cat1" }] });
  await nextMessage(
    host,
    ([c, p]) => c === "kookBound" && p.categoryId === "cat1",
    "kookBound with categoryId"
  );

  // the main channel is host-only and must belong to the category
  const player = await connect(`${GAME_URL}/9030/p30`);
  await nextMessage(player, ([c]) => c === "kookBound", "kookBound on join");
  const errNotHost = nextMessage(
    player,
    ([c, p]) => c === "kookError" && p.op === "setMainChannel",
    "kookError setMainChannel not host"
  );
  send(player, "request", { kookSetMainChannel: ["p30", { channelId: "vc1" }] });
  await errNotHost;
  const errOutside = nextMessage(
    host,
    ([c, p]) => c === "kookError" && p.op === "setMainChannel",
    "kookError setMainChannel outside category"
  );
  send(host, "request", { kookSetMainChannel: ["hostM", { channelId: "vc9" }] });
  await errOutside;

  // host designates vc2 as the main channel of 测试分组
  const mainSet = nextMessage(
    host,
    ([c, p]) => c === "kookBound" && p.mainChannelId === "vc2",
    "kookBound with mainChannelId"
  );
  send(host, "request", { kookSetMainChannel: ["hostM", { channelId: "vc2" }] });
  await mainSet;

  // the player binds; kook1 sits in vc1 (inside the category, not the main
  // channel) and must be auto-pulled to vc2 exactly once
  const movesBefore = fakeKook.calls.moveUsers.length;
  const pulled = nextMessage(
    player,
    ([c, p]) => c === "kookVoice" && (p.occupancy.vc2 || []).includes("kook1"),
    "kookVoice after auto-pull"
  );
  send(player, "request", { kookBindUser: ["p30", { query: "玩家一#1234" }] });
  await pulled;
  assert.deepStrictEqual(fakeKook.calls.moveUsers.slice(movesBefore), [
    ["vc2", ["kook1"]],
  ]);

  // a later voice change must not re-pull the same binding
  fakeKook._voice.moveLocal("kook1", "vc1");
  await sleep(200);
  assert.strictEqual(fakeKook.calls.moveUsers.length, movesBefore + 1);

  host.close();
  player.close();
});

test("kook: invite players from the main channel to another channel", async () => {
  // kook1 is in vc2 after the previous test; kook2 joins it there
  fakeKook._voice.moveLocal("kook2", "vc2");
  const host = await connect(`${GAME_URL}/9031/hostI/host?auth=secret31`);
  send(host, "request", { checkAllowHost: ["hostI", null] });
  await nextMessage(host, ([c]) => c === "allowHost", "allowHost");
  send(host, "request", { kookBind: ["hostI", { guildId: "g1" }] });
  await nextMessage(host, ([c]) => c === "kookBound", "kookBound");
  send(host, "request", { kookSetCategory: ["hostI", { categoryId: "cat1" }] });
  await nextMessage(
    host,
    ([c, p]) => c === "kookBound" && p.categoryId === "cat1",
    "kookBound with categoryId"
  );
  // vc2 is the main channel; both users are already inside it
  send(host, "request", { kookSetMainChannel: ["hostI", { channelId: "vc2" }] });
  await nextMessage(
    host,
    ([c, p]) => c === "kookBound" && p.mainChannelId === "vc2",
    "kookBound with mainChannelId"
  );

  const inviter = await connect(`${GAME_URL}/9031/p31`);
  const invitee = await connect(`${GAME_URL}/9031/p32`);
  send(inviter, "request", { kookBindUser: ["p31", { query: "玩家一#1234" }] });
  await nextMessage(inviter, ([c]) => c === "kookBoundUser", "inviter bound");
  send(invitee, "request", { kookBindUser: ["p32", { query: "玩家二#5678" }] });
  await nextMessage(invitee, ([c]) => c === "kookBoundUser", "invitee bound");

  // inviting to a channel outside the category is rejected
  const errOutside = nextMessage(
    inviter,
    ([c, p]) => c === "kookError" && p.op === "invite",
    "kookError invite outside category"
  );
  send(inviter, "request", {
    kookInvite: ["p31", { channelId: "vc9", playerIds: ["p32"] }],
  });
  await errOutside;

  // the invitee gets the invite naming the inviter, the channel and all
  // fellow invitees
  const invited = nextMessage(
    invitee,
    ([c, p]) =>
      c === "kookInvite" &&
      p.channelId === "vc1" &&
      p.channelName === "主房间" &&
      p.from.name === "小三" &&
      p.invitees.includes("二丫"),
    "kookInvite"
  );
  send(inviter, "request", {
    kookInvite: ["p31", { channelId: "vc1", playerIds: ["p32"] }],
  });
  await invited;

  // accepting moves the invitee: the plain kookMove command does it
  const moved = nextMessage(
    invitee,
    ([c, p]) => c === "kookVoice" && (p.occupancy.vc1 || []).includes("kook2"),
    "kookVoice after accept"
  );
  send(invitee, "request", { kookMove: ["p32", { channelId: "vc1" }] });
  await moved;

  host.close();
  inviter.close();
  invitee.close();
});

// ------------------------------------------------------------------ runner
// module-level so tests can inspect the fake voice state / recorded calls
const fakeKook = makeFakeKook();
(async () => {
  const roomManager = new RoomManager();
  const game = new GameServer(roomManager, fakeKook).start(GAME_PORT);
  const lobby = new LobbyServer(roomManager).start(LOBBY_PORT);
  const api = new HttpApi().start(API_PORT);
  await sleep(300);

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   - ${name}`);
    } catch (err) {
      failed++;
      console.error(`FAIL - ${name}`);
      console.error(`       ${err.message}`);
    }
  }
  for (const wss of [game, lobby]) {
    for (const client of wss.clients) client.terminate();
    wss.close();
  }
  if (api.closeAllConnections) api.closeAllConnections();
  api.close();
  await sleep(200);
  console.log(failed === 0 ? `\n${tests.length} tests passed` : `\n${failed}/${tests.length} tests FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
