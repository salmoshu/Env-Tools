//! 管理类功能（1:1 移植自 Jharu apps.rs / startup.rs / system_space.rs /
//! protected.rs，Apache 2.0）。
//!
//! - apps_list：卸载表（含程序自带卸载命令），Windows 记录在注册表
//!   Uninstall 键下，含干净移除程序的命令。
//! - startup_scan / set_startup_enabled：启动项。Run 键（用户/机器/32 位；
//!   RunOnce 仅列出）、用户与公共 Startup 文件夹、登录触发的计划任务（仅
//!   列出）。开关状态来自任务管理器读写的 StartupApproved 标志，这里翻转
//!   同一标志，两边显示保持一致；Run 值或快捷方式本身永不删除。
//! - system_space：系统级空间大户（休眠文件/页面文件/还原点/组件仓库/
//!   Docker）。只读与变更分离；需要管理员的动作经固定 id 白名单 + 临时
//!   .ps1 + Start-Process -Verb RunAs 提权执行，命令行永不拼接用户文本。
//!
//! 评级刻意收窄，宁可"不动"：
//! - Safe：要启动的程序已不在（该项不再起作用）。
//! - Caution：其余可关闭项（更新器/助手、Microsoft 应用、未识别程序）。
//! - Risky：安全软件、硬件驱动、Windows 系统组件——拒绝关闭。

use crate::jharu::Safety;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn json_err(msg: &str) -> Value { serde_json::json!({ "ok": false, "error": msg }) }

fn hs(n: u64) -> String {
    let u: f64 = if cfg!(windows) { 1024.0 } else { 1000.0 };
    let v = n as f64;
    if v >= u.powi(4) { format!("{:.1}TB", v / u.powi(4)) }
    else if v >= u.powi(3) { format!("{:.1}GB", v / u.powi(3)) }
    else if v >= u.powi(2) { format!("{:.1}MB", v / u.powi(2)) }
    else if v >= u { format!("{:.0}KB", v) }
    else { format!("{n}B") }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn days_ago(unix: u64) -> u64 { now_secs().saturating_sub(unix) / 86_400 }

fn age_text(unix: u64) -> String {
    match days_ago(unix) {
        0 => "今天".into(),
        1 => "1 天前".into(),
        d => format!("{d} 天前"),
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

// ============================================================ protected

const SECURITY_SOFTWARE: &[&str] = &[
    "securityhealth", "sechealth", "windows security", "windows defender", "windowsdefender", "defender", "msmpeng",
    "mpcmdrun", "antimalware", "avast", "avg", "avira", "kaspersky", "norton", "mcafee", "bitdefender", "malwarebytes",
    "eset", "sophos", "crowdstrike", "sentinelone", "webroot", "trend micro", "f secure", "cylance", "carbon black",
    "comodo", "zonealarm", "emsisoft", "xprotect", "globalprotect", "palo alto", "pangps", "pangpa", "pangpsd",
    "zscaler", "netskope", "forticlient", "anyconnect", "little snitch",
];

const HARDWARE_DRIVERS: &[&str] = &[
    "realtek", "rthdvcpl", "rtkaud", "rtkngui", "nvidia", "nvcpl", "nvbackend", "nvtray", "nvdisplay", "igfx",
    "intel graphics", "intel r graphics", "intel r hd graphics", "intel r uhd graphics", "radeon", "amd software",
    "amdrs", "synaptics", "elantech", "touchpad", "bluetooth", "btmshellex", "maxxaudio", "waves", "dolby",
    "conexant", "hd audio", "audio manager", "audio driver", "sound blaster", "etdctrl", "syntp", "elan", "nahimic",
    "iaanotif", "intel r rapid", "intel r wireless", "wlan",
];

const WINDOWS_COMPONENTS: &[&str] = &["ctfmon", "userinit", "explorer", "sihost", "winlogon", "msctf"];

/// 小写化并把非字母数字折叠为单个空格。
fn normalize(s: &str) -> String {
    let mut out = String::new();
    let mut gap = true;
    for c in s.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            gap = false;
        } else if !gap {
            out.push(' ');
            gap = true;
        }
    }
    out.trim_end().to_string()
}

/// needle 出现在 hay 的词首。
fn starts_word(hay: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(i) = hay[from..].find(needle) {
        let at = from + i;
        if at == 0 || hay.as_bytes()[at - 1] == b' ' { return true; }
        from = at + 1;
    }
    false
}

/// 路径（小写、反斜杠）位于 Windows 文件夹内。
fn in_system_dir(target_lower: &str) -> bool {
    let mut roots: Vec<String> = vec!["c:\\windows\\".into()];
    if let Ok(r) = std::env::var("SystemRoot") {
        roots.push(format!("{}\\", r.to_lowercase().trim_end_matches('\\')));
    }
    roots.iter().any(|r| target_lower.starts_with(r.as_str()))
        || ["/system/", "/usr/libexec/", "/usr/sbin/", "/usr/bin/", "/sbin/", "/usr/lib/", "/library/apple/"]
            .iter().any(|p| target_lower.starts_with(p))
}

// ============================================================ 进程与文件信息

/// 一次性收集全部进程的 (exe 路径小写, 名, 内存)，供启动项"正在运行/占用
/// 内存"判断。Windows 对部分进程隐藏路径，此时仅名字可用。
fn gather_procs() -> Vec<(Option<String>, String, u64)> {
    let script = r#"Get-Process | Select-Object ProcessName, @{N='Exe';E={$_.Path}}, @{N='Mem';E={$_.WorkingSet64}} | ConvertTo-Json -Compress"#;
    let Ok(out) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .output()
    else { return vec![] };
    if !out.status.success() { return vec![]; }
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    let arr = v.as_array().cloned()
        .or_else(|| v.as_object().map(|o| vec![Value::Object(o.clone())]))
        .unwrap_or_default();
    arr.into_iter().filter_map(|p| {
        let name = p["ProcessName"].as_str()?.to_string();
        let exe = p["Exe"].as_str().map(|e| e.trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase());
        let mem = p["Mem"].as_u64().unwrap_or(0);
        Some((exe, name.to_lowercase(), mem))
    }).collect()
}

/// 程序是否在运行及其全部进程内存合计。路径匹配失败时按文件名匹配
/// （Windows 隐藏某些进程的路径时只剩名字可依）。
fn procs_lookup(procs: &[(Option<String>, String, u64)], target: Option<&Path>) -> (bool, Option<u64>) {
    let Some(target) = target else { return (false, None) };
    let want = target.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    let file = want.rsplit('\\').next().unwrap_or_default().to_string();
    let mut found = false;
    let mut total = 0u64;
    for (exe, name, mem) in procs {
        let same = match exe {
            Some(e) => *e == want,
            None => !file.is_empty() && *name == file,
        };
        if same { found = true; total += mem; }
    }
    (found, found.then_some(total))
}

/// 批量读取程序的版本资源（公司/描述）。PowerShell 一趟完成，替代
/// GetFileVersionInfoW。
fn files_info(paths: &[&Path]) -> HashMap<String, (Option<String>, Option<String>)> {
    let mut out: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    let clean: Vec<&Path> = paths.iter().copied().filter(|p| p.is_file()).collect();
    if clean.is_empty() { return out; }
    let list = clean.iter().map(|p| format!("'{}'", p.to_string_lossy().replace('\'', "''"))).collect::<Vec<_>>().join(",");
    let script = format!(
        r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Item -LiteralPath {list} -ErrorAction SilentlyContinue | ForEach-Object {{ [pscustomobject]@{{ Path = $_.FullName; Company = $_.VersionInfo.CompanyName; Desc = $_.VersionInfo.FileDescription }} }} | ConvertTo-Json -Compress"#
    );
    let Ok(out_put) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
    else { return out };
    if !out_put.status.success() { return out; }
    let text = String::from_utf8_lossy(&out_put.stdout);
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    let arr = v.as_array().cloned().or_else(|| v.as_object().map(|o| vec![Value::Object(o.clone())])).unwrap_or_default();
    for p in arr {
        let Some(path) = p["Path"].as_str() else { continue };
        let company = p["Company"].as_str().and_then(|s| if s.trim().is_empty() { None } else { Some(s.to_string()) });
        let desc = p["Desc"].as_str().and_then(|s| if s.trim().is_empty() { None } else { Some(s.to_string()) });
        out.insert(path.trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase(), (company, desc));
    }
    out
}

// ============================================================ apps（卸载器）

fn dir_size(path: &Path) -> u64 {
    if path.is_file() { return path.metadata().map(|m| m.len()).unwrap_or(0); }
    let mut stack = vec![path.to_path_buf()];
    let mut total = 0u64;
    while let Some(p) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&p) {
            for e in rd.flatten() {
                let ep = e.path();
                match std::fs::symlink_metadata(&ep) {
                    Ok(m) if m.is_dir() => stack.push(ep),
                    Ok(m) => total += m.len(),
                    _ => {}
                }
            }
        }
    }
    total
}

