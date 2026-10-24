# ZCode 桌面版安装/更新 (Windows)
# 用法: setup_zcode.ps1              # 安装或更新到官方最新版
#
# 说明：
#   ZCode 是智谱的桌面应用（Electron/NSIS 安装包），无 CLI 安装器。
#   最新版从官网 https://zcode.z.ai/cn 首页的下载链接解析（无独立
#   latest 端点），按 semver 取最大；已装版本读卸载注册表
#   （HKCU/HKLM Uninstall 下 DisplayName = "ZCode x.y.z"）。
#   静默安装走 NSIS /S；ZCode 正在运行时安装器可能静默失败，脚本
#   先尝试结束 ZCode 进程再装。
#   代理：官网与 CDN 国内直连可达，脚本内 web 请求一律直连。

[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$envtoolsVersionFile = Join-Path $dir '..\..\VERSION'
if (Test-Path $envtoolsVersionFile) {
    $envtoolsVersion = Get-Content $envtoolsVersionFile -TotalCount 1 -ErrorAction SilentlyContinue
    if ($envtoolsVersion) { Write-Host "Env-Tools v$($envtoolsVersion.Trim())" }
}

$logDir = Join-Path $dir 'log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'setup.log'

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    $line | Out-File $log -Append -Encoding utf8
    Write-Host $line
}

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
[System.Net.WebRequest]::DefaultWebProxy = $null

# --- 已装版本：卸载注册表（HKCU 优先，回退 HKLM 64/32）-------------------------
function Get-InstalledZcode {
    foreach ($root in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
    )) {
        if (-not (Test-Path $root)) { continue }
        foreach ($key in Get-ChildItem $root -ErrorAction SilentlyContinue) {
            $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
            if ($props.DisplayName -match '^ZCode\s+\d') {
                if ($props.DisplayVersion) { return $props.DisplayVersion.Trim() }
            }
        }
    }
    return $null
}

# --- 最新版本：官网首页解析 windows-x64 下载链接，按 semver 取最大 ---------------
function Get-LatestZcode {
    try {
        $html = (Invoke-WebRequest -Uri 'https://zcode.z.ai/cn' -UseBasicParsing -MaximumRedirection 5).Content
        if ($html -is [byte[]]) { $html = [System.Text.Encoding]::UTF8.GetString($html) }
        $best = $null
        foreach ($m in [regex]::Matches($html, 'ZCode-(\d+\.\d+\.\d+)-win-x64\.exe')) {
            $v = $m.Groups[1].Value
            if (-not $best -or ([version]$v -gt [version]$best)) { $best = $v }
        }
        return $best
    } catch {
        return $null
    }
}

# --- 主流程 ---------------------------------------------------------------------
Log '=== zcode setup start ==='
$before = Get-InstalledZcode
$beforeText = if ($before) { $before } else { '未安装' }
Log "当前版本: $beforeText"

Log '查询最新版本 (zcode.z.ai) ...'
$latest = Get-LatestZcode
if (-not $latest) {
    Log 'ERROR: 无法从官网解析最新版本（离线或页面结构变化）'
    exit 1
}
if ($before -and ([version]$before -ge [version]$latest)) {
    Log "已是最新 ($before)，跳过安装"
    Log '=== zcode setup done ==='
    exit 0
}
Log "准备安装/更新: $beforeText -> $latest"

# NSIS 安装器在应用运行中会静默失败，先结束 ZCode 进程（桌面应用，重开无害）
$running = Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue
if ($running) {
    Log 'ZCode 正在运行，先退出以便更新（安装后可重新打开）...'
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

$url = "https://cdn-zcode.z.ai/zcode/electron/releases/$latest/windows-x64/ZCode-$latest-win-x64.exe"
$installer = Join-Path $env:TEMP "ZCode-$latest-win-x64.exe"
Log "下载安装包: $url"
try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $url -OutFile $installer -UseBasicParsing
} catch {
    Log "ERROR: 下载失败 - $($_.Exception.Message)"
    exit 1
}
$size = [math]::Round((Get-Item $installer).Length / 1MB)
Log "下载完成 ($size MB)，静默安装 (/S) ..."
& $installer /S | Out-Null
$rc = $LASTEXITCODE
# NSIS /S 异步解包：进程退出即返回，轮询注册表确认落地（最多 180s）
$after = $null
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 3
    $after = Get-InstalledZcode
    if ($after) { break }
}
Remove-Item $installer -Force -ErrorAction SilentlyContinue
if (-not $after) {
    Log "ERROR: 安装后未在注册表发现 ZCode（installer exit=$rc）；请手动运行安装包确认"
    exit 1
}
Log "完成: $beforeText -> $after"
Log '=== zcode setup done ==='
