# Env-Tools 已部署应用的统一操作入口 (Windows)
# 功能与 Linux 的 tools.sh 一致；Linux 请使用 tools.sh。
#
# 用法:
#   tools.ps1 openssh --status

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Application,
    # 透传给子命令的参数
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$envtoolsVersionFile = Join-Path $root 'VERSION'
if (Test-Path $envtoolsVersionFile) {
    $envtoolsVersion = Get-Content $envtoolsVersionFile -TotalCount 1 -ErrorAction SilentlyContinue
    if ($envtoolsVersion) { Write-Host "Env-Tools v$($envtoolsVersion.Trim())" }
}

function Show-Usage {
    Write-Host @'
用法: tools.ps1 <应用> <操作> [参数...]

应用与操作:
  openssh --status            查看 sshd 服务状态与监听端口

示例:
  tools.ps1 openssh --status
'@
}

function Die([string]$Message) {
    [Console]::Error.WriteLine("ERROR: $Message")
    exit 1
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
    'openssh'  { Invoke-OpenSsh $Rest }
    { $_ -in @('--help', '-h', 'help') } { Show-Usage }
    default { Die "未知应用 '$Application'（当前支持: openssh）" }
}
