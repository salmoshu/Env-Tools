//! 概览页数据（1:1 移植自 Jharu overview.rs，Apache 2.0）。
//!
//! 这里不测量任何新东西，只汇聚其它部分已经保存或已知的数据：空间
//! 历史的驱动器读数与预测、清理日志（trash-log）里本应用移走了什么、
//! 开发缓存的评级、回收站列表与休眠文件。快的部分立刻应答；可清理
//! 部分要跑几遍扫描、耗时几秒，前端单独请求。

use serde_json::Value;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const DAY: u64 = 86_400;
/// 同一来源的日志条目靠得这么近（秒）算一次清理。
const BATCH_GAP: u64 = 120;

fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

fn hs(n: u64) -> String { crate::jharu_bin::hs(n) }

fn name_of(path: &str) -> String {
    std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn system_mount() -> String {
    format!("{}\\", std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()))
}

fn shown_mount(m: &str) -> String {
    let t = m.trim_end_matches(['\\', '/']);
    if t.is_empty() { "/".into() } else { t.into() }
}

fn cache_dir() -> PathBuf {
    crate::settings::local_home().join(".cache").join("ai-usage-monitor")
}

// -------------------------------------------------------------- 空间历史

fn space_history_path() -> PathBuf { cache_dir().join("space-history.jsonl") }

fn load_snapshots() -> Vec<Value> {
    std::fs::read_to_string(space_history_path()).unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l.trim()).ok())
        .collect()
}

/// 某驱动器逐日（每天取最后一条）的 used 序列，旧在前，最多 30 天。
fn daily_used(snaps: &[Value], mount: &str) -> Vec<u64> {
    let key = mount.trim_end_matches('\\').to_lowercase();
    let mut days: Vec<(u64, u64)> = vec![]; // (day, used)
    for s in snaps {
        let Some(ts) = s["ts"].as_u64().or_else(|| s["ts"].as_f64().map(|f| f as u64)) else { continue };
        let Some(drives) = s["drives"].as_array() else { continue };
        let Some(d) = drives.iter().find(|d| {
            d["path"].as_str().map(|p| p.trim_end_matches('\\').to_lowercase()) == Some(key.clone())
                || d["mount"].as_str().map(|p| p.trim_end_matches('\\').to_lowercase()) == Some(key.clone())
        }) else { continue };
        let Some(used) = d["used"].as_u64() else { continue };
        let day = ts / DAY;
        match days.last_mut() {
            Some((d0, u0)) if *d0 == day => *u0 = used,
            _ => days.push((day, used)),
        }
    }
    let mut out: Vec<u64> = days.into_iter().map(|(_, u)| u).collect();
    if out.len() > 30 { out.drain(..out.len() - 30); }
    out
}

/// 线性回归预测（同 jharu_full::space_forecast 的斜率法，单驱动器版）。
fn forecast_for(snaps: &[Value], mount: &str, total: u64) -> Option<(u64, f64)> {
    let key = mount.trim_end_matches('\\').to_lowercase();
    let mut x: Vec<f64> = vec![];
    let mut y: Vec<f64> = vec![];
    for s in snaps.iter().rev().take(30).rev() {
        let Some(ts) = s["ts"].as_f64() else { continue };
        let Some(drives) = s["drives"].as_array() else { continue };
        let Some(d) = drives.iter().find(|d| d["path"].as_str().map(|p| p.trim_end_matches('\\').to_lowercase()) == Some(key.clone())) else { continue };
        let Some(used) = d["used"].as_f64() else { continue };
        x.push(ts / 86400.0);
        y.push(used / 1e9);
    }
    if x.len() < 3 { return None; }
    let n = x.len() as f64;
    let sx: f64 = x.iter().sum();
    let sy: f64 = y.iter().sum();
    let sxx: f64 = x.iter().map(|v| v * v).sum();
    let sxy: f64 = x.iter().zip(&y).map(|(a, b)| a * b).sum();
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-10 { return None; }
    let slope = (n * sxy - sx * sy) / denom; // GB/天
    if slope <= 0.01 { return None; }
    let used_gb = (total as f64 / 1e9) - (sy / n) * 0.0; // 用最新读数更准：
    let _ = used_gb;
    let last_used_gb = *y.last()?;
    let total_gb = total as f64 / 1e9;
    let days = (total_gb - last_used_gb) / slope;
    if days < 0.0 { return None; }
    Some((days as u64, slope))
}

// -------------------------------------------------------------- 已释放统计

