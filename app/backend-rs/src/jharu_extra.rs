//! Jharu 全量补齐（github.com/riponcm/Jharu Apache 2.0）。
//! 深度清理 treemap / 重复文件 / 构建产物 / Git worktree / 回收站管理 /
//! 系统空间 / 启动项 / 卸载器 / 进程管理 / 空间历史对比 / 桌面清理。

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

// ─── 深度清理（全盘扫描 + 分类） ──────────────────────────────────────────

pub fn deep_scan(root: &str, max_depth: usize) -> Value {
    let path = Path::new(root);
    if !path.is_dir() { return json_err("not a directory"); }
    let start = std::time::Instant::now();
    let entries = scan_level(path, 0, max_depth);
    let total: u64 = entries.iter().filter_map(|e| e["size"].as_u64()).sum();
    serde_json::json!({
        "ok": true, "path": root, "total": total, "total_h": hs(total),
        "elapsed_ms": start.elapsed().as_millis() as u64, "entries": entries,
    })
}

fn scan_level(dir: &Path, depth: usize, max_depth: usize) -> Vec<Value> {
    if depth > max_depth { return vec![]; }
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    let mut items: Vec<(PathBuf, u64, bool, u64)> = Vec::new(); // path, size, is_dir, files
    for e in rd.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().into_owned();
        if is_excluded(&name) { continue; }
        if p.is_dir() {
            let (sz, fc) = quick_stats(&p, 2);
            items.push((p, sz, true, fc));
        } else {
            let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
            items.push((p, sz, false, 1));
        }
    }
    items.sort_by(|a, b| b.1.cmp(&a.1));
    for (p, sz, is_dir, fc) in items.iter().take(100) {
        let (kind, protected, hint) = classify_path(p);
        out.push(serde_json::json!({
            "name": p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
            "path": p.display().to_string(), "size": sz, "size_h": hs(*sz),
            "is_dir": is_dir, "files": fc, "kind": kind, "protected": protected, "hint": hint,
        }));
    }
    out
}

fn is_excluded(name: &str) -> bool {
    matches!(name, "$Recycle.Bin" | "System Volume Information" | "$WinREAgent" | "Config.Msi")
        || name.starts_with('.')
}

fn classify_path(p: &Path) -> (&'static str, bool, &'static str) {
    let s = p.to_string_lossy().to_lowercase();
    if s.contains("\\windows\\") || s.ends_with("\\windows") { return ("system", true, "OS files"); }
    if s.contains("\\program files") { return ("applications", false, "Installed programs"); }
    if s.contains("\\users\\") && s.contains("\\appdata\\") { return ("app_data", false, "App data and caches"); }
    if s.contains("node_modules") || s.contains("\\target\\") || s.contains(".venv") { return ("dev", false, "Build artifacts"); }
    if s.contains("\\users\\") { return ("user_data", false, "User files"); }
    ("other", false, "")
}

// ─── 重复文件检测（size+name 预筛 + 内容抽样确认） ─────────────────────────

pub fn dupes_scan(roots: &[String], min_size: u64) -> Value {
    let start = std::time::Instant::now();
    // Phase 1: 按文件大小分组
    let mut by_size: HashMap<u64, Vec<PathBuf>> = HashMap::new();
    for root in roots {
        collect_files(Path::new(root), min_size, &mut |p, sz| {
            by_size.entry(sz).or_default().push(p.to_path_buf());
        });
    }
    // Phase 2: 同大小的文件按首 4KB 内容分组
    let mut by_head: HashMap<(u64, String), Vec<PathBuf>> = HashMap::new();
    for (sz, paths) in &by_size {
        if paths.len() < 2 { continue; }
        for p in paths {
            if let Some(head) = read_head(p, 4096) {
                by_head.entry((*sz, head)).or_default().push(p.clone());
            }
        }
    }
    // Phase 3: 构建重复组
    let mut groups: Vec<Value> = Vec::new();
    let mut wasted: u64 = 0;
    for ((sz, _), paths) in &by_head {
        if paths.len() < 2 { continue; }
        wasted += sz * (paths.len() as u64 - 1);
        groups.push(serde_json::json!({
            "size": sz, "size_h": hs(*sz), "count": paths.len(),
            "wasted": sz * (paths.len() as u64 - 1),
            "files": paths.iter().map(|p| serde_json::json!({
                "name": p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default(),
                "path": p.display().to_string(), "size_h": hs(*sz),
            })).collect::<Vec<_>>(),
        }));
    }
    groups.sort_by(|a, b| b["wasted"].as_u64().cmp(&a["wasted"].as_u64()));
    groups.truncate(50);
    serde_json::json!({
        "ok": true, "groups": groups.len(), "wasted": wasted, "wasted_h": hs(wasted),
        "elapsed_ms": start.elapsed().as_millis() as u64, "items": groups,
    })
}

