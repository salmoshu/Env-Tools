// 开发编排：先起 vite dev server（HMR），就绪后拉起 Electron 并通过
// VITE_DEV_SERVER_URL 让窗口加载热更新页面；Electron 退出时顺带关掉 vite。
// 不引入 concurrently 等新依赖。生产式运行仍是 pnpm run build + pnpm start。
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// electron 包的 main 导出就是本机 electron.exe 路径
const electronExe = require("electron");
const viteEntry = path.join(root, "node_modules", "vite", "bin", "vite.js");
if (!fs.existsSync(viteEntry)) {
  console.error("[dev] vite 未安装，请先运行 pnpm install");
  process.exit(1);
}

const PORT = 5273;
const devUrl = `http://localhost:${PORT}/`;

// 幂等启动：上次异常退出可能遗留占用本端口的 vite（node.exe），先清掉。
// 只杀 node.exe 进程，绝不误伤其他应用。
function killStaleVite() {
  if (process.platform !== "win32") return;
  // v4/v6 独立查询：任一协议无匹配时 findstr 退出码为 1，v4 失败不能跳过
  // v6 检查——vite 绑 localhost 时常常只监听 [::1]
  let out = "";
  for (const proto of ["tcp", "tcpv6"]) {
    try {
      out += `${execSync(`netstat -ano -p ${proto} | findstr ":${PORT} "`, { encoding: "utf8" })}\n`;
    } catch {}
  }
  if (!out.trim()) return; // 端口空闲
  const pids = new Set();
  for (const line of out.split("\n")) {
    if (!line.includes("LISTENING")) continue;
    const pid = line.trim().split(/\s+/).pop();
    if (pid && /^\d+$/.test(pid) && pid !== "0") pids.add(pid);
  }
  for (const pid of pids) {
    try {
      const info = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, { encoding: "utf8" });
      if (info.toLowerCase().includes("node.exe")) {
        execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" });
        console.log(`[dev] killed stale vite (pid ${pid}) on port ${PORT}`);
      }
    } catch {}
  }
}
killStaleVite();

const vite = spawn(process.execPath, [viteEntry, "--port", String(PORT), "--strictPort"], {
  cwd: root,
  stdio: "inherit",
});
// vite 先死（strictPort 冲突、崩溃等）时把已拉起的 Electron 一起收掉：
// 否则残留的窗口会靠单实例锁劫持下一次 pnpm dev（表现为“启动没反应”）
let electron = null;
vite.on("exit", (code) => {
  if (electron) electron.kill();
  process.exit(code ?? 0);
});

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    // 自家 vite 已退出（如 strictPort 撞车）就直接判失败：
    // 端口上答话的可能是别的项目的服务器，不能算"就绪"
    if (vite.exitCode !== null || vite.signalCode !== null) return false;
    try {
      const res = await fetch(devUrl);
      if (res.ok) return true;
    } catch {
      // server 未就绪
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

const ready = await waitForServer();
if (!ready) {
  if (vite.exitCode !== null || vite.signalCode !== null) {
    console.error("[dev] vite 进程已退出（端口冲突或启动失败），详见上方 vite 输出");
  } else {
    console.error(`[dev] vite dev server 在 30s 内未就绪：${devUrl}`);
  }
  vite.kill();
  process.exit(1);
}
console.log(`[dev] vite 就绪：${devUrl}，正在拉起 Electron…`);

electron = spawn(electronExe, [root], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, VITE_DEV_SERVER_URL: devUrl },
});
electron.on("exit", (code) => {
  vite.kill();
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    vite.kill();
    if (electron) electron.kill();
    process.exit(0);
  });
}
