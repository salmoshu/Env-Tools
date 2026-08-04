# OpenSSH Server 部署 (Windows)
# - 未安装 OpenSSH 时：优先使用组件目录内的 OpenSSH-Win64*.msi 静默安装，
#   本地没有则从 GitHub 官方发布页下载最新 MSI 后再安装
# - 已安装时直接进入配置流程：备份并改写 sshd_config 端口、生成主机密钥、
#   修复 ACL、注册 sshd 服务、配置防火墙、启动并验证监听
# - 默认端口 2222（本机 WSL 占用 TCP 22，Windows sshd 避让，详见 docs/openssh-notes.md）
# 需要管理员权限运行（由根目录 setup.ps1 统一提权；单独运行时脚本会自行请求 UAC）。
# 用法:
#   setup_openssh.ps1                          # 默认端口 2222
#   setup_openssh.ps1 -Port 2223               # 自定义端口
#   setup_openssh.ps1 -FirewallProfile Any     # 所有网络类型放行（含公用网络，慎用）

[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 2222,

    [ValidateSet('PrivateAndDomain', 'Any')]
    [string]$FirewallProfile = 'PrivateAndDomain'
)

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $dir 'log'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$log = Join-Path $logDir 'setup.log'

$firewallRuleName = 'OpenSSH-Server-In-TCP'
$configDirectory = Join-Path $env:ProgramData 'ssh'
$configPath = Join-Path $configDirectory 'sshd_config'

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
    $line | Out-File $log -Append -Encoding utf8
    Write-Host $line
}

function Find-OpenSshInstallation {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'OpenSSH'),
        (Join-Path $env:WINDIR 'System32\OpenSSH')
    )

    foreach ($directory in $candidates) {
        $sshdPath = Join-Path $directory 'sshd.exe'
        $sshKeygenPath = Join-Path $directory 'ssh-keygen.exe'
        if ((Test-Path -LiteralPath $sshdPath) -and
            (Test-Path -LiteralPath $sshKeygenPath)) {
            return [pscustomobject]@{
                Directory     = $directory
                SshdPath      = $sshdPath
                SshKeygenPath = $sshKeygenPath
                FixAclScript  = Join-Path $directory 'FixHostFilePermissions.ps1'
                DefaultConfig = Join-Path $directory 'sshd_config_default'
            }
        }
    }

    return $null
}

function Install-OpenSshServer {
    # 优先使用组件目录内的 MSI（离线可用、版本可控）
    $msi = Get-ChildItem -LiteralPath $dir -Filter 'OpenSSH-Win64*.msi' -File |
        Sort-Object Name -Descending |
        Select-Object -First 1

    if (-not $msi) {
        Log '组件目录内未找到 MSI，查询 GitHub 最新发布 ...'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $release = Invoke-RestMethod `
            -Uri 'https://api.github.com/repos/PowerShell/Win32-OpenSSH/releases/latest' `
            -Headers @{ 'User-Agent' = 'Env-Tools' }
        $asset = $release.assets |
            Where-Object { $_.name -match '^OpenSSH-Win64.*\.msi$' } |
            Select-Object -First 1
        if (-not $asset) {
            throw '未在 GitHub 最新发布中找到 OpenSSH-Win64 MSI 资产。'
        }
        $msiPath = Join-Path $dir $asset.name
        Log "下载 $($asset.browser_download_url)"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $msiPath
        $msi = Get-Item -LiteralPath $msiPath
    }

    Log "使用 MSI 静默安装 OpenSSH Server: $($msi.Name)"
    $process = Start-Process msiexec.exe -Wait -PassThru -ArgumentList `
        '/i', "`"$($msi.FullName)`"", '/qn', 'ADDLOCAL=Server', '/norestart'
    if ($process.ExitCode -ne 0) {
        throw "MSI 安装失败 (exit=$($process.ExitCode))。"
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Start-ElevatedCopy {
    $argumentList = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', "`"$PSCommandPath`"",
        '-Port', $Port,
        '-FirewallProfile', $FirewallProfile
    )

    $process = Start-Process `
        -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
        -ArgumentList $argumentList `
        -Verb RunAs `
        -Wait `
        -PassThru

    exit $process.ExitCode
}

function Test-PortCanBind {
    param([int]$LocalPort)

    $listeners = [System.Collections.Generic.List[System.Net.Sockets.TcpListener]]::new()
    try {
        $ipv4 = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::Any,
            $LocalPort
        )
        $ipv4.Start()
        $listeners.Add($ipv4)

        $ipv6 = [System.Net.Sockets.TcpListener]::new(
            [System.Net.IPAddress]::IPv6Any,
            $LocalPort
        )
        $ipv6.Server.DualMode = $false
        $ipv6.Start()
        $listeners.Add($ipv6)

        return $true
    }
    catch {
        return $false
    }
    finally {
        foreach ($listener in $listeners) {
            $listener.Stop()
        }
    }
}

