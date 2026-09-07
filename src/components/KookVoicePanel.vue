<template>
  <div v-if="session.sessionId">
    <div
      ref="toggle"
      class="kook-toggle"
      :class="{ active: isOpen, 'edge-right': edge === 'right', dragging: dragging }"
      :style="toggleStyle"
      title="KOOK 语音(可拖动)"
      @pointerdown="onPointerDown"
    >
      <img
        v-if="kook.guildIcon"
        class="guild-icon"
        :src="kook.guildIcon"
        :alt="kook.guildName"
      />
      <font-awesome-icon v-else icon="volume-up" />
      <span v-if="kook.bound" class="live-dot"></span>
    </div>
    <transition name="kook-slide">
      <div
        v-if="isOpen"
        class="kook-voice-panel"
        :class="{ 'edge-right': edge === 'right' }"
        :style="panelStyle"
        @click.stop
      >
        <h3>
          <font-awesome-icon icon="volume-up" class="title-icon" />
          <span class="title-text">KOOK 语音</span>
          <span
            v-if="kook.guildName"
            class="guild-name"
            :title="kook.guildName"
          >— {{ kook.guildName }}</span>
          <font-awesome-icon class="close" icon="times" @click="isOpen = false" />
        </h3>

        <!-- room is not bound to a KOOK guild yet -->
        <div v-if="!kook.bound" class="bind-guild">
          <template v-if="!session.isSpectator">
            <p>输入 KOOK 服务器 ID,将本房间与该服务器的语音频道关联:</p>
            <div class="row">
              <input
                v-model.trim="guildIdInput"
                class="input"
                placeholder="KOOK 服务器 ID"
                @keyup.enter="bindGuild"
              />
              <button class="confirm-btn" @click="bindGuild">绑定</button>
            </div>
            <p class="hint">
              服务器 ID 可在 KOOK 服务器设置中获得;机器人需已加入该服务器且拥有语音管理权限。
            </p>
          </template>
          <p v-else class="hint">说书人尚未绑定 KOOK 服务器。</p>
        </div>

        <!-- bound: show voice channels -->
        <template v-else>
          <div class="self-bind">
            <template v-if="kook.selfKookId">
              <font-awesome-icon icon="link" />
              <span class="bound-name">
                已绑定:{{ kook.selfKookName || kook.selfKookId }}
              </span>
              <button class="remove-btn small" @click="unbindSelf">解绑</button>
              <span v-if="!isSelfBound" class="warning-text">绑定同步中…</span>
              <span v-else-if="!isSelfInVoice" class="warning-text">
                请先在 KOOK 客户端进入任意语音频道,之后才能在网页端切换
              </span>
            </template>
            <template v-else>
              <input
                v-model.trim="bindInput"
                class="input"
                placeholder="KOOK用户名#识别号"
                @keyup.enter="bindSelf"
              />
              <button class="confirm-btn" @click="bindSelf">绑定我的 KOOK 账号</button>
            </template>
          </div>

          <p v-if="kook.lastError" class="error-text">{{ kook.lastError.message }}</p>

          <div v-if="!session.isSpectator" class="row">
            <span class="label">子房间分组</span>
            <select v-model="categorySelection" class="input" @change="setCategory">
              <option value="">全部语音频道</option>
              <option v-for="cat in categories" :key="cat.id" :value="cat.id">
                {{ cat.name }}
              </option>
            </select>
          </div>

          <div v-if="!session.isSpectator" class="st-controls">
            <button class="confirm-btn" @click="muteAll(true)">全体闭麦</button>
            <button class="remove-btn" @click="muteAll(false)">解除闭麦</button>
            <button class="remove-btn" @click="unbind">解绑服务器</button>
          </div>

          <ul class="channel-list">
            <li v-for="channel in channelList" :key="channel.id" class="channel">
              <div class="channel-head">
                <span class="channel-name">{{ channel.name }}</span>
                <span class="channel-count">
                  {{ channel.users.length
                  }}<template v-if="channel.limitAmount">/{{ channel.limitAmount }}</template>
                </span>
                <button
                  v-if="kook.selfKookId && isSelfBound && selfChannelId !== channel.id"
                  class="confirm-btn small"
                  :class="{ disabled: !isSelfInVoice }"
                  @click="moveSelf(channel.id)"
                >
                  移动到此处
                </button>
                <button
                  v-if="!session.isSpectator"
                  class="confirm-btn small"
                  @click="moveAll(channel.id)"
                >
                  全员集合
                </button>
              </div>
              <div class="user-list">
                <span
                  v-for="user in channel.users"
                  :key="user.id"
                  class="user-chip"
                  :class="{ offline: user.online === false, self: user.isSelf }"
                >
                  <img
                    v-if="user.avatar"
                    class="chip-avatar"
                    :src="user.avatar"
                    :alt="user.displayName"
                  />
                  <font-awesome-icon v-if="user.deafened" icon="volume-mute" />
                  <font-awesome-icon v-else-if="user.muted" icon="microphone-slash" />
                  {{ user.displayName }}
                  <template v-if="seatOf(user.id)">({{ seatOf(user.id) }}号)</template>
                </span>
                <span v-if="!channel.users.length" class="empty">(空)</span>
              </div>
            </li>
          </ul>
        </template>
      </div>
    </transition>
  </div>
