@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo 抖音链接有效性检测 - 本地 Web UI 服务
echo 当前目录：%cd%
echo.

node -v >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 Node.js 22 或兼容版本。
  echo 下载地址：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 未检测到依赖目录 node_modules。
  echo 请在当前目录执行：cmd /c npm install
  pause
  exit /b 1
)

cmd /c npm run check
if errorlevel 1 (
  echo 依赖或源码检查失败。
  echo 如依赖缺失，请执行：cmd /c npm install
  pause
  exit /b 1
)

echo 正在启动本地 Web UI 服务：http://localhost:3000
echo CLI 仍可通过以下命令使用：cmd /c npm run start:cli 或 node src/main.js
cmd /c npm start
echo.
pause
