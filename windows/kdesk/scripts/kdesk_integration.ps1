# Windows integration and portable-deployment helpers used by setup_elevated.ps1.

function Get-KdeskPortableTarget {
    $systemDrive = [IO.Path]::GetPathRoot($env:SystemRoot)
    $nonSystemDrive = [IO.DriveInfo]::GetDrives() |
        Where-Object {
            $_.IsReady -and $_.DriveType -eq 'Fixed' -and
            $_.Name -ne $systemDrive -and $_.AvailableFreeSpace -gt 500MB
        } |
        Sort-Object AvailableFreeSpace -Descending |
        Select-Object -First 1

    if ($nonSystemDrive) {
        return (Join-Path $nonSystemDrive.RootDirectory.FullName 'KDesk')
    }

    return (Join-Path $env:ProgramData 'KDesk')
}

function Stop-KdeskService {
    $service = Get-Service -Name 'kdeskcore' -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name 'kdeskcore' -Force -ErrorAction Stop
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(20))
    }
}

function Set-KdeskService {
    param([Parameter(Mandatory = $true)][string]$Target)

    $serviceExe = Join-Path $Target 'kdeskcore.exe'
    if (-not (Test-Path -LiteralPath $serviceExe -PathType Leaf)) {
        throw "Missing service executable: $serviceExe"
    }

    $binaryPath = '"' + $serviceExe + '" /service cmcore'
    $service = Get-Service -Name 'kdeskcore' -ErrorAction SilentlyContinue
    if ($service) {
        Stop-KdeskService
        $output = & sc.exe config kdeskcore binPath= $binaryPath start= auto error= normal group= ShellSvcGroup DisplayName= 'KDesk Core Service' 2>&1
    } else {
        $output = & sc.exe create kdeskcore binPath= $binaryPath type= own type= interact start= auto error= normal group= ShellSvcGroup DisplayName= 'KDesk Core Service' 2>&1
        if ($LASTEXITCODE -ne 0) {
            $output = & sc.exe create kdeskcore binPath= $binaryPath type= own start= auto error= normal group= ShellSvcGroup DisplayName= 'KDesk Core Service' 2>&1
        }
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to register kdeskcore service: $($output -join ' ')"
    }

    & sc.exe description kdeskcore 'KDesk Core Service' | Out-Null
    Start-Service -Name 'kdeskcore' -ErrorAction Stop
}

function Set-KdeskRegistry {
    param([Parameter(Mandatory = $true)][string]$Target)

    $programPath = $Target.TrimEnd('\') + '\'
    foreach ($productKey in @('HKLM:\SOFTWARE\cmcm\kdesk', 'HKLM:\SOFTWARE\WOW6432Node\cmcm\kdesk')) {
        $setupKey = Join-Path $productKey 'Setup'
        New-Item -Path $setupKey -Force | Out-Null
        New-ItemProperty -Path $productKey -Name 'ProgramPath' -Value $programPath -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $productKey -Name 'operation_minisite_switch' -Value '0' -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $productKey -Name 'Lang' -Value 'chs' -PropertyType String -Force | Out-Null
        New-ItemProperty -Path $productKey -Name 'setup' -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $setupKey -Name 'product_id' -Value '1002' -PropertyType String -Force | Out-Null
    }

    foreach ($appRoot in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths'
    )) {
        foreach ($exeName in @('kwallpaper.exe', 'kdesk.exe')) {
            $exePath = Join-Path $Target $exeName
            if (-not (Test-Path -LiteralPath $exePath -PathType Leaf)) { continue }
            $key = New-Item -Path (Join-Path $appRoot $exeName) -Force
            $key.SetValue('', $exePath, [Microsoft.Win32.RegistryValueKind]::String)
            $key.SetValue('Path', $Target, [Microsoft.Win32.RegistryValueKind]::String)
        }
    }
}

function New-KdeskShortcut {
    param(
        [Parameter(Mandatory = $true)][object]$Shell,
        [Parameter(Mandatory = $true)][string]$ShortcutPath,
        [Parameter(Mandatory = $true)][string]$TargetPath,
        [string]$Arguments = ''
    )

    New-Item -ItemType Directory -Path (Split-Path -Parent $ShortcutPath) -Force | Out-Null
    $shortcut = $Shell.CreateShortcut($ShortcutPath)
    $shortcut.TargetPath = $TargetPath
    $shortcut.WorkingDirectory = Split-Path -Parent $TargetPath
    $shortcut.IconLocation = "$TargetPath,0"
    $shortcut.Arguments = $Arguments
    $shortcut.Save()
}

