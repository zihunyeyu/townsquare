/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 */
// Central configuration, all overridable via environment variables.
const path = require("path");
const fs = require("fs");

// The KOOK bot token may also be supplied via the gitignored file
// server/kook-token.txt - this avoids shell quoting issues (Git Bash/MSYS
// mangles tokens containing "/..." into Windows paths when passed as an
// environment variable).
let kookToken = process.env.KOOK_BOT_TOKEN || "";
if (!kookToken) {
  try {
    kookToken = fs
      .readFileSync(path.join(__dirname, "..", "kook-token.txt"), "utf8")
      .trim();
  } catch (err) {
    /* no token file: KOOK integration stays disabled */
  }
}

module.exports = {
  // Game WebSocket server (LiveSession in the frontend)
  GAME_PORT: Number(process.env.GAME_PORT) || 8081,
  // Lobby WebSocket server (LiveLobby in the frontend)
  LOBBY_PORT: Number(process.env.LOBBY_PORT) || 8082,
  // HTTP API (avatar upload/serving, /dynamic/init)
  API_PORT: Number(process.env.API_PORT) || 8083,

  // How long a room survives its storyteller disconnecting (ms).
  // Within this window the host may reclaim the room with the same stSecret.
  HOST_GRACE_MS: Number(process.env.HOST_GRACE_MS) || 90 * 1000,

  // Server-side WebSocket ping interval, used to measure per-connection latency (ms)
  PING_INTERVAL_MS: Number(process.env.PING_INTERVAL_MS) || 15 * 1000,

  // Max WebSocket message size (bytes). Grimoire/edition payloads can be large.
  WS_MAX_PAYLOAD: Number(process.env.WS_MAX_PAYLOAD) || 8 * 1024 * 1024,

  // Max lobby WebSocket message size (bytes); lobby messages are tiny.
  LOBBY_MAX_PAYLOAD: Number(process.env.LOBBY_MAX_PAYLOAD) || 16 * 1024,

  // KOOK integration (optional). Disabled when no bot token is configured.
  // The token must stay server-side only - never expose it to the frontend.
  KOOK_BOT_TOKEN: kookToken,
  KOOK_API_BASE: process.env.KOOK_API_BASE || "https://www.kookapp.cn/api/v3",

  // Avatar storage
  AVATAR_DIR: process.env.AVATAR_DIR || path.join(__dirname, "..", "avatars"),
  // Mirrors the frontend limit in ImageCropper.vue (1 MiB of raw image data)
  MAX_AVATAR_BASE64_LENGTH:
    Number(process.env.MAX_AVATAR_BASE64_LENGTH) || 1 * 1024 * 1024 * (4 / 3),

  // Reported by GET /dynamic/init. Defaults match this repo's frontend so
  // clients do not see an update prompt.
  APP_VERSION: process.env.APP_VERSION || "3.3.2",
  FLOATING_NOTICE: process.env.FLOATING_NOTICE || "",

  // Reserved playerIds that may not be used by clients
  RESERVED_IDS: new Set(["host", "_host", "player", "default", "lobby"]),
};
