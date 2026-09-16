# Env-Tools 桌面应用（Windows）启动脚本
#
# v0.6.0 起 Windows 原生模式开箱即用：配额引擎脚本与分析 agent 都随包分发
# （包内内嵌独立 Python，无需安装）。WSL 变为可选目标——Target 选择器里连接
# 即可自举；若希望配额数据直接由 WSL 侧引擎承载，加 -UseWsl。
#
# 用法：
#   .\Start-EnvTools.ps1                      # 原生模式（推荐）
#   .\Start-EnvTools.ps1 -UseWsl              # 配额数据由 WSL 侧引擎读取
#   .\Start-EnvTools.ps1 -UseWsl -Distro Ubuntu-22.04 -WslRepo "~/my/Env-Tools"

param(
    [switch]$UseWsl,
    [string]$Distro = "",
    [string]$WslRepo = "~/Env-Tools"
)

$ErrorActionPreference = "Stop"

$exe = Join-Path $PSScriptRoot "Env-Tools.exe"
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Write-Error "Env-Tools.exe not found next to this script."
    exit 1
}

if (-not $UseWsl) {
    Write-Host "Starting Env-Tools (native mode: bundled python + local agent)"
    Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot
    exit 0
}

if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    Write-Error "WSL is not installed. Use native mode (without -UseWsl) or install WSL."
    exit 1
}

if (-not $Distro) {
    $list = (wsl.exe --list --quiet 2>$null) -replace "`0", "" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if (-not $list) {
        Write-Error "No WSL distro found. Deploy the Env-Tools repo first (run setup.sh inside a distro)."
        exit 1
    }
    $Distro = $list | Select-Object -First 1
}

# 展开 WSL 侧的 ~（wslpath 不会展开带引号的 tilde，需先用 bash 取 $HOME）
$wslHome = (wsl.exe -d $Distro --exec bash -c 'echo $HOME' | Out-String).Trim() -replace "`0", ""
if ($WslRepo.StartsWith("~")) {
    $WslRepo = $wslHome + $WslRepo.Substring(1)
}
$WslRepo = $WslRepo.TrimEnd('/')

# 解析并校验数据引擎脚本确实存在（校验失败给出明确指引，而不是启动后配额一直为空）
$script = (wsl.exe -d $Distro --exec bash -c "wslpath -a -u '$WslRepo/linux/ai-tools/usage-monitor/usage_monitor.py' 2>/dev/null" |
    Out-String).Trim() -replace "`0", ""
if (-not $script) {
    Write-Error "Cannot resolve the Env-Tools repo path inside '$Distro'. Deploy the repo (setup.sh) or pass -WslRepo."
    exit 1
}
$exists = (wsl.exe -d $Distro --exec bash -c "test -f '$script' && echo yes || echo no" | Out-String).Trim() -replace "`0", ""
if ($exists -ne "yes") {
    Write-Error "usage_monitor.py not found at '$script' in '$Distro'. Is the Env-Tools repo deployed there?"
    exit 1
}

$env:AI_USAGE_MONITOR_BACKEND = "wsl"
$env:AI_USAGE_MONITOR_WSL_DISTRO = $Distro
$env:AI_USAGE_MONITOR_WSL_SCRIPT = $script

Write-Host "Starting Env-Tools (WSL mode: distro=$Distro, script=$script)"
Start-Process -FilePath $exe -WorkingDirectory $PSScriptRoot
