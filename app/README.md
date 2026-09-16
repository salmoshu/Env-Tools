# Env-Tools Desktop App

整个 Env-Tools 的统一桌面入口（v0.3.0 起）：

- **前端**：React 18 + Vite（渲染层，构建产物 `dist/`，随仓库提交以便 Windows
  启动器直接同步、无需在 Windows 侧再构建）
- **外壳**：Electron（`electron/main.js` 双窗口、置顶、升级/安装脚本编排）
- **本地后端**：Rust + axum（`backend-rs/`，WSL 内运行，监听 127.0.0.1，提供
  `/api/health`、`/api/analytics`、`/api/usage`、`/api/backend-status`；带单飞
  缓存与超时管理）。数据解析仍在 `usage_monitor.py`，后端只做进程编排，
  后端不可用时 Electron 自动回退为直连 python，两条路径契约一致。

## 窗口

- **全量窗口 "Env-Tools"**（默认打开）：Usage Analytics（多 agent 会话分析 +
  套餐配额）与 Tools（组件管理）两个页签，标题栏按钮切换。
- **用量看板 "AI Usage Monitor"**：小悬浮窗（可置顶、高度自适应），紧凑配额
  卡片；全应用的设置页（Display/Theme/Membership/Login/API Keys/Environment/
  About）住在这里，全量窗口的齿轮按钮会打开它并直达设置页。

## 目录

```text
electron/          Electron 主进程、preload、置顶脚本、图标
src/               React 源码（pages/ components/ styles）
dist/              Vite 构建产物（提交，启动器直接复制）
backend-rs/        Rust axum 本地 API 网关（cargo build --release）
launch-windows.ps1 Windows 启动器：同步文件 + 安装 Electron 运行时 + 开始菜单
```

## 开发

```bash
cd app
npm install                # React/Vite 依赖（electron 二进制沿用旧看板已装好的）
npx vite build             # 构建渲染层到 dist/
(../app/node_modules/.bin/electron .)   # 本地 WSLg 直接启动
cd backend-rs && cargo build --release  # 构建 Rust 后端（可选，缺席时自动回退 python）
```

终端 watch 的 `Ctrl+E` 与 `usage_monitor.py --watch` 自动拉起的窗口同样指向
本应用（`launch_usage_window` 已重定向）。
