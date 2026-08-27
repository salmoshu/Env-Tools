#!/usr/bin/env bash
# AI CLI 工具安装/更新 (Linux)
# 用法:
#   setup_ai_tools.sh                  # 安装/更新全部工具
#   setup_ai_tools.sh --codex          # 仅 codex
#   setup_ai_tools.sh --kimi --codex   # 指定多个
#   setup_ai_tools.sh --all            # 全部工具
#   setup_ai_tools.sh --verbose        # 展开完整安装日志（默认折叠视图）
# 依赖 nodejs（npm），缺失时自动调用 ../nodejs/setup_nodejs.sh 安装。
# kimi 若为非 npm 方式安装（官方脚本二进制），更新时走官方安装脚本。
#
# 输出约定（与 windows/ai-tools/setup_ai_tools.ps1 行为对齐）：
#   交互终端下按安装对象（codex / kimi）分条陈述，每个对象的
#   过程消息折叠为最新 3 行、原位刷新；--verbose 或非 TTY 时退化为全量流式输出。
#   全部结束后打印一份安装简报（每个对象：安装/更新/已是最新/失败 + 版本变化）。
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
# npm 默认源失败时回退的国内镜像
NPM_MIRROR="https://registry.npmmirror.com"
VERBOSE=false

pkg_of() {
    case "$1" in
        codex)     echo '@openai/codex' ;;
        kimi)      echo "$KIMI_NPM_PKG" ;;
    esac
}

version_of() {
    command -v "$1" >/dev/null 2>&1 && "$1" --version 2>/dev/null | head -1
}

# 从 --version 输出中提取 x.y.z（各 CLI 输出格式不一，如 "codex-cli 0.25.0"）
extract_semver() {
    grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

# npm registry 上该包的最新版本；默认源查询失败时回退国内镜像（通过
# NPM_SOURCE_NOTE 告知调用方，由调用方按协议输出，不直接污染线程日志）；
# 仍失败（离线等）输出空，调用方按"需要安装"兜底
NPM_SOURCE_NOTE=''
latest_npm_version() {
    NPM_SOURCE_NOTE=''
    local ver
    ver="$(npm view "$1" version --loglevel=error --cache "$NPM_CACHE" 2>/dev/null | tail -1)"
    if [ -z "$ver" ]; then
        ver="$(npm view "$1" version --loglevel=error --cache "$NPM_CACHE" --registry "$NPM_MIRROR" 2>/dev/null | tail -1)"
        [ -n "$ver" ] && NPM_SOURCE_NOTE="默认源查询失败，已改用国内镜像 ($NPM_MIRROR)"
    fi
    printf '%s' "$ver"
}

# 本地版本与官方最新一致时跳过安装。返回 0=已是最新，1=需要安装
is_up_to_date() {
    local local_ver="$1" latest="$2"
    [ -n "$local_ver" ] && [ -n "$latest" ] && [ "$local_ver" = "$latest" ]
}

# --- 解析参数 -------------------------------------------------------------------
targets=()
for arg in "$@"; do
    case "$arg" in
        --all)       targets=(codex kimi) ;;
        --codex)     targets+=(codex) ;;
        --kimi)      targets+=(kimi) ;;
        --verbose|-v) VERBOSE=true ;;
        *)
            log "未知参数: $arg（可选: --all / --codex / --kimi / --verbose）"
            exit 2
            ;;
    esac
