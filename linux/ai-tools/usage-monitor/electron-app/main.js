const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

const MONITOR_SCRIPT = path.join(__dirname, "..", "usage_monitor.py");
const REFRESH_INTERVAL_MS = 60 * 1000;
// 单轮刷新上限：Codex 经代理访问 chatgpt.com 享有双倍单次超时（20s×2 次，
// 最坏约 41s），其余 provider 为 10s×2；留少量余量给进程启动与版本检测。
const FETCH_TIMEOUT_MS = 45 * 1000;
const SETTINGS_TIMEOUT_MS = 10 * 1000;
const WINDOW_TITLE = "AI Usage Monitor";
const MIN_CONTENT_HEIGHT = 140;
// WSLg 下 Electron 的 alwaysOnTop 不会穿透到 Windows 窗口管理器,
// 需要通过 powershell.exe 调 SetWindowPos 在 Windows 侧置顶
const IS_WSL = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
const WSL_BACKEND = process.env.AI_USAGE_MONITOR_BACKEND === "wsl";
const WSL_DISTRO = process.env.AI_USAGE_MONITOR_WSL_DISTRO || "";
const WSL_MONITOR_SCRIPT = process.env.AI_USAGE_MONITOR_WSL_SCRIPT || "";

if (process.platform === "win32") {
  app.setAppUserModelId("AIUsageMonitor");
}

let win = null;
let refreshTimer = null;
let usageFetchPromise = null;
// 置顶期间周期性补挂 WS_EX_TOPMOST 的巡检定时器：
// WSLg 的 RAIL 窗口在焦点切换、尺寸变化等场景下可能重建或重排 Z 序，
// 导致之前用 SetWindowPos 设置的置顶样式丢失（表现：切应用后看板被盖住，
// 拖动一下窗口又恢复）。
let pinWatchdog = null;
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
    const matched = /matched:\s*(\d+)/.exec(out);
    const applied = /topmost:\s*(\d+)/.exec(out);
    const ok = Boolean(
      matched && Number(matched[1]) > 0 &&
      applied && Number(applied[1]) === (topmost ? 1 : 0),
    );
    // 窗口刚创建时 Windows 侧可能尚未出现;置顶/取消未生效时稍后重试
    if (!ok && attemptsLeft > 0) {
      setTimeout(() => applyWindowsTopmost(topmost, attemptsLeft - 1), 800);
    }
  });
}

function startPinWatchdog() {
  if (!IS_WSL || pinWatchdog) return;
  // 置顶样式丢失无法从 Linux 侧感知，只能周期性补挂；
  // set-topmost.ps1 对已置顶的窗口跳过 SetWindowPos，不会抢焦点。
  pinWatchdog = setInterval(() => {
    if (win && win.isAlwaysOnTop()) applyWindowsTopmost(true, 1);
  }, 5000);
}

function stopPinWatchdog() {
  if (pinWatchdog) {
    clearInterval(pinWatchdog);
    pinWatchdog = null;
  }
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

function monitorSpec(extraArgs) {
  if (WSL_BACKEND) {
    if (process.platform !== "win32" || !WSL_DISTRO || !WSL_MONITOR_SCRIPT) {
      return null;
    }
    return {
      command: "wsl.exe",
      args: ["-d", WSL_DISTRO, "--exec", "python3", WSL_MONITOR_SCRIPT, ...extraArgs],
    };
  }
  return { command: "python3", args: [MONITOR_SCRIPT, ...extraArgs] };
}

function runMonitor(extraArgs, { input = "", timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const spec = monitorSpec(extraArgs);
    if (!spec) {
      resolve({ error: "Invalid WSL backend configuration" });
      return;
    }
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish({ timedOut: true, code: null, stdout, stderr });
    }, timeoutMs);
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      finish({ error: err.message, code: null, stdout, stderr });
    });
    child.on("close", (code) => {
      if (settled) return;
      finish({ code, stdout, stderr });
    });
  });
}