fn normalize_flat(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

struct IndexEntry {
    label: String,
    path: PathBuf,
    lower_name: String,
    norm_name: String,
}

fn build_index(home: &Path) -> Vec<IndexEntry> {
    let dirs: Vec<(&str, PathBuf)> = if cfg!(target_os = "windows") {
        vec![
            ("AppData Roaming", home.join("AppData").join("Roaming")),
            ("AppData Local", home.join("AppData").join("Local")),
        ]
    } else {
        vec![
            ("Config", home.join(".config")),
            ("Cache", home.join(".cache")),
            ("Data", home.join(".local").join("share")),
        ]
    };
    let mut index = vec![];
    for (label, dir) in dirs {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            index.push(IndexEntry {
                label: format!("{label} · {name}"),
                path: entry.path(),
                lower_name: name.to_lowercase(),
                norm_name: normalize_flat(&name),
            });
        }
    }
    index
}

fn index_matches(entry: &IndexEntry, norm_name: &str) -> bool {
    // 名字匹配只对有区分度的名字做，避免误报。
    if norm_name.len() >= 5 && entry.norm_name.contains(norm_name) { return true; }
    false
}

/// Windows 在卸载注册表键下记录每个已安装程序，包括干净移除它的命令。
pub fn apps_list() -> Value {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;

        const ROOTS: [(isize, &str); 3] = [
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
            (HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        ];

        let home = crate::settings::local_home();
        let index = build_index(&home);
        let mut apps: Vec<Value> = vec![];
        let mut seen: HashSet<String> = HashSet::new();

        for (hive, path) in ROOTS {
            let root = RegKey::predef(hive);
            let Ok(uninstall) = root.open_subkey_with_flags(path, KEY_READ) else { continue };
            for key_name in uninstall.enum_keys().flatten() {
                let Ok(key) = uninstall.open_subkey_with_flags(&key_name, KEY_READ) else { continue };
                let name: String = match key.get_value("DisplayName") { Ok(n) => n, Err(_) => continue };
                // 跳过补丁与更新：不是用户可卸载的条目。
                let sys_comp: u32 = key.get_value("SystemComponent").unwrap_or(0);
                let has_parent: Option<String> = key.get_value("ParentKeyName").ok();
                if sys_comp == 1 || has_parent.is_some() || !seen.insert(name.to_lowercase()) { continue; }

                let version: Option<String> = key.get_value("DisplayVersion").ok();
                let publisher: Option<String> = key.get_value("Publisher").ok();
                let uninstall_string: Option<String> = key
                    .get_value::<String, _>("QuietUninstallString").ok()
                    .or_else(|| key.get_value::<String, _>("UninstallString").ok());
                let install_location: Option<String> = key.get_value("InstallLocation").ok();

                // EstimatedSize 单位 KB；缺失时实测安装目录。
                let estimated_kb: u32 = key.get_value("EstimatedSize").unwrap_or(0);
                let size_bytes = if estimated_kb > 0 {
                    estimated_kb as u64 * 1024
                } else {
                    install_location.as_deref().filter(|p| !p.is_empty()).map(|p| dir_size(Path::new(p))).unwrap_or(0)
                };

                let norm = normalize_flat(&name);
                let data_bytes: u64 = index.iter()
                    .filter(|e| index_matches(e, &norm))
                    .map(|e| dir_size(&e.path))
                    .sum();

                apps.push(serde_json::json!({
                    "name": name, "path": install_location.unwrap_or_default(),
                    "size_bytes": size_bytes, "size_h": hs(size_bytes),
                    "data_bytes": data_bytes, "data_h": hs(data_bytes),
                    "version": version, "publisher": publisher,
                    "uninstall_command": uninstall_string,
                }));
            }
        }
        apps.sort_by(|a, b| (b["size_bytes"].as_u64().unwrap_or(0) + b["data_bytes"].as_u64().unwrap_or(0))
            .cmp(&(a["size_bytes"].as_u64().unwrap_or(0) + a["data_bytes"].as_u64().unwrap_or(0))));
        serde_json::json!({ "ok": true, "items": apps })
    }
    #[cfg(not(target_os = "windows"))]
    { json_err("应用列表仅支持 Windows") }
}

/// 运行程序自带的卸载器。Windows 要求这样做而不是删文件，程序才能正确
/// 注销自己。命令来自我们自己的注册表扫描。
pub fn run_uninstaller(command: &str) -> Value {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        if command.trim().is_empty() { return json_err("empty uninstall command"); }
        match std::process::Command::new("cmd")
            .args(["/C", "start", "", "/wait"])
            .raw_arg(command)
            .spawn()
        {
            Ok(_) => serde_json::json!({ "ok": true }),
            Err(e) => json_err(&format!("无法启动卸载器: {e}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = command; json_err("卸载仅支持 Windows") }
}

// ============================================================ Authenticode 签名校验

/// Windows Authenticode 验签（Get-AuthenticodeSignature，底层即
/// WinVerifyTrust）。
///
/// Jharu 的 codesign.rs 是 macOS 专用（读 Mach-O 团队 ID 供 group
/// container 匹配），Windows 侧它不验签、发布者取版本资源——版本资源里
/// 的公司名任何程序都能随便填。这里补上真正的证书链校验：启动项评级时
/// 用它防"自称大厂但未签名"的伪装（这类程序直接 Risky）。
fn verify_signatures(paths: &[&Path]) -> HashMap<String, (bool, String)> {
    let mut out: HashMap<String, (bool, String)> = HashMap::new();
    let clean: Vec<&Path> = paths.iter().copied().filter(|p| p.is_file()).collect();
    if clean.is_empty() { return out; }
    let list = clean.iter().map(|p| format!("'{}'", p.to_string_lossy().replace('\'', "''"))).collect::<Vec<_>>().join(",");
    let script = format!(
        r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-AuthenticodeSignature -LiteralPath {list} | ForEach-Object {{ [pscustomobject]@{{ Path = $_.Path; Status = [string]$_.Status; Signer = if ($_.SignerCertificate) {{ ($_.SignerCertificate.Subject -replace '^CN=([^,]+).*','$1') }} else {{ '' }} }} }} | ConvertTo-Json -Compress"#
    );
    let Ok(o) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
    else { return out };
    if !o.status.success() { return out; }
    let text = String::from_utf8_lossy(&o.stdout);
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    let arr = v.as_array().cloned()
        .or_else(|| v.as_object().map(|ob| vec![Value::Object(ob.clone())]))
        .unwrap_or_default();
    for p in arr {
        let Some(path) = p["Path"].as_str() else { continue };
        let valid = p["Status"].as_str() == Some("Valid");
        // CN 值本身可能带引号（Subject 里的转义），剥掉再展示。
        let signer = p["Signer"].as_str().unwrap_or("").trim().trim_matches('"').trim().to_string();
        out.insert(path.trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase(), (valid, signer));
    }
    out
}

/// 声称的大厂发布者：版本资源里写这些名字但验签失败/未签名 → 伪装嫌疑。
const KNOWN_VENDORS: &[&str] = &["microsoft", "google", "apple", "adobe", "intel", "nvidia", "amd", "docker", "oracle", "vmware"];

/// 启动项评级时的签名结论：
/// - (valid, Some(signer))：签名有效且是已知大厂 → 降级为更可信；
/// - 声称大厂但未签名 → 伪装，调用方应升 Risky。
fn signature_verdict(sigs: &HashMap<String, (bool, String)>, target: Option<&Path>, publisher: Option<&str>) -> Option<(bool, String)> {
    let target = target?;
    let key = target.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase();
    sigs.get(&key).cloned().map(|(valid, signer)| {
        let claims_vendor = publisher.is_some_and(|p| {
            let p = p.to_lowercase();
            KNOWN_VENDORS.iter().any(|v| p.contains(v))
        });
        if !valid && claims_vendor {
            // 声称大厂却没有有效签名：版本资源可伪造，签名不能。
            (false, format!("自称「{}」但没有有效数字签名，可能是伪装程序", publisher.unwrap_or("?")))
        } else if valid && !signer.is_empty() {
            (true, format!("已由「{signer}」数字签名（证书链有效）"))
        } else {
            (false, "未签名程序（无数字签名，来源无法核验）".to_string())
        }
    })
}

// ============================================================ startup（启动项）

/// 12 字节的 StartupApproved 值：首字节标志，禁用时跟 Windows FILETIME。
/// 任务管理器写 02=开、03=关；安装器批准过的项会出现 06/07。
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
enum Approved {
    Enabled,
    Disabled(u64),
    Unknown(u8),
}

fn parse_approved(bytes: &[u8]) -> Approved {
    let Some(&flag) = bytes.first() else { return Approved::Unknown(0) };
    match flag {
        0x02 | 0x06 => Approved::Enabled,
        0x03 | 0x07 => {
            let ft = bytes.get(4..12)
                .map(|b| u64::from_le_bytes(b.try_into().unwrap_or([0; 8])))
                .unwrap_or(0);
            Approved::Disabled(ft)
        }
        other => Approved::Unknown(other),
    }
}

/// 任务管理器写的 12 字节：开=02+零；关=03+当前 FILETIME。
fn approved_bytes(enable: bool, now_filetime: u64) -> [u8; 12] {
    let mut b = [0u8; 12];
    if enable { b[0] = 0x02; } else {
        b[0] = 0x03;
        b[4..12].copy_from_slice(&now_filetime.to_le_bytes());
    }
    b
}

const FILETIME_UNIX_OFFSET: u64 = 11_644_473_600;

fn filetime_to_unix(ft: u64) -> Option<u64> {
    (ft > 0).then(|| (ft / 10_000_000).saturating_sub(FILETIME_UNIX_OFFSET))
}

fn now_filetime() -> u64 {
    (now_secs() + FILETIME_UNIX_OFFSET) * 10_000_000
}

fn state_of(a: Option<Approved>) -> (Option<bool>, Option<u64>) {
    match a {
        None | Some(Approved::Enabled) => (Some(true), None),
        Some(Approved::Disabled(ft)) => (Some(false), filetime_to_unix(ft)),
        Some(Approved::Unknown(_)) => (None, None),
    }
}

/// `%NAME%` 引用从环境展开；未知的保持原样。
fn expand_env(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 => {
                let name = &after[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => { out.push('%'); out.push_str(name); out.push('%'); }
                }
                rest = &after[end + 1..];
            }
            _ => { out.push('%'); rest = after; }
        }
    }
    out.push_str(rest);
    out
}

fn is_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || p.starts_with('/')
}

