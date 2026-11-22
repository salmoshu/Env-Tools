//! 磁盘管理：驱动器概览 + 目录深度扫描（体积排行）。
//! 参考 Jharu（github.com/riponcm/Jharu）的"开发者磁盘清理"理念——
//! 按安全等级分类、大目录排行、节省空间估算。

use serde_json::Value;
use std::path::Path;

/// 驱动器列表：卷标、总容量、可用、文件系统、可移除标记
pub fn drives() -> Vec<Value> {
    #[cfg(windows)]
    {
        let mut out = Vec::new();
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            let p = Path::new(&root);
            if !p.exists() {
                continue;
            }
            if let Ok(meta) = p.metadata() {
                // Windows: fscc = total, caller_free = available
                // 用 Win32 API 等价：volume_size 通过 metadata 的 ns
                // 简化用 std::fs::read_dir 遍历代价太大，改用 GetDiskFreeSpaceExW
                let (total, avail) = unsafe {
                    let mut total_bytes: u64 = 0;
                    let mut avail_bytes: u64 = 0;
                    let mut total_free: u64 = 0;
                    let root_wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
                    let ok = GetDiskFreeSpaceExW(
                        root_wide.as_ptr(),
                        &mut avail_bytes as *mut u64,
                        &mut total_bytes as *mut u64,
                        &mut total_free as *mut u64,
                    );
                    if ok != 0 { (total_bytes, avail_bytes) } else { (0, 0) }
                };
                let _ = meta;
                if total > 0 {
                    out.push(serde_json::json!({
                        "path": root,
                        "total": total,
                        "available": avail,
                        "used": total - avail,
                        "used_percent": if total > 0 { ((total - avail) as f64 / total as f64 * 10000.0).round() / 100.0 } else { 0.0 },
                        "removable": false,
                    }));
                }
            }
        }
        return out;
    }
    #[cfg(not(windows))]
    {
        Vec::new() // Linux 走 statvfs
    }
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetDiskFreeSpaceExW(
        directory: *const u16,
        free_bytes_available: *mut u64,
        total_bytes: *mut u64,
        total_free_bytes: *mut u64,
    ) -> i32;
}

/// 目录体积排行：递归扫描，返回前 top_n 个子目录/文件
///（按体积降序）。max_depth 限制深度，hidden 跳过隐藏。
pub fn scan_dir(path: &str, top_n: usize, max_depth: usize) -> Value {
    let root = Path::new(path);
    if !root.is_dir() {
        return serde_json::json!({ "ok": false, "error": format!("not a directory: {path}") });
    }
    let start = std::time::Instant::now();
    let (total, items) = dir_size(root, max_depth, 0);
    let mut sorted: Vec<(String, u64, bool)> = items; // (name, size, is_dir)
    sorted.sort_by(|a, b| b.1.cmp(&a.1));
    sorted.truncate(top_n);
    let entries: Vec<Value> = sorted
        .into_iter()
        .map(|(name, size, is_dir)| {
            serde_json::json!({
                "name": name,
                "size": size,
                "is_dir": is_dir,
                "size_h": human_size(size),
            })
        })
        .collect();
    serde_json::json!({
        "ok": true,
        "path": path,
        "total": total,
        "total_h": human_size(total),
        "elapsed_ms": start.elapsed().as_millis() as u64,
        "items": entries,
    })
}

/// 递归累计目录体积，返回 (total, 直属子项列表)
fn dir_size(dir: &Path, max_depth: usize, depth: usize) -> (u64, Vec<(String, u64, bool)>) {
    let mut total: u64 = 0;
    let mut children: Vec<(String, u64, bool)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (0, children);
    };
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().into_owned();
        if meta.is_dir() {
            let (sub, _) = if depth < max_depth {
                dir_size(&entry.path(), max_depth, depth + 1)
            } else {
                (0, Vec::new())
            };
            total += sub;
            children.push((name, sub, true));
        } else {
            let sz = meta.len();
            total += sz;
            children.push((name, sz, false));
        }
    }
    (total, children)
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1_099_511_627_776 {
        format!("{:.1}T", bytes as f64 / 1_099_511_627_776.0)
    } else if bytes >= 1_073_741_824 {
        format!("{:.1}G", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1}M", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1}K", bytes as f64 / 1024.0)
    } else {
        format!("{bytes}B")
    }
}
