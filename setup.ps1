# Env-Tools 总入口 (Windows)
# 自动检测操作系统并完成部署；当前实现 Windows 下的 kdesk、nodejs、ai-tools 与 openssh 部署。
# Linux 请使用 setup.sh。
#
# 用法:
#   setup.ps1                    # 部署全部组件
#   setup.ps1 kdesk              # 仅安装/更新/重部署 kdesk
#   setup.ps1 nodejs             # 仅部署 nodejs
#   setup.ps1 ai-tools           # 安装/更新全部 AI CLI 工具
#   setup.ps1 ai-tools --codex   # 仅安装/更新 codex（--all/--kimi 同理）
#   setup.ps1 openssh            # 部署 OpenSSH Server（默认端口 2222）
#   setup.ps1 openssh -Port 2223 # 指定 SSH 端口（-FirewallProfile Any 同理）
#   setup.ps1 kdesk nodejs       # 部署指定多个组件
#   右键「使用 PowerShell 运行」时会显示编号菜单选择组件（直接回车 = all）
#   注：带工具参数时请只指定一个组件（参数会透传给该组件的脚本）

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('all', 'kdesk', 'nodejs', 'ai-tools', 'openssh')]
    [string[]]$Component = @('all'),
    # 透传给组件脚本的参数（ai-tools: --all/--codex/--kimi；openssh: -Port/-FirewallProfile）
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$ToolArgs,
    # 内部使用：标记交互式运行（提权后结束时暂停等按键）
    [switch]$Interactive
)

# --- OS detection -----------------------------------------------------------
$isWindows = $false
if ($env:OS -eq 'Windows_NT') { $isWindows = $true }
if (Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) {
    if ($IsWindows) { $isWindows = $true }
}
if (-not $isWindows) {
    Write-Host '当前不是 Windows 系统，请改用根目录的 setup.sh。' -ForegroundColor Yellow
    exit 1
}

# --- 未指定组件时交互询问（如右键运行的场景）----------------------------------
if (-not $PSBoundParameters.ContainsKey('Component')) {
    $Interactive = $true
    $menu = [ordered]@{
        '1' = 'all'
        '2' = 'kdesk'
        '3' = 'nodejs'
        '4' = 'ai-tools'
        '5' = 'openssh'
    }
    Write-Host '可部署组件:' -ForegroundColor Cyan
    Write-Host '  [1] all (全部)  [2] kdesk  [3] nodejs  [4] ai-tools  [5] openssh'
    $answer = Read-Host '请输入编号（多个用空格分隔，直接回车 = 1）'
    if (-not [string]::IsNullOrWhiteSpace($answer)) {
        $picked = @()
        $bad = @()
        foreach ($item in ($answer -split '\s+' | Where-Object { $_ })) {
            if ($menu.Contains($item)) { $picked += $menu[$item] } else { $bad += $item }
        }
        if ($bad) {
            Write-Host "无效编号: $($bad -join ', ')" -ForegroundColor Red
            Read-Host '按回车退出'
            exit 1
        }
        $Component = $picked
    }
}

# --- ValueFromRemainingArguments 会把第二个及以后的位置参数收进 $ToolArgs， ------
# --- 将其中合法的组件名并回 $Component（如 setup.ps1 kdesk nodejs）-------------
if ($ToolArgs) {
    $validNames = @('all','kdesk','nodejs','ai-tools','openssh')
    $left = @()
    foreach ($a in $ToolArgs) {
        if ($a -in $validNames) { $Component += $a } else { $left += $a }
    }
    $ToolArgs = $left
}

# --- self-elevate -----------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    $argList = @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`"") + $Component
    if ($ToolArgs) { $argList += $ToolArgs }
    if ($Interactive) { $argList += '-Interactive' }
    Start-Process powershell -Verb RunAs -ArgumentList $argList
    exit
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$envtoolsVersionFile = Join-Path $root 'VERSION'
if (Test-Path $envtoolsVersionFile) {
    $envtoolsVersion = Get-Content $envtoolsVersionFile -TotalCount 1 -ErrorAction SilentlyContinue
    if ($envtoolsVersion) { Write-Host "Env-Tools v$($envtoolsVersion.Trim())" }
}

$targets = if ($Component -contains 'all') { @('kdesk','nodejs','ai-tools','openssh') } else { $Component }
$scripts = [ordered]@{
    kdesk      = 'windows\kdesk\setup_elevated.ps1'
    nodejs     = 'windows\nodejs\setup_nodejs.ps1'
    'ai-tools' = 'windows\ai-tools\setup_ai_tools.ps1'
    openssh    = 'windows\openssh\setup_openssh.ps1'
}

