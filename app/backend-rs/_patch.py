# -*- coding: utf-8 -*-
import io

p = "src/analytics.rs"
src = io.open(p, encoding="utf-8").read()

# ---- 1) TurnRecord 增加生成时长字段（ZCode 逐请求 TPOT 口径用）----
old = """#[derive(Clone)]
pub struct TurnRecord {
    pub ts: i64,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub sid: String,
}"""
new = """#[derive(Clone)]
pub struct TurnRecord {
    pub ts: i64,
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
    pub sid: String,
    /// 该次请求的纯生成时长（秒）= duration_ms − TTFT。仅 ZCode 数据源
    /// 逐请求可得；kimi/codex 文件源没有该信息，为 0。
    pub gen_seconds: f64,
}"""
assert old in src, "TurnRecord not found"
src = src.replace(old, new, 1)

# ---- 2) SessionRow 增加输出聚合与生成时长 ----
old = """    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
    requests: i64,
    first: i64,
    last: i64,
    total: i64,
}"""
new = """    input: i64,
    output: i64,
    cache_read: i64,
    cache_creation: i64,
    requests: i64,
    first: i64,
    last: i64,
    total: i64,
    /// 逐请求纯生成时长之和（秒，ZCode 源），用于真 TPOT 口径速率
    gen_seconds: f64,
}"""
assert old in src, "SessionRow not found"
src = src.replace(old, new, 1)

# ---- 3) kimi/codex 记录构造处补 gen_seconds: 0.0 ----
import re
n = 0
pattern = re.compile(r"(sid: session_id\.clone\(\),\n(\s*)\}\n)", re.M)
def add_field(m):
    global n
    n += 1
    indent = m.group(2)
    return m.group(1).replace("}", f"gen_seconds: 0.0,\n{indent}}}\n", 1) if False else m.group(1)
# 更直接：定位所有 TurnRecord 字面量收尾
lines = src.split("\n")
out_lines = []
i = 0
patched = 0
while i < len(lines):
    line = lines[i]
    out_lines.append(line)
    if line.rstrip().endswith("sid: String::new(), // 由调用方填文件级会话标识") or \
       line.rstrip() == "sid: String::new(),":
        pass
    if "sid," == line.strip() or line.strip().startswith("sid:"):
        # 查看下一行是否是 "}"/"})",即记录收尾
        nxt = lines[i+1].strip() if i+1 < len(lines) else ""
        if nxt.startswith("}"):
            indent = line[: len(line) - len(line.lstrip())]
            out_lines.append(f"{indent}gen_seconds: 0.0,")
            patched += 1
    i += 1
src = "\n".join(out_lines)
print("TurnRecord literals patched:", patched)

# ---- 4) zcode 扫描器输出 gen_seconds ----
old = """                "SELECT rowid, session_id, model_id, completed_at, \\
                 input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens \\
                 FROM model_usage WHERE rowid > ?1 AND completed_at IS NOT NULL ORDER BY rowid","""
new = """                "SELECT rowid, session_id, model_id, completed_at, \\
                 input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, \\
                 duration_ms, time_to_first_token_ms \\
                 FROM model_usage WHERE rowid > ?1 AND completed_at IS NOT NULL ORDER BY rowid","""
assert old in src, "zcode sql not found"
src = src.replace(old, new, 1)

old = """        let rows = stmt
            .query_map([watermark], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        for row in rows {
            let (rowid, sid, model, completed_ms, input, output, cache_read, cache_creation) =
                row.map_err(|err| err.to_string())?;
            records.push(TurnRecord {
                ts: completed_ms,
                model,
                input: input.max(0),
                output: output.max(0),
                cache_read: cache_read.max(0),
                cache_creation: cache_creation.max(0),
                sid,
            });
            if rowid > new_watermark {
                new_watermark = rowid;
            }
        }"""
new = """        let rows = stmt
            .query_map([watermark], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                ))
            })
            .map_err(|err| err.to_string())?;
        for row in rows {
            let (rowid, sid, model, completed_ms, input, output, cache_read, cache_creation, duration_ms, ttft_ms) =
                row.map_err(|err| err.to_string())?;
            // 纯生成时长 = 总时长 − 首 token 延迟（TTFT）；负值/缺失记 0
            let gen_ms = duration_ms
                .zip(ttft_ms)
                .map(|(d, t)| (d - t).max(0))
                .unwrap_or(0) as f64;
            records.push(TurnRecord {
                ts: completed_ms,
                model,
                input: input.max(0),
                output: output.max(0),
                cache_read: cache_read.max(0),
                cache_creation: cache_creation.max(0),
                sid,
                gen_seconds: gen_ms / 1000.0,
            });
            if rowid > new_watermark {
                new_watermark = rowid;
            }
        }"""
