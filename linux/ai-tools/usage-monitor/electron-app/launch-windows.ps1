param(
    [string]$SourceDir = "",
    [string]$Distro = "",
    [string]$MonitorScript = "",
    [switch]$InstallShortcut
)

$ErrorActionPreference = "Stop"
$windowTitle = "AI Usage Monitor"
$runtimeDir = Join-Path $env:LOCALAPPDATA "AIUsageMonitor"
$appDir = Join-Path $runtimeDir "app"
$logPath = Join-Path $runtimeDir "launcher.log"
$launcherDir = $PSScriptRoot
if (-not $SourceDir) {
    $SourceDir = $launcherDir
}
$mutex = $null

function Write-LauncherLog([string]$Message) {
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -LiteralPath $logPath -Value "$timestamp $Message" -Encoding UTF8
}

function Show-LauncherError([string]$Message) {
    Write-LauncherLog "ERROR: $Message"
    try {
        Add-Type -AssemblyName PresentationFramework
        [System.Windows.MessageBox]::Show(
            $Message,
            $windowTitle,
            [System.Windows.MessageBoxButton]::OK,
            [System.Windows.MessageBoxImage]::Error
        ) | Out-Null
    } catch {
        Write-Error $Message
    }
}

function Test-ElectronRuntime([string]$ElectronPath) {
    if (-not (Test-Path -LiteralPath $ElectronPath -PathType Leaf)) {
        return $false
    }

    try {
        # Test-Path alone is insufficient: an interrupted extraction can leave a
        # truncated electron.exe behind.  Start it with a side-effect-free flag so
        # Windows validates the PE image before we trust the installation stamp.
        $process = Start-Process `
            -FilePath $ElectronPath `
            -ArgumentList @("--version") `
            -WorkingDirectory (Split-Path -Parent $ElectronPath) `
            -WindowStyle Hidden `
            -Wait `
            -PassThru
        if ($process.ExitCode -ne 0) {
            Write-LauncherLog "Electron runtime validation exited with code $($process.ExitCode): $ElectronPath"
            return $false
        }
        return $true
    } catch {
        Write-LauncherLog "Electron runtime validation failed: $($_.Exception.Message)"
        return $false
    }
}

function Remove-BrokenElectronRuntime([string]$ElectronModuleDir) {
    $distDir = Join-Path $ElectronModuleDir "dist"
    $pathFile = Join-Path $ElectronModuleDir "path.txt"
    if (Test-Path -LiteralPath $distDir) {
        Remove-Item -LiteralPath $distDir -Recurse -Force
    }
    if (Test-Path -LiteralPath $pathFile) {
        Remove-Item -LiteralPath $pathFile -Force
    }
}

