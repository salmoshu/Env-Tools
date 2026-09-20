//! DeepSeek 与 GLM 配额引擎（v0.6.1 起原生实现，口径与 usage_monitor.py 的
//! normalize_deepseek / normalize_glm / normalize_glm_subscription 一致）。
//!
//! 依赖：ureq（rustls）+ chrono。代理语义与 Python 版相同：GLM/DeepSeek 默认
//! 走系统代理（HTTP(S)_PROXY / ALL_PROXY），可用对应 *_USE_PROXY=0 关闭；
//! 重试策略与 request_json 一致（GET 重试 3 次，退避 1s/2s）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Datelike, Duration as ChronoDuration, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;

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

/// 构建 HTTP agent（代理语义与 Python 版一致）；settings.rs 的版本探测也复用。
pub fn build_agent(use_proxy: bool, timeout_secs: u64) -> ureq::Agent {
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
            .or_else(|| env_value("all_proxy"))
            // 环境变量缺失时（GUI 启动常如此）回退 Windows 系统代理：
            // Codex/GLM 等经代理访问的接口与浏览器行为保持一致
            .or_else(system_proxy);
        if let Some(raw) = raw {
            if let Ok(proxy) = ureq::Proxy::new(&raw) {
                builder = builder.proxy(proxy);
            }
        }
    }
    builder.build()
}

/// 读 Windows 系统代理（IE/WinINET 设置）：注册表 ProxyEnable + ProxyServer。
/// 非 Windows 或读取失败返回 None。
fn system_proxy() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let output = std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v", "ProxyEnable",
        ])
        .output()
        .ok()?;
    if !String::from_utf8_lossy(&output.stdout).contains("0x1") {
        return None;
    }
    let output = std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v", "ProxyServer",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // 形如 "    ProxyServer    REG_SZ    127.0.0.1:7890"
    let server = text
        .lines()
        .find(|line| line.contains("ProxyServer"))
        .and_then(|line| line.split_whitespace().last())
        .filter(|value| value.contains(':') || value.contains('.'))?
        .to_string();
    // "http=...;https=..." 分段形式取 https 段；裸 host:port 补 scheme
    if let Some(https_part) = server.split(';').find(|part| part.starts_with("https=")) {
        return Some(format!("https://{}", &https_part[6..]));
    }
    if server.contains('=') {
        return None;
    }
    if server.starts_with("http") {
        Some(server)
    } else {
        Some(format!("http://{server}"))
    }
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

// --- Kimi / Codex 原生采集（v0.7.0 起，口径与 usage_monitor.py 一致） ---------

const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_OAUTH_URL: &str = "https://auth.kimi.com/api/oauth/token";
const KIMI_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";
const KIMI_WEB_REFRESH_URL: &str =
    "https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken";
const KIMI_WEB_STATS_URL: &str =
    "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats";
const KIMI_WEB_SUBSCRIPTION_URL: &str =
    "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// 与 Python TOKEN_REFRESH_THRESHOLD 一致：剩余寿命低于 5 分钟即刷新
const TOKEN_REFRESH_THRESHOLD: i64 = 300;

