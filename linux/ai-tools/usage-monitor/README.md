# Env-Tools：Kimi / Codex / CodeBuddy 终端额度监控

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
- CodeBuddy：默认读取
  `~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`，
  凭证即将过期时自动刷新。首次使用前在 CodeBuddy CLI 中执行 `/login`。
  额度数据来自 plans-usage 网页同源接口 `POST /billing/meter/get-user-resource`
  （CLI Bearer token 直接可用），分别显示订阅额度和赠送额度，并汇总总额度。

程序不会复制或输出访问令牌。也可以通过
`KIMI_CREDENTIALS_PATH`、`CODEX_AUTH_PATH`、`CODEBUDDY_AUTH_PATH`
或命令行参数指定文件。

Kimi 请求默认绕过 `HTTP_PROXY`/`HTTPS_PROXY` 直连，以避免部分本地代理造成
TLS EOF；Codex 请求仍遵循系统代理设置。如果所在网络必须通过代理访问 Kimi，
设置 `KIMI_USE_PROXY=1` 即可恢复使用系统代理。

## 使用

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

# 供其他本地脚本读取
./tools.sh ai-tools --usage --json
```

完整参数：

```bash
./tools.sh ai-tools --usage --help
```

Codex 的登录令牌由 Codex CLI 管理；如果终端提示登录失效，请执行
`codex login`。可以用 `CODEX_USAGE_URL` 覆盖额度接口地址，以适配后续官方
客户端的接口调整。

CodeBuddy 相关环境变量：`CODEBUDDY_ENDPOINT`（覆盖 API 地址；默认读取凭证中的
`auth.domain` 自动区分 .cn / .ai 站点）、`CODEBUDDY_TIMEOUT`（请求超时秒数）。