function Get-WslSourceInfo([string]$Path) {
    $plainPath = $Path -replace '^Microsoft\.PowerShell\.Core\\FileSystem::', ''
    $match = [regex]::Match(
        $plainPath,
        '^\\\\(?:wsl\.localhost|wsl\$)\\(?<distro>[^\\]+)\\(?<path>.*)$',
        [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) {
        throw "The launcher must be run from a WSL UNC path, or -Distro and -MonitorScript must be supplied. Source: $plainPath"
    }
    return @{
        Distro = $match.Groups['distro'].Value
        LinuxPath = '/' + ($match.Groups['path'].Value -replace '\\', '/')
    }
}

function Install-StartMenuShortcut(
    [string]$LauncherPath,
    [string]$ElectronPath,
    [string]$SourcePath,
    [string]$DistroName,
    [string]$LinuxMonitorScript
) {
    $programs = [Environment]::GetFolderPath('Programs')
    $shortcutPath = Join-Path $programs "$windowTitle.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = (Get-Command powershell.exe).Source
    $shortcut.Arguments = (
        "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden " +
        "-File `"$LauncherPath`" -SourceDir `"$SourcePath`" " +
        "-Distro `"$DistroName`" -MonitorScript `"$LinuxMonitorScript`""
    )
    $shortcut.WorkingDirectory = $env:USERPROFILE
    $shortcut.IconLocation = "$ElectronPath,0"
    $shortcut.Description = "Native Windows dashboard backed by ai-tools in WSL"
    $shortcut.Save()
    Write-LauncherLog "Installed Start Menu shortcut: $shortcutPath"
}

try {
    New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
    $createdNew = $false
    $mutex = New-Object System.Threading.Mutex($true, "Local\AIUsageMonitorLauncher", [ref]$createdNew)
    if (-not $createdNew) {
        if (-not $mutex.WaitOne(120000)) {
            throw "Timed out waiting for another launcher process."
        }
    }

    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        throw "WSL is not installed. This dashboard currently requires the ai-tools backend in WSL."
    }

    $sourceInfo = Get-WslSourceInfo $SourceDir
    if (-not $Distro) {
        $Distro = $sourceInfo.Distro
    }
    if (-not $MonitorScript) {
        $monitorDir = Split-Path -Parent $sourceInfo.LinuxPath
        $MonitorScript = "$monitorDir/usage_monitor.py"
    }

    $installedDistros = @(wsl.exe --list --quiet 2>$null) -replace "`0", "" | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    if ($installedDistros -notcontains $Distro) {
        throw "WSL distro '$Distro' is not installed. Installed distros: $($installedDistros -join ', ')"
    }

    New-Item -ItemType Directory -Force -Path $appDir | Out-Null
    $appFiles = @(
        "index.html",
        "main.js",
        "package.json",
        "preload.js",
        "renderer.js"
    )
    foreach ($file in $appFiles) {
        Copy-Item -LiteralPath (Join-Path $SourceDir $file) -Destination (Join-Path $appDir $file) -Force
    }

    $sourcePackage = Join-Path $SourceDir "package.json"
    $runtimePackage = Join-Path $runtimeDir "package.json"
    $stampPath = Join-Path $runtimeDir "package.sha256"
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourcePackage).Hash
    $installedHash = if (Test-Path -LiteralPath $stampPath) {
        (Get-Content -LiteralPath $stampPath -Raw).Trim()
    } else {
        ""
    }
    $electronModuleDir = Join-Path $runtimeDir "node_modules\electron"
    $electronPath = Join-Path $electronModuleDir "dist\electron.exe"
    $electronValid = Test-ElectronRuntime $electronPath

    if ($sourceHash -ne $installedHash -or -not $electronValid) {
        if ((Test-Path -LiteralPath $electronPath) -and -not $electronValid) {
            Write-LauncherLog "Removing an invalid or incomplete Electron runtime"
            Remove-BrokenElectronRuntime $electronModuleDir
        }
        Copy-Item -LiteralPath $sourcePackage -Destination $runtimePackage -Force
        $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
        if (-not $npm) {
            throw "Windows Node.js/npm is required to install the native Electron runtime."
        }
        Write-LauncherLog "Installing Windows Electron runtime in $runtimeDir"
        Push-Location $runtimeDir
        try {
            & $npm.Source install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                throw "npm install failed with exit code $LASTEXITCODE."
            }
        } finally {
            Pop-Location
        }

        # Electron 43+ exposes an explicit installer instead of relying on an
        # npm postinstall hook. The npm package alone does not contain electron.exe.
        if (-not (Test-ElectronRuntime $electronPath)) {
            $node = Get-Command node.exe -ErrorAction SilentlyContinue
            $electronInstaller = Join-Path $runtimeDir "node_modules\electron\install.js"
            if (-not $node -or -not (Test-Path -LiteralPath $electronInstaller)) {
                throw "Electron binary installer is unavailable after npm install."
            }
            # install.js treats any existing electron.exe as installed, even if it
            # is truncated.  Always extract into a clean dist directory here.
            Remove-BrokenElectronRuntime $electronModuleDir
            $npmRegistry = (& $npm.Source config get registry).Trim()
            if (-not $env:ELECTRON_MIRROR -and $npmRegistry -like "*npmmirror.com*") {
                $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
            }
            Write-LauncherLog "Downloading the Windows Electron binary"
            & $node.Source $electronInstaller
            if ($LASTEXITCODE -ne 0) {
                throw "Electron binary installation failed with exit code $LASTEXITCODE."
            }
        }
        if (-not (Test-ElectronRuntime $electronPath)) {
            throw "Electron installation completed but the runtime is not executable: $electronPath"
        }
        Set-Content -LiteralPath $stampPath -Value $sourceHash -Encoding ASCII
    }

    $launcherPath = $PSCommandPath
    if ($InstallShortcut) {
        Install-StartMenuShortcut $launcherPath $electronPath $SourceDir $Distro $MonitorScript
    }

    $env:AI_USAGE_MONITOR_BACKEND = "wsl"
    $env:AI_USAGE_MONITOR_WSL_DISTRO = $Distro
    $env:AI_USAGE_MONITOR_WSL_SCRIPT = $MonitorScript
    Write-LauncherLog "Launching native Electron (distro=$Distro, script=$MonitorScript)"
    Start-Process -FilePath $electronPath -ArgumentList @($appDir) -WorkingDirectory $appDir
} catch {
    Show-LauncherError $_.Exception.Message
    exit 1
} finally {
    if ($mutex) {
        try { $mutex.ReleaseMutex() } catch {}
        $mutex.Dispose()
    }
}