function Set-SshdPort {
    param(
        [string]$Path,
        [int]$NewPort
    )

    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $backupPath = "$Path.backup-$timestamp"
    Copy-Item -LiteralPath $Path -Destination $backupPath

    $lines = Get-Content -LiteralPath $Path
    $portConfigured = $false
    $updatedLines = foreach ($line in $lines) {
        if (-not $portConfigured -and $line -match '^\s*#?\s*Port\s+\d+\s*$') {
            "Port $NewPort"
            $portConfigured = $true
        }
        else {
            $line
        }
    }

    if (-not $portConfigured) {
        $updatedLines = @("Port $NewPort") + $updatedLines
    }

    $updatedLines | Set-Content -LiteralPath $Path -Encoding ascii
    return $backupPath
}

function Repair-OpenSshPermissions {
    param([string]$FixAclScriptPath)

    if (Test-Path -LiteralPath $FixAclScriptPath) {
        & $FixAclScriptPath -Confirm:$false
        return
    }

    # The Windows optional-feature build does not include the repair script.
    # Restrict the configuration and private host keys to SYSTEM and Administrators.
    $privateFiles = @($configPath)
    $privateFiles += Get-ChildItem `
        -LiteralPath $configDirectory `
        -Filter 'ssh_host_*_key' `
        -File `
        -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName

    foreach ($file in $privateFiles) {
        & icacls.exe $file /inheritance:r | Out-Null
        & icacls.exe $file /grant:r '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "无法修复 ACL：$file"
        }
    }
}

function Ensure-SshdService {
    param([string]$SshdExecutable)

    $service = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
    if ($null -eq $service) {
        New-Service `
            -Name 'sshd' `
            -BinaryPathName "`"$SshdExecutable`"" `
            -DisplayName 'OpenSSH SSH Server' `
            -Description 'OpenSSH SSH Server' `
            -StartupType Automatic | Out-Null
    }
    else {
        & sc.exe config sshd binPath= "`"$SshdExecutable`"" start= auto | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw '无法更新 sshd 服务配置。'
        }
    }

    # Avoid a zero-delay restart loop if startup ever fails.
    & sc.exe failure sshd reset= 86400 actions= restart/60000 | Out-Null
}

function Set-OpenSshFirewallRule {
    param(
        [int]$LocalPort,
        [string]$ProfileMode
    )

    $profiles = if ($ProfileMode -eq 'Any') {
        'Any'
    }
    else {
        'Private,Domain'
    }

    $existingRule = Get-NetFirewallRule `
        -Name $firewallRuleName `
        -ErrorAction SilentlyContinue

    if ($null -eq $existingRule) {
        New-NetFirewallRule `
            -Name $firewallRuleName `
            -DisplayName "OpenSSH Server (sshd) - TCP $LocalPort" `
            -Enabled True `
            -Direction Inbound `
            -Protocol TCP `
            -Action Allow `
            -LocalPort $LocalPort `
            -Profile $profiles | Out-Null
    }
    else {
        Set-NetFirewallRule `
            -Name $firewallRuleName `
            -NewDisplayName "OpenSSH Server (sshd) - TCP $LocalPort" `
            -Enabled True `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $LocalPort `
            -Profile $profiles | Out-Null
    }
}

Log '=== openssh setup start ==='
Log "目标端口：$Port"

if (-not (Test-IsAdministrator)) {
    Log '请求管理员权限 (UAC) ...'
    Start-ElevatedCopy
}

