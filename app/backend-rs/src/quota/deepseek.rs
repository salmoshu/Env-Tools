//! DeepSeek：API key 直连余额查询，官方口径展示。
//!
//! v0.7.41 起弃用「固定 ¥50/月」的伪用量窗口：官方 API 只有
//! /user/balance（充值余额 / 赠送余额 / 总余额），无任何用量或消费
//! 记录端点，因此卡片改为纯数字展示——充值、赠送、累计消费三项对齐
//! 官方控制台。累计消费官方也不提供，本地按「相邻两次采集的余额
//! 净减少量」累计（充值造成的负增量不计），从首次跟踪起算。

use serde_json::Value;
use std::path::PathBuf;

use super::http::get_json;
use super::util::{env_timeout, fetched_now, num};
use crate::accounts::AccountProfile;
use crate::settings::{env_enabled, env_value, read_json, write_private_json};

const DEEPSEEK_BALANCE_URL: &str = "https://api.deepseek.com/user/balance";

/// 官方口径归一化：不产生伪用量窗口，仅数字行（充值/赠送/总余额）。
/// 官方字段全覆盖：币种（CNY→¥ / USD→$）与 is_available 一并透出。
pub fn normalize_deepseek(data: &Value) -> Value {
    let infos = data.get("balance_infos").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    let (total, granted, topped_up, currency) = if !infos.is_empty() {
        let balance = infos
            .iter()
            .find(|b| b.get("currency").and_then(|v| v.as_str()).unwrap_or("").to_uppercase() == "CNY")
            .unwrap_or(&infos[0]);
        (
            num(balance.get("total_balance")),
            num(balance.get("granted_balance")),
            num(balance.get("topped_up_balance")),
            balance
                .get("currency")
                .and_then(|v| v.as_str())
                .unwrap_or("CNY")
                .to_uppercase(),
        )
    } else {
        // 兼容旧抓包格式（report data 字段）
        (
            num(data.get("data").and_then(|d| d.get("balance"))),
            num(data.get("data").and_then(|d| d.get("giveAmount"))),
            num(data.get("data").and_then(|d| d.get("rechargeAmount"))),
            "CNY".to_string(),
        )
    };
    let symbol = if currency == "USD" { "$" } else { "¥" };
    let available = data
        .get("is_available")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let mut extra_lines = vec![
        format!("Topped-up: {symbol}{topped_up:.2}   Granted: {symbol}{granted:.2}"),
        format!("Total balance: {symbol}{total:.2}"),
    ];
    if !available {
        extra_lines.push("Account unavailable".to_string());
    }
    // 官方控制台口径的统计卡片（前端优先渲染，extra_lines 作兼容兜底）
    let stats = serde_json::json!([
        {"label": "Topped-up", "value": format!("{symbol}{topped_up:.2}")},
        {"label": "Granted", "value": format!("{symbol}{granted:.2}")},
        {"label": "Total", "value": format!("{symbol}{total:.2}")},
    ]);
    serde_json::json!({
        "provider": "DeepSeek",
        "plan": "API",
        "windows": [],
        "stats": stats,
        // 官方 is_available：当前账户是否有余额可供 API 调用
        "available": available,
        "extra_lines": extra_lines,
        "fetched_at": fetched_now(),
        // 消费跟踪快照字段：collect 在此基础上补 spent 追踪
        "_balance_snapshot": {
            "total": total,
            "granted": granted,
            "topped_up": topped_up,
            "currency": currency,
        },
    })
}

/// 累计消费状态文件：~/.cache/ai-usage-monitor/deepseek-spend.json（按账号分键）。
fn spend_state_path() -> PathBuf {
    crate::settings::local_home()
        .join(".cache")
        .join("ai-usage-monitor")
        .join("deepseek-spend.json")
}

/// 依据本次余额快照更新累计消费：余额净减少量（>0）计入 spent。
/// 返回 (spent, since_iso)；首次跟踪时 since 记为今天。
fn track_spend(account_id: &str, snapshot: &Value) -> (f64, String) {
    let path = spend_state_path();
    let mut state = read_json(&path).unwrap_or_else(|_| serde_json::json!({}));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let entry = state
        .get(account_id)
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "spent": 0.0, "since": today }));
    let mut spent = entry.get("spent").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let since = entry
        .get("since")
        .and_then(|v| v.as_str())
        .unwrap_or(&today)
        .to_string();
    if let Some(last) = entry.get("last_total").and_then(|v| v.as_f64()) {
        let current = snapshot.get("total").and_then(|v| v.as_f64()).unwrap_or(last);
        let delta = last - current;
        // 正增量 = 消费；负增量 = 充值/赠送入账，不冲减累计消费
        if delta > 0.0 {
            spent += delta;
        }
    }
    let updated = serde_json::json!({
        "spent": (spent * 100.0).round() / 100.0,
        "since": since,
        "last_total": snapshot.get("total").cloned().unwrap_or(Value::Null),
    });
    if let Some(obj) = state.as_object_mut() {
        obj.insert(account_id.to_string(), updated);
        let _ = write_private_json(&path, &Value::Object(obj.clone()));
    }
    ((spent * 100.0).round() / 100.0, since)
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
    // 累计消费：官方无接口，本地按余额净减少量累计（见模块注释）
    let snapshot = account
        .as_object_mut()
        .and_then(|obj| obj.remove("_balance_snapshot"))
        .unwrap_or_else(|| serde_json::json!({}));
    let (spent, since) = track_spend(&profile.id, &snapshot);
    let symbol = snapshot
        .get("currency")
        .and_then(|v| v.as_str())
        .map(|c| if c == "USD" { "$" } else { "¥" })
        .unwrap_or("¥");
    if let Some(lines) = account.get_mut("extra_lines").and_then(|v| v.as_array_mut()) {
        lines.push(Value::String(format!(
            "Spent: {symbol}{spent:.2} (tracked since {since})"
        )));
    }
    // 累计消费入第四张统计卡
    if let Some(stats) = account.get_mut("stats").and_then(|v| v.as_array_mut()) {
        stats.push(serde_json::json!({
            "label": "Spent",
            "value": format!("{symbol}{spent:.2} (since {since})"),
        }));
    }
    super::membership::attach_manual_membership(&mut account, &profile.membership_key());
    Ok(account)
}
