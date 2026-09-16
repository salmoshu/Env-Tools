// Env-Tools 桌面应用主进程：Electron 外壳 + 本地 Rust API 网关编排。
//
// v0.3.0 起整个 Env-Tools 收敛为一个 Electron 应用（React 渲染层，构建产物在
// ../dist）。两个窗口：
//   - 全量窗口 "Env-Tools"（默认）：会话用量分析 + 套餐配额 + Tools 组件管理
//   - 用量看板 "AI Usage Monitor"（小悬浮窗）：紧凑配额 + 设置页
// 数据链路：渲染层只走 IPC；主进程优先请求 Rust 后端（axum，WSL 内运行，
// localhost 转发），后端不可用时回退为直接调 usage_monitor.py，两条路径
// 的参数与数据契约完全一致。

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.join(__dirname, "..", "..");
// 打包版（GitHub Release）把数据引擎放进包内 backend/；仓库开发布局则指向
// linux/ai-tools 下的源文件，两条路径按存在性自动选择。
const PACKED_MONITOR = path.join(__dirname, "..", "backend", "usage_monitor.py");
const MONITOR_SCRIPT = fs.existsSync(PACKED_MONITOR)
  ? PACKED_MONITOR
  : path.join(REPO_ROOT, "linux", "ai-tools", "usage-monitor", "usage_monitor.py");
const BACKEND_BINARY = path.join(
  REPO_ROOT, "app", "backend-rs", "target", "release", "env-tools-api");
const BACKEND_PORT_DEFAULT = 8747;
const REFRESH_INTERVAL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 45 * 1000;
const SETTINGS_TIMEOUT_MS = 10 * 1000;
const ANALYTICS_TIMEOUT_MS = 180 * 1000;
const WINDOW_TITLE = "AI Usage Monitor";
// 全量窗口标题必须与用量看板不同：WSLg 置顶通过 powershell 按标题匹配窗口，
// 标题相同会把另一个窗口也一起置顶
const DASHBOARD_TITLE = "Env-Tools";
const MIN_CONTENT_HEIGHT = 140;
// WSLg 下 Electron 的 alwaysOnTop 不会穿透到 Windows 窗口管理器,
// 需要通过 powershell.exe 调 SetWindowPos 在 Windows 侧置顶
const IS_WSL = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
const WSL_BACKEND = process.env.AI_USAGE_MONITOR_BACKEND === "wsl";
let WSL_DISTRO = process.env.AI_USAGE_MONITOR_WSL_DISTRO || "";
const WSL_MONITOR_SCRIPT = process.env.AI_USAGE_MONITOR_WSL_SCRIPT || "";

if (process.platform === "win32") {
  app.setAppUserModelId("EnvTools");
}

let mainWin = null;
let boardWin = null;
let refreshTimer = null;
let usageFetchPromise = null;
// Rust 后端（axum）状态：Electron 只负责拉起与健康探测，数据请求失败时
// 自动回退 python 直连，不阻塞界面。
let backendPort = 0;
let backendChild = null;
// 置顶期间周期性补挂 WS_EX_TOPMOST 的巡检定时器：
// WSLg 的 RAIL 窗口在焦点切换、尺寸变化等场景下可能重建或重排 Z 序，
// 导致之前用 SetWindowPos 设置的置顶样式丢失（表现：切应用后看板被盖住，
// 拖动一下窗口又恢复）。
let pinWatchdog = null;
// 用户手动拖过高度后暂停自动贴合;拖回接近自然高度时恢复
let manualHeight = false;
let programmaticResize = false;

// --- Rust 后端（env-tools-api） ---------------------------------------------

function wslBackendBinary() {
  // WSL_MONITOR_SCRIPT 形如 <repo>/linux/ai-tools/usage-monitor/usage_monitor.py
  const marker = "/linux/ai-tools/usage-monitor/usage_monitor.py";
  if (!WSL_MONITOR_SCRIPT.includes(marker)) return "";
  const repo = WSL_MONITOR_SCRIPT.slice(0, WSL_MONITOR_SCRIPT.indexOf(marker));
  return `${repo}/app/backend-rs/target/release/env-tools-api`;
}

function nativeBackendBinary() {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidate = `${BACKEND_BINARY}${suffix}`;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    return "";
  }
}

