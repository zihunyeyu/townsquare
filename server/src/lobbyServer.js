/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * Lobby WebSocket server - protocol-compatible with the frontend's
 * LiveLobby class (src/store/socket.js).
 *
 * Clients connect with /{playerId} (an optional leading /lobby/ segment is
 * accepted). On connect they receive the full room list via "setRooms";
 * afterwards "addRoom" / "removeRoom" are broadcast as rooms gain or lose
 * their storyteller.
 */
const { WebSocketServer } = require("ws");
const http = require("http");
const {
  LOBBY_PORT,
  LOBBY_MAX_PAYLOAD,
  PING_INTERVAL_MS,
  RESERVED_IDS,
} = require("./config");

function send(ws, command, params) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify([command, params]));
  }
}

class LobbyServer {
  constructor(roomManager) {
    this.roomManager = roomManager;
    this.wss = null;
  }

  /**
   * Create the WebSocketServer in noServer mode so it can be attached to
   * any HTTP server (own port via start(), or shared via standalone.js).
   */
  createWss() {
    this.wss = new WebSocketServer({
      noServer: true,
      // lobby messages are tiny; reject oversized payloads early
      maxPayload: LOBBY_MAX_PAYLOAD,
    });
    this.wss.on("connection", (ws, req) => {
      const url = new URL(req.url, "http://localhost");
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0] === "lobby") segments.shift();
      const [playerId] = segments;
      if (!playerId || RESERVED_IDS.has(playerId)) {
        // close with 1000 so the frontend does not auto-reconnect
        ws.close(1000, "无效的玩家ID");
        return;
      }
      ws.isAlive = true;
      ws.on("pong", () => {
        ws.isAlive = true;
      });
      ws.on("error", (err) => {
        // a single misbehaving client must never crash the process
        console.error("[lobby] ws error:", err.message);
      });
      send(ws, "setRooms", this.roomManager.listPublicRooms());
    });

    // detect half-open connections and drop them
    const interval = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }, PING_INTERVAL_MS);
    this.wss.on("close", () => clearInterval(interval));

    const broadcast = (command, roomId) => {
      // serialize once, then send the same payload to every watcher
      const data = JSON.stringify([command, roomId]);
      for (const ws of this.wss.clients) {
        if (ws.readyState === 1) ws.send(data);
      }
    };
    this.roomManager.on("roomHosted", (id) => broadcast("addRoom", id));
    this.roomManager.on("roomUnhosted", (id) => broadcast("removeRoom", id));
    this.roomManager.on("roomRemoved", (id) => broadcast("removeRoom", id));
    return this.wss;
  }

  /** Attach this WSS to an upgrade event of an existing HTTP server. */
  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req);
    });
  }

  start(port = LOBBY_PORT) {
    this.createWss();
    const server = http.createServer();
    server.on("upgrade", (req, socket, head) =>
      this.handleUpgrade(req, socket, head)
    );
    server.listen(port, () => {
      console.log(`[lobby] WebSocket server listening on :${port}`);
    });
    return this.wss;
  }
}

module.exports = LobbyServer;
