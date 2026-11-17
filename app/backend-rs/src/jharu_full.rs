//! Jharu 全功能移植（github.com/riponcm/Jharu，Apache 2.0）。
//! 补齐 jharu.rs 未覆盖的模块：ML 模型追踪、浏览器缓存、Python 环境、
//! 垃圾文件、系统文件夹清理、驱动器健康+填满预测、回收站操作。

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

// ─── ML 模型追踪 ───────────────────────────────────────────────────────────

const USED_THRESHOLD_SECS: u64 = 3_600;

struct Stamps { size: u64, mtime: Option<SystemTime>, atime: Option<SystemTime> }

fn stamps(path: &Path) -> Stamps {
    let mut s = Stamps { size: 0, mtime: None, atime: None };
    let mut consider = |meta: &std::fs::Metadata| {
        s.size += meta.len();
        if let Ok(m) = meta.modified() { if s.mtime.map_or(true, |n| m > n) { s.mtime = Some(m); } }
        if let Ok(a) = meta.accessed() { if s.atime.map_or(true, |n| a > n) { s.atime = Some(a); } }
    };
    if path.is_file() { if let Ok(m) = path.metadata() { consider(&m); } return s; }
    walk_files(path, &mut consider);
    s
}

fn walk_files(path: &Path, f: &mut dyn FnMut(&std::fs::Metadata)) {
    if let Ok(rd) = std::fs::read_dir(path) {
        for e in rd.flatten() {
            if let Ok(meta) = e.metadata() {
                if meta.is_dir() { walk_files(&e.path(), f); } else { f(&meta); }
            }
        }
    }
}

fn days_since(t: Option<SystemTime>) -> Option<u64> {
    t.and_then(|x| SystemTime::now().duration_since(x).ok()).map(|d| d.as_secs() / 86_400)
}
fn epoch(t: Option<SystemTime>) -> u64 {
    t.and_then(|x| x.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

fn model_entry(provider: &str, name: String, path: &Path, note: Option<String>) -> Option<Value> {
    let s = stamps(path);
    if s.size == 0 { return None; }
    let used = epoch(s.atime) > epoch(s.mtime) + USED_THRESHOLD_SECS;
    Some(serde_json::json!({
        "provider": provider, "name": name, "size": s.size, "size_h": human_size(s.size),
        "exclusive": s.size, "paths": [path.display().to_string()],
        "downloaded_days": days_since(s.mtime), "last_used_days": days_since(s.atime),
        "used": used, "note": note,
    }))
}

/// HuggingFace：每个 repo 一个目录 `models--org--name`
fn scan_huggingface(home: &Path, out: &mut Vec<Value>) {
    let hub = home.join(".cache/huggingface/hub");
    let Ok(rd) = std::fs::read_dir(&hub) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let (prov, prefix) = if name.starts_with("models--") { ("Hugging Face", "models--") }
            else if name.starts_with("datasets--") { ("Hugging Face dataset", "datasets--") }
            else { continue };
        let display = name.trim_start_matches(prefix).replace("--", "/");
        if let Some(v) = model_entry(prov, display, &e.path(), None) { out.push(v); }
    }
}

/// Ollama：manifest JSON 引用共享 blob，需 refcount 区分独占/共享
fn scan_ollama(home: &Path, out: &mut Vec<Value>) {
    let root = home.join(".ollama/models");
    let manifests = root.join("manifests");
    if !manifests.exists() { return; }
    let mut model_digests: Vec<(String, PathBuf, Vec<String>)> = vec![];
    let mut refcount: HashMap<String, usize> = HashMap::new();
    // 递归找 manifest 文件
    fn find_manifests(dir: &Path, out: &mut Vec<(String, PathBuf, Vec<String>)>, rc: &mut HashMap<String, usize>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            if e.path().is_dir() { find_manifests(&e.path(), out, rc); continue; }
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            let mut digests: Vec<String> = v["layers"].as_array().map(|a| a.iter()
                .filter_map(|l| l["digest"].as_str().map(String::from)).collect()).unwrap_or_default();
            if let Some(d) = v["config"]["digest"].as_str() { digests.push(d.to_string()); }
            if digests.is_empty() { continue; }
            let parts: Vec<String> = e.path().components()
                .rev().take(2).collect::<Vec<_>>().iter().rev()
                .map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
            let name = if parts.len() >= 2 { format!("{}:{}", parts[parts.len()-2], parts[parts.len()-1]) } else { parts.join("/") };
            for d in &digests { *rc.entry(d.clone()).or_insert(0) += 1; }
            out.push((name, e.path(), digests));
        }
    }
    find_manifests(&manifests, &mut model_digests, &mut refcount);

    for (name, mpath, digests) in model_digests {
        let mut total = 0u64; let mut exclusive = 0u64; let mut shared = 0;
        let mut paths = vec![mpath.display().to_string()];
        let mut mtime = None; let mut atime = None;
        for d in &digests {
            let blob = root.join("blobs").join(d.replace(':', "-"));
            let Ok(meta) = blob.metadata() else { continue };
            total += meta.len();
            if let Ok(m) = meta.modified() { if mtime.map_or(true, |n| m > n) { mtime = Some(m); } }
            if let Ok(a) = meta.accessed() { if atime.map_or(true, |n| a > n) { atime = Some(a); } }
            if refcount.get(d).copied().unwrap_or(0) <= 1 { exclusive += meta.len(); paths.push(blob.display().to_string()); }
            else { shared += 1; }
        }
        if total == 0 { continue; }
        let note = if shared > 0 { Some(format!("{shared} layer(s) shared with other Ollama models")) } else { None };
        let used = epoch(atime) > epoch(mtime) + USED_THRESHOLD_SECS;
        out.push(serde_json::json!({
            "provider": "Ollama", "name": name, "size": total, "size_h": human_size(total),
            "exclusive": exclusive, "paths": paths,
            "downloaded_days": days_since(mtime), "last_used_days": days_since(atime),
            "used": used, "note": note,
        }));
    }
}

