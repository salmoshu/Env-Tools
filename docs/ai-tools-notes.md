# AI CLI 工具维护与接口经验笔记

本文记录 `Env-Tools` 中 AI CLI 安装、升级及额度监控所依赖接口的维护经验。

## Kimi Code

- 凭证 `~/.kimi-code/credentials/kimi-code.json`，临过期用 refresh_token 走
  `https://auth.kimi.com/api/oauth/token` 刷新（client_id 见 usage_monitor.py）。
- 额度接口 `GET https://api.kimi.com/coding/v1/usages`（Bearer）。部分本地代理会 TLS EOF，
  默认直连，`KIMI_USE_PROXY=1` 才走代理。
- 月度总量（官网订阅页「总使用量」）：CLI token 无权访问，需网页登录态，
  详见下方「Kimi 月度总量」专节。
- 升级：脚本安装的二进制（`~/.kimi-code/bin/kimi`）重跑官方安装脚本
  `curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash`；npm 安装则
  `npm install -g @moonshot-ai/kimi-code@latest`。交互式 `kimi upgrade` 不适合脚本。
- Windows（2026-08 实测）：官方安装器是 PowerShell 版
  `irm https://code.kimi.com/kimi-code/install.ps1 | iex`，原生二进制装到
  `%USERPROFILE%\.kimi-code\bin\kimi.exe`（旧版备份为 `kimi.exe.bak`），并把该目录
  **prepend** 到用户 PATH。`windows/ai-tools/setup_ai_tools.ps1` 据此让 kimi 走官方
  安装器、codex 走 npm；装完自动卸载 npm 残留的 `@moonshot-ai/kimi-code`
  （残留判定直接看 `prefix\node_modules\@moonshot-ai\kimi-code` 目录），并对每个工具做
  PATH 遮蔽校验（`Get-Command` 解析路径 vs 预期目录，不一致打 WARN）。
  codex 的"当前版本"直接调 npm prefix 下的 shim（`<cmd>.cmd --version`）判定，
  shim 不存在即视为未安装：既免疫 PATH 遮蔽（IDE 自带 node 工作区抢解析时会误判），
  又避开 `npm ls -g` 的 node 冷启动开销（Windows 上串行多次 npm 调用是卡顿主因）。
  与 linux 版行为对齐：npm 工具与 kimi
  原生安装分两个 Job 并行，Job 输出协议行（`LOG|对象|文本` / `RESULT|对象|状态|前后版本`），
  主线程按对象分条折叠渲染（最新 3 行原位刷新），结束打印安装简报。
  npm 下载（`view` 查询与 `install` 安装）默认源失败时，两平台脚本都会自动回退
  国内镜像 `https://registry.npmmirror.com` 重试一次（2026-08-17 起）。
  三个坑：① PS 5.1 需手动开 TLS 1.2 才能连 code.kimi.com；② 系统代理（Clash/v2ray）
  对它 TLS EOF，脚本内需 `[System.Net.WebRequest]::DefaultWebProxy = $null` 直连；
  ③ 双引号字符串里写 `` ` ``（反引号）是转义符——`` `" `` 会吞掉收尾引号，
  字符串一路吞到几百行后的下一个 `"`，报错点（`字符串缺少终止符`）远在真实问题之外
  （2026-08-17 事故：`正常运行：`npx prefix -g`"` 中的两个反引号；日志里想引用命令
  请用引号或直接写，别用反引号）。含中文的 ps1 仍须存成 **UTF-8 with BOM**。
  `setup.ps1` 现在会在运行组件脚本前做解析预检，把这类损坏报成可操作提示。

### Kimi 月度总量（网页接口，逆向自官网订阅页，2026-07 已实测）

- 两个可用接口（Connect-RPC JSON，头 `Authorization: Bearer <网页 token>` +
  `x-msh-platform: web`）：
  - `POST https://www.kimi.com/apiv2/kimi.gateway.billing.v1.BillingService/GetUsages`，
    body `{"scope":["FEATURE_CODING"]}` → `totalQuota{limit,used,remaining}`
    （次数口径，与 5h/7d 窗口同构；实测不返回 resetTime）。
  - `POST https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats`，
    body `{}` → `subscriptionBalance{amountUsedRatio,kimiCodeUsedRatio,expireTime}`
    （0~1 比例口径，带月度重置时间）。usage_monitor.py 用后者渲染「月度总量」窗口。
- **CLI token 打不通**（401 `REASON_INVALID_AUTH_TOKEN`，与网页 token 受众不同）；
  CLI 的 `/coding/v1/usages` 也带 `totalQuota` 字段，但 LEVEL_INTERMEDIATE 套餐下为空 `{}`。
- 网页 token 获取与续期（localStorage 裸字符串键 `access_token` / `refresh_token`）：
  - F12 → Application → Local Storage 复制 `refresh_token`，存入
    `~/.kimi-code/credentials/kimi-web.json`（chmod 600，勿入 git）。
  - 刷新 `POST https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken`，
    body `{"refresh_token": ...}` → `{accessToken, refreshToken}`，**新 AT+RT 原子写回**
    （RT 每次轮换；实测旧 RT 在短窗口内仍可重复使用一次）。AT 寿命 900 秒（15 分钟）。
  - 备选：扫码登录接口 `CreateLoginQRCode` + 轮询 `GetLoginQRCodeStatus`，
    手机 Kimi App 扫码确认后直接得 AT/RT，无需浏览器（未实测）。
  - 网页端无独立 OAuth client_id，登录走 Connect-RPC 账号服务。
