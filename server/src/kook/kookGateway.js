/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * KOOK Gateway (WebSocket) client.
 * Implements the connection lifecycle documented at
 * https://developer.kookapp.cn/doc/websocket:
 *   fetch gateway url -> hello (s=1) -> heartbeat ping/pong (s=2/3)
 *   -> resume (url params) / reconnect (s=5) with exponential backoff.
 * Incoming events (s=0) are de-duplicated / re-ordered by `sn` and
 * re-emitted as "event".
 */
const WebSocket = require("ws");
const EventEmitter = require("events");

const HELLO_TIMEOUT_MS = 6 * 1000;
const PONG_TIMEOUT_MS = 6 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const MAX_BUFFERED_EVENTS = 50;

class KookGateway extends EventEmitter {
  constructor(api) {
    super();
    this.api = api;
    this.ws = null;
    this.sessionId = null;
    this.sn = 0;
    this._buffer = new Map(); // sn -> event data (out-of-order stash)
    this._heartbeatTimer = null;
    this._pongTimer = null;
    this._helloTimer = null;
    this._reconnectTimer = null;
    this._closed = false;
    this._failures = 0; // consecutive failed/dead connections
  }

  async connect() {
    if (this._closed) return;
    let url;
    try {
      const data = await this.api.getGateway();
      url = data && data.url;
    } catch (err) {
      console.error("[kook] gateway fetch failed:", err.message);
    }
    if (!url) {
      this._scheduleReconnect();
      return;
    }
    // resume the previous session when we have one
    if (this.sessionId && this.sn > 0) {
      const sep = url.includes("?") ? "&" : "?";
      url += `${sep}resume=1&sn=${this.sn}&session_id=${this.sessionId}`;
    }
    this._open(url);
  }

  close() {
    this._closed = true;
    clearTimeout(this._reconnectTimer);
    this._stopHeartbeat();
    clearTimeout(this._helloTimer);
    if (this.ws) {
      try {
        this.ws.close(1000);
      } catch (err) {
        /* ignore */
      }
      this.ws = null;
    }
  }

  _open(url) {
    if (this._closed) return;
    const ws = new WebSocket(url);
    this.ws = ws;
    // hello must arrive within 6s of connect
    this._helloTimer = setTimeout(() => {
      try {
        ws.terminate();
      } catch (err) {
        /* ignore */
      }
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data) => this._onMessage(data));
    ws.on("close", () => this._onClose());
    ws.on("error", (err) => {
      // never let a socket error crash the process; close follows anyway
      console.error("[kook] gateway ws error:", err.message);
    });
  }

  _onMessage(data) {
    let packet;
    try {
      packet = JSON.parse(data);
    } catch (err) {
      return; // not JSON (should not happen with compress=0)
    }
    switch (packet.s) {
      case 0:
        this._onEvent(packet);
        break;
      case 1:
        this._onHello(packet.d || {});
        break;
      case 3:
        clearTimeout(this._pongTimer); // pong
        break;
      case 5:
        // server demands a full reconnect; session state must be reset
        this._resetSession();
        try {
          this.ws && this.ws.close();
        } catch (err) {
          /* ignore */
        }
        this._scheduleReconnect();
        break;
      case 6:
        break; // resume ack, nothing to do
      default:
        break;
    }
  }

  _onHello(d) {
    clearTimeout(this._helloTimer);
    if (d.code === 0) {
      this.sessionId = d.session_id;
      this._failures = 0;
      this._startHeartbeat();
      this.emit("ready");
    } else {
      // invalid/expired token etc: fresh login
      this._resetSession();
      this._scheduleReconnect();
    }
  }

  _onEvent({ d, sn }) {
    if (typeof sn !== "number") return;
    if (sn <= this.sn) return; // duplicate
    if (sn === this.sn + 1) {
      this.sn = sn;
      this.emit("event", d);
      // flush buffered contiguous events
      while (this._buffer.has(this.sn + 1)) {
        const next = this._buffer.get(this.sn + 1);
        this._buffer.delete(this.sn + 1);
        this.sn++;
        this.emit("event", next);
      }
    } else {
      // out-of-order: stash until the gap is filled
      this._buffer.set(sn, d);
      if (this._buffer.size > MAX_BUFFERED_EVENTS) {
        this._scheduleReconnect();
        try {
          this.ws && this.ws.close();
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    const tick = () => {
      if (this._closed || !this.ws || this.ws.readyState !== 1) return;
      this.ws.send(JSON.stringify({ s: 2, sn: this.sn }));
      this._pongTimer = setTimeout(() => {
        // no pong in time: the connection is dead, drop it
        try {
          this.ws && this.ws.terminate();
        } catch (err) {
          /* ignore */
        }
      }, PONG_TIMEOUT_MS);
      // heartbeat interval: 30s with ±5s jitter per the docs
      const jitter = Math.floor(Math.random() * 10000) - 5000;
      this._heartbeatTimer = setTimeout(tick, HEARTBEAT_MS + jitter);
    };
    this._heartbeatTimer = setTimeout(tick, HEARTBEAT_MS);
  }

  _stopHeartbeat() {
    clearTimeout(this._heartbeatTimer);
    clearTimeout(this._pongTimer);
    this._heartbeatTimer = null;
    this._pongTimer = null;
  }

  _onClose() {
    this._stopHeartbeat();
    clearTimeout(this._helloTimer);
    if (this._closed) return;
    this._scheduleReconnect();
  }

  _resetSession() {
    this.sessionId = null;
    this.sn = 0;
    this._buffer.clear();
  }

  _scheduleReconnect() {
    if (this._closed) return;
    this._stopHeartbeat();
    this._failures++;
    // resume works only for the first couple of attempts; after that the
    // session is likely gone, so fall back to a fresh login
    if (this._failures > 2) this._resetSession();
    const delay = Math.min(60000, 2000 * 2 ** Math.min(this._failures, 5));
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }
}

module.exports = KookGateway;
