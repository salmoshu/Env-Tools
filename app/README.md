# Env-Tools Desktop App

整个 Env-Tools 的统一桌面入口（v0.3.0 起）：

- **前端**：React 18 + Vite（渲染层，构建产物 `dist/`，随仓库提交以便 Windows
  启动器直接同步、无需在 Windows 侧再构建）
- **外壳**：Electron（`electron/main.js` 双窗口、置顶、升级/安装脚本编排）
- **本地后端**：Rust + axum（`backend-rs/`，监听 127.0.1，提供 `/api/health`、
  `/api/analytics`、`/api/usage`、`/api/settings`、`/api/api-keys`、
  `/api/accounts`、`/api/codex-accounts`、`/api/backend-status`；带单飞缓存与
  超时管理）。**v0.7.0 起配额（含 Kimi OAuth 刷新）、会话分析、设置与 API key
  全部原生实现，python 引擎不再是应用的依赖**（终端 CLI 保留 python 版）。

## 窗口

当前版本：Kimi Code、OpenAI Codex、GLM / BigModel、DeepSeek 均支持多账号，
按 provider 分别保存 active 并同步到各窗口。默认与额外账号均可新增、重命名、
使用和移除；默认账号还可恢复，操作不删除凭证或会员配置。Kimi/Codex 使用独立
profile 登录，GLM/DeepSeek 使用逐账号 API Key。Codex 受管启动器让后续新启动的
CLI 使用当前账号，正在运行的进程不受影响。账号菜单收起仅显示名称，展开才显示
窗口用量；套餐配额标题不再附加“全部来源合并”。设置页的 **Agent / 智能体**
按厂商分块管理上述功能，并支持逐账号会员购买/续费日期与时长。组件管理按
Agent / 开发工具 / 系统工具分组并提供分类筛选；Windows 与 WSL 目标分别探测
安装状态。设置页兼容中英文、深浅色和窄窗口布局。

- **全量窗口 "Env-Tools"**（默认打开）：Usage Analytics（多 agent 会话分析 +
  套餐配额，支持本机/WSL/SSH 目标与跨源汇总）与 Tools（组件管理）、Settings
  （侧边栏设置页）页签，标题栏左侧图标化切换，右上角带最大化按钮。
- **用量看板 "AI Usage Monitor"**：小悬浮窗（可置顶、高度自适应），紧凑配额
  卡片；设置统一住主窗口（齿轮按钮或 #/settings）。

## 目录

```text
electron/          Electron 主进程、preload、置顶脚本、图标
src/               React 源码（pages/ components/ styles）
dist/              Vite 构建产物（提交，启动器直接复制）
backend-rs/        Rust axum 本地 API 网关（cargo build --release）
scripts/           打包（electron-packager + NSIS setup）与 dev 编排
```

## 开发

```bash
cd app
pnpm install               # 包管理统一使用 pnpm（v0.7.0 起）
pnpm dev                   # vite dev server + Electron 热更新窗口（开发首选）
pnpm run build && pnpm start   # 生产式运行：加载 dist/ 静态产物
cd backend-rs && cargo build --release  # 原生后端（数据引擎必需）
```

`pnpm dev` 由 `scripts/dev.mjs` 编排：先起 vite（端口固定 5173），就绪后注入
`VITE_DEV_SERVER_URL` 拉起 Electron，主进程检测到该变量即改走 `loadURL` 热更新；
仅渲染层享受热更新，改 `electron/` 主进程仍需重启。注意与安装版不能同时运行
（单实例锁）。

## 打包（Windows setup + linux tar.gz）

```bash
node scripts/package.mjs --platform win32 --out release   # zip + NSIS setup.exe
node scripts/package.mjs --platform linux --out release   # tar.gz
```

Windows 的 NSIS 安装器（`scripts/installer.nsi`）为用户级安装
（%LOCALAPPDATA%\Env-Tools），带开始菜单/桌面快捷方式与卸载器；应用内升级
直接静默运行新 setup（/S），无需任何 GitHub token（公开 release）。

终端 watch 的 `Ctrl+E` 与 `usage_monitor.py --watch` 自动拉起的窗口同样指向
本应用（`launch_usage_window` 已重定向）。