try {
    $openSsh = Find-OpenSshInstallation
    if ($null -eq $openSsh) {
        Log '未检测到 OpenSSH Server，开始安装 ...'
        Install-OpenSshServer
        $openSsh = Find-OpenSshInstallation
        if ($null -eq $openSsh) {
            throw '安装完成后仍未检测到 OpenSSH Server。'
        }
        Log "OpenSSH 安装完成：$($openSsh.Directory)"
    }
    else {
        Log "检测到 OpenSSH：$($openSsh.Directory)"
    }

    $service = Get-Service -Name 'sshd' -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Log '停止现有 sshd 服务'
        Stop-Service -Name 'sshd' -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
    }

    Log "检查端口 $Port 是否可用"
    if (-not (Test-PortCanBind -LocalPort $Port)) {
        throw "端口 $Port 已被其他程序、WSL 或 Docker 占用。请使用 -Port 指定其他端口。"
    }

    Log '准备 OpenSSH 配置和主机密钥'
    New-Item -ItemType Directory -Path $configDirectory -Force | Out-Null

    if (-not (Test-Path -LiteralPath $configPath)) {
        if (-not (Test-Path -LiteralPath $openSsh.DefaultConfig)) {
            throw '找不到 sshd_config_default。请重新安装 OpenSSH Server。'
        }
        Copy-Item -LiteralPath $openSsh.DefaultConfig -Destination $configPath
    }

    & $openSsh.SshKeygenPath -A
    if ($LASTEXITCODE -ne 0) {
        throw '生成 OpenSSH 主机密钥失败。'
    }

    Log "配置 SSH 端口为 $Port"
    $configBackup = Set-SshdPort -Path $configPath -NewPort $Port

    Log '修复配置与主机密钥权限'
    Repair-OpenSshPermissions -FixAclScriptPath $openSsh.FixAclScript

    Log '验证 sshd 配置'
    & $openSsh.SshdPath -t
    if ($LASTEXITCODE -ne 0) {
        throw "sshd 配置验证失败。备份文件：$configBackup"
    }

    Log '注册并配置 sshd 服务'
    Ensure-SshdService -SshdExecutable $openSsh.SshdPath

    Log '配置 Windows 防火墙'
    Set-OpenSshFirewallRule `
        -LocalPort $Port `
        -ProfileMode $FirewallProfile

    Log '启动 sshd'
    Set-Service -Name 'sshd' -StartupType Automatic
    Start-Service -Name 'sshd'
    $service = Get-Service -Name 'sshd'
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(15))

    Start-Sleep -Seconds 2
    $listener = Get-NetTCPConnection `
        -LocalPort $Port `
        -State Listen `
        -ErrorAction SilentlyContinue
    if (-not $listener) {
        throw "sshd 已启动，但没有监听端口 $Port。"
    }

    Log '=== openssh setup done ==='

    Write-Host ''
    Write-Host '部署成功。' -ForegroundColor Green
    Write-Host "服务状态：$((Get-Service sshd).Status)"
    Write-Host '启动类型：Automatic'
    Write-Host "监听端口：$Port"
    Write-Host "配置备份：$configBackup"
    Write-Host ''
    Write-Host '本机测试：'
    Write-Host "ssh -p $Port $env:USERNAME@localhost" -ForegroundColor Yellow

    $addresses = Get-NetIPAddress `
        -AddressFamily IPv4 `
        -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -notlike '127.*' -and
            $_.PrefixOrigin -ne 'WellKnown'
        }

    if ($addresses) {
        Write-Host ''
        Write-Host '局域网连接示例：'
        foreach ($address in $addresses) {
            Write-Host "ssh -p $Port $env:USERNAME@$($address.IPAddress)"
        }
    }

    $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue
    $publicProfiles = @($profiles | Where-Object NetworkCategory -eq 'Public')
    if ($FirewallProfile -eq 'PrivateAndDomain' -and $publicProfiles.Count -gt 0) {
        Write-Warning '检测到公用网络。当前防火墙规则不会允许该网络上的远程 SSH。'
        Write-Host '确认是可信局域网后，可在管理员 PowerShell 中执行：'
        foreach ($profile in $publicProfiles) {
            Write-Host "Set-NetConnectionProfile -InterfaceAlias `"$($profile.InterfaceAlias)`" -NetworkCategory Private"
        }
    }

    exit 0
}
catch {
    Set-Service -Name 'sshd' -StartupType Disabled -ErrorAction SilentlyContinue
    Stop-Service -Name 'sshd' -Force -ErrorAction SilentlyContinue
    Log "部署失败：$($_.Exception.Message)"
    Log '为避免服务重启循环，sshd 已被停止并暂时禁用。'
    Log '=== openssh setup aborted ==='
    exit 1
}
