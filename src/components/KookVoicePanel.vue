<template>
  <div v-if="session.sessionId">
    <!-- floating toggle: click to open/close the panel -->
    <button
      ref="toggle"
      class="kook-toggle"
      :class="{ active: isOpen }"
      title="KOOK 语音"
      @click.stop="togglePanel"
    >
      <img
        v-if="kook.guildIcon"
        class="guild-icon"
        :src="kook.guildIcon"
        referrerpolicy="no-referrer"
        :alt="kook.guildName"
      />
      <font-awesome-icon v-else icon="volume-up" />
      <span v-if="kook.bound" class="live-dot"></span>
    </button>

    <transition name="kook-slide">
      <div v-if="isOpen" ref="panel" class="kook-voice-panel" @click.stop>
        <h3>
          <font-awesome-icon icon="volume-up" class="title-icon" />
          <span class="title-text">KOOK 语音</span>
          <span v-if="panelTitle" class="guild-name" :title="panelTitle"
            >— {{ panelTitle }}</span
          >
          <font-awesome-icon
            class="close"
            icon="times"
            @click="isOpen = false"
          />
        </h3>

        <!-- room is not bound to a KOOK guild yet -->
        <div v-if="!kook.bound" class="bind-guild">
          <p v-if="!session.isSpectator" class="hint">
            尚未绑定 KOOK 服务器,请在 菜单 → KOOK 设置 中绑定。
          </p>
          <p v-else class="hint">说书人尚未绑定 KOOK 服务器。</p>
          <p v-if="kook.lastError" class="error-text">
            {{ kook.lastError.message }}
          </p>
        </div>

        <!-- bound: show voice channels -->
        <template v-else>
          <p v-if="kook.lastError" class="error-text">
            {{ kook.lastError.message }}
          </p>

          <div v-if="!session.isSpectator" class="st-controls">
            <button class="confirm-btn" @click="muteAll(true)">全体闭麦</button>
            <button class="remove-btn" @click="muteAll(false)">解除闭麦</button>
          </div>

          <ul class="channel-list">
            <li
              v-for="channel in channelList"
              :key="channel.id"
              class="channel"
            >
              <div class="channel-head">
                <span class="channel-name">{{ channel.name }}</span>
                <span class="channel-count">
                  {{ channel.users.length
                  }}<template v-if="channel.limitAmount"
                    >/{{ channel.limitAmount }}</template
                  >
                </span>
                <button
                  v-if="
                    kook.selfKookId &&
                    isSelfBound &&
                    selfChannelId !== channel.id
                  "
                  class="confirm-btn small icon-btn"
                  :class="{ disabled: !isSelfInVoice }"
                  title="移动到此处"
                  @click="moveSelf(channel.id)"
                >
                  <font-awesome-icon icon="sign-in-alt" />
                </button>
                <button
                  v-if="kook.selfKookId && isSelfBound && kook.mainChannelId"
                  class="confirm-btn small icon-btn"
                  title="邀请主频道玩家到此处"
                  @click="toggleInvite(channel.id)"
                >
                  <font-awesome-icon icon="user-plus" />
                </button>
                <button
                  v-if="!session.isSpectator"
                  class="confirm-btn small icon-btn"
                  title="全员集合到此频道"
                  @click="moveAll(channel.id)"
                >
                  <font-awesome-icon icon="people-arrows" />
                </button>
              </div>
              <div v-if="inviteChannelId === channel.id" class="invite-box">
                <template v-if="invitablePlayers.length">
                  <label
                    v-for="p in invitablePlayers"
                    :key="p.playerId"
                    class="invite-item"
                  >
                    <input
                      v-model="inviteSelection"
                      type="checkbox"
                      :value="p.playerId"
                    />
                    <img
                      v-if="p.avatar"
                      class="invite-avatar"
                      :src="p.avatar"
                      referrerpolicy="no-referrer"
                      :alt="p.name"
                    />
                    {{ p.name }}
                  </label>
                  <div class="invite-actions">
                    <button
                      class="confirm-btn small"
                      :class="{ disabled: !inviteSelection.length }"
                      @click="sendInvite(channel.id)"
                    >
                      发送邀请
                    </button>
                    <button
                      class="remove-btn small"
                      @click="toggleInvite(null)"
                    >
                      取消
                    </button>
                  </div>
                </template>
                <span v-else class="empty">主频道内暂无可邀请的玩家</span>
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
                    referrerpolicy="no-referrer"
                    :alt="user.displayName"
                  />
                  <font-awesome-icon v-if="user.deafened" icon="volume-mute" />
                  <font-awesome-icon
                    v-else-if="user.muted"
                    icon="microphone-slash"
                  />
                  {{ user.displayName }}
                  <template v-if="seatOf(user.id)"
                    >({{ seatOf(user.id) }}号)</template
                  >
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

