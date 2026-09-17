//! DeepSeek 与 GLM 配额引擎（v0.6.1 起原生实现，口径与 usage_monitor.py 的
//! normalize_deepseek / normalize_glm / normalize_glm_subscription 一致）。
//!
//! 依赖：ureq（rustls）+ chrono。代理语义与 Python 版相同：GLM/DeepSeek 默认
//! 走系统代理（HTTP(S)_PROXY / ALL_PROXY），可用对应 *_USE_PROXY=0 关闭；
//! 重试策略与 request_json 一致（GET 重试 3 次，退避 1s/2s）。

use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDateTime, TimeZone, Utc};

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const DEEPSEEK_MONTHLY_LIMIT: f64 = 50.0;
const GLM_QUOTA_URL: &str = "https://open.bigmodel.cn/api/monitor/usage/quota/limit";
const GLM_SUBSCRIPTION_PATH: &str = "/api/biz/subscription/list";
const GLM_BILLING_CYCLE_MONTHS: &[(&str, i64)] = &[
    ("monthly", 1),
    ("quarterly", 3),
    ("semi-annually", 6),
    ("yearly", 12),
];

fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn env_enabled(name: &str, default: bool) -> bool {
    match env_value(name) {
        Some(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        None => default,
    }
}

fn env_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn num(value: Option<&serde_json::Value>) -> f64 {
    match value {
        Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn env_timeout(name: &str, default: u64) -> u64 {
    env_value(name).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn build_agent(use_proxy: bool, timeout_secs: u64) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(timeout_secs));
    if use_proxy {
        // 与 urllib 的环境代理语义对齐（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）
        let raw = env_value("HTTPS_PROXY")
            .or_else(|| env_value("https_proxy"))
            .or_else(|| env_value("HTTP_PROXY"))
            .or_else(|| env_value("http_proxy"))
            .or_else(|| env_value("ALL_PROXY"))
            .or_else(|| env_value("all_proxy"));
        if let Some(raw) = raw {
            if let Ok(proxy) = ureq::Proxy::new(&raw) {
                builder = builder.proxy(proxy);
            }
        }
    }
    builder.build()
}

/// request_json 的 GET 版本：GET 重试 3 次（退避 1s/2s），HTTP 错误不重试。
fn request_json(url: &str, bearer: &str, use_proxy: bool, timeout_secs: u64) -> Result<serde_json::Value, String> {
    let agent = build_agent(use_proxy, timeout_secs);
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let result = agent
            .get(url)
            .set("Authorization", &format!("Bearer {bearer}"))
            .set("Accept", "application/json")
            .call();
        match result {
            Ok(response) => {
                let value: serde_json::Value = response
                    .into_json()
                    .map_err(|err| format!("Invalid API response: {err}"))?;
                return Ok(value);
            }
            Err(ureq::Error::Status(code, response)) => {
                let reason = response
                    .header("http_status_message")
                    .unwrap_or("error")
                    .to_string();
                return Err(format!("HTTP {code}: {reason}"));
            }
            Err(err) => {
                last_error = format!("Network request failed: {err}");
                if attempt < 3 {
                    std::thread::sleep(Duration::from_secs(attempt as u64));
                }
            }
        }
    }
    Err(last_error)
}

pub struct DeepSeekKey(pub String);

pub fn deepseek_api_key() -> Result<DeepSeekKey, String> {
    if let Some(key) = env_value("DEEPSEEK_API_KEY") {
        return Ok(DeepSeekKey(key));
    }
    let path = env_value("DEEPSEEK_CREDENTIALS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| env_home().join(".deepseek").join("credentials.json"));
    if path.is_file() {
        let text = std::fs::read_to_string(&path)
            .map_err(|err| format!("Cannot read DeepSeek credentials file {}: {err}", path.display()))?;
        let data: serde_json::Value =
            serde_json::from_str(&text).map_err(|err| format!("Cannot read DeepSeek credentials file {}: {err}", path.display()))?;
        if let Some(key) = data
            .get("api_key")
            .or_else(|| data.get("DEEPSEEK_API_KEY"))
            .and_then(|v| v.as_str())
        {
            return Ok(DeepSeekKey(key.to_string()));
        }
        return Err(format!(
            "DeepSeek credentials file {} is missing api_key",
            path.display()
        ));
    }
    Err("DEEPSEEK_API_KEY not set; export it, write it to ~/.deepseek/credentials.json, or pass --deepseek-key".into())
}

pub struct GlmKey(pub String);

pub fn glm_api_key() -> Result<GlmKey, String> {
    for name in ["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"] {
        if let Some(key) = env_value(name) {
            return Ok(GlmKey(key));
        }
    }
    let path = env_value("GLM_CREDENTIALS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| env_home().join(".glm").join("credentials.json"));
    if path.is_file() {
        let text = std::fs::read_to_string(&path)
            .map_err(|err| format!("Cannot read GLM credentials file {}: {err}", path.display()))?;
        let data: serde_json::Value =
            serde_json::from_str(&text).map_err(|err| format!("Cannot read GLM credentials file {}: {err}", path.display()))?;
        for field in ["api_key", "GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"] {
            if let Some(key) = data.get(field).and_then(|v| v.as_str()) {
                return Ok(GlmKey(key.to_string()));
            }
        }
        return Err(format!("GLM credentials file {} is missing api_key", path.display()));
    }
    Err("GLM_API_KEY not set; export it, write it to ~/.glm/credentials.json, or pass --glm-key".into())
}

fn fetched_now() -> String {
    Local::now().format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

fn iso_seconds(moment: DateTime<Local>) -> String {
    moment.format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

/// naive 时间按本机时区解释（与 Python _parse_local_datetime 一致）
fn parse_local_datetime(text: &str) -> Option<DateTime<Local>> {
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

pub fn normalize_deepseek(data: &serde_json::Value) -> serde_json::Value {
    let infos = data.get("balance_infos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let report = data.get("data").filter(|v| v.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}));
    let (total, granted, topped_up) = if !infos.is_empty() {
        let balance = infos
            .iter()
            .find(|b| b.get("currency").and_then(|v| v.as_str()).unwrap_or("").to_uppercase() == "CNY")
            .cloned()
            .unwrap_or_else(|| infos[0].clone());
        (
            num(balance.get("total_balance")),
            num(balance.get("granted_balance")),
            num(balance.get("topped_up_balance")),
        )
    } else {
        (
            num(report.get("balance")),
            num(report.get("giveAmount")),
            num(report.get("rechargeAmount")),
        )
    };
    // 进度条口径与其它模型一致：余额转使用量（50 - 余额），低于 0 截断
    let usage = (DEEPSEEK_MONTHLY_LIMIT - total).max(0.0);
    let capped = usage.min(DEEPSEEK_MONTHLY_LIMIT);
    let fill_percent = capped * 100.0 / DEEPSEEK_MONTHLY_LIMIT;
    let mut extra_lines = vec![
        format!("Balance: ¥{total:.2} / ¥{DEEPSEEK_MONTHLY_LIMIT:.2}"),
        format!("Usage: ¥{usage:.2} / ¥{DEEPSEEK_MONTHLY_LIMIT:.2}"),
        format!("Granted: ¥{granted:.2}   Topped-up: ¥{topped_up:.2}"),
    ];
    if report.is_object() && !report.as_object().unwrap().is_empty() {
        let available = num(report.get("availableBalance").or(Some(&serde_json::json!(total))));
        let frozen = num(report.get("frozenBalance"));
        let spent = num(report.get("totalSpendAmount"));
        extra_lines.push(format!(
            "Available: ¥{available:.2}   Frozen: ¥{frozen:.2}   Total spent: ¥{spent:.2}"
        ));
    }
    if !data.get("is_available").and_then(|v| v.as_bool()).unwrap_or(true) {
        extra_lines.push("Account unavailable".to_string());
    }
    serde_json::json!({
        "provider": "DeepSeek",
        "plan": "API",
        "windows": [{
            "label": "Monthly Usage",
            "used_percent": fill_percent,
            "reset_after_seconds": serde_json::Value::Null,
            "window_seconds": serde_json::Value::Null,
            "usage": format!("¥{capped:.2}"),
            "until_used_up": true,
        }],
        "extra_lines": extra_lines,
        "fetched_at": fetched_now(),
    })
}

fn limit_percent(limit: &serde_json::Value) -> Option<f64> {
    match limit.get("percentage").and_then(|v| v.as_f64()) {
        Some(pct) => Some(pct.clamp(0.0, 100.0)),
        None => limit
            .get("percentage")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse::<f64>().ok())
            .map(|pct| pct.clamp(0.0, 100.0)),
    }
}

fn seconds_until(value: Option<&serde_json::Value>, now: DateTime<Utc>) -> Option<i64> {
    let value = match value {
        Some(v) if !v.is_null() => v,
        _ => return None,
    };
    match value {
        serde_json::Value::Number(n) => {
            let numeric = n.as_f64()?;
            let numeric = if numeric > 10_000_000_000.0 { numeric / 1000.0 } else { numeric };
            Some((numeric as i64 - now.timestamp()).max(0))
        }
        serde_json::Value::String(text) => {
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

fn parse_timestamp(value: Option<&serde_json::Value>) -> Option<DateTime<Utc>> {
    let value = match value {
        Some(v) if !v.is_null() => v,
        _ => return None,
    };
    match value {
        serde_json::Value::Number(n) => {
            let mut numeric = n.as_f64()?;
            if numeric > 10_000_000_000.0 {
                numeric /= 1000.0;
            }
            Utc.timestamp_opt(numeric as i64, 0).single()
        }
        serde_json::Value::String(text) => {
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

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    let first_next = Utc
        .with_ymd_and_hms(next_year, next_month, 1, 0, 0, 0)
        .single()
        .expect("valid first-of-month");
    (first_next - ChronoDuration::days(1)).day()
}

fn monthly_window_seconds(reset_at: DateTime<Utc>) -> i64 {
    (reset_at - one_month_before(reset_at)).num_seconds()
}

fn glm_normalize_level(payload: &serde_json::Value) -> String {
    let level = payload
        .get("level")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if level.is_empty() {
        return "Coding".into();
    }
    let mut chars = level.chars();
    match chars.next() {
        Some(first) => format!("Coding {}{}", first.to_uppercase(), chars.as_str()),
        None => "Coding".into(),
    }
}

pub fn normalize_glm(data: &serde_json::Value) -> serde_json::Value {
    let payload = data.get("data").filter(|v| v.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}));
    let limits = payload.get("limits").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let level = glm_normalize_level(&payload);
    let mut windows: Vec<serde_json::Value> = Vec::new();
    let mut extra_lines: Vec<String> = Vec::new();

    let token_limits: Vec<&serde_json::Value> = limits
        .iter()
        .filter(|l| {
            matches!(
                l.get("type").and_then(|v| v.as_str()),
                Some("CREDIT_LIMIT") | Some("TOKENS_LIMIT")
            )
        })
        .collect();

    let pick = |unit: i64, number: i64| -> Option<&serde_json::Value> {
        token_limits.iter().copied().find(|l| {
            l.get("unit").and_then(|v| v.as_i64()) == Some(unit)
                && l.get("number").and_then(|v| v.as_i64()) == Some(number)
        })
    };
    let five_hour = pick(3, 5);
    let weekly = pick(6, 1);
    // 兜底：unit/number 缺失时按重置时间排序，最近的视为 5 小时窗口
    let mut fallback: Vec<&serde_json::Value> = token_limits
        .iter()
        .copied()
        .filter(|l| Some(*l) != five_hour && Some(*l) != weekly)
        .collect();
    fallback.sort_by_key(|l| num(l.get("nextResetTime")) as i64);
    let mut fallback_iter = fallback.into_iter();
    let five_hour = match five_hour {
        Some(l) => Some(l),
        None => fallback_iter.next(),
    };
    let weekly = match weekly {
        Some(l) => Some(l),
        None => fallback_iter.next(),
    };

    let now_utc = Utc::now();
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

fn glm_subscription_end(item: &serde_json::Value) -> Option<DateTime<Local>> {
    // valid 形如 "2026-12-03 10:00:00-2027-03-03 10:00:00"，起点即下次续费时刻
    if let Some(valid) = item.get("valid").and_then(|v| v.as_str()) {
        // valid 形如 "2026-12-03 10:00:00-2027-03-03 10:00:00"，取前 19 位起点
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

pub fn normalize_glm_subscription(result: &serde_json::Value, now: DateTime<Local>) -> Option<serde_json::Value> {
    let data = result.get("data").and_then(|v| v.as_array())?;
    let mut candidates: Vec<(&serde_json::Value, DateTime<Local>)> = Vec::new();
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
        &item.get("purchaseTime").and_then(|v| v.as_str()).unwrap_or(""),
    )
    .or_else(|| {
        parse_local_datetime(
            &item
                .get("currentRenewTime")
                .and_then(|v| v.as_str())
                .unwrap_or(""),
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

/// 原生采集 DeepSeek 与 GLM 两家的账户卡片；单家失败以 errors 形式返回
///（与 python _collect_provider 的契约一致），不阻塞另一家。
pub fn collect_native() -> (Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let mut accounts = Vec::new();
    let mut errors = Vec::new();

    // DeepSeek
    match deepseek_api_key() {
        Ok(key) => match request_json(
            &env_value("DEEPSEEK_BALANCE_URL").unwrap_or_else(|| DEEPSEEK_BALANCE_URL.into()),
            &key.0,
            env_enabled("DEEPSEEK_USE_PROXY", true),
            env_timeout("DEEPSEEK_TIMEOUT", 30),
        ) {
            Ok(data) => accounts.push(normalize_deepseek(&data)),
            Err(err) => errors.push(serde_json::json!({ "provider": "DeepSeek", "error": err })),
        },
        Err(err) => errors.push(serde_json::json!({ "provider": "DeepSeek", "error": err })),
    }

    // GLM（配额失败即跳过订阅查询；成功时附加订阅 membership）
    match glm_api_key() {
        Ok(key) => {
            let use_proxy = env_enabled("GLM_USE_PROXY", true);
            let timeout = env_timeout("GLM_TIMEOUT", 30);
            match request_json(
                &env_value("GLM_QUOTA_URL").unwrap_or_else(|| GLM_QUOTA_URL.into()),
                &key.0,
                use_proxy,
                timeout,
            ) {
                Ok(result) => {
                    let limits_ok = result.get("success").and_then(|v| v.as_bool()).unwrap_or(false)
                        && result.get("data").map(|d| d.get("limits").map(|l| l.is_array()).unwrap_or(false)).unwrap_or(false);
                    if !limits_ok {
                        let error = result
                            .get("msg")
                            .or_else(|| result.get("message"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("unexpected response");
                        errors.push(serde_json::json!({ "provider": "GLM", "error": format!("GLM quota query failed: {error}") }));
                    } else {
                        let mut account = normalize_glm(&result);
                        if let Ok(subscription) = request_json(
                            &env_value("GLM_SUBSCRIPTION_URL").unwrap_or_else(glm_subscription_url),
                            &key.0,
                            use_proxy,
                            timeout,
                        ) {
                            if let Some(membership) =
                                normalize_glm_subscription(&subscription, Local::now())
                            {
                                account["membership"] = membership;
                            }
                        }
                        accounts.push(account);
                    }
                }
                Err(err) => errors.push(serde_json::json!({ "provider": "GLM", "error": err })),
            }
        }
        Err(err) => errors.push(serde_json::json!({ "provider": "GLM", "error": err })),
    }

    (accounts, errors)
}