- **坑**：响应字段是 camelCase（`accessToken`/`subscriptionBalance`/`amountUsedRatio`），
  与官网 JS 里 `useProtoFieldName` 暗示的 snake_case 相反，解析要兼容两种命名。
- 风控头 `x-msh-shield-data`：实测纯脚本调用（仅 Bearer + platform 头）未被强制校验。
- 均为未公开接口，可能随时变更；仅自用低频查询。

## OpenAI Codex

- 凭证 `~/.codex/auth.json`（tokens.access_token / account_id）。
- 额度接口 `GET https://chatgpt.com/backend-api/wham/usage`，头 `ChatGPT-Account-Id`；中国大陆需代理。
- 升级 `npm install -g @openai/codex@latest`。

## 逆向网页接口的通用方法

- 抓页面 HTML 找 JS chunk（`src=` 及动态 import），在 chunk 里搜 API 路径或服务名；
  按 `from"./xxx.js"` 的 import 链追踪 model/service 的定义位置。
- Kimi 前端是 protobuf-es + Connect-RPC：服务定义嵌在 `fileDesc("<base64>")`，
  base64 解码后提取可打印字符串（`re.findall(rb'[ -~]{3,}', data)`）即可枚举
  service/method/字段名，比抓包省一次登录态。
- Connect-RPC 调用形态：`POST {baseUrl}/<package.Service>/<Method>`，JSON body。
  Kimi 业务网关 `https://www.kimi.com/apiv2`，账号服务 `https://auth.kimi.com/api`。
- 端点探测：用假 token 调用，401（鉴权失败）说明路径存在、只是 token 不对；
  404 才是路径错误。
- CLI 二进制（bun 打包的 JS）可直接 `strings` 搜端点字符串，判断 CLI 自己用没用
  某个接口（如 kimi CLI 里搜不到 totalQuota，说明月总量只有网页端在用）。

## 环境（WSL）坑

- **PATH 混入 Windows shim**：`/mnt/c/.../npm/codex` 可能被优先解析，报
  `Missing optional dependency @openai/codex-linux-x64`。用 `type -a <cmd>` 排查解析顺序。
- **启动 Windows GUI 不要使用 `start_new_session`**：WSL interop relay 可能把
  当前伪终端的前台进程组切给短命的 `powershell.exe` 会话；PowerShell 退出后，
  monitor 读取键盘会收到 `SIGTTIN`/`SIGTTOU`，Bash 显示 `Stopped`，但 Windows
  Electron 仍在运行。标准流重定向到 `DEVNULL` 即可，Electron 由 Windows launcher
  自行独立运行。
- **npm 全局目录不能并发写**：多个 `npm install -g` 并行会互相破坏（codex 曾因此缺 vendor 二进制）。
  多个 npm 包合并到一条 `npm install -g pkgA@latest pkgB@latest`，npm 内部自带并行。

## 终端进度显示技巧（ai-tools 安装脚本，两端行为一致）

- 后台工作线程（bash 函数 / PS Job）只输出协议行：`LOG|<对象>|<文本>` 与
  `RESULT|<对象>|<OK|FAIL>|<前版本>|<后版本>`；主线程增量归集，**按安装对象分条渲染**，
  每个对象一行标题（spinner/✓/✗）+ 最新 3 行过程消息，原位重绘。
- Linux：线程写日志文件，主线程按字节偏移增量 `tail -c` 读取（不完整行留在内存缓冲
  下次续读），`\033[<n>A` 上移 + `\033[2K` 清行；Windows：`Receive-Job` 轮询 +
  `[Console]::SetCursorPosition` 重绘，panelTop 按绘制后光标位置反推以容忍缓冲区滚动。
- 过程信息用淡色 `\033[2m`（Linux）；结束后保留面板终态并打印「安装简报」
  （node/npm 版本 + 每个对象：安装成功/更新成功 before->after/已是最新/失败）。
- 标题下的过程信息统一缩进两个字符，使“查询”“已是”等文本与标题中的左中括号
  `[` 对齐；不要按工具名长度动态缩进，否则不同对象的内容起始列会来回跳动。
- nodejs 依赖部署同样折叠（迷你面板，标题 + 最新 3 行）；失败时展开日志尾部。
- TTY 才用折叠视图；`--verbose`（Linux）/ `-Verbose`（Windows）、管道/重定向退化
  全量流式输出。无 TTY 验证折叠 UI：`script -qec "bash xxx.sh" /dev/null` 分配 pty。

## Env-Tools 项目结构约定

- 根目录 `setup.sh` / `setup.ps1` 负责部署，`tools.sh` / `tools.ps1` 负责已部署应用的日常操作。
- AI CLI 安装脚本及额度监控实现统一放在 `linux/ai-tools/`；额度入口为
  `./tools.sh ai-tools --usage`（Windows 为 `tools.ps1 ai-tools --usage`，monitor 跨平台）。
