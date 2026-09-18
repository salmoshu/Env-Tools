# One-time setup (self-elevating). Run this on any machine:
# - uses an existing kdesk installation when one is found
# - otherwise runs the bundled official installer (kdesk_33_1_setup.exe);
#   the first install establishes kdesk_33_1_backup, later runs maintain it
# - deploys to a portable directory if needed
#   (largest non-system fixed drive preferred, ProgramData as fallback)
# - registers the kdeskcore service, registry entries and shortcuts for portable deployments
# - redirects the wallpaper cache into <project>\wallpaper_cache and migrates any existing cache
# - restores the 33_1 snapshot (downgrades auto-updated installs)
# - refreshes the snapshot backup from the current install dir
# - blocks auto-update (upgrade hosts in hosts file + IFEO on cmlive.exe)
# - registers the elevated logon task (replaces Run-key autostart) that re-runs
#   THIS setup at every logon, so every boot gets a full setup pass
# - restarts kwallpaper and runs the optimizer once the UI is up

# self-elevate
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
    exit
}

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

$envtoolsVersionFile = Join-Path $dir '..\..\VERSION'
if (Test-Path $envtoolsVersionFile) {
    $envtoolsVersion = Get-Content $envtoolsVersionFile -TotalCount 1 -ErrorAction SilentlyContinue
    if ($envtoolsVersion) { Write-Host "Env-Tools v$($envtoolsVersion.Trim())" }
}

$scriptDir = Join-Path $dir 'scripts'
$logDir = Join-Path $dir 'log'
$stateDir = Join-Path $scriptDir 'data'
$log = Join-Path $logDir 'setup.log'
$backup = Join-Path $dir 'kdesk_33_1_backup'
$pathCache = Join-Path $stateDir 'kdesk_install_path.txt'

New-Item -ItemType Directory -Path $logDir,$stateDir -Force | Out-Null

. (Join-Path $scriptDir 'kdesk_locator.ps1')
. (Join-Path $scriptDir 'kdesk_integration.ps1')

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File $log -Append -Encoding utf8
}

Log '=== setup start ==='

$target = Find-KdeskDir -StateFile $pathCache -ExcludedPath $backup
$portable = $false
if ([string]::IsNullOrWhiteSpace($target)) {
    if (-not (Test-Path (Join-Path $backup 'kwallpaper.exe'))) {
        # 首次使用：本机既无安装也没有快照备份时，运行随库分发的官方安装包。
        # 安装完成后重新检测，继续走下面的快照建立与维护流程。
        $installer = Join-Path $dir 'kdesk_33_1_setup.exe'
        if (-not (Test-Path $installer)) {
            Log 'ERROR: kdesk not installed, backup snapshot missing and bundled installer not found'
            Log '=== setup aborted ==='
            exit 1
        }
        Log "first-time setup: running bundled official installer: $installer"
        Write-Host 'First-time setup: launching the official kdesk installer. Please finish the installation wizard; this setup continues afterwards.'
        $proc = Start-Process -FilePath $installer -Wait -PassThru
        Log "installer exited with code $($proc.ExitCode)"
        $target = Find-KdeskDir -StateFile $pathCache -ExcludedPath $backup
        if ([string]::IsNullOrWhiteSpace($target)) {
            Log 'ERROR: kdesk still not detected after the installer ran'
            Log '=== setup aborted ==='
            exit 1
        }
        Log "kdesk dir after installer: $target"
    } else {
        $target = Get-KdeskPortableTarget
        $portable = $true
        Log "no installed kdesk found; deploying portable copy to: $target"
    }
} else {
    Log "kdesk dir: $target"
}

$target | Set-Content -LiteralPath $pathCache -Encoding UTF8

Get-Process -Name 'kdesk*','kwallpaper*','cmlive','kvipgui','infocenter','keyemain' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
try { Stop-KdeskService } catch { Log "service stop: $($_.Exception.Message)" }

# Restore the 33_1 snapshot into the target. For a portable deployment this also
# performs the initial copy of the backup into the portable directory.
New-Item -ItemType Directory -Path $target -Force | Out-Null
$restoreCode = Invoke-KdeskSnapshotRestore -Backup $backup -Target $target -LogFile $log
Log "snapshot restore robocopy exit=$restoreCode (0-7 = success)"
if ($restoreCode -gt 7) {
    Log 'ERROR: unable to copy the snapshot into the target dir'
    Log '=== setup aborted ==='
    exit 1
}

# (re)build the snapshot from the current install dir
robocopy $target $backup /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
Log "backup robocopy exit=$LASTEXITCODE (0-7 = success)"

# block silent auto-update (hosts entries + IFEO on cmlive.exe), re-applied on every run
Disable-KdeskAutoUpdate -LogFile $log

if ($portable) {
    try {
        Install-KdeskIntegration -Target $target
        Log 'portable integration registered (service, registry, shortcuts)'
    } catch {
        Log "INTEGRATION ERROR: $($_.Exception.Message)"
    }
} else {
    # restart the core service stopped above for the file restore
    Start-Service -Name 'kdeskcore' -ErrorAction SilentlyContinue
}

# remove the old non-elevated Run-key autostart if present
Remove-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'KdeskAutoDeploy' -ErrorAction SilentlyContinue

# elevated scheduled task at logon: no UAC prompts ever again.
# Runs THIS full setup (equivalent to `setup.ps1 kdesk`) at every logon, so each
# boot gets snapshot restore + update block + optimizer, not just the light deploy.
$setupScript = $PSCommandPath
schtasks /Create /TN 'KdeskAutoDeploy' /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$setupScript`"" /SC ONLOGON /RL HIGHEST /F
Log "schtasks exit=$LASTEXITCODE (task runs: $setupScript)"

# redirect the wallpaper cache into the project directory and migrate existing data
try {
    $cacheDir = Set-KdeskWallpaperCache -ProjectRoot $dir -Target $target
    Log "wallpaper cache dir: $cacheDir"
} catch {
    Log "CACHE ERROR: $($_.Exception.Message)"
}

# start kwallpaper and run the optimizer once the UI is actually up
Start-Process -FilePath (Join-Path $target 'kwallpaper.exe') -ErrorAction SilentlyContinue
$waited = Wait-KdeskWallpaperReady -TimeoutSeconds 60
if ($waited -ge 0) {
    Log "kwallpaper UI ready (waited ${waited}s)"
} else {
    Log 'WARNING: kwallpaper UI not detected after 60s, running optimizer anyway'
}
Start-Sleep -Seconds 10   # let the app finish initializing

Invoke-KdeskOptimizer -Optimizer (Get-KdeskOptimizer -Dir $dir) -LogFile $log
Log '=== setup done ==='
