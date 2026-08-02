# Shared kdesk installation directory discovery for the deployment scripts.
# The caller may provide a cached path and an excluded directory (the bundled backup).

function Resolve-KdeskCandidate {
    param(
        [AllowNull()]
        [string]$Candidate,
        [AllowNull()]
        [string]$ExcludedPath
    )

    if ([string]::IsNullOrWhiteSpace($Candidate)) {
        return $null
    }

    $value = [Environment]::ExpandEnvironmentVariables($Candidate.Trim())

    # DisplayIcon/App Paths values are sometimes formatted as "C:\path\app.exe",0.
    if ($value -match '^\s*"([^"]+)"') {
        $value = $matches[1]
    } else {
        $value = ($value -replace ',\s*-?\d+\s*$', '').Trim('"')
    }

    if (Test-Path -LiteralPath $value -PathType Leaf) {
        $value = Split-Path -Parent $value
    }

    if (-not (Test-Path -LiteralPath $value -PathType Container)) {
        return $null
    }

    try {
        $resolved = (Resolve-Path -LiteralPath $value -ErrorAction Stop).Path.TrimEnd('\')
    } catch {
        return $null
    }

    if (-not [string]::IsNullOrWhiteSpace($ExcludedPath)) {
        try {
            $excluded = (Resolve-Path -LiteralPath $ExcludedPath -ErrorAction Stop).Path.TrimEnd('\')
            if ($resolved -eq $excluded -or $resolved.StartsWith($excluded + '\', [StringComparison]::OrdinalIgnoreCase)) {
                return $null
            }
        } catch {
            # A missing excluded directory does not invalidate the candidate.
        }
    }

    if ((Test-Path -LiteralPath (Join-Path $resolved 'kwallpaper.exe') -PathType Leaf) -and
        ((Test-Path -LiteralPath (Join-Path $resolved 'kdesk.exe') -PathType Leaf) -or
         (Test-Path -LiteralPath (Join-Path $resolved 'kdesk64.exe') -PathType Leaf))) {
        return $resolved
    }

    return $null
}

function Find-KdeskDir {
    param(
        [AllowNull()]
        [string]$StateFile,
        [AllowNull()]
        [string]$ExcludedPath,
        [switch]$SkipFullScan
    )

    # 1. A path detected during setup is the fastest and most reliable source.
    if (-not [string]::IsNullOrWhiteSpace($StateFile) -and (Test-Path -LiteralPath $StateFile -PathType Leaf)) {
        $cached = Get-Content -LiteralPath $StateFile -TotalCount 1 -ErrorAction SilentlyContinue
        $found = Resolve-KdeskCandidate -Candidate $cached -ExcludedPath $ExcludedPath
        if ($found) { return $found }
    }

    # 2. Detect an already running copy.
    foreach ($processName in @('kwallpaper', 'kdesk', 'kdesk64')) {
        foreach ($process in (Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
            try {
                $found = Resolve-KdeskCandidate -Candidate $process.MainModule.FileName -ExcludedPath $ExcludedPath
                if ($found) { return $found }
            } catch {
                # Protected processes may deny access to MainModule.
            }
        }
    }

    # 3. Check Windows App Paths registrations.
    $appPathKeys = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\kwallpaper.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\kwallpaper.exe',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\kdesk.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\kdesk.exe'
    )
    foreach ($key in $appPathKeys) {
        try {
            $item = Get-Item -LiteralPath $key -ErrorAction Stop
            $found = Resolve-KdeskCandidate -Candidate $item.GetValue('') -ExcludedPath $ExcludedPath
            if ($found) { return $found }
            $found = Resolve-KdeskCandidate -Candidate $item.GetValue('Path') -ExcludedPath $ExcludedPath
            if ($found) { return $found }
        } catch {
        }
    }

    # 4. Check both 32-bit and 64-bit uninstall registrations for Yuanqi Desktop/kdesk.
    $uninstallRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $uninstallRoots) {
        foreach ($app in (Get-ItemProperty -Path $root -ErrorAction SilentlyContinue)) {
            if ($app.DisplayName -notmatch '元气桌面|kdesk') { continue }
            foreach ($candidate in @($app.InstallLocation, $app.DisplayIcon)) {
                $found = Resolve-KdeskCandidate -Candidate $candidate -ExcludedPath $ExcludedPath
                if ($found) { return $found }
            }
        }
    }

    # 5. Resolve Start Menu, desktop, and pinned taskbar shortcuts. The shortcut may
    # point at any executable in the installation directory, not only kwallpaper.exe.
    try {
        $shell = New-Object -ComObject WScript.Shell
        $shortcutRoots = @(
            (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
            (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
            (Join-Path $env:USERPROFILE 'Desktop'),
            (Join-Path $env:PUBLIC 'Desktop'),
            (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
        )
        foreach ($root in $shortcutRoots) {
            if (-not (Test-Path -LiteralPath $root -PathType Container)) { continue }
            foreach ($shortcut in (Get-ChildItem -LiteralPath $root -Recurse -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
                try {
                    $targetPath = $shell.CreateShortcut($shortcut.FullName).TargetPath
                    $found = Resolve-KdeskCandidate -Candidate $targetPath -ExcludedPath $ExcludedPath
                    if ($found) { return $found }
                } catch {
                }
            }
        }
    } catch {
    }

    # 6. Check common per-user and machine-wide locations without a recursive scan.
    $baseDirectories = @(
        $env:LOCALAPPDATA,
        $env:APPDATA,
        $env:ProgramFiles,
        ${env:ProgramFiles(x86)},
        $env:ProgramData
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    foreach ($base in $baseDirectories) {
        foreach ($name in @('kdesk', 'Kingsoft\kdesk', 'Kingsoft\元气桌面', '元气桌面')) {
            $found = Resolve-KdeskCandidate -Candidate (Join-Path $base $name) -ExcludedPath $ExcludedPath
            if ($found) { return $found }
        }
    }

    if ($SkipFullScan) { return $null }

    # 7. Last resort: recursively search all ready fixed drives. This is normally
    # reached only on first setup after a custom-path installation.
    $scanResult = $null
    $stopSignal = 'KDESK_INSTALLATION_FOUND'
    try {
        foreach ($drive in ([IO.DriveInfo]::GetDrives() | Where-Object { $_.IsReady -and $_.DriveType -eq 'Fixed' })) {
            Get-ChildItem -LiteralPath $drive.RootDirectory.FullName -Recurse -Filter 'kwallpaper.exe' -File -Force -ErrorAction SilentlyContinue |
                ForEach-Object {
                    $candidate = Resolve-KdeskCandidate -Candidate $_.FullName -ExcludedPath $ExcludedPath
                    if ($candidate) {
                        $scanResult = $candidate
                        throw $stopSignal
                    }
                }
        }
    } catch {
        if ($_.Exception.Message -ne $stopSignal) { throw }
    }

    if ($scanResult) { return $scanResult }

    return $null
}