fn is_unc(p: &str) -> bool { p.starts_with(r"\\") || p.starts_with("//") }

const PROGRAM_EXTS: &[&str] = &["exe", "com", "bat", "cmd", "msc", "lnk", "cpl", "jar", "ps1", "vbs", "js"];

fn has_program_ext(p: &str) -> bool {
    Path::new(p).extension()
        .map(|e| PROGRAM_EXTS.contains(&e.to_string_lossy().to_lowercase().as_str()))
        .unwrap_or(false)
}

/// 命令行启动的程序：(路径, 是否存在)。未加引号的路径可能含空格
/// （`C:\Program Files\X\x.exe /silent`），所以逐个空格前缀都试，第一个
/// 真实文件胜出。
fn resolve_command(command: &str) -> (Option<PathBuf>, Option<bool>) {
    let cmd = expand_env(command.trim());
    let cmd = cmd.trim();
    if cmd.is_empty() { return (None, None); }
    let candidates: Vec<String> = if let Some(rest) = cmd.strip_prefix('"') {
        vec![rest.split('"').next().unwrap_or("").to_string()]
    } else {
        let mut c: Vec<String> = cmd.char_indices()
            .filter(|(_, ch)| *ch == ' ')
            .map(|(i, _)| cmd[..i].to_string())
            .collect();
        c.push(cmd.to_string());
        c
    };
    let candidates: Vec<String> = candidates.into_iter().filter(|c| !c.is_empty()).collect();
    if candidates.is_empty() { return (None, None); }
    if candidates.iter().any(|c| is_unc(c)) {
        return (Some(PathBuf::from(&candidates[0])), None);
    }
    // 裸名（OneDrive.exe / cmd）：按 Windows 的查找顺序找。
    if !candidates[0].contains(['\\', '/']) {
        let first = &candidates[0];
        let found = search_path(first).or_else(|| if has_program_ext(first) { None } else { search_path(&format!("{first}.exe")) });
        return match found {
            Some(p) => (Some(p), Some(true)),
            None => (Some(PathBuf::from(first)), None),
        };
    }
    for c in &candidates {
        if is_absolute(c) {
            let p = PathBuf::from(c);
            if p.is_file() { return (Some(p), Some(true)); }
            if !has_program_ext(c) {
                let with_exe = PathBuf::from(format!("{c}.exe"));
                if with_exe.is_file() { return (Some(with_exe), Some(true)); }
            }
        }
    }
    // 都不存在。展示最像程序的最长候选。
    let shown = candidates.iter().rev().find(|c| has_program_ext(c)).unwrap_or(&candidates[0]).clone();
    let missing = if is_absolute(&shown) { Some(false) } else { None };
    (Some(PathBuf::from(shown)), missing)
}

fn search_path(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = vec![];
    if let Ok(root) = std::env::var("SystemRoot") {
        dirs.push(Path::new(&root).join("System32"));
        dirs.push(PathBuf::from(root));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

/// Windows 快捷方式（.lnk）指向的本地路径，直接从文件读。无普通路径的
/// 快捷方式（商店应用/网络位置）返回 None。
fn parse_lnk(b: &[u8]) -> Option<String> {
    let u32_at = |o: usize| b.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()) as usize);
    if u32_at(0)? != 0x4C { return None; }
    let flags = u32_at(0x14)?;
    let mut pos = 0x4C;
    if flags & 1 != 0 {
        let size = b.get(pos..pos + 2).map(|s| u16::from_le_bytes([s[0], s[1]]) as usize)?;
        pos += 2 + size;
    }
    if flags & 2 == 0 { return None; }
    let info = b.get(pos..)?;
    let at = |o: usize| info.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()) as usize);
    let header = at(4)?;
    if at(8)? & 1 == 0 { return None; } // 无本地基路径，只有网络路径
    if header >= 0x24 {
        let off = at(28)?;
        let units: Vec<u16> = info.get(off..)?
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|&u| u != 0)
            .collect();
        if !units.is_empty() { return Some(String::from_utf16_lossy(&units)); }
    }
    let off = at(16)?;
    let bytes: Vec<u8> = info.get(off..)?.iter().copied().take_while(|&c| c != 0).collect();
    (!bytes.is_empty()).then(|| String::from_utf8_lossy(&bytes).into_owned())
}

/// `schtasks /fo csv` 的 CSV：带引号字段、双写引号、字段内换行（任务
/// 备注里有）。
fn parse_csv(text: &str) -> Vec<Vec<String>> {
    let mut rows = vec![];
    let mut row: Vec<String> = vec![];
    let mut field = String::new();
    let mut quoted = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if quoted {
            match c {
                '"' if chars.peek() == Some(&'"') => { field.push('"'); chars.next(); }
                '"' => quoted = false,
                _ => field.push(c),
            }
        } else {
            match c {
                '"' => quoted = true,
                ',' => row.push(std::mem::take(&mut field)),
                '\r' => {}
                '\n' => {
                    row.push(std::mem::take(&mut field));
                    rows.push(std::mem::take(&mut row));
                }
                _ => field.push(c),
            }
        }
    }
    if !field.is_empty() || !row.is_empty() {
        row.push(field);
        rows.push(row);
    }
    rows
}

/// `schtasks /query /fo csv /v` 的列位置。所有语言里顺序一致；只有表头
/// 文本与计划词随语言变化。
const COL_TASK_NAME: usize = 1;
const COL_STATUS: usize = 3;
const COL_COMMAND: usize = 8;
const COL_STATE: usize = 11;
const COL_RUN_AS: usize = 14;
const COL_SCHEDULE_TYPE: usize = 18;
const MIN_COLUMNS: usize = 19;

fn parse_schtasks(text: &str) -> (Vec<(String, String, bool, String)>, bool) {
    let mut tasks = vec![];
    let mut english = false;
    for row in parse_csv(text) {
        if row.len() < MIN_COLUMNS || row[COL_TASK_NAME] == "TaskName" || row[0] == "HostName" { continue; }
        let schedule = row[COL_SCHEDULE_TYPE].to_lowercase();
        if ["daily", "weekly", "monthly", "one time", "at logon", "at system", "on idle", "on event", "at log on"]
            .iter().any(|w| schedule.contains(w))
        { english = true; }
        if !(schedule.contains("at logon") || schedule.contains("at log on")) { continue; }
        let path = row[COL_TASK_NAME].clone();
        let state_off = row[COL_STATE].eq_ignore_ascii_case("disabled") || row[COL_STATUS].eq_ignore_ascii_case("disabled");
        if tasks.iter().any(|(p, _, _, _)| *p == path) { continue; }
        tasks.push((path, row[COL_COMMAND].clone(), !state_off, row[COL_RUN_AS].clone()));
    }
    (tasks, english)
}

// ---------------------------------------------------------- 评级

const UPDATERS_AND_HELPERS: &[&str] = &["update", "updater", "autoupdate", "helper", "keystone", "notifier", "gc invoker", "maintenance"];

/// 正经软件极少在登录时从这些位置启动。
const ODD_PLACES: &[&str] = &["\\appdata\\local\\temp\\", "\\windows\\temp\\", "\\downloads\\"];

struct Cls<'a> {
    name: &'a str,
    target: Option<&'a str>,
    target_exists: Option<bool>,
    publisher: Option<&'a str>,
    description: Option<&'a str>,
    enabled: Option<bool>,
    running: bool,
    memory: Option<u64>,
}

