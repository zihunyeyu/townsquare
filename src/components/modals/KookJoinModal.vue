<template>
  <Modal v-if="isBlocking" class="kook-join" @close="onClose">
    <h3><font-awesome-icon icon="volume-up" /> 加入房间</h3>

    <template v-if="!kook.bound">
      <p class="hint">等待说书人完成 KOOK 绑定…</p>
      <p class="hint">绑定完成后即可继续加入房间。</p>
    </template>

    <template v-else>
      <p class="hint">加入房间需要先绑定你的 KOOK 账号。</p>
      <div class="row">
        <input
          v-model.trim="bindInput"
          class="input"
          placeholder="KOOK用户名#识别号"
          @keyup.enter="bindSelf"
        />
        <button class="confirm-btn" @click="bindSelf">绑定</button>
      </div>
      <p v-if="kook.lastError" class="error-text">
        {{ kook.lastError.message }}
      </p>
    </template>

    <div class="row">
      <button class="remove-btn" @click="leaveSession">退出房间</button>
    </div>
  </Modal>
</template>

<script>
import Modal from "./Modal";
import { mapState } from "vuex";

export default {
  components: { Modal },
  data() {
    return {
      bindInput: "",
    };
  },
  computed: {
    ...mapState(["session", "kook"]),
    isBlocking() {
      return (
        !!this.session.sessionId &&
        this.session.isSpectator &&
        this.session.isJoinAllowed === true &&
        (!this.kook.bound || !this.kook.selfKookId)
      );
    },
  },
  methods: {
    onClose() {
      // blocking modal: the close button / backdrop click does nothing
    },
    bindSelf() {
      if (!this.bindInput) return;
      // remember the query so a refresh/reconnect can re-bind automatically
      this.$store.commit("kook/setSelfQuery", this.bindInput);
      this.$store.commit("kook/bindSelf", this.bindInput);
      this.bindInput = "";
    },
    // same cleanup as the spectator branch of Menu.leaveSession
    leaveSession() {
      // vacate seat upon leaving the room
      this.$store.commit("session/claimSeat", -1);

      this.$store.commit("session/setSpectator", false);
      this.$store.commit("session/setSessionId", "");
      this.$store.commit("session/setIsHostAllowed", null);
      this.$store.commit("session/setIsJoinAllowed", null);

      // clear seats and return to intro
      if (this.session.nomination) {
        this.$store.commit("session/nomination");
      }
      this.$store.commit("players/clear", true);

      // clear customBootlegger
      if (this.session.bootlegger) {
        this.$store.commit("session/setBootlegger", "");
      }

      // reset allowed votes
      if (this.session.playerVotes > 1) {
        this.$store.commit("session/setPlayerVotes", 1);
      }

      // reset secret vote
      if (this.session.isSecretVote) {
        this.$store.commit("session/setSecretVote", false);
      }

      // reset review
      if (this.session.isReview) {
        this.$store.commit("session/setIsReview", false);
      }

      // close chat box
      this.$store.commit("session/setChatOpen", false);

      // exit group chat
      this.session.groupChats.forEach((group) => {
        this.$store.commit("session/removeGroupChat", { chatId: group.id });
      });

      // clear messages
      while (this.session.messageQueue.length > 0) {
        this.$store.commit("session/deleteMessageQueue", 0);
      }

      // reset wraith
      this.$store.commit("session/setIsRole", {
        role: "wraith",
        property: "active",
        value: false,
      });
      this.$store.commit("session/setIsRole", {
        role: "wraith",
        property: "using",
        value: false,
        st: true,
      });
    },
  },
};
</script>

<style lang="scss" scoped>
@import "../../vars.scss";

.kook-join {
  min-width: 320px;

  h3 {
    margin-top: 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 8px 0;
    flex-wrap: wrap;
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
  }
  .remove-btn {
    background: rgba(120, 0, 0, 0.6);
  }

  .hint {
    opacity: 0.7;
    font-size: 85%;
  }

  .error-text {
    color: $demon;
    margin: 4px 0;
  }
}
</style>
