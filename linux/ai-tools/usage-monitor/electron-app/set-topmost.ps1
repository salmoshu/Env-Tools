# Set or clear WS_EX_TOPMOST on the window whose title matches -Title.
# Under WSLg, Electron's alwaysOnTop does not propagate to the Windows
# window manager, so this script applies it via SetWindowPos instead.
#
# Output:
#   matched: <N>   how many windows matched -Title
#   topmost: <0|1> WS_EX_TOPMOST state after applying
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
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
}
"@

# 置顶时同时激活窗口,让它立刻浮到当前窗口前面;仅取消置顶时保留
# SWP_NOACTIVATE,避免抢走用户当前窗口的焦点。
$flags = 0x0001 -bor 0x0002            # SWP_NOMOVE | SWP_NOSIZE
if ($Topmost -ne "1") { $flags = $flags -bor 0x0010 }  # SWP_NOACTIVATE
$flags = $flags -bor 0x0040            # SWP_SHOWWINDOW
$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$after = if ($Topmost -eq "1") { $HWND_TOPMOST } else { $HWND_NOTOPMOST }

$found = @()
Get-Process | Where-Object {
    $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$Title*"
} | ForEach-Object {
    $found += $_.MainWindowHandle
}

$topmostState = 0
foreach ($h in $found) {
    [void][Win32Topmost]::SetWindowPos($h, $after, 0, 0, 0, 0, $flags)
    $exstyle = [Win32Topmost]::GetWindowLong($h, -20)  # GWL_EXSTYLE
    if (($exstyle -band 0x8) -ne 0) { $topmostState = 1 }  # WS_EX_TOPMOST
}
Write-Output ("matched: " + $found.Count)
Write-Output ("topmost: " + $topmostState)
