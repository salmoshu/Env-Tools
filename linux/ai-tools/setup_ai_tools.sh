#!/usr/bin/env bash
# AI CLI 工具安装/更新 (Linux)
# 用法:
#   setup_ai_tools.sh                  # 安装/更新全部工具
#   setup_ai_tools.sh --codex          # 仅 codex
#   setup_ai_tools.sh --kimi --codex   # 指定多个
#   setup_ai_tools.sh --all            # 全部工具
#   setup_ai_tools.sh --verbose        # 展开完整安装日志
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
VERBOSE=false
RESULT_DIR=""

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
        --verbose|-v) VERBOSE=true ;;
        *)
            log "未知参数: $arg（可选: --all / --codex / --kimi / --codebuddy / --verbose）"
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

# --- 并行安装/更新 --------------------------------------------------------------
# npm 全局目录不能安全地由多个 npm 进程同时写入，因此 npm 工具合并为一个线程；
# 非 npm 安装的 kimi 使用官方脚本，作为第二个线程并行执行。
RESULT_DIR="$(mktemp -d)"
trap 'rm -rf "$RESULT_DIR"' EXIT

write_result() {
    printf '%s\t%s\t%s\t%s\n' "$2" "$1" "${3:-?}" "${4:-?}" >"$RESULT_DIR/$1.result"
}

npm_worker() {
    local names=("$@") pkgs=() name before after
    local -A before_map=()
    for name in "${names[@]}"; do
        pkgs+=("$(pkg_of "$name")@latest")
        before_map[$name]="$(version_of "$name")"
    done
    printf 'npm install -g %s\n' "${pkgs[*]}"
    if npm install -g --loglevel=error --progress=false "${pkgs[@]}"; then
        hash -r 2>/dev/null || true
        for name in "${names[@]}"; do
            after="$(version_of "$name")"
            printf '%s 完成: %s -> %s\n' "$name" "${before_map[$name]:-未安装}" "${after:-未知}"
            write_result "$name" OK "${before_map[$name]:-未安装}" "${after:-未知}"
        done
    else
        for name in "${names[@]}"; do
            printf 'ERROR: %s 安装/更新失败\n' "$name" >&2
            write_result "$name" FAIL "${before_map[$name]:-未安装}"
        done
        return 1
    fi
}

kimi_worker() {
    local before after
    before="$(version_of kimi)"
    if ! command -v curl >/dev/null 2>&1; then
        printf 'ERROR: 更新 kimi 需要 curl\n' >&2
        write_result kimi FAIL "${before:-未安装}"
        return 1
    fi
    printf 'kimi 官方安装线程: curl -fsSL %s | bash\n' "$KIMI_INSTALL_URL"
    if curl -fsSL "$KIMI_INSTALL_URL" | bash; then
        hash -r 2>/dev/null || true
        after="$(version_of kimi)"
        printf 'kimi 完成: %s -> %s\n' "${before:-未安装}" "${after:-未知}"
        write_result kimi OK "${before:-未安装}" "${after:-未知}"
    else
        printf 'ERROR: kimi 安装/更新失败\n' >&2
        write_result kimi FAIL "${before:-未安装}"
        return 1
    fi
}

npm_targets=()
kimi_script=false
for name in "${targets[@]}"; do
    if [ "$name" = kimi ] \
        && ! npm ls -g --depth=0 "$KIMI_NPM_PKG" >/dev/null 2>&1; then
        kimi_script=true
    else
        npm_targets+=("$name")
    fi
done

pids=() thread_tags=() thread_logs=() thread_tools=()
collapsed=false
if [[ -t 1 ]] && ! $VERBOSE; then collapsed=true; fi

start_worker() {
    local tag="$1" tools="$2" logfile="$3"
    shift 3
    if $collapsed; then
        "$@" >"$logfile" 2>&1 &
    else
        "$@" 2>&1 | sed -u "s/^/[$tag] /" | tee -a "$LOG" &
    fi
    pids+=("$!")
    thread_tags+=("$tag")
    thread_logs+=("$logfile")
    thread_tools+=("$tools")
}

if ((${#npm_targets[@]} > 0)); then
    start_worker npm "${npm_targets[*]}" "$RESULT_DIR/npm.log" npm_worker "${npm_targets[@]}"
fi
if $kimi_script; then
    start_worker kimi kimi "$RESULT_DIR/kimi.log" kimi_worker
fi

trap 'kill "${pids[@]}" 2>/dev/null; printf "\033[?25h"; exit 130' INT TERM
threads_alive() {
    local pid
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && return 0; done
    return 1
}

start=$SECONDS
if $collapsed; then
    spinner=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
    tick=0; drawn=0
    cols="${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}"
    width=$((cols > 30 ? cols - 16 : 60))
    printf '\033[?25l'
    while threads_alive; do
        ((drawn > 0)) && printf '\033[%dA' "$drawn"
        drawn=0
        for i in "${!pids[@]}"; do
            indent=$((${#thread_tags[$i]} + 5)); first=true
            while IFS= read -r last; do
                last="${last:0:$width}"
                if $first; then
                    printf '\033[2K%s [%s] %s\n' "${spinner[$((tick % 10))]}" "${thread_tags[$i]}" "$last"
                    first=false
                else
                    printf '\033[2K%*s%s\n' "$indent" '' "$last"
                fi
                drawn=$((drawn + 1))
            done < <(tail -n 5 "${thread_logs[$i]}" 2>/dev/null | tr -d '\r' | sed 's/\x1b\[[0-9;]*m//g')
            if $first; then
                printf '\033[2K%s [%s] 等待输出…\n' "${spinner[$((tick % 10))]}" "${thread_tags[$i]}"
                drawn=$((drawn + 1))
            fi
        done
        tick=$((tick + 1)); sleep 0.1
    done
    if ((drawn > 0)); then
        printf '\033[%dA' "$drawn"
        for ((i = 0; i < drawn; i++)); do printf '\033[2K\n'; done
        printf '\033[%dA' "$drawn"
    fi
    for i in "${!pids[@]}"; do
        failed_thread=false
        for name in ${thread_tools[$i]}; do
            [ -f "$RESULT_DIR/$name.result" ] && grep -q '^OK' "$RESULT_DIR/$name.result" || failed_thread=true
        done
        if $failed_thread; then mark='✗'; else mark='✓'; fi
        printf '\033[2K[%s] [%s] 完成（%ds）\n' "$mark" "${thread_tags[$i]}" "$((SECONDS - start))"
        cat "${thread_logs[$i]}" >>"$LOG"
        if $failed_thread; then
            printf '%s\n' "---- [${thread_tags[$i]}] 日志尾部 ----"
            tail -n 30 "${thread_logs[$i]}"
        fi
    done
    printf '\033[?25h'
else
    while threads_alive; do sleep 1; done
fi

for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
trap - INT TERM

failed=()
for name in "${targets[@]}"; do
    if [ ! -f "$RESULT_DIR/$name.result" ] || ! grep -q '^OK' "$RESULT_DIR/$name.result"; then
        failed+=("$name")
    fi
done
if ((${#failed[@]} > 0)); then
    log "=== ai-tools setup done，失败: ${failed[*]} ==="
    exit 1
fi
log '=== ai-tools setup done ==='
