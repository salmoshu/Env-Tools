# Env-Tools：Kimi / Codex / DeepSeek / GLM 终端额度监控

完全独立于 Sub2API、PostgreSQL、Docker 和 Web 服务的本地终端应用，仅使用
Python 3 标准库。

## 桌面应用（v0.3.0 起）

Env-Tools 自 v0.3.0 起收敛为统一的 Electron 桌面应用（仓库 `app/`，React +
Rust 本地后端），包含三块：

- **Usage Analytics**（全量窗口默认页）：多 agent 会话用量分析 + 套餐配额
  总览。数据来自本地会话日志（Kimi Code 与 Codex CLI 的会话记录；GLM /
  DeepSeek 以自定义模型接入其它 CLI，按模型名归因），顶部 Agent 下拉可查看
  整体或单独某个 agent / API（Kimi / Codex / GLM / DeepSeek）的用量。图表、
  KPI、会话明细的口径与 v0.2.0 一致，另新增按 agent 的占比条与每个模型的
  归属标注。
- **Board**（用量看板小悬浮窗）：v0.2.0 的全部能力保留——紧凑配额卡、模型
  筛选、版本徽章点击升级（浮层实时日志、可取消）、设置页（Display / Theme /
  Membership / Login / API Keys / Environment / About）。全量窗口的齿轮按钮
  会打开看板并直达设置页。
- **Tools**：Env-Tools 其它组件（ai-tools / nodejs / kdesk / openssh）的图形
  化安装与升级入口，动作统一运行仓库根的 setup 脚本并实时滚动输出；
  openssh 支持状态查看。此前需要脚本操作的内容（安装、升级、状态查询）全部
  改由 GUI 完成；被取代的旧纯 JS 看板归档在 `archive/electron-app-plain`。

技术栈：渲染层 React 18 + Vite；外壳 Electron；本地 API 网关为 Rust + axum
（`app/backend-rs`，WSL 内监听 127.0.0.1，带单飞缓存；缺席时自动回退为
Electron 直连 python 数据引擎，契约一致）。数据解析仍在 `usage_monitor.py`。
终端入口（`tools.sh ai-tools --usage`、`--watch` 的 Ctrl+E 拉窗）继续可用，
watch 自动拉起的窗口即本应用。

## 连接目标（v0.4.0 起）

全量窗口顶部新增 **Target** 选择器：以当前所在系统（This machine）为主，同时
可以把 WSL 发行版作为独立目标连接。选择一个 WSL 目标时应用会自动完成自举：
把 agent 二进制与数据引擎写入该发行版的 `~/.local/share/env-tools/` 并启动
（端口 19100，经 localhost 访问），之后用量分析全部由目标内的 Rust 原生引擎
完成——Windows 应用不再要求把仓库部署进 WSL，也不依赖仓库路径。目标内的
配额查询仍由数据引擎经 python 读取（凭证留在目标本机）。

原生引擎（v0.4.0 起）：会话用量分析已用 Rust 在 agent 内实现（内存增量扫描，
首次约 1 秒、后续毫秒级），聚合口径与 `--json --analytics` 完全一致；Plan
配额、设置、API Key、升级等功能仍由 python 数据引擎承载。

Windows 原生模式 + 自动升级（v0.6.0 起）：

- **Native-first**：Windows 启动脚本默认不再走 WSL——配额引擎脚本与分析
  agent 都随包分发（包内内嵌独立 Python，用户无需安装 Python），解压即可用。
  WSL 降级为可选目标：`Start-EnvTools.ps1 -UseWsl` 或在 Target 选择器里连接
  （自举链路不变）。
- **配额按目标路由**：配额查询与分析统一跟随 Target 选择器——本机目标走本
  机 agent，WSL/SSH 目标走对应 agent 的 `/api/usage`。选哪个目标，分析和配
  额就都是那个目标的。
