//! 会员到期手动配置（config.json 小节）→ membership；手动配置优先于订阅查询结果。
//!
//! 解析与到期计算只有 `normalized_manual_entry` 一处实现：配额账户 attach
//! 与 /api/settings 的设置页回填共用，避免两套解析逻辑漂移（v0.7.7 修复：
//! 设置页保存后回填为空即因两处口径不一）。

use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::Value;

use super::util::{add_calendar_months_utc, iso_seconds};

/// 指定 provider 的归一化手动会员条目：无配置返回 None；配置存在但解析失败
/// 返回 {"error": ...}（文案沿用旧版 attach，前端按 error 分支展示）。
pub(crate) fn normalized_manual_entry(provider: &str) -> Option<Value> {
    let section = crate::settings::membership_section(provider)?;
    if let Some(error) = section.get("error") {
        return Some(serde_json::json!({ "error": error }));
    }
    let purchased_text = section
        .get("membership_purchased_at")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    // RFC3339 直接解析；naive 日期按本机时区解释（datetime-local 控件不带时区）。
    // 接受的 naive 格式与 settings::update_membership_config 的写入校验保持一致。
    let purchased_at = DateTime::parse_from_rfc3339(purchased_text).or_else(|_| {
        let mut naive = Err(());
        for format in [
            "%Y-%m-%dT%H:%M",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%Y-%m-%d %H:%M:%S",
        ] {
            if let Ok(parsed) = chrono::NaiveDateTime::parse_from_str(purchased_text, format) {
                naive = Ok(parsed);
                break;
            }
        }
        naive
            .map(|naive| {
                Local
                    .from_local_datetime(&naive)
                    .single()
                    .unwrap_or_else(|| Local.from_local_datetime(&naive).earliest().unwrap())
            })
            .map(|dt| dt.fixed_offset())
    });
    let Ok(purchased_at) = purchased_at else {
        return Some(
            serde_json::json!({ "error": format!("Invalid membership_purchased_at in config.json: {purchased_text}") }),
        );
    };
    let months = section
        .get("membership_duration_months")
        .and_then(|v| v.as_i64())
        .unwrap_or(1)
        .max(1);
    let ends_at = add_calendar_months_utc(purchased_at.with_timezone(&Utc), months);
    Some(serde_json::json!({
        "purchased_at": iso_seconds(purchased_at.with_timezone(&Local)),
        "duration_months": months,
        "ends_at": iso_seconds(ends_at.with_timezone(&Local)),
        "end_after_seconds": (ends_at - Utc::now()).num_seconds(),
        "source": "manual",
    }))
}

/// 返回 true 表示已处理（含配置解析失败写 error 的情况），调用方不再附加订阅结果。
pub fn attach_manual_membership(account: &mut Value, provider: &str) -> bool {
    let Some(entry) = normalized_manual_entry(provider) else {
        return false;
    };
    account["membership"] = entry;
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 归一化形状与无效日期 error 共用一条用例：AI_USAGE_CONFIG_PATH 是进程级
    /// 环境变量，拆成并行测试会互相踩（cargo test 默认多线程）。
    #[test]
    fn normalized_manual_entry_shape_and_error() {
        let dir =
            std::env::temp_dir().join(format!("env-tools-membership-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("config.json");
        std::env::set_var("AI_USAGE_CONFIG_PATH", &config);

        std::fs::write(&config, r#"{"openai":{"membership_purchased_at":"2026-09-20T15:30","membership_duration_months":12}}"#)
            .unwrap();
        let entry = normalized_manual_entry("openai").expect("configured provider yields entry");
        assert_eq!(entry["source"], "manual");
        assert_eq!(entry["duration_months"], 12);
        // naive 时间按本机时区补齐为 RFC3339 带偏移；到期 = 购买日 + 12 个自然月
        assert!(entry["purchased_at"]
            .as_str()
            .unwrap()
            .starts_with("2026-09-20T15:30:00"));
        assert!(entry["ends_at"]
            .as_str()
            .unwrap()
            .starts_with("2027-09-20T15:30:00"));
        assert!(entry["end_after_seconds"].as_i64().unwrap() > 0);
        // 无配置的 provider 不出现在结果里
        assert!(normalized_manual_entry("glm").is_none());

        std::fs::write(&config, r#"{"openai":{"membership_purchased_at":"not-a-date","membership_duration_months":12}}"#)
            .unwrap();
        let entry = normalized_manual_entry("openai").unwrap();
        assert_eq!(
            entry["error"].as_str().unwrap(),
            "Invalid membership_purchased_at in config.json: not-a-date"
        );

        std::env::remove_var("AI_USAGE_CONFIG_PATH");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
