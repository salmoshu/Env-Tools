# Env-Tools 指令补全（bash），对 ./tools.sh 与 ./setup.sh 生效
# （bash 按命令 basename 匹配补全规则，所以 ./tools.sh 也能触发）。
#
# 启用方式（二选一）：
#   1) 临时生效:  source completion/env-tools.bash
#   2) 永久生效:  把下面这行追加到 ~/.bashrc（路径按实际仓库位置修改）
#      source ~/Env-Tools/completion/env-tools.bash

_env_tools_reply() {
    # shellcheck disable=SC2207
    COMPREPLY=( $(compgen -W "$1" -- "$2") )
}

# usage_monitor.py 的全部参数（与 linux/ai-tools/usage-monitor/usage_monitor.py 保持一致）
_env_tools_usage_opts='--watch -w --interval -i --provider --json --no-color --no-codex-auto-login --config --kimi-credentials --kimi-web-credentials --codex-credentials --deepseek-key --deepseek-credentials --glm-key --glm-credentials'

_env_tools_tools() {
    local cur prev
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    # 第 1 个参数：应用名
    if (( COMP_CWORD == 1 )); then
        _env_tools_reply 'ai-tools openssh --help -h help' "$cur"
        return
    fi

    case "${COMP_WORDS[1]}" in
        ai-tools)
            if (( COMP_CWORD == 2 )); then
                _env_tools_reply '--usage --help -h help' "$cur"
                return
            fi
            [ "${COMP_WORDS[2]}" = '--usage' ] || return
            case "$prev" in
                --provider)
                    _env_tools_reply 'all kimi codex deepseek glm' "$cur"
                    ;;
                --interval|-i|--deepseek-key|--glm-key)
                    COMPREPLY=()  # 值参数，不补全
                    ;;
                --config|--kimi-credentials|--kimi-web-credentials|--codex-credentials|--deepseek-credentials|--glm-credentials)
                    # shellcheck disable=SC2207
                    COMPREPLY=( $(compgen -f -- "$cur") )  # 文件路径参数，补全文件名
                    ;;
                *)
                    _env_tools_reply "$_env_tools_usage_opts" "$cur"
                    ;;
            esac
            ;;
        openssh)
            if (( COMP_CWORD == 2 )); then
                _env_tools_reply '--status --help -h help' "$cur"
            fi
            ;;
    esac
}

_env_tools_setup() {
    local cur prev
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"

    if [ "$prev" = '--port' ]; then
        COMPREPLY=()  # 端口号，不补全
        return
    fi
    case "$cur" in
        -*)
            _env_tools_reply '--port --all --kimi --codex --verbose' "$cur"
            ;;
        *)
            _env_tools_reply 'all nodejs ai-tools openssh kdesk' "$cur"
            ;;
    esac
}

complete -F _env_tools_tools tools.sh
complete -F _env_tools_setup setup.sh