function backendSpec() {
  if (WSL_BACKEND) {
    if (process.platform !== "win32" || !WSL_DISTRO || !WSL_MONITOR_SCRIPT) return null;
    const binary = wslBackendBinary();
    if (!binary) return null;
    return {
      command: "wsl.exe",
      args: [
        "-d", WSL_DISTRO, "--exec", binary,
        "--port", String(BACKEND_PORT_DEFAULT),
        "--monitor", WSL_MONITOR_SCRIPT,
      ],
    };
  }
  const binary = nativeBackendBinary();
  if (!binary) return null;
  return {
    command: binary,
    args: [
      "--port", String(BACKEND_PORT_DEFAULT),
      "--monitor", MONITOR_SCRIPT,
    ],
  };
}

function startBackend() {
  const spec = backendSpec();
  if (!spec) return;
  try {
    backendChild = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let buffer = "";
    const onData = (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        const match = /^LISTENING (\d+)$/.exec(line);
        if (match) {
          backendPort = Number(match[1]);
          console.log(`[backend] env-tools-api listening on 127.0.0.1:${backendPort}`);
        }
      }
    };
    backendChild.stdout.on("data", onData);
    backendChild.on("close", () => {
      // 后端退出（或被单实例回收）后回到 python 直连模式
      if (backendChild) backendPort = 0;
    });
    backendChild.on("error", () => {
      backendPort = 0;
    });
  } catch {
    backendPort = 0;
  }
}

function stopBackend() {
  if (!backendChild) return;
  try { backendChild.kill(); } catch { /* 已退出 */ }
  backendChild = null;
  backendPort = 0;
}