- **自动升级**：设置页 About 面板可检查更新并一键升级。流程：读取 Release
  的 `latest.json`（版本号 + 资产名 + sha256）→ 下载并校验 → 解压到临时目
  录 → 两阶段目录交换（等进程退出 → 旧目录改名 .old → 新目录就位 → 重启，
  启动失败自动回滚）。私有仓库需在 About 面板粘贴 GitHub token（或配置
  `AI_USAGE_GH_TOKEN` 环境变量 / 本机 `gh auth login`），token 只存本机
  userData。

SSH 远端目标（v0.5.0 起）：Tools 页可登记 SSH 主机（host/port/user，需密钥
认证）并一键连接——应用把 Linux agent 上传到远端
`~/.local/share/env-tools/`、以随机 token 启动（端口 19100），并通过本地
端口转发隧道访问；远端主机随即出现在 Analytics 的 Target 选择器里，分析
数据（原生引擎）经隧道获取。安全边界：scp/ssh 全部参数数组调用、不拼接
shell；私钥不进配置与日志；远端流量走 SSH 隧道 + token。已知限制：Tools
的安装/升级动作目前仅支持本机与 WSL 目标（脚本材料在仓库侧），SSH 目标仅
提供用量分析。

## 凭证

- Kimi：默认读取 `~/.kimi-code/credentials/kimi-code.json`，并在即将过期时
  自动刷新。首次使用前请在 Kimi Code CLI 中登录。
- Kimi 月度总量与会员信息（可选）：官网订阅页的「总使用量」（月总量，跨 Kimi
  网页版与 Kimi Code 共享）、会员名称（如 Allegro）与当前周期终止/续费时间，
  只由网页版网关提供，CLI 凭证无法访问（`/coding/v1/usages` 已不再返回会员
  等级字段）。配置方式：浏览器登录
  `kimi.com` 后，在开发者工具 Application → Local Storage → `https://www.kimi.com`
  中复制 `refresh_token` 的值，写入 `~/.kimi-code/credentials/kimi-web.json`：

  ```json
  {"refresh_token": "粘贴的值"}
  ```

  之后脚本会用官网同款接口自动刷新该凭证（写回同文件，权限 0600），无需重复
  复制；网页端退出登录后需重新复制。可用 `KIMI_WEB_CREDENTIALS_PATH` 或
  `--kimi-web-credentials` 指定其他路径，`KIMI_WEB_SUBSCRIPTION_URL` /
  `KIMI_WEB_STATS_URL` 可覆盖接口地址。未配置时自动跳过，不影响其它窗口；
  此时会员名称保持 unknown，到期时间可用设置页 Membership 手动配置。
- Codex：默认读取 `~/.codex/auth.json`。首次使用前执行 `codex login`。
- DeepSeek：使用 API Key（platform.deepseek.com 的 API keys 页面生成，与
  `/usage` 网页看到的余额是同一套账户数据）。三种配置方式（按优先级）：
  1. `--deepseek-key` 命令行参数；
  2. 环境变量 `DEEPSEEK_API_KEY`；
  3. 凭证文件 `~/.deepseek/credentials.json`（`{"api_key": "..."}`，权限 0600），
     可用 `DEEPSEEK_CREDENTIALS_PATH` 或 `--deepseek-credentials` 指定其他路径。
  监控会查询 `GET /user/balance` 显示余额，并以 **50 元为每月上限**按使用量计算占比
  （`使用量 = 50 − 余额`，小于 0 时按 0 截断），与其它模型的进度条口径保持一致。
  可用 `DEEPSEEK_USE_PROXY`（默认走系统代理）与 `DEEPSEEK_TIMEOUT`（默认 30 秒）
  调整请求行为，用 `DEEPSEEK_BALANCE_URL` 覆盖接口地址。
