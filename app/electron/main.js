// Env-Tools 桌面应用主进程：Electron 外壳 + 本地 Rust API 网关编排。
//
// v0.3.0 起整个 Env-Tools 收敛为一个 Electron 应用（React 渲染层，构建产物在
// ../dist）。两个窗口：
//   - 全量窗口 "Env-Tools"（默认）：会话用量分析 + 套餐配额 + Tools 组件管理
//     + 设置页（v0.7.0 起为窗口内侧边栏视图）
//   - 用量看板 "AI Usage Monitor"（小悬浮窗）：紧凑配额，可置顶
// 数据链路（v0.7.0）：渲染层只走 IPC；数据全部由原生后端 env-tools-api
// （Rust + axum，配额/分析/设置全原生）提供，python 引擎已移除。

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");

const REPO_ROOT = path.join(__dirname, "..", "..");
// v0.7.0 起数据引擎全部原生（env-tools-api），python 引擎不再是依赖；
// WSL 启动器仍以 usage_monitor.py 路径标记 WSL 内的仓库位置。
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
// 开发模式（pnpm dev）：vite dev server 地址由 scripts/dev.mjs 注入，
// 窗口改走热更新；生产/常规启动仍加载 dist/ 静态产物
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || "";

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
      ],
    };
  }
  const binary = nativeBackendBinary();
  if (!binary) return null;
  return {
    command: binary,
    args: ["--port", String(BACKEND_PORT_DEFAULT)],
  };
}

function startBackend() {
  const spec = backendSpec();
  if (!spec) return;
  try {
    backendChild = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: spec.env,
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

async function backendFetch(pathname, timeoutMs = ANALYTICS_TIMEOUT_MS + 15000, body = null) {
  if (!backendPort) throw new Error("backend not running");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}${pathname}`, {
      signal: controller.signal,
      ...(body === null ? {} : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// 后端不可用时的统一降级：返回 ok:false 结构，由渲染层占位卡片呈现
async function backendJson(pathname, body = null, timeoutMs = SETTINGS_TIMEOUT_MS) {
  try {
    return await backendFetch(pathname, timeoutMs, body);
  } catch (err) {
    return { ok: false, error: err.message };
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

// --- 数据引擎（env-tools-api）与广播 ------------------------------------------

async function fetchUsage() {
  // v0.7.0 起配额只走原生后端；不可用时返回错误结构，由占位卡片呈现
  return backendJson("/api/usage", null, FETCH_TIMEOUT_MS);
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
  if (DEV_SERVER_URL) {
    mainWin.loadURL(`${DEV_SERVER_URL}#dashboard`);
  } else {
    mainWin.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "dashboard" });
  }
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
  if (DEV_SERVER_URL) {
    boardWin.loadURL(`${DEV_SERVER_URL}#board`);
  } else {
    boardWin.loadFile(path.join(__dirname, "..", "dist", "index.html"), { hash: "board" });
  }
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
ipcMain.handle("window-maximize-toggle", (event) => {
  const window = senderWindow(event);
  if (!window) return false;
  if (window.isMaximized()) {
    window.unmaximize();
    return false;
  }
  window.maximize();
  return true;
});
ipcMain.on("window-close", (event) => {
  const window = senderWindow(event);
  if (window) window.close();
});
ipcMain.on("refresh", () => pushUsage());
// 全量窗口 ⇄ 用量看板：互相打开对方窗口；设置页自 v0.7.0 起住主窗口内
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
// --- 连接目标（v0.4.0 Connection 概念） --------------------------------------
// 以“当前所在系统”为主（local agent），其余目标：WSL 发行版（v0.7.1 起由本机
// 后端经 UNC 直读，无需 agent）、SSH 主机（v0.5.0，自举 agent 后走 HTTP）。
const WSL_AGENT_PORT = 19100;

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

// 本机操作系统的展示名（Win11 探测：build >= 22000）
function currentOsLabel() {
  if (process.platform === "win32") {
    const build = Number((os.release().split(".")[2] || "0"));
    return build >= 22000 ? "Windows 11" : "Windows 10";
  }
  if (process.platform === "darwin") return "macOS";
  return "Linux";
}