fn protected_kind(c: &Cls) -> Option<&'static str> {
    let name = normalize(c.name);
    let file = c.target
        .and_then(|t| Path::new(t).file_stem().map(|s| normalize(&s.to_string_lossy())))
        .unwrap_or_default();
    let desc = c.description.map(normalize).unwrap_or_default();
    let publisher = c.publisher.map(normalize).unwrap_or_default();
    let target_lower = c.target.map(|t| t.to_lowercase().replace('/', "\\")).unwrap_or_default();
    let hit = |list: &[&str]| list.iter().any(|n| [&name, &file, &desc].iter().any(|h| starts_word(h, n)));
    if hit(SECURITY_SOFTWARE) || starts_word(&publisher, "malwarebytes") || starts_word(&publisher, "kaspersky") {
        return Some("安全软件");
    }
    if hit(HARDWARE_DRIVERS) || ["realtek", "nvidia", "synaptics"].iter().any(|p| starts_word(&publisher, p)) {
        return Some("硬件驱动");
    }
    if in_system_dir(&target_lower) || hit(WINDOWS_COMPONENTS) {
        return Some("Windows 系统组件");
    }
    None
}

fn is_updater(c: &Cls) -> bool {
    let name = normalize(c.name);
    let file = c.target
        .and_then(|t| Path::new(t).file_stem().map(|s| normalize(&s.to_string_lossy())))
        .unwrap_or_default();
    UPDATERS_AND_HELPERS.iter().any(|n| name.contains(n) || file.contains(n))
}

fn classify(c: &Cls) -> (Safety, String, Vec<Value>) {
    let mut safety = Safety::Safe;
    let summary: String;
    let mut reasons: Vec<Value> = vec![];
    let mut note = |level: &str, at_least: Safety, text: String| {
        if at_least > safety { safety = at_least; }
        reasons.push(serde_json::json!({"level": level, "text": text}));
    };
    let protected = protected_kind(c);

    // 1：该项还有作用吗？
    match c.target_exists {
        Some(false) => note("ok", Safety::Safe, format!(
            "它启动的程序已不在（{}），此项不再起作用，关闭只是整理列表。",
            c.target.unwrap_or("路径未知"),
        )),
        Some(true) => {}
        None => note("warn", Safety::Caution, "无法确定它启动哪个文件，因此无法判断该项是否还有作用。".into()),
    }

    // 2：它是什么？
    if let Some(what) = protected {
        note("bad", Safety::Risky, format!("看起来是{what}。不会帮你关闭：它可能保护或驱动这台电脑。"));
        summary = format!("受保护：{what}");
    } else if c.target_exists == Some(false) {
        summary = "目标已缺失".into();
    } else if is_updater(c) {
        note("warn", Safety::Caution, "看起来是更新器或助手程序。关闭后该程序通常不再自动检查更新，或失去托盘功能，直到你手动打开。".into());
        summary = "更新器/助手".into();
    } else {
        let microsoft = c.publisher.is_some_and(|p| p.to_lowercase().contains("microsoft"));
        let text = if microsoft {
            "Windows 文件夹之外的 Microsoft 程序（如 OneDrive、Teams）。可关，但先看清它做什么。"
        } else {
            "未识别的程序。查看发布者与位置后再决定。关闭只影响下次登录自启。"
        };
        note("warn", Safety::Caution, text.into());
        summary = if microsoft { "Microsoft 应用".into() } else { "未识别".into() };
    }

    // 3：从哪里启动？
    if c.target_exists != Some(false) {
        let t = c.target.unwrap_or("").to_lowercase().replace('/', "\\");
        if ODD_PLACES.iter().any(|p| t.contains(p)) {
            note("warn", Safety::Caution, "从临时或下载文件夹启动，长期安装的软件极少这样。".into());
        }
    }

    // 4：状态与占用。
    if c.enabled == Some(false) {
        note("ok", Safety::Safe, "已关闭：登录时不会启动。可以重新打开。".into());
    }
    if c.running {
        let mem = c.memory.map(|m| format!("；其进程约占 {}", hs(m))).unwrap_or_default();
        note("ok", Safety::Safe, format!("正在运行{mem}。关闭只影响下次登录，不会结束进程。"));
    }
    drop(note);
    (safety, summary, reasons)
}

/// 诚实的估计：现在在跑什么、程序多大。不是实测的启动耗时，措辞如此。
fn estimate_impact(enabled: Option<bool>, exists: Option<bool>, size: Option<u64>, running: bool, memory: Option<u64>) -> Value {
    const HIGH: u64 = 200 * 1024 * 1024;
    const MEDIUM: u64 = 50 * 1024 * 1024;
    const LARGE: u64 = 150 * 1024 * 1024;
    let (level, text) = if enabled == Some(false) {
        ("none", "已关闭：登录时无启动。".to_string())
    } else if exists == Some(false) {
        ("none", "无启动：程序已缺失。".to_string())
    } else if exists.is_none() {
        ("unknown", "无法估计：找不到程序。".to_string())
    } else if running {
        let m = memory.unwrap_or(0);
        let level = if m >= HIGH { "high" } else if m >= MEDIUM { "medium" } else { "low" };
        (level, format!("正在运行；其进程约占 {} 内存。", hs(m)))
    } else if size.is_some_and(|s| s >= LARGE) {
        ("medium", format!("当前未运行，但程序较大（{}），登录时要加载。", hs(size.unwrap_or(0))))
    } else {
        ("low", "当前未运行：登录后可能很快退出或仅按需启动。".to_string())
    };
    serde_json::json!({ "level": level, "text": format!("估计：{text}") })
}

// ---------------------------------------------------------- 收集

struct RawStartup {
    id: String,
    name: String,
    kind_label: &'static str,
    /// StartupApproved 子键名；None = 此类不可开关（只列出）。
    table: Option<&'static str>,
    scope_user: bool,
    command: String,
    location: String,
    enabled: Option<bool>,
    disabled_at: Option<u64>,
    target: Option<PathBuf>,
    target_exists: Option<bool>,
}

#[cfg(target_os = "windows")]
fn read_approved(hive_user: bool, table: &str, name: &str) -> Option<Approved> {
    use winreg::enums::*;
    use winreg::RegKey;
    const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";
    let hive = if hive_user { RegKey::predef(HKEY_CURRENT_USER) } else { RegKey::predef(HKEY_LOCAL_MACHINE) };
    let key = hive.open_subkey_with_flags(APPROVED, KEY_READ).ok()?;
    let sub = key.open_subkey_with_flags(table, KEY_READ).ok()?;
    let v = sub.get_raw_value(name).ok()?;
    if v.vtype != REG_BINARY { return None; }
    Some(parse_approved(&v.bytes))
}

/// 生效状态：本用户自己的标志优先，其次机器的。
#[cfg(target_os = "windows")]
fn effective_state(scope_user: bool, table: &str, name: &str) -> (Option<bool>, Option<u64>) {
    let own = read_approved(true, table, name);
    match scope_user {
        true => state_of(own),
        false => state_of(own.or_else(|| read_approved(false, table, name))),
    }
}

