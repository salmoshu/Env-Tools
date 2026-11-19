//! DeepSeek：API key 直连余额查询，官方口径展示。
//!
//! v0.7.41 起弃用「固定 ¥50/月」的伪用量窗口：官方 API 只有
//! /user/balance（充值余额 / 赠送余额 / 总余额），无任何用量或消费
//! 记录端点，因此卡片改为纯数字展示——充值、赠送、累计消费三项对齐
//! 官方控制台。累计消费官方也不提供，本地按「相邻两次采集的余额
//! 净减少量」累计（充值造成的负增量不计），从首次跟踪起算。

use serde_json::Value;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::http::get_json;
use super::util::{env_timeout, fetched_now, num};
use crate::accounts::AccountProfile;
use crate::settings::{env_enabled, env_value, read_json};

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";

/// 官方口径归一化：不产生伪用量窗口，仅数字行（充值/赠送/总余额）。
/// 官方字段全覆盖：币种（CNY→¥ / USD→$）与 is_available 一并透出。
pub fn normalize_deepseek(data: &Value) -> Value {
    let infos = data.get("balance_infos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let (total, granted, topped_up, currency) = if !infos.is_empty() {
        let balance = infos
            .iter()
            .find(|b| b.get("currency").and_then(|v| v.as_str()).unwrap_or("").to_uppercase() == "CNY")
            .unwrap_or(&infos[0]);
        (
            num(balance.get("total_balance")),
            num(balance.get("granted_balance")),
            num(balance.get("topped_up_balance")),
            balance
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("CNY")
                .to_uppercase(),
        )
    } else {
        // 兼容旧抓包格式（report data 字段）
        (
            num(data.get("data").and_then(|d| d.get("balance"))),
            num(data.get("data").and_then(|d| d.get("giveAmount"))),
            num(data.get("data").and_then(|d| d.get("rechargeAmount"))),
            "CNY".to_string(),
        )
    };
    let symbol = if currency == "USD" { "$" } else { "¥" };
    let available = data
        .get("is_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let mut extra_lines = vec![
        format!("Topped-up: {symbol}{topped_up:.2}   Granted: {symbol}{granted:.2}"),
        format!("Total balance: {symbol}{total:.2}"),
    ];
    if !available {
        extra_lines.push("Account unavailable".to_string());
    }
    // 官方控制台口径的统计卡片（前端优先渲染，extra_lines 作兼容兜底）
    let stats = serde_json::json!([
        {"label": "Topped-up", "value": format!("{symbol}{topped_up:.2}")},
        {"label": "Granted", "value": format!("{symbol}{granted:.2}")},
        {"label": "Total", "value": format!("{symbol}{total:.2}")},
    ]);
    serde_json::json!({
        "provider": "DeepSeek",
        "plan": "API",
        "windows": [],
        "stats": stats,
        // 官方 is_available：当前账户是否有余额可供 API 调用
        "available": available,
        "extra_lines": extra_lines,
        "fetched_at": fetched_now(),
        // 消费跟踪快照字段：collect 在此基础上补 spent 追踪
        "_balance_snapshot": {
            "total": total,
            "granted": granted,
            "topped_up": topped_up,
            "currency": currency,
        },
    })
}

/// 累计消费状态文件：~/.cache/ai-usage-monitor/deepseek-spend.json（按账号分键）。
/// 起始日期单独落在 `.started` 标记文件：状态文件即使损坏重建，也不会把
/// “跟踪起始日”重置成当天（v0.8.1 前的实际故障：since 被中途重置为 11-16）。
fn spend_dir() -> PathBuf {
    crate::settings::local_home()
        .join(".cache")
        .join("ai-usage-monitor")
}

fn spend_state_path() -> PathBuf {
    spend_dir().join("deepseek-spend.json")
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("deepseek-spend.json");
    path.with_file_name(format!("{name}{suffix}"))
}

/// 状态写入期间的进程间互斥：create_new 锁文件 + 陈旧锁（30s）回收。
struct SpendLock {
    path: PathBuf,
}

