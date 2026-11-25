//! Estimate token-equivalent capacity from differences within the same reset window.
//! An unknown offset (usage we didn't see) cancels in a clean interval. Never mix
//! profiles, plans, window lengths, or measurement bases.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

const KEEP_LINES: usize = 12_000;
const GENERATION_TOLERANCE: i64 = 120;
const PERCENT_JITTER: f64 = 1.25;
const MIN_DELTA_PCT: f64 = 3.0;
const MAX_SAMPLE_AGE: i64 = 90 * 86_400;
const MAX_POINTS_PER_SEGMENT: usize = 40;
const MAX_WINDOWS: usize = 8;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub struct Observation<'a> {
    pub provider: &'a str,
    pub account: &'a str,
    pub window: i64,
    pub scope: &'a str,
    pub cohort: &'a str,
    pub plan: &'a str,
    pub at: i64,
    pub elapsed: i64,
    pub pct: f64,
    pub tokens: f64,
    pub complete: bool,
    pub share: Option<f64>,
}

#[derive(Clone, Deserialize, Serialize)]
struct Row {
    #[serde(default)]
    v: u8,
    ts: i64,
    p: String,
    #[serde(default = "default_account")]
    a: String,
    win: i64,
    pct: f64,
    el: i64,
    tok: f64,
    #[serde(default = "local_scope")]
    scope: String,
    #[serde(default)]
    plan: String,
    #[serde(default)]
    cohort: String,
    #[serde(default)]
    basis: String,
    #[serde(default = "yes")]
    complete: bool,
    #[serde(default)]
    external: bool,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    change: String,
}

fn default_account() -> String { "default".into() }
fn local_scope() -> String { "local".into() }
fn yes() -> bool { true }

fn is_month(win: i64) -> bool { (27 * 86400..=32 * 86400).contains(&win) }

impl Row {
    fn start(&self) -> i64 { self.ts.saturating_sub(self.el) }

    fn valid(&self) -> bool {
        self.ts > 0 && self.win > 0 && self.win <= 32 * 86400
            && (0..=self.win).contains(&self.el)
            && self.tok.is_finite() && self.tok >= 0.0
            && (0.0..=100.0).contains(&self.pct)
    }

    fn same_window(&self, other: &Self) -> bool {
        self.win == other.win || is_month(self.win) && is_month(other.win)
    }

    fn same_generation(&self, other: &Self) -> bool {
        self.start().abs_diff(other.start()) <= GENERATION_TOLERANCE as u64
            && self.same_window(other)
    }

    fn same_measurement(&self, other: &Self) -> bool {
        self.p == other.p && self.a == other.a && self.plan == other.plan && self.scope == other.scope
            && self.same_window(other) && self.basis == other.basis
            && (self.v < 3 || self.cohort == other.cohort)
    }
}

impl Observation<'_> {
    fn row(&self) -> Row {
        let share = self.share.filter(|x| (0.0..=100.0).contains(x))
            .filter(|_| self.provider == "kimi" && is_month(self.window));
        Row {
            v: 3, ts: self.at, p: self.provider.into(), a: self.account.into(),
            win: self.window, pct: self.pct * share.unwrap_or(100.0) / 100.0,
            el: self.elapsed, tok: self.tokens, scope: self.scope.into(), plan: self.plan.into(),
            cohort: self.cohort.into(), basis: if share.is_some() { "kimi-share".into() } else { String::new() },
            complete: self.complete, external: false, change: String::new(),
        }
    }
}

fn read(path: &Path) -> Vec<Row> {
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    text.lines().filter_map(|line| serde_json::from_str(line).ok()).collect()
}

fn append(path: &Path, row: &Row) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() > 4 * 1024 * 1024) {
        rotate(path);
    }
    if let (Ok(mut file), Ok(line)) = (
        std::fs::OpenOptions::new().create(true).append(true).open(path),
        serde_json::to_string(row),
    ) {
        let _ = writeln!(file, "{line}");
    }
}

fn rotate(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let lines: Vec<_> = text.lines().collect();
    if lines.len() <= KEEP_LINES {
        return;
    }
    let tmp = path.with_extension("rotating");
    let backup = path.with_extension("rotate-backup");
    if let Ok(mut file) = std::fs::File::create(&tmp) {
        for line in &lines[lines.len() - KEEP_LINES..] {
            if writeln!(file, "{line}").is_err() {
                return;
            }
        }
        drop(file);
        if std::fs::rename(path, &backup).is_ok() {
            if std::fs::rename(&tmp, path).is_ok() {
                let _ = std::fs::remove_file(backup);
            } else {
                let _ = std::fs::rename(&backup, path);
            }
        }
    }
}

