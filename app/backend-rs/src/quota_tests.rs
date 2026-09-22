//! DeepSeek / GLM 配额引擎测试：夹具与期望值与
//! usage_monitor.py 的 test_usage_monitor 同名用例一一对应。

use crate::quota::{
    normalize_deepseek, normalize_glm, normalize_glm_subscription, normalize_reset_status,
};
use chrono::TimeZone;

#[test]
fn deepseek_balance_becomes_usage_window() {
    let result = normalize_deepseek(&serde_json::json!({
        "is_available": true,
        "balance_infos": [
            {"currency": "CNY", "total_balance": "20.00", "granted_balance": "5.00", "topped_up_balance": "15.00"}
        ],
    }));
    let window = &result["windows"][0];
    // 余额 20 → 使用量 30 / 上限 50 = 60%
    assert!((window["used_percent"].as_f64().unwrap() - 60.0).abs() < 1e-9);
    assert_eq!(window["usage"], "¥30.00");
    let extra = result["extra_lines"].as_array().unwrap();
    assert!(extra.iter().any(|l| l == "Balance: ¥20.00 / ¥50.00"));
    assert!(extra.iter().any(|l| l == "Usage: ¥30.00 / ¥50.00"));
    assert!(extra
        .iter()
        .any(|l| l == "Granted: ¥5.00   Topped-up: ¥15.00"));
}

#[test]
fn deepseek_unavailable_clamps_to_full() {
    let result = normalize_deepseek(&serde_json::json!({
        "is_available": false,
        "balance_infos": [
            {"currency": "CNY", "total_balance": "0.00", "granted_balance": "0.00", "topped_up_balance": "0.00"}
        ],
    }));
    // 余额 0 → 使用量 50 / 50 = 100%
    assert!((result["windows"][0]["used_percent"].as_f64().unwrap() - 100.0).abs() < 1e-9);
    let extra = result["extra_lines"].as_array().unwrap();
    assert!(extra
        .iter()
        .any(|l| l.as_str().unwrap().contains("Account unavailable")));
}

