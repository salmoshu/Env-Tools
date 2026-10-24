//! ZCode Start Plan 额度（v0.7.41）：把 ZCode 客户端「bigmodel-start-plan」
//! 通道的套餐信息并入 GLM 套餐卡展示。
//!
//! 接口逆向自 ZCode 桌面客户端（coding-plan-availability 模块）：
//!   GET https://zcode.z.ai/api/v1/zcode-plan/billing/current?app_version=<v>
//!   认证与重置卡同源：ZCode 本机凭证三头（jwt / bigmodel token / target）。
//! 响应 data.plans[]：生效套餐（name/status/ends_at/entitlements[]，每项含
//! show_name 与 grant_tokens，单位 token）。
//!
//! 同族 /billing/balance 能给出逐模型「已用/剩余」，但网关要求未知的设备
//! 签名（参数扫过 15 组头部/查询/Cookie 组合均 3001 parameter error），
//! 当前用 current 的授予量口径；normalize 同时兼容 balance 形态的
//! balances[] 桶，日后打通即自动切换出进度条。
//!
//! 无生效套餐 / 凭证缺失 / 接口异常一律返回 None 静默跳过——Start Plan
//! 只属于登录过 ZCode 的账号。总开关 ZCODE_START_PLAN=0。

use chrono::{DateTime, Local};
use serde_json::Value;

use super::glm_reset::{load_zcode_credentials, zcode_headers};
use super::http::get_json_headers;
use super::util::env_timeout;
use crate::accounts::AccountProfile;
use crate::settings::{env_enabled, env_value};

const ZCODE_PLAN_CURRENT_URL: &str = "https://zcode.z.ai/api/v1/zcode-plan/billing/current";
const ZCODE_APP_VERSION: &str = "3.16.3";

/// 优先级辅助：entitlement priority 数值大者优先展示。
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

/// 归一化：current 形态给数字行（套餐名/到期/各模型授予量）；
/// balance 形态（data.balances 桶）额外产出进度窗口。纯函数供测试覆盖。
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
            "usage": format!("{used:.0}M/{total:.0}M", used = used / 1e6, total = total / 1e6),
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
            "Start {name}: {r:.0}M / {t:.0}M left",
            r = remaining / 1e6,
            t = total / 1e6
        ));
    }

    // current 形态（或 balance 无桶时的兜底）：授予量数字行 + 到期
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
            lines.push(format!("Start {name}: {:.0}M granted", grant / 1e6));
        }
    }
    if lines.is_empty() && windows.is_empty() {
        return None;
    }
    // 套餐到期附在首行（one_time 套餐到期即整体失效）
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

/// 采集 Start Plan；失败/无凭证/无生效套餐一律 None（不影响主配额）。
pub fn collect_start_plan(profile: &AccountProfile) -> Option<Value> {
    if !env_enabled("ZCODE_START_PLAN", true) {
        return None;
    }
    let (jwt, maas) = load_zcode_credentials(profile)?;
    let base = env_value("ZCODE_PLAN_CURRENT_URL").unwrap_or_else(|| ZCODE_PLAN_CURRENT_URL.into());
    let url = format!("{base}?app_version={ZCODE_APP_VERSION}");
    let headers = zcode_headers(&jwt, &maas);
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let response = get_json_headers(
        &url,
        &refs,
        env_enabled("GLM_USE_PROXY", true),
        env_timeout("GLM_RESET_TIMEOUT", 8),
    )
    .ok()?;
    if response.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return None;
    }
    normalize_start_plan(&response, Local::now())
}