async function fetchUsage() {
  const run = await runMonitor(["--json", "--dashboard"]);
  if (run.error) {
    const backend = WSL_BACKEND ? `WSL distro ${WSL_DISTRO}` : "python3";
    return { error: `Cannot run ${backend}: ${run.error}` };
  }
  if (run.timedOut) {
    return { error: `Data fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s` };
  }
  try {
    return { data: JSON.parse(run.stdout) };
  } catch {
    return {
      error: `Data fetch failed (exit ${run.code}): ${run.stderr.trim() || run.stdout.trim()}`,
    };
  }
}

async function runMonitorJson(args, input = "") {
  const run = await runMonitor(args, { input, timeoutMs: SETTINGS_TIMEOUT_MS });
  if (run.error) return { ok: false, error: run.error };
  if (run.timedOut) return { ok: false, error: "Settings request timed out" };
  try {
    return JSON.parse(run.stdout);
  } catch {
    return {
      ok: false,
      error: `Settings request failed (exit ${run.code}): ${run.stderr.trim() || run.stdout.trim()}`,
    };
  }
}

async function pushUsage() {
  if (!win) return null;
  // 定时刷新、手动刷新和升级后刷新可能同时到达；复用同一
  // 个在途请求，避免重复后端进程互相抢网络导致假超时。
  if (usageFetchPromise) return usageFetchPromise;
  usageFetchPromise = (async () => {
    const result = await fetchUsage();
    if (win) win.webContents.send("usage-update", result);
    return result;
  })();
  try {
    return await usageFetchPromise;
  } finally {
    usageFetchPromise = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 400,
    height: 460,
    minWidth: 320,
    minHeight: MIN_CONTENT_HEIGHT,
    useContentSize: true,
    frame: false,
    alwaysOnTop: false,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: "#16181d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "index.html"));
  win.setTitle(WINDOW_TITLE);
  win.on("closed", () => {
    win = null;
    if (refreshTimer) clearInterval(refreshTimer);
    stopPinWatchdog();
  });
  // 窗口失焦(用户切到其它应用)时立即补挂一次置顶;
  // 已置顶时脚本侧直接跳过,不会把窗口抢回前台
  win.on("blur", () => {
    if (win && win.isAlwaysOnTop()) applyWindowsTopmost(true, 1);
  });
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
ipcMain.handle("api-key-status", () => runMonitorJson(["--api-key-status"]));
// 设置页：读取/保存后端设置（数据源环境等）；保存成功后立即刷新看板
ipcMain.handle("get-settings", () => runMonitorJson(["--get-settings"]));
ipcMain.handle("set-settings", async (_event, values) => {
  const result = await runMonitorJson(["--set-settings"], JSON.stringify(values || {}));
  if (result && result.ok) await pushUsage();
  return result;
});
// 设置页打开时加宽窗口以容纳侧边栏布局，关闭时恢复原宽
let widthBeforeSettings = 400;
ipcMain.on("settings-open", (_event, open) => {
  if (!win) return;
  const [width, height] = win.getContentSize();
  if (open) {
    widthBeforeSettings = width;
    // 允许设置页按内容重新贴合高度（用户可能之前手动拖过高度）
    manualHeight = false;
    if (width < 560) {
      programmaticResize = true;
      win.setContentSize(560, height);
      setTimeout(() => (programmaticResize = false), 150);
    }
  } else if (width !== widthBeforeSettings) {
    programmaticResize = true;
    win.setContentSize(widthBeforeSettings, height);
    setTimeout(() => (programmaticResize = false), 150);
    manualHeight = false;
  }
});
ipcMain.handle("save-api-keys", async (_event, values) => {
  const keys = {};
  for (const provider of ["deepseek", "glm"]) {
    const value = values && values[provider];
    if (typeof value === "string" && value.trim()) keys[provider] = value.trim();
  }
  if (Object.keys(keys).length === 0) {
    return { ok: false, error: "Enter at least one API key" };
  }
  // 密钥只通过子进程 stdin 传入，不出现在命令行、进程列表或日志。
  const result = await runMonitorJson(["--configure-api-keys"], JSON.stringify(keys));
  if (result && result.ok) await pushUsage();
  return result;
});
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
  if (next) startPinWatchdog(); else stopPinWatchdog();
  return next;
});
ipcMain.handle("get-pin-state", () => (win ? win.isAlwaysOnTop() : false));

