//! 原生分析引擎测试：与原 Python 实现的 AnalyticsTests
//! 口径一一对应（时间戳规整、Codex 增量拆分、agent 归因、聚合、增量扫描）。

use std::path::Path;

use chrono::TimeZone;

use crate::analytics::{agent_of, AnalyticsState, Source};

fn kimi_line(
    ts: i64,
    model: &str,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
) -> String {
    format!(
        r#"{{"type":"usage.record","usageScope":"turn","time":{ts},"model":"{model}","usage":{{"inputOther":{input},"output":{output},"inputCacheRead":{cache_read},"inputCacheCreation":{cache_creation}}}}}"#
    )
}

fn codex_token_line(
    input_tokens: i64,
    cached: i64,
    cache_write: i64,
    output: i64,
    iso: &str,
) -> String {
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
    assert_eq!(
        agent_of(Source::Kimi, "deepseek/deepseek-v4-flash"),
        "deepseek"
    );
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

/// codex rollout 行构造器：顶层 type + payload，毫秒级时间戳
fn cx_line(iso: &str, top: &str, payload: &str) -> String {
    format!(r#"{{"timestamp":"{iso}","type":"{top}","payload":{payload}}}"#)
}

fn cx_usage(iso: &str, output: i64) -> String {
    cx_line(
        iso,
        "token_usage_record",
        &format!(r#"{{"usage":{{"input_tokens":10,"output_tokens":{output}}}}}"#),
    )
}

fn cx_token_count(iso: &str, output: i64) -> String {
    cx_line(
        iso,
        "event_msg",
        &format!(
            r#"{{"type":"token_count","info":{{"last_token_usage":{{"input_tokens":10,"cached_input_tokens":0,"output_tokens":{output}}},"total_token_usage":{{"input_tokens":10,"output_tokens":{output}}}}}}}"#
        ),
    )
}

#[test]
fn codex_tpot_pairs_usage_record_with_token_count() {
    let dir = tempfile_dir();
    let home = dir.join("home");
    let rollout = home
        .join(".codex")
        .join("sessions")
        .join("2026")
        .join("09")
        .join("26")
        .join("rollout-2026-09-26T08-00-00-01a0test-0000-0000-00000000cafe.jsonl");
    let lines = vec![
        cx_line("2026-09-26T08:00:00.000Z", "session_meta", r#"{"cwd":"/home/u/proj"}"#),
        cx_line("2026-09-26T08:00:00.100Z", "event_msg", r#"{"type":"task_started"}"#),
        cx_line("2026-09-26T08:00:00.200Z", "response_item", r#"{"type":"message","role":"user"}"#),
        cx_line("2026-09-26T08:00:02.000Z", "response_item", r#"{"type":"reasoning"}"#),
        // R1：用户消息 00.200 → 响应完成 04.000，生成 3.8s
        cx_usage("2026-09-26T08:00:04.000Z", 100),
        cx_line("2026-09-26T08:00:06.000Z", "response_item", r#"{"type":"custom_tool_call_output"}"#),
        cx_token_count("2026-09-26T08:00:06.100Z", 100),
        // R2：工具产出 06.000 是新起点（而非 R1 完成时刻），生成 1.5s
        cx_line("2026-09-26T08:00:07.000Z", "response_item", r#"{"type":"reasoning"}"#),
        cx_usage("2026-09-26T08:00:07.500Z", 50),
        cx_token_count("2026-09-26T08:00:07.600Z", 50),
        // R3：间隔 10 分钟的空闲由用户消息边界截断，只计 2.0s
        cx_line("2026-09-26T08:10:00.000Z", "response_item", r#"{"type":"message","role":"user"}"#),
        cx_usage("2026-09-26T08:10:02.000Z", 10),
        cx_token_count("2026-09-26T08:10:02.100Z", 10),
        // R4：span 超过 1h 上限（边界 10:00:03 → 完成 12:00:03），丢弃
        cx_line("2026-09-26T08:10:03.000Z", "response_item", r#"{"type":"function_call_output"}"#),
        cx_usage("2026-09-26T12:00:03.000Z", 5),
        cx_token_count("2026-09-26T12:00:03.100Z", 5),
    ];
    write_file(&rollout, &lines);

    let mut state = AnalyticsState::default();
    assert!(state.scan(&[], &[home.join(".codex")], &[], 1_790_900_000));
    let records: Vec<_> = state
        .files
        .values()
        .flat_map(|f| f.records.iter())
        .collect();
    assert_eq!(records.len(), 4, "四条 token_count 记录");
    let assert_close = |got: f64, want: f64| {
        assert!((got - want).abs() < 0.01, "gen_seconds {got} != {want}");
    };
    assert_close(records[0].gen_seconds, 3.8);
    assert_close(records[1].gen_seconds, 1.5);
    assert_close(records[2].gen_seconds, 2.0);
    assert_close(records[3].gen_seconds, 0.0);

    // 端到端：gen_rate = Σoutput / Σspan = 165 / 7.3
    let now = chrono::Local
        .with_ymd_and_hms(2026, 9, 26, 20, 0, 0)
        .unwrap();
    let all = state.aggregate(7, "all", now);
    let sessions = all["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1);
    let gen_rate = sessions[0]["gen_rate"].as_f64().unwrap();
    assert!(
        (gen_rate - 165.0 / 7.3).abs() < 0.05,
        "gen_rate {gen_rate} != {}",
        165.0 / 7.3
    );
    // 会话寿命吞吐（旧口径）仍可用：分母是首末记录差
    assert!(sessions[0]["rate"].as_f64().unwrap() < 1.0);
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
        format!(
            r#"{{"sessionId":"session_a","workDir":"/w/a/projects/demo"}}
"#
        ),
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

#[test]
fn rate_card_shows_latest_requested_model() {
    let dir = tempfile_dir();
    let home = dir.join("home");
    let wire = home
        .join(".kimi-code")
        .join("sessions")
        .join("session_a")
        .join("wire.jsonl");
    let ts = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 8, 0, 0)
        .unwrap()
        .timestamp();
    write_file(
        &wire,
        &[
            // 旧模型贡献绝大部分 token，最新一条记录才换用新模型：
            // 速率卡模型应跟随最近一次请求，而非 token 占比最高者
            kimi_line(ts, "kimi-code/k3-256k", 100_000, 0, 0, 0),
            kimi_line(ts + 60, "kimi-code/k3", 10, 0, 0, 0),
        ],
    );
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("session_index.jsonl"),
        "{\"sessionId\":\"session_a\",\"workDir\":\"/w/a/projects/demo\"}\n",
    )
    .unwrap();

    let mut state = AnalyticsState::default();
    state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000);
    let now = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 12, 0, 0)
        .unwrap();
    let all = state.aggregate(7, "all", now);
    assert_eq!(
        all["kpi"]["rate"]["latest_sessions"][0]["model"],
        "kimi-code/k3"
    );
    // token 占比口径仍保留在 model_rank（k3-256k 居首）
    assert_eq!(all["model_rank"][0]["model"], "kimi-code/k3-256k");
}

#[test]
fn scan_cache_roundtrip_survives_restart() {
    let dir = tempfile_dir();
    let home = dir.join("home");
    let wire = home
        .join(".kimi-code")
        .join("sessions")
        .join("session_a")
        .join("wire.jsonl");
    let ts = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 8, 0, 0)
        .unwrap()
        .timestamp();
    write_file(&wire, &[kimi_line(ts, "m1", 100, 10, 0, 0)]);
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("session_index.jsonl"),
        "{\"sessionId\":\"session_a\",\"workDir\":\"/w/a/projects/demo\"}\n",
    )
    .unwrap();
    let cache = dir.join("scan-cache-local.json");
    let now = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 12, 0, 0)
        .unwrap();

    // 第一个"进程"：缓存不存在时水合静默跳过，冷扫后落盘
    let mut first = AnalyticsState::default();
    first.hydrate_once(&cache);
    first.scan(&[home.join(".kimi-code")], &[], &[], now.timestamp());
    first.save_cache(&cache);
    let cold = first.aggregate(7, "all", now);
    assert_eq!(cold["kpi"]["today_total"], 110);

    // 第二个"进程"：水合 → 扫描读 0 新字节 → 结果一致、记录不翻倍
    let mut second = AnalyticsState::default();
    second.hydrate_once(&cache);
    second.scan(&[home.join(".kimi-code")], &[], &[], now.timestamp());
    let warm = second.aggregate(7, "all", now);
    assert_eq!(warm["kpi"]["today_total"], 110);
    assert_eq!(warm["kpi"]["active_sessions"], 1);
    assert_eq!(warm["sessions"].as_array().unwrap().len(), 1);

    // 追加一条后第三个"进程"只读增量字节：总量正确累加
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&wire)
        .unwrap();
    writeln!(file, "{}", kimi_line(ts + 3600, "m1", 50, 5, 0, 0)).unwrap();
    drop(file);
    let mut third = AnalyticsState::default();
    third.hydrate_once(&cache);
    third.scan(&[home.join(".kimi-code")], &[], &[], now.timestamp());
    let appended = third.aggregate(7, "all", now);
    assert_eq!(appended["kpi"]["today_total"], 165);
}

#[test]
fn rate_card_prefers_main_agent_over_subagent() {
    let dir = tempfile_dir();
    let home = dir.join("home");
    let base = home
        .join(".kimi-code")
        .join("sessions")
        .join("session_a")
        .join("agents");
    let ts = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 8, 0, 0)
        .unwrap()
        .timestamp();
    // 主代理 8:00 已切到 k3；子代理 9:00 仍带切换前的旧模型产记录（更新但不算数）
    write_file(
        &base.join("main").join("wire.jsonl"),
        &[kimi_line(ts, "kimi-code/k3", 10, 0, 0, 0)],
    );
    write_file(
        &base.join("agent-9").join("wire.jsonl"),
        &[kimi_line(ts + 3600, "kimi-code/k3-256k", 100_000, 0, 0, 0)],
    );
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(
        home.join("session_index.jsonl"),
        "{\"sessionId\":\"session_a\",\"workDir\":\"/w/a/projects/demo\"}\n",
    )
    .unwrap();

    let mut state = AnalyticsState::default();
    state.scan(&[home.join(".kimi-code")], &[], &[], 1_789_100_000);
    let now = chrono::Local
        .with_ymd_and_hms(2026, 9, 16, 12, 0, 0)
        .unwrap();
    let all = state.aggregate(7, "all", now);
    assert_eq!(
        all["kpi"]["rate"]["latest_sessions"][0]["model"], "kimi-code/k3",
        "主代理模型优先于时间更新的子代理"
    );
}
