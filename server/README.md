# townsquare-server

与钟楼谜团魔典前端（本仓库 `src/store/socket.js`）协议兼容的自建后端。
协议细节见 [PROTOCOL.md](PROTOCOL.md)。

## 组成

| 服务 | 默认端口 | 环境变量 |
|---|---|---|
| 游戏 WebSocket | 8081 | `GAME_PORT` |
| 大厅 WebSocket | 8082 | `LOBBY_PORT` |
| HTTP API（头像/版本） | 8083 | `API_PORT` |

## 运行

```bash
npm install
npm start
```

要求 Node.js ≥ 18（开发使用的是 Node 24）。

## 测试

```bash
npm test
```

13 个集成测试覆盖：建房/加入准入、`stSecret` 鉴权、direct 单播与多目标拆分、
广播、feedback 可靠投递、ping 延迟中继、断线 bye、host 宽限期夺回、
大厅房间列表、头像上传与读取、非法连接处理。

## 接入前端

前端的所有服务端地址都可通过环境变量覆盖（默认值仍为官方服务器）。
在项目根目录创建 `.env.local`：

```
VUE_APP_WS_URL=ws://localhost:8081/
VUE_APP_LOBBY_URL=ws://localhost:8082/
VUE_APP_API_URL=http://localhost:8083
VUE_APP_AVATAR_URL=http://localhost:8083/avatars/
```

然后正常 `npm run serve` 启动前端即可。

**注意混合内容**：如果前端页面以 HTTPS 提供，浏览器会拦截 `ws://` 连接。
本地开发请使用 HTTP 前端（`npx vue-cli-service serve`，不带 `--https`）；
生产部署请在反向代理（Nginx 等）后开启 WSS/HTTPS。

## 配置项

见 [src/config.js](src/config.js)。常用：

- `HOST_GRACE_MS`（默认 90000）：说书人断线后房间的保留时间
- `WS_MAX_PAYLOAD`（默认 8MiB）：单条 WebSocket 消息上限
- `APP_VERSION`（默认 3.3.2）：`/dynamic/init` 报告的版本号
- `FLOATING_NOTICE`：全局浮动公告文本
- `AVATAR_DIR`：头像存储目录（默认 `server/avatars/`）
- `KOOK_BOT_TOKEN`：KOOK 机器人 token（语音频道集成，可选）。也可写入
  `server/kook-token.txt`（已 gitignore）——Git Bash/MSYS 会把含 `/` 的
  环境变量值改写成 Windows 路径，本地开发建议用文件方式。

## 生产部署要点

- 用 Nginx 等反向代理统一暴露 443：`/ws/` → 8081、`/lobby/` → 8082、
  `/api/` 与 `/avatars/` → 8083，并开启 TLS（WSS）。
- Nginx 代理 WebSocket 需要 `Upgrade`/`Connection` 头与较长的
  `proxy_read_timeout`（客户端每 3 秒有应用层 ping，60s 以上即可）。
- 前端构建时把上述 `VUE_APP_*` 指向你的域名（如
  `VUE_APP_WS_URL=wss://your-domain/ws/`）。
