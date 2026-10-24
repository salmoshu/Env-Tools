//! ZCode Start Plan 额度（v0.7.41）：把 ZCode 客户端「bigmodel-start-plan」
//! 通道的 token 余额桶并入 GLM 套餐卡展示。
//!
//! 接口逆向自 ZCode 桌面客户端（coding-plan-availability 模块）：
//!   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<v>
//!   认证与重置卡同源三头 + **X-Device-Mid**（网关必查的设备标识，
//!   值取 ~/.zcode/v2/onboarding-record.json 的 deviceMid，与 ZCode 客户端一致）。
//! 响应 data：plans[]（name/status/ends_at）+ balances[]（逐模型桶：
//! show_name/total_units/used_units/remaining_units/expires_at，单位 token）。
//!
//! 设备标识缺失或网关拒绝时回退 /billing/current（只给 entitlements 授予量，
//! 无已用数据），仍无则 None。Start Plan 只属于登录过 ZCode 的账号；
//! 总开关 ZCODE_START_PLAN=0。

use chrono::{DateTime, Local};
use serde_json::Value;

use super::glm_reset::{load_zcode_credentials, zcode_headers};
use super::http::get_json_headers;
use super::util::env_timeout;
use crate::accounts::AccountProfile;
use crate::settings::{env_enabled, env_value, read_json};

const ZCODE_PLAN_BALANCE_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/balance";
const ZCODE_PLAN_CURRENT_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/current";
const ZCODE_APP_VERSION: &str = "3.16.3";

/// 设备标识：onboarding-record.json 与 credentials.json 同在 ~/.zcode/v2 下，
/// 由凭证路径反推同目录读取；缺失返回 None（回退 current 接口）。
fn device_mid(profile: &AccountProfile) -> Option<String> {
    let creds_path = crate::accounts::glm_reset_credentials_path(profile)?;
    let record = creds_path.parent()?.join("onboarding-record.json");
    let value = read_json(&record).ok()?;
    let mid = value.get("deviceMid").and_then(|v| v.as_str())?.trim();
    if mid.is_empty() {
        None
    } else {
        Some(mid.to_string())
    }
}

/// 优先级辅助：active 套餐中 priority 数值大者优先。
fn active_plan(payload: &Value) -> Option<&Value> {
    let plans = payload.get("plans").and_then(|v| v.as_array())?;
    let mut candidates: Vec<&Value> = plans
        .iter()
        .filter(|p| p.get("status").and_then(|s| s.as_str()) == Some("active"))
        .collect();
    if candidates.is_empty() {
        return None;
    }
    candidates.sort_by_key(|p| p.get("priority").and_then(|v| v.as_i64()).unwrap_or(0));
    candidates.last().copied()
}

/// 归一化：balance 形态（balances 桶）产出逐模型进度窗口 + 剩余量行；
/// current 形态（entitlements）只有授予量，走数字行兜底。纯函数供测试覆盖。
pub fn normalize_start_plan(data: &Value, now: DateTime<Local>) -> Option<Value> {
    let payload = data.get("data").filter(|v| v.is_object())?;
    let plan = active_plan(payload)?;
    let plan_name = plan
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Start Plan")
        .to_string();

    let mut lines = Vec::new();
    let mut windows = Vec::new();

    // balance 形态：逐模型用量桶 → 进度窗口 + 剩余量数字行
    for bucket in payload
        .get("balances")
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
    {
        let total = bucket.get("total_units").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if total <= 0.0 {
            continue;
        }
        let used = bucket.get("used_units").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let name = bucket
            .get("show_name")
            .and_then(|v| v.as_str())
            .unwrap_or("model")
            .to_string();
        windows.push(serde_json::json!({
            "label": format!("Start · {name}"),
            "used_percent": (used * 100.0 / total).clamp(0.0, 100.0),
            "usage": format!("{u:.1}M/{t:.0}M", u = used / 1e6, t = total / 1e6),
            "reset_after_seconds": bucket
                .get("expires_at")
                .and_then(|v| v.as_i64())
                .map(|at| (at - now.timestamp()).max(0)),
            "window_seconds": Value::Null,
        }));
        let remaining = bucket
            .get("remaining_units")
            .and_then(|v| v.as_f64())
            .unwrap_or(total - used);
        lines.push(format!(
            "Start {name}: {r:.1}M / {t:.0}M left",
            r = remaining / 1e6,
            t = total / 1e6
        ));
    }

    // current 形态（或 balance 无桶时的兜底）：授予量数字行
    if lines.is_empty() {
        for ent in plan
            .get("entitlements")
            .and_then(|v| v.as_array())
            .into_iter()
            .flatten()
        {
            let grant = ent.get("grant_units").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if grant <= 0.0 {
                continue;
            }
            let name = ent
                .get("show_name")
                .and_then(|v| v.as_str())
                .unwrap_or("model");
            lines.push(format!("Start {name}: {g:.0}M granted", g = grant / 1e6));
        }
    }
    if lines.is_empty() && windows.is_empty() {
        return None;
    }
    // 套餐到期（one_time 套餐到期即整体失效）
    if let Some(ends_at) = plan.get("ends_at").and_then(|v| v.as_i64()) {
        let days = ((ends_at - now.timestamp()) / 86400).max(0);
        lines.push(format!("Start plan ends in {days}d"));
    }
    Some(serde_json::json!({
        "plan_name": plan_name,
        "windows": windows,
        "lines": lines,
    }))
}

fn plan_get(
    url: &str,
    headers: &[(String, String)],
    use_proxy: bool,
    timeout_secs: u64,
) -> Option<Value> {
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let response = get_json_headers(url, &refs, use_proxy, timeout_secs).ok()?;
    if response.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return None;
    }
    Some(response)
}

/// 采集 Start Plan：优先 balance（带已用量），回退 current（仅授予量）；
/// 失败/无凭证/无生效套餐一律 None（不影响主配额）。
pub fn collect_start_plan(profile: &AccountProfile) -> Option<Value> {
    if !env_enabled("ZCODE_START_PLAN", true) {
        return None;
    }
    let (jwt, maas) = load_zcode_credentials(profile)?;
    let mut headers = zcode_headers(&jwt, &maas).to_vec();
    if let Some(mid) = device_mid(profile) {
        headers.push(("X-Device-Mid".to_string(), mid));
    }
    let use_proxy = env_enabled("GLM_USE_PROXY", true);
    let timeout = env_timeout("GLM_RESET_TIMEOUT", 8);

    // balance（带用量桶）：需要设备标识；网关校验失败静默降级
    if headers.len() > 4 {
        let url = env_value("ZCODE_PLAN_BALANCE_URL")
            .unwrap_or_else(|| ZCODE_PLAN_BALANCE_URL.into());
        if let Some(response) =
            plan_get(&format!("{url}?app_version={ZCODE_APP_VERSION}"), &headers, use_proxy, timeout)
        {
            if let Some(normalized) = normalize_start_plan(&response, Local::now()) {
                if normalized.get("windows").and_then(|v| v.as_array()).is_some_and(|a| !a.is_empty()) {
                    return Some(normalized);
                }
            }
        }
    }

    // current 回退：授予量口径
    let url = env_value("ZCODE_PLAN_CURRENT_URL").unwrap_or_else(|| ZCODE_PLAN_CURRENT_URL.into());
    let response = plan_get(&format!("{url}?app_version={ZCODE_APP_VERSION}"), &headers, use_proxy, timeout)?;
    normalize_start_plan(&response, Local::now())
}
