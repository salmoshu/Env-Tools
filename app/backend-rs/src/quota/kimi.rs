//! Kimi Code：CLI OAuth 凭证刷新 + 用量窗口；网页凭证补月总量/会员信息。

use std::fmt;
use std::path::{Path, PathBuf};

use chrono::{Local, Utc};
use serde_json::Value;

use super::http::{get_json, post_json, post_json_detailed};
use super::membership::attach_manual_membership;
use super::util::{
    env_timeout, fetched_now, iso_seconds, monthly_window_seconds, normalize_window, num_of,
    num_opt, parse_timestamp, seconds_until,
};
use super::write_credentials;
use crate::accounts::AccountProfile;
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

/// 网页会话错误：code 供前端按类型引导（过期 → 重新授权；网络 → 重试），
/// message 保留服务端明细（如 "Session expired. Please log in again."）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct KimiWebError {
    pub code: String,
    pub message: String,
}

impl KimiWebError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    fn is_expired(&self) -> bool {
        self.code == "kimi_web_session_expired"
    }

    fn is_auth_missing(&self) -> bool {
        self.code == "kimi_web_missing_token"
    }
}

impl fmt::Display for KimiWebError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// 把 HTTP 失败归类为“需要重新登录 / 网络问题 / 其他 HTTP 错误”。
fn web_failure(failure: super::http::HttpFailure) -> KimiWebError {
    if failure.is_network() {
        KimiWebError::new("kimi_web_network", failure.message)
    } else if failure.status == Some(401) {
        KimiWebError::new("kimi_web_session_expired", failure.message)
    } else {
        KimiWebError::new("kimi_web_http", failure.message)
    }
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

fn fetch_kimi_account(profile: &AccountProfile) -> Result<Value, String> {
    let path = crate::accounts::credential_path(profile).ok_or_else(|| {
        format!(
            "Kimi credentials not found for {}; run kimi and log in again",
            profile.label
        )
    })?;
    let use_proxy = env_enabled("KIMI_USE_PROXY", false);
    let timeout = env_timeout("KIMI_TIMEOUT", 30);
    let credentials = crate::settings::read_json(&path)?;
    let now_secs = Utc::now().timestamp() as f64;
    let expires_at = credentials
        .get("expires_at")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let fresh = if expires_at - now_secs < TOKEN_REFRESH_THRESHOLD as f64 {
        refresh_kimi_credentials(&path, &credentials, use_proxy, timeout.min(10))?
    } else {
        credentials
    };
    let access_token = fresh
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if access_token.is_empty() {
        return Err("access_token missing in Kimi credentials; run kimi and log in again".into());
    }
    let data = get_json(
        &env_value("KIMI_USAGE_URL").unwrap_or_else(|| KIMI_USAGE_URL.into()),
        access_token,
        use_proxy,
        timeout,
    )?;
    let mut account = normalize_kimi(&data);
    account["account_id"] = Value::String(profile.id.clone());
    account["account_label"] = Value::String(profile.label.clone());
    Ok(account)
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
    // 共享额度占比：挂在月额度窗口下方展示（w.sub），不再进 extra_lines
    let mut sub = Value::Null;
    if let Some(code_percent) = ratio_percent(
        balance.get("kimi_code_used_ratio").or_else(|| balance.get("kimiCodeUsedRatio")),
    ) {
        sub = Value::String(format!("Kimi Code share: {code_percent:.2}%"));
    }
    let expire_key = balance.get("expire_time").or_else(|| balance.get("expireTime"));
    let window = serde_json::json!({
        "label": "Monthly Total",
        "used_percent": used_percent,
        "reset_after_seconds": seconds_until(expire_key, Utc::now()),
        "window_seconds": parse_timestamp(expire_key).map(monthly_window_seconds),
        "sub": sub,
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

/// 用 refresh_token 换新会话；401 与网络故障分开上报（前者要重新授权，
/// 后者只需重试），并保留服务端 "Session expired..." 明细。
fn refresh_kimi_web(
    refresh_token: &str,
    use_proxy: bool,
    timeout: u64,
) -> Result<Value, KimiWebError> {
    let refresh_token = refresh_token.trim();
    if refresh_token.is_empty() {
        return Err(KimiWebError::new(
            "kimi_web_missing_token",
            "Kimi web refresh_token is empty; copy it again from kimi.com",
        ));
    }
    let body = serde_json::json!({ "refresh_token": refresh_token }).to_string();
    let result = post_json_detailed(
        KIMI_WEB_REFRESH_URL,
        &[("Content-Type", "application/json"), ("Accept", "application/json")],
        &body,
        use_proxy,
        timeout,
    )
    .map_err(web_failure)?;
    let access_token = result
        .get("access_token")
        .or_else(|| result.get("accessToken"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if access_token.is_empty() {
        return Err(KimiWebError::new(
            "kimi_web_invalid_response",
            "Kimi token refresh response missing access_token",
        ));
    }
    Ok(result)
}

fn kimi_web_access_token(
    path: &Path,
    credentials: &Value,
    use_proxy: bool,
    timeout: u64,
) -> Result<String, KimiWebError> {
    let mut credentials = credentials.clone();
    let access_token = credentials
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if jwt_expires_at(&access_token) - Utc::now().timestamp() >= TOKEN_REFRESH_THRESHOLD {
        return Ok(access_token);
    }
    let refresh_token = credentials
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if refresh_token.is_empty() {
        return Err(KimiWebError::new(
            "kimi_web_missing_token",
            "refresh_token missing in Kimi web credentials; reconnect the Kimi web session",
        ));
    }
    let result = refresh_kimi_web(&refresh_token, use_proxy, timeout)?;
    let access_token = result
        .get("access_token")
        .or_else(|| result.get("accessToken"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
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
    Ok(access_token)
}

fn kimi_web_post(
    url: &str,
    token: &str,
    use_proxy: bool,
    timeout: u64,
) -> Result<Value, KimiWebError> {
    let mut headers: Vec<(&str, &str)> = Vec::with_capacity(KIMI_WEB_JSON_HEADERS.len() + 1);
    headers.push(("Authorization", token));
    headers.extend_from_slice(KIMI_WEB_JSON_HEADERS);
    post_json_detailed(url, &headers, "{}", use_proxy, timeout).map_err(web_failure)
}

/// web_session：前端据此在 Kimi 卡片内展示授权状态与“重新授权”入口。
fn web_session(
    configured: bool,
    state: &str,
    code: &str,
    message: &str,
    path: Option<&Path>,
) -> Value {
    serde_json::json!({
        "configured": configured,
        "state": state,
        "code": code,
        "message": message,
        "path": path.map(|value| value.display().to_string()),
    })
}

/// 保存网页会话的落盘位置：默认账号写 Windows 侧
/// ~/.kimi-code/credentials/kimi-web.json（读取优先级高于 WSL 回退）；
/// 额外账号写各自 profile 目录。
fn kimi_web_write_path(profile: &AccountProfile) -> PathBuf {
    if profile.is_default {
        if let Some(explicit) = env_value("KIMI_WEB_CREDENTIALS_PATH") {
            return PathBuf::from(explicit);
        }
        return crate::settings::local_home().join(".kimi-code/credentials/kimi-web.json");
    }
    profile.home.join("credentials/kimi-web.json")
}

/// 前端“重新授权 Kimi 网页”提交 refresh_token：
/// 先用它换取新 token（验证有效性），再取会员信息，最后落盘。
pub fn save_kimi_web_credential(payload: &Value) -> Result<Value, KimiWebError> {
    let account_id = payload
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("default");
    let refresh_token = payload
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            KimiWebError::new(
                "kimi_web_missing_token",
                "refresh_token is required; copy it from kimi.com local storage",
            )
        })?;
    let profile = crate::accounts::account(crate::accounts::Provider::Kimi, account_id)
        .ok_or_else(|| {
            KimiWebError::new(
                "kimi_web_unknown_account",
                format!("Unknown Kimi account: {account_id}"),
            )
        })?;
    let use_proxy = env_enabled("KIMI_USE_PROXY", false);
    let timeout = env_timeout("KIMI_TIMEOUT", 30);
    let refreshed = refresh_kimi_web(refresh_token, use_proxy, timeout)?;
    let access_token = refreshed
        .get("access_token")
        .or_else(|| refreshed.get("accessToken"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let new_refresh = refreshed
        .get("refresh_token")
        .or_else(|| refreshed.get("refreshToken"))
        .and_then(Value::as_str)
        .unwrap_or(refresh_token)
        .to_string();
    // 会员信息是可选增强：刷新已证明会话有效，这里失败不阻断保存
    let mut plan: Option<String> = None;
    let mut membership = Value::Null;
    let mut warning: Option<String> = None;
    match kimi_web_post(
        &env_value("KIMI_WEB_SUBSCRIPTION_URL").unwrap_or_else(|| KIMI_WEB_SUBSCRIPTION_URL.into()),
        &access_token,
        use_proxy,
        timeout,
    ) {
        Ok(payload) => {
            if let Some(subscription) = normalize_kimi_subscription(&payload) {
                plan = subscription
                    .get("plan")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                membership = subscription.get("membership").cloned().unwrap_or(Value::Null);
            }
        }
        Err(err) if err.is_expired() => return Err(err),
        Err(err) => warning = Some(err.message),
    }
    let path = kimi_web_write_path(&profile);
    let mut credentials = crate::settings::read_json(&path).unwrap_or_else(|_| serde_json::json!({}));
    if !credentials.is_object() {
        credentials = serde_json::json!({});
    }
    credentials["access_token"] = Value::String(access_token.clone());
    credentials["refresh_token"] = Value::String(new_refresh);
    credentials["expires_at"] = Value::from(jwt_expires_at(&access_token));
    credentials["saved_at"] = Value::String(Utc::now().to_rfc3339());
    credentials["saved_by"] = Value::String("env-tools".into());
    crate::settings::write_private_json(&path, &credentials).map_err(|err| {
        KimiWebError::new(
            "kimi_web_write_failed",
            format!("Cannot write {}: {err}", path.display()),
        )
    })?;
    Ok(serde_json::json!({
        "plan": plan,
        "membership": membership,
        "path": path.display().to_string(),
        "warning": warning,
    }))
}

/// Kimi 卡片：当前 profile 的 CLI 凭证查窗口，网页凭证补月总量/会员名/到期。
/// 默认账号保留显式路径与 WSL 网页凭证回退；额外账号仅使用自身 profile。
/// 手动会员先于可选网页增强附加，网页缺失或失败不会将其丢弃。
pub fn collect(profile: &AccountProfile, errors: &mut Vec<Value>) -> Option<Value> {
    let mut account = match fetch_kimi_account(profile) {
        Ok(account) => account,
        Err(err) => {
            let mut error = serde_json::json!({
                "provider": "Kimi Code",
                "account_id": profile.id,
                "account_label": profile.label,
                "plan": "unknown",
                "windows": [],
                "fetched_at": fetched_now(),
                "error": err,
            });
            attach_manual_membership(&mut error, &profile.membership_key());
            errors.push(error);
            return None;
        }
    };
    let manual_membership = attach_manual_membership(&mut account, &profile.membership_key());
    let use_proxy = env_enabled("KIMI_USE_PROXY", false);
    let timeout = env_timeout("KIMI_TIMEOUT", 30);
    let Some(web_path) = crate::accounts::kimi_web_credential_path(profile) else {
        account["web_session"] = web_session(
            false,
            "missing",
            "kimi_web_not_configured",
            "Kimi web session is not connected; membership tier and monthly total are unavailable",
            None,
        );
        return Some(account);
    };
    let credentials = match crate::settings::read_json(&web_path) {
        Ok(credentials) => credentials,
        Err(err) => {
            account["web_session"] = web_session(
                true,
                "error",
                "kimi_web_unreadable",
                &err,
                Some(&web_path),
            );
            return Some(account);
        }
    };
    let token = match kimi_web_access_token(&web_path, &credentials, use_proxy, timeout) {
        Ok(token) => token,
        Err(err) => {
            let state = if err.is_expired() || err.is_auth_missing() {
                "expired"
            } else {
                "error"
            };
            account["web_session"] =
                web_session(true, state, &err.code, &err.message, Some(&web_path));
            return Some(account);
        }
    };
    // 网页增强失败不再单独堆错误卡：状态挂在 Kimi 卡片上，前端据此引导
    // “重新授权”（过期）或“重试”（网络）。
    let mut session_state = "ok";
    let mut session_code = String::new();
    let mut session_message = String::new();
    let mut note_error = |err: &KimiWebError| {
        if session_code.is_empty() {
            session_code = err.code.clone();
            session_message = err.message.clone();
        }
        if err.is_expired() {
            session_state = "expired";
        } else if session_state == "ok" {
            session_state = "degraded";
        }
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
        Err(err) => note_error(&err),
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
        Err(err) => note_error(&err),
    }
    if !manual_membership {
        if let Some(membership) = subscription_membership {
            account["membership"] = membership;
        }
    }
    account["web_session"] = web_session(
        true,
        session_state,
        &session_code,
        &session_message,
        Some(&web_path),
    );
    Some(account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::quota::http::HttpFailure;

    #[test]
    fn expired_session_keeps_server_detail() {
        let failure = HttpFailure {
            status: Some(401),
            message: "HTTP 401: Session expired. Please log in again.".to_string(),
        };
        let err = web_failure(failure);
        assert_eq!(err.code, "kimi_web_session_expired");
        assert!(err.message.contains("Session expired"));
    }

    #[test]
    fn network_failure_is_distinguished_from_auth() {
        let failure = HttpFailure {
            status: None,
            message: "Network request failed: connection refused".to_string(),
        };
        let err = web_failure(failure);
        assert_eq!(err.code, "kimi_web_network");
    }

    #[test]
    fn missing_refresh_token_reports_actionable_code() {
        let err = refresh_kimi_web("   ", false, 5).unwrap_err();
        assert_eq!(err.code, "kimi_web_missing_token");
    }
}
