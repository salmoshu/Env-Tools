//! 原生分析引擎测试：与 usage_monitor.py 的 test_usage_monitor.AnalyticsTests
//! 口径一一对应（时间戳规整、Codex 增量拆分、agent 归因、聚合、增量扫描）。

use std::path::Path;

use chrono::TimeZone;

use crate::analytics::{agent_of, AnalyticsState, Source};

fn kimi_line(ts: i64, model: &str, input: i64, output: i64, cache_read: i64, cache_creation: i64) -> String {
    format!(
        r#"{{"type":"usage.record","usageScope":"turn","time":{ts},"model":"{model}","usage":{{"inputOther":{input},"output":{output},"inputCacheRead":{cache_read},"inputCacheCreation":{cache_creation}}}}}"#
    )
}

fn codex_token_line(input_tokens: i64, cached: i64, cache_write: i64, output: i64, iso: &str) -> String {
    format!(
        r#"{{"timestamp":"{iso}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":{input_tokens},"cached_input_tokens":{cached},"cache_write_input_tokens":{cache_write},"output_tokens":{output}}},"last_token_usage":{{"input_tokens":{input_tokens},"cached_input_tokens":{cached},"cache_write_input_tokens":{cache_write},"output_tokens":{output}}}}}}}}}"#
    )
}

#[test]
fn agent_attribution_matches_python_rules() {
    assert_eq!(agent_of(Source::Kimi, "kimi-code/k3-256k"), "kimi");
    assert_eq!(agent_of(Source::Codex, "gpt-5.6-sol"), "codex");
    assert_eq!(agent_of(Source::Kimi, "zai/glm-5.3-flash"), "glm");
    assert_eq!(agent_of(Source::Codex, "GLM-x"), "glm");
    assert_eq!(agent_of(Source::Kimi, "deepseek/deepseek-v4-flash"), "deepseek");
}

#[test]
fn codex_timestamp_handles_iso_z() {
    let line = codex_token_line(1000, 600, 10, 200, "2026-09-16T08:00:00.000Z");
    let expected = chrono::Utc
        .with_ymd_and_hms(2026, 9, 16, 8, 0, 0)
        .unwrap()
        .timestamp();
    let record = crate::analytics::parse_codex_token_line(&line, "gpt-5.6-sol", "codex-x")
        .expect("token line should parse");
    // 非缓存输入 = input_tokens - cached_input_tokens
    assert_eq!(record.ts, expected);
    assert_eq!(record.input, 400);
    assert_eq!(record.output, 200);
    assert_eq!(record.cache_read, 600);
    assert_eq!(record.cache_creation, 10);
}

#[test]
fn codex_cumulative_only_line_is_skipped() {
    let old_line = r#"{"timestamp":"2026-09-16T08:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":9}}}}"#;
    assert!(crate::analytics::parse_codex_token_line(old_line, "", "s").is_none());
}

#[test]
fn codex_meta_cwd_accepts_both_layouts() {
    // 旧版 CLI / Zed：顶层 type，cwd 直接在 payload（无 payload.type）
    let legacy = r#"{"timestamp":"2026-09-24T08:05:57.850Z","type":"session_meta","payload":{"session_id":"01a07c1f","id":"01a0d273","cwd":"/home/winchell/E-Wagon","originator":"zed"}}"#;
    assert_eq!(
        crate::analytics::parse_codex_meta_cwd(legacy).as_deref(),
        Some("/home/winchell/E-Wagon")
    );
    // 新版 CLI：payload.type == "session_meta"
    let wrapped = r#"{"timestamp":"2026-09-24T08:05:57.850Z","type":"event_msg","payload":{"type":"session_meta","cwd":"D:\\projects\\Env-Tools"}}"#;
    assert_eq!(
        crate::analytics::parse_codex_meta_cwd(wrapped).as_deref(),
        Some("D:\\projects\\Env-Tools")
    );
    // 非 session_meta 行 / 空 cwd 一律拒绝
    let other = r#"{"timestamp":"2026-09-24T08:05:57.850Z","type":"event_msg","payload":{"type":"token_count"}}"#;
    assert!(crate::analytics::parse_codex_meta_cwd(other).is_none());
    let empty_cwd = r#"{"type":"session_meta","payload":{"cwd":""}}"#;
    assert!(crate::analytics::parse_codex_meta_cwd(empty_cwd).is_none());
}

