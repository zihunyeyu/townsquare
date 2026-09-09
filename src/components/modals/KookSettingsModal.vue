<template>
  <Modal class="kook-settings" v-if="modals.kookSettings" @close="onClose">
    <h3><font-awesome-icon icon="volume-up" /> KOOK 设置</h3>
    <p v-if="required" class="required-notice">
      创建房间需先完成 KOOK 绑定：请保存机器人 Token 并绑定服务器。
    </p>

    <template v-if="!session.isSpectator">
      <!-- 服务器绑定 -->
      <div class="section">
        <div class="section-title">语音服务器</div>
        <div v-if="kook.bound" class="row">
          <img
            v-if="kook.guildIcon"
            class="guild-icon"
            :src="kook.guildIcon"
            referrerpolicy="no-referrer"
            :alt="kook.guildName"
          />
          <span class="guild-name">{{ kook.guildName || kook.guildId }}</span>
          <button class="remove-btn" @click="unbind">解绑</button>
        </div>
        <template v-else>
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
            服务器 ID 可在 KOOK
            服务器设置中获得;机器人需已加入该服务器且拥有语音管理权限。
          </p>
        </template>
      </div>

      <!-- 语音分组 -->
      <div v-if="kook.bound" class="section">
        <div class="section-title">子房间分组</div>
        <div class="row">
          <select
            v-model="categorySelection"
            class="input"
            @change="setCategory"
          >
            <option value="">全部语音频道</option>
            <option v-for="cat in categories" :key="cat.id" :value="cat.id">
              {{ cat.name }}
            </option>
          </select>
        </div>
      </div>

      <!-- 主频道 -->
      <div v-if="kook.bound && categorySelection" class="section">
        <div class="section-title">主频道</div>
        <div class="row">
          <select
            v-model="mainChannelSelection"
            class="input"
            @change="setMainChannel"
          >
            <option value="">不设置</option>
            <option v-for="ch in categoryChannels" :key="ch.id" :value="ch.id">
              {{ ch.name }}
            </option>
          </select>
        </div>
        <p class="hint">
          玩家绑定后第一次进入该分组的语音频道时,会被自动拉入主频道。
        </p>
      </div>

      <!-- 机器人 Token -->
      <div class="section">
        <div class="section-title">机器人 Token</div>
        <div class="row">
          <input
            v-model.trim="tokenInput"
            class="input"
            type="password"
            placeholder="KOOK Bot Token"
            autocomplete="off"
            @keyup.enter="saveToken"
          />
          <button class="confirm-btn" @click="saveToken">保存</button>
        </div>
        <p class="hint">
          Token 仅保存在服务端,不会分发给其他玩家;保存后立即生效, 并写入
          server/kook-token.txt 以便重启后继续使用。
        </p>
        <p v-if="tokenNotice" class="hint">{{ tokenNotice }}</p>
      </div>
    </template>

    <!-- 我的 KOOK 账号:绑定/换绑对说书人与玩家都可用 -->
    <div v-if="kook.bound" class="section">
      <div class="section-title">我的 KOOK 账号</div>
      <div v-if="kook.selfKookId" class="row">
        <font-awesome-icon icon="link" />
        <span class="guild-name">
          已绑定:{{ kook.selfKookName || kook.selfKookId }}
        </span>
        <button class="remove-btn" @click="unbindSelf">解绑</button>
      </div>
      <div v-else class="row">
        <input
          v-model.trim="bindInput"
          class="input"
          placeholder="KOOK用户名#识别号"
          @keyup.enter="bindSelf"
        />
        <button class="confirm-btn" @click="bindSelf">绑定</button>
      </div>
    </div>
    <p v-else-if="session.isSpectator" class="hint">
      说书人尚未绑定 KOOK 服务器。
    </p>

    <p v-if="kook.lastError" class="error-text">
      {{ kook.lastError.message }}
    </p>
  </Modal>
</template>

<script>
import Modal from "./Modal";
import { mapGetters, mapMutations, mapState } from "vuex";