done
if ((${#targets[@]} == 0)); then
    targets=(codex kimi)
fi

log "=== ai-tools setup start (targets: ${targets[*]}) ==="

# 脚本的 npm 下载（view 元数据 + install 包）全部放进独立临时缓存，随脚本
# 结束删除，不污染用户的全局 npm 缓存（~/.npm/_cacache）
RESULT_DIR="$(mktemp -d)"
NPM_CACHE="$RESULT_DIR/npm-cache"

# --- 输出机制 -------------------------------------------------------------------
# 后台工作线程只向线程日志写两种协议行：
#   LOG|<对象>|<文本>                          —— 归属到具体安装对象的过程消息
#   （对象结果仍写 <对象>.result 文件：status<TAB>name<TAB>before<TAB>after）
# 主线程增量读取线程日志，按对象分条渲染：折叠模式下每个对象只保留最新 3 行
# 原位刷新；非折叠模式流式打印 [对象] 文本。两种模式都会把干净文本写入 $LOG。
collapsed=false
if [[ -t 1 ]] && [ "${TERM:-dumb}" != "dumb" ] && ! $VERBOSE; then collapsed=true; fi
trap '$collapsed && printf "\033[?25h"; rm -rf "$RESULT_DIR"' EXIT

spinner=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
tick=0
cols="${COLUMNS:-$(tput cols 2>/dev/null || echo 80)}"
width=$((cols > 30 ? cols - 16 : 60))

declare -A TOOL_LINES=() pump_off=() pump_buf=()
panel_drawn=0

append_tool_line() {
    local tool="$1" text="$2"
    [ -z "${text//[[:space:]]/}" ] && return
    if [ -z "${TOOL_LINES[$tool]:-}" ]; then
        TOOL_LINES[$tool]="$text"
    else
        TOOL_LINES[$tool]="$(printf '%s\n%s\n' "${TOOL_LINES[$tool]}" "$text" | tail -n 3)"
    fi
}

handle_line() {
    local line="$1" tool text
    case "$line" in
        LOG\|*)
            text="${line#LOG|}"; tool="${text%%|*}"; text="${text#*|}"
            append_tool_line "$tool" "$text"
            printf '%s  [%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$tool" "$text" >>"$LOG"
            $collapsed || printf '[%s] %s\n' "$tool" "$text"
            ;;
        *)
            [ -z "${line//[[:space:]]/}" ] && return
            printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$line" >>"$LOG"
            $collapsed || printf '%s\n' "$line"
            ;;
    esac
}

# 折叠面板：每个安装对象一行标题 + 最新 3 行过程消息，原位重绘
render_panel() {
    ((panel_drawn > 0)) && printf '\033[%dA' "$panel_drawn"
    panel_drawn=0
    local tool line mark indent
    for tool in "${targets[@]}"; do
        if [ -f "$RESULT_DIR/$tool.result" ]; then
            if grep -q '^OK' "$RESULT_DIR/$tool.result"; then mark='\033[32m✓\033[0m'; else mark='\033[31m✗\033[0m'; fi
        else
            mark="${spinner[$((tick % 10))]}"
        fi
        printf '\033[2K%b \033[1m[%s]\033[0m\n' "$mark" "$tool"
        panel_drawn=$((panel_drawn + 1))
        indent=$((${#tool} + 5))
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            printf '\033[2K\033[2m%*s%s\033[0m\n' "$indent" '' "${line:0:$width}"
            panel_drawn=$((panel_drawn + 1))
        done <<< "${TOOL_LINES[$tool]:-}"
    done
}

# 增量读取所有线程日志（保留跨次读取的不完整行）
pump() {
    local i f size off chunk line last1
    for i in "${!thread_logs[@]}"; do
        f="${thread_logs[$i]}"
        [ -f "$f" ] || continue
        off=${pump_off[$i]:-0}
        size=$(stat -c %s "$f" 2>/dev/null || echo 0)
        ((size > off)) || continue
        last1="$(tail -c 1 -- "$f" 2>/dev/null)"
        chunk="$(tail -c +$((off + 1)) -- "$f")"
        pump_off[$i]=$size
        # 命令替换会吃掉结尾换行：文件以换行结尾则补回，否则末行不完整、留到下次
        chunk="${pump_buf[$i]:-}$chunk"
        [ -z "$last1" ] && [ -n "$chunk" ] && chunk+=$'\n'
        pump_buf[$i]=''
        while [[ "$chunk" == *$'\n'* ]]; do
            line="${chunk%%$'\n'*}"
            chunk="${chunk#*$'\n'}"
            handle_line "$line"
        done
        pump_buf[$i]="$chunk"
    done
}

pump_flush() {
    local i
    for i in "${!thread_logs[@]}"; do
        [ -n "${pump_buf[$i]:-}" ] && handle_line "${pump_buf[$i]}"
        pump_buf[$i]=''
    done
}

# 依赖安装（nodejs）的迷你折叠视图：标题 + 最新 3 行
fold_watch() {
    local tag="$1" f="$2" pid="$3" n=0 first=true line i
    printf '\033[?25l'
    while kill -0 "$pid" 2>/dev/null; do
        ((n > 0)) && printf '\033[%dA' "$n"
        n=0; first=true
        while IFS= read -r line; do
            if $first; then
                printf '\033[2K%s \033[1m[%s]\033[0m \033[2m%s\033[0m\n' "${spinner[$((tick % 10))]}" "$tag" "${line:0:$width}"
                first=false
            else
                printf '\033[2K\033[2m%*s%s\033[0m\n' $((${#tag} + 5)) '' "${line:0:$width}"
            fi
            n=$((n + 1))
        done < <(tail -n 3 "$f" 2>/dev/null | tr -d '\r' | sed 's/\x1b\[[0-9;]*m//g')
        if $first; then
            printf '\033[2K%s \033[1m[%s]\033[0m 等待输出…\n' "${spinner[$((tick % 10))]}" "$tag"
            n=1
        fi
        tick=$((tick + 1)); sleep 0.1
    done
    if ((n > 0)); then
        printf '\033[%dA' "$n"
        for ((i = 0; i < n; i++)); do printf '\033[2K\n'; done
        printf '\033[%dA' "$n"
    fi
    printf '\033[?25h'
}

# --- 依赖：nodejs / npm -----------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
    log '未检测到 node/npm，先部署 nodejs ...'
    nj_start=$SECONDS
    if $collapsed; then
        bash "$DIR/../nodejs/setup_nodejs.sh" >"$RESULT_DIR/nodejs.log" 2>&1 &
        nj_pid=$!
        fold_watch nodejs "$RESULT_DIR/nodejs.log" "$nj_pid"
        wait "$nj_pid"; nj_rc=$?
        cat "$RESULT_DIR/nodejs.log" >>"$LOG"
        if [ "$nj_rc" -eq 0 ]; then
            printf '\033[32m✓\033[0m \033[1m[nodejs]\033[0m 部署完成（%ds）\n' $((SECONDS - nj_start))
        else
            printf '\033[31m✗\033[0m \033[1m[nodejs]\033[0m 部署失败（%ds）\n' $((SECONDS - nj_start))
            tail -n 30 "$RESULT_DIR/nodejs.log"
        fi
    else
        bash "$DIR/../nodejs/setup_nodejs.sh"
        nj_rc=$?
    fi
    if [ "$nj_rc" -ne 0 ]; then
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

write_result() {
    printf '%s\t%s\t%s\t%s\n' "$2" "$1" "${3:-?}" "${4:-?}" >"$RESULT_DIR/$1.result"
}

emit() { printf 'LOG|%s|%s\n' "$1" "$2"; }

npm_worker() {
    local names=("$@") pkgs=() install_names=() name before after latest local_ver n
    local -A before_map=()
    for name in "${names[@]}"; do
        before_map[$name]="$(version_of "$name")"
        local_ver="$(printf '%s' "${before_map[$name]}" | extract_semver)"
        emit "$name" "查询最新版本 ($(pkg_of "$name")) ..."
        latest="$(latest_npm_version "$(pkg_of "$name")")"
        [ -n "$NPM_SOURCE_NOTE" ] && emit "$name" "$NPM_SOURCE_NOTE"
        if is_up_to_date "$local_ver" "$latest"; then
            emit "$name" "已是最新 ($local_ver)，跳过安装"
            write_result "$name" OK "${before_map[$name]:-未安装}" "${before_map[$name]:-未安装}"
        else
            if [ -n "$latest" ]; then
                emit "$name" "当前 ${local_ver:-未安装}，最新 $latest，准备安装/更新"
            else
                emit "$name" '无法查询最新版本（离线?），按需要安装处理'
            fi
            install_names+=("$name")
            pkgs+=("$(pkg_of "$name")@latest")
        fi
    done
    if ((${#pkgs[@]} == 0)); then
        return 0
    fi
    for name in "${install_names[@]}"; do
        emit "$name" "安装/更新中: npm install -g ${pkgs[*]}"
    done
    # 默认源失败时回退国内镜像重试一次
    if ! npm_install_broadcast "${pkgs[@]}"; then
        for name in "${install_names[@]}"; do
            emit "$name" "默认源安装失败，改用国内镜像重试: $NPM_MIRROR"
        done
        if ! npm_install_broadcast --registry "$NPM_MIRROR" "${pkgs[@]}"; then
            for name in "${install_names[@]}"; do
                emit "$name" 'ERROR: 安装/更新失败'
                write_result "$name" FAIL "${before_map[$name]:-未安装}"
            done
            return 1
        fi
    fi
    hash -r 2>/dev/null || true
    for name in "${install_names[@]}"; do
        after="$(version_of "$name")"
        emit "$name" "完成: ${before_map[$name]:-未安装} -> ${after:-未知}"
        write_result "$name" OK "${before_map[$name]:-未安装}" "${after:-未知}"
    done
}

# 合并安装（多个 npm 包一次 install，npm 全局目录不能并发写），
# npm 原始输出广播给每个待装对象
npm_install_broadcast() {
    local line n
    npm install -g --loglevel=error --progress=false --cache "$NPM_CACHE" "$@" 2>&1 |
        while IFS= read -r line; do
            [ -z "$line" ] && continue
            for n in "${install_names[@]}"; do emit "$n" "npm: $line"; done
        done
    return "${PIPESTATUS[0]}"
}

kimi_worker() {
    local before after latest local_ver line rc
    before="$(version_of kimi)"
    # 官方脚本安装的二进制没有 npm 元数据，用 registry 最新版与 --version 输出对比
    emit kimi '查询最新版本 (code.kimi.com) ...'
    latest="$(latest_npm_version "$KIMI_NPM_PKG")"
    [ -n "$NPM_SOURCE_NOTE" ] && emit kimi "$NPM_SOURCE_NOTE"
    local_ver="$(printf '%s' "$before" | extract_semver)"
    if is_up_to_date "$local_ver" "$latest"; then
        emit kimi "已是最新 ($local_ver)，跳过安装"
        write_result kimi OK "${before:-未安装}" "${before:-未安装}"
        return 0
    fi
    if ! command -v curl >/dev/null 2>&1; then
        emit kimi 'ERROR: 更新 kimi 需要 curl'
        write_result kimi FAIL "${before:-未安装}"
        return 1
    fi
    emit kimi "安装/更新中: 官方安装脚本 ($KIMI_INSTALL_URL)，当前 ${before:-未安装}"
    curl -fsSL "$KIMI_INSTALL_URL" | bash 2>&1 | while IFS= read -r line; do
        line="$(printf '%s' "$line" | tr -d '\r' | sed 's/\x1b\[[0-9;]*m//g')"
        [ -n "$line" ] && emit kimi "$line"
    done
    rc=${PIPESTATUS[1]}
    if [ "$rc" -eq 0 ]; then
        hash -r 2>/dev/null || true
        after="$(version_of kimi)"
        emit kimi "完成: ${before:-未安装} -> ${after:-未知}"
        write_result kimi OK "${before:-未安装}" "${after:-未知}"
    else
        emit kimi "ERROR: 安装/更新失败 (install.sh exit=$rc)"
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

start_worker() {
    local tag="$1" tools="$2" logfile="$3"
    shift 3
    "$@" >"$logfile" 2>&1 &
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

trap 'kill "${pids[@]}" 2>/dev/null; exit 130' INT TERM
threads_alive() {
    local pid
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && return 0; done
    return 1
}

$collapsed && printf '\033[?25l'
while threads_alive; do
    pump
    if $collapsed; then
        render_panel
        tick=$((tick + 1))
        sleep 0.1
    else
        sleep 0.3
    fi
done
for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
trap - INT TERM

# 线程异常退出（未写结果文件）按失败兜底
for i in "${!thread_tools[@]}"; do
    for name in ${thread_tools[$i]}; do
        [ -f "$RESULT_DIR/$name.result" ] || write_result "$name" FAIL '' ''
    done
done

pump
pump_flush
if $collapsed; then
    render_panel   # 终态（✓/✗ + 每个对象最后 3 行）
    printf '\033[?25h'
    # 失败对象展开日志尾部
    for i in "${!thread_tags[@]}"; do
        failed_thread=false
        for name in ${thread_tools[$i]}; do
            [ -f "$RESULT_DIR/$name.result" ] && grep -q '^OK' "$RESULT_DIR/$name.result" || failed_thread=true
        done
        if $failed_thread; then
            printf '%s\n' "---- [${thread_tags[$i]}] 日志尾部 ----"
            grep -v '^RESULT|' "${thread_logs[$i]}" | sed 's/^LOG|[^|]*|//' | tail -n 30
        fi
    done
fi

# --- 安装简报 -------------------------------------------------------------------
echo '' | tee -a "$LOG"
echo '安装简报:' | tee -a "$LOG"
echo "  node/npm : $(version_of node) / npm $(npm --version 2>/dev/null | head -1)" | tee -a "$LOG"
failed=()
for name in "${targets[@]}"; do
    status=FAIL; before=''; after=''
    [ -f "$RESULT_DIR/$name.result" ] && IFS=$'\t' read -r status _ before after <"$RESULT_DIR/$name.result"
    if [ "$status" = OK ]; then
        mark='✓'
        if [ "$before" = '未安装' ]; then
            text="安装成功 ($after)"
        elif [ "$before" = "$after" ]; then
            text="已是最新 ($after)"
        else
            text="更新成功 ($before -> $after)"
        fi
    else
        mark='✗'
        text="失败（详见日志 $LOG）"
        failed+=("$name")
    fi
    printf '  %s %-9s: %s\n' "$mark" "$name" "$text" | tee -a "$LOG"
done

if ((${#failed[@]} > 0)); then
    log "=== ai-tools setup done，失败: ${failed[*]} ==="
    exit 1
fi
log '=== ai-tools setup done ==='
