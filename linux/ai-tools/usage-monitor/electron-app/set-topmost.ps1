# Set or clear WS_EX_TOPMOST on the window whose title matches -Title.
# Under WSLg, Electron's alwaysOnTop does not propagate to the Windows
# window manager, so this script applies it via SetWindowPos instead.
#
# NOTE: Do NOT use EnumWindows + GetWindowTextW here. When powershell.exe is
# launched via WSL interop, GetWindowTextW returns an empty string for the
# local-session windows (including the WSLg window), so matching always fails
# (matched: 0). Get-Process.MainWindowTitle / MainWindowHandle works correctly
# and the WSLg title looks like "[WARN:COPY MODE] AI Usage Monitor (Ubuntu-20.04)".
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Topmost = "1"
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Topmost {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

# SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
$flags = 0x0001 -bor 0x0002 -bor 0x0010
$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$after = if ($Topmost -eq "1") { $HWND_TOPMOST } else { $HWND_NOTOPMOST }

$found = @()
Get-Process | Where-Object {
    $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$Title*"
} | ForEach-Object {
    $found += $_.MainWindowHandle
}

foreach ($h in $found) {
    [void][Win32Topmost]::SetWindowPos($h, $after, 0, 0, 0, 0, $flags)
}
Write-Output ("matched: " + $found.Count)
