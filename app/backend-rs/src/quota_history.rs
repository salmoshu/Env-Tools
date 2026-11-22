//! 配额历史与样本质量：只把同账号、同套餐、同来源范围且覆盖完整的
//! 干净样本用于估算。明确的其他设备消耗和异常重置不会进入历史。

use serde_json::Value;
use std::io::Write;
use std::path::Path;

const MAX_LINES: usize = 20_000;
const KEEP_LINES: usize = 8_000;
const GENERATION_TOLERANCE_SECS: i64 = 120;
const ROUNDING_TOLERANCE_PCT: f64 = 0.51;

pub fn append(path: &Path, line: &Value) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > 4 * 1024 * 1024 {
            rotate(path);
        }
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn rotate(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let mut lines: Vec<&str> = text.lines().collect();
    if lines.len() <= KEEP_LINES {
        return;
    }
    let kept = lines.split_off(lines.len() - KEEP_LINES);
    let tmp = path.with_extension("rotating");
    let backup = path.with_extension("rotate-backup");
    if let Ok(mut file) = std::fs::File::create(&tmp) {
        for line in kept {
            let _ = writeln!(file, "{line}");
        }
        drop(file);
        if std::fs::rename(path, &backup).is_ok() {
            match std::fs::rename(&tmp, path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(backup);
                }
                Err(_) => {
                    let _ = std::fs::rename(&backup, path);
                }
            }
        }
    }
}

pub fn read(path: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(path) else { return Vec::new() };
    text.lines().filter_map(|line| serde_json::from_str::<Value>(line).ok()).collect()
}

fn scope_of(snapshot: &Value) -> &str {
    snapshot.get("scope").and_then(Value::as_str).unwrap_or("local")
}

fn same_plan(snapshot: &Value, plan: &str) -> bool {
    let snapshot_plan = snapshot.get("plan").and_then(Value::as_str).unwrap_or("");
    if plan.is_empty() {
        snapshot_plan.is_empty()
    } else {
        snapshot_plan.is_empty() || snapshot_plan == plan
    }
}

fn matches(snapshot: &Value, provider: &str, account: &str, window: i64, scope: &str, plan: &str) -> bool {
    snapshot.get("p").and_then(Value::as_str) == Some(provider)
        && snapshot.get("a").and_then(Value::as_str).unwrap_or("default") == account
        && (snapshot.get("win").and_then(Value::as_i64).unwrap_or(0) - window).abs() <= 600
        && scope_of(snapshot) == scope
        && same_plan(snapshot, plan)
}

#[derive(Clone, Copy)]
struct Sample {
    start: i64,
    ts: i64,
    pct: f64,
    tokens: f64,
}

fn samples(
    rows: &[Value],
    provider: &str,
    account: &str,
    window: i64,
    scope: &str,
    plan: &str,
    exclude_ts: Option<i64>,
) -> Vec<Sample> {
    let mut out = vec![];
    for row in rows {
        if !matches(row, provider, account, window, scope, plan) || row.get("complete").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let ts = row.get("ts").and_then(Value::as_i64).unwrap_or(0);
        if Some(ts) == exclude_ts {
            continue;
        }
        let pct = row.get("pct").and_then(Value::as_f64).unwrap_or(0.0);
        let tokens = row.get("tok").and_then(Value::as_f64).unwrap_or(0.0);
        let elapsed = row.get("el").and_then(Value::as_i64).unwrap_or(0);
        if pct >= 3.0 && tokens > 0.0 && ts > 0 && elapsed > 0 {
            out.push(Sample { start: ts - elapsed, ts, pct, tokens });
        }
    }
    out.sort_by_key(|sample| (sample.start, sample.ts));
    out
}