#[cfg(target_os = "windows")]
fn collect_startup() -> (Vec<RawStartup>, Vec<String>, usize) {
    use winreg::enums::*;
    use winreg::RegKey;

    const RUN_USER: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const RUN_ONCE: &str = r"Software\Microsoft\Windows\CurrentVersion\RunOnce";
    const RUN_32: &str = r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run";

    let mut raws = vec![];
    let mut notes = vec![];
    let mut hidden = 0usize;

    // Run 键：用户 + 机器 + 32 位机器 + RunOnce（仅列出）。
    for (scope_user, sub, kind_label, table) in [
        (true, RUN_USER, "Run 键", Some("Run")),
        (false, RUN_USER, "Run 键（机器）", Some("Run")),
        (false, RUN_32, "Run 键（32 位）", Some("Run32")),
        (true, RUN_ONCE, "RunOnce 键（仅列出）", None),
    ] {
        let hive = if scope_user { RegKey::predef(HKEY_CURRENT_USER) } else { RegKey::predef(HKEY_LOCAL_MACHINE) };
        let Ok(run) = hive.open_subkey_with_flags(sub, KEY_READ) else { continue };
        let values: Vec<(String, String)> = run.enum_values().flatten()
            .filter(|(name, _)| !name.is_empty())
            .filter_map(|(name, v)| {
                use winreg::types::FromRegValue;
                // 仅字符串类型的值（REG_SZ / REG_EXPAND_SZ）是启动命令。
                let s = String::from_reg_value(&v).ok()?;
                (!s.is_empty()).then_some((name, s))
            })
            .collect();
        for (name, command) in values {
            let (enabled, disabled_at) = match table {
                Some(t) => effective_state(scope_user, t, &name),
                None => (Some(true), None),
            };
            let (target, target_exists) = resolve_command(&command);
            let hive_label = if scope_user { "HKCU" } else { "HKLM" };
            raws.push(RawStartup {
                id: format!("{}|{}|{}", table.unwrap_or("other"), if scope_user { "user" } else { "machine" }, name),
                name, kind_label, table, scope_user, command,
                location: format!(r"{hive_label}\{sub}"),
                enabled, disabled_at, target, target_exists,
            });
        }
    }

    // Startup 文件夹：用户 + 公共。
    let home = crate::settings::local_home();
    let folders = [
        (true, home.join("AppData").join("Roaming").join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("Startup")),
        (false, PathBuf::from(std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into()))
            .join("Microsoft").join("Windows").join("Start Menu").join("Programs").join("Startup")),
    ];
    for (scope_user, dir) in folders {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let path = e.path();
            if !path.is_file() { continue; }
            let file = e.file_name().to_string_lossy().into_owned();
            if file.eq_ignore_ascii_case("desktop.ini") { continue; }
            let is_lnk = path.extension().is_some_and(|x| x.eq_ignore_ascii_case("lnk"));
            let (command, target, exists) = if is_lnk {
                // 真快捷方式几 KB；从不读巨大文件。
                let small = std::fs::metadata(&path).is_ok_and(|m| m.len() <= 1024 * 1024);
                match small.then(|| std::fs::read(&path).ok()).flatten().and_then(|b| parse_lnk(&b)) {
                    Some(t) => {
                        let (target, exists) = resolve_command(&format!("\"{t}\""));
                        (t, target, exists)
                    }
                    None => (path.to_string_lossy().into_owned(), None, None), // 商店应用/网络目标
                }
            } else {
                (path.to_string_lossy().into_owned(), Some(path.clone()), Some(true))
            };
            let (enabled, disabled_at) = effective_state(scope_user, "StartupFolder", &file);
            raws.push(RawStartup {
                id: format!("folder|{}|{}", if scope_user { "user" } else { "machine" }, file),
                name: path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| file.clone()),
                kind_label: "Startup 文件夹", table: Some("StartupFolder"), scope_user, command,
                location: dir.to_string_lossy().into_owned(),
                enabled, disabled_at, target, target_exists: exists,
            });
        }
    }

    // 登录触发的计划任务（仅列出，较慢）。
    if let Ok(out) = std::process::Command::new("schtasks").args(["/query", "/fo", "csv", "/v"]).output() {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            let (tasks, english) = parse_schtasks(&text);
            if !english && !tasks.is_empty() {
                notes.push("计划任务列表不是英文输出，可能混入了非登录触发的任务。".into());
            }
            for (path, command, enabled, run_as) in tasks {
                if path.to_lowercase().starts_with(r"\microsoft\windows\") { hidden += 1; continue; }
                let (target, target_exists) = resolve_command(&command);
                raws.push(RawStartup {
                    id: format!("task|machine|{}", path.trim_start_matches('\\')),
                    name: path.trim_start_matches('\\').to_string(),
                    kind_label: "登录计划任务（仅列出）", table: None, scope_user: false, command,
                    location: format!("计划任务 {path}（{run_as}）"),
                    enabled: Some(enabled), disabled_at: None, target, target_exists,
                });
            }
        }
    }

    (raws, notes, hidden)
}

#[cfg(not(target_os = "windows"))]
fn collect_startup() -> (Vec<RawStartup>, Vec<String>, usize) { (vec![], vec!["启动项仅支持 Windows".into()], 0) }

fn finish_startup(raw: RawStartup, procs: &[(Option<String>, String, u64)], infos: &HashMap<String, (Option<String>, Option<String>)>, sigs: &HashMap<String, (bool, String)>) -> Value {
    let on_disk = raw.target.as_ref().filter(|_| raw.target_exists == Some(true));
    let size = on_disk.and_then(|p| std::fs::metadata(p).ok()).filter(|m| m.is_file()).map(|m| m.len());
    let info = on_disk
        .map(|p| infos.get(&p.to_string_lossy().trim_start_matches(r"\\?\").replace('/', "\\").to_lowercase()).cloned().unwrap_or((None, None)))
        .unwrap_or((None, None));
    let (running, memory) = procs_lookup(procs, raw.target.as_deref());
    let target_str = raw.target.as_ref().map(|p| p.to_string_lossy().into_owned());
    let (mut safety, summary, reasons) = classify(&Cls {
        name: &raw.name,
        target: target_str.as_deref(),
        target_exists: raw.target_exists,
        publisher: info.0.as_deref(),
        description: info.1.as_deref(),
        enabled: raw.enabled,
        running,
        memory,
    });
    // Authenticode 结论：有效签名加分说明；声称大厂但未签名 → 直接 Risky。
    let mut reasons = reasons;
    if let Some((good, text)) = signature_verdict(sigs, raw.target.as_deref(), info.0.as_deref()) {
        if !good && text.contains("伪装") {
            safety = Safety::Risky;
            reasons.push(serde_json::json!({"level":"bad","text":text}));
        } else if good {
            reasons.push(serde_json::json!({"level":"ok","text":text}));
        } else {
            reasons.push(serde_json::json!({"level":"warn","text":text}));
        }
    }
    let impact = estimate_impact(raw.enabled, raw.target_exists, size, running, memory);
    let can_toggle = raw.table.is_some();
    serde_json::json!({
        "id": raw.id, "name": raw.name,
        "description": info.1, "publisher": info.0,
        "command": raw.command, "target": target_str,
        "target_exists": raw.target_exists,
        "kind_label": raw.kind_label,
        "scope": if raw.scope_user { "user" } else { "machine" },
        "location": raw.location,
        "enabled": raw.enabled, "disabled_at": raw.disabled_at,
        "can_toggle": can_toggle,
        "needs_admin": !raw.scope_user && can_toggle,
        "size_bytes": size, "running": running, "memory_bytes": memory,
        "impact": impact, "safety": safety.as_str(), "summary": summary, "reasons": reasons,
    })
}

pub fn startup_scan() -> Value {
    let (raws, notes, hidden) = collect_startup();
    let procs = gather_procs();
    let existing: Vec<&Path> = raws.iter()
        .filter_map(|r| r.target.as_ref().filter(|_| r.target_exists == Some(true)).map(|p| p.as_path()))
        .collect();
    let infos = files_info(&existing);
    // Authenticode 验签（一趟批处理；证书链校验由 Windows 完成）。
    let sigs = verify_signatures(&existing);
    let rank = |l: &str| match l { "high" => 4, "medium" => 3, "low" => 2, "unknown" => 1, _ => 0 };
    let mut entries: Vec<Value> = raws.into_iter().map(|r| finish_startup(r, &procs, &infos, &sigs)).collect();
    // 最重在前，其次按名。
    entries.sort_by(|a, b| {
        rank(b["impact"]["level"].as_str().unwrap_or("none"))
            .cmp(&rank(a["impact"]["level"].as_str().unwrap_or("none")))
            .then_with(|| a["name"].as_str().unwrap_or("").to_lowercase().cmp(&b["name"].as_str().unwrap_or("").to_lowercase()))
    });
    serde_json::json!({
        "ok": true,
        "supported": cfg!(target_os = "windows"),
        "entries": entries, "hidden_system_tasks": hidden, "notes": notes,
    })
}

/// 像任务管理器那样开关给定条目。每条先重新查找、再校验、再写标志。
pub fn set_startup_enabled(ids: &[String], enable: bool) -> Value {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        const APPROVED: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved";

        let mut changed: Vec<String> = vec![];
        let mut skipped: Vec<Value> = vec![];
        let mut errors: Vec<String> = vec![];

        // 重新收集（不含计划任务：它们永不被开关，列出又慢）。
        let (mut fresh, _, _) = collect_startup();
        fresh.retain(|r| r.table.is_some());
        let map: HashMap<String, &RawStartup> = fresh.iter().map(|r| (r.id.clone(), r)).collect();

        for id in ids {
            let Some(r) = map.get(id.as_str()) else {
                skipped.push(serde_json::json!({"id": id, "why": "已不存在（扫描后可能被移除）"}));
                continue;
            };
            // 状态校验：已开再开、已关再关都跳过。
            match (r.enabled, enable) {
                (Some(true), true) => { skipped.push(serde_json::json!({"id": id, "why": "已经是开启状态"})); continue; }
                (Some(false), false) => { skipped.push(serde_json::json!({"id": id, "why": "已经是关闭状态"})); continue; }
                _ => {}
            }
            // 受保护条目重新打开是允许的（那是撤销）；只有关闭被拒绝。
            if !enable {
                let (safety, _, _) = classify(&Cls {
                    name: &r.name, target: r.target.as_deref().map(|p| p.to_string_lossy().into_owned()).as_deref(),
                    target_exists: r.target_exists, publisher: None, description: None,
                    enabled: r.enabled, running: false, memory: None,
                });
                if safety == Safety::Risky {
                    skipped.push(serde_json::json!({"id": id, "why": format!("受保护：{}。不会关闭这类项。", r.name)}));
                    continue;
                }
            }
            let table = r.table.unwrap_or("Run");
            let hive = if r.scope_user { RegKey::predef(HKEY_CURRENT_USER) } else { RegKey::predef(HKEY_LOCAL_MACHINE) };
            let write = (|| -> std::io::Result<()> {
                let (key, _) = hive.open_subkey_with_flags(APPROVED, KEY_READ)?
                    .create_subkey_with_flags(table, KEY_SET_VALUE | KEY_READ)?;
                use winreg::RegValue;
                key.set_raw_value(&r.id.split('|').nth(2).unwrap_or(&r.name), &RegValue {
                    bytes: approved_bytes(enable, now_filetime()).to_vec(),
                    vtype: REG_BINARY,
                })
            })();
            match write {
                Ok(()) => changed.push(id.clone()),
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    errors.push(format!("{}：需要管理员权限（机器级条目）", r.name));
                }
                Err(e) => errors.push(format!("{}: {e}", r.name)),
            }
        }
        serde_json::json!({ "ok": errors.is_empty(), "changed": changed, "skipped": skipped, "errors": errors })
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (ids, enable); json_err("启动项开关仅支持 Windows") }
}

// ============================================================ system_space

/// 只读问询其他程序的时限。
const QUERY_TIMEOUT: Duration = Duration::from_secs(20);
/// 为用户保留的命令输出长度。
const OUTPUT_TAIL: usize = 1500;

/// 提权运行固定白名单动作：脚本写入临时 .ps1，Start-Process -Verb RunAs
/// -Wait 执行，输出重定向到临时文件后读回。命令行永不包含用户文本。
fn run_elevated_ps(script_body: &str) -> Result<String, String> {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("envtools-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ps1 = dir.join("action.ps1");
    let out_file = dir.join("result.txt");
    let _ = std::fs::remove_file(&out_file);
    // 包装：捕获全部输出（含错误流）到 result.txt，异常也记入而非静默丢失。
    let wrapped = format!(
        "$ErrorActionPreference = 'Continue';\n$out = (& {{ {script_body} }}) 2>&1 | Out-String;\n$out | Out-File -FilePath '{of}' -Encoding utf8;\n",
        of = out_file.display(),
    );
    std::fs::write(&ps1, wrapped).map_err(|e| e.to_string())?;
    let elev = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command",
               &format!("Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','{}')", ps1.display())])
        .output()
        .map_err(|e| e.to_string())?;
    if !elev.status.success() {
        // 用户拒绝 UAC 时 Start-Process 报错。
        let text = String::from_utf8_lossy(&elev.stderr).to_string();
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("提权未完成（可能拒绝了 UAC）：{}", text.trim()));
    }
    let result = std::fs::read_to_string(&out_file).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    Ok(result)
}

