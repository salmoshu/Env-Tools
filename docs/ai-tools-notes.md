# AI CLI 工具维护与接口经验笔记

本文记录 `Env-Tools` 中 AI CLI 安装、升级及额度监控所依赖接口的维护经验。

## CodeBuddy

- **委派方式**：`codebuddy --model hy3 -p "指令"`（一次性非交互实例）。前提是已登录；
  未登录时返回 `Authentication required`。委派记录写在项目根目录 `codebuddy-log.md`。
- **凭证位置**：`~/.local/share/CodeBuddyExtension/Data/Public/auth/Tencent-Cloud.coding-copilot.info`
  （JSON：auth.accessToken/refreshToken/expiresAt(毫秒)/domain，account.uid/nickname/type）。
  刷新：`POST /v2/auth/token/refresh`，头 `X-Refresh-Token` + `X-Auth-Refresh-Source: plugin`。
- **站点区分（坑）**：国内站 `www.codebuddy.cn` 与国际站 `www.codebuddy.ai` 的 token 不通用，
  写死 `.ai` 会 401。正确做法：读凭证里的 `auth.domain` 自适应（`CODEBUDDY_ENDPOINT` 可覆盖）。
- **数字额度接口**（plans-usage 网页同源，CLI Bearer token 直接可用）：
  `POST https://<domain>/billing/meter/get-user-resource`，
  body `{"PageNumber":1,"PageSize":200,"ProductCode":"p_tcaca","Status":[0,3],"OnlyValidPeriod":true,"PackageCodes":[]}`，
  头 `Authorization: Bearer`、`X-User-Id: <uid>`、`X-Product: SaaS`。
  响应 `data.Response.Data.Accounts[]`：`CycleCapacity{Size,Used,Remain}Precise`（本周期，字符串）、
  `Capacity*Precise`（按天切片套餐的当日口径）、`CapacityType`（4=按天切片）、`CycleEndTime`（本地时间）。
  **区分订阅/赠送**：看 `SubProductCode`——赠送包（活动/签到裂变包）含 `bonus`
  （`sp_tcaca_codebuddyide_bonus_pack`，SubProductName 带"赠送包"），订阅计划为
  `sp_tcaca_codebuddy_ide`；看板据此拆成 Subscription（按月续期）与 Gifted Credits（一次性，到期作废）。
  注意：套餐多为一次性包，到期不重置（用词"过期"）；响应含 uin 等 PII，展示需取舍。
- **CLI 内嵌接口有限**：dist 里只有 `POST /v2/billing/meter/get-dosage-notify`（仅提醒文案，无数字）；
  `/v2/accounts` 无套餐字段。
- **斜杠指令**：`/cost`、`/stats` 是本地会话/token 统计（不走网络，无账户额度）；
  `/upgrade` 只是打开网页。**斜杠指令只在交互模式有效**，`-p` 模式下会被当普通 prompt 发给模型。
- **请求流水**：`POST /billing/meter/get-user-request-usage`（需 startTime/endTime/pageNum/pageSize），
  可看到每次请求的 credit 扣费、model、client。

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
- **npm 全局目录不能并发写**：多个 `npm install -g` 并行会互相破坏（codex 曾因此缺 vendor 二进制）。
  多个 npm 包合并到一条 `npm install -g pkgA@latest pkgB@latest`，npm 内部自带并行。

## 终端进度显示技巧（linux/ai-tools/setup_ai_tools.sh）

- 并行线程各自写日志文件，主线程 spinner（`⠋⠙⠹…`）+ `tail -n 5` 最新日志，
  `\033[<n>A` 上移 + `\033[2K` 清行原地重绘；行数用变量精确记账，线程无输出时占位保持行数稳定。
- 过程信息用淡色 `\033[2m`，结果（✓/✗、汇总）用醒目色；运行期隐藏光标 `\033[?25l`，退出恢复 `\033[?25h`。
- 失败线程自动展开日志尾部；TTY 才用折叠视图，管道/重定向退化全量流式输出。
- 无 TTY 验证折叠 UI：`script -qec "bash xxx.sh" /dev/null` 分配 pty；桩测试用
  "替换 `main \"$@\"` 为桩函数定义 + main 调用"的方式注入假 worker。

## Env-Tools 项目结构约定

- 根目录 `setup.sh` / `setup.ps1` 负责部署，`tools.sh` / `tools.ps1` 负责已部署应用的日常操作。
- AI CLI 安装脚本及额度监控实现统一放在 `linux/ai-tools/`；额度入口为
  `./tools.sh ai-tools --usage`（Windows 为 `tools.ps1 ai-tools --usage`，monitor 跨平台）。