function Set-KdeskShortcuts {
    param([Parameter(Mandatory = $true)][string]$Target)

    $shell = New-Object -ComObject WScript.Shell
    $wallpaperExe = Join-Path $Target 'kwallpaper.exe'
    $desktopExe = if ([Environment]::Is64BitOperatingSystem -and (Test-Path -LiteralPath (Join-Path $Target 'kdesk64.exe'))) {
        Join-Path $Target 'kdesk64.exe'
    } else {
        Join-Path $Target 'kdesk.exe'
    }

    New-KdeskShortcut -Shell $shell -ShortcutPath (Join-Path $env:PUBLIC 'Desktop\元气桌面.lnk') -TargetPath $wallpaperExe -Arguments '/from:27'
    $startMenu = Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs\元气桌面'
    New-KdeskShortcut -Shell $shell -ShortcutPath (Join-Path $startMenu '元气壁纸.lnk') -TargetPath $wallpaperExe
    New-KdeskShortcut -Shell $shell -ShortcutPath (Join-Path $startMenu '桌面整理.lnk') -TargetPath $desktopExe
}

function Set-IniValue {
    param(
        [Parameter(Mandatory = $true)][System.Collections.Generic.List[string]]$Lines,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Value
    )

    for ($index = 0; $index -lt $Lines.Count; $index++) {
        if ($Lines[$index] -match ('^\s*' + [regex]::Escape($Name) + '\s*=')) {
            $Lines[$index] = "$Name=$Value"
            return
        }
    }
    $Lines.Add("$Name=$Value")
}