</template>

<script>
import { mapGetters, mapState } from "vuex";

const STORAGE_KEY = "kookVoiceBtn";

export default {
  computed: {
    ...mapState(["session", "kook"]),
    ...mapState("players", ["players"]),
    ...mapGetters("kook", [
      "channelList",
      "categories",
      "isSelfInVoice",
      "selfChannelId",
      "isSelfBound"
    ]),
    toggleStyle() {
      const x = this.dragging
        ? this.dragX
        : this.edge === "left"
        ? 0
        : this.windowWidth - this.toggleWidth;
      return { left: x + "px", top: this.posY + "px" };
    },
    panelStyle() {
      // on narrow (mobile) screens the panel becomes a bottom sheet and is
      // positioned entirely by CSS
      if (this.windowWidth <= 768) return {};
      // place the panel below the toggle (above it when near the viewport
      // bottom) so the toggle never covers the expanded panel
      const panelMaxH = this.windowHeight * 0.6;
      let top = this.posY + this.toggleHeight + 8;
      if (top + panelMaxH > this.windowHeight - 10) {
        top = Math.max(10, this.posY - panelMaxH - 8);
      }
      return this.edge === "left"
        ? { left: 0, top: top + "px" }
        : { right: 0, top: top + "px" };
    }
  },
  data() {
    return {
      isOpen: false,
      guildIdInput: "",
      bindInput: "",
      categorySelection: "",
      // draggable toggle state
      edge: "left", // snapped screen edge: "left" | "right"
      posY: Math.round(window.innerHeight * 0.2),
      dragging: false,
      dragX: 0,
      toggleWidth: 46,
      toggleHeight: 46,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight
    };
  },
  watch: {
    // auto-open once when the room gets bound, so players notice the panel
    "kook.bound"(val) {
      if (val) this.isOpen = true;
    },
    // keep the dropdown in sync with the server-confirmed category
    "kook.categoryId"(val) {
      this.categorySelection = val || "";
    }
  },
  mounted() {
    if (this.kook.lastGuildId) this.guildIdInput = this.kook.lastGuildId;
    if (this.kook.bound) this.isOpen = true;
    this.categorySelection = this.kook.categoryId || "";
    // restore the toggle position
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && (saved.edge === "left" || saved.edge === "right")) {
        this.edge = saved.edge;
        if (typeof saved.y === "number") this.posY = saved.y;
      }
    } catch (e) {
      /* ignore broken stored position */
    }
    this.clampPosition();
    window.addEventListener("resize", this.onResize);
    this.$nextTick(() => {
      if (this.$refs.toggle) {
        this.toggleWidth = this.$refs.toggle.offsetWidth || 46;
        this.toggleHeight = this.$refs.toggle.offsetHeight || 46;
      }
    });
  },
  beforeDestroy() {
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
  },
  methods: {
    bindGuild() {
      if (!this.guildIdInput) return;
      this.$store.commit("kook/bind", this.guildIdInput);
    },
    unbind() {
      this.$store.commit("kook/unbind");
    },
    bindSelf() {
      if (!this.bindInput) return;
      // remember the query so a refresh/reconnect can re-bind automatically
      this.$store.commit("kook/setSelfQuery", this.bindInput);
      this.$store.commit("kook/bindSelf", this.bindInput);
      this.bindInput = "";
    },
    unbindSelf() {
      // clear the local binding first so the auto re-bind does not refire
      this.$store.commit("kook/clearSelfKook");
      this.$store.commit("kook/unbindSelf");
    },
    moveSelf(channelId) {
      if (!this.isSelfInVoice) return;
      this.$store.commit("kook/move", channelId);
    },
    moveAll(channelId) {
      this.$store.commit("kook/moveAll", channelId);
    },
    muteAll(mute) {
      this.$store.commit("kook/mute", { mute, type: 1 });
    },
    setCategory() {
      this.$store.commit("kook/setLastCategoryId", this.categorySelection);
      this.$store.commit("kook/setCategory", this.categorySelection);
    },
    seatOf(kookId) {
      const playerId = Object.keys(this.kook.bindings).find(
        pid => this.kook.bindings[pid] === kookId
      );
      if (!playerId) return null;
      const index = this.players.findIndex(p => p.id === playerId);
      return index >= 0 ? index + 1 : null;
    },
    // --- drag & edge snap -------------------------------------------------
    onPointerDown(e) {
      e.preventDefault();
      this.pressed = true;
      this.dragging = false;
      this._startX = e.clientX;
      this._startY = e.clientY;
      window.addEventListener("pointermove", this.onPointerMove);
      window.addEventListener("pointerup", this.onPointerUp, { once: true });
    },
    onPointerMove(e) {
      if (!this.pressed) return;
      const dx = e.clientX - this._startX;
      const dy = e.clientY - this._startY;
      if (!this.dragging && Math.hypot(dx, dy) > 6) this.dragging = true;
      if (this.dragging) {
        this.dragX = Math.min(
          Math.max(e.clientX - this.toggleWidth / 2, 0),
          this.windowWidth - this.toggleWidth
        );
        this.posY = Math.min(
          Math.max(e.clientY - 20, 10),
          this.windowHeight - 60
        );
      }
    },
    onPointerUp(e) {
      this.pressed = false;
      window.removeEventListener("pointermove", this.onPointerMove);
      if (this.dragging) {
        // snap to the nearest screen edge and remember the position
        this.edge = e.clientX < this.windowWidth / 2 ? "left" : "right";
        this.dragging = false;
        try {
          localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({ edge: this.edge, y: this.posY })
          );
        } catch (err) {
          /* storage full/denied: position just won't persist */
        }
      } else {
        // plain click: toggle the panel
        this.isOpen = !this.isOpen;
      }
    },
    onResize() {
      this.windowWidth = window.innerWidth;
      this.windowHeight = window.innerHeight;
      this.clampPosition();
    },
    clampPosition() {
      this.posY = Math.min(Math.max(this.posY, 10), this.windowHeight - 60);
    }
  }
};
</script>

