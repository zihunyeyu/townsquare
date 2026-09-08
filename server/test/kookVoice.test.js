/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 */
/**
 * Unit tests for the KOOK integration pieces that need no network:
 *  - KookVoice: state build via stubbed REST + gateway-event reducer
 *  - KookGateway: hello/heartbeat/sn-ordered event delivery against a
 *    local mock WebSocket server
 *
 * Run with: node test/kookVoice.test.js
 */
const assert = require("assert");
const { WebSocketServer } = require("ws");
const KookVoice = require("../src/kook/kookVoice");
const KookGateway = require("../src/kook/kookGateway");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeApi() {
  return {
    async guildView() {
      return { name: "测试服务器", icon: "https://img.kookapp.cn/icons/guild.png" };
    },
    async channelList(guildId, type) {
      const all = [
        { id: "cat1", name: "语音分组", type: 0, is_category: true, level: 1 },
        { id: "vc1", name: "主房间", type: 2, level: 2, limit_amount: 99, is_category: false, parent_id: "cat1" },
        { id: "vc2", name: "夜晚房", type: 2, level: 3, limit_amount: 2, is_category: false, parent_id: "cat1" },
      ];
      if (type === 2) return all.filter((c) => c.type === 2);
      if (type === 1) return all.filter((c) => c.type !== 2);
      return all;
    },
    async channelUserList(channelId) {
      if (channelId === "vc1") {
        return [
          {
            id: "u1",
            username: "张三",
            nickname: "小三",
            identify_num: "0471",
            online: true,
          },
        ];
      }
      return [];
    },
    async guildMuteList() {
      return {
        mic: { type: 1, user_ids: ["u1"] },
        headset: { type: 2, user_ids: [] },
      };
    },
  };
}