async function backendFetch(pathname, timeoutMs = ANALYTICS_TIMEOUT_MS + 15000) {
  if (!backendPort) throw new Error("backend not running");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}${pathname}`, {
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// --- 窗口置顶（WSLg 需要在 Windows 侧补挂样式） ------------------------------

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

// 单实例:再次启动时聚焦已有窗口而不是开新窗口
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

// --- 数据引擎（python）与广播 -------------------------------------------------

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
      resolve({ error: "Invalid backend configuration" });
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

async function runMonitorJson(args, input = "", timeoutMs = SETTINGS_TIMEOUT_MS) {
  const run = await runMonitor(args, { input, timeoutMs });
  if (run.error) return { ok: false, error: run.error };
  if (run.timedOut) return { ok: false, error: "Request timed out" };
  try {
    return JSON.parse(run.stdout);
  } catch {
    return {
      ok: false,
      error: `Request failed (exit ${run.code}): ${run.stderr.trim() || run.stdout.trim()}`,
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

// --- 窗口创建 -----------------------------------------------------------------

// 全量窗口（默认）：用量分析 + 套餐配额 + Tools 组件管理（React 内部路由切换）
function createDashboardWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 760,
    minHeight: 520,
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
  });
  mainWin.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "dashboard" });
  mainWin.setTitle(DASHBOARD_TITLE);
  mainWin.on("closed", () => (mainWin = null));
  // 页面加载完成（含刷新）后立即推一次数据；定时广播最快 60s 后才有下一轮
  mainWin.webContents.on("did-finish-load", () => pushUsage());
  mainWin.on("blur", () => {
    if (mainWin && mainWin.isAlwaysOnTop()) applyWindowsTopmost(true, 1, DASHBOARD_TITLE);
  });
}

// 用量看板（小悬浮窗）：按需从全量模式打开，可置顶，设置页住在这里
function createBoardWindow() {
  boardWin = new BrowserWindow({
    width: 420,
    height: 480,
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
  });
  boardWin.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "board" });
  boardWin.setTitle(WINDOW_TITLE);
  boardWin.on("closed", () => (boardWin = null));
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

// --- IPC：窗口与数据 -----------------------------------------------------------

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
// 全量窗口 ⇄ 用量看板：互相打开对方窗口；设置页统一住在用量看板窗口里
ipcMain.handle("open-usage-board", async () => {
  await focusWindow(() => boardWin, createBoardWindow);
});
ipcMain.handle("open-full-dashboard", async () => {
  const window = await focusWindow(() => mainWin, createDashboardWindow);
  if (window) window.webContents.send("navigate", "dashboard");
});
ipcMain.handle("open-tools", async () => {
  const window = await focusWindow(() => mainWin, createDashboardWindow);
  if (window) window.webContents.send("navigate", "tools");
});
ipcMain.handle("open-board-settings", async () => {
  const window = await focusWindow(() => boardWin, createBoardWindow);
  if (window) window.webContents.send("open-settings");
});
// 分析数据：Rust 后端优先（单飞缓存），失败回退 python 直连
// --- 连接目标（v0.4.0 Connection 概念） --------------------------------------
// 以“当前所在系统”为主（local agent），其余目标（WSL 发行版、SSH 主机，v0.5.0）
// 通过自举把 agent 二进制部署到目标侧后走 HTTP。Windows 应用从此不再依赖
// “先把仓库部署进 WSL”。
const WSL_AGENT_PORT = 19100;
const wslAgents = new Map(); // distro → { port, ready }

function findLinuxAgentBinary() {
  // 打包版：resources/app/agent/env-agent-linux（package.mjs 嵌入）
  const packed = path.join(__dirname, "..", "agent", "env-agent-linux");
  if (fs.existsSync(packed)) return packed;
  // 开发版：仓库构建产物
  const dev = path.join(REPO_ROOT, "app", "backend-rs", "target", "release", "env-tools-api");
  return fs.existsSync(dev) ? dev : "";
}

function wslCommand(distro, args, { input = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn("wsl.exe", ["-d", distro, "--exec", "bash", "-c", ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ error: "wsl command timed out" });
    }, timeoutMs);
    child.stdin.on("error", () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.on("error", (err) => finish({ error: err.message }));
    child.on("close", (code) => finish({ code, stdout: stdout.trim() }));
  });
}

async function wslAgentHealth(distro) {
  const entry = wslAgents.get(distro);
  if (entry && entry.ready) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${WSL_AGENT_PORT}/api/health`, {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return true;
    } catch {}
  }
  // 进程可能在控制器重启后仍存活（WSL VM 常驻）：直接探测端口
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`http://127.0.0.1:${WSL_AGENT_PORT}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      wslAgents.set(distro, { port: WSL_AGENT_PORT, ready: true });
      return true;
    }
  } catch {}
  return false;
}

async function ensureWslAgent(distro) {
  if (await wslAgentHealth(distro)) return { ok: true, port: WSL_AGENT_PORT };
  const binary = findLinuxAgentBinary();
  if (!binary) {
    return { ok: false, error: "agent binary not found (build backend-rs for linux first)" };
  }
  const monitor = WSL_MONITOR_SCRIPT || path.join(REPO_ROOT, "linux", "ai-tools", "usage-monitor", "usage_monitor.py");
  // 自举 stage 1：把 agent 二进制与数据引擎脚本写入 WSL 用户目录
  const copyBinary = await wslCommand(
    distro,
    ["mkdir -p ~/.local/share/env-tools && cat > ~/.local/share/env-tools/env-agent && chmod +x ~/.local/share/env-tools/env-agent"],
    { input: fs.readFileSync(binary) },
  );
  if (copyBinary.error) return { ok: false, error: `bootstrap copy failed: ${copyBinary.error}` };
  await wslCommand(
    distro,
    ["mkdir -p ~/.local/share/env-tools && cat > ~/.local/share/env-tools/usage_monitor.py"],
    { input: fs.readFileSync(monitor) },
  );
  // stage 2：detached 启动 agent（WSL VM 常驻期间保持运行）
  const started = await wslCommand(
    distro,
    ["nohup ~/.local/share/env-tools/env-agent --port 19100 --monitor ~/.local/share/env-tools/usage_monitor.py >~/.local/share/env-tools/agent.log 2>&1 & disown; sleep 1; echo started"],
    { timeoutMs: 20000 },
  );
  if (started.error) return { ok: false, error: `agent start failed: ${started.error}` };
  // stage 3：健康检查（localhost 经 WSL2 端口转发可达）
  for (let attempt = 0; attempt < 6; attempt++) {
    if (await wslAgentHealth(distro)) return { ok: true, port: WSL_AGENT_PORT };
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { ok: false, error: "agent did not become healthy inside WSL (see ~/.local/share/env-tools/agent.log)" };
}

ipcMain.handle("list-targets", async () => {
  const targets = [{ id: "local", label: "This machine", kind: "local", ready: Boolean(backendPort) }];
  if (process.platform === "win32" || IS_WSL) {
    try {
      const raw = await new Promise((resolve) => {
        const child = spawn("wsl.exe", ["--list", "--quiet"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
        let out = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.on("error", () => resolve(""));
        child.on("close", () => resolve(out));
        setTimeout(() => resolve(out), 8000);
      });
      const distros = raw
        .replace(/\0/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      for (const distro of distros) {
        targets.push({
          id: `wsl:${distro}`,
          label: `WSL · ${distro}`,
          kind: "wsl",
          distro,
          ready: wslAgents.get(distro)?.ready || false,
        });
      }
    } catch {}
  }
  return { ok: true, targets };
});
ipcMain.handle("connect-target", async (_event, targetId) => {
  if (targetId === "local") return { ok: true };
  if (targetId.startsWith("wsl:")) {
    const result = await ensureWslAgent(targetId.slice(4));
    return result;
  }
  return { ok: false, error: `unknown target: ${targetId}` };
});
ipcMain.handle("get-analytics", async (_event, days, agent, targetId) => {
  const query = `?days=${encodeURIComponent(days || 30)}&agent=${encodeURIComponent(agent || "all")}`;
  // WSL 目标：自举并请求 WSL 内的 agent（原生引擎，无需仓库路径）
  if (targetId && targetId.startsWith("wsl:")) {
    const distro = targetId.slice(4);
    const ensured = await ensureWslAgent(distro);
    if (ensured.ok) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), ANALYTICS_TIMEOUT_MS);
        const res = await fetch(`http://127.0.0.1:${ensured.port}/api/analytics${query}`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) return await res.json();
      } catch {}
      return { ok: false, error: `WSL agent for ${distro} is unreachable` };
    }
    return ensured;
  }
  try {
    const payload = await backendFetch(`/api/analytics${query}`);
    if (payload && payload.ok !== false) return payload;
    // 后端明确返回错误（如数据目录缺失）也直接透传
    return payload;
  } catch {
    const windowDays = Math.max(1, Math.min(365, Number(days) || 30));
    const agentArg = ["all", "kimi", "codex", "glm", "deepseek"].includes(agent) ? agent : "all";
    const run = await runMonitor(
      ["--json", "--analytics", "--days", String(windowDays), "--agent", agentArg],
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
  }
});
ipcMain.handle("get-backend-status", async () => {
  const info = { running: Boolean(backendPort), port: backendPort, engine: "python3 (direct)" };
  if (backendPort) {
    try {
      const status = await backendFetch("/api/backend-status", 20000);
      return { ...info, running: true, engine: `env-tools-api (rust) → ${status.engine || "python3"}`, detail: status };
    } catch (err) {
      return { ...info, engine: `env-tools-api unreachable: ${err.message}` };
    }
  }
  return info;
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
        'exec "$@"', "env-tools-login", commandName, "login",
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

// --- 安装/升级脚本运行器（看板版本徽章升级 + Tools 组件安装共用） ---------------
// 直接调组件安装脚本(不经 setup.ps1 入口,避免 UAC 自提权弹窗与交互)
const UPGRADE_FLAGS = {
  "Kimi Code": "--kimi",
  "OpenAI Codex": "--codex",
};
const COMPONENT_FLAGS = {
  kimi: "--kimi",
  codex: "--codex",
};
// 下载速度不可控（code.kimi.com 可能被限速到几十 KB/s），给足 20min；
// 完全停滞由 setup 脚本自检（60s 无进展）提前中止，不会真等满超时
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
// 当前在跑的安装子进程，供"取消"终止；一次只允许一个
let installChild = null;
let installCancelled = false;

// POSIX 下子进程独立进程组（detached），整组 SIGTERM 才能清理到
// 安装脚本内部的 curl 等孙子进程；Windows/WSL 路径保持杀直接子进程
function killInstallTree(child) {
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

function repoScriptPath(relative) {
  // WSL 后端下 Electron 运行在 Windows 侧，仓库路径由后端脚本路径推导；
  // 本地运行直接拼 REPO_ROOT。relative 形如 "/setup.sh"、"/tools.sh"。
  const marker = "/linux/ai-tools/usage-monitor/usage_monitor.py";
  if (WSL_MONITOR_SCRIPT.includes(marker)) {
    const repo = WSL_MONITOR_SCRIPT.slice(0, WSL_MONITOR_SCRIPT.indexOf(marker));
    return `${repo}${relative}`;
  }
  return path.join(REPO_ROOT, relative.replace(/^\//, ""));
}

// 数据源切到 Windows 环境时，安装目标也是 Windows 侧；脚本路径由后端以
// UNC 形式给出（main.js 运行在 Windows 本地）。
function windowsSetupScriptFor(kind, windowsSetupScript) {
  if (typeof windowsSetupScript !== "string" || !windowsSetupScript) return "";
  if (kind === "ai-tools") return windowsSetupScript;
  return windowsSetupScript.replace(
    /\\windows\\ai-tools\\setup_ai_tools\.ps1$/i, "\\setup.ps1");
}

function aiToolsSpec(flags, environment, windowsSetupScript) {
  if (environment === "windows" && WSL_BACKEND) {
    const script = windowsSetupScriptFor("ai-tools", windowsSetupScript);
    if (!script) return null;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...flags],
    };
  }
  if (WSL_BACKEND) {
    if (!WSL_DISTRO || !WSL_MONITOR_SCRIPT) return null;
    // wsl.exe --exec 默认不读 .bashrc，会绕过 NVM 并调到系统 npm/node，
    // 交互式 bash 会加载用户的 NVM/PATH；位置参数传脚本和参数，不拼 shell 字符串。
    return {
      command: "wsl.exe",
      args: [
        "-d", WSL_DISTRO, "--exec", "bash", "-ic",
        'exec bash "$1" "${@:2}"', "env-tools-install",
        repoScriptPath("/linux/ai-tools/setup_ai_tools.sh"), ...flags,
      ],
    };
  }
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(REPO_ROOT, "windows", "ai-tools", "setup_ai_tools.ps1"), ...flags],
    };
  }
  return {
    command: "bash",
    args: [path.join(REPO_ROOT, "linux", "ai-tools", "setup_ai_tools.sh"), ...flags],
  };
}