<style lang="scss" scoped>
@import "../vars.scss";

.kook-toggle {
  position: fixed;
  z-index: 70;
  cursor: grab;
  background: rgba(0, 0, 0, 0.7);
  border: 3px solid black;
  border-left: 0;
  border-radius: 0 10px 10px 0;
  padding: 10px 8px;
  color: white;
  transition: left 0.25s ease, top 0.25s ease;
  touch-action: none;
  user-select: none;

  &.dragging {
    cursor: grabbing;
    transition: none;
  }

  &.edge-right {
    border: 3px solid black;
    border-right: 0;
    border-radius: 10px 0 0 10px;
  }

  &:hover {
    color: $townsfolk;
  }
  &.active {
    color: $townsfolk;
  }

  .live-dot {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #4caf50;
  }

  .guild-icon {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: block;
    object-fit: cover;
  }
}

.kook-voice-panel {
  position: fixed;
  z-index: 65;
  width: 260px;
  max-height: 60vh;
  overflow-y: auto;
  overflow-x: hidden;
  background: rgba(0, 0, 0, 0.85);
  border: 3px solid black;
  border-left: 0;
  border-radius: 0 10px 10px 0;
  padding: 10px 12px;
  color: white;
  font-size: 90%;

  &.edge-right {
    border: 3px solid black;
    border-right: 0;
    border-radius: 10px 0 0 10px;
  }

  h3 {
    margin: 0 0 8px;
    color: $townsfolk;
    display: flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;

    .title-icon,
    .title-text {
      flex-shrink: 0;
    }

    .guild-name {
      color: white;
      font-size: 85%;
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .close {
      cursor: pointer;
      flex-shrink: 0;
      margin-left: auto;
      &:hover {
        color: red;
      }
    }
  }

  .hint {
    opacity: 0.7;
    font-size: 85%;
  }

  .row,
  .self-bind {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 0;
    flex-wrap: wrap;
  }

  .bound-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex-shrink: 1;
  }

  .label {
    opacity: 0.8;
    font-size: 85%;
  }

  .input {
    flex-grow: 1;
    min-width: 0;
    padding: 4px 8px;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.3);
    background: rgba(255, 255, 255, 0.1);
    color: white;
  }

  select.input option {
    background: #111;
  }

  .warning-text {
    color: #f0a500;
    font-size: 85%;
  }

  .error-text {
    color: $demon;
    margin: 4px 0;
  }

  .st-controls {
    display: flex;
    gap: 6px;
    margin: 8px 0;
    flex-wrap: wrap;
  }

  .confirm-btn,
  .remove-btn {
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.4);
    border-radius: 5px;
    padding: 4px 10px;
    background: rgba(0, 60, 120, 0.6);
    color: white;
    &:hover {
      filter: brightness(1.3);
    }
    &.small {
      padding: 2px 8px;
      font-size: 85%;
    }
    &.disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
  }
  .remove-btn {
    background: rgba(120, 0, 0, 0.6);
  }

  .channel-list {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    list-style: none;
    margin: 0;
    padding: 0;

    .channel {
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 8px;
      padding: 6px 8px;
      margin: 4px 0;
    }

    .channel-head {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
    }

    .channel-name {
      font-weight: bold;
      color: $townsfolk;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    .channel-count {
      opacity: 0.6;
      font-size: 85%;
      flex-grow: 1;
      white-space: nowrap;
    }

    .confirm-btn.small {
      white-space: nowrap;
      flex-shrink: 0;
    }

    .user-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 4px;
    }

    .user-chip {
      // inline-flex + nowrap: the chip must wrap as a whole unit, never
      // split its background across wrapped text fragments
      display: inline-flex;
      align-items: center;
      white-space: nowrap;
      background: rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 85%;
      max-width: 100%;
      overflow: hidden;
      &.offline {
        opacity: 0.45;
      }
      &.self {
        border: 1px solid $townsfolk;
      }
      svg {
        margin-right: 2px;
        flex-shrink: 0;
      }
      .chip-avatar {
        width: 16px;
        height: 16px;
        border-radius: 50%;
        margin-right: 3px;
        object-fit: cover;
        flex-shrink: 0;
      }
    }

    .empty {
      opacity: 0.4;
      font-size: 85%;
    }
  }
}

