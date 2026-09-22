//! GLM（智谱）：API key 直连配额 + 订阅查询
//!（口径同 usage_monitor.py normalize_glm / normalize_glm_subscription）。

use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use serde_json::Value;

use super::http::get_json;
use super::util::{
    env_timeout, fetched_now, iso_seconds, monthly_window_seconds, num, parse_local_datetime,
    parse_timestamp, seconds_until,
};
use crate::settings::{env_enabled, env_value, local_home};

const GLM_QUOTA_URL: &str = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const GLM_SUBSCRIPTION_PATH: &str = "/api/biz/subscription/list";
const GLM_BILLING_CYCLE_MONTHS: &[(&str, i64)] = &[
    ("monthly", 1),
    ("quarterly", 3),
    ("semi-annually", 6),
    ("yearly", 12),
];

/// 凭证：GLM_API_KEY / ZHIPU_API_KEY / ZHIPUAI_API_KEY 环境变量优先，其次 credentials 文件。
fn api_key() -> Result<String, String> {
    for name in ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"] {
        if let Some(key) = env_value(name) {
            return Ok(key);
        }
    }
    let path = env_value("GLM_CREDENTIALS_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| local_home().join(".glm").join("credentials.json"));
    if path.is_file() {
        return super::api_key_from_file(&path, "GLM", &["api_key", "GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"]);
    }
    Err("GLM_API_KEY not set; export it, write it to ~/.glm/credentials.json, or pass --glm-key".into())
}

fn limit_percent(limit: &Value) -> Option<f64> {
    match limit.get("percentage").and_then(|v| v.as_f64()) {
        Some(pct) => Some(pct.clamp(0.0, 100.0)),
        None => limit
            .get("percentage")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .map(|pct| pct.clamp(0.0, 100.0)),
    }
}

fn glm_normalize_level(payload: &Value) -> String {
    let level = payload
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if level.is_empty() {
        return "Coding".into();
    }
    let mut chars = level.chars();
    match chars.next() {
        Some(first) => format!("Coding {}{}", first.to_uppercase(), chars.as_str()),
        None => "Coding".into(),
    }
}

pub fn normalize_glm(data: &Value) -> Value {
    let payload = data.get("data").filter(|v| v.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}));
    let limits = payload.get("limits").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let level = glm_normalize_level(&payload);
    let mut windows: Vec<Value> = Vec::new();
    let mut extra_lines: Vec<String> = Vec::new();

    let token_limits: Vec<&Value> = limits
        .iter()
        .filter(|l| {
            matches!(
                l.get("type").and_then(|v| v.as_str()),
                Some("CREDIT_LIMIT") | Some("TOKENS_LIMIT")
            )
        })
        .collect();

    let pick = |unit: i64, number: i64| -> Option<&Value> {
        token_limits.iter().copied().find(|l| {
            l.get("unit").and_then(|v| v.as_i64()) == Some(unit)
                && l.get("number").and_then(|v| v.as_i64()) == Some(number)
        })
    };
    let five_hour = pick(3, 5);
    let weekly = pick(6, 1);
    // 兜底：unit/number 缺失时按重置时间排序，最近的视为 5 小时窗口
    let mut fallback: Vec<&Value> = token_limits
        .iter()
        .copied()
        .filter(|l| Some(*l) != five_hour && Some(*l) != weekly)
        .collect();
    fallback.sort_by_key(|l| num(l.get("nextResetTime")) as i64);
    let mut fallback_iter = fallback.into_iter();
    let five_hour = five_hour.or_else(|| fallback_iter.next());
    let weekly = weekly.or_else(|| fallback_iter.next());

    let now_utc = chrono::Utc::now();
    for (limit, label, span) in [
        (five_hour, "5h Window", 5 * 3600i64),
        (weekly, "7d Window", 7 * 86400),
    ] {
        let limit = match limit {
            Some(l) => l,
            None => continue,
        };
        let pct = match limit_percent(limit) {
            Some(pct) => pct,
            None => continue,
        };
        let mut window = serde_json::json!({
            "label": label,
            "used_percent": pct,
            "reset_after_seconds": seconds_until(limit.get("nextResetTime"), now_utc),
            "window_seconds": span,
        });
        let total = num(limit.get("usage"));
        if total > 0.0 {
            // 积分窗口带绝对值：进度条显示已用/总量，附行显示剩余
            window["usage"] = serde_json::json!(format!(
                "{}/{}",
                num(limit.get("currentValue")) as i64,
                total as i64
            ));
            extra_lines.push(format!(
                "{label} remaining: {}/{}",
                num(limit.get("remaining")) as i64,
                total as i64
            ));
        }
        windows.push(window);
    }

    for l in &limits {
        if l.get("type").and_then(|v| v.as_str()) != Some("TIME_LIMIT") {
            continue;
        }
        let total = num(l.get("usage"));
        let used = num(l.get("currentValue"));
        let pct = match limit_percent(l) {
            Some(pct) => Some(pct),
            None if total > 0.0 => Some((used * 100.0 / total).clamp(0.0, 100.0)),
            None => None,
        };
        let pct = match pct {
            Some(pct) => pct,
            None => continue,
        };
        let reset_at = parse_timestamp(l.get("nextResetTime"));
        let mut window = serde_json::json!({
            "label": "Tools Quota",
            "used_percent": pct,
            "reset_after_seconds": seconds_until(l.get("nextResetTime"), now_utc),
            // 月窗口：有重置时间时按一个自然月估算窗口起点（供 | 时间标记定位）
            "window_seconds": reset_at.map(monthly_window_seconds),
        });
        if total > 0.0 {
            window["usage"] = serde_json::json!(format!("{}/{}", used as i64, total as i64));
        }
        extra_lines.push(format!(
            "Tools remaining: {}/{}",
            num(l.get("remaining")) as i64,
            total as i64
        ));
        windows.push(window);
    }

    serde_json::json!({
        "provider": "GLM",
        "plan": level,
        "windows": windows,
        "extra_lines": extra_lines,
        "fetched_at": fetched_now(),
    })
}