function Set-KdeskWallpaperCache {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$Target
    )

    $cacheDir = Join-Path $ProjectRoot 'wallpaper_cache'
    $configDir = Join-Path $env:APPDATA 'kdesk\data\wallpaper'
    $iniPath = Join-Path $configDir 'interactive.ini'
    New-Item -ItemType Directory -Path $cacheDir,$configDir -Force | Out-Null

    $oldCache = $null
    if (Test-Path -LiteralPath $iniPath -PathType Leaf) {
        $oldCacheLine = Get-Content -LiteralPath $iniPath -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^\s*cachepath\s*=' } |
            Select-Object -First 1
        if ($oldCacheLine) { $oldCache = ($oldCacheLine -replace '^\s*cachepath\s*=\s*', '').TrimEnd('\') }
    }
    if ([string]::IsNullOrWhiteSpace($oldCache) -and (Test-Path -LiteralPath 'D:\元气壁纸缓存')) {
        $oldCache = 'D:\元气壁纸缓存'
    }

    if (-not [string]::IsNullOrWhiteSpace($oldCache) -and
        (Test-Path -LiteralPath $oldCache -PathType Container) -and
        $oldCache.TrimEnd('\') -ne $cacheDir.TrimEnd('\')) {
        robocopy $oldCache $cacheDir /E /R:2 /W:2 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -gt 7) { throw "Unable to migrate wallpaper cache from $oldCache" }
    }

    foreach ($subdirectory in @('deskpet','dynamic','dynamic_cache','dynamic_thumbnail','img','img_cache','khealtheye','sys_cache','thumbnail')) {
        New-Item -ItemType Directory -Path (Join-Path $cacheDir $subdirectory) -Force | Out-Null
    }

    $lines = New-Object 'System.Collections.Generic.List[string]'
    if (Test-Path -LiteralPath $iniPath -PathType Leaf) {
        foreach ($line in (Get-Content -LiteralPath $iniPath -ErrorAction Stop)) { $lines.Add($line) }
    } else {
        $lines.Add('[data]')
    }

    $cachePath = $cacheDir.TrimEnd('\') + '\'
    $configPath = $configDir.TrimEnd('\') + '\'
    Set-IniValue -Lines $lines -Name 'cachedynamicpath' -Value ($cachePath + 'dynamic\')
    Set-IniValue -Lines $lines -Name 'cacheimagepath' -Value ($cachePath + 'img\')
    Set-IniValue -Lines $lines -Name 'cachepath' -Value $cachePath
    Set-IniValue -Lines $lines -Name 'configpath' -Value $configPath
    Set-IniValue -Lines $lines -Name 'healthhistoryfile' -Value ($configPath + 'khealtheye_history_action.xml')
    Set-IniValue -Lines $lines -Name 'installpath' -Value ($Target.TrimEnd('\') + '\')
    Set-IniValue -Lines $lines -Name 'rcmd_dy_history' -Value ($configPath + 'RcmdDYACtion.json')
    Set-IniValue -Lines $lines -Name 'spicaltopicfile' -Value ($configPath + 'specail_topic.json')
    Set-IniValue -Lines $lines -Name 'wallpaperfile' -Value ($configPath + 'khealth_wallpaper.json')
    Set-Content -LiteralPath $iniPath -Value $lines -Encoding UTF8

    if (-not [string]::IsNullOrWhiteSpace($oldCache)) {
        foreach ($file in (Get-ChildItem -LiteralPath $configDir -Recurse -File -Include '*.ini','*.xml','*.json' -ErrorAction SilentlyContinue)) {
            $content = Get-Content -LiteralPath $file.FullName -Raw -ErrorAction SilentlyContinue
            if ($null -ne $content -and $content.Contains($oldCache)) {
                $content.Replace($oldCache.TrimEnd('\'), $cacheDir.TrimEnd('\')) |
                    Set-Content -LiteralPath $file.FullName -Encoding UTF8
            }
        }
    }

    return $cacheDir
}

function Install-KdeskIntegration {
    param([Parameter(Mandatory = $true)][string]$Target)

    Set-KdeskRegistry -Target $Target
    Set-KdeskService -Target $Target
    Set-KdeskShortcuts -Target $Target
}

function Invoke-KdeskSnapshotRestore {
    # Mirrors the 33_1 snapshot into the install dir. The most common failure is
    # explorer.exe holding kdeskmenu64.dll open (it is a shell context-menu
    # extension, loaded lazily on the first right-click and never released), which
    # makes robocopy fail with error 32 on the target file. On failure, restart
    # the shell to release the lock and retry once.
    param(
        [Parameter(Mandatory = $true)][string]$Backup,
        [Parameter(Mandatory = $true)][string]$Target,
        [string]$LogFile
    )

    $robocopyArgs = @('/MIR','/R:2','/W:2','/NFL','/NDL','/NJH','/NJS','/NP')
    robocopy $Backup $Target @robocopyArgs | Out-Null
    $code = $LASTEXITCODE
    if ($code -le 7) { return $code }

    if ($LogFile) {
        Write-KdeskLog -LogFile $LogFile -Message "restore failed (exit=$code); restarting explorer to release shell-extension locks, then retrying"
    }
    Get-Process -Name 'explorer' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    robocopy $Backup $Target @robocopyArgs | Out-Null
    $code = $LASTEXITCODE

    # explorer usually auto-restarts; bring it back only if it did not
    Start-Sleep -Seconds 2
    if (-not (Get-Process -Name 'explorer' -ErrorAction SilentlyContinue)) {
        Start-Process 'explorer.exe'
    }
    return $code
}

function Write-KdeskLog {
    param(
        [Parameter(Mandatory = $true)][string]$LogFile,
        [Parameter(Mandatory = $true)][string]$Message
    )

    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $Message" | Out-File $LogFile -Append -Encoding utf8
}

function Wait-KdeskWallpaperReady {
    param([int]$TimeoutSeconds = 60)

    $waited = 0
    while ($waited -lt $TimeoutSeconds) {
        $main = Get-Process -Name 'kwallpaper' -ErrorAction SilentlyContinue
        $ui = Get-Process -Name 'kwallpaperui' -ErrorAction SilentlyContinue
        if ($main -and $ui) {
            # ready as soon as a real window exists; tray-only builds get a grace period
            if ($ui | Where-Object { $_.MainWindowHandle -ne 0 }) { return $waited }
            if ($waited -ge 15) { return $waited }
        }
        Start-Sleep -Seconds 1
        $waited++
    }
    return -1
}

function Get-KdeskOptimizer {
    # The optimizer exe sits in the kdesk project dir. Its filename is Chinese,
    # which turns into mojibake when a script is saved without a UTF-8 BOM
    # (Windows PowerShell then reads the file as ANSI), so resolve it by
    # scanning instead of hard-coding the name.
    param([Parameter(Mandatory = $true)][string]$Dir)

    Get-ChildItem -LiteralPath $Dir -File -Filter '*.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
}

function Invoke-KdeskOptimizer {
    param(
        [string]$Optimizer,
        [Parameter(Mandatory = $true)][string]$LogFile
    )

    if ([string]::IsNullOrWhiteSpace($Optimizer) -or -not (Test-Path -LiteralPath $Optimizer -PathType Leaf)) {
        Write-KdeskLog -LogFile $LogFile -Message "optimizer not found: $Optimizer"
        return
    }

    # kill a hung optimizer left over from a previous run before starting a fresh one
    Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($Optimizer)) -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue

    # the optimizer only takes effect when kwallpaper is already running:
    # wait for it to show up, then give it 3 more seconds to settle before patching
    $waited = 0
    while (-not (Get-Process -Name 'kwallpaper' -ErrorAction SilentlyContinue) -and $waited -lt 60) {
        Start-Sleep -Seconds 1
        $waited++
    }
    if ($waited -ge 60) {
        Write-KdeskLog -LogFile $LogFile -Message 'WARNING: kwallpaper not running after 60s, running optimizer anyway'
    } elseif ($waited -gt 0) {
        Write-KdeskLog -LogFile $LogFile -Message "kwallpaper detected (waited ${waited}s)"
    }
    Start-Sleep -Seconds 3

    try {
        Write-KdeskLog -LogFile $LogFile -Message 'running optimizer...'
        $p = Start-Process -FilePath $Optimizer -PassThru -ErrorAction Stop
        Write-KdeskLog -LogFile $LogFile -Message "optimizer pid=$($p.Id)"
        # the optimizer patches the running kwallpaper and may then stay resident
        # with no window - do not block on it, just confirm it started
        if ($p.WaitForExit(15000)) {
            Write-KdeskLog -LogFile $LogFile -Message "optimizer exited, code=$($p.ExitCode)"
        } else {
            Write-KdeskLog -LogFile $LogFile -Message 'optimizer running in background'
        }
    } catch {
        Write-KdeskLog -LogFile $LogFile -Message "OPTIMIZER ERROR: $($_.Exception.Message)"
    }
}
