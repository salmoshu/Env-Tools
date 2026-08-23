# Env-Tools：Kimi / Codex / CodeBuddy / DeepSeek 终端额度监控

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
- CodeBuddy：默认读取
  `~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`，
  凭证即将过期时自动刷新。首次使用前在 CodeBuddy CLI 中执行 `/login`。
  额度数据来自 plans-usage 网页同源接口 `POST /billing/meter/get-user-resource`
  （CLI Bearer token 直接可用），分别显示订阅额度和赠送额度，并汇总总额度。
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

程序不会复制或输出访问令牌。也可以通过
`KIMI_CREDENTIALS_PATH`、`CODEX_AUTH_PATH`、`CODEBUDDY_AUTH_PATH`
或命令行参数指定文件。

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

# 每 60 秒只监控 Codex
./tools.sh ai-tools --usage --watch --interval 60 --provider codex

# 只监控 Kimi
./tools.sh ai-tools --usage --provider kimi

# 只监控 DeepSeek（需 DEEPSEEK_API_KEY）
./tools.sh ai-tools --usage --provider deepseek

# 供其他本地脚本读取
./tools.sh ai-tools --usage --json
```

完整参数：

```bash
./tools.sh ai-tools --usage --help
```

进度条中的 `|` 标记当前时刻在配额窗口内的位置（由窗口总长与重置时间推算）。
用量填充超过 `|` 说明额度消耗比时间跑得快，可适当放慢使用；反之则有余量。
Kimi/Codex 的 5h、7d 窗口直接带窗口总长；Kimi 月总量与 CodeBuddy 订阅额度
按月周期重置，窗口起点按重置时间往前推一个自然月估算（28~31 天自适应）。
CodeBuddy 赠送包等一次性额度周期未知，不显示标记。

OpenAI 返回 usage limit reset 机会时，终端和 Electron 看板会额外显示
`Reset chance: N remaining · Not usable until limit reached`；触及适用限额后，
后半句变为 `M usable now` 并以绿色提示。它是手动重置机会，不是额度窗口的
自动重置倒计时。

各 agent 标题右侧会显示本机已安装的 CLI 版本，如 `Kimi Code (0.33.0)`；
探测到更新版本时追加黄色的目标版本号 `Kimi Code (0.30.0 → 0.33.0)`，提示应升级 CLI。
当前版本取自本机 `<cli> --version`，每次启动实时检测；最新版本 Kimi 查
`code.kimi.com/kimi-code/latest`，Codex/CodeBuddy 查 npm registry。仅最新版本的
远程探测结果缓存于 `~/.cache/ai-usage-monitor/versions.json`，每小时
（`VERSION_CHECK_INTERVAL`）最多探测一次；探测失败沿用旧值并做小时级退避。

Codex 的登录令牌由 Codex CLI 管理；如果终端提示登录失效，请执行
`codex login`。可以用 `CODEX_USAGE_URL` 覆盖额度接口地址，以适配后续官方
客户端的接口调整。

CodeBuddy 相关环境变量：`CODEBUDDY_ENDPOINT`（覆盖 API 地址；默认读取凭证中的
`auth.domain` 自动区分 .cn / .ai 站点）、`CODEBUDDY_TIMEOUT`（请求超时秒数）。
