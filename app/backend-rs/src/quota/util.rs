//! 共享小工具：JSON 数值提取、时间解析、窗口归一化（Kimi/Codex 窗口结构相同）。

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;

use crate::settings::env_value;

pub fn env_timeout(name: &str, default: u64) -> u64 {
    env_value(name).and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// 数字或数字字符串 → f64；缺失/非法为 0。
pub fn num(value: Option<&Value>) -> f64 {
    value.and_then(num_opt).unwrap_or(0.0)
}

pub fn num_of(value: Option<&Value>) -> f64 {
    value.and_then(num_opt).unwrap_or(0.0)
}

pub fn num_opt(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

pub fn fetched_now() -> String {
    iso_seconds(Local::now())
}

pub fn iso_seconds(moment: DateTime<Local>) -> String {
    moment.format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

/// naive 时间按本机时区解释（与 Python _parse_local_datetime 一致）
pub fn parse_local_datetime(text: &str) -> Option<DateTime<Local>> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(dt.with_timezone(&Local));
    }
    for format in ["%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Local
                .from_local_datetime(&naive)
                .single()
                .or_else(|| Local.from_local_datetime(&naive).earliest());
        }
    }
    None
}

/// 时间戳（秒/毫秒数字或 ISO 字符串）到 now 的剩余秒数，过去为 0。
pub fn seconds_until(value: Option<&Value>, now: DateTime<Utc>) -> Option<i64> {
    let value = match value {
        Some(v) if !v.is_null() => v,
        _ => return None,
    };
    match value {
        Value::Number(n) => {
            let numeric = n.as_f64()?;
            let numeric = if numeric > 10_000_000_000.0 { numeric / 1000.0 } else { numeric };
            Some((numeric as i64 - now.timestamp()).max(0))
        }
        Value::String(text) => {
            let trimmed = text.trim().trim_end_matches('Z');
            if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f") {
                let dt = Utc.from_utc_datetime(&naive);
                return Some((dt - now).num_seconds().max(0));
            }
            let naive = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S").ok()?;
            let dt = Utc.from_utc_datetime(&naive);
            Some((dt - now).num_seconds().max(0))
        }
        _ => None,
    }
}

/// 数字（>1e10 视为毫秒）或 RFC3339 字符串 → UTC 时刻。
pub fn parse_timestamp(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let value = match value {
        Some(v) if !v.is_null() => v,
        _ => return None,
    };
    match value {
        Value::Number(n) => {
            let mut numeric = n.as_f64()?;
            if numeric > 10_000_000_000.0 {
                numeric /= 1000.0;
            }
            Utc.timestamp_opt(numeric as i64, 0).single()
        }
        Value::String(text) => {
            let trimmed = text.trim().trim_end_matches('Z');
            DateTime::parse_from_rfc3339(&format!("{trimmed}+00:00"))
                .ok()
                .map(|dt| dt.with_timezone(&Utc))
        }
        _ => None,
    }
}

fn one_month_before(moment: DateTime<Utc>) -> DateTime<Utc> {
    let (year, month) = if moment.month() == 1 {
        (moment.year() - 1, 12)
    } else {
        (moment.year(), moment.month() - 1)
    };
    let day = moment.day().min(days_in_month(year, month));
    let naive = moment
        .naive_utc()
        .with_year(year)
        .and_then(|n| n.with_month(month))
        .and_then(|n| n.with_day(day))
        .unwrap_or_else(|| moment.naive_utc());
    Utc.from_utc_datetime(&naive)
}

pub fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let first_next = Utc
        .with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0)
        .single()
        .expect("valid first-of-month");
    (first_next - ChronoDuration::days(1)).day()
}

/// 月窗口秒数：重置时刻往前推一个自然月（GLM 积分窗 / Kimi 月总量共用）。
pub fn monthly_window_seconds(reset_at: DateTime<Utc>) -> i64 {
    (reset_at - one_month_before(reset_at)).num_seconds()
}

/// 日历月加法（跨年时进位、日按目标月天数截断）。
pub fn add_calendar_months_utc(moment: DateTime<Utc>, months: i64) -> DateTime<Utc> {
    let total = moment.year() * 12 + moment.month0() as i32 + months as i32;
    let year = total / 12;
    let month = (total % 12 + 1) as u32;
    let day = moment.day().min(days_in_month(year, month));
    let naive = moment
        .naive_utc()
        .with_year(year)
        .and_then(|n| n.with_month(month))
        .and_then(|n| n.with_day(day))
        .unwrap_or_else(|| moment.naive_utc());
    Utc.from_utc_datetime(&naive)
}

/// percent() 的 Rust 版：used > remaining/limit > used*100/limit，截断到 0..100。
pub fn percent(used: Option<&Value>, remaining: Option<&Value>, limit: Option<&Value>, used_amount: Option<&Value>) -> f64 {
    if let Some(value) = used.and_then(num_opt) {
        return value.clamp(0.0, 100.0);
    }
    if let Some(limit) = limit.and_then(num_opt) {
        if limit > 0.0 {
            if let Some(amount) = used_amount.and_then(num_opt) {
                return (amount * 100.0 / limit).clamp(0.0, 100.0);
            }
            if let Some(rest) = remaining.and_then(num_opt) {
                return ((limit - rest) * 100.0 / limit).clamp(0.0, 100.0);
            }
        }
    }
    0.0
}

/// Kimi/Codex 窗口归一化：reset_after_seconds 缺失时由 reset_at/resetTime 推算。
pub fn normalize_window(label: &str, data: &Value, default_seconds: Option<i64>) -> Value {
    let mut reset_after = data
        .get("reset_after_seconds")
        .and_then(num_opt);
    if reset_after.is_none() {
        reset_after = seconds_until(
            data.get("reset_at").or_else(|| data.get("resetTime")),
            Utc::now(),
        )
        .map(|v| v as f64);
    }
    serde_json::json!({
        "label": label,
        "used_percent": percent(
            data.get("used_percent"),
            data.get("remaining"),
            data.get("limit"),
            data.get("used"),
        ),
        "reset_after_seconds": reset_after.map(|v| v.max(0.0) as i64),
        "window_seconds": data.get("limit_window_seconds").and_then(num_opt).map(|v| v as i64).or(default_seconds),
    })
}