#[derive(Clone, Copy)]
struct Candidate {
    total: f64,
    low: f64,
    high: f64,
    points: usize,
    signal: f64,
    strength: f64,
    baseline: bool,
    legacy: bool,
    as_of: i64,
}

#[derive(Serialize)]
struct Estimate {
    total: f64,
    low: f64,
    high: f64,
    samples: usize,
    windows: usize,
    as_of: i64,
    method: &'static str,
    confidence: &'static str,
}

fn quantile(mut values: Vec<f64>, q: f64) -> f64 {
    values.sort_unstable_by(f64::total_cmp);
    let i = (values.len() - 1) as f64 * q;
    let lower = i.floor() as usize;
    values[lower] + (values[i.ceil() as usize] - values[lower]) * i.fract()
}

fn weighted_quantile(values: impl Iterator<Item = (f64, f64)>, q: f64) -> f64 {
    let mut values: Vec<_> = values.collect();
    values.sort_unstable_by(|a, b| a.0.total_cmp(&b.0));
    let threshold = values.iter().map(|v| v.1).sum::<f64>() * q;
    let mut cumulative = 0.0;
    for &(value, weight) in &values {
        cumulative += weight;
        if cumulative >= threshold {
            return value;
        }
    }
    values.last().unwrap().0
}

fn from_segment(segment: &[&Row]) -> Option<Candidate> {
    // Uniformly sample long sequences so minute-by-minute snapshots don't
    // swamp windows with fewer observations. Including both endpoints also
    // preserves useful large changes through 1%-rounded Codex plateaus.
    let n = segment.len().min(MAX_POINTS_PER_SEGMENT);
    if n < 2 {
        return None;
    }
    let observations: Vec<_> = (0..n)
        .map(|i| segment[i * (segment.len() - 1) / (n - 1)])
        .collect();
    let mut pairs = Vec::new();
    let mut low = Vec::new();
    let mut high = Vec::new();
    let mut used = vec![false; n];
    let mut as_of = 0;
    let mut max_delta: f64 = 0.0;
    for (i, a) in observations.iter().enumerate() {
        for (j, b) in observations.iter().enumerate().skip(i + 1) {
            let dp = b.pct - a.pct;
            let dt = b.tok - a.tok;
            // 100% is a censored observation: usage may already exceed the cap.
            if !a.complete || !b.complete || b.ts <= a.ts || b.pct >= 99.5 || dp < MIN_DELTA_PCT || dt <= 0.0 {
                continue;
            }
            used[i] = true;
            used[j] = true;
            as_of = as_of.max(b.ts);
            max_delta = max_delta.max(dp);
            pairs.push(100.0 * dt / dp);
            low.push(100.0 * dt / (dp + 1.0));
            high.push(100.0 * dt / (dp - 1.0));
        }
    }
    if pairs.is_empty() {
        return None;
    }
    let total = quantile(pairs, 0.5);
    Some(Candidate {
        total, low: quantile(low, 0.2), high: quantile(high, 0.8),
        points: used.iter().filter(|used| **used).count(), signal: max_delta,
        strength: (max_delta / 12.0).clamp(0.35, 1.0),
        baseline: false, legacy: observations.iter().all(|r| r.v < 3),
        as_of,
    })
}

fn baseline(segment: &[&Row]) -> Option<Candidate> {
    // A single initial-origin reading is only a provisional estimate. No
    // origin fits after a reset/discontinuity, even if the percentage is high.
    let row = segment.iter().rev().find(|row| row.complete && (5.0..95.0).contains(&row.pct) && row.tok > 0.0)?;
    let total = 100.0 * row.tok / row.pct;
    Some(Candidate {
        total, low: total * 0.6, high: total * 1.7, points: 1, signal: 0.0,
        strength: 0.25, baseline: true, legacy: row.v < 3, as_of: row.ts,
    })
}

fn discontinuity(previous: &Row, next: &Row) -> &'static str {
    if !previous.same_generation(next) {
        let expected = previous.start().saturating_add(previous.win);
        return if next.ts.saturating_add(GENERATION_TOLERANCE) < expected { "early_reset" } else { "new_window" };
    }
    let dp = next.pct - previous.pct;
    let dt = next.tok - previous.tok;
    if dp < -PERCENT_JITTER {
        return "meter_decreased";
    }
    if dt < -0.5 {
        return "observed_usage_decreased";
    }
    if dp > PERCENT_JITTER && dt <= 0.5 {
        return "external_activity";
    }
    ""
}

