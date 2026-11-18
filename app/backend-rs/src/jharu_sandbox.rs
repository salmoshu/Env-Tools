//! 隐藏的应用沙箱：打包应用的私有文件夹（1:1 移植自 Jharu sandboxes.rs，
//! Apache 2.0，实现按本应用基础设施裁剪）。
//!
//! Windows 上从 Microsoft Store（或任何 MSIX 包）安装的应用不写真实的
//! AppData。Windows 在 `%LOCALAPPDATA%\Packages\<PackageFamilyName>\` 下给
//! 它一个私有的虚拟副本：`LocalCache` 持有应用以为的 `AppData\Local` 与
//! `AppData\Roaming`，`TempState` 和 `AC\Temp` 是它的草稿文件，
//! `LocalState` 和 `Settings` 是它自己的数据。资源管理器的存储设置和多数
//! 清理工具从不看那里。Jharu 在一台测试机上发现单个包（Claude）在
//! `LocalCache` 里存了 86 GB：uv 与 pip 缓存、Rust target 目录、录屏。
//!
//! 每个沙箱列出：应用（友好名、已安装还是遗留、是否运行）、真实体积、
//! 按区域分解与评级：
//! - 临时区（TempState、AC\Temp、AC\INetCache）：Safe，但仅当应用未运行。
//! - 应用自身数据（LocalState、RoamingState、Settings）：Risky。
//! - LocalCache 打开来看：已知开发缓存模式（uv/pip/npm/cargo 等）按开发
//!   缓存同样的规则评 Safe；其余按体积列为 Caution。
//! - 应用已不在安装列表的包整体 Caution，并说明原因。
//!
//! 清理走通用 /api/disk/clean（回收站 + 日志），每次勾选前重新核对。

use crate::jharu::Safety;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

fn hs(n: u64) -> String {
    let u: f64 = 1024.0;
    let v = n as f64;
    if v >= u.powi(4) { format!("{:.1}TB", v / u.powi(4)) }
    else if v >= u.powi(3) { format!("{:.1}GB", v / u.powi(3)) }
    else if v >= u.powi(2) { format!("{:.1}MB", v / u.powi(2)) }
    else if v >= u { format!("{:.0}KB", v) }
    else { format!("{n}B") }
}

fn dir_stats(path: &Path) -> (u64, u64) {
    let mut stack = vec![path.to_path_buf()];
    let mut total = 0u64;
    let mut files = 0u64;
    while let Some(p) = stack.pop() {
        if let Ok(rd) = std::fs::read_dir(&p) {
            for e in rd.flatten() {
                let ep = e.path();
                match std::fs::symlink_metadata(&ep) {
                    Ok(m) if m.is_dir() => stack.push(ep),
                    Ok(m) => { total += m.len(); files += 1; }
                    _ => {}
                }
            }
        }
    }
    (total, files)
}

/// LocalCache 内映射到开发缓存规则的模式（Jharu 把 Dev clean 的规则映射进
/// 沙箱；这里取其中最常见、可自动重建的部分）。路径为 LocalCache 下的
/// 相对位置（Local=AppData\Local，Roaming=AppData\Roaming）。
const SAFE_CACHE_PATTERNS: &[(&str, &str)] = &[
    // (相对模式, 说明)
    (r"Local\npm-cache", "npm cache"),
    (r"Local\pnpm", "pnpm store"),
    (r"Local\Yarn\Cache", "Yarn cache"),
    (r"Local\pip\cache", "pip cache"),
    (r"Local\uv\cache", "uv cache"),
    (r".cargo\registry", "Cargo registry"),
    (r"go-build", "Go build cache"),
    (r"Local\go\pkg\mod", "Go modules"),
    (r".m2\repository", "Maven repository"),
    (r".gradle\caches", "Gradle caches"),
    (r"Local\Temp", "temp"),
];

/// Get-AppxPackage 的已安装包集合（Name 与 PackageFullName 都收集）。
fn installed_packages() -> HashSet<String> {
    let script = r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-AppxPackage | Select-Object Name, PackageFullName | ConvertTo-Json -Compress"#;
    let Ok(out) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script]).output()
    else { return HashSet::new() };
    if !out.status.success() { return HashSet::new(); }
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    let arr = v.as_array().cloned()
        .or_else(|| v.as_object().map(|o| vec![Value::Object(o.clone())]))
        .unwrap_or_default();
    let mut set = HashSet::new();
    for p in arr {
        if let Some(n) = p["Name"].as_str() { set.insert(n.to_string()); }
        if let Some(f) = p["PackageFullName"].as_str() { set.insert(f.to_string()); }
    }
    set
}

