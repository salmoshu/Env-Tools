//! OpenAI Codex：本地 auth.json 的 ChatGPT 后端配额查询（wham/usage）。

use std::path::PathBuf;

use serde_json::Value;

use super::http::build_agent;
use super::membership::attach_manual_membership;
use super::util::{env_timeout, fetched_now, normalize_window, num_of};
use super::find_file_across_homes;
use crate::settings::{env_enabled, env_value};

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";

fn codex_credential(homes: &[PathBuf]) -> Option<PathBuf> {
    let mut homes = homes.to_vec();
    if let Some(home) = env_value("CODEX_HOME") {
        homes.insert(0, PathBuf::from(home));
    }
    find_file_across_homes(&homes, &[".codex/auth.json"], "CODEX_AUTH_PATH")
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

pub fn normalize_codex(data: &Value) -> Value {
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

pub fn collect(homes: &[PathBuf], errors: &mut Vec<Value>) -> Option<Value> {
    let path = codex_credential(homes)?;
    let credentials = match crate::settings::read_json(&path) {
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
    let use_proxy = env_enabled("CODEX_USE_PROXY", true);
    // 该接口经代理偶尔慢，压到 20s 上限避免拖垮整个 /api/usage
    let timeout = env_timeout("CODEX_TIMEOUT", 30).min(20);
    let agent = build_agent(use_proxy, timeout);
    let mut request = agent
        .get(&env_value("CODEX_USAGE_URL").unwrap_or_else(|| CODEX_USAGE_URL.into()))
        .set("Accept", "application/json")
        .set("User-Agent", "codex-usage-monitor/1.0")
        .set("Authorization", &format!("Bearer {access_token}"));
    if !account_id.is_empty() {
        request = request.set("ChatGPT-Account-Id", account_id);
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
            // 配额接口失败但存在手动会员配置时，返回一个最小账户（会员到期仍在
            // 前端展示）。一个 provider 只出一张卡：此时不再推送错误条目，
            // 否则前端会同时渲染账号卡片与错误占位卡片。
            let mut account = serde_json::json!({
                "provider": "OpenAI Codex",
                "plan": "unknown",
                "windows": [],
                "fetched_at": fetched_now(),
            });
            if attach_manual_membership(&mut account, "openai") {
                eprintln!("[codex] quota fetch failed, serving minimal account with manual membership: {message}");
                Some(account)
            } else {
                errors.push(serde_json::json!({ "provider": "OpenAI Codex", "error": message }));
                None
            }
        }
    }
}