#[test]
fn kimi_line_normalizes_millis_and_rejects_out_of_range() {
    // 毫秒时间戳按秒解释
    let ms_line = r#"{"type":"usage.record","usageScope":"turn","time":1789000005700,"model":"m1","usage":{"inputOther":1}}"#;
    let record = crate::analytics::parse_kimi_line(ms_line).expect("ms line should parse");
    assert_eq!(record.ts, 1_789_000_005);
    // 超出合理范围的脏数据丢弃
    let huge = r#"{"type":"usage.record","usageScope":"turn","time":99999999999999,"usage":{}}"#;
    assert!(crate::analytics::parse_kimi_line(huge).is_none());
}

fn write_file(path: &Path, lines: &[String]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, lines.join("\n") + "\n").unwrap();
}

#[test]
fn scan_is_incremental_and_survives_truncation_and_deletion() {
    let dir = tempfile_dir();
    let home = dir.join("home");
    let wire = home
        .join(".kimi-code")
        .join("sessions")
        .join("session_a")
        .join("wire.jsonl");
    write_file(&wire, &[kimi_line(1_789_000_000, "m1", 100, 50, 200, 10)]);

    let mut state = AnalyticsState::default();
    assert!(state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000));
    assert_eq!(state.files.values().next().unwrap().records.len(), 1);

    // 无新增：不产生重复记录
    assert!(!state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000));
    assert_eq!(state.files.values().next().unwrap().records.len(), 1);

    // 追加后只读新增部分
    let mut content = std::fs::read_to_string(&wire).unwrap();
    content.push_str(&kimi_line(1_789_001_000, "m1", 1, 0, 0, 0));
    content.push('\n');
    std::fs::write(&wire, &content).unwrap();
    assert!(state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000));
    assert_eq!(state.files.values().next().unwrap().records.len(), 2);

    // 截断重写：旧记录作废
    std::fs::write(&wire, kimi_line(1_789_002_000, "m1", 5, 0, 0, 0) + "\n").unwrap();
    assert!(state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000));
    let records = &state.files.values().next().unwrap().records;
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].ts, 1_789_002_000);

    // 文件删除：记录保留（历史不缩水）
    std::fs::remove_file(&wire).unwrap();
    state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000);
    assert_eq!(state.files.values().next().unwrap().offset, -1);
    assert_eq!(state.files.values().next().unwrap().records.len(), 1);
}

fn tempfile_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "env-tools-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn aggregate_matches_python_contract() {
    let dir = tempfile_dir();
    let home = dir.join("home");
    let wire = home
        .join(".kimi-code")
        .join("sessions")
        .join("session_a")
        .join("wire.jsonl");
    // 时间戳按测试运行时的本地时区落在“今天”，与 Python 版测试一致
    let ts = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 8, 0, 0)
        .unwrap()
        .timestamp();
    write_file(
        &wire,
        &[
            // GLM / DeepSeek 以自定义模型接入 kimi CLI：按模型名归因
            kimi_line(ts, "kimi-for-coding", 100, 0, 0, 0),
            kimi_line(ts, "zai/glm-5.3-flash", 200, 0, 0, 0),
            kimi_line(ts, "deepseek/deepseek-v4-flash", 50, 0, 0, 0),
        ],
    );
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("session_index.jsonl"),
        format!(r#"{{"sessionId":"session_a","workDir":"/w/a/projects/demo"}}
"#),
    )
    .unwrap();

    let mut state = AnalyticsState::default();
    state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000);

    let now = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 12, 0, 0)
        .unwrap();
    let all = state.aggregate(7, "all", now);
    assert_eq!(
        all["agents"].as_array().unwrap().len(),
        3,
        "kimi/glm/deepseek 归因齐全"
    );
    let agent_rank = all["agent_rank"].as_array().unwrap();
    assert_eq!(agent_rank[0]["agent"], "glm");
    assert_eq!(agent_rank[0]["total"], 200);
    assert_eq!(agent_rank[0]["requests"], 1);

    // 单独查看 GLM
    let glm = state.aggregate(7, "glm", now);
    assert_eq!(glm["agents"].as_array().unwrap().len(), 1);
    assert_eq!(glm["kpi"]["today_total"], 200);
    assert_eq!(glm["model_rank"].as_array().unwrap().len(), 1);
    assert_eq!(glm["sessions"].as_array().unwrap()[0]["agent"], "glm");

    // KPI 汇总（窗口内全部来源）
    assert_eq!(all["kpi"]["today_total"], 350);
    assert_eq!(all["kpi"]["active_sessions"], 1);
    assert_eq!(all["daily"][6]["requests"], 3);
}