export default {
  components: { Modal },
  data() {
    return {
      guildIdInput: "",
      tokenInput: "",
      tokenNotice: "",
      categorySelection: "",
      mainChannelSelection: "",
      bindInput: "",
      wasRequired: false, // the modal was force-opened by `required`
    };
  },
  computed: {
    ...mapState(["session", "kook", "modals"]),
    ...mapGetters("kook", ["categories"]),
    // the storyteller must bind KOOK before the room becomes usable
    required() {
      return (
        !this.session.isSpectator &&
        this.session.isHostAllowed === true &&
        !this.kook.bound
      );
    },
    // voice channels under the currently selected category
    categoryChannels() {
      return this.kook.channels
        .filter((c) => !c.isCategory && c.parentId === this.categorySelection)
        .sort((a, b) => a.level - b.level);
    },
  },
  watch: {
    // force-open the modal while binding is required, auto-close it once
    // the room is bound
    required(val) {
      if (val) {
        if (!this.modals.kookSettings) {
          this.wasRequired = true;
          this.toggleModal("kookSettings");
        }
      } else if (this.wasRequired) {
        this.wasRequired = false;
        if (this.modals.kookSettings) this.toggleModal("kookSettings");
      }
    },
    // prefill from the remembered state every time the modal opens
    "modals.kookSettings"(open) {
      if (!open) return;
      this.guildIdInput = this.kook.lastGuildId || "";
      this.categorySelection = this.kook.categoryId || "";
      this.mainChannelSelection = this.kook.mainChannelId || "";
      this.tokenNotice = "";
    },
    "kook.categoryId"(val) {
      this.categorySelection = val || "";
    },
    "kook.mainChannelId"(val) {
      this.mainChannelSelection = val || "";
    },
    // token saved on the server: acknowledge and retry the pending bind
    "kook.tokenSaved"(val) {
      if (!val) return;
      this.tokenNotice = val.verified
        ? "Token 已保存并通过校验"
        : "Token 已保存(未能联机校验,绑定失败时请检查)";
      if (val.configured && this.guildIdInput && !this.kook.bound) {
        this.$store.commit("kook/bind", this.guildIdInput);
      }
      clearTimeout(this._noticeTimer);
      this._noticeTimer = setTimeout(() => (this.tokenNotice = ""), 5000);
    },
  },
  methods: {
    onClose() {
      // while binding is required the modal cannot be dismissed
      if (this.required) return;
      this.toggleModal("kookSettings");
    },
    bindGuild() {
      if (!this.guildIdInput) return;
      this.$store.commit("kook/bind", this.guildIdInput);
    },
    unbind() {
      this.$store.commit("kook/unbind");
    },
    saveToken() {
      if (!this.tokenInput) return;
      this.$store.commit("kook/setToken", this.tokenInput);
      this.tokenInput = "";
      this.tokenNotice = "正在校验并保存…";
    },
    setCategory() {
      this.$store.commit("kook/setLastCategoryId", this.categorySelection);
      this.$store.commit("kook/setCategory", this.categorySelection);
    },
    setMainChannel() {
      this.$store.commit(
        "kook/setLastMainChannelId",
        this.mainChannelSelection,
      );
      this.$store.commit("kook/setMainChannel", this.mainChannelSelection);
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
    ...mapMutations(["toggleModal"]),
  },
};
</script>

<style lang="scss" scoped>
@import "../../vars.scss";

.kook-settings {
  min-width: 320px;

  h3 {
    margin-top: 0;
  }

  .required-notice {
    color: $demon;
    font-weight: bold;
    margin: 0 0 8px;
  }

  .section {
    margin-bottom: 14px;
  }

  .section-title {
    font-weight: bold;
    opacity: 0.85;
    margin-bottom: 4px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.15);
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

  select.input option {
    background: #111;
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

  .guild-icon {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    object-fit: cover;
  }

  .guild-name {
    flex-grow: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