/// Assess one window at a time, with separate intercepts around observed jumps.
/// Pairwise medians within segments and a recency-weighted median over at most
/// eight reset windows keep a busy week or one isolated outlier from dominating.
fn calibrate(rows: &[&Row]) -> (Option<Estimate>, Vec<f64>) {
    let mut groups: Vec<Vec<Vec<&Row>>> = vec![];
    for &row in rows {
        let current = groups.last_mut();
        let previous = current.as_ref().and_then(|g| g.last()).and_then(|s| s.last()).copied();
        let new_window = current.as_ref().and_then(|g| g.first()).and_then(|s| s.first())
            .is_none_or(|anchor| !anchor.same_generation(row));
        if new_window {
            groups.push(vec![vec![row]]);
        } else if let (Some(group), Some(previous)) = (current, previous) {
            if !row.change.is_empty() || !discontinuity(previous, row).is_empty() {
                group.push(vec![row]);
            } else {
                group.last_mut().unwrap().push(row);
            }
        }
    }
    let mut windows: Vec<Candidate> = groups.iter().rev().take(MAX_WINDOWS).filter_map(|segments| {
        // Use the most informative robust segment, not the last sample alone.
        segments.iter().filter_map(|s| from_segment(s))
            .max_by(|a, b| a.signal.total_cmp(&b.signal).then(a.as_of.cmp(&b.as_of)))
            .or_else(|| {
                let first = segments.first()?;
                if segments.len() == 1 && first.first()?.change.is_empty() {
                    baseline(first)
                } else {
                    None
                }
            })
    }).collect();
    if windows.is_empty() {
        return (None, vec![]);
    }
    if windows.iter().any(|c| !c.baseline) {
        windows.retain(|c| !c.baseline);
    }
    // Two independently reset windows agreeing on a sustained scale change can
    // supersede earlier windows even if the provider kept the same plan name.
    if windows.len() >= 3 && !windows[0].baseline && windows[0].signal >= 6.0 && windows[1].signal >= 6.0 {
        let recent = (windows[0].total + windows[1].total) / 2.0;
        let past = quantile(windows[2..].iter().map(|c| c.total).collect(), 0.5);
        let agreement = (windows[0].total / windows[1].total).ln().abs();
        if agreement < 1.25_f64.ln() && (recent / past).ln().abs() > 1.4_f64.ln() {
            windows.truncate(2);
        }
    }
    let weight = |i: usize, candidate: &Candidate| {
        0.80_f64.powi(i as i32) * candidate.strength * if candidate.legacy { 0.65 } else { 1.0 }
    };
    let total = weighted_quantile(windows.iter().enumerate().map(|(i, c)| (c.total, weight(i, c))), 0.5);
    let low = weighted_quantile(windows.iter().enumerate().map(|(i, c)| (c.low, weight(i, c))), 0.2).min(total);
    let high = weighted_quantile(windows.iter().enumerate().map(|(i, c)| (c.high, weight(i, c))), 0.8).max(total);
    let all_legacy = windows.iter().all(|w| w.legacy);
    let confidence = if windows[0].baseline || high / low > 2.0 || all_legacy {
        "low"
    } else if windows.len() >= 3 && high / low < 1.35 && windows.iter().filter(|c| c.signal >= 6.0).count() >= 2 {
        "high"
    } else if windows.len() >= 2 || windows[0].signal >= 8.0 && windows[0].points >= 4 {
        "medium"
    } else {
        "low"
    };
    (Some(Estimate {
        total, low, high, windows: windows.len(),
        samples: windows.iter().map(|c| c.points).sum(),
        as_of: windows.iter().map(|c| c.as_of).max().unwrap_or(0),
        method: if windows[0].baseline { "baseline" } else { "increments" },
        confidence,
    }), windows.iter().rev().map(|candidate| candidate.total).collect())
}

