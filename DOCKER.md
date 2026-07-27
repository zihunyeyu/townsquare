# Docker 部署指南

提供两种部署形态，按需选择：

- **一体化单镜像**（推荐）：前端 + 后端 + 静态托管在一个容器里，单端口对外。
- **多容器**：前端 Nginx 容器 + 后端容器（见下文「多容器部署」）。

## 一体化单镜像（推荐）

```bash
# 编辑 docker-compose.standalone.yml 中的 DOMAIN / SCHEME 后：
docker compose -f docker-compose.standalone.yml up -d --build
```

默认暴露宿主机 **8080 端口**（`HTTP_PORT=80 docker compose -f ... up -d` 可改）。
容器内一个 Node 进程同时提供：前端静态页面（含 SPA 兜底）、游戏 WS
（`/ws/`）、大厅 WS（`/lobby/`）、HTTP API（`/avatars/`、`/dynamic/init`、
`/upload/avatar`）。头像持久化在 `avatars` 数据卷。

### 修改代码后重新发布

前后端任何改动后，重新执行同一条命令即可：

```bash
docker compose -f docker-compose.standalone.yml up -d --build
```

Docker 层缓存会自动跳过未变化的部分（`npm ci` 等），只重建受影响的层；
改动越靠后（源码层），重建越快。

说明：compose 服务同时声明了 `image: townsquare-app` 和 `build:`，
因此**不带 `--build` 的 `up -d` 在本地已有镜像时直接运行、不联网校验**；
镜像不存在时才自动构建。离线环境反复启停用 `up -d` 即可。

## 多容器部署

```bash
# 编辑 docker-compose.yml 中 frontend 的环境变量：
#   DOMAIN: 你的域名或服务器 IP（不带协议）
#   SCHEME: http 或 https
docker compose up -d --build
```

默认暴露宿主机 **80 端口**（改 `HTTP_PORT` 环境变量可换端口，如
`HTTP_PORT=8080 docker compose up -d`）。

访问 `http://<DOMAIN>/` 即可。说书人创建房间、玩家加入、投票、私聊、
头像上传等全部走自建后端，不依赖官方服务器。

## 工作原理

- `Dockerfile`（根目录）：多阶段构建——Node 编译前端 → Nginx 托管 `dist/`
  并反向代理 `/ws/`（→ 后端 8081）、`/lobby/`（→ 8082）、`/avatars/`、
  `/dynamic/init`、`/upload/avatar`（→ 8083）。
- `Dockerfile.standalone`（根目录）：同样的前端构建，但运行时是
  `server/src/standalone.js` 单进程单端口（8080），不需要 Nginx。
- `server/Dockerfile`：多容器模式的后端镜像（端口 8081/8082/8083，
  容器内互联，无需暴露到宿主机）。
- 前端的服务端地址**不在构建期写死**：容器启动时按 `DOMAIN`/`SCHEME`
  生成 `/env.js`，前端运行时读取（`src/config.js` 优先使用
  `window.__ENV`）。同一镜像换个域名可直接复用。

## 环境变量

前端容器（`frontend`）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DOMAIN` | `localhost` | 对外域名/IP，非标准端口时可带端口（如 `example.com:8080`） |
| `SCHEME` | `http` | `https` 时前端自动使用 `wss://` |
| `WS_URL` / `LOBBY_URL` / `API_URL` / `AVATAR_URL` | 按 DOMAIN/SCHEME 推导 | 需要自定义路径时单独覆盖 |

后端容器（`backend`）：见 `server/src/config.js`
（`APP_VERSION`、`HOST_GRACE_MS`、`WS_MAX_PAYLOAD` 等）。

## 启用 HTTPS（生产必需）

WSS 要求页面与 WebSocket 同为 TLS。两种方式任选：

1. **外层 TLS 代理**（推荐）：在本 compose 前再放一层终止 TLS 的代理
   （Nginx / Caddy / Traefik / 云负载均衡），`SCHEME` 设为 `https`，
   `DOMAIN` 填对外域名。
2. **本栈内终止**：把证书挂载进 frontend 容器，参考 `docker/nginx.conf`
   末尾注释掉的 443 server 块自行启用。

## 验证部署

```bash
curl http://<DOMAIN>/healthz         # 未提供；用下行代替
curl http://<DOMAIN>/dynamic/init    # {"payload":{"version":"3.3.1",...}}
curl http://<DOMAIN>/env.js          # window.__ENV 运行时配置
```

游戏频道可用任意 WebSocket 客户端连接
`ws://<DOMAIN>/ws/123/testplayer` 验证（应能收到对 `checkAllowJoin`
的 `allowJoin` 响应）。

## 注意

- 自建后端与官方后端互不连通，请确保所有玩家访问的是你的实例。
- 分发/公开部署请遵守仓库许可证条款（保留署名，见根目录 README）。
