/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * Minimal KOOK REST API client (https://developer.kookapp.cn/doc/http).
 * No external dependencies: uses the global fetch available in Node >= 18.
 *
 * Handles bot-token auth, the {code, message, data} response envelope,
 * pagination, and 429 rate-limit retries with backoff.
 */

class KookApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.code = code; // KOOK business code (0 = ok)
    this.status = status; // HTTP status
  }
}

class KookApi {
  constructor(token, base) {
    this.token = token;
    this.base = base || "https://www.kookapp.cn/api/v3";
  }

  /**
   * Call a KOOK REST endpoint.
   * @param method HTTP method ("GET" / "POST")
   * @param path e.g. "/guild/view"
   * @param options { query: object, body: object }
   * @returns the `data` field of the response envelope
   */
  async call(method, path, { query, body } = {}, attempt = 0) {
    let url = this.base + path;
    if (query) {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== "") {
          qs.set(key, String(value));
        }
      }
      const s = qs.toString();
      if (s) url += "?" + s;
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${this.token}`,
        "Content-Type": "application/json",
        "Accept-Language": "zh-CN",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429) {
      // rate limited: honor Retry-After when present, otherwise back off
      if (attempt >= 3) {
        throw new KookApiError("KOOK API 频率超限,请稍后再试", null, 429);
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, wait));
      return this.call(method, path, { query, body }, attempt + 1);
    }
    let payload;
    try {
      payload = await res.json();
    } catch (err) {
      throw new KookApiError(
        `KOOK API 响应异常 (HTTP ${res.status})`,
        null,
        res.status
      );
    }
    if (payload.code !== 0) {
      throw new KookApiError(
        payload.message || "KOOK API 错误",
        payload.code,
        res.status
      );
    }
    return payload.data;
  }

  /** Fetch every page of a paginated GET endpoint and return all items. */
  async paged(path, query = {}) {
    const items = [];
    let page = 1;
    for (;;) {
      const data = await this.call("GET", path, {
        query: { ...query, page, page_size: 50 },
      });
      if (!data || !Array.isArray(data.items)) break;
      items.push(...data.items);
      const pageTotal = (data.meta && data.meta.page_total) || 1;
      if (page >= pageTotal) break;
      page++;
    }
    return items;
  }

  getGateway() {
    return this.call("GET", "/gateway/index", { query: { compress: 0 } });
  }

  guildView(guildId) {
    return this.call("GET", "/guild/view", { query: { guild_id: guildId } });
  }

  channelList(guildId, type) {
    return this.paged("/channel/list", { guild_id: guildId, type });
  }

  channelUserList(channelId) {
    return this.call("GET", "/channel/user-list", {
      query: { channel_id: channelId },
    });
  }

  guildUserList(guildId, search) {
    return this.paged("/guild/user-list", { guild_id: guildId, search });
  }

  /** Public profile of a user; guild_id adds the in-guild nickname. */
  userView(userId, guildId) {
    return this.call("GET", "/user/view", {
      query: { user_id: userId, guild_id: guildId },
    });
  }

  guildMuteList(guildId) {
    return this.call("GET", "/guild-mute/list", {
      query: { guild_id: guildId, return_type: "detail" },
    });
  }

  /** Move users between voice channels; users must already be in voice. */
  moveUsers(targetChannelId, userIds) {
    return this.call("POST", "/channel/move-user", {
      body: { target_id: targetChannelId, user_ids: userIds },
    });
  }

  /** Server-wide mute: type 1 = microphone, 2 = headset (deafen). */
  muteUser(guildId, userId, type = 1) {
    return this.call("POST", "/guild-mute/create", {
      body: { guild_id: guildId, user_id: userId, type },
    });
  }

  unmuteUser(guildId, userId, type = 1) {
    return this.call("POST", "/guild-mute/delete", {
      body: { guild_id: guildId, user_id: userId, type },
    });
  }
}

module.exports = { KookApi, KookApiError };
