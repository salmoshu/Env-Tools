# Runs at every logon (scheduled task, highest privileges):
# 1. locate the kdesk dir (portable-deploy from the backup if nothing is installed)
# 2. stop kdesk and the kdeskcore service (the service locks files in the target dir)
# 3. restore the 33_1 snapshot (defeats auto-update)
# 4. restart the service, start kwallpaper and wait until its UI is really up
# 5. keep the wallpaper cache pointed at <project>\wallpaper_cache (self-heals if the project moved)
# 6. run the optimizer (only after the wallpaper UI is ready)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$dir       = Split-Path -Parent $scriptDir
$backup    = Join-Path $dir 'kdesk_33_1_backup'
$optimizer = Join-Path $dir '软件性能优化.exe'
$logDir    = Join-Path $dir 'log'
$stateDir  = Join-Path $scriptDir 'data'
$log       = Join-Path $logDir 'deploy.log'
$pathCache = Join-Path $stateDir 'kdesk_install_path.txt'

New-Item -ItemType Directory -Path $logDir,$stateDir -Force | Out-Null

. (Join-Path $scriptDir 'kdesk_locator.ps1')
. (Join-Path $scriptDir 'kdesk_integration.ps1')

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg" | Out-File $log -Append -Encoding utf8
}

Log '=== deploy start ==='

$target = Find-KdeskDir -StateFile $pathCache -ExcludedPath $backup
if ([string]::IsNullOrWhiteSpace($target)) {
    if (-not (Test-Path (Join-Path $backup 'kwallpaper.exe'))) {
        Log 'ERROR: kdesk not found and no backup snapshot available, abort'
        Log '=== deploy finished ==='
        exit 1
    }
    $target = Get-KdeskPortableTarget
    Log "kdesk not installed; deploying portable copy to: $target"
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    robocopy $backup $target /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
    Log "portable deploy robocopy exit=$LASTEXITCODE (0-7 = success)"
    if ($LASTEXITCODE -le 7) {
        try {
            Install-KdeskIntegration -Target $target
            Log 'portable integration registered (service, registry, shortcuts)'
        } catch {
            Log "INTEGRATION ERROR: $($_.Exception.Message)"
        }
    }
}
Log "kdesk dir: $target"

# Refresh the cache if the installation was moved and rediscovered.
$target | Set-Content -LiteralPath $pathCache -Encoding UTF8

Get-Process -Name 'kdesk*','kwallpaper*','cmlive','kvipgui','infocenter','keyemain' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
try { Stop-KdeskService } catch { Log "service stop: $($_.Exception.Message)" }

robocopy $backup $target /MIR /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
Log "restore robocopy exit=$LASTEXITCODE (0-7 = success)"

Start-Service -Name 'kdeskcore' -ErrorAction SilentlyContinue

# keep the wallpaper cache inside the project directory (runs before kwallpaper starts)
try {
    $cacheDir = Set-KdeskWallpaperCache -ProjectRoot $dir -Target $target
    Log "wallpaper cache dir: $cacheDir"
} catch {
    Log "CACHE ERROR: $($_.Exception.Message)"
}

# optimizer requires kwallpaper to be fully up first, otherwise it hangs or errors out
Start-Process -FilePath (Join-Path $target 'kwallpaper.exe') -ErrorAction SilentlyContinue
$waited = Wait-KdeskWallpaperReady -TimeoutSeconds 60
if ($waited -ge 0) {
    Log "kwallpaper UI ready (waited ${waited}s)"
} else {
    Log 'WARNING: kwallpaper UI not detected after 60s, running optimizer anyway'
}
Start-Sleep -Seconds 10   # let the app finish initializing

Invoke-KdeskOptimizer -Optimizer $optimizer -LogFile $log

Log '=== deploy finished ==='