/// percent() 的 Rust 版：used > remaining/limit > used*100/limit，截断到 0..100。
fn percent(used: Option<&Value>, remaining: Option<&Value>, limit: Option<&Value>, used_amount: Option<&Value>) -> f64 {
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

fn num_opt(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn num_of(value: Option<&Value>) -> f64 {
    value.and_then(num_opt).unwrap_or(0.0)
}

/// POST 版请求（Python request_json 的 data 分支：不重试）。
#[allow(clippy::too_many_arguments)]
fn request_json_post(
    url: &str,
    headers: &[(&str, &str)],
    body: &str,
    use_proxy: bool,
    timeout_secs: u64,
) -> Result<Value, String> {
    let agent = build_agent(use_proxy, timeout_secs);
    let mut request = agent.post(url);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    match request.send_string(body) {
        Ok(response) => response
            .into_json()
            .map_err(|err| format!("Invalid API response: {err}")),
        Err(ureq::Error::Status(code, response)) => {
            let reason = response.header("http_status_message").unwrap_or("error").to_string();
            Err(format!("HTTP {code}: {reason}"))
        }
        Err(err) => Err(format!("Network request failed: {err}")),
    }
}

/// 凭证家目录（v0.7.1 起仅本机侧：配额不再跨 WSL 读取，避免 9P 慢与串源）。
/// 分析数据仍可跨源汇总（见 /api/analytics 的 aggregate 参数）。
fn credential_homes() -> Vec<(PathBuf, &'static str)> {
    vec![(env_home(), "windows")]
}

fn find_file_across_homes(
    homes: &[(PathBuf, &'static str)],
    relatives: &[&str],
    env_name: &str,
) -> Option<(PathBuf, &'static str)> {
    if let Some(explicit) = crate::settings::env_value(env_name) {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some((path, "windows"));
        }
    }
    for (home, label) in homes {
        for relative in relatives {
            let path = home.join(relative);
            if path.is_file() {
                return Some((path, label));
            }
        }
    }
    None
}

fn kimi_code_credential(homes: &[(PathBuf, &'static str)]) -> Option<(PathBuf, &'static str)> {
    if let Some(home) = crate::settings::env_value("KIMI_CODE_HOME") {
        let explicit = PathBuf::from(home).join("credentials/kimi-code.json");
        if explicit.is_file() {
            return Some((explicit, "windows"));
        }
    }
    find_file_across_homes(
        homes,
        &[".kimi-code/credentials/kimi-code.json", ".kimi/credentials/kimi-code.json"],
        "KIMI_CREDENTIALS_PATH",
    )
}

fn kimi_web_credential(homes: &[(PathBuf, &'static str)]) -> Option<(PathBuf, &'static str)> {
    find_file_across_homes(homes, &[".kimi-code/credentials/kimi-web.json"], "KIMI_WEB_CREDENTIALS_PATH")
}

fn codex_credential(homes: &[(PathBuf, &'static str)]) -> Option<(PathBuf, &'static str)> {
    let mut homes = homes.to_vec();
    if let Some(home) = crate::settings::env_value("CODEX_HOME") {
        homes.insert(0, (PathBuf::from(home), "windows"));
    }
    find_file_across_homes(&homes, &[".codex/auth.json"], "CODEX_AUTH_PATH")
}

fn write_credentials(path: &Path, value: &Value) {
    if let Err(err) = crate::settings::write_private_json(path, value) {
        eprintln!("[quota] cannot persist credentials {}: {err}", path.display());
    }
}

/// 不验签读取 JWT 的 exp（秒）。
fn jwt_expires_at(token: &str) -> i64 {
    let segment = token.split('.').nth(1).unwrap_or("");
    let padded = segment.trim_end_matches('=');
    let decoded = base64url_decode(padded);
    decoded
        .and_then(|bytes| serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)).ok())
        .and_then(|data| data.get("exp").and_then(|v| v.as_f64()))
        .map(|exp| exp as i64)
        .unwrap_or(0)
}

fn base64url_decode(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut output = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0u32;
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE.iter().position(|c| *c == byte)? as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push(((buffer >> bits) & 0xFF) as u8);
        }
    }
    Some(output)
}

fn refresh_kimi_credentials(path: &Path, credentials: &Value, use_proxy: bool, timeout: u64) -> Result<Value, String> {
    let refresh_token = credentials
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or("Kimi credentials expired and refresh_token is missing; run kimi and log in again")?;
    let body = form_urlencoded(&[
        ("client_id", KIMI_CLIENT_ID),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ]);
    let result = request_json_post(
        KIMI_OAUTH_URL,
        &[("Content-Type", "application/x-www-form-urlencoded")],
        &body,
        use_proxy,
        timeout,
    )?;
    let mut updated = credentials.clone();
    let access = result
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or("Kimi token refresh response missing access_token")?;
    updated["access_token"] = Value::String(access.to_string());
    updated["refresh_token"] = Value::String(
        result.get("refresh_token").and_then(|v| v.as_str()).unwrap_or(refresh_token).to_string(),
    );
    updated["expires_at"] = Value::from(
        chrono::Utc::now().timestamp()
            + result.get("expires_in").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64,
    );
    write_credentials(path, &updated);
    Ok(updated)
}

fn form_urlencoded(pairs: &[(&str, &str)]) -> String {
    let mut encoded = String::new();
    for (key, value) in pairs {
        if !encoded.is_empty() {
            encoded.push('&');
        }
        encoded.push_str(&urlencode_component(key));
        encoded.push('=');
        encoded.push_str(&urlencode_component(value));
    }
    encoded
}

fn urlencode_component(text: &str) -> String {
    let mut output = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn fetch_kimi_account(homes: &[(PathBuf, &'static str)], errors: &mut Vec<Value>) -> Option<Value> {
    let (path, _) = kimi_code_credential(homes)?;
    let use_proxy = crate::settings::env_enabled("KIMI_USE_PROXY", false);
    let timeout = crate::settings::env_value("KIMI_TIMEOUT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let credentials = match read_json_file(&path) {
        Ok(value) => value,
        Err(err) => {
            errors.push(serde_json::json!({ "provider": "Kimi Code", "error": err }));
            return None;
        }
    };
    let now_secs = chrono::Utc::now().timestamp() as f64;
    let expires_at = credentials.get("expires_at").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let fresh = if expires_at - now_secs < TOKEN_REFRESH_THRESHOLD as f64 {
        match refresh_kimi_credentials(&path, &credentials, use_proxy, timeout) {
            Ok(value) => value,
            Err(err) => {
                errors.push(serde_json::json!({ "provider": "Kimi Code", "error": err }));
                return None;
            }
        }
    } else {
        credentials
    };
    let access_token = fresh.get("access_token").and_then(|v| v.as_str()).unwrap_or("");
    if access_token.is_empty() {
        errors.push(serde_json::json!({ "provider": "Kimi Code",
            "error": "access_token missing in Kimi credentials; run kimi and log in again" }));
        return None;
    }
    match request_json(
        &crate::settings::env_value("KIMI_USAGE_URL").unwrap_or_else(|| KIMI_USAGE_URL.into()),
        access_token,
        use_proxy,
        timeout,
    ) {
        Ok(data) => Some(normalize_kimi(&data)),
        Err(err) => {
            errors.push(serde_json::json!({ "provider": "Kimi Code", "error": err }));
            None
        }
    }
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    crate::settings::read_json(path)
}

fn normalize_window(label: &str, data: &Value, default_seconds: Option<i64>) -> Value {
    let mut reset_after = data
        .get("reset_after_seconds")
        .and_then(num_opt);
    if reset_after.is_none() {
        reset_after = seconds_until(
            data.get("reset_at").or_else(|| data.get("resetTime")),
            chrono::Utc::now(),
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

fn normalize_kimi(data: &Value) -> Value {
    let mut windows: Vec<Value> = Vec::new();
    for item in data.get("limits").and_then(|v| v.as_array()).into_iter().flatten() {
        let meta = item.get("window").cloned().unwrap_or_else(|| serde_json::json!({}));
        let detail = item.get("detail").cloned().unwrap_or_else(|| serde_json::json!({}));
        let duration = num_of(meta.get("duration")) as i64;
        let unit = meta.get("timeUnit").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let seconds = if unit.contains("hour") { duration * 3600 } else { duration * 60 };
        let label = if unit.contains("hour") {
            format!("{duration}h Window")
        } else {
            format!("{duration}m Window")
        };
        let label = if duration == 300 && unit.contains("minute") {
            "5h Window".to_string()
        } else {
            label
        };
        windows.push(normalize_window(&label, &detail, if seconds > 0 { Some(seconds) } else { None }));
    }
    windows.push(normalize_window("7d Window", data.get("usage").unwrap_or(&Value::Null), Some(7 * 86400)));
    let membership = data
        .pointer("/user/membership")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let plan = membership
        .get("level")
        .and_then(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .or_else(|| data.get("subType").and_then(|v| v.as_str()).filter(|v| !v.is_empty()))
        .unwrap_or("unknown");
    serde_json::json!({
        "provider": "Kimi Code",
        "plan": plan,
        "windows": windows,
        "fetched_at": fetched_now(),
    })
}

fn ratio_percent(value: Option<&Value>) -> Option<f64> {
    let numeric = value.and_then(num_opt)?;
    if !(0.0..=100.0).contains(&numeric) {
        return None;
    }
    let numeric = if numeric <= 1.0 { numeric * 100.0 } else { numeric };
    Some(numeric.clamp(0.0, 100.0))
}

fn normalize_kimi_monthly(stats: &Value) -> Option<(Value, Vec<String>)> {
    let balance = stats
        .get("subscription_balance")
        .or_else(|| stats.get("subscriptionBalance"))?
        .clone();
    if balance.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return None;
    }
    let used_percent = ratio_percent(
        balance.get("amount_used_ratio").or_else(|| balance.get("amountUsedRatio")),
    )?;
    let mut extra_lines = Vec::new();
    if let Some(code_percent) = ratio_percent(
        balance.get("kimi_code_used_ratio").or_else(|| balance.get("kimiCodeUsedRatio")),
    ) {
        extra_lines.push(format!("Kimi Code share: {code_percent:.2}%"));
    }
    let expire_key = balance.get("expire_time").or_else(|| balance.get("expireTime"));
    let window = serde_json::json!({
        "label": "Monthly Total",
        "used_percent": used_percent,
        "reset_after_seconds": seconds_until(expire_key, chrono::Utc::now()),
        "window_seconds": parse_timestamp(expire_key).map(monthly_window_seconds),
    });
    Some((window, extra_lines))
}

/// GetSubscription 响应 → plan（goods.title，如 Allegro）与 membership；无订阅返回 None。
fn normalize_kimi_subscription(data: &Value) -> Option<Value> {
    let subscription = data
        .get("subscription")
        .or_else(|| data.get("purchaseSubscription"))?
        .as_object()?;
    if subscription.is_empty() {
        return None;
    }
    let goods = subscription.get("goods").cloned().unwrap_or_else(|| serde_json::json!({}));
    let mut result = serde_json::json!({});
    let plan = goods.get("title").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if !plan.is_empty() {
        result["plan"] = Value::String(plan);
    }
    let ends_at = parse_timestamp(subscription.get("currentEndTime"))?;
    let now = chrono::Local::now();
    let purchased_at = parse_timestamp(
        subscription.get("currentStartTime").or_else(|| subscription.get("subscriptionTime")),
    )
    .unwrap_or(ends_at);
    let mut membership = serde_json::json!({
        "purchased_at": iso_seconds(purchased_at.with_timezone(&Local)),
        "ends_at": iso_seconds(ends_at.with_timezone(&Local)),
        "end_after_seconds": (ends_at - now.with_timezone(&Utc)).num_seconds(),
    });
    let cycle = goods.get("billingCycle").cloned().unwrap_or_else(|| serde_json::json!({}));
    let cycle_count = num_of(cycle.get("duration")) as i64;
    let cycle_unit = cycle.get("timeUnit").and_then(|v| v.as_str()).unwrap_or("").to_uppercase();
    let cycle_months = if cycle_unit.contains("YEAR") { cycle_count * 12 } else { cycle_count };
    if cycle_unit.contains("MONTH") || cycle_unit.contains("YEAR") {
        if cycle_months > 0 {
            membership["duration_months"] = Value::from(cycle_months);
        }
    }
    let active = subscription.get("active").and_then(|v| v.as_bool()).unwrap_or(true);
    if subscription.get("nextBillingTime").map(|v| !v.is_null()).unwrap_or(false) && active {
        membership["auto_renew"] = Value::Bool(true);
    }
    result["membership"] = membership;
    Some(result)
}

/// 会员到期手动配置（config.json 小节）→ membership；手动配置优先于订阅。
fn attach_manual_membership(account: &mut Value, provider: &str) -> bool {
    let Some(section) = crate::settings::membership_section(provider) else {
        return false;
    };
    if let Some(error) = section.get("error") {
        account["membership"] = serde_json::json!({ "error": error });
        return true;
    }
    let purchased_text = section.get("membership_purchased_at").and_then(|v| v.as_str()).unwrap_or("");
    let purchased_at = chrono::DateTime::parse_from_rfc3339(purchased_text)
        .or_else(|_| {
            chrono::NaiveDateTime::parse_from_str(purchased_text, "%Y-%m-%dT%H:%M")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(purchased_text, "%Y-%m-%d %H:%M"))
                .map(|naive| {
                    Local
                        .from_local_datetime(&naive)
                        .single()
                        .unwrap_or_else(|| Local.from_local_datetime(&naive).earliest().unwrap())
                })
                .map(|dt| dt.fixed_offset())
        });
    let Ok(purchased_at) = purchased_at else {
        account["membership"] =
            serde_json::json!({ "error": format!("Invalid membership_purchased_at in config.json: {purchased_text}") });
        return true;
    };
    let months = section
        .get("membership_duration_months")
        .and_then(|v| v.as_i64())
        .unwrap_or(1)
        .max(1);
    let ends_at = add_calendar_months_utc(purchased_at.with_timezone(&Utc), months);
    account["membership"] = serde_json::json!({
        "purchased_at": iso_seconds(purchased_at.with_timezone(&Local)),
        "ends_at": iso_seconds(ends_at.with_timezone(&Local)),
        "end_after_seconds": (ends_at - Utc::now()).num_seconds(),
        "duration_months": months,
    });
    true
}

fn add_calendar_months_utc(moment: DateTime<Utc>, months: i64) -> DateTime<Utc> {
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

/// Kimi 卡片：CLI 凭证查窗口（仅本机侧）+ 网页凭证补月总量/会员名/会员到期。
/// 网页凭证（kimi-web.json）允许跨家目录发现（本机缺失时读 WSL 侧小文件，
/// 成本极低）——它承载 plan（如 Allegro）与订阅到期，配额窗口本身仍来自
/// 本机 CLI 凭证，不受跨源影响。
fn collect_kimi(homes: &[(PathBuf, &'static str)], errors: &mut Vec<Value>) -> Option<Value> {
    let mut account = fetch_kimi_account(homes, errors)?;
    let use_proxy = crate::settings::env_enabled("KIMI_USE_PROXY", false);
    let timeout = crate::settings::env_value("KIMI_TIMEOUT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let mut web_homes = homes.to_vec();
    for home in crate::settings::wsl_homes() {
        web_homes.push((home, "wsl"));
    }
    if let Some((web_path, _)) = kimi_web_credential(&web_homes) {
        if let Ok(credentials) = read_json_file(&web_path) {
            if let Some(token) = kimi_web_access_token(&web_path, &credentials, use_proxy, timeout, errors) {
                let stats = request_json_post(
                    &crate::settings::env_value("KIMI_WEB_STATS_URL").unwrap_or_else(|| KIMI_WEB_STATS_URL.into()),
                    &[
                        ("Authorization", token.as_str()),
                        ("Content-Type", "application/json"),
                        ("Accept", "application/json"),
                        ("x-msh-platform", "web"),
                    ],
                    "{}",
                    use_proxy,
                    timeout,
                );
                match stats {
                    Ok(payload) => {
                        if let Some((window, extra_lines)) = normalize_kimi_monthly(&payload) {
                            if let Some(list) = account["windows"].as_array_mut() {
                                list.push(window);
                            }
                            let existing = account
                                .get("extra_lines")
                                .and_then(|v| v.as_array())
                                .cloned()
                                .unwrap_or_default();
                            let mut lines = existing;
                            for line in extra_lines {
                                lines.push(Value::String(line));
                            }
                            account["extra_lines"] = Value::Array(lines);
                        }
                    }
                    Err(err) => {
                        errors.push(serde_json::json!({ "provider": "Kimi Monthly Total", "error": err }));
                    }
                }
                match request_json_post(
                    &crate::settings::env_value("KIMI_WEB_SUBSCRIPTION_URL")
                        .unwrap_or_else(|| KIMI_WEB_SUBSCRIPTION_URL.into()),
                    &[
                        ("Authorization", token.as_str()),
                        ("Content-Type", "application/json"),
                        ("Accept", "application/json"),
                        ("x-msh-platform", "web"),
                    ],
                    "{}",
                    use_proxy,
                    timeout,
                ) {
                    Ok(payload) => {
                        if let Some(subscription) = normalize_kimi_subscription(&payload) {
                            if let Some(plan) = subscription.get("plan").and_then(|v| v.as_str()) {
                                account["plan"] = Value::String(plan.to_string());
                            }
                            if !attach_manual_membership(&mut account, "kimi") {
                                if let Some(membership) = subscription.get("membership") {
                                    account["membership"] = membership.clone();
                                }
                            }
                        }
                    }
                    // 订阅属增强项：失败保持 plan=unknown 不额外报错（口径同 Python）
                    Err(_) => {}
                }
            }
        }
    }
    Some(account)
}

fn kimi_web_access_token(
    path: &Path,
    credentials: &Value,
    use_proxy: bool,
    timeout: u64,
    errors: &mut Vec<Value>,
) -> Option<String> {
    let mut credentials = credentials.clone();
    let mut access_token = credentials.get("access_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if jwt_expires_at(&access_token) - chrono::Utc::now().timestamp() >= TOKEN_REFRESH_THRESHOLD {
        return Some(access_token);
    }
    let refresh_token = credentials
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if refresh_token.is_empty() {
        errors.push(serde_json::json!({ "provider": "Kimi Monthly Total",
            "error": "refresh_token missing in Kimi web credentials; copy it again from the browser (see docs/usage-monitor.md)" }));
        return None;
    }
    let body = serde_json::json!({ "refresh_token": refresh_token }).to_string();
    let result = request_json_post(
        KIMI_WEB_REFRESH_URL,
        &[("Content-Type", "application/json"), ("Accept", "application/json")],
        &body,
        use_proxy,
        timeout,
    );
    let Ok(result) = result else {
        errors.push(serde_json::json!({ "provider": "Kimi Monthly Total",
            "error": "Failed to refresh Kimi web credentials; copy refresh_token again from the browser (see docs/usage-monitor.md)" }));
        return None;
    };
    access_token = result
        .get("access_token")
        .or_else(|| result.get("accessToken"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if access_token.is_empty() {
        errors.push(serde_json::json!({ "provider": "Kimi Monthly Total",
            "error": "Failed to refresh Kimi web credentials; copy refresh_token again from the browser (see docs/usage-monitor.md)" }));
        return None;
    }
    credentials["access_token"] = Value::String(access_token.clone());
    credentials["refresh_token"] = Value::String(
        result
            .get("refresh_token")
            .or_else(|| result.get("refreshToken"))
            .and_then(|v| v.as_str())
            .unwrap_or(&refresh_token)
            .to_string(),
    );
    write_credentials(path, &credentials);
    Some(access_token)
}

fn window_label(seconds: i64, fallback: &str) -> String {
    if (4 * 3600..=6 * 3600).contains(&seconds) {
        return "5h Window".into();
    }
    if (6 * 86400..=8 * 86400).contains(&seconds) {
        return "7d Window".into();
    }
    if seconds > 0 && seconds % 86400 == 0 {
        return format!("{}d Window", seconds / 86400);
    }
    if seconds > 0 && seconds % 3600 == 0 {
        return format!("{}h Window", seconds / 3600);
    }
    fallback.to_string()
}

fn collect_codex(homes: &[(PathBuf, &'static str)], errors: &mut Vec<Value>) -> Option<Value> {
    let (path, _) = codex_credential(homes)?;
    let credentials = match read_json_file(&path) {
        Ok(value) => value,
        Err(err) => {
            errors.push(serde_json::json!({ "provider": "OpenAI Codex", "error": err }));
            return None;
        }
    };
    let tokens = credentials.get("tokens").cloned().unwrap_or_else(|| serde_json::json!({}));
    let access_token = tokens.get("access_token").and_then(|v| v.as_str()).unwrap_or("");
    if access_token.is_empty() {
        errors.push(serde_json::json!({ "provider": "OpenAI Codex",
            "error": "access_token missing in Codex credentials; run `codex login`" }));
        return None;
    }
    let account_id = tokens.get("account_id").and_then(|v| v.as_str()).unwrap_or("");
    let use_proxy = crate::settings::env_enabled("CODEX_USE_PROXY", true);
    let timeout = crate::settings::env_value("CODEX_TIMEOUT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(30);
    let mut dynamic_headers: Vec<(String, String)> = vec![
        ("Authorization".into(), format!("Bearer {access_token}")),
    ];
    if !account_id.is_empty() {
        dynamic_headers.push(("ChatGPT-Account-Id".into(), account_id.to_string()));
    }
    let agent = build_agent(use_proxy, timeout.min(20));
    let mut request = agent
        .get(&crate::settings::env_value("CODEX_USAGE_URL").unwrap_or_else(|| CODEX_USAGE_URL.into()))
        .set("Accept", "application/json")
        .set("User-Agent", "codex-usage-monitor/1.0");
    for (name, value) in &dynamic_headers {
        request = request.set(name, value);
    }
    let result = match request.call() {
        Ok(response) => response
            .into_json()
            .map_err(|err| format!("Invalid API response: {err}")),
        Err(ureq::Error::Status(401, _)) => Err(
            "Codex login expired; run `codex login` and retry".to_string(),
        ),
        Err(ureq::Error::Status(code, response)) => {
            let reason = response.header("http_status_message").unwrap_or("error").to_string();
            Err(format!("HTTP {code}: {reason}"))
        }
        Err(err) => Err(format!("Network request failed: {err}")),
    };
    match result {
        Ok(data) => {
            let mut account = normalize_codex(&data);
            attach_manual_membership(&mut account, "openai");
            Some(account)
        }
        Err(err) => {
            let lowered = err.to_lowercase();
            let message = if lowered.contains("timed out")
                || lowered.contains("connection reset")
                || lowered.contains("network is unreachable")
            {
                "Cannot reach chatgpt.com; check proxy/DNS/network (a proxy is required in mainland China)".to_string()
            } else {
                err
            };
            errors.push(serde_json::json!({ "provider": "OpenAI Codex", "error": message }));
            None
        }
    }
}

fn normalize_codex(data: &Value) -> Value {
    let rate_limit = data
        .get("rate_limit")
        .or_else(|| data.get("rateLimit"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let reset_credits = data
        .get("rate_limit_reset_credits")
        .or_else(|| data.get("rateLimitResetCredits"))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let mut windows: Vec<Value> = Vec::new();
    for key in ["primary_window", "primaryWindow", "secondary_window", "secondaryWindow"] {
        let window = rate_limit.get(key).filter(|v| v.is_object());
        let Some(window) = window else { continue };
        let seconds = num_of(window.get("limit_window_seconds")) as i64;
        windows.push(normalize_window(&window_label(seconds, "Window"), window, Some(seconds)));
    }
    let mut result = serde_json::json!({
        "provider": "OpenAI Codex",
        "plan": data.get("plan_type").or_else(|| data.get("planType")).and_then(|v| v.as_str()).unwrap_or("unknown"),
        "windows": windows,
        "credits": data.get("credits").cloned().unwrap_or(Value::Null),
        "fetched_at": fetched_now(),
    });
    if reset_credits.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
        let mut normalized = serde_json::Map::new();
        for (key, alternatives) in [
            ("available_count", ["available_count", "availableCount"]),
            ("applicable_available_count", ["applicable_available_count", "applicableAvailableCount"]),
        ] {
            for alternative in alternatives {
                let raw = reset_credits.get(alternative).filter(|v| !v.is_null());
                if raw.is_some() {
                    normalized.insert(key.into(), Value::from(num_of(raw).max(0.0) as i64));
                    break;
                }
            }
        }
        if !normalized.is_empty() {
            result["rate_limit_reset_credits"] = Value::Object(normalized);
        }
    }
    result
}

/// 全量配额采集：Kimi/Codex/DeepSeek/GLM 四家全原生，凭证跨本机与 WSL 发现。
/// 返回 (accounts, errors)；versions 由调用方附加。
pub fn collect_all() -> (Vec<Value>, Vec<Value>) {
    let homes = credential_homes();
    let mut accounts: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();

    // 顺序与 Python collect 一致：Kimi、Codex、DeepSeek、GLM
    match collect_kimi(&homes, &mut errors) {
        Some(account) => accounts.push(account),
        None if !errors.iter().any(|e| e["provider"] == "Kimi Code") => {
            errors.push(serde_json::json!({ "provider": "Kimi Code",
                "error": "Kimi credentials not found; run kimi and log in again" }));
        }
        None => {}
    }
    match collect_codex(&homes, &mut errors) {
        Some(account) => accounts.push(account),
        None if !errors.iter().any(|e| e["provider"] == "OpenAI Codex") => {
            errors.push(serde_json::json!({ "provider": "OpenAI Codex",
                "error": "Codex credentials not found; run `codex login`" }));
        }
        None => {}
    }
    let (native_accounts, mut native_errors) = collect_native();
    accounts.extend(native_accounts);
    errors.append(&mut native_errors);
    (accounts, errors)
}
