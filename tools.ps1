# Env-Tools 已部署应用的统一操作入口 (Windows)
# 功能与 Linux 的 tools.sh 一致；Linux 请使用 tools.sh。
#
# 用法:
#   tools.ps1 ai-tools --usage [usage 参数...]
#   tools.ps1 openssh --status
#
# usage monitor 随本项目分发（linux/ai-tools/usage-monitor，跨平台），不依赖外部项目。

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Application,
    # 透传给子命令的参数
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Show-Usage {
    Write-Host @'
用法: tools.ps1 <应用> <操作> [参数...]

应用与操作:
  ai-tools --usage [参数...]  查看 Kimi / Codex / CodeBuddy 余量
  openssh --status            查看 sshd 服务状态与监听端口

示例:
  tools.ps1 ai-tools --usage
  tools.ps1 ai-tools --usage --provider codex
  tools.ps1 ai-tools --usage --json
  tools.ps1 openssh --status
'@
}

function Die([string]$Message) {
    [Console]::Error.WriteLine("ERROR: $Message")
    exit 1
}

function Find-Python {
    # 依次尝试 py 启动器 / python / python3，用 --version 验证可用
    # （排除 Microsoft Store 的 python.exe 占位 shim）
    foreach ($spec in @(@('py', '-3'), @('python'), @('python3'))) {
        $exe = $spec[0]
        $pre = @($spec | Select-Object -Skip 1)
        if (Get-Command $exe -ErrorAction SilentlyContinue) {
            & $exe @pre --version *> $null
            if ($LASTEXITCODE -eq 0) {
                return @{ Exe = $exe; Pre = $pre }
            }
        }
    }
    return $null
}

function Invoke-AiTools([string[]]$OpArgs) {
    $operation = if ($OpArgs.Count -gt 0) { $OpArgs[0] } else { '' }
    $extra = @($OpArgs | Select-Object -Skip 1)

    switch ($operation) {
        '--usage' {
            $monitor = Join-Path $root 'linux\ai-tools\usage-monitor\usage_monitor.py'
            if (-not (Test-Path $monitor)) { Die "余量监控程序不存在: $monitor" }
            $py = Find-Python
            if (-not $py) { Die '未找到 python，无法运行余量监控（可安装 python.org 的 Python 3）。' }
            # 与 tools.sh 保持一致：无额外参数时默认持续监控
            if ($extra.Count -eq 0) { $extra = @('--watch') }
            & $py.Exe @($py.Pre) $monitor @extra
            exit $LASTEXITCODE
        }
        { $_ -in @('--help', '-h', 'help', '') } { Show-Usage }
        default { Die "ai-tools 不支持操作 '$operation'（当前支持: --usage）" }
    }
}

function Invoke-OpenSsh([string[]]$OpArgs) {
    $operation = if ($OpArgs.Count -gt 0) { $OpArgs[0] } else { '' }

    switch ($operation) {
        '--status' {
            $sshd = $null
            foreach ($p in @("$env:ProgramFiles\OpenSSH\sshd.exe", "$env:WINDIR\System32\OpenSSH\sshd.exe")) {
                if (Test-Path $p) { $sshd = $p; break }
            }
            if (-not $sshd) {
                $cmd = Get-Command sshd.exe -ErrorAction SilentlyContinue
                if ($cmd) { $sshd = $cmd.Source }
            }
            if (-not $sshd) {
                Write-Host 'sshd: 未安装（可用 setup.ps1 openssh 部署）'
                exit 1
            }
            $version = (Get-Item $sshd).VersionInfo.ProductVersion
            if (-not $version) { $version = '版本未知' }
            Write-Host "sshd: $sshd ($version)"

            $svc = Get-Service sshd -ErrorAction SilentlyContinue
            if ($svc) {
                Write-Host "服务: $($svc.Status) / 启动类型 $($svc.StartType)"
            } else {
                Write-Host '服务: 未注册'
            }

            Write-Host '监听端口:'
            $pids = @((Get-Process sshd -ErrorAction SilentlyContinue).Id)
            $listeners = @()
            if ($pids.Count -gt 0) {
                $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $pids -ErrorAction SilentlyContinue)
            }
            if ($listeners.Count -gt 0) {
                $listeners | Sort-Object LocalPort | ForEach-Object {
                    Write-Host "  $($_.LocalAddress):$($_.LocalPort)"
                }
                $port = ($listeners | Select-Object -First 1).LocalPort
                Write-Host "连接示例: ssh -p $port $env:USERNAME@<本机IP>"
            } else {
                Write-Host '  （未检测到 sshd 监听端口；非管理员运行时进程信息可能不可见）'
            }
        }
        { $_ -in @('--help', '-h', 'help', '') } { Show-Usage }
        default { Die "openssh 不支持操作 '$operation'（当前支持: --status）" }
    }
}

if (-not $Application) {
    Show-Usage
    exit 0
}

switch ($Application) {
    'ai-tools' { Invoke-AiTools $Rest }
    'openssh'  { Invoke-OpenSsh $Rest }
    { $_ -in @('--help', '-h', 'help') } { Show-Usage }
    default { Die "未知应用 '$Application'（当前支持: ai-tools / openssh）" }
}
