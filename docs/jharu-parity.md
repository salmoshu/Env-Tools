# Jharu 功能对齐清单（Env-Tools 磁盘管理）

对照 [github.com/riponcm/Jharu](https://github.com/riponcm/Jharu)（Apache 2.0，
源码参考 `tmp/jharu-ref`）逐模块核对。✅ 已对齐 · ⚠️ 简化实现 · ❌ 未做。

## 后端（app/backend-rs/src）

| Jharu 模块 | Env-Tools 实现 | 状态 |
|---|---|---|
| rules.rs 开发缓存规则 | `jharu.rs::dev_rules`（25+ 规则 + 运行降级） | ✅ |
| ai_tools.rs AI 工具痕迹 | `jharu.rs::ai_tool_locations` | ✅ |
| models.rs ML 模型 | `jharu_full.rs::scan_models`（HF/Ollama/检查点，引用计数共享层，用过判定） | ✅ |
| python.rs 环境与包 | `jharu_full.rs::python_scan` | ✅ |
| browsers.rs 浏览器 | `jharu_full.rs::browser_scan`（清理走通用链路） | ✅ |
| junk.rs 垃圾文件 | `jharu_full.rs::junk_scan` | ✅ |
| deep.rs 深度分类 | `jharu_extra.rs::deep_scan`（classify_path 五级分类） | ✅ |
| dupes.rs 重复文件 | `jharu_extra.rs::dupes_scan`（4KB 头指纹 + SHA-256 全文件确认） | ✅ |
| projects.rs 构建产物 | `jharu_extra.rs::projects_scan` | ✅ |
| worktrees.rs | `jharu_extra.rs::worktrees_scan`（分支/已合并判定） | ✅ |
| processes.rs 进程评级 | `jharu_extra.rs::process_rated`（系统进程保护表） | ✅ |
| safety.rs 运行时推断 | `jharu_extra.rs::infer_safety`（Facts/gather/工具在跑） | ✅ |
| scanner.rs 扫描缓存 | scan-cache v4 增量 | ✅ |
| health.rs 健康预测 | `jharu_full.rs::space_forecast`（线性回归） | ✅ |
| history.rs 目录历史 | `jharu_extra.rs::history_dir_compare` | ✅ |
| overview.rs 驱动器 | `disk.rs::drives` + 前端 Ring | ✅ |
| overview.rs 概览聚合 | `jharu_overview.rs`（quick：驱动器+预测+逐日趋势+已释放统计+最近批次；cleanable：各源 safe/caution/risky 堆叠含休眠与回收站；live：CPU/内存 2s 轮询；system_map：深度扫描顶层快照持久化→树图） | ✅ 新增 |
| trashlog.rs 清理日志 | `jharu_bin.rs`（trash-log.jsonl，2 万条裁剪） | ✅ 新增 |
| bin.rs 回收站 | `jharu_bin.rs`（$I 元数据真名还原/日志匹配评级/范围清空/还原/取消令牌） | ✅ 新增 |
| apps.rs 卸载器 | `jharu_manage.rs::apps_list`（3 个卸载键 + EstimatedSize + AppData 数据量）+ `run_uninstaller` | ✅ 新增 |
| startup.rs 启动项 | `jharu_manage.rs`（Run/Run32/RunOnce/Startup 文件夹/登录计划任务；StartupApproved 读写与任务管理器一致；受保护项拒绝关闭） | ⚠️ 机器级条目写 HKLM 需管理员时报错，无 UAC 提权重试 |
| protected.rs 保护表 | `jharu_manage.rs` 内联（安全软件/驱动/系统组件） | ✅ 新增 |
| system_space.rs 系统空间 | `jharu_manage.rs`（休眠/页面文件/还原点/WinSxS/Docker；固定 id 白名单 + 临时 .ps1 + RunAs 提权） | ⚠️ 无 DISM 中途取消（Jharu 同样标记不可取消）；还原点删除未在提权脚本内二次核对"仍是最旧/最新" |
| sandboxes.rs 应用沙箱 | `jharu_sandbox.rs`（Packages 128 包扫描、临时区/应用数据/LocalCache 分级、遗留包识别） | ⚠️ LocalCache 的开发缓存映射取常见子集，非全量规则 |
| autocare.rs 自动养护 | `jharu_autocare.rs`（Safe+自动重建+未用天数+体积阈值；锁外执行；事件日志持久化） | ⚠️ 低空间提醒进事件日志而非系统通知；无空闲检测 |
| cleaning.rs 清理引擎 | `jharu_bin.rs`：clean_core/purge_core 逐项回调+取消；任务注册表（start/progress/cancel 三端点，前端 400ms 轮询——IPC 桥无法直连 SSE 的等价形态）；进度条+当前项+取消按钮已接入清理条与回收站清空 | ⚠️ 无管理员清理助手进程（受保护目录清理仍需提权另行处理） |
| codesign.rs 签名校验 | `jharu_manage.rs::verify_signatures`（Get-AuthenticodeSignature，底层 WinVerifyTrust 证书链校验）。注：Jharu 的 codesign.rs 是 macOS 专用（Mach-O 团队 ID），Windows 侧它同样不验签；此项为超出 Jharu 的 Windows 增强——启动项评级给出签名结论，自称大厂但未签名 → Risky（实测 ctfmon=Microsoft Windows 有效、Fences 未签名、25/32 项有结论） | ✅（增强） |
| access.rs / usage.rs 文件使用追踪 | 模型 atime / worktree 判定内联 | ⚠️ 无独立 Seen 索引 |
| places.rs 常用位置 | junk/desktop 内联 | ⚠️ |
| gadget.rs 悬浮挂件 | — | ❌ |

## 前端（app/src/pages/DiskPage.jsx）

- 20 → 22 个子标签页（新增 应用沙箱、自动养护）。
- **概览仪表盘（本轮对齐 Jharu Overview.tsx）**：四统计 tile（系统盘可用+趋势线 /
  本应用已释放+六周柱 / 现在可安全清理 / 实时负载 CPU+内存）、驱动器环+
  满盘预测+“先满”、可清理量按安全性堆叠条（点击跳页）、系统盘 squarify
  树图（复用最近深度扫描）、最近清理批次（含来源与时间）、快捷动作条。
- 清理链路：扫描 → 勾选 → 清理选中（→回收站+日志）→ 自动重扫，9 个扫描页可用。
- 回收站页：应用/自有分类汇总、范围清空（全部/超30天/仅本应用）、单项还原、清理日志还原。
- 卸载器页：程序+数据双体积、卸载按钮（运行程序自带卸载命令）。
- 启动项页：影响估计、开关（受保护禁用）、已开/已关筛选。
- 系统空间页：事实卡 + 管理员检查（还原点/组件仓库）+ 动作（成本/理由悬停说明、UAC 提权）。
- 未对齐：悬浮挂件（gadget，用户确认不需要）。其余全部对齐。

## 本次新增文件

- `app/backend-rs/src/jharu_bin.rs` — trashlog + 回收站四操作
- `app/backend-rs/src/jharu_manage.rs` — 卸载器/启动项/系统空间
- `app/backend-rs/src/jharu_sandbox.rs` — 应用沙箱
- `app/backend-rs/src/jharu_autocare.rs` — 自动养护
- `app/backend-rs/src/jharu_overview.rs` — 概览聚合（quick/cleanable/live/system_map）
- `app/src/components/squarify.js` — 树图布局（Jharu squarify.ts 1:1 移植）
- 依赖新增：`trash = "5"`、`winreg = "0.52"`（Jharu 同源方案，替代 PowerShell 转义地狱）

## 已验证（2026-11-18 本机）

- 回收站：真实列表（$I 还原原路径）→ 清理入站带日志 → by_app 评级 Safe → 还原文件内容完整。
- 清空：范围选择 + 逐项核对（deleted 时间戳不符即跳过）。
- 启动项：45 项（25 系统任务隐藏）、ctfmon 正确判 Risky、开关往返后注册表字节 02/03+FILETIME 与任务管理器一致。
- 卸载器：VS2022 7.3GB 等真实列表 + 卸载命令。
- 系统空间：页面文件 WMI 用量、休眠注册表状态、还原点/组件仓库等待管理员检查。
- 沙箱：128 包 1.7GB，OpenAI.Codex 等正确识别。
- 自动养护：启用/立即运行/事件日志（修复了两处锁死锁：tick 持锁清理、update→status 重入）。
- 概览视觉对齐应用设计系统（qcard token 卡片、树图蓝色梯度随主题、新增通用 .btn/
  .btn-primary 按钮类修复全页原生按钮、侧栏副标题对比度）；经 CDP 截图两轮验收。
- 概览：quick（3 驱动器+系统盘标记+trashlog 统计+批次聚合）、cleanable（开发缓存 2.9G safe/
  11.7G risky、垃圾 15.6G safe、回收站 63M 等）、live（CPU 34%、内存 20/42G）、
  深扫 C:\ 后 system_map 树图（Windows 42.3G / Program Files 4.6G / 其余 3.0G）。
  已随 v0.8.0 发布。
