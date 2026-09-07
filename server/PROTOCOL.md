# Townsquare 后端协议

本文档由前端 `src/store/socket.js`（`LiveSession` / `LiveLobby`）反向整理而成，
是本仓库 `server/` 目录中参考实现的规范。标注 *(实现决策)* 的条目是前端无法约束、
由服务器自行决定的行为。

## 1. 架构总览

服务器是**无游戏状态**的薄层，只有三个职责：房间注册、消息中继、准入检查。
游戏状态（座位、角色、投票等）的权威副本在说书人（host）的客户端上；
新玩家加入后直接向 host 拉取全量状态（`getGamestate`）。

三个服务：

| 服务 | 默认端口 | 用途 |
|---|---|---|
| 游戏 WebSocket | 8081 | 房间内的实时会话 |
| 大厅 WebSocket | 8082 | 可加入房间列表的推送 |
| HTTP API | 8083 | 头像上传/读取、版本与公告 |

## 2. 连接

### 2.1 游戏频道

```
玩家:   ws://{host}:{port}/{channel}/{playerId}
说书人: ws://{host}:{port}/{channel}/{playerId}/host?auth={stSecret}
```

- `channel`：房间号，1–10000 的整数。
- `playerId`：客户端生成的随机字符串；保留字 `host`、`_host`、`player`、
  `default`、`lobby` 不可用。
- `stSecret`：说书人密钥（前端生成的 32 字节随机 base64url）。首次创建房间时
  由服务器记录；之后只有在密钥匹配时才允许重连夺回主持权。
- 连接参数非法时，服务器以 **code 1000 + reason** 关闭连接 *(实现决策：
  前端只在 code !== 1000 时自动重连，用 1000 可避免无效连接的重连风暴)*。

### 2.2 大厅频道

```
ws://{host}:{port}/{playerId}
```

连接成功后服务器立即推送一次 `setRooms`。

### 2.3 报文格式

所有消息均为 JSON 数组：

```
[command, params, feedback?]
```

- `feedback`：可靠投递的消息 ID（通常为时间戳）。不需要确认的消息为 `false` 或省略。

## 3. 上行消息（客户端 → 服务器）

### 3.1 `direct` — 定向消息

```json
["direct", { "<targetId>": [command, params], ... }, feedback]
```

- `targetId` 为 `"host"` 时路由到房间的说书人，否则路由到对应的 `playerId`。
- 一个 `direct` 可携带**多个目标**（如说书人群发角色），服务器逐个拆分投递。
- 投递时对目标**解包**：目标客户端收到的是 `[command, params, feedback]`，
  不再有 `direct` 外壳。
- 若带 `feedback` 且目标不在线，服务器暂存该消息，目标重连后补投 *(实现决策)*。

### 3.2 `request` — 服务器命令

```json
["request", { "<command>": [playerId, params] }]
```

| command | 说明 | 服务器响应 |
|---|---|---|
| `checkAllowHost` | 说书人请求主持房间 | `["allowHost", bool]` |
| `checkAllowJoin` | 玩家请求加入房间 | `["allowJoin", bool]` |
| `deleteMessage` | 可靠投递确认，`params = [queueType, feedbackId]` | 向原发送方转发 `["feedback", feedbackId]` |
| `kookBind` | 绑定房间到 KOOK 服务器，`params = { guildId }`（仅 host） | 广播 `kookBound` + `kookVoice` |
| `kookUnbind` | 解除绑定（仅 host） | 广播 `["kookBound", null]` |
| `kookBindUser` | 绑定自己的 KOOK 账号，`params = { query: "用户名#识别号" }` | 广播 `kookBindings`；向本人回 `kookBoundUser` |
| `kookUnbindUser` | 解除自己的 KOOK 绑定 | 广播 `kookBindings`；未绑定回 `kookError` |
| `kookMove` | 把自己移到指定语音频道，`params = { channelId }` | 广播 `kookVoice`；失败回 `kookError` |
| `kookMoveAll` | 全员移到指定语音频道（仅 host），`params = { channelId }` | 广播 `kookVoice` |
| `kookMute` | 服务器级闭麦/解除（仅 host），`params = { userIds?, mute?, type? }`（type 1=麦克风 2=耳机） | 广播 `kookVoice` |
| `kookSetCategory` | 限定本局使用的语音频道分组（仅 host），`params = { categoryId }`，空值解除 | 广播 `kookBound` + `kookVoice`（按分组过滤） |
| `kookSync` | 请求重发当前 KOOK 状态 | `kookBound` + `kookBindings` + `kookVoice` |

