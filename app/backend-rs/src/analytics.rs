//! 会话用量分析引擎（v0.4.0 起原生实现，口径与 usage_monitor.py 的
//! --analytics 完全一致）。
//!
//! 扫描 Kimi Code（~/.kimi-code/sessions/**/wire.jsonl 的 turn 级
//! usage.record）与 Codex CLI（~/.codex/sessions/**/rollout-*.jsonl 的
//! token_count 事件，取 last_token_usage 单轮增量），GLM / DeepSeek 以自定义
//! 模型接入其它 CLI，按模型名归因。与 Python 版的差异只在性能形态：解析
//! 位置（offset）保留在本进程内存中，作为常驻服务重复请求只读取新增字节。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Datelike, Local, TimeZone, Timelike};

pub const RECORD_RETENTION_DAYS: i64 = 400;
pub const SESSION_CAP: usize = 500;
pub const AGENTS: [&str; 5] = ["all", "kimi", "codex", "glm", "deepseek"];

#[derive(Clone, Copy, PartialEq)]
pub enum Source {
    Kimi,
    Codex,
}

#[derive(Clone)]
pub struct TurnRecord {
    pub ts: i64,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub sid: String,
}

#[derive(Clone)]
pub struct FileState {
    /// 已解析到的字节位置；-1 表示文件已消失（记录保留，避免历史缩水）
    pub offset: i64,
    pub records: Vec<TurnRecord>,
    pub source: Source,
    /// codex：session_id → 工作目录（rollout 一文件一会话）
    pub cwds: HashMap<String, String>,
}

/// 进程内增量状态：跨请求累积，重复调用只读取各文件新增字节。
#[derive(Default)]
pub struct AnalyticsState {
    pub files: HashMap<String, FileState>,
    /// kimi session_index.jsonl：session_id → 工作目录（每次扫描重新读取）
    pub session_index: HashMap<String, String>,
    scanned: bool,
}

fn normalize_ts(value: i64) -> Option<i64> {
    // 毫秒时间戳按秒解释；2000~2200 年之外的视为脏数据
    let value = if value > 100_000_000_000 { value / 1000 } else { value };
    if !(946_684_800..=7_258_118_400).contains(&value) {
        return None;
    }
    Some(value)
}

fn count_field(usage: &serde_json::Value, key: &str) -> i64 {
    match usage.get(key).and_then(|v| v.as_f64()) {
        Some(v) if v > 0.0 => v as i64,
        _ => 0,
    }
}

pub(crate) fn parse_kimi_line(line: &str) -> Option<TurnRecord> {
    if !line.contains("\"usage.record\"") {
        return None;
    }
    let rec: serde_json::Value = serde_json::from_str(line).ok()?;
    if rec.get("type")?.as_str()? != "usage.record" {
        return None;
    }
    if rec.get("usageScope")?.as_str()? != "turn" {
        return None;
    }
    let ts = normalize_ts(rec.get("time")?.as_f64()? as i64)?;
    // 借用而非克隆：usage 缺失/非对象按空对象计
    let empty = serde_json::Value::Object(serde_json::Map::new());
    let usage = rec.get("usage").filter(|u| u.is_object()).unwrap_or(&empty);
    Some(TurnRecord {
        ts,
        model: rec
            .get("model")
            .and_then(|m| m.as_str())
            .filter(|m| !m.is_empty())
            .unwrap_or("(unknown)")
            .to_string(),
        input: count_field(&usage, "inputOther"),
        output: count_field(&usage, "output"),
        cache_read: count_field(&usage, "inputCacheRead"),
        cache_creation: count_field(&usage, "inputCacheCreation"),
        sid: String::new(), // 由调用方填文件级会话标识
    })
}

