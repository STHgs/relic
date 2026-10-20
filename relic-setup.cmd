@echo off
title relic SETUP
setlocal
set "PS1=%~dp0relic-setup.ps1"
if exist "%PS1%" goto :run
set "PS1=%~dp0scripts\setup.ps1"
:run
if not exist "%PS1%" goto :missing
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
if errorlevel 1 pause
exit /b 0
:missing
echo [ERROR] relic-setup.ps1 not found next to this script.
pause
exit /b 1
