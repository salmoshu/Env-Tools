//! OpenAI Codex：本地 auth.json 的 ChatGPT 配额查询。
//! 优先官方 `codex app-server`（account/rateLimits/read，见 codex_appserver），
//! CLI 不可用/查询失败时回退直连 wham/usage。

use std::sync::OnceLock;

use serde_json::Value;

use super::http::{build_agent, post_json};
use super::membership::attach_manual_membership;
use super::util::{env_timeout, fetched_now, normalize_window, num_of};

use crate::accounts::AccountProfile;
use crate::settings::{env_enabled, env_value};

const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_RESET_CONSUME_URL: &str =
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";

fn codex_credential(account: &AccountProfile) -> Option<std::path::PathBuf> {
    crate::accounts::credential_path(account)
}

/// 本地 id_token 的 chatgpt_plan_type（不验签，仅展示）：
/// 与接口 planType 分开原样显示，不做别名转换或回退。
fn local_plan_type(credentials: &Value) -> Option<String> {
    let id_token = credentials.get("tokens")?.get("id_token")?.as_str()?;
    let segment = id_token.split('.').nth(1)?;
    let decoded = base64url_decode(segment)?;
    let data = serde_json::from_slice::<Value>(&decoded).ok()?;
    data.get("chatgpt_plan_type")
        .and_then(|v| v.as_str())
        .map(str::to_string)
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
fn fetch_account(account: &AccountProfile) -> Result<Value, String> {
    let path = codex_credential(account).ok_or_else(|| {
        format!(
            "Codex credentials not found for {}; run `codex login`",
            account.label
        )
    })?;
    let credentials = crate::settings::read_json(&path).map_err(|err| err.to_string())?;
    let local_plan = local_plan_type(&credentials);
    let tokens = credentials
        .get("tokens")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let access_token = tokens
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if access_token.is_empty() {
        // API key 登录没有 ChatGPT 订阅窗口：明说，不显示 0% 或无限额度
        let has_api_key = credentials
            .get("OPENAI_API_KEY")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if has_api_key {
            let mut account_data = serde_json::json!({
                "provider": "OpenAI Codex",
                "plan": "API",
                "windows": [],
                "extra_lines": ["API key account: no ChatGPT subscription windows"],
                "fetched_at": fetched_now(),
                "account_id": account.id.clone(),
                "account_label": account.label.clone(),
            });
            attach_manual_membership(
                &mut account_data,
                &crate::settings::codex_membership_key(&account.id),
            );
            return Ok(account_data);
        }
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
    // 优先官方 app-server（account/rateLimits/read）：官方续期与协议兼容；
    // CLI 缺失/版本不支持/查询失败时回退直连 wham/usage
    // app-server 的 CODEX_HOME 必须取"实际凭证所在目录"，而不是 profile.home：
    // default 被物化覆盖时（~/.codex 是当前激活账号），其真实登录在
    // _default-original 备份里，直接用 profile.home 会把两个账号查成同一个
    let appserver_home = path.parent().unwrap_or(&account.home).to_path_buf();
    let appserver = if appserver_home.is_dir() && env_enabled("CODEX_APPSERVER", true) {
        super::codex_appserver::query_rate_limits(
            &appserver_home,
            env_timeout("CODEX_APPSERVER_TIMEOUT", 25).min(25),
        )
        .ok()
    } else {
        None
    };
    let mut account_data = match appserver {
        Some(result) => normalize_codex(&super::codex_appserver::to_wham_shape(
            &result,
            chrono::Utc::now().timestamp(),
        )),
        None => {
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
            normalize_codex(&data)
        }
    };
    // 本地 token 套餐与接口 planType 不一致时并列展示（典型：接口 unknown）
    if let Some(local) = local_plan {
        let api_plan = account_data
            .get("plan")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if local != api_plan {
            let line = Value::String(format!("Local plan: {local}"));
            if let Some(lines) = account_data.get_mut("extra_lines").and_then(|v| v.as_array_mut()) {
                lines.push(line);
            } else {
                account_data["extra_lines"] = Value::Array(vec![line]);
            }
        }
    }
    account_data["account_id"] = Value::String(account.id.clone());
    account_data["account_label"] = Value::String(account.label.clone());
    attach_manual_membership(
        &mut account_data,
        &crate::settings::codex_membership_key(&account.id),
    );
    Ok(account_data)
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

static RETRY_WINDOWS: OnceLock<std::sync::Mutex<std::collections::HashMap<String, RetryWindow>>> =
    OnceLock::new();
static RETRY_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn retry_windows() -> &'static std::sync::Mutex<std::collections::HashMap<String, RetryWindow>> {
    RETRY_WINDOWS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

fn retry_generation() -> u64 {
    RETRY_GENERATION.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn invalidate_retry_state() {
    let mut windows = retry_windows()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    RETRY_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    windows.clear();
}

pub(crate) fn apply_retry_window_for(
    account_id: &str,
    expected_generation: u64,
    outcome: Result<Value, String>,
) -> WindowOutcome {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    apply_retry_window_at_for_guarded(account_id, outcome, now_ms, Some(expected_generation))
}

/// 窗口决策核心（时钟注入以便测试），默认账号兼容旧测试与旧调用。
#[allow(dead_code)]
pub(crate) fn apply_retry_window_at(
    outcome: Result<Value, String>,
    now_ms: i64,
) -> WindowOutcome {
    apply_retry_window_at_for("default", outcome, now_ms)
}

fn apply_retry_window_at_for(
    account_id: &str,
    outcome: Result<Value, String>,
    now_ms: i64,
) -> WindowOutcome {
    apply_retry_window_at_for_guarded(account_id, outcome, now_ms, None)
}

fn apply_retry_window_at_for_guarded(
    account_id: &str,
    outcome: Result<Value, String>,
    now_ms: i64,
    expected_generation: Option<u64>,
) -> WindowOutcome {
    let mut windows = retry_windows()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if expected_generation
        .map(|generation| generation != retry_generation())
        .unwrap_or(false)
    {
        return WindowOutcome::Failed(
            "Codex account registration changed during query; retry".into(),
        );
    }
    let win = windows.entry(account_id.to_string()).or_insert_with(|| RetryWindow {
        last_good: None,
        consecutive_fails: 0,
        last_fail_ms: 0,
    });
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

pub fn collect(account: &AccountProfile, errors: &mut Vec<Value>) -> Option<Value> {
    let generation = retry_generation();
    let outcome = fetch_account(account);
    match apply_retry_window_for(&account.id, generation, outcome) {
        WindowOutcome::Fresh(account) | WindowOutcome::Stale(account) => Some(account),
        WindowOutcome::Failed(message) => {
            // 配额失败统一进入错误卡片；手动会员信息随错误保留，避免
            // unknown 占位卡遮蔽登录失效或网络异常。
            let mut error = serde_json::json!({
                "provider": "OpenAI Codex",
                "account_id": account.id,
                "account_label": account.label,
                "plan": "unknown",
                "windows": [],
                "fetched_at": fetched_now(),
                "error": message,
            });
            attach_manual_membership(
                &mut error,
                &crate::settings::codex_membership_key(&account.id),
            );
            errors.push(error);
            None
        }
    }
}

/// 消耗一个速率限制重置额度（wham rate-limit-reset-credits/consume，口径同
/// codex CLI 的 backend-client）。返回 {"code": "reset"|"nothing_to_reset"|
/// "no_credit"|"already_redeemed", "windows_reset": n}；网络/HTTP 错误返回 Err。
pub fn consume_reset_credit(account_id: &str) -> Result<Value, String> {
    let account = crate::settings::codex_account(account_id)
        .ok_or_else(|| format!("Codex account not found: {account_id}"))?;
    let path = codex_credential(&account).ok_or_else(|| {
        format!(
            "Codex credentials not found for {}; run `codex login`",
            account.label
        )
    })?;
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
