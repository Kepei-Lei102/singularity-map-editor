@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
node -e "process.exit(parseInt(process.versions.node)>=22?0:1)" >nul 2>nul
if errorlevel 1 goto bootstrap
call npm.cmd --version >nul 2>nul
if errorlevel 1 goto bootstrap
node "%~dp0scripts\launch.mjs" %*
goto finished
:bootstrap
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo 需要 Windows PowerShell 5.1，Windows 10/11 自带。
  pause
  exit /b 1
)
if not "%~2"=="" (
  echo 一次只能打开一个工程，请用双引号括住路径。
  pause
  exit /b 1
)
powershell.exe -NoProfile -File "%~dp0scripts\bootstrap-windows.ps1" %*
:finished
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