/// 对整份日志求和：总量、条数、最早时间、最近六周（旧在前）、最近批次。
fn savings(entries: &[crate::jharu_bin::Entry], now: u64) -> (u64, usize, Option<u64>, Vec<u64>, Vec<Value>) {
    let total: u64 = entries.iter().map(|e| e.size).sum();
    let since = entries.iter().map(|e| e.time).min();
    let mut weeks = vec![0u64; 6];
    for e in entries {
        let age = now.saturating_sub(e.time) / (7 * DAY);
        if age < 6 { weeks[5 - age as usize] += e.size; }
    }

    let mut sorted: Vec<&crate::jharu_bin::Entry> = entries.iter().collect();
    sorted.sort_by_key(|e| e.time);
    let mut batches: Vec<(Value, u64)> = vec![];
    for e in sorted {
        match batches.last_mut() {
            Some((b, last)) if b["source"].as_str() == Some(e.source.as_str()) && e.time.saturating_sub(*last) <= BATCH_GAP => {
                let items = b["items"].as_u64().unwrap_or(1) + 1;
                let bytes = b["bytes"].as_u64().unwrap_or(0) + e.size;
                b["items"] = Value::from(items);
                b["bytes"] = Value::from(bytes);
                b["label"] = Value::from(format!("{items} 项"));
                *last = e.time;
            }
            _ => batches.push((
                serde_json::json!({
                    "label": name_of(&e.path), "source": e.source.clone(),
                    "bytes": e.size, "items": 1, "time": e.time,
                }),
                e.time,
            )),
        }
    }
    let recent = batches.into_iter().rev().take(5).map(|(b, _)| b).collect();
    (total, entries.len(), since, weeks, recent)
}

// -------------------------------------------------------------- 系统盘地图

fn system_map_path() -> PathBuf { cache_dir().join("system-map.json") }

/// 深度扫描根目录后调用：记录顶层文件夹体积，供概览树图使用。
pub fn record_system_map(root: &str, folders: &[(String, u64)], used: u64) {
    let v = serde_json::json!({
        "root": shown_mount(root), "ts": now_secs(), "used": used,
        "folders": folders.iter().map(|(p, b)| serde_json::json!({
            "name": name_of(p), "path": p, "bytes": b,
        })).collect::<Vec<_>>(),
    });
    let _ = std::fs::create_dir_all(cache_dir());
    let _ = std::fs::write(system_map_path(), v.to_string());
}

fn read_system_map() -> Option<Value> {
    let text = std::fs::read_to_string(system_map_path()).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let mut top: Vec<Value> = v["folders"].as_array()?.clone();
    top.sort_by(|a, b| b["bytes"].as_u64().unwrap_or(0).cmp(&a["bytes"].as_u64().unwrap_or(0)));
    let used = v["used"].as_u64().unwrap_or(0);
    let shown: u64 = top.iter().take(6).filter_map(|f| f["bytes"].as_u64()).sum();
    let other = used.saturating_sub(shown);
    top.truncate(6);
    Some(serde_json::json!({
        "root": v["root"], "ts": v["ts"], "folders": top, "other": other,
    }))
}

// -------------------------------------------------------------- quick

pub fn overview_quick() -> Value {
    let now = now_secs();
    let snaps = load_snapshots();
    let sys_key = system_mount().to_lowercase();

    let mut drives: Vec<Value> = crate::disk::drives().into_iter().map(|d| {
        let mount_raw = d["path"].as_str().unwrap_or_default().to_string();
        let mount = shown_mount(&mount_raw);
        let total = d["total"].as_u64().unwrap_or(0);
        let avail = d["available"].as_u64().unwrap_or(0);
        let used = d["used"].as_u64().unwrap_or(total.saturating_sub(avail));
        let system = mount.to_lowercase().trim_end_matches('\\').to_string() == sys_key.trim_end_matches('\\');
        let (days_until_full, growth) = forecast_for(&snaps, &mount_raw, total).unzip();
        let trend = daily_used(&snaps, &mount_raw);
        serde_json::json!({
            "mount": mount, "total": total, "used": used, "free": avail,
            "removable": d["removable"].as_bool().unwrap_or(false),
            "system": system,
            "days_until_full": days_until_full,
            "growth_gb_per_day": growth,
            "trend": trend,
        })
    }).collect();
    drives.sort_by_key(|d| !d["system"].as_bool().unwrap_or(false));

    let entries = crate::jharu_bin::read_all();
    let (saved_total, saved_items, saved_since, saved_weeks, recent) = savings(&entries, now);

    serde_json::json!({
        "ok": true,
        "drives": drives,
        "saved_total": saved_total, "saved_total_h": hs(saved_total),
        "saved_items": saved_items, "saved_since": saved_since,
        "saved_weeks": saved_weeks,
        "recent": recent,
        "system_map": read_system_map(),
    })
}

