#!/bin/bash
# 本地（WSLg）开发启动：关闭 core dump（WSL 崩溃转储会把 Windows Temp 撑到
# 数百 GB），再启动 Electron 应用。用法：scripts/dev-wslg.sh [extra electron args]
ulimit -c 0
cd "$(dirname "$0")/.."
exec ./node_modules/.bin/electron "$@" .
