# Env-Tools：Kimi / Codex / DeepSeek / GLM 终端额度监控

完全独立于 Sub2API、PostgreSQL、Docker 和 Web 服务的本地终端应用，仅使用
Python 3 标准库。

## 凭证

- Kimi：默认读取 `~/.kimi-code/credentials/kimi-code.json`，并在即将过期时
  自动刷新。首次使用前请在 Kimi Code CLI 中登录。
- Kimi 月度总量（可选）：官网订阅页的「总使用量」（月总量，跨 Kimi 网页版与
  Kimi Code 共享）只由网页版网关提供，CLI 凭证无法访问。配置方式：浏览器登录
  `kimi.com` 后，在开发者工具 Application → Local Storage → `https://www.kimi.com`
  中复制 `refresh_token` 的值，写入 `~/.kimi-code/credentials/kimi-web.json`：

  ```json
  {"refresh_token": "粘贴的值"}
  ```

  之后脚本会用官网同款接口自动刷新该凭证（写回同文件，权限 0600），无需重复
  复制；网页端退出登录后需重新复制。可用 `KIMI_WEB_CREDENTIALS_PATH` 或
  `--kimi-web-credentials` 指定其他路径。未配置时自动跳过，不影响其它窗口。
- Codex：默认读取 `~/.codex/auth.json`。首次使用前执行 `codex login`。
  会员购买时间记录在 monitor 同目录的 `config.json`。默认按一个自然月计算终止
  时间，并在终端和 Electron 同时显示购买时间、终止时间及剩余时长。购买或续费后
  直接修改 `openai.membership_purchased_at` 即可；无时区的时间按本机时区解释。
  `membership_duration_months` 可调整会员时长。也可通过 `--config` 或环境变量
  `AI_USAGE_CONFIG_PATH` 使用其他配置文件。
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
- GLM（智谱 BigModel）：使用 BigModel 平台的 API Key，与财务中心
  `https://bigmodel.cn/finance-center/finance/overview` 对应同一账户余额。
  配置方式（按优先级）：
  1. `--glm-key` 命令行参数；
  2. 环境变量 `GLM_API_KEY`（也兼容 `ZHIPU_API_KEY` 和
     `ZHIPUAI_API_KEY`）；
  3. 凭证文件 `~/.glm/credentials.json`（`{"api_key": "..."}`，权限 0600），
     可用 `GLM_CREDENTIALS_PATH` 或 `--glm-credentials` 指定其他路径。
  监控会用 Bearer 鉴权查询 `GET /api/paas/v4/balance`；若当前平台
  未开放该路由，会自动回退到财务中心同款账户报表接口。展示与
  DeepSeek 保持一致：显示余额、赠送金额和充值金额，以 **50 元为每月上限**
  换算用量进度。可用 `GLM_USE_PROXY`（默认走系统代理）、
  `GLM_TIMEOUT`（默认 30 秒）和 `GLM_BALANCE_URL` 调整请求。

程序不会复制或输出访问令牌。也可以通过
`KIMI_CREDENTIALS_PATH`、`CODEX_AUTH_PATH`
或命令行参数指定文件。

Windows Electron 看板可点击标题栏的齿轮按钮打开设置页（铺满窗口，左侧边栏
分类，不再是弹框）：

- **Display**：勾选要在看板上显示的模型（原标题栏筛选下拉框已迁入此处）；选择会
  持久化，重启 Electron 后仍然保留。
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
