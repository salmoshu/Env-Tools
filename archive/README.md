# archive/

历史遗留、已被图形界面取代的入口与脚本归档。v0.3.0 起 Env-Tools 收敛为一个
Electron 桌面应用（仓库 `app/` 目录，React + Rust 本地后端），日常操作全部
通过 GUI 完成。

- `electron-app-plain/`：v0.1.x–v0.2.0 的纯 JS 用量看板（无构建链），已被
  `app/` 的 React 应用完整取代（功能超集：分析 + 配额 + 组件管理）。目录中的
  `node_modules` 未纳入版本管理，仅作历史参考。
- `setup_ai_tools.ps1` / `tools.ps1` / `tools.sh` / `completion/` 等仍保留原位
  （`app/` 的安装升级与状态查询在后台调用它们），后续按需逐步 GUI 化后再归档。

仍可使用的底层入口：

- `./setup.sh` / `setup.ps1`：组件部署（GUI 的 Tools 页后台调用同一脚本）
- `./tools.sh ai-tools --usage`：终端配额监控（GUI 之外的可选途径）
- `linux/ai-tools/usage-monitor/usage_monitor.py --json --analytics`：分析数据
  （GUI 的数据引擎）