`allowHost` 判定：房间无活跃 host，或 `stSecret` 与房间记录匹配（重连夺回）。
`allowJoin` 判定：房间当前有活跃 host。
KOOK 指令的失败一律以 `["kookError", { op, message }]` 回复请求方（见 §9）。

### 3.3 `uploadFile` — 文件上传

```json
["uploadFile", { "uploadAvatar": [playerId, dataUrl] }, feedback]
```

服务器解码 base64 图片，存为 `{playerId}.{ext}`，回复
`["avatarReceived", "{playerId}.{ext}"]`。
注意：3.3.1 前端实际走 HTTP `POST /upload/avatar`（见 §5），此通道仅为协议完整保留。
相同 `feedback` 的重复上传会被去重 *(实现决策)*。

### 3.4 `ping` — 心跳

```json
["ping", [playerIdOrCount, "latency"]]
```

- 玩家发送自己的 `playerId`；host 发送当前玩家数。
- 服务器将 `"latency"` 占位符**替换为发送方连接的实测延迟**（通过 WebSocket
  协议层 ping/pong 测量）后转发：玩家的 ping 只发给 host；host 的 ping 发给所有玩家。
- 服务器同时向发送方回 `["pong"]` *(实现决策)*。

### 3.5 其他顶层命令 — 广播

除以上四类外，任何顶层命令都广播给房间内**除发送方外**的所有成员，原样转发
`[command, params, feedback]`。例如：`gs`、`edition`、`player`、`nomination`、
`vote`、`lock`、`marked`、`isNight`、`votingSpeed`、`fabled`、`setTalking`、
`setTimer` 等（完整目录见 §4，广播对服务器透明）。

## 4. 下行消息（服务器 → 客户端）

| command | 来源 | 说明 |
|---|---|---|
| `allowHost` / `allowJoin` | 服务器 | 准入结果（见 §3.2） |
| `alertPopup` | 服务器 | 弹窗提示文本（如房间关闭通知） |
| `pong` | 服务器 | ping 应答 |
| `feedback` | 服务器 | 可靠投递确认，转发给原发送方 |
| `avatarReceived` | 服务器 | 头像上传成功，params 为文件名 |
| `setRooms` / `addRoom` / `removeRoom` | 服务器（大厅） | 房间列表全量/增量推送 |
| `kookBound` / `kookBindings` / `kookVoice` / `kookBoundUser` / `kookError` | 服务器 | KOOK 语音集成（见 §9） |
| 其余全部 | 中继 | `gs`、`edition`、`states`、`teamsNames`、`firstNight`、`otherNight`、`fabled`、`syncPlayersStatus`、`stId`、`player`、`bluff`、`grimoire`、`claim`、`leaveSeat`、`ping`、`nomination`、`swap`、`move`、`remove`、`marked`、`isNight`、`isVoteHistoryAllowed`、`votingSpeed`、`clearVoteHistory`、`isVoteInProgress`、`vote`、`lock`、`bye`、`pronouns`、`isRole`、`usingRole`、`chat`、`addGroupChat`、`removeGroupChat`、`removeGroupChatMember`、`setTimer`、`startTimer`、`stopTimer`、`secretVote`、`bootlegger`、`useOldOrder`、`useOldRole`、`isReview`、`setTalking`、`getGamestate`、`getStId` |

中继消息的语义由客户端定义，服务器不解释 payload。

## 5. HTTP API

所有响应带 `Access-Control-Allow-Origin: *`，前端可部署在任意源。

### `POST /upload/avatar`

请求：`{ "playerId": "...", "uploadContent": "data:image/webp;base64,..." }`
（ImageCropper.vue 限制 base64 长度 ≤ 1MiB × 4/3）

成功：`200 { "status": "success", "avatarUrl": "{playerId}.{ext}" }`
失败：`4xx { "status": "error", "message": "..." }`

支持 png/webp/jpeg/gif；`playerId` 仅允许 `[A-Za-z0-9_-]{1,64}`。

### `GET /avatars/{filename}`

返回头像图片，`Cache-Control: public, max-age=31536000, immutable`。

### `GET /dynamic/init`

```json
{ "payload": { "version": "3.3.1", "floatingNotice": "" } }
```

前端用它对比本地版本号，不一致时弹更新提示（不强制）。`version` 可用
环境变量 `APP_VERSION` 配置。

### `GET /healthz`

`{ "status": "ok" }`

## 6. 房间生命周期

