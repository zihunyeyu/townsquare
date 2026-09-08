/**
 * KOOK voice integration state (server-driven).
 *
 * The backend holds the authoritative voice state (channel tree, occupancy,
 * mute lists) of the KOOK guild bound to the current room and pushes it as
 * "kookVoice" snapshots; `bindings` maps in-room playerId -> kookUserId.
 */
const state = () => ({
  bound: false,
  guildId: "",
  guildName: "",
  guildIcon: "", // guild icon url, shown on the panel toggle once bound
  categoryId: "", // restrict the panel to voice channels under this category
  lastGuildId: "", // remembered locally to prefill the bind form
  channels: [], // [{id, name, parentId, isCategory, level, limitAmount}]
  users: {}, // kookUserId -> {id, username, nickname, avatar, online}
  occupancy: {}, // channelId -> [kookUserId]
  muted: [], // kookUserIds with server mic mute
  deafened: [], // kookUserIds with server headset mute
  bindings: {}, // playerId -> kookUserId
  selfKookId: "", // this client's bound KOOK user id
  selfKookName: "",
  selfQuery: "", // persisted "用户名#识别号" for automatic re-binding
  lastCategoryId: "", // last chosen channel category (host, auto re-applied)
  lastError: null, // { op, message, code? }
  tokenSaved: null, // { configured, verified, ts } ack of kook/setToken
});

const getters = {
  /** Channel categories (for the group selector). */
  categories(state) {
    return state.channels
      .filter((c) => c.isCategory)
      .sort((a, b) => a.level - b.level);
  },
  /** Voice channels with resolved, display-ready user lists. */
  channelList(state) {
    return state.channels
      .filter((c) => !c.isCategory)
      .map((c) => ({
        ...c,
        users: (state.occupancy[c.id] || []).map((uid) => {
          const u = state.users[uid] || { id: uid };
          return {
            ...u,
            displayName: u.nickname || u.username || uid,
            muted: state.muted.includes(uid),
            deafened: state.deafened.includes(uid),
            isSelf: uid === state.selfKookId,
          };
        }),
      }))
      .sort((a, b) => a.level - b.level);
  },
  /** Whether the bound KOOK user of this client is in any voice channel. */
  isSelfInVoice(state) {
    return Object.keys(state.occupancy).some((cid) =>
      state.occupancy[cid].includes(state.selfKookId),
    );
  },
  selfChannelId(state) {
    for (const cid of Object.keys(state.occupancy)) {
      if (state.occupancy[cid].includes(state.selfKookId)) return cid;
    }
    return null;
  },
  /** Whether the room's binding table includes this client's playerId. */
  isSelfBound(state, getters, rootState) {
    return !!state.bindings[rootState.session.playerId];
  },
  /** playerId -> display info of the bound KOOK user (for seat badges). */
  bindingsWithUser(state) {
    const map = {};
    for (const [playerId, kookId] of Object.entries(state.bindings)) {
      const u = state.users[kookId];
      map[playerId] = {
        kookId,
        name: u ? u.nickname || u.username || kookId : kookId,
        channelId: null,
      };
      for (const cid of Object.keys(state.occupancy)) {
        if (state.occupancy[cid].includes(kookId)) {
          map[playerId].channelId = cid;
          break;
        }
      }
    }
    return map;
  },
};

const mutations = {
  setBound(state, val) {
    if (!val) {
      state.bound = false;
      state.guildId = "";
      state.guildName = "";
      state.guildIcon = "";
      state.categoryId = "";
      state.channels = [];
      state.users = {};
      state.occupancy = {};
      state.muted = [];
      state.deafened = [];
      state.bindings = {};
      return;
    }
    state.bound = true;
    state.guildId = val.guildId;
    state.guildName = val.guildName || "";
    state.guildIcon = val.guildIcon || "";
    state.categoryId = val.categoryId || "";
  },
  setVoice(state, snap) {
    if (!snap) return;
    state.channels = snap.channels || [];
    state.users = snap.users || {};
    state.occupancy = snap.occupancy || {};
    state.muted = snap.muted || [];
    state.deafened = snap.deafened || [];
  },
  setBindings(state, bindings) {
    state.bindings = bindings || {};
  },
  setSelfKook(state, payload) {
    if (!payload || !payload.id) return;
    state.selfKookId = payload.id;
    state.selfKookName = payload.nickname || payload.username || "";
    // derive the re-bind query (用户名#识别号) so a refresh / fresh room can
    // re-bind automatically even if it was never typed on this device
    if (payload.username && payload.identify_num) {
      state.selfQuery = `${payload.username}#${payload.identify_num}`;
    }
  },
  setError(state, err) {
    state.lastError = err;
  },
  // Command-only mutations: intercepted by the socket plugin
  // (store.subscribe in socket.js), which forwards them to the server
  // through the LiveSession "request" channel. They only clear the stale
  // error state.
  bind(state) {
    state.lastError = null;
  },
  unbind(state) {
    state.lastError = null;
  },
  bindSelf(state) {
    state.lastError = null;
  },
  move(state) {
    state.lastError = null;
  },
  moveAll(state) {
    state.lastError = null;
  },
  mute(state) {
    state.lastError = null;
  },
  setCategory(state) {
    // command mutation: forwarded to the server by the socket plugin
    state.lastError = null;
  },
  setToken(state) {
    // command mutation: forwarded to the server by the socket plugin
    state.lastError = null;
    state.tokenSaved = null;
  },
  setTokenSaved(state, payload) {
    // ack of kook/setToken: { configured, verified } from the server
    state.tokenSaved = { ...payload, ts: Date.now() };
    if (payload && payload.configured) state.lastError = null;
  },
  setLastGuildId(state, guildId) {
    state.lastGuildId = guildId || "";
  },
  setSelfQuery(state, query) {
    state.selfQuery = query || "";
  },
  setLastCategoryId(state, categoryId) {
    state.lastCategoryId = categoryId || "";
  },
  unbindSelf(state) {
    // command mutation: forwarded to the server by the socket plugin
    state.lastError = null;
  },
  clearSelfKook(state) {
    state.selfKookId = "";
    state.selfKookName = "";
    state.selfQuery = "";
  },
  reset(state) {
    // room-scoped state is dropped; the self KOOK identity stays so the
    // user does not have to re-enter it in the next room
    state.bound = false;
    state.guildId = "";
    state.guildName = "";
    state.channels = [];
    state.users = {};
    state.occupancy = {};
    state.muted = [];
    state.deafened = [];
    state.bindings = {};
    state.lastError = null;
  },
};

export default {
  namespaced: true,
  state,
  getters,
  mutations,
};