/// 普通权限运行 PowerShell，取回 stdout；超时后杀进程（只读问询不等待
/// 挂起的 WMI）。
fn run_ps(script: &str, timeout: Option<Duration>) -> Result<String, String> {
    use std::io::Read;
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = String::new();
                if let Some(mut p) = child.stdout.take() { let mut b = Vec::new(); let _ = p.read_to_end(&mut b); stdout = String::from_utf8_lossy(&b).into_owned(); }
                let mut stderr = String::new();
                if let Some(mut p) = child.stderr.take() { let mut b = Vec::new(); let _ = p.read_to_end(&mut b); stderr = String::from_utf8_lossy(&b).into_owned(); }
                if !status.success() { return Err(stderr.trim().to_string()); }
                return Ok(stdout.trim().trim_start_matches('\u{feff}').to_string());
            }
            Ok(None) => {}
            Err(e) => return Err(e.to_string()),
        }
        if timeout.is_some_and(|t| start.elapsed() > t) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("查询超时".into());
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

/// "9.74 GB"（DISM 的 1024 进制单位）。
fn parse_binary_size(text: &str) -> Option<u64> {
    let mut parts = text.split_whitespace();
    let number: f64 = parts.next()?.replace(',', ".").parse().ok()?;
    let mult: f64 = match parts.next()?.to_ascii_uppercase().as_str() {
        "B" | "BYTES" => 1.0,
        "KB" => 1024.0,
        "MB" => 1024.0 * 1024.0,
        "GB" => 1024.0 * 1024.0 * 1024.0,
        "TB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((number * mult) as u64)
}

/// "1.234GB"（Docker 的 1000 进制单位）。
fn parse_docker_size(text: &str) -> Option<u64> {
    let token = text.split_whitespace().next()?;
    let split = token.find(|c: char| c.is_ascii_alphabetic())?;
    let (num, unit) = token.split_at(split);
    let number: f64 = num.parse().ok()?;
    let mult: f64 = match unit.to_ascii_lowercase().as_str() {
        "b" => 1.0, "kb" => 1e3, "mb" => 1e6, "gb" => 1e9, "tb" => 1e12, "pb" => 1e15,
        _ => return None,
    };
    Some((number * mult) as u64)
}

fn json_u64(v: &Value) -> u64 {
    match v {
        Value::Number(n) => n.as_u64().unwrap_or(0),
        Value::String(s) => s.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn as_list(v: Option<&Value>) -> Vec<&Value> {
    match v {
        Some(Value::Array(a)) => a.iter().collect(),
        Some(Value::Null) | None => vec![],
        Some(other) => vec![other],
    }
}

/// `{3D6A7F2E-0000-4C1B-8A00-1234567890AB}`：唯一允许进入命令行的卷影
/// 副本 id 形状。
fn valid_shadow_id(id: &str) -> bool {
    let b = id.as_bytes();
    id.len() == 38
        && b[0] == b'{'
        && b[37] == b'}'
        && id[1..37].chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() }
        })
}

fn tail(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= OUTPUT_TAIL { return t.to_string(); }
    let skip = t.chars().count() - OUTPUT_TAIL;
    format!("…{}", t.chars().skip(skip).collect::<String>())
}

// 会话内缓存的管理员查询结果（还原点/组件仓库）：没有管理员权限读不了，
// 重扫描时复用答案而不是再弹一次 UAC。
static LOOKED: std::sync::Mutex<(Option<(Value, u64)>, Option<(Value, u64)>)> = std::sync::Mutex::new((None, None));

fn sysroot() -> PathBuf {
    PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into()))
}

fn system_drive() -> PathBuf {
    let d = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
    PathBuf::from(format!("{d}\\"))
}

fn system32(exe: &str) -> PathBuf { sysroot().join("System32").join(exe) }

fn reg_u32(subkey: &str, name: &str) -> Option<u32> {
    #[cfg(target_os = "windows")]
    {
        use winreg::enums::*;
        use winreg::RegKey;
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey_with_flags(subkey, KEY_READ).ok()?
            .get_value::<u32, _>(name).ok()
    }
    #[cfg(not(target_os = "windows"))]
    { let _ = (subkey, name); None }
}

/// WMI 查询脚本（无双引号：作为单个命令行参数传递时引号最先出问题）。
/// 卷影副本 JSON 输出。
const RESTORE_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; \
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$d = $env:SystemDrive; \
$vol = (Get-CimInstance Win32_Volume | Where-Object { $_.DriveLetter -eq $d } | Select-Object -First 1).DeviceID; \
if (-not $vol) { throw 'system volume not found' }; \
$guid = [regex]::Match($vol, '\\{[0-9a-fA-F-]+\\}').Value; \
$pts = @(Get-CimInstance Win32_ShadowCopy | Where-Object { $_.VolumeName -like ('*' + $guid + '*') -and $_.ClientAccessible } | ForEach-Object { [pscustomobject]@{ id = $_.ID; created = ([DateTimeOffset]$_.InstallDate).ToUnixTimeSeconds() } }); \
$st = @(Get-CimInstance Win32_ShadowStorage | Where-Object { (([string]$_.Volume.DeviceID) + ([string]$_.Volume)) -like ('*' + $guid + '*') } | ForEach-Object { [pscustomobject]@{ used = [string]$_.UsedSpace; allocated = [string]$_.AllocatedSpace; max = [string]$_.MaxSpace } }); \
[pscustomobject]@{ points = $pts; storage = $st } | ConvertTo-Json -Compress -Depth 4";

const PAGEFILE_SCRIPT: &str = "$ErrorActionPreference = 'Stop'; \
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; \
$pf = @(Get-CimInstance Win32_PageFileUsage | ForEach-Object { [pscustomobject]@{ name = $_.Name; allocated_mb = [string]$_.AllocatedBaseSize; used_mb = [string]$_.CurrentUsage; peak_mb = [string]$_.PeakUsage } }); \
$auto = [bool](Get-CimInstance Win32_ComputerSystem).AutomaticManagedPagefile; \
[pscustomobject]@{ files = $pf; auto = $auto } | ConvertTo-Json -Compress -Depth 4";

fn parse_restore_json(text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}'))
        .map_err(|e| format!("还原点列表不可读: {e}"))?;
    Ok(v)
}

fn restore_state_of(v: &Value) -> (Vec<(String, u64)>, Option<u64>, Option<u64>, Option<u64>) {
    const UNBOUNDED: u64 = 1 << 62;
    let mut points: Vec<(String, u64)> = as_list(v.get("points")).into_iter()
        .filter_map(|p| Some((p.get("id")?.as_str()?.to_string(), p.get("created").map(json_u64)?)))
        .collect();
    points.sort_by_key(|(_, c)| *c);
    let storage = as_list(v.get("storage"));
    let first = storage.first();
    let field = |key: &str| -> Option<u64> {
        let v = first?.get(key)?;
        match v {
            Value::String(s) => s.trim().parse::<u64>().ok(),
            other => other.as_u64(),
        }
    };
    let max = field("max").filter(|m| *m < UNBOUNDED);
    (points, field("used"), field("allocated"), max)
}

