/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * KookService: owns the KOOK REST client, the shared gateway connection and
 * the per-guild KookVoice caches. Created once per process; disabled (but
 * harmless) when no bot token is configured.
 */
const EventEmitter = require("events");
const fs = require("fs");
const path = require("path");
const { KookApi, KookApiError } = require("./kookApi");
const KookGateway = require("./kookGateway");
const KookVoice = require("./kookVoice");
const { KOOK_BOT_TOKEN, KOOK_API_BASE } = require("../config");

// The token set from the web UI is persisted here; config.js reads the same
// file at startup when KOOK_BOT_TOKEN is not in the environment.
const DEFAULT_TOKEN_FILE = path.join(__dirname, "..", "..", "kook-token.txt");

class KookService extends EventEmitter {
  constructor({ token = KOOK_BOT_TOKEN, base = KOOK_API_BASE, tokenFile = DEFAULT_TOKEN_FILE } = {}) {
    super();
    this.base = base;
    this.tokenFile = tokenFile;
    this.api = token ? new KookApi(token, base) : null;
    this.gateway = null;
    this.voices = new Map(); // guildId -> KookVoice
  }

  enabled() {
    return !!this.api;
  }

  /**
   * Set/replace the bot token at runtime (storyteller web UI). The token is
   * validated against the KOOK API when it is reachable; state tied to the
   * old token (gateway connection, voice caches) is torn down and the new
   * token is persisted to kook-token.txt on a best-effort basis. An empty
   * token disables the integration.
   * @returns {Promise<{configured: boolean, verified: boolean}>}
   */
  async setToken(token) {
    token = (token || "").trim();
    let verified = false;
    if (token) {
      // /gateway/index is a cheap authenticated call with no side effects
      const probe = new KookApi(token, this.base);
      try {
        await probe.getGateway();
        verified = true;
      } catch (err) {
        // A KOOK business/HTTP error means the token itself was rejected;
        // a plain network failure must not block saving (KOOK may just be
        // unreachable from this host right now).
        if (err instanceof KookApiError) throw err;
      }
    }
    this._teardown();
    this.api = token ? new KookApi(token, this.base) : null;
    this._persistToken(token);
    return { configured: !!this.api, verified };
  }

  _teardown() {
    if (this.gateway) {
      this.gateway.close();
      this.gateway = null;
    }
    this.voices.clear();
  }

  _persistToken(token) {
    try {
      fs.writeFileSync(this.tokenFile, token ? token + "\n" : "", "utf8");
    } catch (err) {
      console.warn("[kook] 无法写入 kook-token.txt:", err.message);
    }
  }

  /**
   * Get (or create and initialize) the voice-state cache for a guild.
   * Throws when the bot cannot access the guild (not a member, bad id).
   */
  async getVoice(guildId) {
    if (!this.api) {
      throw new Error("后端未配置 KOOK_BOT_TOKEN");
    }
    let voice = this.voices.get(guildId);
    if (voice && voice.ready) return voice;
    voice = new KookVoice(this.api, guildId);
    await voice.init(); // throws when the guild is unreachable
    this._ensureGateway();
    voice.on("change", (snap) => this.emit("voiceChange", guildId, snap));
    this.voices.set(guildId, voice);
    return voice;
  }

  _ensureGateway() {
    if (this.gateway) return;
    this.gateway = new KookGateway(this.api);
    this.gateway.on("event", (d) => this._route(d));
    this.gateway.on("ready", () => {
      console.log("[kook] gateway connected");
      // events may have been missed while the gateway was down; reconcile
      // every cached guild right away (resync pushes a fresh snapshot to
      // the room) instead of waiting for the periodic resync
      for (const voice of this.voices.values()) {
        voice
          .resync()
          .catch((err) =>
            console.error("[kook] resync after reconnect failed:", err.message)
          );
      }
    });
    this.gateway.connect();
  }

  /** Route a gateway event to the voice cache(s) it belongs to. */
  _route(d) {
    const extra = d && d.extra;
    if (!extra) return;
    const body = extra.body || {};
    // the guild id lives in different places depending on the event type:
    // message events carry extra.guild_id, channel events carry
    // body.guild_id, and system events (joined_channel, guild_member_*,
    // ...) only have the top-level target_id
    const guildId =
      extra.guild_id ||
      body.guild_id ||
      (d.channel_type === "GROUP" ? d.target_id : null);
    let voice = guildId ? this.voices.get(guildId) : null;
    if (!voice && body.channel_id) {
      // fallback: some event shapes do not resolve to a guild id at all;
      // find the voice cache holding the affected channel instead
      for (const v of this.voices.values()) {
        if (v.channels.has(String(body.channel_id))) {
          voice = v;
          break;
        }
      }
    }
    if (voice) {
      if (
        [
          "joined_channel",
          "exited_channel",
          "added_channel",
          "updated_channel",
          "deleted_channel",
        ].includes(extra.type)
      ) {
        console.log(`[kook] event ${extra.type}`, JSON.stringify(body).slice(0, 120));
      }
      voice.handleEvent(d);
      return;
    }
    // member online/offline events carry a list of shared guilds
    if (Array.isArray(body.guilds)) {
      for (const g of body.guilds) {
        const voice = this.voices.get(g);
        if (voice) voice.handleEvent(d);
      }
      return;
    }
    // user_updated has no guild context: apply to every guild that knows
    // the user
    if (extra.type === "user_updated") {
      for (const voice of this.voices.values()) {
        if (voice.users.has(body.user_id)) voice.handleEvent(d);
      }
    }
  }
}

module.exports = KookService;
