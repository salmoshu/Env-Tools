const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

const MONITOR_SCRIPT = path.join(__dirname, "..", "usage_monitor.py");
const REFRESH_INTERVAL_MS = 60 * 1000;
// 单轮刷新上限：Codex 经代理访问 chatgpt.com 享有双倍单次超时（20s×2 次，
// 最坏约 41s），其余 provider 为 10s×2；留少量余量给进程启动与版本检测。
const FETCH_TIMEOUT_MS = 45 * 1000;
const SETTINGS_TIMEOUT_MS = 10 * 1000;
// 全量模式分析需要扫描本地会话日志；首次全量扫描大日志可能较慢，放宽超时
const ANALYTICS_TIMEOUT_MS = 120 * 1000;
const WINDOW_TITLE = "AI Usage Monitor";
// 全量窗口标题必须与用量看板不同：WSLg 置顶通过 powershell 按标题匹配窗口，
// 标题相同会把另一个窗口也一起置顶
const DASHBOARD_TITLE = "AI Usage Dashboard";
const MIN_CONTENT_HEIGHT = 140;
// WSLg 下 Electron 的 alwaysOnTop 不会穿透到 Windows 窗口管理器,
// 需要通过 powershell.exe 调 SetWindowPos 在 Windows 侧置顶
const IS_WSL = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
const WSL_BACKEND = process.env.AI_USAGE_MONITOR_BACKEND === "wsl";
let WSL_DISTRO = process.env.AI_USAGE_MONITOR_WSL_DISTRO || "";
const WSL_MONITOR_SCRIPT = process.env.AI_USAGE_MONITOR_WSL_SCRIPT || "";

if (process.platform === "win32") {
  app.setAppUserModelId("AIUsageMonitor");
}

let mainWin = null;
let boardWin = null;
let refreshTimer = null;
let usageFetchPromise = null;
// 单实例:再次启动(Ctrl+E)时聚焦已有窗口而不是开新窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = mainWin || boardWin;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
}
// 置顶期间周期性补挂 WS_EX_TOPMOST 的巡检定时器：
// WSLg 的 RAIL 窗口在焦点切换、尺寸变化等场景下可能重建或重排 Z 序，
// 导致之前用 SetWindowPos 设置的置顶样式丢失（表现：切应用后看板被盖住，
// 拖动一下窗口又恢复）。
let pinWatchdog = null;
// 用户手动拖过高度后暂停自动贴合;拖回接近自然高度时恢复
let manualHeight = false;
let programmaticResize = false;

function applyWindowsTopmost(topmost, attemptsLeft = 5, title = WINDOW_TITLE) {
  if (!IS_WSL) return;
  const script = path.join(__dirname, "set-topmost.ps1");
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script,
     "-Title", title, "-Topmost", topmost ? "1" : "0"],
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
      setTimeout(() => applyWindowsTopmost(topmost, attemptsLeft - 1, title), 800);
    }
  });
}

function liveWindows() {
  return [mainWin, boardWin].filter((w) => w && !w.isDestroyed());
}

function anyPinned() {
  return liveWindows().some((w) => w.isAlwaysOnTop());
}

function startPinWatchdog() {
  if (!IS_WSL || pinWatchdog) return;
  // 置顶样式丢失无法从 Linux 侧感知，只能周期性补挂；
  // set-topmost.ps1 对已置顶的窗口跳过 SetWindowPos，不会抢焦点。
  pinWatchdog = setInterval(() => {
    for (const w of liveWindows()) {
      if (w.isAlwaysOnTop()) applyWindowsTopmost(true, 1, w.getTitle());
    }
  }, 5000);
}

function stopPinWatchdog() {
  if (pinWatchdog) {
    clearInterval(pinWatchdog);
    pinWatchdog = null;
  }
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
  if (liveWindows().length === 0) return null;
  // 定时刷新、手动刷新和升级后刷新可能同时到达；复用同一
  // 个在途请求，避免重复后端进程互相抢网络导致假超时。
  if (usageFetchPromise) return usageFetchPromise;
  usageFetchPromise = (async () => {
    const result = await fetchUsage();
    for (const w of liveWindows()) w.webContents.send("usage-update", result);
    return result;
  })();
  try {
    return await usageFetchPromise;
  } finally {
    usageFetchPromise = null;
  }
}

