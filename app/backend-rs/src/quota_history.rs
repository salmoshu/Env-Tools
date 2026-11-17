//! 配额快照历史：每次配额采集落盘 (ts, provider, window, pct, elapsed, tokens)，
//! 用于"高水位中位数"额度估算——单点 tokens/pct 受百分比取整与跨设备
//! 覆盖差影响大；按窗口代际取峰值水位点估算、跨代取中位数后显著更稳。
//! 行量控制：pct 或代际变化才落一行；文件超限保留尾部。

use serde_json::Value;
use std::io::Write;
use std::path::Path;

const MAX_LINES: usize = 20_000;
const KEEP_LINES: usize = 8_000;

/// 追加一条快照（调用方已做变化去重）。文件超 MAX_LINES 时保留尾部 KEEP_LINES 行。
pub fn append(path: &Path, line: &Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > 4 * 1024 * 1024 {
            rotate(path);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{line}");
    }
}

fn rotate(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() <= KEEP_LINES {
        return;
    }
    let kept: Vec<&str> = lines.split_off(lines.len() - KEEP_LINES);
    let tmp = path.with_extension("rotating");
    if let Ok(mut f) = std::fs::File::create(&tmp) {
        for l in kept {
            let _ = writeln!(f, "{l}");
        }
        let _ = std::fs::rename(&tmp, path);
    }
}

/// 读取全部快照（坏行跳过），按行序（时间序）返回
pub fn read(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect()
}

/// 高水位中位数估算：按 (provider, window_seconds) 过滤 → 以
/// window_start = ts - elapsed 分代 → 每代取 pct 最高的快照（该代最准点）
/// → estimate = tokens / pct。返回最近 N 代的估算值数组（旧→新），
/// 前端与当前单点合并取中位数。
pub fn generation_estimates(
    path: &Path,
    provider: &str,
    window_seconds: i64,
    max_gens: usize,
) -> Vec<f64> {
    let mut rows: Vec<(i64, f64, f64)> = Vec::new(); // (window_start, pct, tokens)
    for snap in read(path) {
        if snap.get("p").and_then(|v| v.as_str()) != Some(provider) {
            continue;
        }
        let win = snap.get("win").and_then(|v| v.as_i64()).unwrap_or(0);
        if (win - window_seconds).abs() > 600 {
            continue;
        }
        let pct = snap.get("pct").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let tokens = snap.get("tok").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let ts = snap.get("ts").and_then(|v| v.as_i64()).unwrap_or(0);
        let elapsed = snap.get("el").and_then(|v| v.as_i64()).unwrap_or(0);
        if pct >= 3.0 && tokens > 0.0 && ts > 0 && elapsed > 0 {
            rows.push((ts - elapsed, pct, tokens));
        }
    }
    // 分代取每代最高 pct 的行（rows 已按 window_start 排序，相邻同代）
    rows.sort_by_key(|(start, _, _)| *start);
    let mut gens: Vec<(i64, f64, f64)> = Vec::new(); // (start, best_pct, tokens)
    for (start, pct, tokens) in rows {
        match gens.last_mut() {
            Some((s, best_pct, best_tok)) if *s == start => {
                if pct > *best_pct {
                    *best_pct = pct;
                    *best_tok = tokens;
                }
            }
            _ => gens.push((start, pct, tokens)),
        }
    }
    gens.iter()
        .map(|(_, pct, tokens)| tokens / (pct / 100.0))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(max_gens)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}
