//! OpenAI Codex：本地 auth.json 的 ChatGPT 后端配额查询（wham/usage）。

use std::path::PathBuf;

use serde_json::Value;

use super::http::{build_agent, post_json};
use super::membership::attach_manual_membership;
use super::util::{env_timeout, fetched_now, normalize_window, num_of};
use super::{credential_homes, find_file_across_homes};
use crate::settings::{env_enabled, env_value};

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CONSUME_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

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
    for key in [
        "primary_window",
        "primaryWindow",
        "secondary_window",
        "secondaryWindow",
    ] {
        let window = rate_limit.get(key).filter(|v| v.is_object());
        let Some(window) = window else { continue };
        let seconds = num_of(window.get("limit_window_seconds")) as i64;
        windows.push(normalize_window(
            &window_label(seconds, "Window"),
            window,
            Some(seconds),
        ));
    }
    let mut result = serde_json::json!({
        "provider": "OpenAI Codex",
        "plan": data.get("plan_type").or_else(|| data.get("planType")).and_then(|v| v.as_str()).unwrap_or("unknown"),
        "windows": windows,
        "credits": data.get("credits").cloned().unwrap_or(Value::Null),
        "fetched_at": fetched_now(),
    });
    if reset_credits
        .as_object()
        .map(|o| !o.is_empty())
        .unwrap_or(false)
    {
        let mut normalized = serde_json::Map::new();
        for (key, alternatives) in [
            ("available_count", ["available_count", "availableCount"]),
            (
                "applicable_available_count",
                ["applicable_available_count", "applicableAvailableCount"],
            ),
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

/// 单轮真实采集：凭证发现 → HTTP → 归一化（成功路径附加手动会员）。
/// 只反映本轮配额接口是否成功，不涉及轮次窗口（见 collect）
fn fetch_account(homes: &[PathBuf]) -> Result<Value, String> {
    let path = codex_credential(homes)
        .ok_or_else(|| "Codex credentials not found; run `codex login`".to_string())?;
    let credentials = crate::settings::read_json(&path).map_err(|err| err.to_string())?;
    let tokens = credentials
        .get("tokens")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if access_token.is_empty() {
        return Err(
            "access_token missing in Codex credentials; run `codex login`".to_string(),
        );
    }
    let account_id = tokens
        .get("account_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
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
    let data = match request.call() {
        Ok(response) => response
            .into_json()
            .map_err(|err| format!("Invalid API response: {err}"))?,
        Err(ureq::Error::Status(401, _)) => {
            return Err("Codex login expired; run `codex login` and retry".to_string());
        }
        Err(ureq::Error::Status(code, response)) => {
            let reason = response
                .header("http_status_message")
                .unwrap_or("error")
                .to_string();
            return Err(format!("HTTP {code}: {reason}"));
        }
        Err(err) => return Err(format!("Network request failed: {err}")),
    };
    let mut account = normalize_codex(&data);
    attach_manual_membership(&mut account, "openai");
    Ok(account)
}

/// 轮次窗口决策结果：纯逻辑（不读任何机器配置），可确定性测试
#[derive(Debug)]
pub(crate) enum WindowOutcome {
    /// 本轮取数成功
    Fresh(Value),
    /// 本轮失败但窗口内（<3 轮）且曾有成功数据：沿用（已打 stale 标记）
    Stale(Value),
    /// 本轮失败且窗口判定应出错误（启动首轮失败，或连续第 3 轮失败）；
    /// 携带面向用户的错误消息（网络类已转译）
    Failed(String),
}

/// 轮次失败窗口：单轮失败先沿用上次成功数据（标记 stale，不出错误卡），
/// 连续第 CODEX_FAIL_STREAK_LIMIT 轮仍失败才走错误降级；任一轮成功清零。
/// 进程内状态：重启后无记忆，启动首轮失败即直接降级（无历史可沿用）。
/// 轮次计数带时间闸门（CODEX_FAIL_COUNT_INTERVAL_MS）：距上一个已计数
/// 失败不足间隔的失败不推进计数——手动连点刷新不烧额度，"3 轮"始终是
/// 时间意义上的 3 个周期（自动 60s 轮天然满足），而非任意 3 次失败
struct RetryWindow {
    last_good: Option<Value>,
    consecutive_fails: u32,
    /// 上一个"已计数"失败的毫秒时刻；0 = 无（成功后清零）
    last_fail_ms: i64,
}

const CODEX_FAIL_STREAK_LIMIT: u32 = 3;
const CODEX_FAIL_COUNT_INTERVAL_MS: i64 = 30_000;

static RETRY_WINDOW: std::sync::Mutex<RetryWindow> = std::sync::Mutex::new(RetryWindow {
    last_good: None,
    consecutive_fails: 0,
    last_fail_ms: 0,
});

pub(crate) fn apply_retry_window(outcome: Result<Value, String>) -> WindowOutcome {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    apply_retry_window_at(outcome, now_ms)
}

/// 窗口决策核心（时钟注入以便测试）
pub(crate) fn apply_retry_window_at(
    outcome: Result<Value, String>,
    now_ms: i64,
) -> WindowOutcome {
    let mut win = RETRY_WINDOW
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match outcome {
        Ok(account) => {
            win.last_good = Some(account.clone());
            win.consecutive_fails = 0;
            win.last_fail_ms = 0;
            WindowOutcome::Fresh(account)
        }
        Err(raw) => {
            let lowered = raw.to_lowercase();
            let message = if lowered.contains("timed out")
                || lowered.contains("connection reset")
                || lowered.contains("network is unreachable")
            {
                "Cannot reach chatgpt.com; check proxy/DNS/network (a proxy is required in mainland China)".to_string()
            } else {
                raw
            };
            // 时间闸门：间隔不足的失败不推进计数，但窗口判定照常
            //（窗口内仍沿用旧数据；已到 3 轮则维持错误态）
            let counted = win.last_fail_ms == 0
                || now_ms - win.last_fail_ms >= CODEX_FAIL_COUNT_INTERVAL_MS;
            if counted {
                win.consecutive_fails += 1;
                win.last_fail_ms = now_ms;
            }
            if win.consecutive_fails < CODEX_FAIL_STREAK_LIMIT {
                if let Some(mut last) = win.last_good.clone() {
                    last["stale"] = Value::Bool(true);
                    eprintln!(
                        "[codex] quota fetch failed ({}/{CODEX_FAIL_STREAK_LIMIT}{}), serving last good data: {message}",
                        win.consecutive_fails,
                        if counted { "" } else { ", rapid retry not counted" }
                    );
                    return WindowOutcome::Stale(last);
                }
                // 启动首轮即失败：无历史可沿用，直接降级
            }
            WindowOutcome::Failed(message)
        }
    }
}

pub fn collect(homes: &[PathBuf], errors: &mut Vec<Value>) -> Option<Value> {
    match apply_retry_window(fetch_account(homes)) {
        WindowOutcome::Fresh(account) | WindowOutcome::Stale(account) => Some(account),
        WindowOutcome::Failed(message) => {
            // 错误降级：配额接口失败但存在手动会员配置时，返回一个最小账户
            // （会员到期仍在前端展示）。一个 provider 只出一张卡：此时不再推送
            // 错误条目，否则前端会同时渲染账号卡片与错误占位卡片。
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

/// 消耗一个速率限制重置额度（wham rate-limit-reset-credits/consume，口径同
/// codex CLI 的 backend-client）。返回 {"code": "reset"|"nothing_to_reset"|
/// "no_credit"|"already_redeemed", "windows_reset": n}；网络/HTTP 错误返回 Err。
pub fn consume_reset_credit() -> Result<Value, String> {
    let homes = credential_homes();
    let path = codex_credential(&homes)
        .ok_or_else(|| "Codex credentials not found; run `codex login`".to_string())?;
    let credentials = crate::settings::read_json(&path).map_err(|err| err.to_string())?;
    let tokens = credentials
        .get("tokens")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if access_token.is_empty() {
        return Err("access_token missing in Codex credentials; run `codex login`".into());
    }
    let account_id = tokens
        .get("account_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let use_proxy = env_enabled("CODEX_USE_PROXY", true);
    let timeout = env_timeout("CODEX_TIMEOUT", 30).min(20);
    let url =
        env_value("CODEX_RESET_CONSUME_URL").unwrap_or_else(|| CODEX_RESET_CONSUME_URL.into());
    let authorization = format!("Bearer {access_token}");
    let mut headers: Vec<(&str, &str)> = vec![
        ("Accept", "application/json"),
        ("User-Agent", "codex-cli/1.0"),
        ("Authorization", authorization.as_str()),
        ("Content-Type", "application/json"),
    ];
    if !account_id.is_empty() {
        headers.push(("ChatGPT-Account-Id", account_id));
    }
    let body = serde_json::json!({ "redeem_request_id": super::util::random_token() }).to_string();
    post_json(&url, &headers, &body, use_proxy, timeout)
}