/// 沙箱目录名（PackageFullName：Name_Version_Arch__PublisherId）里的包名。
fn pkg_name_of(dir: &str) -> String {
    dir.split('_').next().unwrap_or(dir).to_string()
}

/// 从沙箱内的 AppxManifest.xml 读显示名；ms-resource 资源串时退回包名。
fn display_name(pkg_dir: &Path, fallback: &str) -> String {
    let manifest = pkg_dir.join("AppxManifest.xml");
    let Ok(bytes) = std::fs::read(&manifest) else { return fallback.to_string() };
    let text = String::from_utf8_lossy(&bytes);
    // VisualElements 的 DisplayName 属性（XML 属性顺序不定，逐属性找）。
    let mut best: Option<String> = None;
    for attr in ["DisplayName=\"", "DisplayName='"] {
        if let Some(i) = text.find(attr) {
            let rest = &text[i + attr.len()..];
            let end = if attr.ends_with('"') { rest.find('"') } else { rest.find('\'') };
            if let Some(e) = end {
                let s = &rest[..e];
                if !s.is_empty() && !s.starts_with("ms-resource") { best = Some(s.to_string()); }
            }
        }
    }
    best.unwrap_or_else(|| fallback.to_string())
}

/// 进程可执行路径集合（小写），判断应用是否在运行。
fn running_exes() -> HashSet<String> {
    let script = r#"Get-Process | Where-Object { $_.Path } | Select-Object -ExpandProperty Path | ConvertTo-Json -Compress"#;
    let Ok(out) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script]).output()
    else { return HashSet::new() };
    if !out.status.success() { return HashSet::new(); }
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    match v {
        Value::Array(a) => a.into_iter().filter_map(|s| s.as_str().map(|p| p.to_lowercase())).collect(),
        Value::String(s) => [s.to_lowercase()].into_iter().collect(),
        _ => HashSet::new(),
    }
}