function componentSpec(component, environment, windowsSetupScript) {
  // 通用组件：repo 根 setup 脚本 + 组件名位置参数（setup.sh nodejs / setup.ps1 nodejs）
  if (environment === "windows" && WSL_BACKEND) {
    const script = windowsSetupScriptFor(component, windowsSetupScript);
    if (!script) return null;
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, component],
    };
  }
  if (WSL_BACKEND) {
    if (!WSL_DISTRO || !WSL_MONITOR_SCRIPT) return null;
    return {
      command: "wsl.exe",
      args: [
        "-d", WSL_DISTRO, "--exec", "bash", "-ic",
        'exec bash "$1" "${@:2}"', "env-tools-install",
        repoScriptPath("/setup.sh"), component,
      ],
    };
  }
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(REPO_ROOT, "setup.ps1"), component],
    };
  }
  return { command: "bash", args: [path.join(REPO_ROOT, "setup.sh"), component] };
}

function installSpec(kind, targets, environment, windowsSetupScript) {
  if (kind === "upgrade") {
    // 看板版本徽章升级：targets 是 provider 名（"Kimi Code" 等）
    const flags = (Array.isArray(targets) ? targets : [])
      .map((p) => UPGRADE_FLAGS[p])
      .filter(Boolean);
    if (flags.length === 0) return null;
    return aiToolsSpec(flags, environment, windowsSetupScript);
  }
  if (kind === "ai-tools") {
    const flags = (Array.isArray(targets) ? targets : [targets])
      .map((t) => COMPONENT_FLAGS[t])
      .filter(Boolean);
    if (flags.length === 0) return null;
    return aiToolsSpec(flags, environment, windowsSetupScript);
  }
  return componentSpec(String(targets), environment, windowsSetupScript);
}

