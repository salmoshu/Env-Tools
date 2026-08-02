# Env-Tools 总入口 (Windows)
# 自动检测操作系统并完成部署；当前实现 Windows 下的 kdesk、nodejs 与 ai-tools 部署。
# Linux 请使用 setup.sh。
#
# 用法:
#   setup.ps1                    # 部署全部组件
#   setup.ps1 kdesk              # 仅安装/更新/重部署 kdesk
#   setup.ps1 nodejs             # 仅部署 nodejs
#   setup.ps1 ai-tools           # 安装/更新全部 AI CLI 工具
#   setup.ps1 ai-tools --codex   # 仅安装/更新 codex（--all/--kimi/--codebuddy 同理）
#   setup.ps1 kdesk nodejs       # 部署指定多个组件
#   右键「使用 PowerShell 运行」时会先询问要部署的组件（直接回车 = all）

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('all', 'kdesk', 'nodejs', 'ai-tools')]
    [string[]]$Component = @('all'),
    # 透传给 ai-tools 脚本的参数（--all / --codex / --kimi / --codebuddy）
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
    Write-Host '可部署组件: all(全部) / kdesk / nodejs / ai-tools' -ForegroundColor Cyan
    $answer = Read-Host '请输入要部署的组件（多个用空格分隔，直接回车 = all）'
    if (-not [string]::IsNullOrWhiteSpace($answer)) {
        $Component = $answer -split '\s+' | Where-Object { $_ }
        $bad = $Component | Where-Object { $_ -notin @('all','kdesk','nodejs','ai-tools') }
        if ($bad) {
            Write-Host "无效组件: $($bad -join ', ')" -ForegroundColor Red
            Read-Host '按回车退出'
            exit 1
        }
    }
}

# --- ValueFromRemainingArguments 会把第二个及以后的位置参数收进 $ToolArgs， ------
# --- 将其中合法的组件名并回 $Component（如 setup.ps1 kdesk nodejs）-------------
if ($ToolArgs) {
    $validNames = @('all','kdesk','nodejs','ai-tools')
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

$targets = if ($Component -contains 'all') { @('kdesk','nodejs','ai-tools') } else { $Component }
$scripts = [ordered]@{
    kdesk      = 'windows\kdesk\setup_elevated.ps1'
    nodejs     = 'windows\nodejs\setup_nodejs.ps1'
    'ai-tools' = 'windows\ai-tools\setup_ai_tools.ps1'
}

# 每个组件用独立 powershell 子进程运行：隔离子脚本里的 exit，并拿到真实退出码
$i = 0
foreach ($name in $targets) {
    $i++
    Write-Host ''
    Write-Host "=== [$i/$($targets.Count)] 部署 $name ===" -ForegroundColor Cyan
    $childArgs = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $root $scripts[$name]))
    if ($name -eq 'ai-tools' -and $ToolArgs) { $childArgs += $ToolArgs }
    & powershell @childArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host "$name 部署失败 (exit=$LASTEXITCODE)，日志见 $($scripts[$name] -replace '[^\\]+\.ps1$','log\setup.log')" -ForegroundColor Red
        if ($Interactive) { Read-Host '按回车退出' }
        exit $LASTEXITCODE
    }
}

Write-Host ''
Write-Host '=== 部署完成 ===' -ForegroundColor Green
if ($Interactive) { Read-Host '按回车退出' }
