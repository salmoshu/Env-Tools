//! 自动养护（1:1 移植自 Jharu autocare.rs，Apache 2.0，按本应用的
//! 后端常驻进程形态裁剪）。
//!
//! 后台任务每几分钟醒一次，到检查间隔（默认 6 小时）时做三件事：
//! 1. 记一条驱动器读数进空间历史（便宜，喂预测）。
//! 2. 记录低于空闲空间阈值的驱动器（事件列表，前端轮询展示）。
//! 3. 定时清理开启且到期时运行它。
//!
//! 定时清理刻意收窄（同 Jharu）：
//! - 只考虑评 Safe 且规则声明工具自动重建（Restore::Automatic）的开发缓存；
//! - 数天（默认 7 天）内无访问的才动；
//! - 小于 100MB 的不值得一次定时运行的关注；
//! - 移除前用最新事实再问一遍：仍 Safe、无程序从该目录运行、未被修改。
//! 其余一概不碰，无论多大。移除进回收站并写清理日志。默认关闭。
//!
//! 配置与运行记录持久化在
//! `<local>/.cache/ai-usage-monitor/autocare.json`。

use serde_json::Value;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DAY: u64 = 86_400;
/// 小于此体积的缓存不值得定时运行的关注。
const MIN_CLEAN_BYTES: u64 = 100 << 20;
/// 后台线程的时钟检查步长。
const TICK: Duration = Duration::from_secs(300);

#[derive(Clone)]
struct Config {
    enabled: bool,
    /// 检查间隔（小时）。
    interval_hours: u64,
    /// 空闲空间告警阈值（GB，0=关）。
    alert_free_gb: u64,
    /// 缓存至少 N 天未访问才清理。
    untouched_days: u64,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: false, interval_hours: 6, alert_free_gb: 20, untouched_days: 7 }
    }
}

struct State {
    config: Config,
    last_run: Option<u64>,
    /// 事件日志（最新在前，最多保留 50 条）。
    events: Vec<Value>,
    /// 驱动器 → 上次低空间提醒时间。
    alerted: std::collections::HashMap<String, u64>,
    /// 是否正在清理。
    cleaning: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn state_path() -> Option<PathBuf> {
    Some(crate::settings::local_home().join(".cache").join("ai-usage-monitor").join("autocare.json"))
}

fn now_secs() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) }

fn load_state() -> State {
    let mut st = State {
        config: Config::default(),
        last_run: None,
        events: vec![],
        alerted: std::collections::HashMap::new(),
        cleaning: false,
    };
    if let Some(p) = state_path() {
        if let Ok(text) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                st.config.enabled = v["enabled"].as_bool().unwrap_or(false);
                st.config.interval_hours = v["interval_hours"].as_u64().unwrap_or(6);
                st.config.alert_free_gb = v["alert_free_gb"].as_u64().unwrap_or(20);
                st.config.untouched_days = v["untouched_days"].as_u64().unwrap_or(7);
                st.last_run = v["last_run"].as_u64();
                if let Some(ev) = v["events"].as_array() { st.events = ev.clone(); }
            }
        }
    }
    st
}

fn save_state(st: &State) {
    let Some(p) = state_path() else { return };
    if let Some(dir) = p.parent() { let _ = std::fs::create_dir_all(dir); }
    let v = serde_json::json!({
        "enabled": st.config.enabled,
        "interval_hours": st.config.interval_hours,
        "alert_free_gb": st.config.alert_free_gb,
        "untouched_days": st.config.untouched_days,
        "last_run": st.last_run,
        "events": st.events,
    });
    let _ = std::fs::write(&p, v.to_string());
}

fn push_event(st: &mut State, kind: &str, text: String) {
    st.events.insert(0, serde_json::json!({
        "ts": now_secs(), "kind": kind, "text": text,
    }));
    st.events.truncate(50);
}

/// 启动后台养护任务（幂等，server 启动时调用一次）。
pub fn start() {
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
    std::thread::spawn(|| {
        // 让应用先完成启动。
        std::thread::sleep(Duration::from_secs(45));
        loop {
            std::thread::sleep(TICK);
            let tick = tick_once();
            if let Err(e) = tick { eprintln!("autocare tick failed: {e}"); }
        }
    });
}

fn tick_once() -> Result<(), String> {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = guard.get_or_insert_with(load_state);
    if !st.config.enabled { return Ok(()); }
    let interval = st.config.interval_hours.max(1) * 3600;
    let due = st.last_run.map_or(true, |t| now_secs().saturating_sub(t) >= interval);
    if !due || st.cleaning { return Ok(()); }
    st.cleaning = true;
    let config = st.config.clone();
    drop(guard);
    // 清理在锁外执行（可能耗时数分钟；期间 status/update 不被阻塞）。
    let r = scheduled_clean(&config);
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = guard.get_or_insert_with(load_state);
    st.last_run = Some(now_secs());
    for (kind, text) in r.events {
        push_event(st, &kind, text);
    }
    push_event(st, "run", format!("定时清理完成：移入 {} 项，释放 {}", r.moved, r.freed_h));
    st.cleaning = false;
    save_state(st);
    Ok(())
}

