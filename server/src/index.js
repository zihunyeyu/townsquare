/**
 * Entry point: starts the game WebSocket server, the lobby WebSocket
 * server and the HTTP API in a single process.
 */
const RoomManager = require("./rooms");
const GameServer = require("./gameServer");
const LobbyServer = require("./lobbyServer");
const HttpApi = require("./httpApi");

const roomManager = new RoomManager();

new GameServer(roomManager).start();
new LobbyServer(roomManager).start();
new HttpApi().start();
