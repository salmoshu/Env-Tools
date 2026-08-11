# Env-Tools 指令补全（Windows PowerShell 5.1+ / PowerShell 7+），对 tools.ps1 与 setup.ps1 生效。
#
# 启用方式：把下面这行追加到 $PROFILE（路径按实际仓库位置修改）
#   . "D:\path\to\Env-Tools\completion\Env-Tools.Completion.ps1"

# usage_monitor.py 的全部参数（与 linux/ai-tools/usage-monitor/usage_monitor.py 保持一致）
$script:EnvToolsUsageOptions = @(
    '--watch', '-w', '--interval', '-i', '--provider', '--json', '--no-color',
    '--no-codex-auto-login', '--kimi-credentials', '--kimi-web-credentials',
    '--codex-credentials', '--codebuddy-credentials', '--deepseek-key', '--deepseek-credentials'
)

function script:Write-EnvToolsCompletion([string[]]$Values, [string]$WordToComplete) {
    foreach ($v in $Values) {
        if ($v -like "$WordToComplete*") {
            [System.Management.Automation.CompletionResult]::new($v, $v, 'ParameterValue', $v)
        }
    }
}

# 计算正在补全的参数下标（0 为脚本名本身）：
# 已输入部分词时 CommandElements 包含该词；光标在空格后时则不算入。
function script:Get-EnvToolsArgIndex($CommandAst, [string]$WordToComplete) {
    $count = @($CommandAst.CommandElements).Count
    if ($WordToComplete) { return $count - 1 }
    return $count
}

# 注意：tools.ps1 / setup.ps1 是脚本而不是 native exe，
# 这里不用 -Native，Windows PowerShell 5.1 与 PowerShell 7+ 都可用。
Register-ArgumentCompleter -CommandName 'tools.ps1', 'tools' -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $texts = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
    $index = Get-EnvToolsArgIndex $commandAst $wordToComplete

    # 第 1 个参数：应用名
    if ($index -le 1) {
        Write-EnvToolsCompletion @('ai-tools', 'openssh', '--help', '-h', 'help') $wordToComplete
        return
    }

    switch ($texts[1]) {
        'ai-tools' {
            if ($index -eq 2) {
                Write-EnvToolsCompletion @('--usage', '--help', '-h', 'help') $wordToComplete
                return
            }
            if ($texts.Count -lt 3 -or $texts[2] -ne '--usage') { return }
            $prev = $texts[$index - 1]
            switch ($prev) {
                '--provider' {
                    Write-EnvToolsCompletion @('all', 'kimi', 'codex', 'codebuddy', 'deepseek') $wordToComplete
                    return
                }
                # 数字 / 文件路径参数交给默认补全（文件名）
                default { }
            }
            if ($wordToComplete -and $wordToComplete -notlike '-*') { return }
            Write-EnvToolsCompletion $script:EnvToolsUsageOptions $wordToComplete
        }
        'openssh' {
            if ($index -eq 2) {
                Write-EnvToolsCompletion @('--status', '--help', '-h', 'help') $wordToComplete
            }
        }
    }
}

Register-ArgumentCompleter -CommandName 'setup.ps1', 'setup' -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)

    $texts = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
    $index = Get-EnvToolsArgIndex $commandAst $wordToComplete
    if ($index -ge 1 -and $texts[$index - 1] -eq '-Port') { return }  # 端口号，不补全

    if ($wordToComplete -like '-*') {
        Write-EnvToolsCompletion @('--all', '--kimi', '--codex', '--codebuddy', '-Port') $wordToComplete
    } else {
        Write-EnvToolsCompletion @('all', 'kdesk', 'nodejs', 'ai-tools', 'openssh') $wordToComplete
    }
}
