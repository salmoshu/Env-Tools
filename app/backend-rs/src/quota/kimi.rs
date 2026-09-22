//! Kimi Code：CLI OAuth 凭证刷新 + 用量窗口；网页凭证补月总量/会员信息。

use std::path::{Path, PathBuf};

use chrono::{Local, Utc};
use serde_json::Value;

use super::http::{get_json, post_json};
use super::membership::attach_manual_membership;
use super::util::{
    env_timeout, fetched_now, iso_seconds, monthly_window_seconds, normalize_window, num_of,
    num_opt, parse_timestamp, seconds_until,
};
use super::{find_file_across_homes, write_credentials};
use crate::settings::{env_enabled, env_value};

const KIMI_CLIENT_ID: &str = "17e5f671-d194-4dfb-9706-5516cb48c098";
const KIMI_OAUTH_URL: &str = "https://auth.kimi.com/api/oauth/token";
const KIMI_USAGE_URL: &str = "https://api.kimi.com/coding/v1/usages";
const KIMI_WEB_REFRESH_URL: &str =
    "https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken";
const KIMI_WEB_STATS_URL: &str =
    "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats";
const KIMI_WEB_SUBSCRIPTION_URL: &str =
    "https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription";
/// 与 Python TOKEN_REFRESH_THRESHOLD 一致：剩余寿命低于 5 分钟即刷新
const TOKEN_REFRESH_THRESHOLD: i64 = 300;

fn kimi_code_credential(homes: &[PathBuf]) -> Option<PathBuf> {
    if let Some(home) = env_value("KIMI_CODE_HOME") {
        let explicit = PathBuf::from(home).join("credentials/kimi-code.json");
        if explicit.is_file() {
            return Some(explicit);
        }
    }
    find_file_across_homes(
        homes,
        &[".kimi-code/credentials/kimi-code.json", ".kimi/credentials/kimi-code.json"],
        "KIMI_CREDENTIALS_PATH",
    )
}

fn kimi_web_credential(homes: &[PathBuf]) -> Option<PathBuf> {
    find_file_across_homes(homes, &[".kimi-code/credentials/kimi-web.json"], "KIMI_WEB_CREDENTIALS_PATH")
}

/// 不验签读取 JWT 的 exp（秒）。
fn jwt_expires_at(token: &str) -> i64 {
    let segment = token.split('.').nth(1).unwrap_or("");
    let padded = segment.trim_end_matches('=');
    base64url_decode(padded)
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
    let result = post_json(
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
        Utc::now().timestamp()
            + result.get("expires_in").and_then(|v| v.as_f64()).unwrap_or(0.0) as i64,
    );
    write_credentials(path, &updated);
    Ok(updated)
}

