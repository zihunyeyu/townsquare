/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * Minimal static file server for the built frontend (dist/), with SPA
 * fallback to index.html. Used by standalone.js.
 */
const fs = require("fs");
const path = require("path");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(rootDir, req, res) {
  const url = new URL(req.url, "http://localhost");
  let pathname = decodeURIComponent(url.pathname);
  // prevent path traversal
  const filePath = path.normalize(path.join(rootDir, pathname));
  if (!filePath.startsWith(path.normalize(rootDir))) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  let target = filePath;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // SPA fallback: unknown paths serve the app shell
    if (!path.extname(pathname)) {
      target = path.join(rootDir, "index.html");
    }
    if (!fs.existsSync(target)) {
      res.writeHead(404);
      return res.end("not found");
    }
  }
  const ext = path.extname(target).toLowerCase();
  const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
  if (pathname.startsWith("/assets/")) {
    headers["Cache-Control"] = "public, max-age=2592000, immutable";
  }
  fs.readFile(target, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, headers);
    res.end(content);
  });
}

module.exports = { serveStatic };
