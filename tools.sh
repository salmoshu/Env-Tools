#!/usr/bin/env bash
# 已部署应用的统一操作入口。
#
# 用法：
#   ./tools.sh ai-tools --usage [usage 参数...]
#
# usage monitor 随本项目分发，不依赖外部 AI-Tools 项目。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<'EOF'
用法: ./tools.sh <应用> <操作> [参数...]

应用与操作:
  ai-tools --usage [参数...]  查看 Kimi / Codex / CodeBuddy 余量

示例:
  ./tools.sh ai-tools --usage
  ./tools.sh ai-tools --usage --provider codex
  ./tools.sh ai-tools --usage --json

EOF
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

run_ai_tools() {
    local operation="${1:-}"
    (($# > 0)) && shift

    case "$operation" in
        --usage)
            local monitor="$ROOT/linux/ai-tools/usage-monitor/usage_monitor.py"
            command -v python3 >/dev/null 2>&1 \
                || die '未找到 python3，无法运行余量监控。'
            [ -f "$monitor" ] \
                || die "余量监控程序不存在: $monitor"
            # 与原 AI-Tools 入口保持一致：无额外参数时默认持续监控。
            if (($# == 0)); then
                set -- --watch
            fi
            exec python3 "$monitor" "$@"
            ;;
        --help|-h|help|'')
            usage
            ;;
        *)
            die "ai-tools 不支持操作 '$operation'（当前支持: --usage）"
            ;;
    esac
}

if (($# == 0)); then
    usage
    exit 0
fi

application="$1"
shift
case "$application" in
    ai-tools)
        run_ai_tools "$@"
        ;;
    --help|-h|help)
        usage
        ;;
    *)
        die "未知应用 '$application'（当前支持: ai-tools）"
        ;;
esac