function createWindow(options, htmlFile, title) {
  const window = new BrowserWindow(options);
  window.loadFile(path.join(__dirname, htmlFile));
  window.setTitle(title);
  return window;
}

// 全量模式（默认主窗口）：用量分析看板 + 配额总览
function createDashboardWindow() {
  mainWin = createWindow({
    width: 1160,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    useContentSize: true,
    frame: false,
    alwaysOnTop: false,
    resizable: true,
    skipTaskbar: false,
    backgroundColor: "#10131a",
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "logo.ico" : "logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }, "dashboard.html", DASHBOARD_TITLE);
  mainWin.on("closed", () => (mainWin = null));
  // 页面加载完成（含刷新）后立即推一次数据；定时广播最快 60s 后才有下一轮
  mainWin.webContents.on("did-finish-load", () => pushUsage());
  mainWin.on("blur", () => {
    if (mainWin && mainWin.isAlwaysOnTop()) applyWindowsTopmost(true, 1, DASHBOARD_TITLE);
  });
}

// 用量看板（小悬浮窗）：按需从全量模式打开，可置顶
function createBoardWindow() {
  boardWin = createWindow({
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
    icon: path.join(__dirname, "assets", process.platform === "win32" ? "logo.ico" : "logo.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }, "index.html", WINDOW_TITLE);
  boardWin.on("closed", () => (boardWin = null));
  // 与全量窗口相同：加载完成（含刷新）后立即补推一次数据
  boardWin.webContents.on("did-finish-load", () => pushUsage());
  // 窗口失焦(用户切到其它应用)时立即补挂一次置顶;
  // 已置顶时脚本侧直接跳过,不会把窗口抢回前台
  boardWin.on("blur", () => {
    if (boardWin && boardWin.isAlwaysOnTop()) applyWindowsTopmost(true, 1, WINDOW_TITLE);
  });
  // 用户手动调整高度后,暂停数据刷新带来的自动贴合;
  // WSLg 不一定遵守 minHeight,程序强制最小高度(防止拉成一条线)
  boardWin.on("resize", () => {
    if (!boardWin) return;
    const [width, height] = boardWin.getContentSize();
    if (height < MIN_CONTENT_HEIGHT) {
      programmaticResize = true;
      boardWin.setContentSize(width, MIN_CONTENT_HEIGHT);
      setTimeout(() => (programmaticResize = false), 150);
      manualHeight = true;
      return;
    }
    if (!programmaticResize) manualHeight = true;
  });
}

async function focusWindow(getter, creator) {
  const existing = getter();
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  creator();
  const created = getter();
  if (!created) return null;
  // 新窗口首屏数据由 did-finish-load 里的 pushUsage 补推
  await new Promise((resolve) => {
    if (created.webContents.isLoading()) {
      created.webContents.once("did-finish-load", resolve);
    } else {
      resolve();
    }
  });
  return created;
}

// 最小化/关闭/置顶都作用于发起调用的窗口（全量窗口与用量看板各有标题栏）
function senderWindow(event) {
  const window = BrowserWindow.fromWebContents(event.sender);
  return window && !window.isDestroyed() ? window : null;
}

ipcMain.on("window-minimize", (event) => {
  const window = senderWindow(event);
  if (window) window.minimize();
});
ipcMain.on("window-close", (event) => {
  const window = senderWindow(event);
  if (window) window.close();
});
ipcMain.on("refresh", () => pushUsage());
// 全量模式 ⇄ 用量看板：互相打开对方窗口；设置页统一住在用量看板窗口里
ipcMain.handle("open-usage-board", async () => {
  await focusWindow(() => boardWin, createBoardWindow);
});
ipcMain.handle("open-full-dashboard", async () => {
  await focusWindow(() => mainWin, createDashboardWindow);
});
ipcMain.handle("open-board-settings", async () => {
  const window = await focusWindow(() => boardWin, createBoardWindow);
  if (window) window.webContents.send("open-settings");
});
// 全量模式分析数据：扫描本地会话日志（无网络请求），按天窗口取数
let analyticsFetchPromise = null;
ipcMain.handle("get-analytics", async (_event, days) => {
  // 复用在途请求：开窗、定时器与手动刷新同时到达时只扫一次
  if (analyticsFetchPromise) return analyticsFetchPromise;
  const windowDays = Math.max(1, Math.min(365, Number(days) || 30));
  const request = (async () => {
    const run = await runMonitor(
      ["--json", "--analytics", "--days", String(windowDays)],
      { timeoutMs: ANALYTICS_TIMEOUT_MS },
    );
    if (run.error) return { ok: false, error: run.error };
    if (run.timedOut) {
      return { ok: false, error: `Analytics timed out after ${ANALYTICS_TIMEOUT_MS / 1000}s` };
    }
    try {
      return JSON.parse(run.stdout);
    } catch {
      return {
        ok: false,
        error: `Analytics failed (exit ${run.code}): ${(run.stderr || run.stdout).trim().slice(-300)}`,
      };
    }
  })();
  analyticsFetchPromise = request;
  try {
    return await request;
  } finally {
    if (analyticsFetchPromise === request) analyticsFetchPromise = null;
  }
});
ipcMain.handle("api-key-status", () => runMonitorJson(["--api-key-status"]));
// 设置页：读取/保存后端设置（数据源环境等）；保存成功后立即刷新看板
ipcMain.handle("get-settings", () => runMonitorJson(["--get-settings"]));
ipcMain.handle("set-settings", async (_event, values) => {
  const result = await runMonitorJson(["--set-settings"], JSON.stringify(values || {}));
  if (result && result.ok) {
    const settings = result.settings || {};
    if (WSL_BACKEND && settings.environment === "wsl" && typeof settings.wsl_distro === "string") {
      WSL_DISTRO = settings.wsl_distro;
    }
    await pushUsage();
  }
  return result;
});
// 设置页和看板共用窗口宽度；切页时允许高度重新贴合内容
ipcMain.on("settings-open", () => {
  manualHeight = false;
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

const LOGIN_AGENTS = {
  kimi: "kimi",
  codex: "codex",
};

function loginSpec(agent, environment) {
  const commandName = LOGIN_AGENTS[agent];
  if (!commandName) return null;
  if (WSL_BACKEND && environment === "windows") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-Command", `${commandName} login`],
    };
  }
  if (WSL_BACKEND) {
    if (!WSL_DISTRO) return null;
    return {
      command: "wsl.exe",
      args: [
        "-d", WSL_DISTRO, "--exec", "bash", "-ic",
        'exec "$@"', "ai-usage-login", commandName, "login",
      ],
    };
  }
  return { command: commandName, args: ["login"] };
}

ipcMain.handle("login-agent", (_event, agent, environment) => new Promise((resolve) => {
  const selectedEnvironment = environment || (WSL_BACKEND ? "wsl" : "windows");
  const spec = loginSpec(agent, selectedEnvironment);
  if (!spec) {
    resolve({ ok: false, error: "unsupported login agent or missing WSL distro" });
    return;
  }
  try {
    const child = spawn(spec.command, spec.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", (err) => resolve({ ok: false, error: err.message }));
    child.once("spawn", () => {
      child.unref();
      resolve({ ok: true, agent });
    });
  } catch (err) {
    resolve({ ok: false, error: err.message });
  }
}));
// 切换筛选时清除手动高度状态,让窗口重新贴合内容(避免误触发紧凑折叠)
ipcMain.on("reset-fit", () => {
  manualHeight = false;
});
// 悬浮(置顶)开关：标题栏 pin 按钮切换，作用于发起调用的窗口
ipcMain.handle("toggle-pin", (event) => {
  const window = senderWindow(event);
  if (!window) return false;
  const next = !window.isAlwaysOnTop();
  window.setAlwaysOnTop(next);
  applyWindowsTopmost(next, 5, window.getTitle());
  if (next) startPinWatchdog(); else if (!anyPinned()) stopPinWatchdog();
  return next;
});
ipcMain.handle("get-pin-state", (event) => {
  const window = senderWindow(event);
  return window ? window.isAlwaysOnTop() : false;
});

// --- 看板内点击版本徽章触发升级 ---------------------------------------------
// 直接调组件安装脚本(不经 setup.ps1 入口,避免 UAC 自提权弹窗与交互)
const UPGRADE_FLAGS = {
  "Kimi Code": "--kimi",
  "OpenAI Codex": "--codex",
};
// 下载速度不可控（code.kimi.com 可能被限速到几十 KB/s），给足 20min；
// 完全停滞由 setup 脚本自检（60s 无进展）提前中止，不会真等满超时
const UPGRADE_TIMEOUT_MS = 20 * 60 * 1000;
// 当前在跑的升级子进程，供"取消升级"终止；一次只允许一个升级
let upgradeChild = null;
let upgradeCancelled = false;

// POSIX 下子进程独立进程组（detached），整组 SIGTERM 才能清理到
// install.sh 内部的 curl 等孙子进程；Windows/WSL 路径保持杀直接子进程
function killUpgradeTree(child) {
  if (process.platform === "win32") {
    try { child.kill(); } catch { /* 已退出 */ }
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill(); } catch { /* 已退出 */ }
  }
}

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
  if (upgradeChild) {
    resolve({ ok: false, error: "another upgrade is already running" });
    return;
  }
  const child = spawn(spec.command, spec.args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  upgradeChild = child;
  upgradeCancelled = false;
  let output = "";
  let lineBuf = "";
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    upgradeChild = null;
    resolve(result);
  };
  const timer = setTimeout(() => {
    killUpgradeTree(child);
    finish({ ok: false, error: `upgrade timed out after ${UPGRADE_TIMEOUT_MS / 60000}min` });
  }, UPGRADE_TIMEOUT_MS);
  // 安装脚本输出按行实时推给升级浮层（脚本在非 TTY 下逐行流式输出，
  // 含下载进度心跳），同时累积尾部供失败时诊断
  const feedLines = (chunk) => {
    output += chunk;
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, idx).replace(/\r$/, "");
      lineBuf = lineBuf.slice(idx + 1);
      if (line.trim()) {
        for (const w of liveWindows()) w.webContents.send("upgrade-progress", { line });
      }
    }
  };
  child.stdout.on("data", (d) => feedLines(String(d)));
  child.stderr.on("data", (d) => feedLines(String(d)));
  child.on("error", (err) => finish({ ok: false, error: err.message }));
  child.on("close", async (code) => {
    if (settled) return;
    if (lineBuf.trim()) {
      for (const w of liveWindows()) {
        w.webContents.send("upgrade-progress", { line: lineBuf.trim() });
      }
    }
    if (code !== 0) {
      finish({
        ok: false,
        error: upgradeCancelled ? "cancelled" : `exit ${code}: ${output.trim().slice(-300)}`,
      });
      return;
    }
    // 等到后端重新探测 CLI 版本并推送到渲染层后再报成功，
    // 避免浮层显示完成时旧版本箭头仍留在页面上。
    await pushUsage();
    finish({ ok: true });
  });
}));

