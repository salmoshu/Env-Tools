#!/usr/bin/env bash
# AI CLI 工具安装/更新 (Linux)
# 用法:
#   setup_ai_tools.sh                  # 安装/更新全部工具
#   setup_ai_tools.sh --codex          # 仅 codex
#   setup_ai_tools.sh --kimi --codex   # 指定多个
#   setup_ai_tools.sh --all            # 全部工具
# 依赖 nodejs（npm），缺失时自动调用 ../nodejs/setup_nodejs.sh 安装。
# kimi 若为非 npm 方式安装（官方脚本二进制），更新时走官方安装脚本。
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$DIR/log"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/setup.log"

log() {
    local line="$(date '+%Y-%m-%d %H:%M:%S')  $1"
    echo "$line" | tee -a "$LOG"
}

KIMI_NPM_PKG="@moonshot-ai/kimi-code"
KIMI_INSTALL_URL="https://code.kimi.com/kimi-code/install.sh"

pkg_of() {
    case "$1" in
        codex)     echo '@openai/codex' ;;
        kimi)      echo "$KIMI_NPM_PKG" ;;
        codebuddy) echo '@tencent-ai/codebuddy-code' ;;
    esac
}

version_of() {
    command -v "$1" >/dev/null 2>&1 && "$1" --version 2>/dev/null | head -1
}

# --- 解析参数 -------------------------------------------------------------------
targets=()
for arg in "$@"; do
    case "$arg" in
        --all)       targets=(codex kimi codebuddy) ;;
        --codex)     targets+=(codex) ;;
        --kimi)      targets+=(kimi) ;;
        --codebuddy) targets+=(codebuddy) ;;
        *)
            log "未知参数: $arg（可选: --all / --codex / --kimi / --codebuddy）"
            exit 2
            ;;
    esac
done
if ((${#targets[@]} == 0)); then
    targets=(codex kimi codebuddy)
fi

log "=== ai-tools setup start (targets: ${targets[*]}) ==="

# --- 依赖：nodejs / npm -----------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
    log '未检测到 node/npm，先部署 nodejs ...'
    if ! bash "$DIR/../nodejs/setup_nodejs.sh"; then
        log 'ERROR: nodejs 部署失败'
        exit 1
    fi
    # 便携版部署时 runtime/bin 不在当前 PATH 中，手动补上
    [ -d "$DIR/../nodejs/runtime/bin" ] && export PATH="$DIR/../nodejs/runtime/bin:$PATH"
    hash -r 2>/dev/null || true
    if ! command -v npm >/dev/null 2>&1; then
        log 'ERROR: nodejs 部署后仍无法找到 npm'
        exit 1
    fi
fi
log "npm 就绪: $(version_of node) (node)"

# --- 安装/更新 ----------------------------------------------------------------------
failed=()
for name in "${targets[@]}"; do
    pkg="$(pkg_of "$name")"
    before="$(version_of "$name")"
    log "安装/更新 $name ($pkg)，当前版本: ${before:-未安装}"

    if [ "$name" = 'kimi' ] && command -v kimi >/dev/null 2>&1 \
        && ! npm ls -g --depth=0 "$KIMI_NPM_PKG" >/dev/null 2>&1; then
        # 已安装的 kimi 不是 npm 包（官方脚本二进制），用官方脚本更新
        if ! command -v curl >/dev/null 2>&1; then
            log 'ERROR: 更新 kimi 需要 curl'
            failed+=(kimi)
            continue
        fi
        log "kimi 为官方脚本安装，执行: curl -fsSL $KIMI_INSTALL_URL | bash"
        curl -fsSL "$KIMI_INSTALL_URL" | bash
    else
        npm install -g "$pkg@latest" --loglevel=error
    fi

    if [ $? -ne 0 ]; then
        log "ERROR: $name 安装/更新失败"
        failed+=("$name")
        continue
    fi
    hash -r 2>/dev/null || true
    after="$(version_of "$name")"
    log "$name 完成: ${before:-未安装} -> ${after:-未知}"
done

if ((${#failed[@]} > 0)); then
    log "=== ai-tools setup done，失败: ${failed[*]} ==="
    exit 1
fi
log '=== ai-tools setup done ==='