/// DISM 分析报告的英文标签。找不到任何尺寸时返回 None（非英文系统）。
fn parse_dism_analysis(text: &str) -> Option<Value> {
    let mut s = serde_json::Map::new();
    let mut found = false;
    for line in text.lines() {
        let Some((label, value)) = line.split_once(" : ") else { continue };
        let (label, value) = (label.trim(), value.trim());
        let mut set_size = |k: &str| {
            if let Some(b) = parse_binary_size(value) {
                s.insert(k.into(), Value::from(b));
                found = true;
            }
        };
        if label.starts_with("Windows Explorer Reported Size") { set_size("explorer_bytes"); }
        else if label.starts_with("Actual Size of Component Store") { set_size("actual_bytes"); }
        else if label.starts_with("Shared with Windows") { set_size("shared_bytes"); }
        else if label.starts_with("Backups and Disabled Features") { set_size("backups_bytes"); }
        else if label.starts_with("Cache and Temporary Data") { set_size("cache_bytes"); }
        else if label.starts_with("Date of Last Cleanup") { s.insert("last_cleanup".into(), Value::from(value)); }
        else if label.starts_with("Number of Reclaimable Packages") {
            if let Ok(n) = value.parse::<u32>() { s.insert("reclaimable_packages".into(), Value::from(n)); }
        } else if label.starts_with("Component Store Cleanup Recommended") {
            let b = match value.to_ascii_lowercase().as_str() {
                "yes" => Some(true), "no" => Some(false), _ => None,
            };
            if let Some(b) = b { s.insert("cleanup_recommended".into(), Value::from(b)); }
        }
    }
    found.then(|| Value::Object(s))
}

/// 系统空间报告：休眠文件 / 页面文件 / 还原点 / 组件仓库 / Docker。
pub fn system_space() -> Value {
    let mut items: Vec<Value> = vec![];
    let is_admin = false; // 只读信息不强制管理员

    // ---- 休眠文件
    {
        let file = system_drive().join("hiberfil.sys");
        let meta = std::fs::metadata(&file);
        let size = meta.as_ref().ok().map(|m| m.len());
        let percent = reg_u32(r"SYSTEM\CurrentControlSet\Control\Power", "HiberFileSizePercent").unwrap_or(0);
        let reduced = (1..=50).contains(&percent);
        let fast = reg_u32(r"SYSTEM\CurrentControlSet\Control\Session Manager\Power", "HiberbootEnabled")
            .map(|v| v != 0);
        let mut facts = vec![
            serde_json::json!({"label": "文件", "text": file.display().to_string()}),
        ];
        if size.is_some() {
            facts.push(serde_json::json!({"label": "类型", "text": if reduced { "精简型：仅快速启动可用，休眠不可用" } else { "完整型：休眠与快速启动都可用" }}));
        }
        facts.push(serde_json::json!({"label": "快速启动", "text": match fast { Some(true) => "开：关机时保存休眠映像加速下次启动", Some(false) => "关", None => "未知" }}));
        let mut actions = vec![];
        if let Some(size) = size {
            actions.push(serde_json::json!({
                "id": "hibernate-off", "label": "关闭休眠",
                "commands": ["powercfg /hibernate off"],
                "cost": "休眠与快速启动都将停止工作。Windows 立即删除该文件，无需重启。",
                "safety": "caution", "admin": true, "permanent": false,
                "undo": "运行 powercfg /hibernate on；文件会以同样大小回来。",
                "est_bytes": size, "est_h": hs(size),
            }));
            if !reduced {
                let est = size - size * 40 / 75;
                actions.push(serde_json::json!({
                    "id": "hibernate-reduced", "label": "缩减为精简型",
                    "commands": ["powercfg /h /type reduced"],
                    "cost": "休眠停止工作，快速启动保留。文件缩减到约 40% 内存。",
                    "safety": "caution", "admin": true, "permanent": false,
                    "undo": "运行 powercfg /h /type full 恢复完整大小。",
                    "est_bytes": est, "est_h": hs(est),
                }));
            }
        }
        items.push(serde_json::json!({
            "id": "hibernation", "title": "休眠文件",
            "summary": "hiberfil.sys 保存内存副本供休眠与快速启动使用。常年占用内存的相当比例。",
            "size_bytes": size, "size_h": size.map(hs),
            "size_note": if size.is_none() { Some("休眠已关闭：文件不存在".to_string()) } else { None },
            "facts": facts, "info_only": false, "actions": actions,
        }));
    }

    // ---- 页面文件（仅信息）
    {
        let parsed = run_ps(PAGEFILE_SCRIPT, Some(QUERY_TIMEOUT)).ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok());
        let mut facts = vec![];
        let mut size = 0u64;
        let mut known = false;
        if let Some(p) = &parsed {
            for f in as_list(p.get("files")) {
                let name = f.get("name").and_then(|n| n.as_str()).unwrap_or("pagefile.sys");
                let mb = |k: &str| f.get(k).map(json_u64).unwrap_or(0) * 1024 * 1024;
                let on_disk = std::fs::metadata(name).map(|m| m.len()).unwrap_or_else(|_| mb("allocated_mb"));
                size += on_disk;
                known = true;
                facts.push(serde_json::json!({"label": "页面文件", "text": format!("{name}: 磁盘 {} · 当前用 {} · 峰值 {}", hs(on_disk), hs(mb("used_mb")), hs(mb("peak_mb")))}));
            }
            let auto = p.get("auto").and_then(|a| a.as_bool()).unwrap_or(true);
            facts.push(serde_json::json!({"label": "管理方式", "text": if auto { "Windows 自动决定大小" } else { "手动设定的大小" }}));
        }
        if !known {
            if let Ok(m) = std::fs::metadata(system_drive().join("pagefile.sys")) {
                size = m.len();
                known = true;
                facts.push(serde_json::json!({"label": "页面文件", "text": format!("{}: {}", system_drive().join("pagefile.sys").display(), hs(size))}));
            }
        }
        items.push(serde_json::json!({
            "id": "pagefile", "title": "页面文件",
            "summary": "pagefile.sys 是内存的溢出空间，也是崩溃转储的起点。本应用永不修改它。",
            "size_bytes": if known { Some(size) } else { None }, "size_h": if known { hs(size) } else { "—".into() },
            "size_note": if known { None } else { Some("未找到页面文件，或 Windows 未提供".to_string()) },
            "facts": facts,
            "how_to": "自行调整：Win+R 运行 sysdm.cpl → 高级 → 性能设置 → 高级 → 虚拟内存。过小或缺失会导致程序内存不足报错并无法转储，多数人保持自动更好。",
            "info_only": true, "actions": [],
        }));
    }

    // ---- 还原点（需管理员查询，会话内缓存）
    {
        let cached = LOOKED.lock().ok().and_then(|l| l.0.clone());
        let mut item = serde_json::json!({
            "id": "restore-points", "title": "系统还原点",
            "summary": "安装与更新前 Windows 拍的快照，用于回滚。共享系统盘的一块保留空间。",
            "size_bytes": null, "size_h": "—",
            "facts": [], "inspect": { "label": "检查还原点", "admin": true, "done": cached.is_some() },
            "actions": [],
        });
        if let Some((state, checked)) = cached {
            let (points, used, allocated, max) = restore_state_of(&state);
            item["size_bytes"] = used.map(Value::from).unwrap_or(Value::Null);
            item["size_h"] = Value::from(used.map(hs).unwrap_or_else(|| "—".into()));
            item["facts"] = Value::Array(vec![
                serde_json::json!({"label": "检查于", "text": format!("{}（点击重新检查刷新）", age_text(checked))}),
                serde_json::json!({"label": "还原点", "text": points.len().to_string()}),
                serde_json::json!({"label": "已用", "text": used.map(hs).unwrap_or_else(|| "未知".into())}),
                serde_json::json!({"label": "已分配", "text": allocated.map(hs).unwrap_or_else(|| "未知".into())}),
                serde_json::json!({"label": "上限", "text": max.map(hs).unwrap_or_else(|| "无限制".into())}),
            ]);
            if !points.is_empty() {
                let oldest = &points[0];
                let newest = points.last().unwrap();
                item["facts"].as_array_mut().unwrap().push(serde_json::json!({"label": "最旧/最新", "text": format!("{} / {}", age_text(oldest.1), age_text(newest.1))}));
                let common = |extra: Vec<Value>| -> Vec<Value> {
                    let mut r = vec![
                        serde_json::json!({"level":"bad","text":"失去回退手段：还原点是 Windows 撤销坏驱动/更新/安装的方式。"}),
                        serde_json::json!({"level":"bad","text":"不可逆：不是文件，进不了回收站，无法恢复。"}),
                        serde_json::json!({"level":"warn","text":"列表是系统盘上程序可浏览的全部卷影副本；备份软件也会建同类副本，删除对其同样生效。"}),
                        serde_json::json!({"level":"ok","text":"文档、应用与设置不受影响；还原点从不保存你的文件。"}),
                    ];
                    r.extend(extra);
                    r
                };
                item["actions"] = Value::Array(vec![
                    serde_json::json!({
                        "id": "restore-delete-oldest", "label": "删除最旧的还原点",
                        "point_id": oldest.0,
                        "commands": [format!("vssadmin delete shadows /shadow={} /quiet", oldest.0)],
                        "cost": format!("不能再回退到 {}（最旧的点）。", age_text(oldest.1)),
                        "safety": "risky", "admin": true, "permanent": true,
                        "reasons": common(vec![serde_json::json!({"level":"ok","text":format!("更新的点保留，包括最新（{}）。", age_text(newest.1))})]),
                    }),
                    serde_json::json!({
                        "id": "restore-keep-newest", "label": "仅保留最新的还原点",
                        "point_id": newest.0,
                        "commands": points[..points.len().saturating_sub(1)].iter()
                            .map(|(id, _)| format!("vssadmin delete shadows /shadow={id} /quiet")).collect::<Vec<_>>(),
                        "cost": format!("{}被删除；仅保留最新（{}）。", plural(points.len().saturating_sub(1), "个还原点", "个还原点"), age_text(newest.1)),
                        "safety": "risky", "admin": true, "permanent": true,
                        "enabled": points.len() > 1,
                        "reasons": common(vec![serde_json::json!({"level":"ok","text":format!("最新点（{}）保留，仍可回退。", age_text(newest.1))})]),
                    }),
                ]);
            } else {
                item["notice"] = Value::from("系统盘没有还原点：系统保护可能已关闭，或尚未创建。");
            }
        } else {
            item["size_note"] = Value::from("还原点仅管理员可见，需要先点检查。查看不改变任何东西。");
        }
        items.push(item);
    }

    // ---- 组件仓库 WinSxS（需管理员分析，会话内缓存）
    {
        let cached = LOOKED.lock().ok().and_then(|l| l.1.clone());
        let mut item = serde_json::json!({
            "id": "winsxs", "title": "Windows 组件仓库（WinSxS）",
            "summary": "Windows 存放自身文件所有版本的文件夹。资源管理器会高估：多数文件是与真正系统文件夹共享的硬链接。",
            "size_bytes": null, "size_h": "—",
            "facts": [],
            "inspect": { "label": "分析组件仓库", "admin": true, "slow": true, "done": cached.is_some() },
            "actions": [],
        });
        if let Some((store, checked)) = cached {
            let actual = store["actual_bytes"].as_u64().or(store["explorer_bytes"].as_u64());
            item["size_bytes"] = actual.map(Value::from).unwrap_or(Value::Null);
            item["size_h"] = Value::from(actual.map(hs).unwrap_or_else(|| "—".into()));
            item["size_note"] = Value::from("实际大小（共享文件只算一次）");
            let mut facts = vec![serde_json::json!({"label": "检查于", "text": format!("{}（点击重新分析刷新）", age_text(checked))})];
            for (label, k) in [("资源管理器报告", "explorer_bytes"), ("实际大小", "actual_bytes"), ("与 Windows 共享", "shared_bytes"), ("备份与禁用功能", "backups_bytes"), ("缓存与临时数据", "cache_bytes")] {
                if let Some(v) = store[k].as_u64() {
                    facts.push(serde_json::json!({"label": label, "text": hs(v)}));
                }
            }
            if let Some(d) = store["last_cleanup"].as_str() {
                facts.push(serde_json::json!({"label": "上次清理", "text": d}));
            }
            if let Some(n) = store["reclaimable_packages"].as_u64() {
                facts.push(serde_json::json!({"label": "可回收包", "text": n.to_string()}));
            }
            item["facts"] = Value::Array(facts);
            let rec = match (store["cleanup_recommended"].as_bool(), store["reclaimable_packages"].as_u64()) {
                (Some(true), n) => serde_json::json!({"level":"ok","text":format!("Windows 自己的分析建议清理{}。", n.map(|n| format!("（{n} 个可回收包）")).unwrap_or_default())}),
                (Some(false), _) => serde_json::json!({"level":"warn","text":"Windows 自己的分析认为现在不宜清理，预期释放有限。"}),
                (None, _) => serde_json::json!({"level":"warn","text":"分析未说明是否建议清理。"}),
            };
            item["actions"] = Value::Array(vec![serde_json::json!({
                "id": "component-cleanup", "label": "清理组件仓库",
                "commands": ["DISM /Online /Cleanup-Image /StartComponentCleanup"],
                "cost": "耗时数分钟甚至更久，期间不能关机。更新组件的旧版本不能再用于修复，但已装更新仍可卸载。",
                "safety": "safe", "admin": true, "permanent": false, "slow": true, "cancellable": false,
                "reasons": [
                    serde_json::json!({"level":"ok","text":"这是微软官方文档记载的组件仓库清理，Windows 自己也会按计划运行。"}),
                    serde_json::json!({"level":"ok","text":"未使用 /ResetBase，所有已装更新仍可卸载。"}),
                    rec,
                    serde_json::json!({"level":"warn","text":"运行期间请勿关机或睡眠；无法中途停止。"}),
                ],
            })]);
        } else {
            item["size_note"] = Value::from("直接遍历会把共享文件算两遍，所以要问 Windows。分析需要管理员且耗时一两分钟。查看不改变任何东西。");
        }
        items.push(item);
    }

    // ---- Docker
    {
        let mut item = serde_json::json!({
            "id": "docker", "title": "Docker",
            "summary": "镜像、容器与卷占用的磁盘空间。通过 docker system df 读取（Docker 的 JSON 格式，与系统语言无关）。",
            "size_bytes": null, "size_h": "—", "facts": [], "notice": Value::Null,
        });
        let out = std::process::Command::new("docker").args(["system", "df", "--format", "{{json .}}"]).output();
        match out {
            Ok(o) if o.status.success() => {
                let text = String::from_utf8_lossy(&o.stdout);
                let mut total = 0u64;
                let mut reclaim = 0u64;
                let mut rows = vec![];
                for line in text.lines() {
                    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    let Some(kind) = v.get("Type").and_then(|t| t.as_str()) else { continue };
                    let sz = |k: &str| v.get(k).and_then(|s| s.as_str()).and_then(parse_docker_size).unwrap_or(0);
                    let size = sz("Size");
                    let reclaimable = sz("Reclaimable");
                    total += size;
                    reclaim += reclaimable;
                    rows.push(serde_json::json!({
                        "kind": kind, "total": v.get("TotalCount").map(json_u64).unwrap_or(0),
                        "active": v.get("Active").map(json_u64).unwrap_or(0),
                        "size_bytes": size, "size_h": hs(size),
                        "reclaimable_bytes": reclaimable, "reclaimable_h": hs(reclaimable),
                    }));
                }
                item["size_bytes"] = Value::from(total);
                item["size_h"] = Value::from(hs(total));
                item["facts"] = Value::Array(vec![
                    serde_json::json!({"label": "合计", "text": hs(total)}),
                    serde_json::json!({"label": "可回收", "text": hs(reclaim)}),
                ]);
                item["rows"] = Value::Array(rows);
                item["actions"] = Value::Array(vec![serde_json::json!({
                    "id": "docker-prune", "label": "docker system prune（清未使用资源）",
                    "commands": ["docker system prune -f"],
                    "cost": "删除所有未使用的容器、网络与悬空镜像。已停止但未移除的容器会丢。",
                    "safety": "caution", "admin": false, "permanent": true, "slow": false,
                })]);
            }
            _ => {
                item["notice"] = Value::from("Docker 未运行或未安装。");
            }
        }
        items.push(item);
    }

    serde_json::json!({ "ok": true, "platform": "windows", "is_admin": is_admin, "items": items })
}

