/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * KookVoice: an event-driven cache of a KOOK guild's voice-channel state.
 *
 * Holds the channel tree (categories + voice channels), the guild members
 * seen in voice, voice-channel occupancy and the server-wide mute lists.
 * Initialized via REST, then kept in sync by gateway events; a periodic
 * full resync guards against drift (mute changes have no gateway event).
 *
 * Emits "change" with a plain-object snapshot whenever the state changes.
 */
const EventEmitter = require("events");

const RESYNC_INTERVAL_MS = 5 * 1000;

// KOOK sometimes returns plain-http asset URLs; pages served over https
// would block them as mixed content, so always upgrade to https.
const httpsUrl = (url) =>
  typeof url === "string"
    ? url.replace(/^http:\/\/(.*\.kookapp\.cn)/, "https://$1")
    : url;

class KookVoice extends EventEmitter {
  constructor(api, guildId) {
    super();
    this.api = api;
    this.guildId = guildId;
    this.name = "";
    this.icon = ""; // guild icon url (shown as the panel toggle icon)
    this.channels = new Map(); // id -> {id,name,parentId,isCategory,level,limitAmount}
    this.users = new Map(); // userId -> {id,username,nickname,avatar,online}
    this.occupancy = new Map(); // channelId -> Set(userId)
    this.muted = new Set(); // userIds with server mic mute
    this.deafened = new Set(); // userIds with server headset mute
    this.ready = false;
    this._resyncTimer = null;
  }

  async init() {
    await this.resync();
    this.ready = true;
    this._resyncTimer = setInterval(() => {
      this.resync().catch((err) =>
        console.error(`[kook] resync failed (guild ${this.guildId}):`, err.message)
      );
    }, RESYNC_INTERVAL_MS);
  }

  destroy() {
    clearInterval(this._resyncTimer);
    this.removeAllListeners();
  }

  /** Full REST refresh of the cached state. */
  async resync() {
    const view = await this.api.guildView(this.guildId);
    this.name = view.name || "";
    this.icon = httpsUrl(view.icon || "");

    // one unfiltered listing covers voice channels AND categories alike
    // (the type filter would exclude categories from the result)
    const all = await this.api.channelList(this.guildId);
    this.channels.clear();
    this.occupancy.clear();
    for (const ch of all) {
      if (ch.type === 2 || ch.is_category) this._setChannel(ch);
    }
    for (const ch of this.channels.values()) {
      if (ch.isCategory) continue;
      const members = await this.api
        .channelUserList(ch.id)
        .catch(() => []);
      const set = new Set();
      for (const u of members) {
        set.add(u.id);
        this.upsertUser(u);
      }
      this.occupancy.set(ch.id, set);
    }

    const mutes = await this.api
      .guildMuteList(this.guildId)
      .catch(() => null);
    this.muted = new Set((mutes && mutes.mic && mutes.mic.user_ids) || []);
    this.deafened = new Set(
      (mutes && mutes.headset && mutes.headset.user_ids) || []
    );
    // a resync fixes drift that gateway events never cover (e.g. mute
    // changes); without this push the corrected state only reached clients
    // on their next page refresh
    this.emit("change", this.snapshot());
  }

  // --- state accessors ---------------------------------------------------

  /** The voice channel a user is currently in, or null. */
  channelOfUser(userId) {
    for (const [channelId, set] of this.occupancy) {
      if (set.has(userId)) return channelId;
    }
    return null;
  }

  voiceChannels() {
    return [...this.channels.values()].filter((c) => !c.isCategory);
  }

  /**
   * Serializable snapshot of the current state.
   * @param categoryId when set, only voice channels under this category
   *   (and the category itself) are included
   */
  snapshot(categoryId = null) {
    let channels = [...this.channels.values()];
    let occupancy = this.occupancy;
    if (categoryId) {
      // keep every category (for the group selector) but only the voice
      // channels under the chosen one
      channels = channels.filter(
        (c) => c.isCategory || c.parentId === categoryId
      );
      const ids = new Set(channels.map((c) => c.id));
      occupancy = new Map([...this.occupancy].filter(([cid]) => ids.has(cid)));
    }
    return {
      guildId: this.guildId,
      name: this.name,
      icon: this.icon,
      ready: this.ready,
      channels: channels.sort((a, b) => a.level - b.level),
      users: Object.fromEntries(this.users),
      occupancy: Object.fromEntries(
        [...occupancy].map(([k, v]) => [k, [...v]])
      ),
      muted: [...this.muted],
      deafened: [...this.deafened],
    };
  }

  // --- optimistic local mutations (right after a successful REST call) ---

  moveLocal(userId, toChannelId) {
    const from = this.channelOfUser(userId);
    if (from === toChannelId) return;
    if (from) this.occupancy.get(from).delete(userId);
    if (!this.occupancy.has(toChannelId)) {
      this.occupancy.set(toChannelId, new Set());
    }
    this.occupancy.get(toChannelId).add(userId);
    this.emit("change", this.snapshot());
  }