fn json_string_after(line: &str, needle: &str) -> Option<String> {
    let start = line.find(needle)? + needle.len();
    let rest = line[start..].trim_start().strip_prefix('"')?;
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn codex_timestamp(line: &str) -> Option<i64> {
    let raw = json_string_after(line, "\"timestamp\":")?;
    let raw = raw.trim_end_matches('Z');
    let dt = DateTime::parse_from_rfc3339(&format!("{raw}+00:00")).ok()?;
    Some(dt.timestamp())
}

fn codex_model(line: &str) -> Option<String> {
    json_string_after(line, "\"model\":")
}

pub(crate) fn parse_codex_token_line(line: &str, model: &str, sid: &str) -> Option<TurnRecord> {
    if !line.contains("\"token_count\"") {
        return None;
    }
    let rec: serde_json::Value = serde_json::from_str(line).ok()?;
    let payload = rec.get("payload")?;
    if payload.get("type")?.as_str()? != "token_count" {
        return None;
    }
    let usage = payload.get("info")?.get("last_token_usage")?;
    if !usage.is_object() {
        return None;
    }
    let ts = codex_timestamp(line)?;
    let cached = count_field(usage, "cached_input_tokens");
    let input_total = count_field(usage, "input_tokens");
    Some(TurnRecord {
        ts,
        model: if model.is_empty() { "(unknown)".into() } else { model.to_string() },
        input: (input_total - cached).max(0),
        output: count_field(usage, "output_tokens"),
        cache_read: cached,
        cache_creation: count_field(usage, "cache_write_input_tokens"),
        sid: sid.to_string(),
    })
}

pub(crate) fn parse_codex_meta_cwd(line: &str) -> Option<String> {
    if !line.contains("\"session_meta\"") {
        return None;
    }
    let rec: serde_json::Value = serde_json::from_str(line).ok()?;
    let payload = rec.get("payload")?;
    // 两种实际存在的格式：CLI 新版 payload.type == "session_meta"；
    // CLI 旧版 / Zed 写的是顶层 type == "session_meta"，cwd 直接在 payload 里
    let is_meta = rec.get("type").and_then(|v| v.as_str()) == Some("session_meta")
        || payload.get("type").and_then(|v| v.as_str()) == Some("session_meta");
    if !is_meta {
        return None;
    }
    let cwd = payload
        .get("cwd")
        .or_else(|| rec.get("cwd"))
        .and_then(|v| v.as_str())?;
    if cwd.is_empty() {
        return None;
    }
    Some(cwd.to_string())
}

fn kimi_session_id(path: &Path) -> String {
    for part in path.components().rev() {
        let name = part.as_os_str().to_string_lossy();
        if name.starts_with("session_") {
            return name.to_string();
        }
    }
    "(unknown)".into()
}

fn codex_default_session_id(path: &Path) -> String {
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let tail = stem.rsplit('-').next().unwrap_or(&stem).to_string();
    format!("codex-{tail}")
}

fn wire_files(root: &Path, selector: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if path.is_dir() {
                stack.push(path);
            } else if path
                .file_name()
                .map(|n| selector(&n.to_string_lossy()))
                .unwrap_or(false)
            {
                files.push(path);
            }
        }
    }
    files
}

/// 读取自 offset 起新增的完整行文本（末尾未换行的半截行留待下次）。
/// 返回 (文本, 新 offset, 是否截断重写)；无新增或读取失败时文本为空。
fn read_new_lines(path: &Path, offset: i64) -> (String, i64, bool) {
    use std::io::{Read, Seek, SeekFrom};
    let size = match std::fs::metadata(path) {
        Ok(m) => m.len() as i64,
        Err(_) => return (String::new(), offset, false),
    };
    let restarted = size < offset;
    let start = if restarted { 0 } else { offset };
    if size == start {
        return (String::new(), start, false);
    }
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (String::new(), start, false),
    };
    if file.seek(SeekFrom::Start(start as u64)).is_err() {
        return (String::new(), start, false);
    }
    let mut data = Vec::new();
    if file.read_to_end(&mut data).is_err() {
        return (String::new(), start, false);
    }
    match data.iter().rposition(|b| *b == b'\n') {
        Some(last) => (
            String::from_utf8_lossy(&data[..last]).into_owned(),
            start + last as i64 + 1,
            restarted,
        ),
        None => (String::new(), start, false),
    }
}

fn load_session_index(kimi_home: &Path) -> HashMap<String, String> {
    let mut index = HashMap::new();
    if let Ok(text) = std::fs::read_to_string(kimi_home.join("session_index.jsonl")) {
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(rec) = serde_json::from_str::<serde_json::Value>(line) {
                if let (Some(sid), Some(wd)) = (
                    rec.get("sessionId").and_then(|v| v.as_str()),
                    rec.get("workDir").and_then(|v| v.as_str()),
                ) {
                    index.insert(sid.to_string(), wd.to_string());
                }
            }
        }
    }
    index
}