fn collect_files(dir: &Path, min_size: u64, f: &mut dyn FnMut(&Path, u64)) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_files(&p, min_size, f);
        } else if let Ok(m) = e.metadata() {
            if m.len() >= min_size { f(&p, m.len()); }
        }
    }
}

fn read_head(p: &Path, n: usize) -> Option<String> {
    use std::io::Read;
    let mut f = std::fs::File::open(p).ok()?;
    let mut buf = vec![0u8; n.min(4096)];
    let read = f.read(&mut buf).ok()?;
    buf.truncate(read);
    Some(buf.iter().map(|b| format!("{b:02x}")).collect())
}

// ─── 构建产物检测（node_modules/target/dist/venv 等） ─────────────────────

pub fn projects_scan(root: &str) -> Value {
    let start = std::time::Instant::now();
    let mut items = Vec::new();
    find_build_folders(Path::new(root), 0, 6, &mut items);
    items.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    let total: u64 = items.iter().filter_map(|i| i["size"].as_u64()).sum();
    serde_json::json!({ "ok": true, "total": total, "total_h": hs(total),
        "elapsed_ms": start.elapsed().as_millis() as u64, "items": items })
}

fn find_build_folders(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<Value>) {
    if depth > max_depth { return; }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() { continue; }
        let name = e.file_name().to_string_lossy().into_owned();
        if let Some(kind) = detect_build_kind(&p, &name) {
            let (sz, _) = quick_stats(&p, 3);
            if sz > 1_000_000 { // >1MB
                let parent = p.parent().map(|x| x.display().to_string()).unwrap_or_default();
                out.push(serde_json::json!({
                    "kind": kind, "path": p.display().to_string(), "project": parent,
                    "size": sz, "size_h": hs(sz),
                }));
                continue; // Don't recurse into build folders
            }
        }
        find_build_folders(&p, depth + 1, max_depth, out);
    }
}

fn detect_build_kind(p: &Path, name: &str) -> Option<&'static str> {
    let parent = p.parent()?;
    match name {
        "node_modules" if parent.join("package.json").exists() => Some("node_modules"),
        "target" if parent.join("Cargo.toml").exists() => Some("rust_target"),
        "dist" | "build" if parent.join(".gitignore").exists() => Some("build_output"),
        ".venv" | "venv" if parent.join("pyvenv.cfg").exists() || p.join("pyvenv.cfg").exists() => Some("venv"),
        "__pycache__" => Some("pycache"),
        ".next" if parent.join("package.json").exists() => Some("next_build"),
        ".turbo" if parent.join("package.json").exists() => Some("turbo_cache"),
        "Pods" if parent.join("Podfile").exists() => Some("ios_pods"),
        _ => None,
    }
}

// ─── Git worktree 清理 ─────────────────────────────────────────────────────

pub fn worktrees_scan(root: &str) -> Value {
    let start = std::time::Instant::now();
    let mut items = Vec::new();
    find_worktrees(Path::new(root), 0, 5, &mut items);
    let total: u64 = items.iter().filter_map(|i| i["size"].as_u64()).sum();
    serde_json::json!({ "ok": true, "total": total, "total_h": hs(total),
        "elapsed_ms": start.elapsed().as_millis() as u64, "items": items })
}

