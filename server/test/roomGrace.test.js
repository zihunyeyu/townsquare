/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 */
/**
 * Room lifecycle unit test: the host-reconnect grace window must also cover
 * a room with no players, so a lone storyteller can refresh the page without
 * the room dissolving underneath them.
 *
 * Run with: node test/roomGrace.test.js
 */
process.env.HOST_GRACE_MS = "400"; // must precede the config require
const assert = require("assert");
const RoomManager = require("../src/rooms");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeWs() {
  return {
    readyState: 1,
    close() {
      this.readyState = 3;
    },
    send() {},
  };
}

(async () => {
  const rm = new RoomManager();
  const room = rm.getOrCreate("9001");
  const ws1 = fakeWs();
  assert.strictEqual(rm.claimHost(room, ws1, "hostP", "secret1"), true);

  // lone host refreshes: the old socket closes -> the room must survive
  ws1.readyState = 3;
  rm.dropHost(room);
  assert.strictEqual(
    rm.get("9001"),
    room,
    "empty room must not be destroyed before the grace window expires"
  );

  // reclaim within the grace window with the same stSecret
  const ws2 = fakeWs();
  assert.strictEqual(rm.claimHost(room, ws2, "hostP", "secret1"), true);
  assert.strictEqual(room.host, ws2);

  // host leaves for good: after the grace window an EMPTY room is reaped
  ws2.readyState = 3;
  rm.dropHost(room);
  await sleep(600);
  assert.strictEqual(
    rm.get("9001"),
    undefined,
    "room must be destroyed once the grace window expires"
  );

  // ...but a room that still has players is never destroyed by the timer
  const room2 = rm.getOrCreate("9002");
  const wsHost = fakeWs();
  const wsPlayer = fakeWs();
  rm.claimHost(room2, wsHost, "hostQ", "secret2");
  rm.addPlayer(room2, "p1", wsPlayer);
  wsHost.readyState = 3;
  rm.dropHost(room2);
  await sleep(600);
  assert.strictEqual(
    rm.get("9002"),
    room2,
    "a room with players must survive grace expiry"
  );
  assert.strictEqual(wsPlayer.readyState, 1, "players must not be kicked");

  console.log("ok   - room grace covers empty rooms");
  console.log("ok   - rooms with players are never destroyed by the timer");
  console.log("\n2 tests passed");
})().catch((err) => {
  console.error("FAIL -", err.message);
  process.exit(1);
});
