# AI CLI 工具安装/更新 (Windows)
# 用法:
#   setup_ai_tools.ps1                  # 安装/更新全部工具
#   setup_ai_tools.ps1 --codex          # 仅 codex
#   setup_ai_tools.ps1 --kimi --codex   # 指定多个
#   setup_ai_tools.ps1 --all            # 全部工具
# 依赖 nodejs（npm），缺失时自动调用 ..\nodejs\setup_nodejs.ps1 安装。

[CmdletBinding()]
param(
    [switch]$All,
    [switch]$Codex,
    [switch]$Kimi,
    [switch]$Codebuddy
)

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $dir 'log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'setup.log'

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    $line | Out-File $log -Append -Encoding utf8
    Write-Host $line
}

# 让新装的 node/npm 在当前会话中立即可用
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Test-Npm {
    Update-SessionPath
    return [bool](Get-Command npm -ErrorAction SilentlyContinue)
}

function Get-ToolVersion($cmd) {
    try {
        return (& $cmd --version 2>$null | Select-Object -First 1)
    } catch {
        return $null
    }
}

# 从 --version 输出中提取 x.y.z（各 CLI 输出格式不一，如 "codex-cli 0.25.0"）
function Get-Semver($text) {
    if ($text -match '(\d+\.\d+\.\d+)') { return $Matches[1] }
    return $null
}

# npm registry 上该包的最新版本；查询失败（离线等）返回空，按"需要安装"兜底
function Get-LatestNpmVersion($package) {
    try {
        return ((& npm view $package version --loglevel=error 2>$null | Select-Object -Last 1) -replace '\s', '')
    } catch {
        return $null
    }
}

$tools = [ordered]@{
    codex     = @{ Package = '@openai/codex';            Command = 'codex' }
    kimi      = @{ Package = '@moonshot-ai/kimi-code';   Command = 'kimi' }
    codebuddy = @{ Package = '@tencent-ai/codebuddy-code'; Command = 'codebuddy' }
}

$targets = @()
if ($Codex)     { $targets += 'codex' }
if ($Kimi)      { $targets += 'kimi' }
if ($Codebuddy) { $targets += 'codebuddy' }
if ($All -or $targets.Count -eq 0) { $targets = @($tools.Keys) }

Log "=== ai-tools setup start (targets: $($targets -join ', ')) ==="

# --- 依赖：nodejs / npm -------------------------------------------------------
if (-not (Test-Npm)) {
    Log '未检测到 node/npm，先部署 nodejs ...'
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir '..\nodejs\setup_nodejs.ps1')
    if ($LASTEXITCODE -ne 0) {
        Log "ERROR: nodejs 部署失败 (exit=$LASTEXITCODE)"
        exit 1
    }
    if (-not (Test-Npm)) {
        Log 'ERROR: nodejs 部署后仍无法找到 npm'
        exit 1
    }
}
Log "npm 就绪: $(Get-ToolVersion 'node') (node)"

# --- 安装/更新 ------------------------------------------------------------------
$failed = @()
foreach ($name in $targets) {
    $t = $tools[$name]
    $before = Get-ToolVersion $t.Command
    $beforeText = if ($before) { $before } else { '未安装' }
    $localVer = Get-Semver $before
    $latest = Get-LatestNpmVersion $t.Package
    if ($localVer -and $latest -and ($localVer -eq $latest)) {
        Log "$name 已是最新 ($localVer)，跳过安装"
        continue
    }
    Log "安装/更新 $name ($($t.Package))，当前版本: $beforeText"
    & npm install -g "$($t.Package)@latest" --loglevel=error
    if ($LASTEXITCODE -ne 0) {
        Log "ERROR: $name 安装失败 (npm exit=$LASTEXITCODE)"
        $failed += $name
        continue
    }
    Update-SessionPath
    $after = Get-ToolVersion $t.Command
    $afterText = if ($after) { $after } else { '未知' }
    Log "$name 完成: $beforeText -> $afterText"
}

if ($failed.Count -gt 0) {
    Log "=== ai-tools setup done，失败: $($failed -join ', ') ==="
    exit 1
}
Log '=== ai-tools setup done ==='