  setMuteLocal(userId, type, on) {
    const set = type === 2 ? this.deafened : this.muted;
    const had = set.has(userId);
    if (on && !had) set.add(userId);
    if (!on && had) set.delete(userId);
    if (had !== on) this.emit("change", this.snapshot());
  }

  upsertUser(u) {
    if (!u || !u.id) return false;
    const existing = this.users.get(u.id);
    const merged = {
      id: u.id,
      username: u.username !== undefined ? u.username : (existing && existing.username) || "",
      nickname: u.nickname !== undefined ? u.nickname : (existing && existing.nickname) || "",
      identify_num:
        u.identify_num !== undefined
          ? u.identify_num
          : (existing && existing.identify_num) || "",
      avatar: httpsUrl(
        u.avatar !== undefined ? u.avatar : (existing && existing.avatar) || "",
      ),
      online: u.online !== undefined ? u.online : (existing ? existing.online : true),
    };
    const changed =
      !existing ||
      existing.username !== merged.username ||
      existing.nickname !== merged.nickname ||
      existing.identify_num !== merged.identify_num ||
      existing.avatar !== merged.avatar ||
      existing.online !== merged.online;
    if (changed) this.users.set(u.id, merged);
    return changed;
  }

  // --- gateway event reducer ----------------------------------------------

  handleEvent(d) {
    const extra = d && d.extra;
    if (!extra) return;
    const body = extra.body || {};
    let dirty = false;
    switch (extra.type) {
      case "joined_channel":
        dirty = this._join(body.user_id, body.channel_id);
        break;
      case "exited_channel":
        dirty = this._leave(body.user_id, body.channel_id);
        break;
      case "added_channel":
      case "updated_channel":
        if (body.type === 2 || body.is_category) {
          dirty = this._setChannel(body);
        } else if (this.channels.delete(body.id)) {
          this.occupancy.delete(body.id);
          dirty = true;
        }
        break;
      case "deleted_channel":
        if (this.channels.delete(body.id)) {
          this.occupancy.delete(body.id);
          dirty = true;
        }
        break;
      case "guild_member_online":
      case "guild_member_offline": {
        const u = this.users.get(body.user_id);
        const online = extra.type === "guild_member_online";
        if (u && u.online !== online) {
          u.online = online;
          dirty = true;
        }
        break;
      }
      case "updated_guild_member":
        dirty = this.upsertUser({
          id: body.id || body.user_id,
          nickname: body.nickname,
          avatar: body.avatar,
          online: body.online,
        });
        break;
      case "user_updated":
        dirty = this.upsertUser({
          id: body.user_id,
          username: body.username,
          avatar: body.avatar,
        });
        break;
      default:
        break;
    }
    if (dirty) this.emit("change", this.snapshot());
  }

  // --- internals -----------------------------------------------------------

  _setChannel(ch) {
    const normalized = {
      id: String(ch.id),
      name: ch.name || "",
      parentId: String(ch.parent_id || ""),
      isCategory: !!(ch.is_category || ch.isCategory),
      level: ch.level || 0,
      limitAmount: ch.limit_amount || 0,
    };
    const existing = this.channels.get(normalized.id);
    const changed =
      !existing ||
      existing.name !== normalized.name ||
      existing.parentId !== normalized.parentId ||
      existing.isCategory !== normalized.isCategory ||
      existing.level !== normalized.level ||
      existing.limitAmount !== normalized.limitAmount;
    if (changed) {
      this.channels.set(normalized.id, normalized);
      if (!normalized.isCategory && !this.occupancy.has(normalized.id)) {
        this.occupancy.set(normalized.id, new Set());
      }
    }
    return changed;
  }

  _join(userId, channelId) {
    if (!userId || !channelId) return false;
    const ch = this.channels.get(String(channelId));
    if (!ch || ch.isCategory) return false;
    const id = String(channelId);
    if (!this.occupancy.has(id)) this.occupancy.set(id, new Set());
    const set = this.occupancy.get(id);
    if (set.has(userId)) return false;
    // a user can only be in one voice channel at a time
    const from = this.channelOfUser(userId);
    if (from) this.occupancy.get(from).delete(userId);
    set.add(userId);
    if (!this.users.has(userId)) {
      this.users.set(userId, {
        id: userId,
        username: "",
        nickname: "",
        avatar: "",
        online: true,
      });
      // gateway events carry only the user id; fetch the profile right away
      // so the name/avatar do not stay blank until the next full resync
      this._fetchUser(userId);
    }
    return true;
  }

  /** Fill in a voice joiner's profile in the background (best effort). */
  async _fetchUser(userId) {
    try {
      const u = await this.api.userView(userId, this.guildId);
      if (this.upsertUser(u)) this.emit("change", this.snapshot());
    } catch (err) {
      // profile stays blank until the next resync; not fatal
    }
  }

  _leave(userId, channelId) {
    if (!userId) return false;
    const from = this.channelOfUser(userId);
    if (!from) return false;
    // channel_id of the event is informational; remove from wherever they are
    this.occupancy.get(from).delete(userId);
    return true;
  }
}

module.exports = KookVoice;