// -------------------------------------------------------------- cleanable

fn add(s: &mut Value, safety: &str, bytes: u64) {
    let k = format!("{safety}_bytes");
    if let Some(v) = s.get_mut(&k) {
        *v = Value::from(v.as_u64().unwrap_or(0) + bytes);
    }
    if let Some(v) = s.get_mut("items") {
        *v = Value::from(v.as_u64().unwrap_or(0) + 1);
    }
}

fn source(id: &str, label: &str, tab: &str) -> Value {
    serde_json::json!({
        "id": id, "label": label, "tab": tab,
        "safe_bytes": 0, "caution_bytes": 0, "risky_bytes": 0, "items": 0,
    })
}

/// 各来源可清理量（按安全性分档）。慢（要跑几遍扫描），前端单独请求。
pub fn overview_cleanable() -> Value {
    let mut out: Vec<Value> = vec![];

    // 开发缓存（含 AI 工具痕迹，同页展示）。
    let mut dev = source("dev", "开发缓存", "dev");
    for f in crate::jharu::scan_dev_caches() {
        add(&mut dev, f["safety"].as_str().unwrap_or("caution"), f["size"].as_u64().unwrap_or(0));
    }
    out.push(dev);

    let mut ai = source("ai", "AI 工具", "ai");
    for a in crate::jharu::ai_tool_locations() {
        add(&mut ai, a["safety"].as_str().unwrap_or("caution"), a["size"].as_u64().unwrap_or(0));
    }
    out.push(ai);

    // ML 模型：删除需重新下载，统一 caution（用过与否不影响档位）。
    let mut models = source("models", "ML 模型", "models");
    let model_scan = crate::jharu_full::scan_models();
    for m in model_scan["models"].as_array().cloned().unwrap_or_default() {
        let bytes = m["exclusive"].as_u64().filter(|b| *b > 0).or(m["size"].as_u64()).unwrap_or(0);
        add(&mut models, "caution", bytes);
    }
    out.push(models);

    // 垃圾文件（安装包/临时）：safe。
    let mut junk = source("junk", "垃圾文件", "junk");
    let junk_scan = crate::jharu_full::scan_all("junk");
    for g in junk_scan["groups"].as_array().cloned().unwrap_or_default() {
        add(&mut junk, "safe", g["total"].as_u64().unwrap_or(0));
    }
    out.push(junk);

    // 休眠文件：可逆但改变开机方式，永不"safe"。
    {
        let hiber = PathBuf::from(system_mount()).join("hiberfil.sys");
        if let Ok(m) = std::fs::metadata(&hiber) {
            let mut s = source("hibernation", "休眠文件", "system");
            add(&mut s, "caution", m.len());
            out.push(s);
        }
    }

    // 回收站：按逐项评级。
    {
        let bin = crate::jharu_bin::bin_list();
        if bin["ok"].as_bool().unwrap_or(false) {
            let mut s = source("bin", "回收站", "bin");
            if let Some(items) = bin["items"].as_array() {
                for i in items.clone() {
                    add(&mut s, i["safety"].as_str().unwrap_or("caution"), i["size_bytes"].as_u64().unwrap_or(0));
                }
            }
            out.push(s);
        }
    }

    out.retain(|s| {
        s["safe_bytes"].as_u64().unwrap_or(0) + s["caution_bytes"].as_u64().unwrap_or(0) + s["risky_bytes"].as_u64().unwrap_or(0) > 0
    });
    serde_json::json!({ "ok": true, "sources": out })
}

// -------------------------------------------------------------- 实时负载

/// CPU 占用与内存（概览"实时负载"tile，2-5s 轮询一次的轻量查询）。
pub fn system_live() -> Value {
    let script = r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $cpu = @(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $os = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ cpu = [double]$cpu; total = [uint64]$os.TotalVisibleMemorySize; free = [uint64]$os.FreePhysicalMemory } | ConvertTo-Json -Compress"#;
    let Ok(out) = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script]).output()
    else { return serde_json::json!({ "ok": false }); };
    if !out.status.success() { return serde_json::json!({ "ok": false }); }
    let text = String::from_utf8_lossy(&out.stdout);
    let v: Value = serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or(Value::Null);
    let kb = 1024u64;
    serde_json::json!({
        "ok": true,
        "cpu": v["cpu"].as_f64().map(|c| c as u32).unwrap_or(0),
        "memory_total": v["total"].as_u64().unwrap_or(0).saturating_mul(kb),
        "memory_used": v["total"].as_u64().unwrap_or(0).saturating_sub(v["free"].as_u64().unwrap_or(0)).saturating_mul(kb),
    })
}
