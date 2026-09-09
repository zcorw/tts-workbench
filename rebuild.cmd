@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\rebuild-local.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" pause
exit /b %result%