fn find_worktrees(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<Value>) {
    if depth > max_depth { return; }
    let git = dir.join(".git");
    if git.is_file() {
        // worktree 的 .git 是一个文件指向主仓库
        if let Ok(content) = std::fs::read_to_string(&git) {
            if let Some(main_repo) = content.strip_prefix("gitdir: ") {
                let main = Path::new(main_repo.trim()).parent().map(|p| p.to_path_buf());
                let branch = get_worktree_branch(dir);
                let merged = check_merged(dir);
                let (sz, _) = quick_stats(dir, 2);
                out.push(serde_json::json!({
                    "path": dir.display().to_string(),
                    "main_repo": main.map(|m| m.display().to_string()).unwrap_or_default(),
                    "branch": branch, "merged": merged,
                    "size": sz, "size_h": hs(sz),
                }));
                return; // 不递归进 worktree 内部
            }
        }
    }
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if e.path().is_dir() { find_worktrees(&e.path(), depth + 1, max_depth, out); }
    }
}

fn get_worktree_branch(dir: &Path) -> String {
    let output = std::process::Command::new("git")
        .args(["-C", &dir.display().to_string(), "branch", "--show-current"])
        .output();
    match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn check_merged(dir: &Path) -> bool {
    let output = std::process::Command::new("git")
        .args(["-C", &dir.display().to_string(), "branch", "--merged", "main"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let branches = String::from_utf8_lossy(&o.stdout);
            branches.lines().any(|l| l.starts_with('*'))
        }
        _ => false,
    }
}

// ─── 回收站管理 ────────────────────────────────────────────────────────────

pub fn bin_list() -> Value {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            "$shell = New-Object -ComObject Shell.Application; $rb = $shell.Namespace(0xA); $rb.Items() | ForEach-Object { [PSCustomObject]@{ Name = $_.Name; Path = $_.Path; Size = $_.Size; Deleted = $rb.GetDetailsOf($_, 2) } } | ConvertTo-Json"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let items: Vec<Value> = serde_json::from_str(&text).unwrap_or(vec![]);
            let total: u64 = items.iter().filter_map(|i| i["Size"].as_u64()).sum();
            serde_json::json!({ "ok": true, "total": total, "total_h": hs(total), "items": items })
        }
        _ => json_err("failed to list recycle bin")
    }
}

pub fn bin_purge() -> Value {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output 'OK'"])
        .output();
    match output {
        Ok(o) if o.status.success() => serde_json::json!({ "ok": true }),
        _ => json_err("failed to purge")
    }
}

pub fn bin_restore(path: &str) -> Value {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            &format!("$shell = New-Object -ComObject Shell.Application; $rb = $shell.Namespace(0xA); $rb.Items() | Where-Object {{ $_.Path -eq '{}' }} | ForEach-Object {{ $_.InvokeVerb('Restore') }}", path)])
        .output();
    match output {
        Ok(o) if o.status.success() => serde_json::json!({ "ok": true }),
        _ => json_err("failed to restore")
    }
}

// ─── 系统空间 ──────────────────────────────────────────────────────────────

pub fn system_space() -> Value {
    let mut items = Vec::new();
    // 休眠文件
    let hiber = PathBuf::from(r"C:\hiberfil.sys");
    if let Ok(m) = hiber.metadata() { items.push(sys_item("hibernation", "休眠文件", m.len(), true)); }
    // 页面文件
    for drive in ["C:", "D:", "E:"] {
        let pf = PathBuf::from(format!("{}\\pagefile.sys", drive));
        if let Ok(m) = pf.metadata() { items.push(sys_item("pagefile", "页面文件", m.len(), true)); }
    }
    // Windows Update 缓存
    let wu = PathBuf::from(r"C:\Windows\SoftwareDistribution\Download");
    let (wu_sz, _) = quick_stats(&wu, 2);
    if wu_sz > 0 { items.push(sys_item("update_cache", "Windows 更新缓存", wu_sz, true)); }
    // 系统还原点（WMI）
    let sr_size = get_restore_points_size();
    if sr_size > 0 { items.push(sys_item("restore_points", "系统还原点", sr_size, true)); }
    // Docker
    let docker_data = PathBuf::from(r"C:\ProgramData\Docker");
    let (dk_sz, _) = quick_stats(&docker_data, 2);
    if dk_sz > 0 { items.push(sys_item("docker", "Docker 数据", dk_sz, true)); }
    // 临时文件
    let temp = std::env::var("TEMP").map(PathBuf::from).unwrap_or_default();
    let (t_sz, _) = quick_stats(&temp, 2);
    if t_sz > 0 { items.push(sys_item("temp", "系统临时文件", t_sz, false)); }
    let total: u64 = items.iter().filter_map(|i| i["size"].as_u64()).sum();
    serde_json::json!({ "ok": true, "total": total, "total_h": hs(total), "items": items })
}