.kook-slide-enter-active,
.kook-slide-leave-active {
  transition: transform 0.2s ease, opacity 0.2s ease;
}
.kook-slide-enter,
.kook-slide-leave-to {
  transform: translateX(-20px);
  opacity: 0;
}
.kook-slide-enter.edge-right,
.kook-slide-leave-to.edge-right,
.edge-right.kook-slide-enter,
.edge-right.kook-slide-leave-to {
  transform: translateX(20px);
}

// mobile: the panel becomes a bottom sheet with bigger touch targets
@media (max-width: 768px) {
  .kook-toggle {
    padding: 12px 10px;
    font-size: 110%;
  }

  .kook-voice-panel {
    left: 0 !important;
    right: 0 !important;
    top: auto !important;
    bottom: 0;
    width: 100%;
    max-height: 45vh;
    border-radius: 12px 12px 0 0 !important;
    border: 3px solid black !important;
    border-bottom: 0 !important;
    padding: 12px 14px;
    font-size: 100%;

    .confirm-btn,
    .remove-btn {
      padding: 8px 12px;
      &.small {
        padding: 6px 10px;
        font-size: 90%;
      }
    }
  }

  .kook-slide-enter,
  .kook-slide-leave-to,
  .kook-slide-enter.edge-right,
  .kook-slide-leave-to.edge-right {
    transform: translateY(20px) !important;
  }
}
</style>