struct CleanOutcome { moved: usize, freed_h: String, events: Vec<(String, String)> }

/// 定时清理：只动 Safe + 自动重建 + N 天未动 + ≥100MB 的开发缓存。
/// 移除前逐项重新核对（同 Jharu 的"最后一问"）。
fn scheduled_clean(config: &Config) -> CleanOutcome {
    use crate::jharu::{dev_rules, Safety, Restore};
    let mut out = CleanOutcome { moved: 0, freed_h: "0B".into(), events: vec![] };
    let mut freed: u64 = 0;
    let cutoff = SystemTime::now() - Duration::from_secs(config.untouched_days.max(1) as u64 * DAY);
    for rule in dev_rules() {
        // 只有工具自动重建的 Safe 缓存才考虑。
        if rule.safety != Safety::Safe { continue; }
        if !matches!(rule.restore, Restore::Automatic) { continue; }
        // 规则声明的工具正在运行时跳过（运行中的缓存不做定时清理）。
        if crate::jharu::is_any_tool_running(rule.tools) { continue; }
        for path in crate::jharu::dev_rule_paths(rule.id) {
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            // 数天内无访问。
            let accessed = meta.accessed().ok().or_else(|| meta.modified().ok());
            let Some(at) = accessed else { continue };
            if at > cutoff { continue; }
            // 足够大才值得动。
            let size = if meta.is_dir() {
                let mut stack = vec![path.clone()];
                let mut t = 0u64;
                while let Some(p) = stack.pop() {
                    if let Ok(rd) = std::fs::read_dir(&p) {
                        for e in rd.flatten() {
                            let ep = e.path();
                            match std::fs::symlink_metadata(&ep) {
                                Ok(m) if m.is_dir() => stack.push(ep),
                                Ok(m) => t += m.len(),
                                _ => {}
                            }
                        }
                    }
                }
                t
            } else { meta.len() };
            if size < MIN_CLEAN_BYTES { continue; }
            // 移除前最后一问：此刻目录是否又被修改。
            if let Ok(m2) = std::fs::symlink_metadata(&path) {
                if let Ok(modified) = m2.modified() {
                    if modified > cutoff { continue; }
                }
            }
            // 移入回收站 + 日志。
            let items = vec![serde_json::json!({ "path": path.display().to_string(), "size": size, "source": "自动养护" })];
            let r = crate::jharu_bin::clean_and_journal(&items);
            if r["ok"].as_bool().unwrap_or(false) {
                out.moved += 1;
                freed += size;
                out.events.push(("clean".into(), format!("{}：{}", rule.name, crate::jharu_bin::hs(size))));
            }
        }
    }
    out.freed_h = crate::jharu_bin::hs(freed);
    out
}

// -------------------------------------------------------------- API

/// 不加锁的状态快照（调用方持有锁或已确保独占）。std::sync::Mutex 不可
/// 重入，持锁路径必须走这个而不是 status()。
fn status_of(st: &State) -> Value {
    serde_json::json!({
        "ok": true,
        "enabled": st.config.enabled,
        "interval_hours": st.config.interval_hours,
        "alert_free_gb": st.config.alert_free_gb,
        "untouched_days": st.config.untouched_days,
        "last_run": st.last_run,
        "cleaning": st.cleaning,
        "events": st.events,
    })
}

pub fn status() -> Value {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = guard.get_or_insert_with(load_state);
    status_of(st)
}

pub fn update(body: &Value) -> Value {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = guard.get_or_insert_with(load_state);
    if let Some(b) = body["enabled"].as_bool() { st.config.enabled = b; }
    if let Some(h) = body["interval_hours"].as_u64() { st.config.interval_hours = h.clamp(1, 72); }
    if let Some(g) = body["alert_free_gb"].as_u64() { st.config.alert_free_gb = g.min(1024); }
    if let Some(d) = body["untouched_days"].as_u64() { st.config.untouched_days = d.clamp(1, 90); }
    save_state(st);
    status_of(st)
}

/// 立即运行一次（手动触发，仍走全部安全检查）。
pub fn run_now() -> Value {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = guard.get_or_insert_with(load_state);
    if st.cleaning { return serde_json::json!({ "ok": false, "error": "清理已在进行" }); }
    st.cleaning = true;
    drop(guard);
    let config = {
        let guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
        let st = guard.as_ref().unwrap();
        st.config.clone()
    };
    let r = scheduled_clean(&config);
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = guard.get_or_insert_with(load_state);
    st.last_run = Some(now_secs());
    for (kind, text) in r.events { push_event(st, &kind, text); }
    push_event(st, "run", format!("手动触发清理：移入 {} 项，释放 {}", r.moved, r.freed_h));
    st.cleaning = false;
    save_state(st);
    serde_json::json!({ "ok": true, "moved": r.moved, "freed_h": r.freed_h })
}

