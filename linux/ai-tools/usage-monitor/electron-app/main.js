const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

const MONITOR_SCRIPT = path.join(__dirname, "..", "usage_monitor.py");
const REFRESH_INTERVAL_MS = 60 * 1000;
const WINDOW_TITLE = "AI Usage Monitor";
const MIN_CONTENT_HEIGHT = 140;
// WSLg 下 Electron 的 alwaysOnTop 不会穿透到 Windows 窗口管理器,
// 需要通过 powershell.exe 调 SetWindowPos 在 Windows 侧置顶
const IS_WSL = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);

let win = null;
let refreshTimer = null;
// 用户手动拖过高度后暂停自动贴合;拖回接近自然高度时恢复
let manualHeight = false;
let programmaticResize = false;

function applyWindowsTopmost(topmost, attemptsLeft = 5) {
  if (!IS_WSL) return;
  const script = path.join(__dirname, "set-topmost.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
     "-Title", WINDOW_TITLE, "-Topmost", topmost ? "1" : "0"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.on("close", () => {
    // 窗口刚创建时 Windows 侧可能尚未出现,匹配不到则重试
    if (topmost && attemptsLeft > 0 && out.includes("matched: 0")) {
      setTimeout(() => applyWindowsTopmost(topmost, attemptsLeft - 1), 1500);
    }
  });
}

// 单实例:再次启动(Ctrl+E)时聚焦已有窗口而不是开新窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}

function fetchUsage() {
  return new Promise((resolve) => {
    const child = spawn("python3", [MONITOR_SCRIPT, "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ error: `无法运行 python3: ${err.message}` }));
    child.on("close", (code) => {
      try {
        resolve({ data: JSON.parse(stdout) });
      } catch {
        resolve({ error: `数据获取失败 (exit ${code}): ${stderr.trim() || stdout.trim()}` });
      }
    });
  });
}

async function pushUsage() {
  if (!win) return;
  const result = await fetchUsage();
  if (win) win.webContents.send("usage-update", result);
}

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 460,
    minWidth: 320,
    minHeight: MIN_CONTENT_HEIGHT,
    useContentSize: true,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: "#16181d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile("index.html");
  win.setTitle(WINDOW_TITLE);
  win.on("closed", () => {
    win = null;
    if (refreshTimer) clearInterval(refreshTimer);
  });
  // 默认悬浮:页面加载完成后在 Windows 侧置顶(WSLg 下才实际生效)
  win.webContents.on("did-finish-load", () => applyWindowsTopmost(true));
  // 用户手动调整高度后,暂停数据刷新带来的自动贴合;
  // WSLg 不一定遵守 minHeight,程序强制最小高度(防止拉成一条线)
  win.on("resize", () => {
    if (!win) return;
    const [width, height] = win.getContentSize();
    if (height < MIN_CONTENT_HEIGHT) {
      programmaticResize = true;
      win.setContentSize(width, MIN_CONTENT_HEIGHT);
      setTimeout(() => (programmaticResize = false), 150);
      manualHeight = true;
      return;
    }
    if (!programmaticResize) manualHeight = true;
  });

  pushUsage();
  refreshTimer = setInterval(pushUsage, REFRESH_INTERVAL_MS);
}

ipcMain.on("window-minimize", () => win && win.minimize());
ipcMain.on("window-close", () => win && win.close());
ipcMain.on("refresh", () => pushUsage());
// 切换筛选时清除手动高度状态,让窗口重新贴合内容(避免误触发紧凑折叠)
ipcMain.on("reset-fit", () => {
  manualHeight = false;
});
// 悬浮(置顶)开关:标题栏 pin 按钮切换
ipcMain.handle("toggle-pin", () => {
  if (!win) return false;
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next);
  applyWindowsTopmost(next);
  return next;
});
ipcMain.handle("get-pin-state", () => (win ? win.isAlwaysOnTop() : true));
// 渲染层根据内容高度请求自适应窗口(保持小巧,不出现大片空白);
// 用户手动拖过高度则暂停自动贴合,拖回接近自然高度时恢复
ipcMain.on("fit-height", (_event, height) => {
  if (!win) return;
  const clamped = Math.max(MIN_CONTENT_HEIGHT, Math.min(800, Math.ceil(height)));
  const [width, current] = win.getContentSize();
  if (Math.abs(current - clamped) <= 6) {
    manualHeight = false;
    return;
  }
  if (manualHeight) return;
  programmaticResize = true;
  win.setContentSize(width, clamped);
  setTimeout(() => (programmaticResize = false), 150);
});

app.whenReady().then(createWindow);

// 窗口关闭即退出进程,终端里 Ctrl+E 可重新拉起
app.on("window-all-closed", () => app.quit());
