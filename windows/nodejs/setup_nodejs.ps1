# Node.js 环境部署 (Windows)
# - 已安装 Node.js 时直接跳过
# - 优先使用 winget 安装 OpenJS.NodeJS.LTS
# - 无 winget 时回退为便携版：下载官方 LTS zip 解压到 <project>\runtime 并写入用户 PATH
# 需要管理员权限运行（由根目录 setup.ps1 统一提权）。

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$envtoolsVersionFile = Join-Path $dir '..\..\VERSION'
if (Test-Path $envtoolsVersionFile) {
    $envtoolsVersion = Get-Content $envtoolsVersionFile -TotalCount 1 -ErrorAction SilentlyContinue
    if ($envtoolsVersion) { Write-Host "Env-Tools v$($envtoolsVersion.Trim())" }
}

$logDir = Join-Path $dir 'log'
$runtimeDir = Join-Path $dir 'runtime'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'setup.log'

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    $line | Out-File $log -Append -Encoding utf8
    Write-Host $line
}

# 让 winget 新装的 node 在当前会话中立即可用
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Get-NodeVersion {
    try {
        Update-SessionPath
        return (& node --version 2>$null)
    } catch {
        return $null
    }
}

Log '=== nodejs setup start ==='

$version = Get-NodeVersion
if ($version) {
    Log "node 已安装 ($version)，跳过部署"
    Log '=== nodejs setup done ==='
    exit 0
}

# --- 方案一：winget ---------------------------------------------------------
$winget = Get-Command winget -ErrorAction SilentlyContinue
if ($winget) {
    Log '使用 winget 安装 OpenJS.NodeJS.LTS ...'
    & winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
    Log "winget exit=$LASTEXITCODE"
    $version = Get-NodeVersion
    if ($version) {
        Log "node 安装完成 ($version)"
        Log '=== nodejs setup done ==='
        exit 0
    }
    Log 'winget 安装后仍未检测到 node，回退到便携版部署'
} else {
    Log '未找到 winget，使用便携版部署'
}

# --- 方案二：官方 LTS 便携版 -------------------------------------------------
try {
    Log '查询 nodejs.org 最新 LTS 版本 ...'
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    if (-not $lts) { throw 'index.json 中没有 LTS 版本' }
    $ver = $lts.version
    $zipName = "node-$ver-win-x64.zip"
    $zipPath = Join-Path $dir $zipName
    $url = "https://nodejs.org/dist/$ver/$zipName"

    Log "下载 $url"
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing

    if (Test-Path $runtimeDir) { Remove-Item $runtimeDir -Recurse -Force }
    Log "解压到 $runtimeDir"
    Expand-Archive -Path $zipPath -DestinationPath $dir -Force
    Rename-Item -Path (Join-Path $dir "node-$ver-win-x64") -NewName 'runtime'
    Remove-Item $zipPath -Force

    # 写入用户 PATH
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($userPath -split ';') -notcontains $runtimeDir) {
        [Environment]::SetEnvironmentVariable('Path', "$userPath;$runtimeDir", 'User')
        Log "已将 $runtimeDir 写入用户 PATH（新开的终端生效）"
    }
    $env:Path = "$env:Path;$runtimeDir"

    $version = Get-NodeVersion
    if (-not $version) { throw '便携版部署后仍无法运行 node' }
    Log "node 便携版部署完成 ($version)，位置: $runtimeDir"
    Log '=== nodejs setup done ==='
    exit 0
} catch {
    Log "ERROR: 便携版部署失败 - $($_.Exception.Message)"
    Log '=== nodejs setup aborted ==='
    exit 1
}
