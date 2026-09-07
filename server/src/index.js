/**
 * Entry point: starts the game WebSocket server, the lobby WebSocket
 * server and the HTTP API in a single process.
 *
 * The startup banner and the --version / --license flags are required by
 * the license (GPLv3 + Section 7 additional terms) - do not remove.
 */
const { printBanner, handleCliFlags } = require("./banner");

if (handleCliFlags()) {
  process.exit(0);
}
printBanner();

const RoomManager = require("./rooms");
const GameServer = require("./gameServer");
const LobbyServer = require("./lobbyServer");
const HttpApi = require("./httpApi");
const KookService = require("./kook/kookService");

const roomManager = new RoomManager();
const kook = new KookService();
if (kook.enabled()) {
  console.log("[kook] integration enabled");
}

new GameServer(roomManager, kook).start();
new LobbyServer(roomManager).start();
new HttpApi().start();
