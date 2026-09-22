//! `apply-update` 子命令：zip/tar.gz 升级包的解压与目录交换（v0.7.7 起原生实现，
//! 取代 Electron 运行时生成的 upgrade.ps1/upgrade.sh 与 Expand-Archive/tar 调用）。
//!
//! 调用方（Electron 主进程）在退出前 detached 拉起：
//!   env-tools-api apply-update --archive <zip|tar.gz> --cur <安装目录> --exe <Env-Tools.exe|Env-Tools>
//! 本进程与正在运行的 server 实例互不干扰（不连端口），处理完直接 exit，不起 server。
//!
//! 语义与原脚本一致：等旧进程退出 → cur 改名 cur.old → 新目录就位 → 拉起新 exe →
//! 5s 后验证；任何一步失败都回滚到旧版本。退出码 0 成功 / 1 失败。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// 旧进程退出等待上限（秒），超时后强制结束再等 KILL_GRACE_SECS
const WAIT_EXIT_SECS: u64 = 60;
const KILL_GRACE_SECS: u64 = 15;
/// 新 exe 拉起后的存活验证延迟（同原脚本 Start-Sleep 5）
const VERIFY_DELAY_SECS: u64 = 5;

struct Options {
    archive: PathBuf,
    cur: PathBuf,
    exe: String,
}

pub fn run(args: &[String]) -> i32 {
    let opts = match parse_args(args) {
        Ok(opts) => opts,
        Err(err) => {
            eprintln!("[apply-update] {err}");
            return 1;
        }
    };
    // 清理上一轮升级遗留的临时目录（超过 1 小时视为残留；进行中的不会被误删）
    if let Some(parent) = opts.cur.parent() {
        clean_stale_temp(parent);
    }
    // 本进程若以 <cur> 内的二进制运行（Electron 就地拉起 env-tools-api），自身镜像
    // 会永久占住"后端二进制"探测锁、Windows 上还会卡住目录改名：复制自身到 cur 同级
    // 临时目录接力执行，原进程随即退出释放锁。
    if exe_inside(&opts.cur) {
        if std::env::var_os("ENV_TOOLS_APPLY_UPDATE_SELFCOPY").is_some() {
            // 兜底防死循环：接力副本落在 cur 外，正常不会走到这里
            eprintln!("[apply-update] self-copy still resolves inside install dir; aborting");
            return 1;
        }
        match reexec_from_copy(&opts, args) {
            // 副本已 detached 拉起，本进程直接退出释放文件锁
            Ok(()) => std::process::exit(0),
            Err(err) => {
                eprintln!("[apply-update] self-copy re-exec failed: {err}");
                return 1;
            }
        }
    }
    let result = execute(&opts);
    // 接力副本目录收尾（Windows 上运行中的自身 exe 删不掉，经 detached cmd 延迟删除）
    if let Ok(copy_dir) = std::env::var("ENV_TOOLS_APPLY_UPDATE_SELFCOPY") {
        remove_selfcopy_dir(&PathBuf::from(copy_dir));
    }
    match result {
        Ok(()) => {
            eprintln!("[apply-update] done");
            0
        }
        Err(err) => {
            eprintln!("[apply-update] FAILED: {err}");
            1
        }
    }
}

fn parse_args(args: &[String]) -> Result<Options, String> {
    let mut archive = None;
    let mut cur = None;
    let mut exe = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--archive" => archive = iter.next().cloned(),
            "--cur" => cur = iter.next().cloned(),
            "--exe" => exe = iter.next().cloned(),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let archive = PathBuf::from(archive.ok_or("missing --archive <path>")?);
    // 去掉结尾分隔符，避免 cur.old 等派生路径出现双斜杠
    let cur_raw = cur.ok_or("missing --cur <dir>")?;
    let cur = PathBuf::from(cur_raw.trim_end_matches(['/', '\\']));
    let exe = exe.ok_or("missing --exe <name>")?;
    if !archive.is_file() {
        return Err(format!("archive not found: {}", archive.display()));
    }
    if !cur.is_dir() {
        return Err(format!("install dir not found: {}", cur.display()));
    }
    Ok(Options { archive, cur, exe })
}