- GLM（智谱 BigModel）：面向 **GLM Coding Plan** 订阅用户，使用 BigModel 平台的
  API Key 查询 Coding Plan 的套餐配额，与开放平台 API 余额无关。
  配置方式（按优先级）：
  1. `--glm-key` 命令行参数；
  2. 环境变量 `GLM_API_KEY`（也兼容 `ZHIPU_API_KEY` 和
     `ZHIPUAI_API_KEY`）；
  3. 凭证文件 `~/.glm/credentials.json`（`{"api_key": "..."}`，权限 0600），
     可用 `GLM_CREDENTIALS_PATH` 或 `--glm-credentials` 指定其他路径。
  监控会用 Bearer 鉴权查询 `GET /api/monitor/usage/quota/limit`（官方
  [Coding Plan 订阅管理页](https://bigmodel.cn/coding-plan/personal/overview)
  在用的接口），展示三个窗口：5 小时 token 额度、每周 token 额度（均为已用
  百分比 + 重置倒计时），以及工具/联网搜索月额度（绝对次数 + 剩余量）。
  可用 `GLM_USE_PROXY`（默认走系统代理）、`GLM_TIMEOUT`（默认 30 秒）和
  `GLM_QUOTA_URL` 调整请求；国际版（z.ai）用户可将 `GLM_QUOTA_URL` 设为
  `https://api.z.ai/api/monitor/usage/quota/limit`。
  未在 config.json 手动配置会员时间时，还会查询同一管理页的
  `GET /api/biz/subscription/list`（可用 `GLM_SUBSCRIPTION_URL` 覆盖，
  默认从 `GLM_QUOTA_URL` 同源推导），把订阅的续费（重置）日期作为会员到期
  时间显示；自动续费的套餐以 renews 措辞展示。

## 会员到期时间

每个模型都可以显示会员到期时间（终止日期 + 剩余时长，终端与 Electron 同步
展示）。配置写入 monitor 同目录的 `config.json`，可在 Electron 设置页
**Membership** 中统一管理（购买/续费日期 + 时长月数，留空即隐藏），也可直接
编辑文件：`kimi` / `openai` / `glm` / `deepseek` 各小节的
`membership_purchased_at`（无时区按本机时区解释）与
`membership_duration_months`（默认 1 个月）。Kimi（需网页凭证）与 GLM 未手动
配置时会自动使用订阅接口返回的周期终止/续费日期。也可通过 `--config` 或环境
变量 `AI_USAGE_CONFIG_PATH` 使用其他配置文件。

程序不会复制或输出访问令牌。也可以通过
`KIMI_CREDENTIALS_PATH`、`CODEX_AUTH_PATH`
或命令行参数指定文件。

Windows Electron 看板自 v0.2.0 起默认打开**全量模式**窗口（Usage Analytics），
标题栏的 `Board` 按钮可打开原来的小悬浮**用量看板**窗口（用量看板标题栏的
展开按钮也可回到全量模式；两个窗口可同时开启，配额数据 60 秒同步刷新到两
个窗口）。设置页仍然住在用量看板窗口里：全量模式标题栏的齿轮按钮会打开用
量看板并直接进入设置页。

全量模式参考 [kimi-usage-dashboard](https://github.com/coconilu/kimi-usage-dashboard)
集成了本地会话用量分析（数据源为 Kimi Code CLI 的会话日志
`~/.kimi-code/sessions/**/wire.jsonl`，只读取 turn 级 `usage.record`，全程不
联网）：

- KPI 卡片：近 7 天 tokens、今日 tokens、总缓存命中率、活跃会话数、上周同期
  （含周环比涨跌）。
- 图表：每日 token 趋势（input/output/cacheRead/cacheCreation 堆叠）、今日按
  小时趋势、模型占比（Top 8 + 其他）、每日 × 模型堆叠、缓存命中率折线、项目
  排行 Top 15（按会话工作目录聚合）、GitHub 风格近一年活动日历。
- 会话明细：按 token 总量排序，点击 Start / End / Total 表头可切换排序。
- 顶部 Range 下拉切换统计窗口（7/14/30/90 天）；数据每 5 分钟自动重扫，也可
  点击标题栏刷新按钮立即重扫。解析位置按文件增量缓存在
  `~/.cache/ai-usage-monitor/kimi-usage-cache.json`，重复请求只读取日志新增
  字节。数据根目录可用 `KIMI_CODE_HOME` 环境变量覆盖。
- 全量模式同时以紧凑卡片展示各套餐配额（与用量看板同源），含 5h/周/月窗口
  进度、重置倒计时与会员到期时间。
- 数据源环境（WSL / Windows）跟随设置页 Environment 的选择：扫描的是所选环
  境用户目录下的会话日志。

WSL 终端里也可以直接输出同一份分析 JSON：
`usage_monitor.py --json --analytics --days 30`。

小悬浮用量看板窗口标题栏的齿轮按钮打开设置页（铺满窗口，左侧边栏分类，返
回按钮在边栏顶部）：

- **Display**：勾选要在看板上显示的模型（原标题栏筛选下拉框已迁入此处）；选择会
  持久化，重启 Electron 后仍然保留。
- **Theme**：亮 / 暗主题切换，默认跟随系统（System）；选择持久化在本机。
- **Membership**：统一管理各模型的会员购买/续费日期与时长（见上文「会员到期
  时间」）；保存后看板立即刷新。Kimi（需网页凭证）与 GLM 留空时自动显示订阅
  接口返回的续费日期。
- **Login**：为 Kimi Code 或 OpenAI Codex 手动启动网页授权。看板启动和刷新时
  不会自动打开登录页面；终端 watch 中也可按 `Ctrl+L` 选择 agent 登录。
- **API Keys**：配置 DeepSeek 和 GLM API Key。输入框不会回显已保存的 Key；
  留空表示保留原值。保存时密钥只通过子进程的标准输入传给 WSL 后端，不会
  进入命令行、进程列表或日志，最终分别写入 `~/.deepseek/credentials.json`
  和 `~/.glm/credentials.json`（权限 0600）。如果对应环境变量已经配置，
  看板只显示“已配置（环境变量）”，不会读取或覆盖环境变量的内容；输入新值
  时仍会写入凭证文件，但环境变量继续拥有更高优先级。
- **Environment**（仅在 WSL 中检测到 Windows 侧可达时出现）：切换看板数据
  源。WSL 和 Windows 中的 agent 版本与凭据可能不同；切换后用量、版本号、
  升级操作和 API Key 配置均作用于所选环境。选择持久化在
  `~/.config/ai-usage-monitor/settings.json`（可用 `AI_USAGE_SETTINGS_PATH`
  覆盖），终端 watch 同样跟随该设置，也可用 `--environment wsl|windows`
  临时覆盖。选择 WSL 时还必须指定已安装的发行版（例如 `Ubuntu-22.04`）。
  注意网络请求始终由 WSL 后端发出，代理按 WSL 环境变量。
- **About**：仓库版本号、当前数据源环境与后端脚本路径。

看板标题栏与终端头部显示仓库统一版本号（根目录 `VERSION` 文件，所有内部
应用与脚本共用）；数据源被切换到非本机环境时标题栏会显示环境标记。

Kimi 请求默认绕过 `HTTP_PROXY`/`HTTPS_PROXY` 直连，以避免部分本地代理造成
TLS EOF；Codex 请求仍遵循系统代理设置。如果所在网络必须通过代理访问 Kimi，
设置 `KIMI_USE_PROXY=1` 即可恢复使用系统代理。

## 使用

Linux 用 `./tools.sh`，Windows 用 `powershell -File tools.ps1`（参数完全一致，
monitor 本身跨平台）。中文 Windows 的 GBK 控制台无法编码 `░`/`█`/`═` 等字符，
这些字符会降级显示为 `?`（不会崩溃）。用法：

```bash
# 显示一次
./tools.sh ai-tools --usage --no-color

# 持续监控，默认每 3 分钟刷新
./tools.sh ai-tools --usage

# 持续监控时可按 Ctrl+R 立即刷新，按 Ctrl+C 退出
# 持续监控时按 Ctrl+L，再按 K/C，手动启动 Kimi/Codex 网页授权

# 每 60 秒只监控 Codex
./tools.sh ai-tools --usage --watch --interval 60 --provider codex

# 只监控 Kimi
./tools.sh ai-tools --usage --provider kimi

# 只监控 DeepSeek（需 DEEPSEEK_API_KEY）
./tools.sh ai-tools --usage --provider deepseek

# 只监控 GLM（需 GLM_API_KEY / ZHIPU_API_KEY）
./tools.sh ai-tools --usage --provider glm

# 供其他本地脚本读取
./tools.sh ai-tools --usage --json
```

完整参数：

```bash
./tools.sh ai-tools --usage --help
```

进度条中的 `|` 标记当前时刻在配额窗口内的位置（由窗口总长与重置时间推算）。
用量填充超过 `|` 说明额度消耗比时间跑得快，可适当放慢使用；反之则有余量。
Kimi/Codex 的 5h、7d 窗口直接带窗口总长；Kimi 月总量按月周期重置，
窗口起点按重置时间往前推一个自然月估算（28~31 天自适应）。

OpenAI 返回 usage limit reset 机会时，终端和 Electron 看板会额外显示
`Reset chance: N remaining · Not usable until limit reached`；触及适用限额后，
后半句变为 `M usable now` 并以绿色提示。它是手动重置机会，不是额度窗口的
自动重置倒计时。

各 agent 标题右侧会显示本机已安装的 CLI 版本，如 `Kimi Code (0.33.0)`；
探测到更新版本时追加黄色的目标版本号 `Kimi Code (0.30.0 → 0.33.0)`，提示应升级 CLI。
当前版本取自本机 `<cli> --version`，每次启动实时检测；最新版本 Kimi 查
`code.kimi.com/kimi-code/latest`，Codex 查 npm registry。仅最新版本的
远程探测结果缓存于 `~/.cache/ai-usage-monitor/versions.json`，每小时
（`VERSION_CHECK_INTERVAL`）最多探测一次；探测失败沿用旧值并做小时级退避。

点击黄色版本徽章弹出升级浮层，确认后原地升级。升级期间浮层实时滚动安装
脚本的输出（kimi 官方脚本路线的 tarball 下载含 MiB/百分比/速率心跳，
每 5 秒一拍）并显示已用时长；可随时 Cancel 整组中止安装进程。下载持续
60 秒无任何进展判定为停滞：自动杀掉安装进程组，并翻转代理设置
（直连 ↔ 系统代理，需存在 `http_proxy` 等环境变量）重试一次；整体超过
20 分钟未完成按超时失败。失败（含停滞/超时/取消）时浮层不自动关闭，
末尾日志保留在浮层里供排查，完整过程见 `ai-tools/log/setup.log`。

Codex 的登录令牌由 Codex CLI 管理；如果终端提示登录失效，请执行
`codex login`。可以用 `CODEX_USAGE_URL` 覆盖额度接口地址，以适配后续官方
客户端的接口调整。

## Electron 看板刷新策略

Electron 看板会并行查询 Kimi、Codex、DeepSeek 和 GLM，并按固定顺序展示结果。
某个服务断网或接口异常时，只显示该服务的错误，不阻塞其他卡片。后台请求采用
比终端模式更短的单次网络超时（10 秒，Codex 因必须经代理访问 chatgpt.com
放宽到 20 秒），同一轮最多重试一次（下一轮定时刷新还会继续尝试），
完整刷新超过 45 秒会终止；定时刷新、
手动刷新和升级后的刷新若同时发生，会共用同一个进行中的请求，避免重复进程抢占
网络而产生假超时。

Electron 后台没有交互终端，因此不会自动启动 `codex login`。Codex 凭证缺失或
过期时会立即显示错误；可在设置页 **Login** 中手动启动网页授权，也可以在 WSL
终端按 `Ctrl+L` 登录后再刷新看板。
