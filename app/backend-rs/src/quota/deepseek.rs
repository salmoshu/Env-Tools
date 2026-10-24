//! DeepSeek：API key 直连余额查询（口径同原 Python 实现 normalize_deepseek）。

use serde_json::Value;

use super::http::get_json;
use super::util::{env_timeout, fetched_now, num};
use crate::accounts::AccountProfile;
use crate::settings::{env_enabled, env_value};

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const DEEPSEEK_MONTHLY_LIMIT: f64 = 50.0;

pub fn normalize_deepseek(data: &Value) -> Value {
    let infos = data.get("balance_infos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let report = data.get("data").filter(|v| v.is_object()).cloned().unwrap_or_else(|| serde_json::json!({}));
    let (total, granted, topped_up) = if !infos.is_empty() {
        let balance = infos
            .iter()
            .find(|b| b.get("currency").and_then(|v| v.as_str()).unwrap_or("").to_uppercase() == "CNY")
            .unwrap_or(&infos[0]);
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
            "reset_after_seconds": Value::Null,
            "window_seconds": Value::Null,
            "usage": format!("¥{capped:.2}"),
            "until_used_up": true,
        }],
        "extra_lines": extra_lines,
        "fetched_at": fetched_now(),
    })
}

pub fn collect(profile: &AccountProfile) -> Result<Value, String> {
    let key = crate::accounts::api_key(profile)?;
    let url = env_value("DEEPSEEK_BALANCE_URL").unwrap_or_else(|| DEEPSEEK_BALANCE_URL.into());
    let data = get_json(
        &url,
        &key,
        env_enabled("DEEPSEEK_USE_PROXY", true),
        env_timeout("DEEPSEEK_TIMEOUT", 30),
    )?;
    let mut account = normalize_deepseek(&data);
    account["account_id"] = Value::String(profile.id.clone());
    account["account_label"] = Value::String(profile.label.clone());
    super::membership::attach_manual_membership(&mut account, &profile.membership_key());
    Ok(account)
}