assert old in src, "zcode rows block not found"
src = src.replace(old, new, 1)

# ---- 5) SessionRow 构造 + 累加 ----
old = """                let session = sessions.entry(record.sid.clone()).or_insert_with(|| SessionRow {
                    sid: record.sid.clone(),
                    project: project_name(&work_dir),
                    work_dir: work_dir.clone(),
                    agent: record_agent,
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
                });"""
new = """                let session = sessions.entry(record.sid.clone()).or_insert_with(|| SessionRow {
                    sid: record.sid.clone(),
                    project: project_name(&work_dir),
                    work_dir: work_dir.clone(),
                    agent: record_agent,
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
                    gen_seconds: 0.0,
                });"""
assert old in src, "SessionRow ctor not found"
src = src.replace(old, new, 1)

old = """                session.first = session.first.min(record.ts);
                session.last = session.last.max(record.ts);
                session.total += total;"""
new = """                session.first = session.first.min(record.ts);
                session.last = session.last.max(record.ts);
                session.total += total;
                session.gen_seconds += record.gen_seconds;"""
assert old in src, "session accum not found"
src = src.replace(old, new, 1)

# ---- 6) 会话 payload：rate 改为输出口径 + 新增 tpot（ZCode 真生成速度）----
old = """                    "rate": if session.last > session.first {
                        serde_json::json!(
                            (session.total as f64 / (session.last - session.first) as f64 * 100.0).round() / 100.0
                        )
                    } else {
                        serde_json::Value::Null
                    },"""
new = """                    // 输出速率（业界标准口径之一）：output ÷ 会话时长
                    "rate": if session.last > session.first {
                        serde_json::json!(
                            (session.output as f64 / (session.last - session.first) as f64 * 100.0).round() / 100.0
                        )
                    } else {
                        serde_json::Value::Null
                    },
                    // 真生成速度（TPOT 口径，仅 ZCode 源有逐请求生成时长）：
                    // output ÷ Σ(请求时长 − TTFT)
                    "gen_rate": if session.gen_seconds > 0.0 {
                        serde_json::json!(
                            (session.output as f64 / session.gen_seconds * 100.0).round() / 100.0
                        )
                    } else {
                        serde_json::Value::Null
                    },"""
assert old in src, "session rate payload not found"
src = src.replace(old, new, 1)

# ---- 7) latest_sessions（顶部速率卡）同步输出/生成为基础 ----
old = """                serde_json::json!({
                    "project": s.project,
                    "agent": dominant,
                    "rate": if s.last > s.first {
                        serde_json::json!(
                            (s.total as f64 / (s.last - s.first) as f64 * 100.0).round() / 100.0
                        )
                    } else {
                        serde_json::Value::Null
                    },
                    "total": s.total,
                    "last": s.last,
                    "ended_ago_seconds": (now_sec - s.last).max(0),
                })"""
new = """                serde_json::json!({
                    "project": s.project,
                    "agent": dominant,
                    // 输出速率为基础（业界标准：吞吐用输出 token 计量）
                    "rate": if s.last > s.first {
                        serde_json::json!(
                            (s.output as f64 / (s.last - s.first) as f64 * 100.0).round() / 100.0
                        )
                    } else {
                        serde_json::Value::Null
                    },
                    "gen_rate": if s.gen_seconds > 0.0 {
                        serde_json::json!(
                            (s.output as f64 / s.gen_seconds * 100.0).round() / 100.0
                        )
                    } else {
                        serde_json::Value::Null
                    },
                    "total": s.total,
                    "output": s.output,
                    "last": s.last,
                    "ended_ago_seconds": (now_sec - s.last).max(0),
                })"""
assert old in src, "latest_sessions payload not found"
src = src.replace(old, new, 1)

io.open(p, "w", encoding="utf-8", newline="\n").write(src)
print("analytics.rs output-based rates done")
