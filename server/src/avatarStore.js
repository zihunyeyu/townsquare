/**
 * Shared avatar storage helper. Avatars are stored as files named
 * `{playerId}.{ext}` in AVATAR_DIR and served by the HTTP API.
 */
const fs = require("fs");
const path = require("path");
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
 * `{playerId}.{ext}`. Returns the filename, or null on invalid input.
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
  const filename = `${playerId}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, filename), buffer);
  return filename;
}

const EXT_TO_MIME = Object.fromEntries(
  Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])
);

module.exports = { saveAvatar, isValidPlayerId, EXT_TO_MIME };
