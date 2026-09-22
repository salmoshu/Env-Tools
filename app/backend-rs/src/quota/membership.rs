//! 会员到期手动配置（config.json 小节）→ membership；手动配置优先于订阅查询结果。

use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::Value;

use super::util::{add_calendar_months_utc, iso_seconds};

/// 返回 true 表示已处理（含配置解析失败写 error 的情况），调用方不再附加订阅结果。
pub fn attach_manual_membership(account: &mut Value, provider: &str) -> bool {
    let Some(section) = crate::settings::membership_section(provider) else {
        return false;
    };
    if let Some(error) = section.get("error") {
        account["membership"] = serde_json::json!({ "error": error });
        return true;
    }
    let purchased_text = section.get("membership_purchased_at").and_then(|v| v.as_str()).unwrap_or("");
    let purchased_at = DateTime::parse_from_rfc3339(purchased_text)
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