// runs 统一入口：spawn 安装脚本，按行推送输出，可取消，超时兜底
function startInstall(runKey, spec) {
  return new Promise((resolve) => {
    if (installChild) {
      resolve({ ok: false, error: "another install is already running" });
      return;
    }
    const child = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    installChild = child;
    installCancelled = false;
    let output = "";
    let lineBuf = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      installChild = null;
      resolve(result);
    };
    const timer = setTimeout(() => {
      killInstallTree(child);
      finish({ ok: false, error: `install timed out after ${INSTALL_TIMEOUT_MS / 60000}min` });
    }, INSTALL_TIMEOUT_MS);
    // 安装脚本输出按行实时推给浮层（脚本在非 TTY 下逐行流式输出，
    // 含下载进度心跳），同时累积尾部供失败时诊断
    const feedLines = (chunk) => {
      output += chunk;
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx).replace(/\r$/, "");
        lineBuf = lineBuf.slice(idx + 1);
        if (line.trim()) {
          for (const w of liveWindows()) {
            w.webContents.send("install-progress", { key: runKey, line });
          }
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
          w.webContents.send("install-progress", { key: runKey, line: lineBuf.trim() });
        }
      }
      if (code !== 0) {
        finish({
          ok: false,
          error: installCancelled ? "cancelled" : `exit ${code}: ${output.trim().slice(-300)}`,
        });
        return;
      }
      // 等到数据引擎重新探测 CLI 版本并推送到渲染层后再报成功，
      // 避免浮层显示完成时旧版本徽章仍留在页面上。
      await pushUsage();
      finish({ ok: true });
    });
  });
}