fn sys_item(id: &str, label: &str, size: u64, needs_admin: bool) -> Value {
    serde_json::json!({ "id": id, "label": label, "size": size, "size_h": hs(size), "needs_admin": needs_admin })
}

fn get_restore_points_size() -> u64 {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "vssadmin list shadowstorage /for=C: 2>$null | Select-String 'Used' | ForEach-Object { if ($_ -match '([\\d.]+)\\s+(GB|MB|B)') { [double]$matches[1] * switch ($matches[2]) { 'GB' { 1GB } 'MB' { 1MB } default { 1 } } } }"])
        .output();
    output.ok().and_then(|o| {
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        s.parse::<f64>().map(|v| v as u64).ok()
    }).unwrap_or(0)
}

// ─── 启动项管理 ────────────────────────────────────────────────────────────

pub fn startup_scan() -> Value {
    let mut items = Vec::new();
    // 注册表 Run 键
    for (hive, path) in [
        ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Run"),
        ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\Run"),
        ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"),
    ] {
        let cmd = format!("Get-ItemProperty '{}:\\{}' | Select-Object * -ExcludeProperty PS*", hive, path);
        if let Ok(o) = std::process::Command::new("powershell").args(["-NoProfile", "-Command", &cmd]).output() {
            if o.status.success() {
                let text = String::from_utf8_lossy(&o.stdout).to_string();
                for line in text.lines().skip(2) { // Skip headers
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 2 {
                        items.push(serde_json::json!({
                            "name": parts[0], "source": format!("{}:\\{}", hive, path),
                            "command": parts[1..].join(" "), "enabled": true,
                        }));
                    }
                }
            }
        }
    }
    // 启动文件夹
    let startup_dir = std::env::var("APPDATA").map(|a| PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs\Startup")).unwrap_or_default();
    if let Ok(rd) = std::fs::read_dir(&startup_dir) {
        for e in rd.flatten() {
            items.push(serde_json::json!({
                "name": e.file_name().to_string_lossy(), "source": "startup_folder",
                "command": e.path().display().to_string(), "enabled": true,
            }));
        }
    }
    serde_json::json!({ "ok": true, "items": items })
}

// ─── 卸载器 ────────────────────────────────────────────────────────────────

pub fn apps_list() -> Value {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            "Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } | Select-Object DisplayName, DisplayVersion, Publisher, InstallDate, EstimatedSize, UninstallString | Sort-Object DisplayName | ConvertTo-Json"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let items: Vec<Value> = serde_json::from_str(&text).unwrap_or(vec![]);
            serde_json::json!({ "ok": true, "items": items })
        }
        _ => json_err("failed to list apps")
    }
}

// ─── 进程管理（任务管理器） ────────────────────────────────────────────────

pub fn process_list() -> Value {
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command",
            "Get-Process | Sort-Object CPU -Descending | Select-Object -First 50 Id, ProcessName, CPU, @{N='MemMB';E={[math]::Round($_.WorkingSet64/1MB,0)}} | ConvertTo-Json"])
        .output();
    match output {
        Ok(o) if o.status.success() => {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            let items: Vec<Value> = serde_json::from_str(&text).unwrap_or(vec![]);
            serde_json::json!({ "ok": true, "items": items })
        }
        _ => json_err("failed to list processes")
    }
}

