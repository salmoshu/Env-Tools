# OpenSSH Server 部署笔记

本文记录 `windows/openssh` 与 `linux/openssh` 两个组件的结构与端口约定，供后续维护参考。

## 结构

- `windows/openssh/setup_openssh.ps1`：安装 + 配置一体。
  未检测到 OpenSSH 时优先用组件目录内的 `OpenSSH-Win64*.msi` 静默安装
  （`msiexec /qn ADDLOCAL=Server`），本地没有则从 GitHub 官方发布
  （PowerShell/Win32-OpenSSH）下载最新 MSI 再装；随后进入配置流程。
- `windows/openssh/OpenSSH-Win64-v10.0.0.0.msi`：随库分发的安装包（约 6.5MB，
  保证离线可用、版本可控）。要升级版本时替换此文件即可，脚本自动取目录内最新的 MSI。
- `linux/openssh/setup_openssh.sh`：包管理器安装（apt/dnf/yum/pacman）+ 启动，
  有 systemd 用 `systemctl enable --now`，无 systemd（旧版 WSL）回退 `service`。
- 日志：各自的 `log/setup.log`。
- 状态查询：Linux 用 `./tools.sh openssh --status`，Windows 用 `tools.ps1 openssh --status`
  （Windows 部署脚本结尾也会打印一次状态）。

## 端口约定：WSL 占 22，Windows 用 2222

本机的 Ubuntu 20.04 与 22.04（WSL）监听 TCP 22，WSL 镜像网络会把该端口映射到
Windows 侧，导致 Windows `sshd` 在 TCP 22 上报：

```text
Bind to port 22 failed: Permission denied
Cannot bind any address
```

因此约定：

- **Linux（含 WSL）组件默认端口 22**，脚本不主动改端口；
- **Windows 组件默认端口 2222**，避开冲突；
- 两侧的脚本在配置/启动前都会做端口占用检测：
  - Windows：`Test-PortCanBind` 尝试真实绑定 IPv4/IPv6，失败则报错退出并提示换端口；
  - Linux：`ss -tlnp` 查监听者，是本机 sshd 则视为幂等沿用，是其他进程
    （另一个 WSL 发行版、Docker 等）则列出占用者并报错退出。

## 用法

```powershell
# Windows（PowerShell，自动提权）
setup.ps1 openssh                  # 默认端口 2222
setup.ps1 openssh -Port 2223       # 自定义端口
setup.ps1 openssh -FirewallProfile Any   # 所有网络类型放行（公用网络慎用）
```

```bash
# Linux
./setup.sh openssh                 # 默认端口 22
./setup.sh openssh --port 2222     # 自定义端口
./tools.sh openssh --status        # 查看服务状态与监听端口
```

## Windows 侧行为细节（继承自原一键部署工具）

- 防火墙规则 `OpenSSH-Server-In-TCP` 默认只对「专用/域」网络放行；检测到公用网络
  时会给出 `Set-NetConnectionProfile ... -NetworkCategory Private` 的提示。
- 改写 `sshd_config` 前自动创建带时间戳的备份（`sshd_config.backup-yyyyMMdd-HHmmss`）。
- 服务失败动作设为 60 秒后重启（`sc.exe failure sshd reset= 86400 actions= restart/60000`），
  避免零延迟重启循环；部署失败时会停止并禁用 sshd。
- 兼容 MSI 版（`Program Files\OpenSSH`）与 Windows 可选功能版（`System32\OpenSSH`），
  后者没有 `FixHostFilePermissions.ps1`，用 icacls 兜底修 ACL。

## 维护注意

- `windows/openssh/setup_openssh.ps1` 必须保存为 **UTF-8 带 BOM**（Windows PowerShell
  5.1 对无 BOM 的 .ps1 按 GBK 解码，中文字符串会乱码，详见 docs/kdesk-notes.md 坑 2）。
- 登录用 Windows 账户密码，不是 Windows Hello PIN。
- `setup.ps1` / `setup.sh` 带工具参数时请只指定一个组件，参数会透传给该组件脚本。