fn estimates(mut rows: Vec<Sample>, max_gens: usize) -> Vec<f64> {
    let mut generations: Vec<Vec<Sample>> = vec![];
    for row in rows.drain(..) {
        match generations.last_mut() {
            Some(group) if (row.start - group[0].start).abs() <= GENERATION_TOLERANCE_SECS => group.push(row),
            _ => generations.push(vec![row]),
        }
    }
    generations
        .into_iter()
        .rev()
        .take(max_gens)
        .filter_map(|group| {
            let best = group.into_iter().max_by_key(|sample| sample.ts)?;
            Some(best.tokens / (best.pct / 100.0))
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

pub fn generation_estimates_scoped(
    path: &Path,
    provider: &str,
    account: &str,
    window: i64,
    scope: &str,
    plan: &str,
    max_gens: usize,
) -> Vec<f64> {
    estimates(samples(&read(path), provider, account, window, scope, plan, None), max_gens)
}

pub fn generation_estimates(path: &Path, provider: &str, account: &str, window: i64, max_gens: usize) -> Vec<f64> {
    generation_estimates_scoped(path, provider, account, window, "local", "", max_gens)
}

#[allow(clippy::too_many_arguments)]
pub fn evaluate(
    path: &Path,
    provider: &str,
    account: &str,
    window: i64,
    scope: &str,
    plan: &str,
    at: i64,
    elapsed: i64,
    pct: f64,
    tokens: f64,
    complete: bool,
) -> Value {
    let rows = read(path);
    let current_start = at - elapsed;
    let generation_contaminated = rows.iter().any(|row| {
        row.get("external").and_then(Value::as_bool) == Some(true)
            && matches(row, provider, account, window, scope, plan)
            && (row.get("ts").and_then(Value::as_i64).unwrap_or(0)
                - row.get("el").and_then(Value::as_i64).unwrap_or(0)
                - current_start)
                .abs() <= GENERATION_TOLERANCE_SECS
    });
    let history_rows = samples(&rows, provider, account, window, scope, plan, Some(at));
    let previous = history_rows
        .iter()
        .filter(|sample| sample.ts < at && (sample.start - current_start).abs() <= GENERATION_TOLERANCE_SECS)
        .max_by_key(|sample| sample.ts)
        .copied();
    let mut external = generation_contaminated;
    let mut reason = if generation_contaminated { "external_activity" } else if complete { "ok" } else { "incomplete_coverage" };
    if let Some(previous) = previous {
        let token_delta = tokens - previous.tokens;
        let pct_delta = pct - previous.pct;
        if token_delta < -0.5 {
            reason = "local_usage_decreased";
        } else if pct_delta < -ROUNDING_TOLERANCE_PCT {
            reason = "generation_reset";
        } else if token_delta <= 0.0 && pct_delta > ROUNDING_TOLERANCE_PCT {
            external = true;
            reason = "external_activity";
        }
    }
    if pct < 1.0 {
        reason = "percent_too_small";
    }
    if tokens <= 0.0 {
        reason = "no_local_usage";
    }
    let history = estimates(history_rows, 8);
    let usable = complete && !external && reason == "ok" && tokens > 0.0 && pct >= 1.0;
    let quality = if !usable {
        "low"
    } else if pct >= 10.0 && history.len() >= 2 {
        "high"
    } else if pct >= 3.0 {
        "medium"
    } else {
        "low"
    };
    serde_json::json!({
        "history": history,
        "externalActivity": external,
        "generationContaminated": generation_contaminated,
        "usable": usable,
        "quality": quality,
        "reason": reason,
    })
}

#[allow(clippy::too_many_arguments)]
pub fn record(
    path: &Path,
    provider: &str,
    account: &str,
    window: i64,
    scope: &str,
    plan: &str,
    at: i64,
    elapsed: i64,
    pct: f64,
    tokens: f64,
    complete: bool,
) -> Value {
    let mut result = evaluate(path, provider, account, window, scope, plan, at, elapsed, pct, tokens, complete);
    let duplicate = read(path).into_iter().any(|row| {
        matches(&row, provider, account, window, scope, plan)
            && row.get("ts").and_then(Value::as_i64) == Some(at)
            && row.get("tok").and_then(Value::as_f64) == Some(tokens)
            && row.get("pct").and_then(Value::as_f64) == Some(pct)
    });
    let external = result["externalActivity"].as_bool().unwrap_or(false);
    let should_record = !duplicate
        && (result["usable"].as_bool().unwrap_or(false)
            || (result["externalActivity"].as_bool().unwrap_or(false)
                && !result["generationContaminated"].as_bool().unwrap_or(false)));
    if should_record {
        append(path, &serde_json::json!({
            "v": 2, "ts": at, "p": provider, "a": account, "win": window,
            "pct": pct, "el": elapsed, "tok": tokens, "scope": scope,
            "plan": plan, "complete": complete && !external, "external": external,
        }));
    }
    result["recorded"] = Value::Bool(should_record);
    result
}

#[cfg(test)]
mod tests {
    use super::{append, evaluate, generation_estimates_scoped, read, record};
    use serde_json::json;

    fn path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "env-tools-quota-{tag}-{}-{:?}.jsonl",
            std::process::id(),
            std::thread::current().id(),
        ))
    }

    #[test]
    fn accounts_scopes_and_plans_are_isolated() {
        let path = path("scope");
        let _ = std::fs::remove_file(&path);
        for line in [
            json!({"ts":100_000,"p":"codex","a":"default","win":18_000,"pct":10.0,"el":1_000,"tok":1_000}),
            json!({"ts":100_000,"p":"codex","a":"work","win":18_000,"pct":10.0,"el":1_000,"tok":2_000}),
            json!({"ts":100_000,"p":"codex","a":"work","win":18_000,"pct":20.0,"el":1_000,"tok":2_000,"scope":"aggregate"}),
            json!({"ts":100_000,"p":"codex","a":"work","win":18_000,"pct":20.0,"el":1_000,"tok":3_000,"plan":"pro"}),
        ] {
            append(&path, &line);
        }
        assert_eq!(generation_estimates_scoped(&path, "codex", "default", 18_000, "local", "", 8), vec![10_000.0]);
        assert_eq!(generation_estimates_scoped(&path, "codex", "work", 18_000, "local", "", 8), vec![20_000.0]);
        assert_eq!(generation_estimates_scoped(&path, "codex", "work", 18_000, "aggregate", "", 8), vec![10_000.0]);
        assert_eq!(generation_estimates_scoped(&path, "codex", "work", 18_000, "local", "pro", 8), vec![15_000.0]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn external_only_growth_is_rejected_and_preserves_last_good_history() {
        let path = path("external");
        let _ = std::fs::remove_file(&path);
        let first = record(&path, "codex", "default", 18_000, "local", "pro", 100_000, 1_000, 10.0, 1_000.0, true);
        assert_eq!(first["usable"], true);
        let polluted = evaluate(&path, "codex", "default", 18_000, "local", "pro", 100_100, 1_100, 20.0, 1_000.0, true);
        assert_eq!(polluted["externalActivity"], true);
        assert_eq!(polluted["usable"], false);
        assert_eq!(polluted["history"], json!([10_000.0]));
        let written = record(&path, "codex", "default", 18_000, "local", "pro", 100_100, 1_100, 20.0, 1_000.0, true);
        assert_eq!(written["recorded"], true);
        assert_eq!(read(&path).len(), 2);
        let later = record(&path, "codex", "default", 18_000, "local", "pro", 100_200, 1_200, 20.0, 1_200.0, true);
        assert_eq!(later["externalActivity"], true);
        assert_eq!(later["usable"], false);
        assert_eq!(later["recorded"], false);
        assert_eq!(read(&path).len(), 2);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn generation_start_drift_is_clustered_and_latest_sample_wins() {
        let path = path("generation");
        let _ = std::fs::remove_file(&path);
        for line in [
            json!({"ts":100_000,"p":"kimi","a":"default","win":18_000,"pct":10.0,"el":1_000,"tok":1_000,"scope":"local"}),
            json!({"ts":100_100,"p":"kimi","a":"default","win":18_000,"pct":8.0,"el":1_030,"tok":1_200,"scope":"local"}),
        ] {
            append(&path, &line);
        }
        assert_eq!(generation_estimates_scoped(&path, "kimi", "default", 18_000, "local", "", 8), vec![15_000.0]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn incomplete_coverage_never_becomes_a_history_sample() {
        let path = path("coverage");
        let _ = std::fs::remove_file(&path);
        let result = record(&path, "codex", "default", 18_000, "local", "", 100_000, 1_000, 10.0, 1_000.0, false);
        assert_eq!(result["usable"], false);
        assert_eq!(result["reason"], "incomplete_coverage");
        assert!(read(&path).is_empty());
        let _ = std::fs::remove_file(path);
    }
}