/// 当前进程镜像是否位于 dir 内（Windows 路径大小写不敏感）。
fn exe_inside(dir: &Path) -> bool {
    let Ok(self_exe) = std::env::current_exe() else { return false };
    let self_exe = self_exe.canonicalize().unwrap_or(self_exe);
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    if cfg!(windows) {
        self_exe
            .to_string_lossy()
            .to_lowercase()
            .starts_with(dir.to_string_lossy().to_lowercase().as_str())
    } else {
        self_exe.starts_with(&dir)
    }
}

/// 复制自身到 cur 同级临时目录并 detached 接力执行同一子命令。
fn reexec_from_copy(opts: &Options, args: &[String]) -> Result<(), String> {
    let self_exe = std::env::current_exe().map_err(|e| format!("current_exe failed: {e}"))?;
    let parent = opts.cur.parent().ok_or("install dir has no parent")?;
    let copy_dir = parent.join(format!(".env-tools-update-self-{}", std::process::id()));
    std::fs::create_dir_all(&copy_dir)
        .map_err(|e| format!("cannot create {}: {e}", copy_dir.display()))?;
    let file_name = self_exe.file_name().ok_or("current exe has no file name")?;
    let copy_exe = copy_dir.join(file_name);
    std::fs::copy(&self_exe, &copy_exe)
        .map_err(|e| format!("cannot copy {} to {}: {e}", self_exe.display(), copy_exe.display()))?;
    #[cfg(unix)]
    mark_executable(&copy_exe);
    eprintln!("[apply-update] re-executing from {} ...", copy_exe.display());
    let mut cmd = Command::new(&copy_exe);
    cmd.arg("apply-update")
        .args(args)
        .current_dir(&copy_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env("ENV_TOOLS_APPLY_UPDATE_SELFCOPY", &copy_dir);
    detach(&mut cmd);
    cmd.spawn().map_err(|e| format!("cannot spawn self copy: {e}"))?;
    Ok(())
}

fn execute(opts: &Options) -> Result<(), String> {
    let exe_path = opts.cur.join(&opts.exe);
    let backend = opts
        .cur
        .join("resources")
        .join("app")
        .join("backend-rs")
        .join("target")
        .join("release")
        .join(if cfg!(windows) { "env-tools-api.exe" } else { "env-tools-api" });
    let probes = vec![exe_path.clone(), backend.clone()];

    // 1. 解压到 cur 同级临时目录（同卷，保证后续 rename/move 可用）
    let parent = opts.cur.parent().ok_or("install dir has no parent")?.to_path_buf();
    let temp = TempDir::new(parent.join(format!(".env-tools-update-{}", std::process::id())))?;
    let extract_dir = temp.path().join("extracted");
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| format!("cannot create {}: {e}", extract_dir.display()))?;
    eprintln!("[apply-update] extracting {} ...", opts.archive.display());
    let name = opts
        .archive
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if name.ends_with(".zip") {
        extract_zip(&opts.archive, &extract_dir)?;
    } else if name.ends_with(".tar.gz") || name.ends_with(".tgz") {
        extract_targz(&opts.archive, &extract_dir)?;
    } else {
        return Err(format!("unsupported archive type (expect .zip or .tar.gz): {name}"));
    }
    // 校验：恰好一个顶层目录且内含 <exe>（口径同 Electron extractUpdate 调用方）
    let entries: Vec<PathBuf> = std::fs::read_dir(&extract_dir)
        .map_err(|e| format!("cannot list {}: {e}", extract_dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .collect();
    if entries.len() != 1 {
        return Err(format!(
            "unexpected package layout: {} top-level entries (expect exactly 1)",
            entries.len()
        ));
    }
    let new_dir = entries.into_iter().next().unwrap();
    if !new_dir.is_dir() || !new_dir.join(&opts.exe).is_file() {
        return Err(format!(
            "unexpected package layout: {} missing {}",
            new_dir.display(),
            opts.exe
        ));
    }

    // 2. 等旧进程退出：写模式打开失败即文件仍被运行中的进程占用（跨平台零依赖）
    eprintln!("[apply-update] waiting for old process to exit ({}s max) ...", WAIT_EXIT_SECS);
    if !wait_until_unlocked(&probes, WAIT_EXIT_SECS) {
        eprintln!("[apply-update] still locked; force killing ...");
        force_kill(&opts.cur, &opts.exe);
        if !wait_until_unlocked(&probes, KILL_GRACE_SECS) {
            return Err(
                "old process still running after kill; aborting (install dir untouched)".into()
            );
        }
    }

    // 3. 交换目录
    eprintln!("[apply-update] swapping {} ...", opts.cur.display());
    let old = suffixed(&opts.cur, ".old");
    if old.exists() {
        std::fs::remove_dir_all(&old)
            .map_err(|e| format!("cannot remove stale {}: {e}", old.display()))?;
    }
    std::fs::rename(&opts.cur, &old)
        .map_err(|e| format!("rename {} -> {} failed: {e}", opts.cur.display(), old.display()))?;
    if let Err(err) = std::fs::rename(&new_dir, &opts.cur) {
        // 新目录就位失败：立即回滚，保留旧版本
        let _ = std::fs::rename(&old, &opts.cur);
        return Err(format!("move new dir into place failed: {err} (rolled back)"));
    }
    #[cfg(unix)]
    {
        mark_executable(&exe_path);
        mark_executable(&backend);
    }

    // 4. detached 拉起新版本
    eprintln!("[apply-update] starting {} ...", exe_path.display());
    if let Err(err) = spawn_detached(&exe_path, &opts.cur) {
        rollback(&opts.cur, &old, &opts.exe);
        return Err(format!("cannot start new exe: {err} (rolled back)"));
    }
    std::thread::sleep(Duration::from_secs(VERIFY_DELAY_SECS));

    // 5. 验证：写模式打开失败 = 新 exe 正在运行
    if path_locked(&exe_path) {
        eprintln!("[apply-update] new version running; removing {} ...", old.display());
        remove_dir_all_retry(&old);
        Ok(())
    } else {
        eprintln!(
            "[apply-update] new exe not running after {}s; rolling back ...",
            VERIFY_DELAY_SECS
        );
        rollback(&opts.cur, &old, &opts.exe);
        Err("new version failed to start; rolled back to previous version".into())
    }
}

/// 交换失败/验证失败的回滚：cur → cur.new-failed，cur.old 复位，拉起旧 exe。
fn rollback(cur: &Path, old: &Path, exe: &str) {
    let failed = suffixed(cur, ".new-failed");
    if failed.exists() {
        remove_dir_all_retry(&failed);
    }
    let _ = std::fs::rename(cur, &failed);
    if let Err(err) = std::fs::rename(old, cur) {
        eprintln!("[apply-update] rollback rename failed: {err}");
        return;
    }
    let exe_path = cur.join(exe);
    eprintln!("[apply-update] rolled back; restarting old {} ...", exe_path.display());
    if let Err(err) = spawn_detached(&exe_path, cur) {
        eprintln!("[apply-update] cannot restart old exe: {err}");
    }
}

/// "进程是否还活着"探测：以写模式打开目标文件（不落任何字节，纯访问位探测）。
/// 运行中的可执行文件（Windows 共享冲突 / Linux ETXTBSY）会打开失败；文件不存在
/// 视为未运行。注意必须用 write 而非 append：Windows 11 24H2 起运行中镜像的
/// FILE_APPEND_DATA 打开不再被拒（实测可成功），FILE_WRITE_DATA 仍会冲突。
fn path_locked(path: &Path) -> bool {
    match std::fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(err) => err.kind() != std::io::ErrorKind::NotFound,
    }
}

fn wait_until_unlocked(probes: &[PathBuf], max_secs: u64) -> bool {
    for _ in 0..=max_secs {
        if !probes.iter().any(|p| path_locked(p)) {
            return true;
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    false
}

/// 超时后的强制结束：Windows 按镜像名 taskkill（/FI 排除自身 PID——接力副本与
/// 后端同名 env-tools-api.exe），Linux 按完整路径 pkill。
fn force_kill(cur: &Path, exe: &str) {
    if cfg!(windows) {
        let own_pid = std::process::id().to_string();
        for image in [exe, "env-tools-api.exe"] {
            let _ = Command::new("taskkill")
                .args(["/IM", image, "/F", "/FI"])
                .arg(format!("PID ne {own_pid}"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    } else {
        let target = cur.join(exe);
        let _ = Command::new("pkill")
            .arg("-f")
            .arg(&target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

/// detached 拉起（等价原脚本的 Start-Process / nohup）：stdio 全空，Windows 加
/// DETACHED_PROCESS 标志，unix 直接 spawn（父进程退出后子进程由 init 收养）。
fn spawn_detached(exe: &Path, workdir: &Path) -> std::io::Result<()> {
    let mut cmd = Command::new(exe);
    cmd.current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    detach(&mut cmd);
    cmd.spawn().map(|_| ())
}

fn detach(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(unix)]
    {
        let _ = cmd;
    }
}

#[cfg(unix)]
fn mark_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if path.is_file() {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
}

/// `path` 同级派生路径（保持 OsString，不经过 UTF-8 转换）：cur → cur.old
fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("cannot open {}: {e}", archive.display()))?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| format!("invalid zip {}: {e}", archive.display()))?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|e| format!("zip entry #{index}: {e}"))?;
        // enclosed_name 过滤 zip-slip（绝对路径/.. 穿越）
        let Some(name) = entry.enclosed_name() else { continue };
        let out = dest.join(name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out)
                .map_err(|e| format!("cannot create {}: {e}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        let mut target = std::fs::File::create(&out)
            .map_err(|e| format!("cannot write {}: {e}", out.display()))?;
        std::io::copy(&mut entry, &mut target)
            .map_err(|e| format!("cannot extract {}: {e}", out.display()))?;
        #[cfg(unix)]
        if let Some(mode) = entry.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode));
        }
    }
    Ok(())
}

fn extract_targz(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive)
        .map_err(|e| format!("cannot open {}: {e}", archive.display()))?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    // tar crate 的 unpack 自带 .. 穿越防护
    tar.unpack(dest)
        .map_err(|e| format!("cannot extract {}: {e}", archive.display()))?;
    Ok(())
}

/// 临时目录守卫：离开作用域即尽力删除（交换完成后 extracted/ 已空）
struct TempDir(PathBuf);

impl TempDir {
    fn new(path: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&path)
            .map_err(|e| format!("cannot create {}: {e}", path.display()))?;
        Ok(Self(path))
    }
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// 接力副本目录收尾：unix 直接删；Windows 运行中的自身 exe 删不掉，交给后台
/// powershell 延迟删除（本进程退出后锁才释放）。路径经环境变量传入，避免命令行
/// 拼接转义问题。实测注意：powershell 在 DETACHED_PROCESS 下不执行命令（静默
/// 退出），必须用 CREATE_NO_WINDOW；cmd timeout 在 null stdio 下会挂起，也不可用。
fn remove_selfcopy_dir(dir: &Path) {
    if cfg!(windows) {
        let mut cmd = Command::new("powershell");
        cmd.args([
            "-NoProfile",
            "-Command",
            "Start-Sleep -Seconds 2; Remove-Item -LiteralPath $env:ENV_TOOLS_RM_DIR -Recurse -Force",
        ])
        .env("ENV_TOOLS_RM_DIR", dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
        // cwd 不能落在待删目录内（本进程 cwd 即接力副本目录，子进程会继承）
        if let Some(parent) = dir.parent() {
            cmd.current_dir(parent);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let _ = cmd.spawn();
    } else {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// 带重试的目录删除：刚交换/解压出来的 exe 可能被 Defender、索引器等瞬时占用，
/// 直接放弃会留下 cur.old 残留；重试几次，最终失败仅记日志（升级本身已成功）。
fn remove_dir_all_retry(dir: &Path) {
    for attempt in 0..5 {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => return,
            Err(err) => {
                if attempt == 4 {
                    eprintln!("[apply-update] cannot remove {}: {err} (left in place)", dir.display());
                    return;
                }
                std::thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

/// 清理 parent 下上一轮升级遗留的临时目录（>1 小时视为残留）。
fn clean_stale_temp(parent: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(".env-tools-update-") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| now.duration_since(t).unwrap_or_default() > Duration::from_secs(3600))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