fn scan_checkpoints(dir: &Path, provider: &str, exts: &[&str], out: &mut Vec<Value>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() { continue; }
        let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if !exts.contains(&ext.as_str()) { continue; }
        let name = p.file_stem().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if let Some(v) = model_entry(provider, name, &p, None) { out.push(v); }
    }
}

pub fn scan_models() -> Value {
    let home = dirs_home();
    let mut models = vec![];
    scan_huggingface(&home, &mut models);
    scan_ollama(&home, &mut models);
    scan_checkpoints(&home.join(".cache/whisper"), "Whisper", &["pt"], &mut models);
    scan_checkpoints(&home.join(".cache/torch/hub/checkpoints"), "PyTorch", &["pth","pt","bin"], &mut models);
    scan_checkpoints(&home.join(".keras/models"), "Keras", &["h5","keras"], &mut models);
    let reliable = models.iter().any(|m| m["used"].as_bool().unwrap_or(false));
    let total: u64 = models.iter().filter_map(|m| m["size"].as_u64()).sum();
    let unused: u64 = if reliable {
        models.iter().filter(|m| !m["used"].as_bool().unwrap_or(false))
            .filter_map(|m| m["exclusive"].as_u64()).sum()
    } else { 0 };
    models.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    serde_json::json!({ "total": total, "unused": unused, "reliable": reliable, "models": models })
}

// ─── 浏览器缓存 ────────────────────────────────────────────────────────────