fn glm_subscription_end(item: &Value) -> Option<DateTime<Local>> {
    // valid 形如 "2026-12-03 10:00:00-2027-03-03 10:00:00"，起点即下次续费时刻
    if let Some(valid) = item.get("valid").and_then(|v| v.as_str()) {
        if valid.len() >= 19 {
            if let Ok(naive) = NaiveDateTime::parse_from_str(&valid[..19], "%Y-%m-%d %H:%M:%S") {
                return Local
                    .from_local_datetime(&naive)
                    .single()
                    .or_else(|| Local.from_local_datetime(&naive).earliest());
            }
        }
    }
    if let Some(renew) = item.get("nextRenewTime").and_then(|v| v.as_str()) {
        let renew = renew.trim();
        if !renew.is_empty() {
            // nextRenewTime 可能只有日期（"2026-12-03"），按本机时区零点计
            let text = if renew.contains(':') { renew.to_string() } else { format!("{renew} 00:00:00") };
            return parse_local_datetime(&text);
        }
    }
    None
}

pub fn normalize_glm_subscription(result: &Value, now: DateTime<Local>) -> Option<Value> {
    let data = result.get("data").and_then(|v| v.as_array())?;
    let mut candidates: Vec<(&Value, DateTime<Local>)> = Vec::new();
    for item in data {
        if let Some(end) = glm_subscription_end(item) {
            candidates.push((item, end));
        }
    }
    if candidates.is_empty() {
        return None;
    }
    let current: Vec<_> = candidates
        .iter()
        .filter(|(item, _)| {
            item.get("inCurrentPeriod").and_then(|v| v.as_bool()).unwrap_or(false)
                && item
                    .get("status")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_uppercase()
                    == "VALID"
        })
        .collect();
    let (item, ends_at) = match current.first() {
        Some((item, ends_at)) => (*item, *ends_at),
        None => (candidates[0].0, candidates[0].1),
    };
    let purchased_at = parse_local_datetime(
        item.get("purchaseTime").and_then(|v| v.as_str()).unwrap_or(""),
    )
    .or_else(|| {
        parse_local_datetime(
            item.get("currentRenewTime").and_then(|v| v.as_str()).unwrap_or(""),
        )
    });
    let billing_cycle = item
        .get("billingCycle")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let duration_months = GLM_BILLING_CYCLE_MONTHS
        .iter()
        .find(|(name, _)| *name == billing_cycle)
        .map(|(_, months)| months);
    let purchased = purchased_at.unwrap_or(ends_at);
    Some(serde_json::json!({
        "purchased_at": iso_seconds(purchased),
        "ends_at": iso_seconds(ends_at),
        "end_after_seconds": (ends_at - now).num_seconds(),
        "duration_months": duration_months,
        // 自动续费的套餐显示 renews 而非 ends，避免误读为到期停用
        "auto_renew": item.get("autoRenew").and_then(|v| v.as_bool()).unwrap_or(false),
    }))
}

fn glm_subscription_url() -> String {
    let quota_url = env_value("GLM_QUOTA_URL").unwrap_or_else(|| GLM_QUOTA_URL.into());
    let base = quota_url.split("/api/").next().unwrap_or("").trim_end_matches('/').to_string();
    format!("{base}{GLM_SUBSCRIPTION_PATH}")
}

/// 配额失败即跳过订阅查询；成功时附加订阅 membership。
pub fn collect() -> Result<Value, String> {
    let key = api_key()?;
    let use_proxy = env_enabled("GLM_USE_PROXY", true);
    let timeout = env_timeout("GLM_TIMEOUT", 30);
    let quota_url = env_value("GLM_QUOTA_URL").unwrap_or_else(|| GLM_QUOTA_URL.into());
    let result = get_json(&quota_url, &key, use_proxy, timeout)?;
    let limits_ok = result.get("success").and_then(|v| v.as_bool()).unwrap_or(false)
        && result.get("data").map(|d| d.get("limits").map(|l| l.is_array()).unwrap_or(false)).unwrap_or(false);
    if !limits_ok {
        let error = result
            .get("msg")
            .or_else(|| result.get("message"))
            .and_then(|v| v.as_str())
            .unwrap_or("unexpected response");
        return Err(format!("GLM quota query failed: {error}"));
    }
    let mut account = normalize_glm(&result);
    let subscription_url = env_value("GLM_SUBSCRIPTION_URL").unwrap_or_else(glm_subscription_url);
    if let Ok(subscription) = get_json(&subscription_url, &key, use_proxy, timeout) {
        if let Some(membership) = normalize_glm_subscription(&subscription, Local::now()) {
            account["membership"] = membership;
        }
    }
    Ok(account)
}