fn evaluate_rows(current: &Row, history: &[Row]) -> (Value, String) {
    let mut sorted: Vec<_> = history.iter()
        .filter(|row| row.valid() && (row.ts < current.ts || !current.complete && row.ts == current.ts)
            && row.ts >= current.ts - MAX_SAMPLE_AGE && row.same_measurement(current))
        .collect();
    sorted.sort_by_key(|row| row.ts);
    sorted.dedup_by_key(|row| row.ts);
    let previous = sorted.iter().rev().find(|row| row.complete).copied();
    // Legacy readers stored a single "external" marker for the whole window.
    // A 1pp plateau boundary is not evidence of external usage. Larger
    // confirmed legacy jumps are kept as segment boundaries, not quota points.
    let mut points = Vec::with_capacity(sorted.len() + 1);
    let mut prior = None;
    for row in &sorted {
        if row.complete && !row.external {
            points.push(*row);
            prior = Some(*row);
        } else if row.external && prior.is_some_and(|p: &Row| discontinuity(p, row) == "external_activity") {
            points.push(*row);
            prior = Some(*row);
        }
    }
    let mut change = previous.map_or("", |row| discontinuity(row, current)).to_string();
    if !current.complete || !current.valid() {
        change.clear();
    }
    let (prior_estimate, prior_history) = calibrate(&points);
    if change.is_empty() && current.complete && current.valid() {
        if let (Some(previous), Some(estimate)) = (previous, prior_estimate.as_ref()) {
            if estimate.confidence != "low" && previous.same_generation(current) && previous.change.is_empty() && current.pct < 99.5 {
                let dp = current.pct - previous.pct;
                let expected_max = 100.0 * (current.tok - previous.tok).max(0.0) / estimate.low;
                if dp >= 4.0 && dp - expected_max >= 3.0 && expected_max < dp * 0.4 {
                    change = "unexplained_jump".into();
                }
            }
        }
    }
    let mut normalized = current.clone();
    // Expected resets create a new window, not a contaminated initial origin.
    if change != "new_window" && change != "early_reset" {
        normalized.change = change.clone();
    }
    if normalized.valid() && normalized.complete {
        points.push(&normalized);
    }
    let (estimate, _) = if current.complete && current.valid() {
        calibrate(&points)
    } else {
        (prior_estimate, vec![])
    };
    let issue = match change.as_str() {
        "new_window" | "" if !current.complete => "incomplete_coverage",
        "new_window" | "" if current.pct >= 99.5 => "saturated",
        "new_window" | "" if current.tok <= 0.0 => "no_local_usage",
        "new_window" | "" => "ok",
        other => other,
    };
    let external = matches!(issue, "external_activity" | "unexplained_jump");
    let quality = estimate.as_ref().map_or("low", |e| e.confidence);
    (
        json!({
            "ok": true, "estimate": estimate, "history": prior_history,
            "externalActivity": external, "usable": current.valid() && current.complete && issue == "ok",
            "quality": quality, "reason": issue,
        }),
        normalized.change,
    )
}

pub fn evaluate(path: &Path, observation: &Observation<'_>) -> Value {
    evaluate_rows(&observation.row(), &read(path)).0
}

