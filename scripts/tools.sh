#!/usr/bin/env bash
# 已部署应用的统一操作入口。
#
# 用法：
#   ./tools.sh openssh --status
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"  # 仓库根（脚本已收纳进 scripts/）

# 在 Windows 的 Git Bash / MSYS 下运行时，转交给 PowerShell 入口
case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
        exec powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$SCRIPT_DIR/tools.ps1" "$@"
        ;;
esac

ENVTOOLS_VERSION="$(cat "$ROOT/VERSION" 2>/dev/null || true)"
if [ -n "$ENVTOOLS_VERSION" ]; then
    printf 'Env-Tools v%s\n' "$ENVTOOLS_VERSION"
fi

usage() {
    cat <<'EOF'
用法: ./tools.sh <应用> <操作> [参数...]

应用与操作:
  openssh --status            查看 sshd 服务状态与监听端口

示例:
  ./tools.sh openssh --status

EOF
}

die() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

run_openssh() {
    local operation="${1:-}"
    (($# > 0)) && shift

    case "$operation" in
        --status)
            local sshd_bin
            sshd_bin="$(command -v sshd 2>/dev/null || true)"
            if [ -z "$sshd_bin" ]; then
                for p in /usr/sbin/sshd /sbin/sshd; do
                    [ -x "$p" ] && sshd_bin="$p"
                done
            fi
            if [ -z "$sshd_bin" ]; then
                echo 'sshd: 未安装（可用 ./scripts/setup.sh openssh 部署）'
                exit 1
            fi
            echo "sshd: $sshd_bin ($("$sshd_bin" -V 2>&1 | head -1 || echo '版本未知'))"

            local svc=sshd
            [ -f /etc/debian_version ] && svc=ssh
            if [ "$(ps -p 1 -o comm= 2>/dev/null)" = 'systemd' ]; then
                echo "服务: $(systemctl is-enabled "$svc" 2>/dev/null || echo unknown) / $(systemctl is-active "$svc" 2>/dev/null || echo unknown)"
            else
                if sudo -n service "$svc" status >/dev/null 2>&1 || service "$svc" status >/dev/null 2>&1; then
                    echo '服务: running'
                else
                    echo '服务: stopped 或状态未知（无 systemd，service 查询可能需要 sudo）'
                fi
            fi

            echo '监听端口:'
            local listeners=''
            if command -v ss >/dev/null 2>&1; then
                listeners="$(sudo -n ss -tlnpH 2>/dev/null | grep -i sshd || ss -tlnH 2>/dev/null | grep -i sshd || true)"
            elif command -v netstat >/dev/null 2>&1; then
                listeners="$(sudo -n netstat -tlnp 2>/dev/null | grep -i sshd || netstat -tln 2>/dev/null | grep -i sshd || true)"
            fi
            if [ -n "$listeners" ]; then
                echo "$listeners" | sed 's/^/  /'
                local ports
                ports="$(echo "$listeners" | awk '{print $4}' | grep -oE '[0-9]+$' | sort -un | tr '\n' ' ')"
                echo "连接示例: ssh -p ${ports%% *} $USER@<本机IP>"
            else
                echo '  （未检测到 sshd 监听端口；无 sudo 时进程信息可能不可见）'
            fi
            ;;
        --help|-h|help|'')
            usage
            ;;
        *)
            die "openssh 不支持操作 '$operation'（当前支持: --status）"
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
    openssh)
        run_openssh "$@"
        ;;
    --help|-h|help)
        usage
        ;;
    *)
        die "未知应用 '$application'（当前支持: openssh）"
        ;;
esac