fn browser_scan() -> Vec<Value> {
    let home = dirs_home();
    let local = home.join("AppData/Local");
    struct Spec { name: &'static str, profiles: Vec<PathBuf> }
    let chromium_profile = |root: &Path| -> Vec<(String, PathBuf)> {
        let mut out = vec![];
        let Ok(rd) = std::fs::read_dir(root) else { return out };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().into_owned();
            if n != "Default" && !n.starts_with("Profile ") { continue; }
            for sub in ["Cache","Code Cache","GPUCache","Service Worker/CacheStorage"] {
                let p = e.path().join(sub);
                if p.exists() { out.push((format!("{n} · {sub}"), p)); }
            }
        }
        out
    };
    let specs = vec![
        Spec { name: "Google Chrome", profiles: vec![local.join("Google/Chrome/User Data")] },
        Spec { name: "Microsoft Edge", profiles: vec![local.join("Microsoft/Edge/User Data")] },
        Spec { name: "Brave", profiles: vec![local.join("BraveSoftware/Brave-Browser/User Data")] },
        Spec { name: "Firefox", profiles: vec![local.join("Mozilla/Firefox/Profiles")] },
    ];
    let mut reports = vec![];
    for spec in specs {
        let mut items = vec![];
        if spec.name == "Firefox" {
            if let Ok(rd) = std::fs::read_dir(&spec.profiles[0]) {
                for e in rd.flatten() {
                    let cache = e.path().join("cache2");
                    if cache.exists() {
                        let sz = dir_size(&cache);
                        if sz > 0 { items.push(serde_json::json!({"label": e.file_name().to_string_lossy(), "size": sz, "size_h": human_size(sz)})); }
                    }
                }
            }
        } else {
            for (label, path) in chromium_profile(&spec.profiles[0]) {
                let sz = dir_size(&path);
                if sz > 0 { items.push(serde_json::json!({"label": label, "size": sz, "size_h": human_size(sz), "path": path.display().to_string()})); }
            }
        }
        if !items.is_empty() {
            items.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
            let total: u64 = items.iter().filter_map(|i| i["size"].as_u64()).sum();
            reports.push(serde_json::json!({"name": spec.name, "total": total, "total_h": human_size(total), "items": items}));
        }
    }
    reports.sort_by(|a, b| b["total"].as_u64().cmp(&a["total"].as_u64()));
    reports
}

// ─── Python 环境 ───────────────────────────────────────────────────────────

fn python_scan() -> Value {
    let home = dirs_home();
    let mut envs: Vec<(PathBuf, String)> = vec![];
    // 浅扫 home 下 4 层找 pyvenv.cfg / conda-meta
    fn find_envs(dir: &Path, depth: usize, out: &mut Vec<(PathBuf, String)>) {
        if depth > 4 { return; }
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || matches!(name.as_str(), "node_modules"|"AppData"|"Windows"|"Program Files") { continue; }
            if e.path().is_dir() {
                if e.path().join("pyvenv.cfg").exists() { out.push((e.path(), "venv".into())); continue; }
                if name == "envs" { // conda envs 目录
                    if let Ok(er) = std::fs::read_dir(e.path()) {
                        for c in er.flatten() {
                            if c.path().join("conda-meta").is_dir() { out.push((c.path(), "conda".into())); }
                        }
                    }
                    continue;
                }
                find_envs(&e.path(), depth + 1, out);
            }
        }
    }
    // 已知 conda 路径直接扫
    for cp in ["miniconda3","anaconda3","miniforge3","D:/ProgramData/anaconda3"] {
        let envs_dir = home.join(cp).join("envs");
        if envs_dir.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&envs_dir) {
                for e in rd.flatten() {
                    if e.path().join("conda-meta").is_dir() { envs.push((e.path(), "conda".into())); }
                }
            }
        }
    }
    find_envs(&home, 0, &mut envs);
    envs.sort(); envs.dedup();

    let mut env_list = vec![];
    for (path, kind) in envs {
        let sz = dir_size(&path);
        if sz == 0 { continue; }
        // 找包目录
        let sp = if cfg!(windows) { path.join("Lib/site-packages") } else { path.join("lib/python3/site-packages") };
        let mut packages = vec![];
        if let Ok(rd) = std::fs::read_dir(&sp) {
            for e in rd.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if n.starts_with("__pycache__") || n.starts_with('.') { continue; }
                let base = n.strip_suffix(".dist-info").or_else(|| n.strip_suffix(".egg-info")).unwrap_or(&n);
                let base = base.rsplit_once('-').filter(|(_, t)| t.chars().next().is_some_and(|c| c.is_ascii_digit())).map(|(h,_)| h).unwrap_or(base);
                if !base.is_empty() {
                    let psz = dir_size(&e.path());
                    if psz > 0 { packages.push(serde_json::json!({"name": base.to_lowercase(), "size": psz, "size_h": human_size(psz)})); }
                }
            }
        }
        packages.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
        packages.truncate(20);
        env_list.push(serde_json::json!({
            "name": path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            "path": path.display().to_string(), "kind": kind,
            "size": sz, "size_h": human_size(sz), "packages": packages,
        }));
    }
    env_list.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    let total: u64 = env_list.iter().filter_map(|e| e["size"].as_u64()).sum();
    serde_json::json!({ "total": total, "total_h": human_size(total), "envs": env_list })
}