pub fn record(path: &Path, observation: &Observation<'_>) -> Value {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|err| err.into_inner());
    let mut row = observation.row();
    let history = read(path);
    let (mut result, change) = evaluate_rows(&row, &history);
    row.change = change;
    // Retain zero and 100% observations as anchors/censoring information.
    // Store a stable plateau at most every five minutes, but never drop jumps.
    let previous = history.iter().filter(|old| old.same_measurement(&row)).max_by_key(|old| old.ts);
    let meaningful = previous.is_none_or(|old| {
        old.ts < row.ts && (!old.same_generation(&row) || (old.pct - row.pct).abs() >= 0.25
            || !row.change.is_empty() || (row.ts - old.ts >= 300 && (old.tok - row.tok).abs() >= 1.0))
    });
    let recorded = row.valid() && row.complete && meaningful;
    if recorded {
        append(path, &row);
    }
    result["recorded"] = Value::Bool(recorded);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const WEEK: i64 = 604_800;
    const EPOCH: i64 = 1_700_000_000;

    fn observation(start: i64, elapsed: i64, pct: f64, tokens: f64) -> Observation<'static> {
        Observation {
            provider: "codex", account: "work", window: WEEK,
            scope: "aggregate", cohort: "windows+wsl", plan: "prolite",
            at: start + elapsed, elapsed, pct, tokens, complete: true, share: None,
        }
    }

    fn row(elapsed: i64, pct: f64, tokens: f64) -> Row {
        observation(EPOCH, elapsed, pct, tokens).row()
    }

    fn assert_total(result: &Value, expected: f64) {
        let total = result["estimate"]["total"].as_f64().unwrap();
        assert!((total - expected).abs() <= expected / 100.0, "{result}");
    }

    #[test]
    fn weekly_only_plan_reuses_the_capacity_at_zero_and_rejects_other_windows() {
        let mut wrong_plan = row(300, 20.0, 10.0);
        wrong_plan.plan = "plus".into();
        let mut wrong_account = row(301, 80.0, 20.0);
        wrong_account.a = "default".into();
        let mut wrong_window = row(302, 40.0, 30.0);
        wrong_window.win = 18_000;
        let mut wrong_sources = row(303, 35.0, 9_000.0);
        wrong_sources.cohort = "windows-only".into();
        let history = vec![
            row(0, 0.0, 0.0), wrong_plan, wrong_account, wrong_window, wrong_sources,
            row(1000, 8.0, 800.0), row(2000, 12.0, 1200.0), row(3000, 16.0, 1600.0),
        ];
        let current = observation(EPOCH + WEEK, 0, 0.0, 0.0).row();
        let (result, _) = evaluate_rows(&current, &history);
        assert_total(&result, 10_000.0);
        assert_eq!(result["estimate"]["method"], "increments");
        assert_eq!(result["externalActivity"], false);
    }

    #[test]
    fn allows_rounding_and_recovers_after_unobserved_activity_and_gifts() {
        let mut history = vec![
            row(100, 10.0, 1000.0),
            row(200, 11.0, 1000.0),
            row(900, 20.0, 2000.0),
            row(1300, 24.0, 2400.0),
            row(1700, 28.0, 2800.0),
        ];
        let one_percent = evaluate_rows(&row(1800, 29.0, 2800.0), &history).0;
        assert_eq!(one_percent["externalActivity"], false);
        let mut spike = row(1900, 47.0, 2900.0);
        let (unobserved, change) = evaluate_rows(&spike, &history);
        assert_eq!(unobserved["reason"], "unexplained_jump");
        assert_total(&unobserved, 10_000.0);
        spike.change = change;
        history.push(spike);
        history.push(row(2500, 53.0, 3500.0));
        let mut gift = row(2700, 30.0, 3500.0);
        let (changed, change) = evaluate_rows(&gift, &history);
        assert_eq!(changed["reason"], "meter_decreased");
        gift.change = change;
        history.push(gift);
        history.push(row(3400, 37.0, 4200.0));
        history.push(row(3900, 42.0, 4700.0));
        let recovered = evaluate_rows(&row(4500, 48.0, 5300.0), &history).0;
        assert_eq!(recovered["usable"], true);
        assert_total(&recovered, 10_000.0);
    }

    #[test]
    fn early_reset_and_saturation_are_not_mixed_into_increments() {
        let history = vec![row(1000, 10.0, 1000.0), row(2000, 20.0, 2000.0)];
        let saturated = evaluate_rows(&row(3000, 100.0, 90_000.0), &history).0;
        assert_eq!(saturated["reason"], "saturated");
        assert_total(&saturated, 10_000.0);
        let reset = observation(EPOCH + 3600, 60, 0.0, 0.0).row();
        let early = evaluate_rows(&reset, &history).0;
        assert_eq!(early["reason"], "early_reset");
        assert_total(&early, 10_000.0);
    }

    #[test]
    fn persistent_scale_changes_supersede_older_matching_plan_windows() {
        let mut history = Vec::new();
        for i in 0..5 {
            let total = if i < 3 { 10_000.0 } else { 18_000.0 };
            for pct in [5.0, 10.0, 15.0, 20.0] {
                history.push(observation(EPOCH + i * WEEK, (pct * 100.0) as i64, pct, total * pct / 100.0).row());
            }
        }
        let result = evaluate_rows(&observation(EPOCH + 5 * WEEK, 0, 0.0, 0.0).row(), &history).0;
        assert_total(&result, 18_000.0);
        assert_eq!(result["estimate"]["windows"], 2);
    }

    #[test]
    fn incomplete_points_are_not_written_and_legacy_plan_remains_isolated() {
        let file = std::env::temp_dir().join(format!("envtools-quota-v3-{}.jsonl", std::process::id()));
        let _ = std::fs::remove_file(&file);
        let mut sample = observation(EPOCH, 100, 0.0, 0.0);
        sample.complete = false;
        assert_eq!(record(&file, &sample)["recorded"], false);
        sample.complete = true;
        assert_eq!(record(&file, &sample)["recorded"], true);
        assert_eq!(record(&file, &sample)["recorded"], false);
        let mut legacy = row(500, 15.0, 1500.0);
        legacy.v = 2;
        legacy.cohort.clear();
        append(&file, &legacy);
        let accepted = evaluate(&file, &observation(EPOCH, 1000, 20.0, 2000.0));
        assert_total(&accepted, 10_000.0);
        let mut switched = observation(EPOCH, 1000, 1.0, 0.0);
        switched.plan = "plus";
        assert!(evaluate(&file, &switched)["estimate"].is_null());
        let _ = std::fs::remove_file(file);
    }
}