// --- 看板内点击版本徽章触发升级 ---------------------------------------------
// 直接调组件安装脚本(不经 setup.ps1 入口,避免 UAC 自提权弹窗与交互)
const UPGRADE_FLAGS = {
  "Kimi Code": "--kimi",
  "OpenAI Codex": "--codex",
};
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;

function upgradeSpec(providers, environment, windowsSetupScript) {
  const flags = (Array.isArray(providers) ? providers : [])
    .map((p) => UPGRADE_FLAGS[p])
    .filter(Boolean);
  if (flags.length === 0) return null;
  const repoRoot = path.join(__dirname, "..", "..", "..");
  // 数据源切到 Windows 环境时，升级目标也是 Windows 侧的 agent；
  // 脚本路径由后端以 UNC 形式给出（main.js 运行在 Windows 本地）。
  if (environment === "windows" && WSL_BACKEND) {
    if (typeof windowsSetupScript !== "string" || !windowsSetupScript) return null;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowsSetupScript, ...flags],
    };
  }
  if (WSL_BACKEND) {
    if (!WSL_DISTRO || !WSL_MONITOR_SCRIPT) return null;
    // .../linux/ai-tools/usage-monitor/usage_monitor.py → .../linux/ai-tools/setup_ai_tools.sh
    const setupScript = WSL_MONITOR_SCRIPT.replace(
      /usage-monitor\/usage_monitor\.py$/, "setup_ai_tools.sh");
    if (setupScript === WSL_MONITOR_SCRIPT) return null;
    // wsl.exe --exec 默认不读 .bashrc，会绕过 NVM 并调到系统 npm，
    // 结果是“安装命令成功”却升级了另一个全局目录。交互式
    // bash 会加载用户的 NVM/PATH；位置参数传脚本和 flags，不拼 shell 字符串。
    return {
      command: "wsl.exe",
      args: [
        "-d", WSL_DISTRO, "--exec", "bash", "-ic",
        'exec bash "$1" "${@:2}"', "ai-usage-upgrade", setupScript, ...flags,
      ],
    };
  }
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(repoRoot, "windows", "ai-tools", "setup_ai_tools.ps1"), ...flags],
    };
  }
  return { command: "bash", args: [path.join(repoRoot, "linux", "ai-tools", "setup_ai_tools.sh"), ...flags] };
}

ipcMain.handle("upgrade-agents", (_event, providers, environment, windowsSetupScript) => new Promise((resolve) => {
  const spec = upgradeSpec(providers, environment, windowsSetupScript);
  if (!spec) {
    resolve({ ok: false, error: "no upgradable target" });
    return;
  }
  const child = spawn(spec.command, spec.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    child.kill();
    finish({ ok: false, error: `upgrade timed out after ${UPGRADE_TIMEOUT_MS / 60000}min` });
  }, UPGRADE_TIMEOUT_MS);
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  child.on("error", (err) => finish({ ok: false, error: err.message }));
  child.on("close", async (code) => {
    if (settled) return;
    if (code !== 0) {
      finish({ ok: false, error: `exit ${code}: ${output.trim().slice(-300)}` });
      return;
    }
    // 等到后端重新探测 CLI 版本并推送到渲染层后再报成功，
    // 避免浮层显示完成时旧版本箭头仍留在页面上。
    await pushUsage();
    finish({ ok: true });
  });
}));
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

if (gotLock) app.whenReady().then(createWindow);

// 窗口关闭即退出进程,终端里 Ctrl+E 可重新拉起
app.on("window-all-closed", () => app.quit());
