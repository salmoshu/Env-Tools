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

# v0.7.25 黑屏修复（一）：快照备份是 gitignore 的本机目录，换机/清盘后会缺失。
# 原逻辑无条件 robocopy 快照 → 源不存在 exit 16 → exit 1 中止——而此时
# kwallpaper 已被杀掉，再也没人把它拉起来，桌面一直黑屏。
# 现在先把"本次部署的形态"定下来：没快照但有已安装副本 → 跳过版本还原继续跑；
# 两者都没有 → 在杀任何进程之前就退出（无需恢复现场）。
$hasSnapshot = Test-Path -LiteralPath (Join-Path $backup 'kwallpaper.exe') -PathType Leaf
$hasInstalled = Test-Path -LiteralPath (Join-Path $target 'kwallpaper.exe') -PathType Leaf
if (-not $hasSnapshot -and -not $hasInstalled) {
    Log 'ERROR: no snapshot backup and no installed kwallpaper found, abort (nothing was stopped)'
    Log '=== setup aborted ==='
    exit 1
}

Get-Process -Name 'kdesk*','kwallpaper*','cmlive','kvipgui','infocenter','keyemain' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
try { Stop-KdeskService } catch { Log "service stop: $($_.Exception.Message)" }

# Restore the 33_1 snapshot into the target. For a portable deployment this also
# performs the initial copy of the backup into the portable directory.
New-Item -ItemType Directory -Path $target -Force | Out-Null
$restoreFailed = $false
if ($hasSnapshot) {
    $restoreCode = Invoke-KdeskSnapshotRestore -Backup $backup -Target $target -LogFile $log
    Log "snapshot restore robocopy exit=$restoreCode (0-7 = success)"
    if ($restoreCode -gt 7) {
        # v0.7.25 黑屏修复（二）：还原失败不再中止。中止路径发生在杀掉壁纸进程
        # 之后，服务与 kwallpaper 永不重启，桌面必然黑屏。还原失败只意味着本次
        # 跳过"版本回退"，已安装文件保持原样，后续照常拉起桌面。
        $restoreFailed = $true
        Log 'WARNING: snapshot restore failed; keeping existing install files and continuing'
    }
} else {
    Log 'snapshot backup missing; skipping version restore (installed copy left as-is)'
}

# (re)build the snapshot from the current install dir. When the snapshot was
# missing this re-establishes it from the intact install (self-heal), so future
# logons get the normal restore path again. Skipped after a failed restore —
# the target may be a half-copied mix and must not become the new snapshot.
if (-not $restoreFailed) {
    robocopy $target $backup /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    Log "backup robocopy exit=$LASTEXITCODE (0-7 = success)"
}

# 持久屏蔽桌面助手（改名 + IFEO），放在快照刷新之后，保证还原/刷新都不会复活它
Disable-KdeskAssistant -Target $target -Backup $backup -LogFile $log

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
# Runs THIS full setup (equivalent to `scripts/setup.ps1 kdesk`) at every logon, so each
# boot gets snapshot restore + update block + optimizer, not just the light deploy.
# 注册要点（三者缺一都会「静默无效」）：
# 1. 用 -Command "& '<path>'" 而非 -File：任务启动链路上 powershell -File 遇
#    中文路径会静默不执行且退出码为 0（-Command 内联同路径则正常，已实测）；
# 2. Register-ScheduledTask 显式 -AllowStartIfOnBatteries：schtasks /Create 的
#    默认是电池供电不启动，笔记本拔电后登录任务全部静默跳过；
# 3. -RunLevel Highest 等价原 /RL HIGHEST，免 UAC。
$setupScript = $PSCommandPath
try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command "& ''' + $setupScript + '''"')
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
        -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Days 3)
    Register-ScheduledTask -TaskName 'KdeskAutoDeploy' -Action $action -Trigger $trigger `
        -Principal $principal -Settings $settings -Force | Out-Null
    Log "logon task registered (runs via -Command: $setupScript)"
} catch {
    Log "logon task register failed: $($_.Exception.Message)"
}

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

# v0.7.25 黑屏修复（三）：最终防线——优化器可能把 kwallpaper 补丁失败/带崩，
# 结束前确认它还活着；不在就再拉一次。到这一步无论结果如何都不再退出，
# 保证"杀掉的壁纸进程一定有人负责拉起"。
if (-not (Get-Process -Name 'kwallpaper' -ErrorAction SilentlyContinue)) {
    Log 'kwallpaper not running after optimizer; starting it again'
    Start-Process -FilePath (Join-Path $target 'kwallpaper.exe') -ErrorAction SilentlyContinue
    $retryWaited = Wait-KdeskWallpaperReady -TimeoutSeconds 30
    if ($retryWaited -ge 0) {
        Log "kwallpaper UI ready after retry (waited ${retryWaited}s)"
    } else {
        Log 'WARNING: kwallpaper still not detected after retry'
    }
}
Log '=== setup done ==='