#[test]
fn glm_coding_plan_quota_display() {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let result = normalize_glm(&serde_json::json!({
        "code": 200,
        "success": true,
        "data": {
            "level": "pro",
            "limits": [
                {"type": "TIME_LIMIT", "percentage": 7, "usage": 1000,
                 "currentValue": 72, "remaining": 928},
                {"type": "CREDIT_LIMIT", "unit": 3, "number": 5, "percentage": 44,
                 "usage": 2000, "currentValue": 880, "remaining": 1120,
                 "nextResetTime": now_ms + 3_600_000},
                {"type": "CREDIT_LIMIT", "unit": 6, "number": 1, "percentage": 53,
                 "usage": 10000, "currentValue": 5300, "remaining": 4700,
                 "nextResetTime": now_ms + 3 * 86_400_000},
            ],
        },
    }));

    assert_eq!(result["provider"], "GLM");
    assert_eq!(result["plan"], "Coding Pro");
    let windows = result["windows"].as_array().unwrap();
    let labels: Vec<&str> = windows
        .iter()
        .map(|w| w["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["5h Window", "7d Window", "Tools Quota"]);
    let five_hour = &windows[0];
    assert!((five_hour["used_percent"].as_f64().unwrap() - 44.0).abs() < 1e-9);
    assert_eq!(five_hour["window_seconds"], 5 * 3600);
    let reset = five_hour["reset_after_seconds"].as_i64().unwrap();
    assert!((reset - 3600).abs() <= 5);
    assert_eq!(five_hour["usage"], "880/2000");
    let weekly = &windows[1];
    assert!((weekly["used_percent"].as_f64().unwrap() - 53.0).abs() < 1e-9);
    assert_eq!(weekly["window_seconds"], 7 * 86400);
    let tools = &windows[2];
    assert!((tools["used_percent"].as_f64().unwrap() - 7.0).abs() < 1e-9);
    assert_eq!(tools["usage"], "72/1000");
    let extra = result["extra_lines"].as_array().unwrap();
    assert!(extra.iter().any(|l| l == "5h Window remaining: 1120/2000"));
    assert!(extra.iter().any(|l| l == "7d Window remaining: 4700/10000"));
    assert!(extra.iter().any(|l| l == "Tools remaining: 928/1000"));
}

#[test]
fn glm_token_limits_fallback_sorted_by_reset_time() {
    // unit/number 缺失时按重置时间排序：近的为 5 小时窗口
    let now_ms = chrono::Utc::now().timestamp_millis();
    let result = normalize_glm(&serde_json::json!({
        "data": {
            "limits": [
                {"type": "TOKENS_LIMIT", "percentage": 80, "nextResetTime": now_ms + 5 * 86_400_000},
                {"type": "TOKENS_LIMIT", "percentage": 20, "nextResetTime": now_ms + 1_800_000},
            ],
        },
    }));
    let windows = result["windows"].as_array().unwrap();
    let labels: Vec<&str> = windows
        .iter()
        .map(|w| w["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["5h Window", "7d Window"]);
    assert!((windows[0]["used_percent"].as_f64().unwrap() - 20.0).abs() < 1e-9);
    assert!((windows[1]["used_percent"].as_f64().unwrap() - 80.0).abs() < 1e-9);
}

#[test]
fn glm_percentage_one_is_one_percent() {
    let result = normalize_glm(&serde_json::json!({
        "data": {
            "limits": [
                {"type": "CREDIT_LIMIT", "unit": 6, "number": 1,
                 "percentage": 1, "usage": 10000, "currentValue": 100, "remaining": 9900},
            ],
        },
    }));
    assert!((result["windows"][0]["used_percent"].as_f64().unwrap() - 1.0).abs() < 1e-9);
}

#[test]
fn glm_subscription_membership_shape() {
    let result = normalize_glm_subscription(
        &serde_json::json!({
            "success": true,
            "data": [
                {
                    "status": "VALID",
                    "inCurrentPeriod": true,
                    "valid": "2026-12-03 10:00:00-2027-03-03 10:00:00",
                    "purchaseTime": "2026-12-03 09:30:00",
                    "billingCycle": "quarterly",
                    "autoRenew": true,
                }
            ],
        }),
        chrono::Local
            .with_ymd_and_hms(2026, 12, 1, 12, 0, 0)
            .unwrap(),
    )
    .expect("subscription should normalize");
    assert_eq!(
        result["ends_at"].as_str().unwrap()[..10].to_string(),
        "2026-12-03"
    );
    assert_eq!(result["duration_months"], 3);
    assert_eq!(result["auto_renew"], true);
    // end_after_seconds 为正值（终止时刻在未来）
    assert!(result["end_after_seconds"].as_i64().unwrap() > 0);
}

#[test]
fn codex_windows_map_to_5h_and_7d() {
    let now = chrono::Utc::now().timestamp();
    let result = crate::quota::normalize_codex(&serde_json::json!({
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": {"used_percent": 12.5, "limit_window_seconds": 18000, "reset_at": now + 3600},
            "secondary_window": {"used_percent": 34, "limit_window_seconds": 604800, "reset_at": now + 86400},
        },
        "credits": {"balance": "10.5"},
    }));
    assert_eq!(result["provider"], "OpenAI Codex");
    assert_eq!(result["plan"], "plus");
    let windows = result["windows"].as_array().unwrap();
    let labels: Vec<&str> = windows
        .iter()
        .map(|w| w["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["5h Window", "7d Window"]);
    assert!((windows[0]["used_percent"].as_f64().unwrap() - 12.5).abs() < 1e-9);
    // reset_at 推算 reset_after_seconds
    let reset = windows[0]["reset_after_seconds"].as_i64().unwrap();
    assert!((reset - 3600).abs() <= 5);
    assert_eq!(windows[1]["window_seconds"], 604800);
}

#[test]
fn codex_reset_credits_normalize_to_snake_case() {
    let result = crate::quota::normalize_codex(&serde_json::json!({
        "rateLimitResetCredits": {"availableCount": "7", "applicableAvailableCount": 3},
    }));
    let credits = &result["rate_limit_reset_credits"];
    assert_eq!(credits["available_count"], 7);
    assert_eq!(credits["applicable_available_count"], 3);
}

#[test]
fn kimi_limits_normalize_window_labels() {
    let result = crate::quota::normalize_kimi(&serde_json::json!({
        "limits": [
            {"window": {"duration": 300, "timeUnit": "minute"},
             "detail": {"used_percent": 40, "limit_window_seconds": 18000}},
            {"window": {"duration": 2, "timeUnit": "hour"},
             "detail": {"remaining": 60, "limit": 100}},
        ],
        "usage": {"used_percent": 7, "reset_after_seconds": 1000},
        "user": {"membership": {"level": "allegro"}},
    }));
    assert_eq!(result["provider"], "Kimi Code");
    assert_eq!(result["plan"], "allegro");
    let windows = result["windows"].as_array().unwrap();
    let labels: Vec<&str> = windows
        .iter()
        .map(|w| w["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, ["5h Window", "2h Window", "7d Window"]);
    // remaining/limit 口径：(100 - 60) / 100 = 40%
    assert!((windows[1]["used_percent"].as_f64().unwrap() - 40.0).abs() < 1e-9);
    assert_eq!(windows[2]["reset_after_seconds"], 1000);
}

#[test]
fn glm_reset_cards_filter_sort_and_format() {
    let now = chrono::Local
        .with_ymd_and_hms(2026, 9, 22, 12, 0, 0)
        .unwrap();
    let now_ms = now.timestamp() * 1000;
    let result = normalize_reset_status(
        &serde_json::json!({
            "available_five_hour_resets": [
                {"expire_at": now_ms + 86_400_000},
                {"expire_at": now_ms + 3_600_000},
                {"expire_at": now_ms - 60_000}
            ],
            "available_week_resets": [{"expire_at": now_ms + 7 * 86_400_000}],
            "latest_five_hour_reset_history": {"used_at": now_ms - 86_400_000},
            "latest_week_reset_history": null,
            "has_unread_history": false
        }),
        now,
    );
    let five = result["five_hour"].as_array().unwrap();
    // 已过期卡片被过滤，剩余按到期升序
    assert_eq!(five.len(), 2);
    assert_eq!(five[0]["expire_after_seconds"].as_i64().unwrap(), 3600);
    assert_eq!(five[1]["expire_after_seconds"].as_i64().unwrap(), 86400);
    assert!(five[0]["expire_at"]
        .as_str()
        .unwrap()
        .starts_with("2026-09-22T13:00:00"));
    let week = result["week"].as_array().unwrap();
    assert_eq!(week.len(), 1);
    assert!(result["latest_five_hour_used_at"]
        .as_str()
        .unwrap()
        .starts_with("2026-09-21"));
    assert!(result["latest_week_used_at"].is_null());
    assert_eq!(result["has_unread_history"], false);
}

#[test]
fn glm_reset_cards_empty_response() {
    let now = chrono::Local
        .with_ymd_and_hms(2026, 9, 22, 12, 0, 0)
        .unwrap();
    let result = normalize_reset_status(
        &serde_json::json!({
            "available_five_hour_resets": [],
            "available_week_resets": [],
            "latest_five_hour_reset_history": null,
            "latest_week_reset_history": null,
            "has_unread_history": true
        }),
        now,
    );
    assert_eq!(result["five_hour"].as_array().unwrap().len(), 0);
    assert_eq!(result["week"].as_array().unwrap().len(), 0);
    assert_eq!(result["has_unread_history"], true);
}