ipcMain.handle("upgrade-agents", (_event, providers, environment, windowsSetupScript) => {
  const spec = installSpec("upgrade", providers, environment, windowsSetupScript);
  if (!spec) return Promise.resolve({ ok: false, error: "no upgradable target" });
  return startInstall("upgrade", spec);
});
ipcMain.handle("run-component", (_event, component, environment, windowsSetupScript) => {
  const spec = installSpec(String(component), component, environment, windowsSetupScript);
  if (!spec) return Promise.resolve({ ok: false, error: "no installable target for this component" });
  return startInstall(`component:${component}`, spec);
});
ipcMain.handle("install-cancel", () => {
  if (!installChild) return false;
  installCancelled = true;
  killInstallTree(installChild);
  return true;
});
ipcMain.handle("component-status", async (_event, component, environment) => {
  // 目前只有 openssh 有 status 子命令；其余组件的“状态”由安装结果体现
  if (component !== "openssh") return { ok: false, error: "no status command" };
  const timeoutMs = 30 * 1000;
  return new Promise((resolve) => {
    let spec;
    if (environment === "windows" && WSL_BACKEND) {
      spec = { command: "powershell.exe", args: ["-NoProfile", "-Command",
        "Get-Service sshd | Select-Object -Property Status,StartType | Format-List"] };
    } else if (WSL_BACKEND) {
      if (!WSL_DISTRO) {
        resolve({ ok: false, error: "missing WSL distro" });
        return;
      }
      spec = { command: "wsl.exe", args: ["-d", WSL_DISTRO, "--exec", "bash", "-ic",
        'exec bash "$1" "${@:2}"', "env-tools-status",
        repoScriptPath("/tools.sh"), "openssh", "--status"] };
    } else {
      spec = { command: "bash", args: [path.join(REPO_ROOT, "tools.sh"), "openssh", "--status"] };
    }
    const child = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (out += String(d)));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) => resolve({ ok: code === 0 || out.trim().length > 0, output: out.trim() }));
    setTimeout(() => {
      try { child.kill(); } catch {}
      resolve({ ok: false, error: "timed out", output: out.trim() });
    }, timeoutMs);
  });
});

if (gotLock) {
  app.whenReady().then(async () => {
    if (WSL_BACKEND) {
      const settings = await runMonitorJson(["--get-settings"]);
      if (settings && settings.ok && settings.environment === "wsl" && typeof settings.wsl_distro === "string") {
        WSL_DISTRO = settings.wsl_distro;
      }
    }
    startBackend();
    // v0.3.0 起默认打开全量窗口；用量看板与 Tools 都在其中打开
    createDashboardWindow();
    pushUsage();
    refreshTimer = setInterval(pushUsage, REFRESH_INTERVAL_MS);
  });
}

app.on("before-quit", () => stopBackend());
// 窗口关闭即退出进程,终端里 Ctrl+E 可重新拉起
app.on("window-all-closed", () => app.quit());
