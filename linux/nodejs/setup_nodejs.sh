#!/usr/bin/env bash
# Node.js 环境部署 (Linux)
# - 已安装 Node.js 时直接跳过
# - 优先使用系统包管理器安装 (apt / dnf / yum / pacman)
# - 无支持的包管理器时回退为便携版：下载官方 LTS 压缩包解压到 <project>/runtime
#   并把 PATH 导出写入 ~/.bashrc
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ENVTOOLS_VERSION="$(cat "$DIR/../../VERSION" 2>/dev/null || true)"
if [ -n "$ENVTOOLS_VERSION" ]; then
    printf 'Env-Tools v%s\n' "$ENVTOOLS_VERSION"
fi

LOG_DIR="$DIR/log"
RUNTIME_DIR="$DIR/runtime"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/setup.log"

log() {
    local line="$(date '+%Y-%m-%d %H:%M:%S')  $1"
    echo "$line" | tee -a "$LOG"
}

log '=== nodejs setup start ==='

if command -v node >/dev/null 2>&1; then
    log "node 已安装 ($(node --version))，跳过部署"
    log '=== nodejs setup done ==='
    exit 0
fi

# --- 方案一：系统包管理器 -----------------------------------------------------
install_via_pkg_mgr() {
    if command -v apt-get >/dev/null 2>&1; then
        log '使用 apt-get 安装 nodejs npm ...'
        sudo apt-get update -y && sudo apt-get install -y nodejs npm
    elif command -v dnf >/dev/null 2>&1; then
        log '使用 dnf 安装 nodejs ...'
        sudo dnf install -y nodejs
    elif command -v yum >/dev/null 2>&1; then
        log '使用 yum 安装 nodejs ...'
        sudo yum install -y nodejs
    elif command -v pacman >/dev/null 2>&1; then
        log '使用 pacman 安装 nodejs npm ...'
        sudo pacman -S --noconfirm nodejs npm
    else
        return 1
    fi
}

if install_via_pkg_mgr; then
    if command -v node >/dev/null 2>&1; then
        log "node 安装完成 ($(node --version))"
        log '=== nodejs setup done ==='
        exit 0
    fi
    log '包管理器安装后仍未检测到 node，回退到便携版部署'
else
    log '未找到支持的包管理器 (apt/dnf/yum/pacman)，使用便携版部署'
fi

# --- 方案二：官方 LTS 便携版 ---------------------------------------------------
download() {
    if command -v curl >/dev/null 2>&1; then
        curl -fSL "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$2" "$1"
    else
        log 'ERROR: 需要 curl 或 wget 来下载 node'
        return 1
    fi
}

log '查询 nodejs.org 最新 LTS 版本 ...'
INDEX_JSON="$(download https://nodejs.org/dist/index.json /dev/stdout)"
VER="$(echo "$INDEX_JSON" | grep -m1 '"lts":"' | sed -E 's/.*"version":"(v[^"]+)".*/\1/')"
if [ -z "$VER" ]; then
    log 'ERROR: 无法从 index.json 解析 LTS 版本'
    log '=== nodejs setup aborted ==='
    exit 1
fi

TARBALL="node-$VER-linux-x64.tar.xz"
URL="https://nodejs.org/dist/$VER/$TARBALL"
log "下载 $URL"
download "$URL" "$DIR/$TARBALL"

rm -rf "$RUNTIME_DIR"
log "解压到 $RUNTIME_DIR"
tar -xJf "$DIR/$TARBALL" -C "$DIR"
mv "$DIR/node-$VER-linux-x64" "$RUNTIME_DIR"
rm -f "$DIR/$TARBALL"

# 写入 ~/.bashrc（新开的终端生效）
MARKER='# env-tools nodejs'
LEGACY_MARKER='# machine-setup nodejs'
if ! grep -qF "$MARKER" "$HOME/.bashrc" 2>/dev/null \
    && ! grep -qF "$LEGACY_MARKER" "$HOME/.bashrc" 2>/dev/null; then
    {
        echo "$MARKER"
        echo "export PATH=\"$RUNTIME_DIR/bin:\$PATH\""
    } >> "$HOME/.bashrc"
    log "已将 $RUNTIME_DIR/bin 写入 ~/.bashrc（新开的终端生效）"
fi
export PATH="$RUNTIME_DIR/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
    log 'ERROR: 便携版部署后仍无法运行 node'
    log '=== nodejs setup aborted ==='
    exit 1
fi

log "node 便携版部署完成 ($(node --version))，位置: $RUNTIME_DIR"
log '=== nodejs setup done ==='
