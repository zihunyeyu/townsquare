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
  assert.strictEqual(result.avatarUrl, "tester1.png");

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

// ------------------------------------------------------------------ runner
(async () => {
  const roomManager = new RoomManager();
  const game = new GameServer(roomManager).start(GAME_PORT);
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
