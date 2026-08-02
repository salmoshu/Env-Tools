# kdesk（元气桌面）部署与排障笔记

本文记录 `windows/kdesk` 一键部署的结构与已踩过的坑，供后续维护参考。

## 结构

- `setup_elevated.ps1`：一次性装机脚本（自提权）。定位/便携部署 kdesk → 停进程与服务 →
  还原 33_1 快照 → 刷新备份 → 注册服务/注册表/快捷方式 → 注册登录任务 `KdeskAutoDeploy` →
  重定向壁纸缓存到项目目录 → 启动 kwallpaper 并运行优化器。
- `scripts/deploy.ps1`：每次登录由计划任务以最高权限运行，做同样的快照还原 + 优化器执行，
  用于对抗自动升级（降回 33_1）。
- `scripts/kdesk_locator.ps1`：定位已安装目录（缓存路径在 `scripts/data/kdesk_install_path.txt`）。
- `scripts/kdesk_integration.ps1`：共享函数库（服务/注册表/快捷方式/壁纸缓存/优化器）。
- `kdesk_33_1_backup/`：33_1 快照，还原与备份都靠 `robocopy /MIR`（退出码 0-7 均为成功）。
- 日志：`log/setup.log`（装机）、`log/deploy.log`（登录任务）。

## 坑 1：快照还原 robocopy exit=8/11（错误 32，文件被占用）

- **现象**：setup.log 中 `snapshot restore robocopy exit=8` → `ERROR: unable to copy the snapshot into the target dir`。
- **根因**：`kdeskmenu64.dll` 是资源管理器右键菜单外壳扩展，只要右键过一次桌面/文件，
  explorer.exe 就会加载目标目录里的这个 DLL 并**永不释放**，robocopy 覆盖时报错误 32
  （`ERROR_SHARING_VIOLATION`）。停掉 kdesk 自身进程和 kdeskcore 服务都不够。
- **处置**：`Invoke-KdeskSnapshotRestore`（integration 库）在 robocopy 失败后自动
  强杀 explorer.exe（系统会随即自动拉起，脚本也会兜底重启）释放锁并重试一次。
  装机时任务栏闪一下属正常现象。
- **排查手法**：用 PowerShell 遍历进程模块定位占用者——
  `Get-Process | % { $_.Modules | ? FileName -like '*kdesk*' }`；
  robocopy 加 `/LOG:` 落盘后用 `iconv -f GBK -t UTF-8` 读（robocopy 日志是 ANSI/GBK）。

## 坑 2：优化器 "not found"，路径变乱码（杞欢鎬ц兘浼樺寲.exe）

- **根因**：Windows PowerShell 5.1 对**无 BOM 的 .ps1 按系统 ANSI（中文机为 GBK）解码**，
  UTF-8 中文字面量（如 `'软件性能优化.exe'`）直接变乱码。很多编辑器/编辑工具保存时会丢 BOM，
  改完务必复查：`head -c 3 file.ps1` 应为 `EF BB BF`。
- **现状**：四个脚本均已加 BOM；优化器不再硬编码中文名，改用
  `Get-KdeskOptimizer` 动态扫描 kdesk 目录下的 exe，编码再坏也不受影响。

## 坑 3：优化器没有自动执行 / 执行无效

- **触发时机**：优化器只在两处运行——setup 脚本结尾、登录任务 `KdeskAutoDeploy` 触发的
  deploy.ps1。**手动打开元气桌面不会触发**。检查任务：
  `Get-ScheduledTask KdeskAutoDeploy | Get-ScheduledTaskInfo`（LastRunTime 为 1999 表示注册后尚未登录过）。
- **有效前提**：优化器是给运行中的 kwallpaper 打补丁，必须等其 UI 起来才有效。
  `Invoke-KdeskOptimizer` 内部已保证：先等 `kwallpaper` 进程出现（最多 60s），
  再固定延迟 3s 让其完成初始化，然后才启动优化器；两个脚本在调用前还有
  `Wait-KdeskWallpaperReady`（等真实窗口）+ 10s 余量。
- **成功判据**：日志 `optimizer exited, code=0`（打完即退）或 `running in background`（驻留）均正常。

## 常用检查命令

```powershell
# 占用 kdesk 目录文件的进程
Get-Process | Where-Object { $_.Path -like 'D:\software\kdesk*' }
# 服务状态
Get-Service kdeskcore
# 登录任务
Get-ScheduledTask KdeskAutoDeploy | Get-ScheduledTaskInfo
```
