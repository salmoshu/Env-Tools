#!/usr/bin/env node
// Env-Tools 桌面应用打包脚本（本地与 GitHub Actions 共用）。
//
// 用法：
//   node scripts/package.mjs --platform linux --out release
//   node scripts/package.mjs --platform win32 --out release
//
// 产物：release/Env-Tools-<platform>-x64/ 与同名 .tar.gz（linux）/.zip（win32）。
// 前置条件：vite build 已完成；backend-rs 二进制已按目标平台编译
// （backend-rs/target/release/env-tools-api[.exe]），打包时复制进包内并随之分发。

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const platformArg = (() => {
  const index = args.indexOf("--platform");
  return index >= 0 ? args[index + 1] : process.platform === "win32" ? "win32" : "linux";
})();
const outDir = path.resolve(root, (() => {
  const index = args.indexOf("--out");
  return index >= 0 ? args[index + 1] : "release";
})());

const exeSuffix = platformArg === "win32" ? ".exe" : "";
const backendBinary = path.join(root, "backend-rs", "target", "release", `env-tools-api${exeSuffix}`);
const monitorScript = path.resolve(root, "..", "linux", "ai-tools", "usage-monitor", "usage_monitor.py");
const staging = path.join(root, "release-staging");

if (!fs.existsSync(backendBinary)) {
  console.error(`[package] backend binary missing: ${backendBinary}`);
  console.error("[package] build it first: (cd backend-rs && cargo build --release)");
  process.exit(1);
}

// 1. 组装暂存目录（打包内容最小化：外壳 + 渲染产物 + 数据引擎 + agent 二进制）
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(staging, { recursive: true });
for (const entry of ["electron", "dist"]) {
  fs.cpSync(path.join(root, entry), path.join(staging, entry), { recursive: true });
}
fs.mkdirSync(path.join(staging, "backend"), { recursive: true });
fs.copyFileSync(monitorScript, path.join(staging, "backend", "usage_monitor.py"));
fs.mkdirSync(path.join(staging, "backend-rs", "target", "release"), { recursive: true });
fs.copyFileSync(backendBinary, path.join(staging, "backend-rs", "target", "release", `env-tools-api${exeSuffix}`));
fs.copyFileSync(path.join(root, "package.json"), path.join(staging, "package.json"));
fs.copyFileSync(path.join(root, "Start-EnvTools.ps1"), path.join(staging, "Start-EnvTools.ps1"));

// Windows 包嵌入 Linux agent 二进制：Windows UI 可通过 WSL 目标自举（v0.4.0
// Connection 概念）。CI 从 build-agent-linux artifact 下载后经 --linux-agent 传入。
const linuxAgentIndex = args.indexOf("--linux-agent");
const linuxAgent = linuxAgentIndex >= 0 ? args[linuxAgentIndex + 1]
  : path.join(root, "backend-rs", "target", "release", "env-tools-api");
if (platformArg === "win32" && linuxAgent && fs.existsSync(linuxAgent)) {
  fs.mkdirSync(path.join(staging, "agent"), { recursive: true });
  fs.copyFileSync(linuxAgent, path.join(staging, "agent", "env-agent-linux"));
  console.log("[package] embedded linux agent for WSL bootstrap");
}

// 2. electron-packager
const appName = "Env-Tools";
execSync(
  `npx electron-packager . ${appName} --platform=${platformArg} --arch=x64 ` +
  `--out=${JSON.stringify(outDir)} --overwrite --icon=electron/assets/logo.${platformArg === "win32" ? "ico" : "png"}`,
  { cwd: staging, stdio: "inherit", env: process.env },
);

// 3. Windows 包根补启动脚本；linux 包恢复可执行位
const pkgDir = path.join(outDir, `${appName}-${platformArg}-x64`);
if (platformArg === "win32") {
  // 启动脚本已在 staging 根，packager 会复制；无需额外动作
} else {
  const backend = path.join(pkgDir, "resources", "app", "backend-rs", "target", "release", "env-tools-api");
  fs.chmodSync(backend, 0o755);
}

// 4. 压缩
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const archiveBase = `env-tools-desktop-v${version}-${platformArg}-x64`;
if (platformArg === "win32") {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${pkgDir}' -DestinationPath '${path.join(outDir, archiveBase + ".zip")}' -Force"`,
    { stdio: "inherit" },
  );
} else {
  execSync(
    `tar czf ${JSON.stringify(path.join(outDir, archiveBase + ".tar.gz"))} -C ${JSON.stringify(outDir)} ${appName}-linux-x64`,
    { stdio: "inherit" },
  );
}
console.log(`[package] done: ${path.join(outDir, archiveBase)}`);
