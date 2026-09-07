@echo off
setlocal
cd /d "%~dp0"
title townsquare 构建并推送到阿里云镜像仓库

REM 说明:本机的 Docker Desktop 代理配置会把容器内 HTTPS 全部重置,因此
REM 采用"宿主机预构建 + 容器内零联网"路线(Dockerfile.local)。
REM 前置:本机已安装 Node 与 Docker。

REM ---- 读取阿里云 ACR 配置(aliyun-acr.txt,已 gitignore/dockerignore,勿提交) ----
if not exist "aliyun-acr.txt" (
  echo [提示] 首次使用,请在项目根目录创建 aliyun-acr.txt,内容如下(^; 开头为注释^):
  echo.
  echo   REGISTRY=crpi-cp6ypbcubm5ma9ru.cn-hangzhou.personal.cr.aliyuncs.com
  echo   NAMESPACE=purplesoul
  echo   IMAGE=townsquare
  echo   USERNAME=你的阿里云账号
  echo   ; PASSWORD 为镜像仓库访问密码,可选;不填则使用本机已保存的 docker 登录态
  echo   PASSWORD=
  echo.
  pause
  exit /b 1
)
for /f "usebackq eol=; tokens=1,* delims==" %%a in ("aliyun-acr.txt") do set "%%a=%%b"

if "%REGISTRY%"=="" goto :config_error
if "%NAMESPACE%"=="" goto :config_error
if "%IMAGE%"=="" goto :config_error
if "%USERNAME%"=="" goto :config_error

REM ---- 镜像标签:命令行参数 > package.json 版本号 > latest ----
set TAG=%~1
if "%TAG%"=="" (
  for /f %%v in ('node -p "require('./package.json').version" 2^>nul') do set TAG=%%v
)
if "%TAG%"=="" set TAG=latest

set FULL_IMAGE=%REGISTRY%/%NAMESPACE%/%IMAGE%:%TAG%

echo [1/4] 宿主机安装后端依赖...
pushd server
call npm ci --omit=dev --no-audit --no-fund || (popd & goto :fail)
popd

echo [2/4] 宿主机构建前端 dist(约 1-2 分钟)...
call npx vue-cli-service build || goto :fail

echo [3/4] 组装镜像 %FULL_IMAGE% (容器内不联网)...
docker build --provenance=false -f Dockerfile.local -t %FULL_IMAGE% . || goto :fail

if not "%PASSWORD%"=="" (
  echo [4/4] 登录 %REGISTRY% 并推送...
  echo %PASSWORD%| docker login --username %USERNAME% --password-stdin %REGISTRY% || goto :fail
) else (
  echo [4/4] 使用本机已保存的 docker 登录态推送...
)
docker push %FULL_IMAGE% || goto :fail

echo.
echo 完成!服务器上运行:
echo   docker pull %FULL_IMAGE%
echo   docker run -d -p 8080:8080 -e DOMAIN=你的域名 -e SCHEME=https -e KOOK_BOT_TOKEN=xxx -v townsquare-avatars:/app/server/avatars --name townsquare --restart unless-stopped %FULL_IMAGE%
echo.
pause
exit /b 0

:config_error
echo [错误] aliyun-acr.txt 配置不完整,需要 REGISTRY/NAMESPACE/IMAGE/USERNAME
pause
exit /b 1

:fail
echo [错误] 构建或推送失败,请检查上方错误信息。
pause
exit /b 1
