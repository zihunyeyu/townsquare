@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title townsquare 本地开发启动器

REM ---- 前置检查:Node 必须在 PATH 中 ----
where node >nul 2>nul || (echo [错误] 未找到 node,请先安装 Node.js 并加入 PATH。& pause & exit /b 1)
where npm >nul 2>nul || (echo [错误] 未找到 npm,请先安装 Node.js 并加入 PATH。& pause & exit /b 1)

REM ---- 1. 安装依赖(仅在缺失时) ----
if not exist "node_modules" (
  echo [1/3] 首次运行,安装前端依赖^(需要几分钟^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo 依赖安装失败,请检查网络后重试。
    pause
    exit /b 1
  )
)
if not exist "server\node_modules" (
  echo [1/3] 安装后端依赖...
  pushd server
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    popd
    echo 后端依赖安装失败,请检查网络后重试。
    pause
    exit /b 1
  )
  popd
)

REM ---- 2. 生成 .env.local(仅在缺失时) ----
if not exist ".env.local" (
  echo [2/3] 生成 .env.local^(前端指向本地后端^)...
  (
    echo VUE_APP_WS_URL=ws://\$HOST:8081/
    echo VUE_APP_LOBBY_URL=ws://\$HOST:8082/
    echo VUE_APP_API_URL=http://\$HOST:8083
    echo VUE_APP_AVATAR_URL=http://\$HOST:8083/avatars/
  )> .env.local
)

REM ---- 3. 启动后端与前端(各自独立窗口) ----
REM KOOK token(可选):从 server\kook-token.txt 读取(该文件已被 gitignore)
if exist "server\kook-token.txt" (
  set /p KOOK_BOT_TOKEN=<"server\kook-token.txt"
  echo 已加载 KOOK_BOT_TOKEN
)
echo [3/3] 启动服务...
start "townsquare-backend 8081-8083" /d "%~dp0server" cmd /k npm start
timeout /t 2 /nobreak >nul
start "townsquare-frontend 8080" /d "%~dp0" cmd /k "npx vue-cli-service serve"

echo.
echo 后端: ws://localhost:8081 (游戏) / 8082 (大厅) / http://localhost:8083 (API)
echo 前端首次编译约需 30-60 秒,完成后访问: http://localhost:8080
echo 浏览器将在编译期间自动打开,若提示无法连接请稍后刷新。
echo 关闭对应窗口即可停止服务。
timeout /t 25 /nobreak >nul
start "" "http://localhost:8080"
exit /b 0