/// 沙箱扫描报告：包列表 + 区域评级。
pub fn sandboxes_scan() -> Value {
    let packages_root = crate::settings::local_home()
        .join("AppData").join("Local").join("Packages");
    let installed = installed_packages();
    let running = running_exes();

    let Ok(rd) = std::fs::read_dir(&packages_root) else {
        return serde_json::json!({ "ok": false, "error": "无法读取 Packages 目录" });
    };
    let mut pkgs: Vec<Value> = vec![];
    for entry in rd.flatten() {
        let dir = entry.path();
        if !dir.is_dir() { continue; }
        let dirname = entry.file_name().to_string_lossy().into_owned();
        let pkg_name = pkg_name_of(&dirname);
        let is_installed = installed.contains(&dirname) || installed.contains(&pkg_name);
        // 运行判定：任何进程的可执行路径落在 WindowsApps\<包名> 下。
        let pkg_lower = pkg_name.to_lowercase();
        let running_now = running.iter().any(|p| p.contains(&pkg_lower));

        // 区域分解。
        let mut areas: Vec<Value> = vec![];
        let mut total: u64 = 0;
        let mut collect_area = |id: &str, label: &str, sub: Option<&str>, safety: Safety, note: &str| -> Option<u64> {
            let path = match sub {
                Some(s) => dir.join(s),
                None => dir.join(id),
            };
            if !path.is_dir() { return None; }
            let (size, files) = dir_stats(&path);
            if size == 0 { return None; }
            areas.push(serde_json::json!({
                "id": id, "label": label, "path": path.display().to_string(),
                "size": size, "size_h": hs(size), "files": files,
                "safety": safety.as_str(), "note": note,
            }));
            Some(size)
        };
        // 临时区：Safe（应用未运行时）。
        for (id, label) in [("TempState", "临时状态"), (r"AC\Temp", "应用临时"), (r"AC\INetCache", "网络缓存")] {
            let note = if running_now { "应用正在运行，清理前请先退出" } else { "应用未运行，可安全清理" };
            let safety = if running_now { Safety::Caution } else { Safety::Safe };
            if let Some(s) = collect_area(id, &format!("临时区·{label}"), None, safety, note) { total += s; }
        }
        // 应用自身数据：仅列出，Risky。
        for (id, label) in [("LocalState", "本地数据"), ("RoamingState", "漫游数据"), ("Settings", "设置")] {
            if let Some(s) = collect_area(id, &format!("应用数据·{label}"), None, Safety::Risky, "应用自身数据，清理会丢失应用状态") { total += s; }
        }
        // LocalCache：打开来看。已知开发缓存模式 → Safe，其余大目录 → Caution。
        let local_cache = dir.join("LocalCache");
        if local_cache.is_dir() {
            let (size, files) = dir_stats(&local_cache);
            if size > 0 {
                total += size;
                let mut details: Vec<Value> = vec![];
                // 常见开发缓存位置（LocalCache 下的相对路径）。
                for (pat, name) in SAFE_CACHE_PATTERNS {
                    let p = local_cache.join(pat);
                    if p.is_dir() {
                        let (s, f) = dir_stats(&p);
                        if s > 0 {
                            details.push(serde_json::json!({
                                "path": p.display().to_string(), "name": name,
                                "size": s, "size_h": hs(s), "files": f,
                                "safety": "safe", "note": "已知缓存，工具自动重建",
                            }));
                        }
                    }
                }
                // 其余大子目录（>100MB）列为 Caution。
                if let Ok(rd2) = std::fs::read_dir(&local_cache.join("Local")) {
                    for e2 in rd2.flatten() {
                        let p2 = e2.path();
                        if !p2.is_dir() { continue; }
                        let rel = p2.strip_prefix(&local_cache).unwrap_or(&p2).display().to_string();
                        if SAFE_CACHE_PATTERNS.iter().any(|(pat, _)| rel.starts_with(pat.trim_start_matches(r"Local\"))) { continue; }
                        let (s, f) = dir_stats(&p2);
                        if s > 100_000_000 {
                            details.push(serde_json::json!({
                                "path": p2.display().to_string(), "name": rel,
                                "size": s, "size_h": hs(s), "files": f,
                                "safety": "caution", "note": "应用以为的 AppData 内容，清理前先查看",
                            }));
                        }
                    }
                }
                details.sort_by(|a, b| b["size"].as_u64().unwrap_or(0).cmp(&a["size"].as_u64().unwrap_or(0)));
                areas.push(serde_json::json!({
                    "id": "LocalCache", "label": "LocalCache（虚拟 AppData）",
                    "path": local_cache.display().to_string(),
                    "size": size, "size_h": hs(size), "files": files,
                    "safety": "caution", "note": "应用以为的 AppData；按内容分级",
                    "details": details,
                }));
            }
        }
        if total == 0 { continue; }
        pkgs.push(serde_json::json!({
            "dirname": dirname, "name": pkg_name,
            "display": display_name(&dir, &pkg_name),
            "installed": is_installed, "running": running_now,
            "total": total, "total_h": hs(total),
            "areas": areas,
            "note": if is_installed { Value::Null } else {
                serde_json::json!("应用已卸载，但沙箱数据仍在。确认不再需要该应用的数据后可整体清理")
            },
        }));
    }
    pkgs.sort_by(|a, b| b["total"].as_u64().unwrap_or(0).cmp(&a["total"].as_u64().unwrap_or(0)));
    let grand: u64 = pkgs.iter().filter_map(|p| p["total"].as_u64()).sum();
    serde_json::json!({ "ok": true, "packages": pkgs, "count": pkgs.len(), "total_h": hs(grand) })
}

/// 展开一个包的可清理项（临时区 + LocalCache 内 Safe 明细），供前端勾选。
pub fn sandbox_cleanable(dirname: &str) -> Value {
    let pkg_dir = crate::settings::local_home()
        .join("AppData").join("Local").join("Packages").join(dirname);
    if !pkg_dir.is_dir() { return serde_json::json!({ "ok": false, "error": "包不存在" }); }
    let running_now = {
        let pkg_lower = pkg_name_of(dirname).to_lowercase();
        running_exes().iter().any(|p| p.contains(&pkg_lower))
    };
    let mut items: Vec<Value> = vec![];
    for id in ["TempState", r"AC\Temp", r"AC\INetCache"] {
        let p = pkg_dir.join(id);
        if p.is_dir() {
            let (s, _) = dir_stats(&p);
            if s > 0 && !running_now {
                items.push(serde_json::json!({ "path": p.display().to_string(), "size": s, "safety": "safe", "label": id }));
            }
        }
    }
    let lc = pkg_dir.join("LocalCache");
    for (pat, name) in SAFE_CACHE_PATTERNS {
        let p = lc.join(pat);
        if p.is_dir() {
            let (s, _) = dir_stats(&p);
            if s > 0 {
                items.push(serde_json::json!({ "path": p.display().to_string(), "size": s, "safety": if running_now { "caution" } else { "safe" }, "label": name }));
            }
        }
    }
    serde_json::json!({ "ok": true, "items": items })
}
