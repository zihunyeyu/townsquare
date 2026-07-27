/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * HTTP API server (no framework needed):
 *
 *   POST /upload/avatar   { playerId, uploadContent: dataUrl }
 *                         -> { status: "success", avatarUrl: "{playerId}.{ext}" }
 *                         (used by ImageCropper.vue)
 *   GET  /avatars/{file}  serve stored avatar images
 *   GET  /dynamic/init    -> { payload: { version, floatingNotice } }
 *                         (used by the store's fetchInit action)
 *   GET  /healthz         liveness probe
 *
 * All endpoints send permissive CORS headers so the frontend can be hosted
 * on a different origin.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const {
  API_PORT,
  AVATAR_DIR,
  MAX_AVATAR_BASE64_LENGTH,
  APP_VERSION,
  FLOATING_NOTICE,
} = require("./config");
const { saveAvatar, isValidPlayerId, EXT_TO_MIME } = require("./avatarStore");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

class HttpApi {
  /**
   * The request handler, exposed so standalone.js can mount the API on a
   * shared HTTP server.
   */
  async handleRequest(req, res) {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json(res, 200, { status: "ok" });
      }
      if (req.method === "GET" && url.pathname === "/dynamic/init") {
        return json(res, 200, {
          payload: { version: APP_VERSION, floatingNotice: FLOATING_NOTICE },
        });
      }
      if (req.method === "POST" && url.pathname === "/upload/avatar") {
        return await this._uploadAvatar(req, res);
      }
      if (req.method === "GET" && url.pathname.startsWith("/avatars/")) {
        return this._serveAvatar(url.pathname.slice("/avatars/".length), res);
      }
      json(res, 404, { status: "error", message: "not found" });
    } catch (err) {
      json(res, 500, { status: "error", message: "internal error" });
    }
  }

  start(port = API_PORT) {
    fs.mkdirSync(AVATAR_DIR, { recursive: true });
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(port, () => {
      console.log(`[api] HTTP server listening on :${port}`);
    });
    return this.server;
  }

  async _uploadAvatar(req, res) {
    let body;
    try {
      // JSON envelope + base64 payload allowance
      body = await readBody(req, MAX_AVATAR_BASE64_LENGTH + 4096);
    } catch (err) {
      return json(res, 413, { status: "error", message: "图片过大" });
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      return json(res, 400, { status: "error", message: "无效的请求" });
    }
    const { playerId, uploadContent } = data || {};
    if (!isValidPlayerId(playerId) || typeof uploadContent !== "string") {
      return json(res, 400, { status: "error", message: "无效的请求" });
    }
    if (uploadContent.length > MAX_AVATAR_BASE64_LENGTH + 64) {
      return json(res, 413, { status: "error", message: "图片过大" });
    }
    const filename = saveAvatar(playerId, uploadContent);
    if (!filename) {
      return json(res, 400, { status: "error", message: "无效的图片格式" });
    }
    json(res, 200, { status: "success", avatarUrl: filename });
  }

  _serveAvatar(filename, res) {
    // prevent path traversal
    if (!/^[A-Za-z0-9_-]{1,64}\.(png|webp|jpg|gif)$/.test(filename)) {
      return json(res, 400, { status: "error", message: "无效的文件名" });
    }
    const filePath = path.join(AVATAR_DIR, filename);
    fs.readFile(filePath, (err, content) => {
      if (err) {
        return json(res, 404, { status: "error", message: "not found" });
      }
      const ext = filename.split(".").pop();
      res.writeHead(200, {
        "Content-Type": EXT_TO_MIME[ext] || "application/octet-stream",
        "Cache-Control": "public, max-age=31536000, immutable",
      });
      res.end(content);
    });
  }
}

module.exports = HttpApi;
