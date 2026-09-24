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

// 3. 启动脚本放到 exe 旁边（packager 只会把 staging 内容复制进 resources/app）
const pkgDir = path.join(outDir, `${appName}-${platformArg}-x64`);
if (platformArg === "win32") {
  fs.copyFileSync(path.join(staging, "Start-EnvTools.ps1"), path.join(pkgDir, "Start-EnvTools.ps1"));
} else {
  const backend = path.join(pkgDir, "resources", "app", "backend-rs", "target", "release", "env-tools-api");
  fs.chmodSync(backend, 0o755);
}

// 3.5 组件安装脚本负载随包分发：安装后 electron 侧 REPO_ROOT 解析为
// <pkg>/resources（main.js 按 __dirname/../.. 推导），Tools 组件安装与看板
// agent 升级直接调用这些脚本，此处按仓库同构布局复制到 resources/ 下。
// kdesk 负载数百 MB（厂商安装包/快照/壁纸缓存）不随包分发；各组件脚本的
// log/ 运行目录同样排除。main.js 对缺失负载会给出明确提示而非乱码报错。
const repoRoot = path.resolve(root, "..");
const resourcesDir = path.join(pkgDir, "resources");
for (const file of ["setup.ps1", "setup.sh", "tools.ps1", "tools.sh", "VERSION"]) {
  fs.copyFileSync(path.join(repoRoot, file), path.join(resourcesDir, file));
}
const payloadFilter = (src) => {
  const rel = path.relative(repoRoot, src).replace(/\\/g, "/");
  if (/(^|\/)log(\/|$)/.test(rel)) return false;
  if (rel.startsWith("windows/kdesk")) return false;
  return true;
};
for (const dir of ["completion", "linux", "windows"]) {
  fs.cpSync(path.join(repoRoot, dir), path.join(resourcesDir, dir), { recursive: true, filter: payloadFilter });
}
console.log("[package] component install scripts bundled into resources/");

// 4. 压缩 / 安装器
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version;
const archiveBase = `env-tools-desktop-v${version}-${platformArg}-x64`;
if (platformArg === "win32") {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${pkgDir}' -DestinationPath '${path.join(outDir, archiveBase + ".zip")}' -Force"`,
    { stdio: "inherit" },
  );
  // 5. NSIS setup 安装器（v0.7.0 起 Windows 官方分发形态；/S 静默安装兼容）
  const setupPath = path.join(outDir, `env-tools-setup-v${version}-win32-x64.exe`);
  const nsi = path.join(root, "scripts", "installer.nsi");
  const makensisCandidates = [
    "makensis",
    "C:\\Program Files (x86)\\NSIS\\makensis.exe",
    "C:\\Program Files\\NSIS\\makensis.exe",
  ];
  let built = false;
  for (const makensis of makensisCandidates) {
    try {
      execSync(
        `${JSON.stringify(makensis)} /DAPP_DIR=${JSON.stringify(pkgDir)} ` +
        `/DSETUP_OUT=${JSON.stringify(setupPath)} /DVERSION=${JSON.stringify(version)} ` +
        `/DICON=${JSON.stringify(path.join(root, "electron", "assets", "logo.ico"))} ${JSON.stringify(nsi)}`,
        { stdio: "inherit" },
      );
      built = true;
      break;
    } catch (err) {
      if (makensis === makensisCandidates.at(-1)) {
        // NSIS 失败必须硬失败：历史上警告后继续曾导致 CI 只产出 zip、
        // 到上传步骤才报 "setup exe missing"，真正的 makensis 错误被淹没问题现场
        console.error(`[package] ERROR: NSIS setup build failed (${err.message})`);
        process.exit(1);
      }
    }
  }
  if (built) console.log(`[package] setup installer: ${setupPath}`);
  console.log(`[package] done: ${path.join(outDir, archiveBase)}`);
} else {
  execSync(
    `tar czf ${JSON.stringify(path.join(outDir, archiveBase + ".tar.gz"))} -C ${JSON.stringify(outDir)} ${appName}-linux-x64`,
    { stdio: "inherit" },
  );
  console.log(`[package] done: ${path.join(outDir, archiveBase)}`);
}
