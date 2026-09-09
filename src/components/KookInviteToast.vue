<template>
  <!-- pending channel invites: accept moves this client to the channel -->
  <div v-if="kook.invites.length" class="kook-invites">
    <div
      v-for="(invite, index) in kook.invites"
      :key="index"
      class="invite-card"
    >
      <div class="invite-title">
        <img
          v-if="invite.from && invite.from.avatar"
          class="invite-avatar"
          :src="invite.from.avatar"
          referrerpolicy="no-referrer"
          :alt="invite.from.name"
        />
        <span>
          <b>{{ invite.from && invite.from.name }}</b>
          邀请你前往「{{ invite.channelName }}」
        </span>
      </div>
      <div v-if="invite.invitees && invite.invitees.length" class="invitees">
        同时邀请:{{ invite.invitees.join("、") }}
      </div>
      <div class="row">
        <button class="confirm-btn" @click="accept(index)">接受</button>
        <button class="remove-btn" @click="decline(index)">拒绝</button>
      </div>
    </div>
  </div>
</template>

<script>
import { mapState } from "vuex";

export default {
  computed: {
    ...mapState(["kook"]),
  },
  methods: {
    accept(index) {
      const invite = this.kook.invites[index];
      if (invite) this.$store.commit("kook/move", invite.channelId);
      this.$store.commit("kook/removeInvite", index);
    },
    decline(index) {
      this.$store.commit("kook/removeInvite", index);
    },
  },
};
</script>

<style lang="scss" scoped>
@import "../vars.scss";

.kook-invites {
  position: fixed;
  right: 10px;
  top: 20vh;
  z-index: 80;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 280px;
}

.invite-card {
  background: rgba(15, 15, 25, 0.92);
  backdrop-filter: blur(6px);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 12px;
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6);
  padding: 10px 12px;
  color: white;
  font-size: 90%;

  .invite-title {
    display: flex;
    align-items: center;
    gap: 6px;

    b {
      color: $townsfolk;
    }
  }

  .invite-avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    object-fit: cover;
    flex-shrink: 0;
  }

  .invitees {
    opacity: 0.7;
    font-size: 85%;
    margin: 4px 0;
  }

  .row {
    display: flex;
    gap: 6px;
    margin-top: 8px;
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
}
</style>