fn fetch_kimi_account(homes: &[PathBuf], errors: &mut Vec<Value>) -> Option<Value> {
    let path = kimi_code_credential(homes)?;
    let use_proxy = env_enabled("KIMI_USE_PROXY", false);
    let timeout = env_timeout("KIMI_TIMEOUT", 30);
    let credentials = match crate::settings::read_json(&path) {
        Ok(value) => value,
        Err(err) => {
            errors.push(serde_json::json!({ "provider": "Kimi Code", "error": err }));
            return None;
        }
    };
    let now_secs = Utc::now().timestamp() as f64;
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
    match get_json(
        &env_value("KIMI_USAGE_URL").unwrap_or_else(|| KIMI_USAGE_URL.into()),
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

pub fn normalize_kimi(data: &Value) -> Value {
    let mut windows: Vec<Value> = Vec::new();
    for item in data.get("limits").and_then(|v| v.as_array()).into_iter().flatten() {
        let meta = item.get("window").cloned().unwrap_or_else(|| serde_json::json!({}));
        let detail = item.get("detail").cloned().unwrap_or_else(|| serde_json::json!({}));
        let duration = num_of(meta.get("duration")) as i64;
        let unit = meta.get("timeUnit").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
        let seconds = if unit.contains("hour") { duration * 3600 } else { duration * 60 };
        let label = if duration == 300 && unit.contains("minute") {
            "5h Window".to_string()
        } else if unit.contains("hour") {
            format!("{duration}h Window")
        } else {
            format!("{duration}m Window")
        };
        windows.push(normalize_window(&label, &detail, if seconds > 0 { Some(seconds) } else { None }));
    }
    windows.push(normalize_window("7d Window", data.get("usage").unwrap_or(&Value::Null), Some(7 * 86400)));
    let plan = data
        .pointer("/user/membership")
        .and_then(|m| m.get("level"))
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
        .or_else(|| stats.get("subscriptionBalance"))?;
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
        "reset_after_seconds": seconds_until(expire_key, Utc::now()),
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
    let purchased_at = parse_timestamp(
        subscription.get("currentStartTime").or_else(|| subscription.get("subscriptionTime")),
    )
    .unwrap_or(ends_at);
    let mut membership = serde_json::json!({
        "purchased_at": iso_seconds(purchased_at.with_timezone(&Local)),
        "ends_at": iso_seconds(ends_at.with_timezone(&Local)),
        "end_after_seconds": (ends_at - Utc::now()).num_seconds(),
    });
    let cycle = goods.get("billingCycle").cloned().unwrap_or_else(|| serde_json::json!({}));
    let cycle_count = num_of(cycle.get("duration")) as i64;
    let cycle_unit = cycle.get("timeUnit").and_then(|v| v.as_str()).unwrap_or("").to_uppercase();
    let cycle_months = if cycle_unit.contains("YEAR") { cycle_count * 12 } else { cycle_count };
    if (cycle_unit.contains("MONTH") || cycle_unit.contains("YEAR")) && cycle_months > 0 {
        membership["duration_months"] = Value::from(cycle_months);
    }
    let active = subscription.get("active").and_then(|v| v.as_bool()).unwrap_or(true);
    if subscription.get("nextBillingTime").map(|v| !v.is_null()).unwrap_or(false) && active {
        membership["auto_renew"] = Value::Bool(true);
    }
    result["membership"] = membership;
    Some(result)
}

/// 网页接口公共头（platform 头缺失会被拒）。
const KIMI_WEB_JSON_HEADERS: &[(&str, &str)] = &[
    ("Content-Type", "application/json"),
    ("Accept", "application/json"),
    ("x-msh-platform", "web"),
];

fn kimi_web_access_token(
    path: &Path,
    credentials: &Value,
    use_proxy: bool,
    timeout: u64,
    errors: &mut Vec<Value>,
) -> Option<String> {
    let mut credentials = credentials.clone();
    let access_token = credentials.get("access_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if jwt_expires_at(&access_token) - Utc::now().timestamp() >= TOKEN_REFRESH_THRESHOLD {
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
    let result = post_json(
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
    let access_token = result
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

fn kimi_web_post(url: &str, token: &str, use_proxy: bool, timeout: u64) -> Result<Value, String> {
    let mut headers: Vec<(&str, &str)> = Vec::with_capacity(KIMI_WEB_JSON_HEADERS.len() + 1);
    headers.push(("Authorization", token));
    headers.extend_from_slice(KIMI_WEB_JSON_HEADERS);
    post_json(url, &headers, "{}", use_proxy, timeout)
}

/// Kimi 卡片：CLI 凭证查窗口（仅本机侧）+ 网页凭证补月总量/会员名/会员到期。
/// 网页凭证（kimi-web.json）允许跨家目录发现（本机缺失时读 WSL 侧小文件，
/// 成本极低）——它承载 plan（如 Allegro）与订阅到期，配额窗口本身仍来自
/// 本机 CLI 凭证，不受跨源影响。
pub fn collect(homes: &[PathBuf], errors: &mut Vec<Value>) -> Option<Value> {
    let mut account = fetch_kimi_account(homes, errors)?;
    let use_proxy = env_enabled("KIMI_USE_PROXY", false);
    let timeout = env_timeout("KIMI_TIMEOUT", 30);
    let mut web_homes = homes.to_vec();
    web_homes.extend(crate::settings::wsl_homes());
    // 网页凭证为增强项：缺失/不可读/刷新失败时仍返回 CLI 窗口卡片
    let Some(web_path) = kimi_web_credential(&web_homes) else {
        return Some(account);
    };
    let Ok(credentials) = crate::settings::read_json(&web_path) else {
        return Some(account);
    };
    let Some(token) = kimi_web_access_token(&web_path, &credentials, use_proxy, timeout, errors) else {
        return Some(account);
    };
    match kimi_web_post(
        &env_value("KIMI_WEB_STATS_URL").unwrap_or_else(|| KIMI_WEB_STATS_URL.into()),
        &token,
        use_proxy,
        timeout,
    ) {
        Ok(payload) => {
            if let Some((window, extra_lines)) = normalize_kimi_monthly(&payload) {
                if let Some(list) = account["windows"].as_array_mut() {
                    list.push(window);
                }
                let mut lines = account
                    .get("extra_lines")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                lines.extend(extra_lines.into_iter().map(Value::String));
                account["extra_lines"] = Value::Array(lines);
            }
        }
        Err(err) => {
            errors.push(serde_json::json!({ "provider": "Kimi Monthly Total", "error": err }));
        }
    }
    let mut subscription_membership = None;
    match kimi_web_post(
        &env_value("KIMI_WEB_SUBSCRIPTION_URL").unwrap_or_else(|| KIMI_WEB_SUBSCRIPTION_URL.into()),
        &token,
        use_proxy,
        timeout,
    ) {
        Ok(payload) => {
            if let Some(subscription) = normalize_kimi_subscription(&payload) {
                if let Some(plan) = subscription.get("plan").and_then(|v| v.as_str()) {
                    account["plan"] = Value::String(plan.to_string());
                }
                subscription_membership = subscription.get("membership").cloned();
            }
        }
        // 订阅属增强项：失败保持 plan=unknown 不额外报错（口径同 Python）
        Err(_) => {}
    }
    // 手动会员配置无条件优先（订阅接口失败时也不能丢），订阅结果仅作兜底
    if !attach_manual_membership(&mut account, "kimi") {
        if let Some(membership) = subscription_membership {
            account["membership"] = membership;
        }
    }
    Some(account)
}