function event(type, body) {
  return { type: 255, extra: { type, body } };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test("voice: init builds channels, occupancy, users and mute lists", async () => {
  const v = new KookVoice(makeApi(), "g1");
  await v.init();
  const snap = v.snapshot();
  assert.strictEqual(snap.name, "测试服务器");
  assert.strictEqual(snap.icon, "https://img.kookapp.cn/icons/guild.png");
  assert.strictEqual(snap.channels.length, 3); // 2 voice + 1 category
  assert.deepStrictEqual(snap.occupancy.vc1, ["u1"]);
  assert.strictEqual(snap.users.u1.nickname, "小三");
  assert.strictEqual(snap.users.u1.identify_num, "0471");
  assert.deepStrictEqual(snap.muted, ["u1"]);
  assert.strictEqual(v.channelOfUser("u1"), "vc1");
  v.destroy();
});

test("voice: joined/exited channel events update occupancy and emit change", async () => {
  const v = new KookVoice(makeApi(), "g1");
  await v.init();
  let changes = 0;
  v.on("change", () => changes++);

  v.handleEvent(event("joined_channel", { user_id: "u2", channel_id: "vc2" }));
  assert.strictEqual(v.channelOfUser("u2"), "vc2");
  assert.strictEqual(changes, 1);

  // moving between channels removes the user from the old one
  v.handleEvent(event("joined_channel", { user_id: "u2", channel_id: "vc1" }));
  assert.strictEqual(v.channelOfUser("u2"), "vc1");
  assert.deepStrictEqual(v.snapshot().occupancy.vc2, []);

  v.handleEvent(event("exited_channel", { user_id: "u2", channel_id: "vc1" }));
  assert.strictEqual(v.channelOfUser("u2"), null);

  // unknown events and duplicate joins must not emit
  const before = changes;
  v.handleEvent(event("joined_channel", { user_id: "u1", channel_id: "vc1" }));
  v.handleEvent({ type: 9, extra: { type: "message" } });
  assert.strictEqual(changes, before + 0);
  v.destroy();
});

test("voice: channel add/update/delete events maintain the channel tree", async () => {
  const v = new KookVoice(makeApi(), "g1");
  await v.init();
  v.handleEvent(event("added_channel", { id: "vc3", name: "夜晚房2", type: 2, level: 4 }));
  assert.ok(v.channels.has("vc3"));
  v.handleEvent(event("updated_channel", { id: "vc3", name: "改名了", type: 2, level: 4 }));
  assert.strictEqual(v.channels.get("vc3").name, "改名了");
  v.handleEvent(event("deleted_channel", { id: "vc3" }));
  assert.ok(!v.channels.has("vc3"));
  v.destroy();
});

test("voice: optimistic move/mute emit change immediately", async () => {
  const v = new KookVoice(makeApi(), "g1");
  await v.init();
  let changes = 0;
  v.on("change", () => changes++);
  v.moveLocal("u1", "vc2");
  assert.strictEqual(v.channelOfUser("u1"), "vc2");
  v.setMuteLocal("u1", 1, false);
  assert.deepStrictEqual(v.snapshot().muted, []);
  v.setMuteLocal("u2", 2, true);
  assert.deepStrictEqual(v.snapshot().deafened, ["u2"]);
  assert.strictEqual(changes, 3);
  v.destroy();
});

test("voice: member online/offline events flip the online flag", async () => {
  const v = new KookVoice(makeApi(), "g1");
  await v.init();
  assert.strictEqual(v.users.get("u1").online, true);
  v.handleEvent(event("guild_member_offline", { user_id: "u1" }));
  assert.strictEqual(v.users.get("u1").online, false);
  v.handleEvent(event("guild_member_online", { user_id: "u1" }));
  assert.strictEqual(v.users.get("u1").online, true);
  v.destroy();
});

test("voice: snapshot filters voice channels by category", async () => {
  const v = new KookVoice(makeApi(), "g1");
  await v.init();
  // a channel outside the bound category
  v.handleEvent(
    event("added_channel", { id: "vc9", name: "别局", type: 2, level: 9, parent_id: "" })
  );
  const snap = v.snapshot("cat1");
  assert.ok(snap.channels.some((c) => c.id === "cat1")); // category kept
  assert.ok(snap.channels.some((c) => c.id === "vc1")); // child kept
  assert.ok(!snap.channels.some((c) => c.id === "vc9")); // out-of-group dropped
  assert.ok(!("vc9" in snap.occupancy));
  const full = v.snapshot();
  assert.ok(full.channels.some((c) => c.id === "vc9"));
  v.destroy();
});

test("service: routes voice events by top-level target_id (KOOK doc shape)", () => {
  const KookService = require("../src/kook/kookService");
  const svc = new KookService({ token: "x" });
  const received = [];
  svc.voices.set("g1", {
    users: new Map(),
    channels: new Map([["vc1", {}]]),
    handleEvent: (d) => received.push(d),
  });
  // joined_channel per the official docs: guild id only in target_id
  svc._route({
    channel_type: "GROUP",
    target_id: "g1",
    type: 255,
    extra: {
      type: "joined_channel",
      body: { user_id: "u9", channel_id: "vc1" },
    },
  });
  assert.strictEqual(received.length, 1);
  // fallback: shapes whose target_id is NOT the guild id still route via
  // the affected channel id
  svc._route({
    channel_type: "GROUP",
    target_id: "vc1",
    type: 255,
    extra: {
      type: "exited_channel",
      body: { user_id: "u9", channel_id: "vc1" },
    },
  });
  assert.strictEqual(received.length, 2);
  // PERSON events without a known guild/user must not reach the voice cache
  svc._route({
    channel_type: "PERSON",
    target_id: "u9",
    type: 255,
    extra: { type: "user_updated", body: { user_id: "nobody" } },
  });
  assert.strictEqual(received.length, 2);
});

test("voice: resync emits change so clients see the corrected state", async () => {
  const v = new KookVoice(makeApi(), "g1");
  await v.init();
  let changes = 0;
  v.on("change", () => changes++);
  await v.resync();
  assert.ok(changes >= 1, "resync must emit change");
  v.destroy();
});

test("gateway: hello, heartbeat and sn-ordered event delivery", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.on("listening", r));
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ s: 1, d: { code: 0, session_id: "sess1" } }));
    // in-order, then out-of-order, then the gap filler, then a duplicate
    ws.send(JSON.stringify({ s: 0, sn: 1, d: { n: 1 } }));
    ws.send(JSON.stringify({ s: 0, sn: 3, d: { n: 3 } }));
    ws.send(JSON.stringify({ s: 0, sn: 2, d: { n: 2 } }));
    ws.send(JSON.stringify({ s: 0, sn: 2, d: { n: 99 } }));
    ws.on("message", (data) => {
      const p = JSON.parse(data);
      if (p.s === 2) ws.send(JSON.stringify({ s: 3 })); // answer pings
    });
  });
  const port = wss.address().port;
  const gw = new KookGateway({
    getGateway: async () => ({ url: `ws://127.0.0.1:${port}` }),
  });
  const events = [];
  gw.on("event", (d) => events.push(d.n));
  const ready = new Promise((resolve) => gw.on("ready", resolve));
  gw.connect();
  await ready;
  await sleep(200);
  assert.deepStrictEqual(events, [1, 2, 3]); // ordered, duplicate dropped
  assert.strictEqual(gw.sn, 3);
  gw.close();
  wss.close();
});

// ------------------------------------------------------------------ runner
(async () => {
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
  await sleep(100);
  console.log(
    failed === 0
      ? `\n${tests.length} tests passed`
      : `\n${failed}/${tests.length} tests FAILED`
  );
  process.exit(failed === 0 ? 0 : 1);
})();
