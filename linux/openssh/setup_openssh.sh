#!/usr/bin/env bash
# OpenSSH Server 部署 (Linux)
# - 已安装 sshd 时跳过安装，否则用系统包管理器安装 (apt / dnf / yum / pacman)
# - 启动方式：systemd 用 systemctl，无 systemd（如旧版 WSL）回退 service
# - 配置/启动前检测目标端口占用：被非 sshd 进程占用则报错退出；
#   被本机已运行的 sshd 占用视为幂等（沿用现有实例）
# - 默认端口 22，不做防火墙配置（桌面发行版/WSL 默认无入站限制）
# 用法:
#   setup_openssh.sh              # 默认端口 22
#   setup_openssh.sh --port 2222  # 指定端口
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENVTOOLS_VERSION="$(cat "$DIR/../../VERSION" 2>/dev/null || true)"
if [ -n "$ENVTOOLS_VERSION" ]; then
    printf 'Env-Tools v%s\n' "$ENVTOOLS_VERSION"
fi

LOG_DIR="$DIR/log"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/setup.log"

log() {
    local line="$(date '+%Y-%m-%d %H:%M:%S')  $1"
    echo "$line" | tee -a "$LOG"
}

die() {
    log "ERROR: $1"
    log '=== openssh setup aborted ==='
    exit 1
}

PORT=22
while (($# > 0)); do
    case "$1" in
        --port)
            (($# >= 2)) || die '--port 需要端口号参数'
            PORT="$2"
            shift 2
            ;;
        --port=*)
            PORT="${1#--port=}"
            shift
            ;;
        *)
            die "未知参数: $1（可选: --port N）"
            ;;
    esac
done
[[ "$PORT" =~ ^[0-9]+$ ]] && ((PORT >= 1 && PORT <= 65535)) \
    || die "无效端口: $PORT（应为 1-65535）"

log '=== openssh setup start ==='
log "目标端口: $PORT"

# --- 检测/安装 sshd -------------------------------------------------------------
find_sshd() {
    command -v sshd 2>/dev/null && return 0
    for p in /usr/sbin/sshd /sbin/sshd; do
        [ -x "$p" ] && { echo "$p"; return 0; }
    done
    return 1
}

install_openssh() {
    if command -v apt-get >/dev/null 2>&1; then
        log '使用 apt-get 安装 openssh-server ...'
        sudo apt-get update -y && sudo apt-get install -y openssh-server
    elif command -v dnf >/dev/null 2>&1; then
        log '使用 dnf 安装 openssh-server ...'
        sudo dnf install -y openssh-server
    elif command -v yum >/dev/null 2>&1; then
        log '使用 yum 安装 openssh-server ...'
        sudo yum install -y openssh-server
    elif command -v pacman >/dev/null 2>&1; then
        log '使用 pacman 安装 openssh ...'
        sudo pacman -S --noconfirm openssh
    else
        return 1
    fi
}

SSHD_BIN="$(find_sshd || true)"
if [ -z "$SSHD_BIN" ]; then
    install_openssh || die '未找到支持的包管理器 (apt/dnf/yum/pacman)，无法安装 openssh-server'
    SSHD_BIN="$(find_sshd || true)"
    [ -n "$SSHD_BIN" ] || die '安装后仍未检测到 sshd'
    log "openssh-server 安装完成 ($SSHD_BIN)"
else
    log "检测到 sshd: $SSHD_BIN，跳过安装"
fi

# --- 端口占用检测 -----------------------------------------------------------------
# 返回监听该端口的行（含进程名，需 sudo 才能看到其他用户进程）
port_listeners() {
    if command -v ss >/dev/null 2>&1; then
        sudo ss -tlnpH "sport = :$PORT" 2>/dev/null || ss -tlnH "sport = :$PORT" 2>/dev/null
    elif command -v netstat >/dev/null 2>&1; then
        sudo netstat -tlnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$"' \
            || netstat -tln 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$"'
    fi
}

LISTENERS="$(port_listeners || true)"
if [ -n "$LISTENERS" ]; then
    if grep -qi 'sshd' <<<"$LISTENERS"; then
        log "端口 $PORT 已由本机 sshd 监听，沿用现有实例（幂等）"
        echo "$LISTENERS" | while IFS= read -r l; do log "  $l"; done
        log '=== openssh setup done ==='
        exit 0
    fi
    log "端口 $PORT 被非 sshd 进程占用："
    echo "$LISTENERS" | while IFS= read -r l; do log "  $l"; done
    die "端口 $PORT 被占用（可能是 WSL 其他发行版、Docker 或本机其他服务）。请释放该端口或用 --port 指定其他端口。"
fi

# --- 端口配置（非默认 22 时改写 sshd_config，改前备份）-------------------------------
SSHD_CONFIG=/etc/ssh/sshd_config
CONFIG_CHANGED=false
if ((PORT != 22)); then
    [ -f "$SSHD_CONFIG" ] || die "找不到 $SSHD_CONFIG"
    BACKUP="$SSHD_CONFIG.backup-$(date '+%Y%m%d-%H%M%S')"
    sudo cp "$SSHD_CONFIG" "$BACKUP"
    log "已备份 sshd_config 到 $BACKUP"
    if sudo grep -qE '^\s*#?\s*Port\s+[0-9]+\s*$' "$SSHD_CONFIG"; then
        sudo sed -i -E "0,/^\s*#?\s*Port\s+[0-9]+\s*$/s//Port $PORT/" "$SSHD_CONFIG"
    else
        echo "Port $PORT" | sudo tee -a "$SSHD_CONFIG" >/dev/null
    fi
    log "已将 sshd 端口配置为 $PORT"
    CONFIG_CHANGED=true
fi

# --- 启动服务 -----------------------------------------------------------------------
# Debian/Ubuntu 服务名为 ssh，Fedora/Arch 为 sshd
SVC=sshd
[ -f /etc/debian_version ] && SVC=ssh

IS_SYSTEMD=false
[ "$(ps -p 1 -o comm= 2>/dev/null)" = 'systemd' ] && IS_SYSTEMD=true

is_running() {
    if $IS_SYSTEMD; then
        systemctl is-active --quiet "$SVC"
    else
        sudo service "$SVC" status >/dev/null 2>&1
    fi
}

if $IS_SYSTEMD; then
    log '使用 systemctl 启用并启动 sshd'
    sudo systemctl enable "$SVC" >/dev/null 2>&1 || true
    if is_running && $CONFIG_CHANGED; then
        sudo systemctl restart "$SVC"
    elif ! is_running; then
        sudo systemctl start "$SVC"
    fi
else
    log '未检测到 systemd（WSL?），使用 service 启动 sshd'
    if is_running && $CONFIG_CHANGED; then
        sudo service "$SVC" restart
    elif ! is_running; then
        sudo service "$SVC" start
    fi
fi

# --- 验证监听 -----------------------------------------------------------------------
sleep 1
LISTENERS="$(port_listeners || true)"
if [ -z "$LISTENERS" ] && command -v ss >/dev/null 2>&1; then
    # 无 sudo 权限时 ss -p 可能拿不到进程名，再试一次不带 -p 的
    LISTENERS="$(ss -tlnH "sport = :$PORT" 2>/dev/null || true)"
fi
[ -n "$LISTENERS" ] || die "sshd 已启动但未监听端口 $PORT，请检查日志: sudo journalctl -u $SVC 或 /var/log/auth.log"

log "sshd 正在监听端口 $PORT"
log "本机测试: ssh -p $PORT ${USER}@localhost"
log '=== openssh setup done ==='
