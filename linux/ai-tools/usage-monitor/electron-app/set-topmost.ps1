# Set or clear WS_EX_TOPMOST on the window whose title matches -Title.
# Under WSLg, Electron's alwaysOnTop does not propagate to the Windows
# window manager, so this script applies it via SetWindowPos instead.
param(
    [Parameter(Mandatory = $true)][string]$Title,
    [string]$Topmost = "1"
)

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32Topmost {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
"@

$script:found = @()
$cb = [Win32Topmost+EnumWindowsProc]{
    param($hWnd, $lParam)
    if ([Win32Topmost]::IsWindowVisible($hWnd)) {
        $sb = New-Object System.Text.StringBuilder 256
        [void][Win32Topmost]::GetWindowTextW($hWnd, $sb, 256)
        $t = $sb.ToString()
        if ($t -eq $Title -or $t.StartsWith($Title)) { $script:found += $hWnd }
    }
    return $true
}
[void][Win32Topmost]::EnumWindows($cb, [IntPtr]::Zero)

# SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE
$flags = 0x0001 -bor 0x0002 -bor 0x0010
$HWND_TOPMOST = [IntPtr]::new(-1)
$HWND_NOTOPMOST = [IntPtr]::new(-2)
$after = if ($Topmost -eq "1") { $HWND_TOPMOST } else { $HWND_NOTOPMOST }
foreach ($h in $script:found) {
    [void][Win32Topmost]::SetWindowPos($h, $after, 0, 0, 0, 0, $flags)
}
Write-Output ("matched: " + $script:found.Count)
