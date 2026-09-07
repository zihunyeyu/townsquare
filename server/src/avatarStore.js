/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * Shared avatar storage helper. Avatars are stored as files named
 * `{playerId}-{hash8}.{ext}` in AVATAR_DIR and served by the HTTP API.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { AVATAR_DIR } = require("./config");

const MIME_TO_EXT = {
  "image/png": "png",
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/gif": "gif",
};

function isValidPlayerId(playerId) {
  return typeof playerId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(playerId);
}

/**
 * Decode a `data:image/...;base64,...` URL and save it as
 * `{playerId}-{hash8}.{ext}`. The content hash makes each new avatar a new
 * URL, so browsers/CDNs can cache the files forever and a changed avatar is
 * picked up immediately. Older avatars of the same player are removed.
 * Returns the filename, or null on invalid input.
 */
function saveAvatar(playerId, dataUrl) {
  if (!isValidPlayerId(playerId)) return null;
  const match = /^data:(image\/(?:png|webp|jpeg|gif));base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl
  );
  if (!match) return null;
  const ext = MIME_TO_EXT[match[1]];
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return null;
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 8);
  const filename = `${playerId}-${hash}.${ext}`;
  // remove previous avatars of this player (old `{playerId}.{ext}` and
  // hashed `{playerId}-*.{ext}` formats alike)
  for (const entry of fs.readdirSync(AVATAR_DIR)) {
    if (
      entry !== filename &&
      (entry.startsWith(`${playerId}-`) || entry.startsWith(`${playerId}.`))
    ) {
      fs.rmSync(path.join(AVATAR_DIR, entry), { force: true });
    }
  }
  fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
  return filename;
}

const EXT_TO_MIME = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])
);

module.exports = { saveAvatar, isValidPlayerId, EXT_TO_MIME };