// --- SSH 远端目标（v0.5.0） ---------------------------------------------------
// 连接定义持久化在 userData/connections.json；自举 = scp agent 二进制 +
// ssh 启动（随机 token），日常经本地端口转发访问远端 agent。Tools 安装/升级
// 动作仍限 local/WSL 目标（脚本材料在仓库侧）。
let sshConnections = [];
let sshSeq = 1;
const sshSessions = new Map(); // host → { localPort, token, tunnelChild }

function connectionsFile() {
  return path.join(app.getPath("userData"), "connections.json");
}

function loadConnections() {
  try {
    const parsed = JSON.parse(fs.readFileSync(connectionsFile(), "utf8"));
    if (Array.isArray(parsed)) sshConnections = parsed.filter((c) => c && c.host);
  } catch {}
}

function saveConnections() {
  try {
    fs.mkdirSync(path.dirname(connectionsFile()), { recursive: true });
    fs.writeFileSync(connectionsFile(), JSON.stringify(sshConnections, null, 2));
  } catch {}
}

function sshArgs(connection, remoteCommand) {
  const args = [
    "-p", String(connection.port || 22),
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
  ];
  if (connection.user) args.push("-l", connection.user);
  args.push(connection.host);
  if (remoteCommand) args.push(remoteCommand);
  return args;
}

function runSsh(connection, remoteCommand, timeoutMs = 45000) {
  return new Promise((resolve) => {
    const child = spawn("ssh", sshArgs(connection, remoteCommand), {
      stdio: ["ignore", "pipe", "pipe"],
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
      finish({ error: "ssh command timed out" });
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stdout += String(d)));
    child.on("error", (err) => finish({ error: err.message }));
    child.on("close", (code) => finish({ code, stdout: stdout.trim() }));
  });
}

function sshAgentPath() {
  const packed = path.join(__dirname, "..", "agent", "env-agent-linux");
  if (fs.existsSync(packed)) return packed;
  return findLinuxAgentBinary();
}

async function ensureSshAgent(connection) {
  const existing = sshSessions.get(connection.host);
  if (existing) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${existing.localPort}/api/health`, {
        headers: { "x-env-token": existing.token },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return { ok: true, ...existing };
    } catch {}
  }
  const binary = sshAgentPath();
  if (!binary) return { ok: false, error: "linux agent binary not found in this package" };
  const remoteDir = "~/.local/share/env-tools";
  const token = require("node:crypto").randomBytes(16).toString("hex");

  // stage 1：建立远端目录并上传 agent（scp 参数数组，不拼 shell）
  const mkdir = await runSsh(connection, `mkdir -p ${remoteDir}`);
  if (mkdir.error) return { ok: false, error: `ssh failed: ${mkdir.error}` };
  const scp = await new Promise((resolve) => {
    // scp 没有 -l 选项，用户名并入 host（user@host:path）
    const hostSpec = `${connection.user ? connection.user + "@" : ""}${connection.host}`;
    const args = ["-P", String(connection.port || 22)];
    args.push(binary, `${hostSpec}:${remoteDir}/env-agent`);
    const child = spawn("scp", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += String(d)));
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ error: "scp timed out" }); }, 180000);
    child.on("error", (e) => { clearTimeout(timer); resolve({ error: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { error: `scp exit ${code}: ${err.trim().slice(-200)}` }); });
  });
  if (scp.error) return { ok: false, error: scp.error };

  // stage 2：随机 token 启动（SSH 场景非 loopback-only，必须鉴权）
  const start = await runSsh(
    connection,
    `chmod +x ${remoteDir}/env-agent && pkill -f 'env-agent --port ${WSL_AGENT_PORT}' 2>/dev/null; ` +
    `nohup ${remoteDir}/env-agent --port ${WSL_AGENT_PORT} --token ${token} >${remoteDir}/agent.log 2>&1 & disown; sleep 1; echo started`,
  );
  if (start.error) return { ok: false, error: `agent start failed: ${start.error}` };

  // stage 3：本地端口转发隧道
  let localPort = 19150 + (sshSeq++ % 40);
  const tunnelChild = spawn("ssh", [
    "-p", String(connection.port || 22),
    "-o", "BatchMode=yes",
    "-o", "ExitOnForwardFailure=yes",
    "-N",
    "-L", `${localPort}:127.0.0.1:${WSL_AGENT_PORT}`,
    ...(connection.user ? ["-l", connection.user] : []),
    connection.host,
  ], { stdio: ["ignore", "ignore", "ignore"], windowsHide: true, detached: process.platform !== "win32" });
  for (let attempt = 0; attempt < 8; attempt++) {
    await new Promise((r) => setTimeout(r, 1200));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${localPort}/api/health`, {
        headers: { "x-env-token": token },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        sshSessions.set(connection.host, { localPort, token, tunnelChild });
        return { ok: true, localPort, token };
      }
    } catch {}
  }
  try { tunnelChild.kill(); } catch {}
  return { ok: false, error: "tunnel or remote agent did not become healthy (check ssh access & ~/.local/share/env-tools/agent.log)" };
}