export default {
  computed: {
    ...mapState(["session", "kook"]),
    ...mapState("players", ["players"]),
    ...mapGetters("kook", [
      "channelList",
      "isSelfInVoice",
      "selfChannelId",
      "isSelfBound",
      "mainChannelPlayers",
    ]),
    // the title follows the current voice channel, then the selected
    // category, then the guild name
    panelTitle() {
      if (this.selfChannelId) {
        const channel = this.kook.channels.find(
          (c) => c.id === this.selfChannelId,
        );
        if (channel) return channel.name;
      }
      if (this.kook.categoryId) {
        const category = this.kook.channels.find(
          (c) => c.id === this.kook.categoryId,
        );
        if (category) return category.name;
      }
      return this.kook.guildName;
    },
    // main-channel players other than myself (invite candidates)
    invitablePlayers() {
      return this.mainChannelPlayers.filter(
        (p) => p.playerId !== this.session.playerId,
      );
    },
  },
  data() {
    return {
      isOpen: false,
      inviteChannelId: null, // channel currently in invite-selection mode
      inviteSelection: [], // selected playerIds to invite
    };
  },
  watch: {
    // auto-open once when the room gets bound, so players notice the panel
    "kook.bound"(val) {
      if (val) this.isOpen = true;
    },
  },
  mounted() {
    if (this.kook.bound) this.isOpen = true;
    window.addEventListener("keydown", this.onKeydown);
  },
  beforeDestroy() {
    window.removeEventListener("keydown", this.onKeydown);
  },
  methods: {
    togglePanel() {
      this.isOpen = !this.isOpen;
    },
    // the panel never auto-hides: only the × button / toggle / Escape close it
    onKeydown(e) {
      if (e.key === "Escape") this.isOpen = false;
    },
    moveSelf(channelId) {
      if (!this.isSelfInVoice) return;
      this.$store.commit("kook/move", channelId);
    },
    toggleInvite(channelId) {
      this.inviteChannelId = channelId;
      this.inviteSelection = [];
    },
    sendInvite(channelId) {
      if (!this.inviteSelection.length) return;
      this.$store.commit("kook/invite", {
        channelId,
        playerIds: [...this.inviteSelection],
      });
      this.toggleInvite(null);
    },
    moveAll(channelId) {
      this.$store.commit("kook/moveAll", channelId);
    },
    muteAll(mute) {
      this.$store.commit("kook/mute", { mute, type: 1 });
    },
    seatOf(kookId) {
      const playerId = Object.keys(this.kook.bindings).find(
        (pid) => this.kook.bindings[pid] === kookId,
      );
      if (!playerId) return null;
      const index = this.players.findIndex((p) => p.id === playerId);
      return index >= 0 ? index + 1 : null;
    },
  },
};
</script>

<style lang="scss" scoped>
@import "../vars.scss";

.kook-toggle {
  position: fixed;
  left: 0;
  top: 20vh;
  z-index: 70;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 42px;
  min-height: 42px;
  background: rgba(20, 20, 30, 0.78);
  backdrop-filter: blur(4px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-left: 0;
  border-radius: 0 12px 12px 0;
  box-shadow: 2px 2px 12px rgba(0, 0, 0, 0.5);
  padding: 10px;
  color: white;
  transition:
    transform 0.15s ease,
    color 0.15s ease;

  &:hover {
    transform: translateX(2px);
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
  left: 48px;
  top: calc(20vh + 54px);
  z-index: 65;
  width: 280px;
  max-height: 60vh;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.3) transparent;
  background: rgba(15, 15, 25, 0.88);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
  padding: 10px 12px;
  color: white;
  font-size: 90%;

  &::-webkit-scrollbar {
    width: 8px;
  }
  &::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.25);
    border-radius: 4px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
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

  .error-text {
    color: $demon;
    margin: 4px 0;
  }

  .invite-box {
    margin: 4px 0;
    padding: 4px 6px;
    border: 1px dashed rgba(255, 255, 255, 0.25);
    border-radius: 6px;

    .invite-item {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 2px 0;
      cursor: pointer;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .invite-avatar {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
    }

    .invite-actions {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }

    .empty {
      opacity: 0.4;
      font-size: 85%;
    }
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
    &.icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 26px;
      padding: 3px 7px;
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
  transition:
    transform 0.2s ease,
    opacity 0.2s ease;
}
.kook-slide-enter,
.kook-slide-leave-to {
  transform: translateX(-16px);
  opacity: 0;
}

// mobile: the panel becomes a bottom sheet with bigger touch targets
@media (max-width: 768px) {
  .kook-toggle {
    min-width: 48px;
    min-height: 48px;
    font-size: 110%;
  }

  .kook-voice-panel {
    left: 0;
    right: 0;
    top: auto;
    bottom: 0;
    width: 100%;
    max-height: 45vh;
    border-radius: 12px 12px 0 0;

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
  .kook-slide-leave-to {
    transform: translateY(20px);
  }
}
</style>
