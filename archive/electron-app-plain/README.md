# AI Usage Monitor window

The dashboard uses a native Windows Electron process when it is launched from
WSL. Data collection still runs in the originating WSL distro through
`usage_monitor.py --json`. This avoids the WSLg/RDP rendering path and its
`[WARN:COPY MODE]` failures.

## Windows

Since v0.2.0 the app opens in the full-mode analytics window
(`dashboard.html`, "AI Usage Dashboard") by default. The `Board` button in its
titlebar opens the compact usage-board window (`index.html`, "AI Usage
Monitor"); the expand button in the board's titlebar goes back to the full
window. Both windows can stay open at the same time and share the same
60-second quota refresh. The settings pages live in the usage-board window;
the gear button in the full window opens the board straight to Settings.

The full window also renders local Kimi Code session analytics
(`usage_monitor.py --json --analytics`): daily/hourly token trends, model
share, cache hit rate, project ranking, a yearly activity calendar and a
session table. See `docs/usage-monitor.md` for details.

## Launching

- `usage_monitor.py --watch` opens the window automatically.
- Press `Ctrl+E` in the watch terminal to open or restore the existing window.
- On Windows, open **AI Usage Monitor** from the Start menu. The shortcut is
  created by the first setup launch.
- Open **Settings → Login** to start Kimi Code or Codex web authorization manually.
- **Settings → Environment** lets WSL users choose the distribution used by the
  dashboard.

Opening the Windows shortcut while WSL is stopped starts the configured distro
in the background. It does not open a terminal window.

The Windows runtime is isolated at
`%LOCALAPPDATA%\AIUsageMonitor`; Linux `node_modules` is not reused or changed.
Launcher diagnostics are written to
`%LOCALAPPDATA%\AIUsageMonitor\launcher.log`.

## Requirements

- WSL with the distro and repository path recorded in the Start menu shortcut.
- Windows Node.js/npm for the first Electron runtime installation.
- The existing credentials used by `usage_monitor.py` inside WSL.

Closing the WSL terminal does not close a Windows dashboard that may also have
been opened from the Start menu. Use the dashboard's close button to exit it.