ipcMain.handle("ssh-list", () => ({ ok: true, connections: sshConnections }));
ipcMain.handle("ssh-save", (_event, list) => {
  if (!Array.isArray(list)) return { ok: false, error: "invalid list" };
  sshConnections = list
    .filter((c) => c && typeof c.host === "string" && c.host.trim())
    .map((c, index) => ({
      id: `ssh:${c.host}`,
      host: c.host.trim(),
      port: Number(c.port) || 22,
      user: (c.user || "").trim(),
    }));
  saveConnections();
  return { ok: true, connections: sshConnections };
});
ipcMain.handle("ssh-connect", async (_event, host) => {
  const connection = sshConnections.find((c) => c.host === host);
  if (!connection) return { ok: false, error: `unknown ssh host: ${host}` };
  return ensureSshAgent(connection);
});
ipcMain.handle("ssh-disconnect", (_event, host) => {
  const session = sshSessions.get(host);
  if (session) {
    try { session.tunnelChild.kill(); } catch {}
    sshSessions.delete(host);
  }
  return { ok: true };
});

ipcMain.handle("list-targets", async () => {
  // v0.7.1：汇总目标置顶且为默认；本机目标带操作系统名（Win11 探测）；
  // WSL 目标改走后端 UNC 直读，无需 linux agent。
  const targets = [
    { id: "aggregate", label: "All sources (merged)", kind: "aggregate", ready: Boolean(backendPort) },
    { id: "local", label: currentOsLabel(), kind: "local", os: currentOsLabel(), ready: Boolean(backendPort) },
  ];
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
          ready: true,
        });
      }
    } catch {}
  }
  for (const connection of sshConnections) {
    const session = sshSessions.get(connection.host);
    targets.push({
      id: `ssh:${connection.host}`,
      label: `SSH · ${connection.user ? connection.user + "@" : ""}${connection.host}`,
      kind: "ssh",
      host: connection.host,
      ready: Boolean(session),
    });
  }
  return { ok: true, targets };
});
ipcMain.handle("connect-target", async (_event, targetId) => {
  if (targetId === "local" || targetId === "aggregate") return { ok: true };
  // WSL 目标 v0.7.1 起走后端 UNC 直读，无需 agent 自举
  if (targetId.startsWith("wsl:")) return { ok: true };
  if (targetId.startsWith("ssh:")) {
    const host = targetId.slice(4);
    const result = await ensureSshAgent(sshConnections.find((c) => c.host === host) || { host });
    if (result.ok) return { ok: true, localPort: result.localPort, token: result.token };
    return result;
  }
  return { ok: false, error: `unknown target: ${targetId}` };
});
// 按目标解析 agent 访问点（本机后端 / SSH 隧道）。WSL 目标不再走 agent，
// 分析经本机后端的 UNC 扫描、配额按应用运行侧读取（见 get-usage/get-analytics）。
async function resolveTargetAgent(targetId) {
  if (!targetId || targetId === "local" || targetId === "aggregate") {
    if (!backendPort) return null;
    return { base: `http://127.0.0.1:${backendPort}`, headers: {} };
  }
  if (targetId.startsWith("ssh:")) {
    const session = sshSessions.get(targetId.slice(4));
    if (!session) return null;
    return {
      base: `http://127.0.0.1:${session.localPort}`,
      headers: { "x-env-token": session.token },
    };
  }
  return null;
}