# 每个组件用独立 powershell 子进程运行：隔离子脚本里的 exit，并拿到真实退出码
$i = 0
foreach ($name in $targets) {
    $i++
    Write-Host ''
    Write-Host "=== [$i/$($targets.Count)] 部署 $name ===" -ForegroundColor Cyan
    $childScript = Join-Path $root $scripts[$name]

    # 预检组件脚本能否解析：文件损坏或丢失 UTF-8 BOM（被编辑器另存）时，
    # 直接运行只会得到一串难以理解的 ParserError，这里提前给出可操作的提示
    $parseErrs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($childScript, [ref]$null, [ref]$parseErrs)
    if ($parseErrs) {
        $first = $parseErrs[0]
        Write-Host "$name 组件脚本解析失败: $childScript" -ForegroundColor Red
        Write-Host "  $($first.Message) (行 $($first.Extent.StartLineNumber), 字符 $($first.Extent.StartColumnNumber))" -ForegroundColor Red
        Write-Host '脚本文件可能损坏或丢失了 UTF-8 BOM（编辑器另存所致），请重新从仓库同步该文件后再试。' -ForegroundColor Yellow
        if ($Interactive) { Read-Host '按回车退出' }
        exit 1
    }

    $childArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',$childScript)
    if ($name -in @('ai-tools','openssh') -and $ToolArgs) { $childArgs += $ToolArgs }
    & powershell @childArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "$name 部署失败 (exit=$LASTEXITCODE)，日志见 $($scripts[$name] -replace '[^\\]+\.ps1$','log\setup.log')" -ForegroundColor Red
        if ($Interactive) { Read-Host '按回车退出' }
        exit $LASTEXITCODE
    }
}

Write-Host ''
# 把 Tab 补全写入 PowerShell $PROFILE（幂等），新开 PowerShell 会话即可用
$completionScript = Join-Path $root 'completion\Env-Tools.Completion.ps1'
$marker = '# Env-Tools completion'
if (Test-Path $completionScript) {
    New-Item -ItemType Directory -Path (Split-Path -Parent $PROFILE) -Force | Out-Null
    if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force | Out-Null }
    if (-not (Select-String -Path $PROFILE -Pattern ([regex]::Escape($marker)) -Quiet)) {
        Add-Content -Path $PROFILE -Value "`r`n$marker`r`n. `"$completionScript`""
        Write-Host "已把 Tab 补全写入 $PROFILE（新开 PowerShell 会话生效）" -ForegroundColor Green
    }
}

# Git Bash：把 bash 补全写入 ~/.bashrc（幂等）。git 可能在 PATH 里但装在自定义目录
# （如 D:\software\Git），从 git.exe 反推 bash.exe 位置。
$gitBashCandidates = @("$env:ProgramFiles\Git\bin\bash.exe", "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")
$gitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($gitCmd) { $gitBashCandidates += (Join-Path (Split-Path -Parent (Split-Path -Parent $gitCmd.Source)) 'bin\bash.exe') }
$gitBash = $gitBashCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$completionBash = Join-Path $root 'completion\env-tools.bash'
if ($gitBash -and (Test-Path $completionBash)) {
    $bashrc = Join-Path $env:USERPROFILE '.bashrc'
    # 转成 /d/... 形式；rc 文件必须保持 LF 行尾，不能用 Add-Content（会写 CRLF）
    $posix = $completionBash -replace '\\', '/'
    $bashPath = '/' + $posix.Substring(0, 1).ToLower() + $posix.Substring(2)
    $existing = if (Test-Path $bashrc) { [IO.File]::ReadAllText($bashrc) } else { '' }
    if (-not $existing.Contains($marker)) {
        [IO.File]::AppendAllText($bashrc, "`n$marker`nsource `"$bashPath`"`n")
        Write-Host "已把 Tab 补全写入 Git Bash $bashrc（新开 Git Bash 生效）" -ForegroundColor Green
    }
}

# cmd.exe：原生只有文件名补全，参数补全依赖 Clink。检测到 Clink 时把
# argmatcher 脚本挂进它的自动加载目录（幂等）。
$clinkDir = Join-Path $env:LOCALAPPDATA 'clink'
$clinkLua = Join-Path $root 'completion\env-tools.clink.lua'
if ((Test-Path $clinkDir) -and (Test-Path $clinkLua)) {
    $shim = Join-Path $clinkDir 'env-tools.lua'
    $shimBody = "-- Env-Tools completion`ndofile([[$clinkLua]])`n"
    if (-not (Test-Path $shim) -or [IO.File]::ReadAllText($shim) -ne $shimBody) {
        [IO.File]::WriteAllText($shim, $shimBody)
        Write-Host "已把 cmd 补全注册到 Clink（重开 cmd 生效）" -ForegroundColor Green
    }
}

Write-Host '=== 部署完成 ===' -ForegroundColor Green
if ($Interactive) { Read-Host '按回车退出' }