fn date_string(moment: DateTime<Local>) -> String {
    moment.format("%Y-%m-%d").to_string()
}

fn project_name(work_dir: &str) -> String {
    if work_dir.is_empty() || work_dir == "(unknown)" {
        return "(unknown)".into();
    }
    let trimmed = work_dir.trim_end_matches(['/', '\\']);
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(work_dir)
        .to_string()
}

pub fn agent_of(source: Source, model: &str) -> &'static str {
    let lowered = model.to_lowercase();
    if lowered.contains("glm") || lowered.contains("zhipu") || lowered.starts_with("zai/") {
        "glm"
    } else if lowered.contains("deepseek") {
        "deepseek"
    } else if source == Source::Codex {
        "codex"
    } else {
        "kimi"
    }
}

#[derive(Default, Clone)]
struct Bucket {
    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
    requests: i64,
    total: i64,
}

#[derive(Default)]
struct SessionRow {
    sid: String,
    project: String,
    work_dir: String,
    agent_totals: HashMap<&'static str, i64>,
    models: HashSet<String>,
    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
    requests: i64,
    first: i64,
    last: i64,
    total: i64,
}

impl AnalyticsState {
    /// 扫描多个来源（任一可为空切片），返回是否有变化。语义与 Python 版一致：
    /// 文件截断重写时丢弃该文件旧记录从头统计；文件消失时保留历史记录
    /// （offset 置 -1），同路径再次出现时替换，避免重复统计。
    /// kimi/codex 各自接受多个家目录（本机 + WSL UNC），会话按绝对路径天然合并。
    pub fn scan(&mut self, kimi_homes: &[PathBuf], codex_homes: &[PathBuf], now: i64) -> bool {
        let cutoff = now - RECORD_RETENTION_DAYS * 86400;
        let mut dirty = !self.scanned;
        self.scanned = true;
        self.session_index.clear();
        for home in kimi_homes {
            for (sid, wd) in load_session_index(home) {
                self.session_index.insert(sid, wd);
            }
        }

        let mut sources: Vec<(Source, PathBuf, fn(&Path) -> String, fn(&str) -> bool)> = Vec::new();
        for home in kimi_homes {
            sources.push((
                Source::Kimi,
                home.join("sessions"),
                kimi_session_id as fn(&Path) -> String,
                (|name: &str| name == "wire.jsonl") as fn(&str) -> bool,
            ));
        }
        for home in codex_homes {
            sources.push((
                Source::Codex,
                home.join("sessions"),
                codex_default_session_id as fn(&Path) -> String,
                (|name: &str| name.starts_with("rollout-") && name.ends_with(".jsonl"))
                    as fn(&str) -> bool,
            ));
        }

        for (source, root, session_id_of, selector) in sources {
            let files = wire_files(&root, selector);
            // HashSet：已登记文件 × 现存文件逐个 contains 是 O(n²)
            let live: HashSet<String> = files.iter().map(|p| p.to_string_lossy().into_owned()).collect();
            for (key, state) in self.files.iter_mut() {
                if state.source == source && !live.contains(key) && state.offset != -1 {
                    state.offset = -1;
                    dirty = true;
                }
            }
            for wire in files {
                let key = wire.to_string_lossy().to_string();
                if !self.files.contains_key(&key) {
                    self.files.insert(
                        key.clone(),
                        FileState { offset: 0, records: Vec::new(), source, cwds: HashMap::new() },
                    );
                    dirty = true;
                }
                let state = self.files.get_mut(&key).unwrap();
                if state.offset == -1 {
                    state.offset = 0;
                    state.records.clear();
                    state.cwds.clear();
                    dirty = true;
                }
                let (text, new_offset, restarted) = read_new_lines(&wire, state.offset);
                state.offset = new_offset;
                if restarted {
                    state.records.clear();
                    state.cwds.clear();
                    dirty = true;
                }
                let session_id = session_id_of(&wire);
                let mut current_model = String::new();
                for line in text.split('\n') {
                    if source == Source::Kimi {
                        if let Some(mut record) = parse_kimi_line(line) {
                            record.sid = session_id.clone();
                            state.records.push(record);
                            dirty = true;
                        }
                        continue;
                    }
                    if let Some(model) = codex_model(line) {
                        current_model = model;
                    }
                    if let Some(cwd) = parse_codex_meta_cwd(line) {
                        // rollout 文件与会话一一对应，统一用文件级会话 ID
                        state.cwds.insert(session_id.clone(), cwd);
                        dirty = true;
                    }
                    if let Some(record) = parse_codex_token_line(line, &current_model, &session_id) {
                        state.records.push(record);
                        dirty = true;
                    }
                }
                let before = state.records.len();
                state.records.retain_mut(|record| match normalize_ts(record.ts) {
                    Some(ts) if ts >= cutoff => {
                        record.ts = ts;
                        true
                    }
                    _ => false,
                });
                if state.records.len() != before {
                    dirty = true;
                }
            }
        }
        dirty
    }