ipcMain.handle("get-usage", async (_event, targetId) => {
  // v0.7.1：配额一律用应用运行侧的本机后端读取（不跨 WSL 取配额）；
  // 仅 SSH 目标继续路由到远端 agent。
  if (targetId && targetId.startsWith("ssh:")) {
    const agent = await resolveTargetAgent(targetId);
    if (agent) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 55000);
        const res = await fetch(`${agent.base}/api/usage`, {
          headers: agent.headers,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) return await res.json();
      } catch {}
    }
    return { error: `target ${targetId} agent is unreachable — connect it in Tools first` };
  }
  return await fetchUsage();
});

ipcMain.handle("get-analytics", async (_event, days, agent, targetId) => {
  const aggregate = targetId === "aggregate";
  const query = `?days=${encodeURIComponent(days || 30)}&agent=${encodeURIComponent(agent || "all")}` +
    `${aggregate ? "&aggregate=1" : ""}`;
  if (aggregate) {
    // 汇总目标：本机后端一次扫描本机 + WSL 家目录（会话跨源合并）
    try {
      return await backendFetch(`/api/analytics${query}`);
    } catch (err) {
      return { ok: false, error: `Analytics engine unavailable: ${err.message}` };
    }
  }
  // SSH 目标：经本地端口转发访问远端 agent（请求带自举时的随机 token）
  if (targetId && targetId.startsWith("ssh:")) {
    const host = targetId.slice(4);
    const session = sshSessions.get(host);
    if (!session) return { ok: false, error: `SSH target ${host} is not connected — connect it in Tools first` };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ANALYTICS_TIMEOUT_MS);
      const res = await fetch(`http://127.0.0.1:${session.localPort}/api/analytics${query}`, {
        headers: { "x-env-token": session.token },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) return await res.json();
    } catch {}
    return { ok: false, error: `SSH agent for ${host} is unreachable (tunnel may have dropped)` };
  }
  // WSL 目标（v0.7.1）：本机后端经 UNC 直读该发行版家目录，无 agent 依赖
  if (targetId && targetId.startsWith("wsl:")) {
    const distro = targetId.slice(4);
    try {
      return await backendFetch(`/api/analytics${query}&wsl_distro=${encodeURIComponent(distro)}`);
    } catch (err) {
      return { ok: false, error: `Analytics engine unavailable: ${err.message}` };
    }
  }
  try {
    return await backendFetch(`/api/analytics${query}`);
  } catch (err) {
    return { ok: false, error: `Analytics engine unavailable: ${err.message}` };
  }
});
ipcMain.handle("get-backend-status", async () => {
  const info = { running: Boolean(backendPort), port: backendPort, engine: "env-tools-api (not running)" };
  if (backendPort) {
    try {
      const status = await backendFetch("/api/backend-status", 20000);
      return { ...info, running: true, engine: status.engine || "env-tools-api", detail: status };
    } catch (err) {
      return { ...info, engine: `env-tools-api unreachable: ${err.message}` };
    }
  }
  return info;
});
ipcMain.handle("api-key-status", () => backendJson("/api/api-keys"));
// 设置页：读取/保存后端设置（数据源环境等）；保存成功后立即刷新看板
ipcMain.handle("get-settings", () => backendJson("/api/settings"));
ipcMain.handle("set-settings", async (_event, values) => {
  const result = await backendJson("/api/settings", values || {});
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
  const result = await backendJson("/api/api-keys", keys);
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
  // npm 全局安装的 codex/kimi 在 Windows 上是 .cmd 垫片，直接 spawn 可执行名会 ENOENT
  if (process.platform === "win32") {
    return { command: "cmd.exe", args: ["/c", commandName, "login"] };
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

// --- 自研轻量升级器（v0.6.0） -------------------------------------------------
// 检查：读取 Release 的 latest.json（版本号 + 资产名 + sha256），与当前版本比较。
// 安装：下载对应平台资产 → 校验 → 解压到临时目录 → 生成参数化交换脚本（等主
// 进程退出 → 旧目录改名 .old → 新目录就位 → 重启 → 成功后清理），脱离父进程
// 执行后主进程退出。任何一步失败都回滚保留旧版本。
const UPDATE_FEED = process.env.AI_USAGE_UPDATE_FEED
  || "https://github.com/salmoshu/Env-Tools/releases/latest/download/latest.json";
let lastUpdateInfo = null;

// v0.7.0 起仓库公开，release 资产匿名可下载：不再需要任何 GitHub token。
// githubHeaders 保留 UA 与 Accept，便于将来扩展私有源。
function githubHeaders(extra = {}) {
  return {
    "User-Agent": "env-tools-app",
    ...extra,
  };
}

function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function pickUpdateAsset(meta) {
  const platform = process.platform === "win32" ? "win32" : "linux";
  return (meta.files || {})[platform] || null;
}

ipcMain.handle("update-check", async () => {
  const current = app.getVersion();
  try {
    let meta;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(UPDATE_FEED, {
        headers: githubHeaders(),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      meta = await res.json();
    } catch (feedErr) {
      // 兜底：latest 短链延迟时，走公开 GitHub API 定位 latest.json
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const api = await fetch("https://api.github.com/repos/salmoshu/Env-Tools/releases/latest", {
        headers: githubHeaders({ Accept: "application/vnd.github+json" }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!api.ok) {
        throw new Error(
          `feed HTTP ${String(feedErr.message || feedErr).slice(0, 40)}; api HTTP ${api.status}`,
        );
      }
      const release = await api.json();
      const metaAsset = (release.assets || []).find((a) => a.name === "latest.json");
      if (!metaAsset) throw new Error("latest release has no latest.json");
      const res2 = await fetch(metaAsset.browser_download_url, { headers: githubHeaders() });
      if (!res2.ok) throw new Error(`latest.json download HTTP ${res2.status}`);
      meta = JSON.parse(await res2.text());
      // 记录平台资产的直链，下载时匿名走 browser_download_url
      for (const key of Object.keys(meta.files || {})) {
        const match = (release.assets || []).find((a) => a.name === meta.files[key].name);
        if (match) meta.files[key].url = match.browser_download_url;
      }
    }
    const available = compareVersions(meta.version, current) > 0;
    lastUpdateInfo = available ? meta : null;
    const asset = available ? pickUpdateAsset(meta) : null;
    return {
      ok: true,
      current,
      latest: meta.version,
      available,
      asset: asset ? asset.name : null,
    };
  } catch (err) {
    return { ok: false, error: err.message, current };
  }
});

function sendUpdateProgress(payload) {
  for (const w of liveWindows()) w.webContents.send("update-progress", payload);
}

async function downloadUpdateAsset(asset, destFile) {
  // 公开仓库：优先用 update-check 拿到的直链，否则按 tag 拼接 download URL
  const url = asset.url
    || `https://github.com/salmoshu/Env-Tools/releases/download/v${lastUpdateInfo.version}/${encodeURIComponent(asset.name)}`;
  sendUpdateProgress({ phase: "download", percent: 0 });
  const res = await fetch(url, {
    headers: githubHeaders({ Accept: "application/octet-stream" }),
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  const chunks = [];
  for await (const chunk of res.body) {
    chunks.push(chunk);
    received += chunk.length;
    if (total) {
      sendUpdateProgress({ phase: "download", percent: Math.round((received / total) * 100) });
    }
  }
  const buffer = Buffer.concat(chunks);
  if (asset.sha256) {
    const crypto = require("node:crypto");
    const digest = crypto.createHash("sha256").update(buffer).digest("hex");
    if (digest !== asset.sha256.toLowerCase()) {
      throw new Error(`sha256 mismatch (expected ${asset.sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…)`);
    }
  }
  fs.writeFileSync(destFile, buffer);
}

function extractUpdate(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (process.platform === "win32") {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -Path '${archive}' -DestinationPath '${destDir}' -Force"`,
      { stdio: "ignore" },
    );
  } else {
    execSync(`tar xzf ${JSON.stringify(archive)} -C ${JSON.stringify(destDir)}`, { stdio: "ignore" });
  }
}

ipcMain.handle("update-install", async () => {
  if (!app.isPackaged) {
    return { ok: false, error: "auto-update works only in packaged builds (dev: rebuild manually)" };
  }
  if (!lastUpdateInfo) return { ok: false, error: "no pending update — run check first" };
  const asset = pickUpdateAsset(lastUpdateInfo);
  if (!asset) return { ok: false, error: "no asset for this platform in the release" };
  const currentDir = path.dirname(app.getPath("exe"));
  const exeName = process.platform === "win32" ? "Env-Tools.exe" : "Env-Tools";
  const work = path.join(app.getPath("temp"), `env-tools-update-${Date.now()}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    // v0.7.0 起 Windows 官方分发为 NSIS setup：下载 → 校验 → 静默安装 → 退出
    if (asset.installer || asset.name.endsWith(".exe")) {
      const installer = path.join(work, asset.name);
      await downloadUpdateAsset(asset, installer);
      sendUpdateProgress({ phase: "install", percent: 100 });
      spawn(installer, ["/S"], {
        detached: true, stdio: "ignore", windowsHide: true,
      }).unref();
      sendUpdateProgress({ phase: "restart", percent: 100 });
      setTimeout(() => app.quit(), 1500);
      return { ok: true };
    }
    const archive = path.join(work, asset.name);
    await downloadUpdateAsset(asset, archive);
    sendUpdateProgress({ phase: "extract", percent: 100 });
    const extractDir = path.join(work, "extracted");
    extractUpdate(archive, extractDir);
    const entries = fs.readdirSync(extractDir).filter((name) =>
      fs.existsSync(path.join(extractDir, name, exeName)));
    if (entries.length !== 1) throw new Error("unexpected package layout");
    const newDir = path.join(extractDir, entries[0]);

    // 参数化交换脚本：路径全部经参数传入，脚本内容零转义
    const isWin = process.platform === "win32";
    const swapScript = path.join(work, isWin ? "upgrade.ps1" : "upgrade.sh");
    if (isWin) {
      fs.writeFileSync(swapScript, `$ErrorActionPreference = "Stop"
param([string]$Cur, [string]$NewDir, [string]$ExeName)
$appExe = Join-Path $Cur $ExeName
for ($i = 0; $i -lt 60; $i++) {
  $p = Get-Process | Where-Object { $_.Path -eq $appExe }
  if (-not $p) { break }
  Start-Sleep -Seconds 1
}
$old = "${Cur}.old"
$target = Join-Path (Split-Path $Cur -Parent) (Split-Path $Cur -Leaf)
Rename-Item $Cur $old
Move-Item $NewDir $target
Start-Process -FilePath (Join-Path $target $ExeName) -WorkingDirectory $target
Start-Sleep -Seconds 5
$p = Get-Process | Where-Object { $_.Path -eq (Join-Path $target $ExeName) }
if ($p) {
  Remove-Item $old -Recurse -Force
} else {
  Rename-Item $target "$target.new-failed"
  Rename-Item $old $Cur
  Start-Process -FilePath $appExe -WorkingDirectory $Cur
}
`);
      spawn("powershell", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", swapScript,
        "-Cur", currentDir, "-NewDir", newDir, "-ExeName", exeName,
      ], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      fs.writeFileSync(swapScript, `#!/bin/bash
set -e
CUR="$1"; NEW="$2"; EXE="$3"
exe="$CUR/$EXE"
for i in $(seq 1 60); do
  pgrep -f "$exe" >/dev/null 2>&1 || break
  sleep 1
done
mv "$CUR" "$CUR.old"
mv "$NEW" "$CUR"
chmod +x "$CUR/$EXE" 2>/dev/null || true
nohup "$CUR/$EXE" >/dev/null 2>&1 &
sleep 5
if pgrep -f "$CUR/$EXE" >/dev/null 2>&1; then
  rm -rf "$CUR.old"
else
  mv "$CUR" "$CUR.new-failed"
  mv "$CUR.old" "$CUR"
  nohup "$CUR/$EXE" >/dev/null 2>&1 &
fi
`, { mode: 0o755 });
      spawn("bash", [swapScript, currentDir, newDir, exeName], {
        detached: true, stdio: "ignore",
      }).unref();
    }
    sendUpdateProgress({ phase: "restart", percent: 100 });
    setTimeout(() => app.quit(), 1500);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

if (gotLock) {
  app.whenReady().then(async () => {
    loadConnections();
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
