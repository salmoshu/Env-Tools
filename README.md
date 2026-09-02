# Env-Tools

一套 Windows / Linux 双平台的环境一键部署与日常运维脚本集。根目录两个入口脚本
负责部署，`tools.sh` 负责已部署应用的日常操作，维护经验文档集中在 `docs/`。

## 目录结构

```text
setup.ps1            Windows 总入口（自动提权，右键运行会交互询问组件）
setup.sh             Linux / Git Bash 总入口（Git Bash 下自动转交 setup.ps1）
tools.sh             已部署应用的统一操作入口（Linux；Git Bash 下自动转交 tools.ps1）
tools.ps1            已部署应用的统一操作入口（Windows，功能与 tools.sh 一致）
windows/             Windows 侧组件（kdesk / nodejs / ai-tools / openssh）
linux/               Linux 侧组件（nodejs / ai-tools / openssh）
completion/          tools.sh / tools.ps1（含 setup 入口）的 Tab 智能补全脚本
docs/                部署与维护文档（见下方索引）
```

## 快速开始

Windows（PowerShell，自动弹 UAC 提权）：

```powershell
setup.ps1                        # 部署全部组件
setup.ps1 nodejs                 # 只部署某个组件
setup.ps1 kdesk nodejs           # 部署多个组件
setup.ps1 ai-tools --codex       # ai-tools 只装/更新 codex（--all/--kimi 同理）
setup.ps1 openssh -Port 2223     # openssh 指定端口（Windows 默认 2222）
```

Linux（bash）：

```bash
./setup.sh                       # 部署全部组件
./setup.sh nodejs                # 只部署某个组件
./setup.sh ai-tools --kimi       # ai-tools 只装/更新 kimi
./setup.sh openssh --port 2222   # openssh 指定端口（Linux 默认 22）
```

注意：带工具参数（`--codex`、`-Port` 等）时请只指定一个组件，参数会原样透传给
该组件的脚本。

## 组件一览

| 组件 | Windows | Linux | 说明 |
| --- | --- | --- | --- |
| `kdesk` | ✓ | — | 元气桌面免安装便携部署 + 快照对抗自动升级，详见 [docs/kdesk-notes.md](docs/kdesk-notes.md) |
| `nodejs` | ✓ | ✓ | Node.js 环境部署 |
| `ai-tools` | ✓ | ✓ | Kimi Code / Codex CLI 安装与更新，详见 [docs/ai-tools-notes.md](docs/ai-tools-notes.md) |
| `openssh` | ✓ | ✓ | OpenSSH Server 安装与配置，详见 [docs/openssh-notes.md](docs/openssh-notes.md) |

## 日常操作（tools.sh / tools.ps1）

Linux 用 `./tools.sh`，Windows 用 `tools.ps1`，参数完全一致：

```bash
./tools.sh ai-tools --usage              # 持续监控余量（Ctrl+R 刷新，Ctrl+L 登录）
./tools.sh ai-tools --usage --json       # 单次输出 JSON，供其他脚本读取
./tools.sh openssh --status              # 查看 sshd 服务状态、监听端口与连接示例
./tools.sh                               # 查看完整用法
```

余量监控的配置（凭证位置、网页登录和 Kimi 月度总量网页 token 等）见
[docs/usage-monitor.md](docs/usage-monitor.md)。Windows Electron 看板的齿轮按钮可直接
配置 API Key、手动启动 agent 网页授权和选择要显示的用量；筛选状态会在重启后保留。

## 指令智能补全

`completion/` 提供 `tools.sh` / `setup.sh`（bash）与 `tools.ps1` / `setup.ps1`
（PowerShell）的 Tab 补全：应用名、操作与 usage 参数（含 `--provider` 的取值、
凭证文件路径）都能补全。PowerShell 版对 `tools.ps1`、`.\tools.ps1`、完整路径
等调用形态均生效。

**运行一次 `setup.sh` / `setup.ps1` 会自动完成接线（幂等）**，新开终端即生效：

- **bash（Linux/WSL）**：source 行写入 `~/.bashrc`；
- **PowerShell**：补全脚本写入 `$PROFILE`（内部包装了 `TabExpansion2`，
  让已输入 `-` 的词也能补全，对其他命令透明）；
- **Git Bash（Windows）**：source 行写入 `%USERPROFILE%\.bashrc`
  （git 装在自定义目录也能从 `git.exe` 反推定位）；
- **cmd.exe**：原生只支持文件名补全。参数补全需安装 [Clink](https://chrisant996.github.io/clink/)
  （`winget install clink`）；检测到 Clink 后 setup 会自动把
  `completion/env-tools.clink.lua` 挂进 `%LOCALAPPDATA%\clink\`，对根目录的
  `tools.cmd` / `setup.cmd` 桥接入口生效。

手动启用（当前会话临时生效）：

```bash
source completion/env-tools.bash
```

```powershell
. "D:\path\to\Env-Tools\completion\Env-Tools.Completion.ps1"
```

## 文档索引

- [docs/ai-tools-notes.md](docs/ai-tools-notes.md) — AI CLI 安装/升级与额度接口的维护经验
- [docs/usage-monitor.md](docs/usage-monitor.md) — 终端额度监控的凭证配置与使用说明
- [docs/kdesk-notes.md](docs/kdesk-notes.md) — kdesk 一键部署的结构与排障笔记
- [docs/kdesk-research-notes.md](docs/kdesk-research-notes.md) — kdesk 免安装部署的研究结论与运维速查
- [docs/openssh-notes.md](docs/openssh-notes.md) — OpenSSH 双平台部署与端口约定

## 维护注意

- **所有 `.ps1` 必须保存为 UTF-8 带 BOM**：Windows PowerShell 5.1 对无 BOM 的
  脚本按 GBK 解码，中文字符串会乱码。改完用 `head -c 3 file.ps1` 确认是
  `EF BB BF`（详见 docs/kdesk-notes.md 坑 2）。
- **端口约定**：WSL 的 sshd 占 22，Windows 组件默认用 2222 避开冲突（详见
  docs/openssh-notes.md）。
- 各组件日志写在各自目录的 `log/setup.log`（kdesk 另有 `log/deploy.log`）。
- `windows/openssh/OpenSSH-Win64-*.msi` 随库分发保证离线可装，升级时替换该文件即可。
