#!/bin/sh
# ============================================================
#  install.sh — relic 快速入口（macOS / Linux / WSL）
# ============================================================
#  已有 clone 的用户直接跑此脚本启动向导（跳过环境安装引导）。
#  全新部署请用 relic-setup.cmd（win）或手动 clone + 本脚本。
# ============================================================

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"

echo "◇ relic 安装向导"
echo ""

# 检查 node
if ! command -v node >/dev/null 2>&1; then
    echo "✗ Node.js 未安装。请先安装 Node.js ≥ 20："
    echo "  https://nodejs.org"
    exit 1
fi

# 检查版本
NODE_MAJOR=$(node -v | cut -d. -f1 | sed 's/v//')
if [ "$NODE_MAJOR" -lt 20 ]; then
    echo "✗ Node.js 版本过低（需要 ≥ 20，当前 $(node -v)）"
    exit 1
fi

# 安装依赖（如需要）
if [ ! -d "$DIR/node_modules" ]; then
    echo "  安装依赖..."
    (cd "$DIR" && npm install --silent)
fi

# 启动向导
echo "  启动向导..."
cd "$DIR" && node scripts/wizard.mjs
