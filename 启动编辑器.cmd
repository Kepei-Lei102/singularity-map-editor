@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js LTS：https://nodejs.org/ （需要22或更新版本）
  echo 安装后重新打开此脚本。
  pause
  exit /b 1
)
node "%~dp0scripts\launch.mjs" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