pub fn process_kill(pid: u32) -> Value {
    let output = std::process::Command::new("taskkill")
        .args(["/F", "/PID", &pid.to_string()])
        .output();
    match output {
        Ok(o) if o.status.success() => serde_json::json!({ "ok": true }),
        Ok(o) => json_err(&String::from_utf8_lossy(&o.stderr)),
        Err(e) => json_err(&e.to_string()),
    }
}

// ─── 空间历史详细对比 ──────────────────────────────────────────────────────

pub fn history_compare() -> Value {
    let snaps = read_snapshots();
    if snaps.len() < 2 { return serde_json::json!({ "ok": false, "reason": "need 2+ snapshots" }); }
    let prev = &snaps[snaps.len() - 2];
    let curr = &snaps[snaps.len() - 1];
    let mut changes = Vec::new();
    for cd in curr["drives"].as_array().unwrap_or(&vec![]) {
        let mount = cd["path"].as_str().unwrap_or_default();
        let pd = prev["drives"].as_array().and_then(|a| a.iter().find(|d| d["path"].as_str() == Some(mount)));
        if let Some(pd) = pd {
            let used_delta = cd["used"].as_i64().unwrap_or(0) - pd["used"].as_i64().unwrap_or(0);
            if used_delta != 0 {
                changes.push(serde_json::json!({
                    "drive": mount, "delta": used_delta, "delta_h": hs(used_delta.unsigned_abs()),
                    "direction": if used_delta > 0 { "grew" } else { "shrank" },
                }));
            }
        }
    }
    serde_json::json!({ "ok": true, "changes": changes, "snapshots": snaps.len() })
}

fn read_snapshots() -> Vec<Value> {
    let path = crate::settings::local_home().join(".cache").join("ai-usage-monitor").join("space-history.jsonl");
    let text = std::fs::read_to_string(path).unwrap_or_default();
    text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

// ─── 桌面清理（截图/大文件） ──────────────────────────────────────────────

pub fn desktop_scan() -> Value {
    let desktop = std::env::var("USERPROFILE").map(|h| PathBuf::from(h).join("Desktop")).unwrap_or_default();
    let mut items = Vec::new();
    let img_exts = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "heic"];
    if let Ok(rd) = std::fs::read_dir(&desktop) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() { continue; }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            let sz = e.metadata().map(|m| m.len()).unwrap_or(0);
            if sz < 100_000 { continue; } // >100KB
            let kind = if img_exts.contains(&ext.as_str()) { "screenshot" } else { "file" };
            items.push(serde_json::json!({
                "name": e.file_name().to_string_lossy(), "size": sz, "size_h": hs(sz), "kind": kind,
            }));
        }
    }
    items.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    let total: u64 = items.iter().filter_map(|i| i["size"].as_u64()).sum();
    serde_json::json!({ "ok": true, "total": total, "total_h": hs(total), "items": items })
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────

fn quick_stats(path: &Path, depth: usize) -> (u64, u64) {
    let mut size = 0u64; let mut files = 0u64;
    fn walk(p: &Path, d: usize, max: usize, sz: &mut u64, fc: &mut u64) {
        if d > max { return; }
        if let Ok(rd) = std::fs::read_dir(p) {
            for e in rd.flatten() {
                if let Ok(m) = e.metadata() {
                    if m.is_dir() { walk(&e.path(), d + 1, max, sz, fc); }
                    else { *sz += m.len(); *fc += 1; }
                }
            }
        }
    }
    walk(path, 0, depth, &mut size, &mut files);
    (size, files)
}

fn hs(bytes: u64) -> String {
    if bytes >= 1_099_511_627_776 { format!("{:.1} TB", bytes as f64 / 1_099_511_627_776.0) }
    else if bytes >= 1_073_741_824 { format!("{:.1} GB", bytes as f64 / 1_073_741_824.0) }
    else if bytes >= 1_048_576 { format!("{:.1} MB", bytes as f64 / 1_048_576.0) }
    else { format!("{:.1} KB", bytes as f64 / 1024.0) }
}

fn json_err(msg: &str) -> Value { serde_json::json!({ "ok": false, "error": msg }) }
