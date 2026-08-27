# Env-Tools 指令补全（Windows PowerShell 5.1+ / PowerShell 7+），对 tools.ps1 与 setup.ps1 生效。
#
# 启用方式：把下面这行追加到 $PROFILE（路径按实际仓库位置修改）
#   . "D:\path\to\Env-Tools\completion\Env-Tools.Completion.ps1"
# （跑一次 setup.ps1 会自动写入 $PROFILE，幂等）

# usage_monitor.py 的全部参数（与 linux/ai-tools/usage-monitor/usage_monitor.py 保持一致）
$script:EnvToolsUsageOptions = @(
    '--watch', '-w', '--interval', '-i', '--provider', '--json', '--no-color',
    '--no-codex-auto-login', '--config', '--kimi-credentials', '--kimi-web-credentials',
    '--codex-credentials', '--deepseek-key', '--deepseek-credentials',
    '--glm-key', '--glm-credentials'
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

# 两个入口的补全逻辑放在全局变量里：Register-ArgumentCompleter 与下方的
# TabExpansion2 包装共用同一份逻辑，避免两处漂移。
$global:EnvToolsCompleters = @{
    tools = {
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
                        Write-EnvToolsCompletion @('all', 'kimi', 'codex', 'deepseek', 'glm') $wordToComplete
                        return
                    }
                    { $_ -in @('--interval', '-i', '--deepseek-key', '--glm-key') } { return }  # 值参数，不补全
                    { $_ -eq '--config' -or $_ -like '--*-credentials' } { return }  # 文件路径，交给默认文件名补全
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
    setup = {
        param($wordToComplete, $commandAst, $cursorPosition)

        $texts = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
        $index = Get-EnvToolsArgIndex $commandAst $wordToComplete
        if ($index -ge 1 -and $texts[$index - 1] -in @('-Port', '-FirewallProfile')) { return }  # 参数值，不补全

        if ($wordToComplete -like '-*') {
            Write-EnvToolsCompletion @('--all', '--kimi', '--codex', '--verbose', '-Port', '-FirewallProfile') $wordToComplete
        } else {
            Write-EnvToolsCompletion @('all', 'kdesk', 'nodejs', 'ai-tools', 'openssh') $wordToComplete
        }
    }
}

# 注意：tools.ps1 / setup.ps1 是脚本而不是 native exe，
# 这里不用 -Native，Windows PowerShell 5.1 与 PowerShell 7+ 都可用。
# CommandName 必须覆盖各种调用形态：tools.ps1（PATH 上）、.\tools.ps1、./tools.ps1、
# 以及完整路径调用（*\tools.ps1 通配符）。
Register-ArgumentCompleter -CommandName 'tools', 'tools.ps1', '*\tools.ps1', '*/tools.ps1' -ScriptBlock $global:EnvToolsCompleters.tools
Register-ArgumentCompleter -CommandName 'setup', 'setup.ps1', '*\setup.ps1', '*/setup.ps1' -ScriptBlock $global:EnvToolsCompleters.setup

# --- TabExpansion2 包装 -----------------------------------------------------------
# 实测 PS 5.1：对带 param 块的脚本，只要已输入的词以 '-' 开头，内置参数名补全就
# 会接管，Register-ArgumentCompleter 的自定义补全器根本不会被调用
# （'.\setup.ps1 --a' 无任何候选）。这里包一层 TabExpansion2：
# 命令行调用的是本仓库 tools.ps1 / setup.ps1 时先跑自定义补全——
#   - 普通词（组件名/操作/参数值）：只用自定义结果（避免混入文件名候选的噪声）；
#   - '-' 开头的词：自定义结果与内置结果合并（脚本真实参数如 -Component 仍可补全）；
# 其余命令行原样转交原实现。重复 source 本文件不会叠加包装。
if (-not $global:EnvToolsOriginalTabExpansion2) {
    $prev = Get-Command -Name TabExpansion2 -CommandType Function -ErrorAction SilentlyContinue
    if ($prev -and $prev.ScriptBlock) {
        $global:EnvToolsOriginalTabExpansion2 = $prev.ScriptBlock
    }
}

function global:TabExpansion2 {
    param($inputScript, $cursorColumn, $options)

    $custom = @()
    $wordToComplete = ''
    # 仅拦截本仓库入口脚本（tools.ps1 / setup.ps1，支持 .\、全路径等调用形态）
    if ($inputScript -match '(?:^|[\s|&;])(?:[^\s|&;]*[\\/])?(tools|setup)\.ps1(?:\s|$)') {
        $kind = $Matches[1]
        $sub = $inputScript
        if ($cursorColumn -lt $inputScript.Length) { $sub = $inputScript.Substring(0, $cursorColumn) }
        if ($sub -match '(\S+)$') { $wordToComplete = $Matches[1] }
        # 命令名本身不算参数词
        if ($wordToComplete -match '(?:^|[\\/])(tools|setup)\.ps1$') { $wordToComplete = '' }
        $tokens = $null; $parseErrs = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseInput($sub, [ref]$tokens, [ref]$parseErrs)
        $cmdAst = $ast.Find({ param($a) return $a -is [System.Management.Automation.Language.CommandAst] }, $true)
        if ($cmdAst) {
            $custom = @(& $global:EnvToolsCompleters[$kind] $wordToComplete $cmdAst $cursorColumn)
        }
    }

    $original = & $global:EnvToolsOriginalTabExpansion2 $inputScript $cursorColumn $options

    if ($custom.Count -eq 0) { return $original }

    $customList = New-Object 'System.Collections.Generic.List[System.Management.Automation.CompletionResult]'
    foreach ($c in $custom) { $customList.Add($c) }

    # 普通词只用自定义结果；'-' 开头的词与内置结果合并（保留脚本真实参数）
    if ($wordToComplete -notlike '-*' -or
        -not $original -or -not $original.CompletionMatches -or $original.CompletionMatches.Count -eq 0) {
        return [System.Management.Automation.CommandCompletion]::new(
            $customList, -1, $cursorColumn - $wordToComplete.Length, $wordToComplete.Length)
    }

    $merged = New-Object 'System.Collections.Generic.List[System.Management.Automation.CompletionResult]'
    $seen = @{}
    foreach ($m in @($custom) + @($original.CompletionMatches)) {
        if (-not $seen.ContainsKey($m.CompletionText)) { $seen[$m.CompletionText] = $true; $merged.Add($m) }
    }
    return [System.Management.Automation.CommandCompletion]::new(
        $merged, -1, $original.ReplacementIndex, $original.ReplacementLength)
}
