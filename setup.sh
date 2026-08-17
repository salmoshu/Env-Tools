#!/usr/bin/env bash
# Env-Tools 总入口 (Linux / Unix shell)
# 自动检测操作系统并完成部署；Windows 实现 kdesk + nodejs + ai-tools + openssh，Linux 实现 nodejs + ai-tools + openssh。
# 用法: ./setup.sh [组件...] [--工具参数...]
#   ./setup.sh                  # 部署全部组件
#   ./setup.sh nodejs           # 仅部署 nodejs
#   ./setup.sh ai-tools         # 安装/更新全部 AI CLI 工具
#   ./setup.sh ai-tools --codex # 仅安装/更新 codex（--all/--kimi/--codebuddy 同理）
#   ./setup.sh openssh          # 部署 OpenSSH Server（默认端口 22）
#   ./setup.sh openssh --port 2222  # 指定 SSH 端口
#   注：带工具参数时请只指定一个组件（参数会透传给该组件的脚本）
# 在 Windows 的 Git Bash 下运行时参数原样透传给 setup.ps1。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        # 在 Windows 的 Git Bash / MSYS 下运行，转交给 PowerShell 入口
        exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$ROOT/setup.ps1" "$@"
        ;;
    Linux)
        # 组件与 - 开头的工具参数分开收集；工具参数透传给 ai-tools / openssh
        # (--port 需要连后面的端口号一起收进工具参数，否则端口号会被误判为组件名)
        components=() tool_args=()
        while (($# > 0)); do
            case "$1" in
                --port)
                    (($# >= 2)) || { echo 'ERROR: --port 需要端口号参数'; exit 1; }
                    tool_args+=("$1" "$2")
                    shift 2
                    ;;
                -*)
                    tool_args+=("$1")
                    shift
                    ;;
                *)
                    components+=("$1")
                    shift
                    ;;
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
        deploy_openssh() {
            echo '=== 部署 openssh ==='
            bash "$ROOT/linux/openssh/setup_openssh.sh" ${tool_args[@]+"${tool_args[@]}"}
        }

        for name in "${components[@]}"; do
            case "$name" in
                all)
                    deploy_nodejs
                    deploy_ai_tools
                    deploy_openssh
                    ;;
                nodejs)
                    deploy_nodejs
                    ;;
                ai-tools)
                    deploy_ai_tools
                    ;;
                openssh)
                    deploy_openssh
                    ;;
                kdesk)
                    echo 'kdesk 仅支持 Windows，Linux 下跳过。'
                    ;;
                *)
                    echo "无效组件: $name（可选: all / nodejs / ai-tools / openssh）"
                    exit 1
                    ;;
            esac
        done
        # 把 Tab 补全写入 ~/.bashrc（幂等），新开的 bash 会话即可用
        completion_marker='# Env-Tools completion'
        if ! grep -qF "$completion_marker" "$HOME/.bashrc" 2>/dev/null; then
            printf '\n%s\nsource "%s"\n' "$completion_marker" "$ROOT/completion/env-tools.bash" >> "$HOME/.bashrc"
            echo "已把 Tab 补全写入 $HOME/.bashrc（新开终端生效）"
        fi
        echo '=== 部署完成 ==='
        ;;
    *)
        echo "未识别的操作系统: $(uname -s)"
        exit 1
        ;;
esac
