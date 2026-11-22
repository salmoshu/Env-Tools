# Jharu 功能对齐清单（Env-Tools 磁盘管理）

对照 Jharu v1.0.0 参考源码（`tmp/jharu-ref`，基线提交 `62c0aa0`，Apache 2.0）。
当前磁盘页采用同源专用实现，不再以通用表格和通用路径删除模拟各模块。

## 架构

- `app/backend-rs/src`：复用 Jharu 的扫描、安全评级、删除复核、历史和管理模块。
- `jharu_api.rs`：把原 Tauri command 映射为本地 HTTP 命令，参数和返回值保持原结构。
- `jharu_host.rs`：以事件队列替代 Tauri 事件，以 Electron 系统通知替代通知插件。
- `app/electron/main.js` / `preload.js`：提供命令、进度事件、文件定位、外链和挂件窗口 IPC。
- `app/src/disk`：复用 Jharu 各专用 React 视图；`adapter.js` 保留 `invoke/listen` 语义。
- `app/src/disk/jharu.css`：同源样式限定在 `.jharu-root` 内，不影响 Env-Tools 其它页面。
- 原 `jharu.rs`、`jharu_extra.rs`、`jharu_bin.rs` 等简化实现及其旧 IPC/HTTP 入口已移除。

## 功能矩阵

| 模块 | 同源能力 |
|---|---|
| 概览 | 驱动器、已释放统计、可清理量分级、实时负载、系统盘地图、最近清理 |
| 开发缓存 | 完整规则、运行态评级、锁检测、不可读报告、子项体积、硬链接实际释放量 |
| ML 模型 | HF/Ollama/Whisper/PyTorch/Keras、从未加载筛选、Ollama 共享层与独占体积 |
| Python | 环境发现、包明细、跨环境重复包与浪费空间、环境删除确认 |
| 构建产物 | 项目证据、完整类型、源码时间、排序筛选、自定义根目录、重建命令、占用/锁检查 |
| Git worktrees | 默认分支、未合入提交、未提交文件、CRLF、会话所有者、失效记录、prune |
| AI 工具 | 缓存/历史/状态/扩展分类、按年龄裁剪、项目存续判断、运行态与删除复核 |
| 深度清理 | 流式 Map/List、逐层进入、不可读项、云占位/共享空间、系统位置保护 |
| 重复文件 | 首尾抽样 + BLAKE3 全文件确认、保留副本选择、硬链接/云文件、删除前重新哈希 |
| 应用沙箱 | MSIX/macOS 容器扫描、区域评级、遗留包、目录内容清理、进度取消与复核 |
| 系统空间 | 休眠、页面文件、还原点、WinSxS、Docker（含 volumes）、固定动作提权助手 |
| 垃圾文件 | 安装包/归档、陈旧大文件、Windows 系统残留、Prefetch 只读、管理员内容清理 |
| 桌面 | 截图识别、类型/年龄筛选、默认归档、重名不覆盖、另选移入回收站 |
| 浏览器 | 按浏览器/配置文件明细、安全与需核查分类、安全缓存清理 |
| 回收站 | 真名与原路径、日志匹配、范围清空、逐项复核、取消、单项/批量恢复 |
| 卸载器 | 程序与数据体积、卸载命令、遗留发现、置信度选择与清扫 |
| Speed | 实时总量、程序分组、CPU/内存/磁盘、评级、优雅关闭、强退、PID 重用防护 |
| 启动项 | 来源扫描、影响与评级、批量开关/撤销、StartupApproved、机器级提权 |
| 驱动器健康 | 容量、卷信息、趋势与预测；SMART/smartctl 保持上游平台能力 |
| 空间历史 | 后台读数、目录快照、增长/缩小、基线选择、评级、90 天保留、稳健预测 |
| 自动养护 | 预览后执行、调度、空闲检查、扫描/清理互斥、低空间系统通知与测试通知 |
| 悬浮挂件 | 条/卡片、置顶拖动、位置记忆、最忙进程、预测、预览确认后安全清理 |

## 有意的非功能差异

- 不移植 Jharu 的 GitHub Star 推广卡、产品链接和品牌文案。
- 应用版本与更新继续使用 Env-Tools 原有设置和更新链路。
- 本地数据写入 `Env-Tools` 数据目录；回收站日志沿用 `Env-Tools/trash-log.jsonl`。
- 首次启动迁移旧 `autocare.json` 设置、上次运行时间和驱动器容量历史；新文件已存在时不覆盖。
- Windows 是当前实际验收平台。上游 macOS 平台代码保留，但本机未做 macOS 运行验收。

## 验证

最新结果：Rust **294 通过 / 0 失败 / 16 忽略**；Node **9 通过 / 0 失败**；前端生产构建和 Electron 语法检查通过。隔离 HTTP 烟测通过：同头异内容文件不误判、完整哈希分组、桌面/垃圾路径、构建扫描、D 盘 Git、深度/构建/重复文件事件、历史、挂件、进程、驱动器和只读养护预览。

- `cargo check`
- `cargo test --release -- --test-threads=1`（Git Bash 下需把 POSIX PATH 转为 Windows PATH）
- `npm test`
- `node --check electron/main.js && node --check electron/preload.js`
- `npm run build`
- 本地 HTTP 命令烟测：以临时用户目录和 `ENVTOOLS_DATA_DIR` 隔离数据，覆盖只读扫描、重复文件反例、进度事件与历史接口；不执行真实系统清理或提权动作。