    pub fn aggregate(&self, days: u32, agent: &str, now: DateTime<Local>) -> serde_json::Value {
        let days = days.clamp(1, 365) as i64;
        let agent = if AGENTS.contains(&agent) { agent } else { "all" };
        let today = date_string(now);
        let day_list: Vec<String> = (0..days)
            .rev()
            .map(|offset| date_string(now - chrono::Duration::days(offset)))
            .collect();
        let day_set: HashSet<&String> = day_list.iter().collect();

        let mut daily: HashMap<String, Bucket> = HashMap::new();
        let mut hourly: Vec<Bucket> = vec![Bucket::default(); 24];
        let mut daily_model: HashMap<String, HashMap<String, i64>> = HashMap::new();
        let mut daily_agent: HashMap<String, HashMap<&'static str, i64>> = HashMap::new();
        let mut daily_project: HashMap<String, HashMap<String, i64>> = HashMap::new();
        let mut model_total: HashMap<String, i64> = HashMap::new();
        let mut model_agent: HashMap<String, &'static str> = HashMap::new();
        let mut project_total: HashMap<(String, String), i64> = HashMap::new();
        let mut calendar: HashMap<String, (i64, i64)> = HashMap::new();
        let mut agents_seen: HashSet<&'static str> = HashSet::new();
        let mut agent_totals: HashMap<&'static str, i64> = HashMap::new();
        let mut agent_requests: HashMap<&'static str, i64> = HashMap::new();
        let mut sessions: HashMap<String, SessionRow> = HashMap::new();
        // 日期格式化按天缓存：同一日期只在首次出现时 format
        let mut date_cache: HashMap<i32, String> = HashMap::new();

        for state in self.files.values() {
            for record in &state.records {
                let record_agent = agent_of(state.source, &record.model);
                if agent != "all" && record_agent != agent {
                    continue;
                }
                let work_dir = if state.source == Source::Codex {
                    state.cwds.get(&record.sid).cloned().unwrap_or_else(|| "(unknown)".into())
                } else {
                    self.session_index.get(&record.sid).cloned().unwrap_or_else(|| "(unknown)".into())
                };
                let local = Local
                    .timestamp_opt(record.ts, 0)
                    .single()
                    .unwrap_or_else(|| now.clone());
                let date = date_cache
                    .entry(local.date_naive().num_days_from_ce())
                    .or_insert_with(|| date_string(local))
                    .clone();
                let total = record.input + record.output + record.cache_read + record.cache_creation;
                agents_seen.insert(record_agent);
                let cell = calendar.entry(date.clone()).or_insert((0, 0));
                cell.0 += total;
                cell.1 += 1;
                if !day_set.contains(&date) {
                    continue;
                }
                let bucket = daily.entry(date.clone()).or_default();
                bucket.input += record.input;
                bucket.output += record.output;
                bucket.cache_read += record.cache_read;
                bucket.cache_creation += record.cache_creation;
                bucket.requests += 1;
                bucket.total += total;
                *agent_requests.entry(record_agent).or_default() += 1;
                *daily_agent
                    .entry(date.clone())
                    .or_default()
                    .entry(record_agent)
                    .or_default() += total;
                if date == today {
                    let hour = &mut hourly[local.hour() as usize];
                    hour.input += record.input;
                    hour.output += record.output;
                    hour.cache_read += record.cache_read;
                    hour.cache_creation += record.cache_creation;
                    hour.requests += 1;
                }
                *daily_model
                    .entry(date.clone())
                    .or_default()
                    .entry(record.model.clone())
                    .or_default() += total;
                *model_total.entry(record.model.clone()).or_default() += total;
                model_agent.entry(record.model.clone()).or_insert(record_agent);
                let project = project_name(&work_dir);
                *project_total
                    .entry((project.clone(), work_dir.clone()))
                    .or_default() += total;
                *daily_project
                    .entry(date.clone())
                    .or_default()
                    .entry(project.clone())
                    .or_default() += total;

                let session = sessions.entry(record.sid.clone()).or_insert_with(|| SessionRow {
                    sid: record.sid.clone(),
                    project: project.clone(),
                    work_dir: work_dir.clone(),
                    agent_totals: HashMap::new(),
                    models: HashSet::new(),
                    input: 0,
                    output: 0,
                    cache_read: 0,
                    cache_creation: 0,
                    requests: 0,
                    first: record.ts,
                    last: record.ts,
                    total: 0,
                });
                session.models.insert(record.model.clone());
                *session.agent_totals.entry(record_agent).or_default() += total;
                session.input += record.input;
                session.output += record.output;
                session.cache_read += record.cache_read;
                session.cache_creation += record.cache_creation;
                session.requests += 1;
                session.first = session.first.min(record.ts);
                session.last = session.last.max(record.ts);
                session.total += total;
            }
        }

        for agents_of_day in daily_agent.values() {
            for (&name, total) in agents_of_day {
                *agent_totals.entry(name).or_default() += total;
            }
        }

        let daily_out: Vec<serde_json::Value> = day_list
            .iter()
            .map(|day| {
                let b = daily.get(day).cloned().unwrap_or_default();
                let input_total = b.input + b.cache_read + b.cache_creation;
                serde_json::json!({
                    "date": day,
                    "input": b.input,
                    "output": b.output,
                    "cache_read": b.cache_read,
                    "cache_creation": b.cache_creation,
                    "total": b.total,
                    "requests": b.requests,
                    "cache_hit_rate": if input_total > 0 {
                        (b.cache_read as f64 / input_total as f64 * 10000.0).round() / 10000.0
                    } else { 0.0 },
                })
            })
            .collect();

        let mut models: Vec<(String, i64)> = model_total.iter().map(|(k, v)| (k.clone(), *v)).collect();
        models.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let model_names: Vec<String> = models.iter().map(|(m, _)| m.clone()).collect();

        let mut rank: Vec<(&'static str, i64)> = agent_totals.iter().map(|(k, v)| (*k, *v)).collect();
        rank.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        let agent_rank: Vec<serde_json::Value> = rank
            .iter()
            .map(|(name, total)| {
                serde_json::json!({
                    "agent": name,
                    "total": total,
                    "requests": agent_requests.get(name).copied().unwrap_or(0),
                })
            })
            .collect();

        let mut project_rank: Vec<((String, String), i64)> =
            project_total.iter().map(|(k, v)| (k.clone(), *v)).collect();
        project_rank.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

        // 每日 top 项目（悬浮提示用）：date → [{name, total}] 前 5
        let mut daily_projects: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
        for day in &day_list {
            if let Some(projects) = daily_project.get(day) {
                let mut ranked: Vec<(String, i64)> =
                    projects.iter().map(|(name, total)| (name.clone(), *total)).collect();
                ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
                let top: Vec<serde_json::Value> = ranked
                    .into_iter()
                    .take(5)
                    .map(|(name, total)| {
                        serde_json::json!({ "name": name, "total": total })
                    })
                    .collect();
                daily_projects.insert(day.clone(), serde_json::Value::Array(top));
            }
        }

        let mut session_rows: Vec<&SessionRow> = sessions.values().collect();
        session_rows.sort_by(|a, b| b.total.cmp(&a.total).then(a.first.cmp(&b.first)));
        let session_payload: Vec<serde_json::Value> = session_rows
            .iter()
            .take(SESSION_CAP)
            .map(|session| {
                let dominant = session
                    .agent_totals
                    .iter()
                    .max_by_key(|(_, total)| **total)
                    .map(|(name, _)| *name)
                    .unwrap_or("kimi");
                serde_json::json!({
                    "session_id": session.sid,
                    "project": session.project,
                    "work_dir": session.work_dir,
                    "agent": dominant,
                    "models": session.models.iter().cloned().collect::<Vec<_>>(),
                    "input": session.input,
                    "output": session.output,
                    "cache_read": session.cache_read,
                    "cache_creation": session.cache_creation,
                    "requests": session.requests,
                    "first": session.first,
                    "last": session.last,
                    "total": session.total,
                })
            })
            .collect();

        let calendar_days: Vec<serde_json::Value> = calendar
            .iter()
            .map(|(date, (total, requests))| serde_json::json!([date, total, requests]))
            .collect();

        let week_total: i64 = daily_out.iter().rev().take(7).map(|d| d["total"].as_i64().unwrap_or(0)).sum();
        let prev_week_total: i64 = if days >= 14 {
            daily_out.iter().rev().skip(7).take(7).map(|d| d["total"].as_i64().unwrap_or(0)).sum()
        } else {
            0
        };
        let denominator: i64 = daily_out
            .iter()
            .map(|d| d["input"].as_i64().unwrap_or(0) + d["cache_read"].as_i64().unwrap_or(0) + d["cache_creation"].as_i64().unwrap_or(0))
            .sum();
        let total_cache_read: i64 = daily_out.iter().map(|d| d["cache_read"].as_i64().unwrap_or(0)).sum();

        serde_json::json!({
            "generated_at": now.format("%Y-%m-%d %H:%M:%S").to_string(),
            "days": days,
            "agent": agent,
            "agents": agents_seen.into_iter().collect::<Vec<_>>(),
            "date_range": [day_list.first(), day_list.last()],
            "day_list": day_list,
            "daily": daily_out,
            "daily_agent": day_list.iter().map(|day| {
                (day.clone(), daily_agent.get(day).cloned().unwrap_or_default())
            }).collect::<HashMap<String, _>>(),
            "today_hourly": hourly.iter().enumerate().map(|(hour, b)| serde_json::json!({
                "hour": hour,
                "input": b.input,
                "output": b.output,
                "cache_read": b.cache_read,
                "cache_creation": b.cache_creation,
                "requests": b.requests,
            })).collect::<Vec<_>>(),
            "models": model_names,
            "daily_model": day_list.iter().map(|day| {
                let per_model = daily_model.get(day).cloned().unwrap_or_default();
                (day.clone(), model_names.iter().map(|m| per_model.get(m).copied().unwrap_or(0)).collect::<Vec<_>>())
            }).collect::<HashMap<String, _>>(),
            "model_rank": models.iter().map(|(model, total)| serde_json::json!({
                "model": model,
                "total": total,
                "agent": model_agent.get(model).copied().unwrap_or(""),
            })).collect::<Vec<_>>(),
            "agent_rank": agent_rank,
            "project_rank": project_rank.iter().map(|((name, path), total)| serde_json::json!({
                "name": name,
                "path": path,
                "total": total,
            })).collect::<Vec<_>>(),
            "daily_projects": daily_projects,
            "calendar": {
                "range": [
                    date_string(now - chrono::Duration::days(364)),
                    today,
                ],
                "days": calendar_days,
            },
            "sessions": session_payload,
            "kpi": {
                "week_total": week_total,
                "prev_week_total": prev_week_total,
                "week_over_week": if prev_week_total > 0 {
                    serde_json::json!(
                        ((week_total - prev_week_total) as f64 / prev_week_total as f64 * 10000.0).round() / 10000.0
                    )
                } else { serde_json::Value::Null },
                "today_total": daily_out.last().map(|d| d["total"].as_i64().unwrap_or(0)).unwrap_or(0),
                "cache_hit_rate": if denominator > 0 {
                    (total_cache_read as f64 / denominator as f64 * 10000.0).round() / 10000.0
                } else { 0.0 },
                "active_sessions": sessions.len(),
            },
        })
    }
}