1. **创建**：首个 host 连接且 `checkAllowHost` 通过；`stSecret` 此时绑定房间。
2. **大厅广播**：host 就位 → `addRoom`；host 断开 → `removeRoom`（即使房间仍在宽限期）。
3. **host 断开**：进入宽限期（默认 90 秒，`HOST_GRACE_MS`）。宽限期内：
   - 相同 `stSecret` 的 host 连接可夺回房间（顶替失效连接）；
   - 玩家重连不受影响（前端 `isJoinAllowed === true` 时跳过重新检查）。
4. **关闭**：宽限期结束 host 未归 → 向剩余玩家发 `alertPopup` 后以 1000 关闭
   其连接，销毁房间；或所有成员离开后自动销毁 *(均为实现决策)*。
5. **玩家断开**：服务器向 host 转发 `["bye", playerId]`。

## 7. 可靠投递（feedback 机制）

1. 发送方把带 `feedback` ID 的消息放入重发队列，每 1.5 秒重发直到收到确认。
2. 服务器记录 `{target}:{feedbackId} → {from, message}`（容量 1000，先进先出淘汰）。
3. 接收方收到后发送 `request/deleteMessage [queueType, feedbackId]`；
   服务器查表，向原发送方转发 `["feedback", feedbackId]` 并删除记录。
4. 接收方用 `messageUniqueQueue` 对重复投递去重。
5. 目标离线时的消息由服务器暂存，重连后补投 *(实现决策)*。

## 8. 安全与限制

- `stSecret` 是房间主持权的唯一凭证，请只在 HTTPS/WSS 下传输。
- WebSocket 单消息上限默认 8 MiB（`WS_MAX_PAYLOAD`）。
- 头像上传大小与格式受 §5 限制；HTTP body 超限返回 413。
- 游戏逻辑（角色、投票合法性等）完全由客户端执行，服务器**不做**游戏规则校验。
  恶意客户端可以伪造消息——与官方后端一致，信任模型不变。

## 9. KOOK 语音集成

可选功能，需配置环境变量 `KOOK_BOT_TOKEN`（未配置时所有 `kook*` 请求回
`kookError`，其余行为不变）。**token 只存在于服务器进程内，绝不下发前端。**

### 9.1 模型

- 房间通过 `request/kookBind { guildId }`（仅 host）绑定到一个 KOOK 服务器；
  机器人必须是该服务器成员且具备语音管理权限。
- 绑定关系存于房间：`room.kookGuildId`、`room.kookBindings`（`playerId -> kookUserId`）、
  `room.kookCategoryId`（可选的分组限定），房间销毁时随之清理。
- 设置分组后，推送的 `kookVoice` 快照只包含该分组下的语音频道
  （所有分组本身始终保留，供前端切换），移动/集合指令也被约束在该分组内。
- 语音状态（频道树、频道内成员、闭麦列表）由**服务器持有**（本后端唯一的
  有状态模块）：REST 全量初始化 + Gateway 事件增量维护 + 每 60s 全量对账。
  实现见 `src/kook/`（`kookApi` REST 封装 / `kookGateway` 长连接 /
  `kookVoice` 状态缓存 / `kookService` 门面）。

### 9.2 下行消息

| command | params | 时机 |
|---|---|---|
| `kookBound` | `{ guildId, guildName, guildIcon, categoryId }` 或 `null` | 绑定/解绑/改分组时广播；新连接加入已绑定房间时单独补发 |
| `kookBindings` | `{ playerId: kookUserId, ... }` | 绑定/解绑用户、玩家真正离开时广播 |
| `kookVoice` | 语音状态快照 `{ guildId, name, ready, channels, users, occupancy, muted, deafened }` | 状态变化时全房间广播（全量快照，无量级问题） |
| `kookBoundUser` | `{ id, username, nickname, avatar, identify_num }` | 本人 `kookBindUser` 成功后回执；重连时若绑定仍在会补发 |
| `kookError` | `{ op, message }` | 任一 `kook*` 指令失败时回复请求方 |

### 9.3 约束（继承自 KOOK 平台）

- 只能移动**已经在语音频道中**的用户（`channel/move-user` 平台限制）；
- 闭麦是**服务器级**（`guild-mute`），同一 KOOK 服务器上同时开多个房间会互相干扰，
  请为一个房间使用一个独立的 KOOK 服务器；
- 机器人主动发消息有每日配额（10000 条/开发者），本集成不发送任何聊天消息，
  不受影响；
- KOOK REST 有按路由的频率限制，客户端已内置 429 退避重试。