impl Drop for SpendLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn acquire_lock(path: &Path) -> Option<SpendLock> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut file) => {
                let _ = write!(file, "{}", std::process::id());
                return Some(SpendLock {
                    path: path.to_path_buf(),
                });
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => {
                let stale = std::fs::metadata(path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .map(|age| age.as_secs() > 30)
                    .unwrap_or(false);
                if stale {
                    let _ = std::fs::remove_file(path);
                    continue;
                }
                if Instant::now() >= deadline {
                    // 拿不到锁也继续：宁可冒一次并发写风险，也不让配额采集卡死
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

fn replace_file(from: &Path, to: &Path) -> std::io::Result<()> {
    match std::fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(first) => {
            // Windows 偶尔拒绝覆盖仍被读句柄占用的目标：退一步先删再改名
            let _ = std::fs::remove_file(to);
            std::fs::rename(from, to).map_err(|_| first)
        }
    }
}

fn write_text_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = sibling(path, ".tmp");
    std::fs::write(&tmp, text)?;
    replace_file(&tmp, path)
}

/// 状态文件写入：临时文件 + rename 原子替换，旧版本保留为 `.bak`
/// （解析失败时可回退，避免“读坏一次就从零开始”）。
fn write_state_atomic(path: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let text = serde_json::to_string_pretty(data).map_err(|err| err.to_string())?;
    let tmp = sibling(path, ".tmp");
    std::fs::write(&tmp, text).map_err(|err| format!("Cannot write {}: {err}", tmp.display()))?;
    if path.is_file() {
        let _ = std::fs::copy(path, sibling(path, ".bak"));
    }
    replace_file(&tmp, path).map_err(|err| format!("Cannot replace {}: {err}", path.display()))
}

fn read_spend_state(path: &Path) -> Value {
    if let Ok(value) = read_json(path) {
        if value.is_object() {
            return value;
        }
    }
    if let Ok(value) = read_json(&sibling(path, ".bak")) {
        if value.is_object() {
            return value;
        }
    }
    serde_json::json!({})
}

fn read_marker(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let trimmed = text.trim();
    chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
        .ok()
        .map(|_| trimmed.to_string())
}

/// 状态文件创建日期：用户机器上 CreationTime=2026-10-24，而 since 被重置为
/// 11-16——迁移时取两者较早者即可找回真实起点。
fn file_created_date(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let system = meta.created().or_else(|_| meta.modified()).ok()?;
    let utc: chrono::DateTime<chrono::Utc> = system.into();
    Some(
        utc.with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string(),
    )
}

/// 起始日标记只创建一次；迁移时取 min(状态里的 since, 文件创建日, 今天)。
fn ensure_spend_start(state_path: &Path, marker_path: &Path, state: &Value) -> String {
    if let Some(date) = read_marker(marker_path) {
        return date;
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut candidate = today;
    for entry in state.as_object().into_iter().flat_map(|obj| obj.values()) {
        if let Some(since) = entry.get("since").and_then(|v| v.as_str()) {
            if chrono::NaiveDate::parse_from_str(since, "%Y-%m-%d").is_ok()
                && since < candidate.as_str()
            {
                candidate = since.to_string();
            }
        }
    }
    if let Some(created) = file_created_date(state_path) {
        if created < candidate {
            candidate = created;
        }
    }
    let _ = write_text_atomic(marker_path, &format!("{candidate}\n"));
    candidate
}

/// 依据本次余额快照更新累计消费：余额净减少量（>0）计入 spent。
/// 返回 (spent, since_iso)；since 始终来自起始日标记文件。
fn track_spend_at(
    state_path: &Path,
    marker_path: &Path,
    account_id: &str,
    snapshot: &Value,
) -> (f64, String) {
    let _lock = acquire_lock(&sibling(state_path, ".lock"));
    let mut state = read_spend_state(state_path);
    let since = ensure_spend_start(state_path, marker_path, &state);
    let entry = state.get(account_id).cloned().unwrap_or_else(|| {
        serde_json::json!({ "spent": 0.0, "since": since, "last_total": Value::Null })
    });
    let mut spent = entry.get("spent").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if let Some(last) = entry.get("last_total").and_then(|v| v.as_f64()) {
        let current = snapshot.get("total").and_then(|v| v.as_f64()).unwrap_or(last);
        let delta = last - current;
        // 正增量 = 消费；负增量 = 充值/赠送入账，不冲减累计消费
        if delta > 0.0 {
            spent += delta;
        }
    }
    let spent = (spent * 100.0).round() / 100.0;
    let updated = serde_json::json!({
        "spent": spent,
        "since": since,
        "last_total": snapshot.get("total").cloned().unwrap_or(Value::Null),
    });
    if let Some(obj) = state.as_object_mut() {
        obj.insert(account_id.to_string(), updated);
        let _ = write_state_atomic(state_path, &Value::Object(obj.clone()));
    }
    (spent, since)
}

fn track_spend(account_id: &str, snapshot: &Value) -> (f64, String) {
    let state_path = spend_state_path();
    let marker_path = sibling(&state_path, ".started");
    track_spend_at(&state_path, &marker_path, account_id, snapshot)
}

pub fn collect(profile: &AccountProfile) -> Result<Value, String> {
    let key = crate::accounts::api_key(profile)?;
    let url = env_value("DEEPSEEK_BALANCE_URL").unwrap_or_else(|| DEEPSEEK_BALANCE_URL.into());
    let data = get_json(
        &url,
        &key,
        env_enabled("DEEPSEEK_USE_PROXY", true),
        env_timeout("DEEPSEEK_TIMEOUT", 30),
    )?;
    let mut account = normalize_deepseek(&data);
    account["account_id"] = Value::String(profile.id.clone());
    account["account_label"] = Value::String(profile.label.clone());
    // 累计消费：官方无接口，本地按余额净减少量累计（见模块注释）
    let snapshot = account
        .as_object_mut()
        .and_then(|obj| obj.remove("_balance_snapshot"))
        .unwrap_or_else(|| serde_json::json!({}));
    let (spent, since) = track_spend(&profile.id, &snapshot);
    let symbol = snapshot
        .get("currency")
        .and_then(|v| v.as_str())
        .map(|c| if c == "USD" { "$" } else { "¥" })
        .unwrap_or("¥");
    if let Some(lines) = account.get_mut("extra_lines").and_then(|v| v.as_array_mut()) {
        lines.push(Value::String(format!(
            "Spent: {symbol}{spent:.2} (tracked since {since})"
        )));
    }
    // 累计消费入第四张统计卡
    if let Some(stats) = account.get_mut("stats").and_then(|v| v.as_array_mut()) {
        // since 起始日跟在 Spent 标签右侧，金额保持纯净
        stats.push(serde_json::json!({
            "label": format!("Spent (since {since})"),
            "value": format!("{symbol}{spent:.2}"),
        }));
    }
    super::membership::attach_manual_membership(&mut account, &profile.membership_key());
    Ok(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "env-tools-deepseek-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn marker_keeps_historical_start_across_state_rewrites() {
        let dir = temp_dir();
        let state = dir.join("deepseek-spend.json");
        let marker = dir.join("deepseek-spend.json.started");
        std::fs::write(&marker, "2026-10-24\n").unwrap();
        std::fs::write(
            &state,
            r#"{"default":{"last_total":51.07,"since":"2026-11-16","spent":10.31}}"#,
        )
        .unwrap();
        let snapshot = serde_json::json!({ "total": 40.76 });
        let (spent, since) = track_spend_at(&state, &marker, "default", &snapshot);
        assert_eq!(since, "2026-10-24");
        assert!((spent - 20.62).abs() < 1e-9);
        let stored = read_json(&state).unwrap();
        assert_eq!(stored["default"]["since"], "2026-10-24");
        assert_eq!(stored["default"]["last_total"], 40.76);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn corrupt_state_falls_back_to_backup() {
        let dir = temp_dir();
        let state = dir.join("deepseek-spend.json");
        let marker = dir.join("deepseek-spend.json.started");
        std::fs::write(&marker, "2026-10-24\n").unwrap();
        std::fs::write(&state, "{ not json").unwrap();
        std::fs::write(
            &sibling(&state, ".bak"),
            r#"{"default":{"last_total":30.0,"since":"2026-11-16","spent":5.5}}"#,
        )
        .unwrap();
        let snapshot = serde_json::json!({ "total": 20.0 });
        let (spent, since) = track_spend_at(&state, &marker, "default", &snapshot);
        assert_eq!(since, "2026-10-24");
        assert!((spent - 15.5).abs() < 1e-9);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn first_run_keeps_older_entry_since() {
        let dir = temp_dir();
        let state = dir.join("deepseek-spend.json");
        let marker = dir.join("deepseek-spend.json.started");
        std::fs::write(
            &state,
            r#"{"default":{"last_total":30.0,"since":"2026-10-24","spent":1.0}}"#,
        )
        .unwrap();
        let snapshot = serde_json::json!({ "total": 29.0 });
        let (spent, since) = track_spend_at(&state, &marker, "default", &snapshot);
        assert_eq!(since, "2026-10-24");
        assert!((spent - 2.0).abs() < 1e-9);
        assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "2026-10-24");
        std::fs::remove_dir_all(dir).ok();
    }
}