// 浮层 Cancel：终止在跑的升级进程组，close 事件以 cancelled 收尾
ipcMain.handle("upgrade-cancel", () => {
  if (!upgradeChild) return false;
  upgradeCancelled = true;
  killUpgradeTree(upgradeChild);
  return true;
});
// 渲染层根据内容高度请求自适应窗口(保持小巧,不出现大片空白);
// 用户手动拖过高度则暂停自动贴合,拖回接近自然高度时恢复。
// 只有用量看板窗口使用高度贴合。
ipcMain.on("fit-height", (_event, height) => {
  if (!boardWin || boardWin.isDestroyed()) return;
  const clamped = Math.max(MIN_CONTENT_HEIGHT, Math.min(800, Math.ceil(height)));
  const [width, current] = boardWin.getContentSize();
  if (Math.abs(current - clamped) <= 6) {
    manualHeight = false;
    return;
  }
  if (manualHeight) return;
  programmaticResize = true;
  boardWin.setContentSize(width, clamped);
  setTimeout(() => (programmaticResize = false), 150);
});

if (gotLock) {
  app.whenReady().then(async () => {
    if (WSL_BACKEND) {
      const settings = await runMonitorJson(["--get-settings"]);
      if (settings && settings.ok && settings.environment === "wsl" && typeof settings.wsl_distro === "string") {
        WSL_DISTRO = settings.wsl_distro;
      }
    }
    // v0.2.0 起默认打开全量模式；用量看板通过全量模式里的按钮打开
    createDashboardWindow();
    pushUsage();
    refreshTimer = setInterval(pushUsage, REFRESH_INTERVAL_MS);
  });
}

// 窗口关闭即退出进程,终端里 Ctrl+E 可重新拉起
app.on("window-all-closed", () => app.quit());
