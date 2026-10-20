@echo off
rem ============================================================
rem  install.cmd — relic 快速入口（Windows）
rem ============================================================
rem  已有 clone 的用户双击此脚本启动向导（跳过环境安装引导）。
rem  全新部署请用 relic-setup.cmd。
rem ============================================================
title relic 安装向导

cd /d "%~dp0"

rem 检查 node
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ✗ Node.js 未安装。请先安装 Node.js 或使用 relic-setup.cmd
    pause
    exit /b 1
)

rem 安装依赖（如需要）
if not exist node_modules (
    echo   安装依赖...
    call npm install --silent
)

rem 启动向导
echo   启动向导...
node scripts/wizard.mjs
pause
