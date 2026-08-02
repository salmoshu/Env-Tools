#!/usr/bin/env bash
# Machine-Setup 总入口 (Linux / Unix shell)
# 自动检测操作系统并完成部署；Windows 实现 kdesk + nodejs + ai-tools，Linux 实现 nodejs + ai-tools。
# 用法: ./setup.sh [组件...] [--工具参数...]
#   ./setup.sh                  # 部署全部组件
#   ./setup.sh nodejs           # 仅部署 nodejs
#   ./setup.sh ai-tools         # 安装/更新全部 AI CLI 工具
#   ./setup.sh ai-tools --codex # 仅安装/更新 codex（--all/--kimi/--codebuddy 同理）
# 在 Windows 的 Git Bash 下运行时参数原样透传给 setup.ps1。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        # 在 Windows 的 Git Bash / MSYS 下运行，转交给 PowerShell 入口
        exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ROOT/setup.ps1" "$@"
        ;;
    Linux)
        # 组件与 -- 开头的工具参数分开收集；工具参数仅透传给 ai-tools
        components=() tool_args=()
        for a in "$@"; do
            case "$a" in
                -*) tool_args+=("$a") ;;
                *)  components+=("$a") ;;
            esac
        done
        ((${#components[@]} == 0)) && components=(all)

        deploy_nodejs() {
            echo '=== 部署 nodejs ==='
            bash "$ROOT/linux/nodejs/setup_nodejs.sh"
        }
        deploy_ai_tools() {
            echo '=== 部署 ai-tools ==='
            bash "$ROOT/linux/ai-tools/setup_ai_tools.sh" ${tool_args[@]+"${tool_args[@]}"}
        }

        for name in "${components[@]}"; do
            case "$name" in
                all)
                    deploy_nodejs
                    deploy_ai_tools
                    ;;
                nodejs)
                    deploy_nodejs
                    ;;
                ai-tools)
                    deploy_ai_tools
                    ;;
                kdesk)
                    echo 'kdesk 仅支持 Windows，Linux 下跳过。'
                    ;;
                *)
                    echo "无效组件: $name（可选: all / nodejs / ai-tools）"
                    exit 1
                    ;;
            esac
        done
        echo '=== 部署完成 ==='
        ;;
    *)
        echo "未识别的操作系统: $(uname -s)"
        exit 1
        ;;
esac
