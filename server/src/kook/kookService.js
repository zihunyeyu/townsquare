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
const { KookApi } = require("./kookApi");
const KookGateway = require("./kookGateway");
const KookVoice = require("./kookVoice");
const { KOOK_BOT_TOKEN, KOOK_API_BASE } = require("../config");

class KookService extends EventEmitter {
  constructor({ token = KOOK_BOT_TOKEN, base = KOOK_API_BASE } = {}) {
    super();
    this.api = token ? new KookApi(token, base) : null;
    this.gateway = null;
    this.voices = new Map(); // guildId -> KookVoice
  }

  enabled() {
    return !!this.api;
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
    this.gateway.on("ready", () => console.log("[kook] gateway connected"));
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
    if (guildId && this.voices.has(guildId)) {
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
      this.voices.get(guildId).handleEvent(d);
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