/// 提权执行系统空间动作（固定白名单 id）。shadow 仅还原点删除类动作需要。
pub fn system_space_action(action_id: &str, shadow: Option<&str>) -> Value {
    let body: String = match action_id {
        "hibernate-off" => "powercfg /hibernate off".into(),
        "hibernate-reduced" => "powercfg /h /type reduced".into(),
        "analyze-component-store" => format!("dism /Online /Cleanup-Image /AnalyzeComponentStore"),
        "component-cleanup" => "dism /Online /Cleanup-Image /StartComponentCleanup".into(),
        "list-restore-points" => RESTORE_SCRIPT.to_string(),
        "restore-delete-oldest" | "restore-keep-newest" => {
            let Some(id) = shadow.filter(|s| valid_shadow_id(s)) else {
                return json_err("拒绝：还原点 id 无效或缺失");
            };
            format!("vssadmin delete shadows /shadow={id} /quiet")
        }
        _ => return json_err("拒绝：未知的系统空间动作"),
    };
    match run_elevated_ps(&body) {
        Ok(output) => {
            // 缓存只读查询结果。
            if action_id == "list-restore-points" {
                if let Ok(state) = parse_restore_json(&output) {
                    if let Ok(mut l) = LOOKED.lock() { l.0 = Some((state, now_secs())); }
                }
            } else if action_id == "analyze-component-store" {
                if let Some(store) = parse_dism_analysis(&output) {
                    if let Ok(mut l) = LOOKED.lock() { l.1 = Some((store, now_secs())); }
                }
            }
            serde_json::json!({ "ok": true, "action_id": action_id, "output": tail(&output) })
        }
        Err(e) => json_err(&e),
    }
}