// ─── 垃圾文件 ──────────────────────────────────────────────────────────────

fn junk_scan() -> Vec<Value> {
    let home = dirs_home();
    let local = home.join("AppData/Local");
    let mut groups = vec![];
    let mut add_group = |id: &str, title: &str, note: &str, items: Vec<Value>| {
        if items.is_empty() { return; }
        let total: u64 = items.iter().filter_map(|i| i["size"].as_u64()).sum();
        groups.push(serde_json::json!({"id": id, "title": title, "note": note, "total": total, "total_h": human_size(total), "items": items}));
    };
    // Downloads 安装包
    let dl = home.join("Downloads");
    let mut installers = vec![];
    if let Ok(rd) = std::fs::read_dir(&dl) {
        for e in rd.flatten() {
            let p = e.path();
            if !p.is_file() { continue; }
            let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            let sz = p.metadata().map(|m| m.len()).unwrap_or(0);
            if sz < 1_000_000 { continue; }
            if ["exe","msi","iso"].contains(&ext.as_str()) {
                installers.push(serde_json::json!({"label": e.file_name().to_string_lossy(), "size": sz, "size_h": human_size(sz), "safe": true}));
            }
        }
    }
    installers.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    add_group("installers", "Downloads 安装包", "已安装过的安装程序", installers);
    // 用户 Temp
    let temp = local.join("Temp");
    let tsz = dir_size(&temp);
    if tsz > 0 { add_group("user-temp", "用户临时文件", "%LOCALAPPDATA%\\Temp", vec![serde_json::json!({"label": "Temp", "size": tsz, "size_h": human_size(tsz), "safe": true, "location": "user-temp"})]); }
    // 崩溃转储
    let dumps = local.join("CrashDumps");
    let dsz = dir_size(&dumps);
    if dsz > 0 { add_group("crash-dumps", "崩溃转储", "应用崩溃时生成的 dump 文件", vec![serde_json::json!({"label": "CrashDumps", "size": dsz, "size_h": human_size(dsz), "safe": true})]); }
    // 回收站
    let rb = PathBuf::from(r"C:\$Recycle.Bin");
    let rsz = dir_size(&rb);
    if rsz > 0 { add_group("recycle-bin", "回收站", "已删除但未清空的文件", vec![serde_json::json!({"label": "Recycle Bin", "size": rsz, "size_h": human_size(rsz), "safe": true})]); }
    groups
}

// ─── 回收站操作 ────────────────────────────────────────────────────────────

/// 通过 PowerShell 将路径列表移入回收站
pub fn move_to_recycle_bin(paths: &[String]) -> Value {
    let ps_script = r#"
Add-Type -AssemblyName Microsoft.VisualBasic
param([string[]]$Paths)
foreach ($p in $Paths) {
    try {
        if (Test-Path $p -PathType Container) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
        } elseif (Test-Path $p) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
        }
        Write-Output "OK|$p"
    } catch {
        Write-Output "ERR|$p|$($_.Exception.Message)"
    }
}
"#;
    let paths_json = serde_json::json!(paths).to_string();
    let output = std::process::Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
               &format!("param([string[]]$Paths={}); {}", paths_json, ps_script)])
        .output();
    let mut moved = 0u64; let mut errors = vec![];
    match output {
        Ok(o) => {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if line.starts_with("OK|") { moved += 1; }
                else if line.starts_with("ERR|") { errors.push(line[4..].to_string()); }
            }
        }
        Err(e) => errors.push(e.to_string()),
    }
    serde_json::json!({ "moved": moved, "errors": errors })
}

// ─── 空间历史 ──────────────────────────────────────────────────────────────

fn space_history_path() -> PathBuf {
    crate::settings::local_home().join(".cache").join("ai-usage-monitor").join("space-history.jsonl")
}

pub fn record_space_snapshot() -> Value {
    let drives = crate::disk::drives();
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let snap = serde_json::json!({ "ts": now, "drives": drives });
    if let Some(dir) = space_history_path().parent() { let _ = std::fs::create_dir_all(dir); }
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(space_history_path()) {
        let _ = writeln!(f, "{snap}");
    }
    // 保留最近 1000 条
    let text = std::fs::read_to_string(space_history_path()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().collect();
    if lines.len() > 1000 {
        let kept = lines[lines.len()-1000..].join("\n");
        let _ = std::fs::write(space_history_path(), kept);
    }
    snap
}

pub fn space_forecast() -> Value {
    let text = std::fs::read_to_string(space_history_path()).unwrap_or_default();
    let snaps: Vec<Value> = text.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    if snaps.len() < 3 {
        return serde_json::json!({ "ok": false, "reason": "need 3+ snapshots", "snapshots": snaps.len() });
    }
    let mut forecasts = vec![];
    let recent: Vec<&Value> = snaps.iter().rev().take(30).collect::<Vec<_>>().into_iter().rev().collect();
    for d in recent.last().and_then(|s| s["drives"].as_array()).unwrap_or(&vec![]) {
        let mount = d["path"].as_str().unwrap_or_default().to_string();
        let mut x: Vec<f64> = vec![]; let mut y: Vec<f64> = vec![];
        for s in &recent {
            if let Some(drive) = s["drives"].as_array().and_then(|a| a.iter().find(|d| d["path"].as_str() == Some(mount.as_str()))) {
                if let (Some(ts), Some(used)) = (s["ts"].as_f64(), drive["used"].as_f64()) {
                    x.push(ts / 86400.0); y.push(used / 1_000_000_000.0); // GB
                }
            }
        }
        if x.len() < 3 { continue; }
        let n = x.len() as f64;
        let sx: f64 = x.iter().sum(); let sy: f64 = y.iter().sum();
        let sxx: f64 = x.iter().map(|v| v*v).sum(); let sxy: f64 = x.iter().zip(&y).map(|(a,b)| a*b).sum();
        let denom = n * sxx - sx * sx;
        if denom.abs() < 1e-10 { continue; }
        let slope = (n * sxy - sx * sy) / denom; // GB/day
        let total_gb = d["total"].as_f64().unwrap_or(0.0) / 1_000_000_000.0;
        let used_gb = d["used"].as_f64().unwrap_or(0.0) / 1_000_000_000.0;
        let days_to_full = if slope > 0.01 { Some((total_gb - used_gb) / slope) } else { None };
        forecasts.push(serde_json::json!({
            "path": mount, "total_gb": total_gb, "used_gb": used_gb,
            "growth_gb_per_day": slope,
            "days_to_full": days_to_full,
            "eta": days_to_full.map(|d| {
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|x| x.as_secs()).unwrap_or(0);
                let eta = now + (d as u64) * 86400;
                let dt = chrono::DateTime::from_timestamp(eta as i64, 0).map(|d| d.with_timezone(&chrono::Local));
                dt.map(|t| t.format("%Y-%m-%d").to_string()).unwrap_or_default()
            }),
        }));
    }
    serde_json::json!({ "ok": true, "snapshots": snaps.len(), "forecasts": forecasts })
}

// ─── 统一扫描入口 ──────────────────────────────────────────────────────────

pub fn scan_all(tab: &str) -> Value {
    match tab {
        "models" => scan_models(),
        "browsers" => serde_json::json!({ "browsers": browser_scan() }),
        "python" => python_scan(),
        "junk" => serde_json::json!({ "groups": junk_scan() }),
        "health" => {
            record_space_snapshot();
            space_forecast()
        }
        _ => serde_json::json!({ "ok": false, "error": format!("unknown tab: {tab}") }),
    }
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────

fn dirs_home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

fn dir_size(path: &Path) -> u64 {
    let mut sz = 0u64;
    walk_files(path, &mut |m| sz += m.len());
    sz
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1_099_511_627_776 { format!("{:.1} TB", bytes as f64 / 1_099_511_627_776.0) }
    else if bytes >= 1_073_741_824 { format!("{:.1} GB", bytes as f64 / 1_073_741_824.0) }
    else if bytes >= 1_048_576 { format!("{:.1} MB", bytes as f64 / 1_048_576.0) }
    else if bytes >= 1024 { format!("{:.1} KB", bytes as f64 / 1024.0) }
    else { format!("{bytes} B") }
}
