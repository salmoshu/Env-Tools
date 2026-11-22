//! Env-Tools 桌面应用的本地 API 网关（Rust + axum）。
//!
//! Electron 主进程拉起本服务，渲染层的数据请求统一走这里。v0.7.0 起数据
//! 引擎全部原生实现，不再依赖 Python：
//! - `GET /api/health`                     健康检查（含版本号）
//! - `GET /api/analytics?days=&agent=&aggregate=`  会话用量分析（原生引擎；
//!   aggregate=1 时合并本机与 WSL 家目录的会话数据）
//! - `GET /api/usage`                      四家配额全原生（按可见账号 profile
//!   读取凭证并并行采集，账户与错误均带账号身份）
//! - `GET|POST /api/settings`              数据源环境与会员到期配置
//! - `GET|POST /api/api-keys`              API key 状态查询 / 保存（支持账号范围）
//! - `GET|POST /api/accounts?provider=`    四家账号注册表与 active 管理
//! - `GET|POST /api/codex-accounts`        Codex 旧账号接口（兼容包装）
//! - `GET /api/backend-status`             引擎与数据源环境信息
//!
//! 任何失败都以 `{"ok": false, "error": ...}` 的 200 响应返回，由渲染层统一
//! 处理。监听 127.0.0.1，启动完成后向 stdout 打印 `LISTENING <port>`，供
//! Electron 主进程探测就绪状态。

use std::{
    collections::HashMap,
    future::Future,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    extract::Query,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use serde_json::Value;
use tokio::sync::Mutex;

mod accounts;
mod disk;
mod ai_tools;
mod apps;
mod autocare;
mod bin;
mod browsers;
mod cleaning;
mod codesign;
mod deep;
mod desktop;
mod dupes;
mod gadget;
mod health;
mod history;
mod jharu_api;
mod jharu_host;
mod jharu_migration;
mod junk;
mod models;
mod overview;
mod places;
mod processes;
mod projects;
mod protected;
mod python;
mod rules;
mod safety;
mod sandboxes;
mod scanner;
mod spacehistory;
mod startup;
mod system_space;
mod trashlog;
mod usage;
mod walk;
mod worktrees;
mod analytics;
mod apply_update;
mod quota;
mod quota_history;
mod settings;

#[cfg(test)]
#[path = "analytics_tests.rs"]
mod analytics_tests;

#[cfg(test)]
#[path = "quota_tests.rs"]
mod quota_tests;

/// 展示给用户的版本号：由 build.rs 从仓库根 VERSION 文件注入，
/// Cargo.toml 的 version 仅作编译期兜底，保证全项目版本显示一致。
pub(crate) const APP_VERSION: &str = match option_env!("APP_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

const ANALYTICS_TTL: Duration = Duration::from_secs(30);
/// 扫描节流窗（秒）：节流窗内复用引擎内已累积的记录，只重算聚合（纯内存，
/// 毫秒级）。数据未变时的重复全量扫描纯属浪费——WSL/聚合走 9P 尤甚（20s+）。
/// 刷新按钮经 /api/cache-clear 重置水位强制重扫。
const SCAN_GAP_LOCAL: i64 = 30;
const SCAN_GAP_WSL: i64 = 120;
const USAGE_TTL: Duration = Duration::from_secs(20);
const ANALYTICS_WSL_TTL: Duration = Duration::from_secs(120);

/// 配额快照专用分析引擎（与主 AppState.analytics 分离：usage 闭包 'static）。
/// HashMap::new 非 const——OnceLock 惰性初始化绕过静态限制
static SNAP_ENGINES: std::sync::OnceLock<
    std::sync::Mutex<
        std::collections::HashMap<String, Arc<std::sync::Mutex<analytics::AnalyticsState>>>,
    >,
> = std::sync::OnceLock::new();

#[derive(Clone)]
struct AppState {
    cache: Arc<Cache>,
    /// 原生分析引擎状态：按扫描范围（local / wsl:<distro> / aggregate）各一份，
    /// 进程内增量（std Mutex + spawn_blocking 避免阻塞运行时）
    analytics:
        Arc<std::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<analytics::AnalyticsState>>>>>,
    /// 可选鉴权 token（--token）：设置后所有 /api 请求（除 /api/health）必须带
    /// x-env-token 头。用于 SSH 等跨机场景；本机 loopback 可省略。
    token: Option<String>,
    /// 最近一次 /api 请求的时刻（毫秒，INSTANT_MILLIS 基准）；空闲自毁依据
    last_activity: Arc<std::sync::atomic::AtomicU64>,
}

fn now_millis() -> u64 {
    use std::time::SystemTime;
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn error_payload(message: String) -> Value {
    serde_json::json!({ "ok": false, "error": message })
}

/// 鉴权中间件：设置了 --token 时，除 health 外的请求必须携带 x-env-token。
/// 所有请求都会刷新活跃时间戳（空闲自毁的依据）。
async fn auth_guard(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    state
        .last_activity
        .store(now_millis(), std::sync::atomic::Ordering::Relaxed);
    if let Some(expected) = &state.token {
        let is_health = req.uri().path().starts_with("/api/health");
        let provided = req
            .headers()
            .get("x-env-token")
            .and_then(|v| v.to_str().ok());
        if !is_health && provided != Some(expected.as_str()) {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                Json(error_payload(
                    "invalid or missing x-env-token header".into(),
                )),
            )
                .into_response();
        }
    }
    next.run(req).await
}

/// 单飞缓存：同一 key 的并发请求共享同一次抓取（OnceCell），成功结果在
/// TTL 内直接复用；失败不落地，后续请求自动重试。
struct Cache {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
}

struct Entry {
    created: Instant,
    cell: tokio::sync::OnceCell<Value>,
}

impl Cache {
    fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }

    async fn get_or_fetch<F, Fut>(&self, key: String, ttl: Duration, fetch: F) -> Value
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Value>,
    {
        let entry = {
            let mut map = self.entries.lock().await;
            // 顺带清理：已过期且有值的旧代目直接淘汰；无值的（在途/失败）保留
            map.retain(|_, e| e.cell.get().is_none() || e.created.elapsed() < ttl);
            match map.get(&key) {
                Some(entry) => entry.clone(),
                None => {
                    let entry = Arc::new(Entry {
                        created: Instant::now(),
                        cell: tokio::sync::OnceCell::new(),
                    });
                    map.insert(key.clone(), entry.clone());
                    entry
                }
            }
        };
        if let Some(value) = entry.cell.get() {
            return value.clone();
        }
        entry.cell.get_or_init(fetch).await.clone()
    }
}

async fn health() -> Json<Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "env-tools-api",
        "version": APP_VERSION,
    }))
}

fn kimi_homes(aggregate: bool, wsl_distro: Option<&str>) -> Vec<PathBuf> {
    if let Some(distro) = wsl_distro {
        // 指定 WSL 发行版：仅扫描该发行版家目录（UNC）
        let mut homes: Vec<PathBuf> = Vec::new();
        for home in settings::wsl_distro_homes(distro) {
            homes.push(home.join(".kimi-code"));
            homes.push(home.join(".kimi"));
        }
        return homes;
    }
    let mut homes: Vec<PathBuf> = accounts::profiles(accounts::Provider::Kimi)
        .into_iter()
        .map(|account| account.home)
        .collect();
    if aggregate {
        for home in settings::wsl_homes() {
            homes.push(home.join(".kimi-code"));
            homes.push(home.join(".kimi"));
        }
    }
    homes
}

fn kimi_work_homes(wsl_distro: Option<&str>) -> Vec<PathBuf> {
    if wsl_distro.is_some() {
        return Vec::new();
    }
    if let Some(home) = std::env::var_os("KIMI_WORK_HOME") {
        return vec![PathBuf::from(home)];
    }
    if !cfg!(windows) {
        return Vec::new();
    }
    std::env::var_os("APPDATA")
        .map(|app_data| {
            PathBuf::from(app_data)
                .join("kimi-desktop")
                .join("daimon-share")
                .join("daimon")
                .join("runtime")
                .join("kimi-code")
                .join("home")
        })
        .into_iter()
        .collect()
}

fn zcode_homes(aggregate: bool, wsl_distro: Option<&str>) -> Vec<PathBuf> {
    if let Some(distro) = wsl_distro {
        return settings::wsl_distro_homes(distro);
    }
    let mut homes = vec![settings::local_home()];
    if aggregate {
        homes.extend(settings::wsl_homes());
    }
    homes
}

fn codex_homes(aggregate: bool, wsl_distro: Option<&str>) -> Vec<PathBuf> {
    if let Some(distro) = wsl_distro {
        return settings::wsl_distro_homes(distro)
            .into_iter()
            .map(|home| home.join(".codex"))
            .collect();
    }
    let mut homes: Vec<PathBuf> = settings::codex_accounts()
        .into_iter()
        .map(|account| account.home)
        .collect();
    if aggregate {
        for home in settings::wsl_homes() {
            homes.push(home.join(".codex"));
        }
    }
    homes
}

/// omp 家目录：~/.omp（会话在 agent/sessions，由 scan_all 决定子布局）。
/// 本机 + 聚合时的全部 WSL 发行版 UNC，与 kimi/codex 同模式
fn omp_homes(aggregate: bool, wsl_distro: Option<&str>) -> Vec<PathBuf> {
    if let Some(distro) = wsl_distro {
        return settings::wsl_distro_homes(distro)
            .into_iter()
            .map(|home| home.join(".omp"))
            .collect();
    }
    let mut homes = vec![omp_home()];
    if aggregate {
        for home in settings::wsl_homes() {
            homes.push(home.join(".omp"));
        }
    }
    homes
}

fn omp_home() -> PathBuf {
    if let Some(home) = std::env::var_os("OMP_HOME") {
        return PathBuf::from(home);
    }
    default_home(".omp")
}

fn default_home(dot_dir: &str) -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| PathBuf::from(home).join(dot_dir))
        .unwrap_or_else(|| PathBuf::from(dot_dir))
}

/// 分析 worker：扫描（节流）+ 聚合。引擎按 scope 各持一把细粒度锁——
/// aggregate 的 9P 长扫描不会阻塞 local 请求。启动预热也走这条路径。
fn analytics_worker(
    state: &AppState,
    days: u32,
    agent: &str,
    aggregate: bool,
    wsl_distro: Option<&str>,
    scope: &str,
) -> Value {
    let now = chrono::Local::now();
    let now_sec = now.timestamp();
    let engine_arc = {
        let mut engines = state.analytics.lock().unwrap();
        engines.entry(scope.to_string()).or_default().clone()
    };
    let mut engine = engine_arc.lock().unwrap();
    // 首次见到该 scope 的引擎：先水合磁盘缓存再扫描，重启后只需读增量字节
    engine.hydrate_once(&settings::scan_cache_path(scope));
    let scan_gap = if aggregate || wsl_distro.is_some() {
        SCAN_GAP_WSL
    } else {
        SCAN_GAP_LOCAL
    };
    let scan_started = std::time::Instant::now();
    let (dirty, scan_note) = if now_sec - engine.last_scan_secs >= scan_gap {
        let dirty = engine.scan_all(
            &kimi_homes(aggregate, wsl_distro),
            &codex_homes(aggregate, wsl_distro),
            &zcode_homes(aggregate, wsl_distro),
            &omp_homes(aggregate, wsl_distro),
            &kimi_work_homes(wsl_distro),
            now_sec,
        );
        engine.last_scan_secs = now_sec;
        if dirty {
            engine.save_cache(&settings::scan_cache_path(scope));
        }
        (
            dirty,
            format!(
                "scan {:.1}ms",
                scan_started.elapsed().as_secs_f64() * 1000.0
            ),
        )
    } else {
        (false, "scan throttled".to_string())
    };
    // 周起点设置（settings.json 的 week_start）注入周至今对比
    let week_start = settings::load_settings()
        .get("week_start")
        .and_then(|v| v.as_str())
        .unwrap_or("monday")
        .to_string();
    let payload = engine.aggregate_with_week_start(days, agent, now, &week_start);
    drop(engine);
    let engine_note = format!(
        "native-rust{}{} ({}, dirty={dirty})",
        if aggregate { "+wsl" } else { "" },
        if let Some(name) = wsl_distro {
            format!("[{name}]")
        } else {
            String::new()
        },
        scan_note,
    );
    serde_json::json!({
        "ok": true,
        "engine": engine_note,
        "analytics": payload,
    })
}

/// /api/analytics：原生引擎扫描 + 聚合（无网络、无子进程）；aggregate=1 时
/// 额外扫描 WSL 家目录（9P 访问较慢，缓存 TTL 放宽）。
async fn analytics(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let days: u32 = params
        .get("days")
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(30)
        .clamp(1, 365);
    let agent = params
        .get("agent")
        .map(String::as_str)
        .filter(|raw| analytics::AGENTS.contains(raw))
        .unwrap_or("all")
        .to_string();
    let aggregate = params
        .get("aggregate")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let wsl_distro = params
        .get("wsl_distro")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    // 扫描范围标识：每个范围独立的引擎状态。引擎对"消失文件"保留历史记录
    //（增量语义），共享单个状态会让上一个目标的记录污染下一个目标的结果。
    let scope = match wsl_distro.as_deref() {
        Some(distro) => format!("wsl:{distro}"),
        None if aggregate => "aggregate".to_string(),
        None => "local".to_string(),
    };
    let key = format!("analytics:{days}:{agent}:{scope}");
    let ttl = if aggregate || wsl_distro.is_some() {
        ANALYTICS_WSL_TTL
    } else {
        ANALYTICS_TTL
    };
    let state = state.clone();
    let cache = state.cache.clone();
    let value = cache
        .get_or_fetch(key, ttl, move || {
            let state = state.clone();
            let agent = agent.clone();
            let wsl_distro = wsl_distro.clone();
            let scope = scope.clone();
            async move {
                tokio::task::spawn_blocking(move || {
                    analytics_worker(
                        &state,
                        days,
                        &agent,
                        aggregate,
                        wsl_distro.as_deref(),
                        &scope,
                    )
                })
                .await
                .unwrap_or_else(|err| error_payload(format!("analytics worker failed: {err}")))
            }
        })
        .await;
    Json(value)
}

/// /api/analytics/rolling：额度估算用——provider + account 在
/// [at-seconds, at] 内同来源范围的请求级 token 总量（omp 按底层模型归并）。
/// 服务端百分比、覆盖状态和历史质量评估共同决定该点是否可用于反推。
/// 独立 rolling scope：与主分析互不干扰，扫描节流与主视图一致
async fn analytics_rolling(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let provider = params
        .get("agent")
        .map(String::as_str)
        .filter(|raw| ["kimi", "codex", "glm"].contains(raw))
        .unwrap_or("kimi")
        .to_string();
    let account_id = params
        .get("account_id")
        .map(String::as_str)
        .filter(|raw| !raw.is_empty())
        .unwrap_or("default")
        .to_string();
    let seconds: i64 = params
        .get("seconds")
        .and_then(|raw| raw.parse().ok())
        .unwrap_or(3600)
        .clamp(1, 60 * 86400);
    let aggregate = params
        .get("aggregate")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let wsl_distro = params
        .get("wsl_distro")
        .map(String::as_str)
        .filter(|raw| !raw.is_empty())
        .map(String::from);
    // 时钟对齐：cutoff 以配额 fetched_at 时刻为基准（百分比与 token 同一时刻），
    // 默认退化为 now（容错：配额时间戳缺失时）
    let at = params
        .get("at")
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or_else(|| chrono::Local::now().timestamp());
    let window_seconds = params
        .get("window")
        .and_then(|raw| raw.parse::<i64>().ok())
        .filter(|v| *v > 0);
    let with_history = params
        .get("history")
        .map(|v| v == "1" || v == "true")
        .unwrap_or(false);
    let observed_pct = params.get("pct").and_then(|raw| raw.parse::<f64>().ok());
    let plan = params.get("plan").and_then(|raw| raw.parse::<String>().ok()).unwrap_or_default();
    let estimate_scope = params
        .get("scope")
        .filter(|raw| !raw.is_empty() && raw.len() <= 128)
        .cloned()
        .unwrap_or_else(|| {
            if let Some(distro) = wsl_distro.as_deref() {
                format!("wsl:{distro}")
            } else if aggregate {
                "aggregate".into()
            } else {
                "local".into()
            }
        });
    let scope = if let Some(distro) = wsl_distro.as_deref() {
        format!("rolling:wsl:{distro}")
    } else if aggregate {
        "rolling:aggregate".to_string()
    } else {
        "rolling:local".to_string()
    };
    let engine_arc = {
        let mut engines = state.analytics.lock().unwrap();
        engines.entry(scope.clone()).or_default().clone()
    };
    let mut engine = engine_arc.lock().unwrap();
    engine.hydrate_once(&settings::scan_cache_path(&scope));
    let now_sec = chrono::Local::now().timestamp();
    let scan_gap = if aggregate || wsl_distro.is_some() { SCAN_GAP_WSL } else { SCAN_GAP_LOCAL };
    if now_sec - engine.last_scan_secs >= scan_gap {
        engine.scan_all(
            &kimi_homes(aggregate, wsl_distro.as_deref()),
            &codex_homes(aggregate, wsl_distro.as_deref()),
            &zcode_homes(aggregate, wsl_distro.as_deref()),
            &omp_homes(aggregate, wsl_distro.as_deref()),
            &kimi_work_homes(wsl_distro.as_deref()),
            now_sec,
        );
        engine.last_scan_secs = now_sec;
        engine.save_cache(&settings::scan_cache_path(&scope));
    }
    let scanned_through = engine.last_scan_secs;
    drop(engine);
    let tokens = engine_arc
        .lock()
        .unwrap()
        .rolling_quota_tokens_for_account(&provider, at - seconds, at, &account_id);
    let coverage_complete = scanned_through >= at;
    let assessment = match (window_seconds, observed_pct) {
        (Some(win), Some(pct)) => quota_history::evaluate(
            &settings::quota_history_path(),
            &provider,
            &account_id,
            win,
            &estimate_scope,
            &plan,
            at,
            seconds,
            pct,
            tokens as f64,
            coverage_complete,
        ),
        _ => Value::Null,
    };
    let history = if with_history {
        assessment.get("history").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let source_count = if aggregate { 1 + settings::wsl_homes().len() } else { 1 };
    Json(serde_json::json!({
        "ok": true,
        "agent": provider,
        "account_id": account_id,
        "seconds": seconds,
        "at": at,
        "tokens": tokens,
        "history": history,
        "sourceCount": source_count,
        "failedSources": 0,
        "coverageComplete": coverage_complete,
        "coverageEnd": scanned_through.min(at),
        "externalActivity": assessment.get("externalActivity").and_then(Value::as_bool).unwrap_or(false),
        "usable": assessment.get("usable").and_then(Value::as_bool).unwrap_or(false),
        "quality": assessment.get("quality").and_then(Value::as_str).unwrap_or("low"),
        "reason": assessment.get("reason").and_then(Value::as_str).unwrap_or("missing_percentage"),
    }))
}


/// /api/usage：四家配额全原生（Kimi/Codex OAuth 刷新 + DeepSeek/GLM 直连）。
async fn usage(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Value> {
    let value = state
        .cache
        .get_or_fetch("usage".to_string(), USAGE_TTL, move || async move {
            tokio::task::spawn_blocking(|| {
                let (accounts, errors) = quota::collect_all();
                // 配额快照落盘（额度估算精度）：pct/代际变化才落一行。
                // tokens 经 rolling 引擎按窗口 elapsed 取本机对应账号用量
                record_quota_snapshots(&accounts);
                let versions = settings::collect_versions();
                let settings = settings::load_settings();
                let data = serde_json::json!({
                    "accounts": accounts,
                    "errors": errors,
                    "versions": versions.get("providers").cloned().unwrap_or(serde_json::json!({})),
                    "monitor_version": APP_VERSION,
                    "environment": settings.get("environment").cloned().unwrap_or(Value::Null),
                    "native_environment": settings::native_environment(),
                });
                serde_json::json!({ "ok": true, "data": data })
            })
            .await
            .unwrap_or_else(|err| error_payload(format!("usage worker failed: {err}")))
        })
        .await;
    Json(value)
}

/// 配额快照：按账号自己的 fetched_at 对齐；百分比变化、代际变化或持续
/// token 增长均可形成样本，是否写入历史由质量评估决定。
fn record_quota_snapshots(accounts: &[Value]) {
    static LAST: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashMap<String, (i64, f64, i64, i64)>>,
    > = std::sync::OnceLock::new();
    let key_of = |provider: &str| match provider {
        "Kimi Code" => Some("kimi"),
        "OpenAI Codex" => Some("codex"),
        "GLM" => Some("glm"),
        _ => None,
    };
    let now_sec = chrono::Local::now().timestamp();
    for account in accounts {
        let Some(key) = key_of(account.get("provider").and_then(|v| v.as_str()).unwrap_or("")) else { continue };
        let account_id = account
            .get("account_id")
            .and_then(|v| v.as_str())
            .filter(|v| !v.is_empty())
            .unwrap_or("default");
        let at = account
            .get("fetched_at")
            .and_then(Value::as_str)
            .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
            .map(|time| time.timestamp())
            .unwrap_or(now_sec);
        let plan = account.get("plan").and_then(Value::as_str).unwrap_or("");
        for w in account.get("windows").and_then(|v| v.as_array()).unwrap_or(&Vec::new()) {
            let pct = w.get("used_percent").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let win = w.get("window_seconds").and_then(|v| v.as_i64()).unwrap_or(0);
            let Some(ra) = w.get("reset_after_seconds").and_then(|v| v.as_i64()) else { continue };
            if pct <= 0.0 || win <= 0 || win > 32 * 86400 {
                continue;
            }
            let elapsed = win - ra;
            if elapsed <= 0 {
                continue;
            }
            let gen = at - elapsed;
            let map_key = format!("{key}|{account_id}|{win}");
            let scope = "quota-history".to_string();
            let engine_arc = SNAP_ENGINES
                .get_or_init(Default::default)
                .lock()
                .unwrap()
                .entry(scope.clone())
                .or_default()
                .clone();
            let mut engine = engine_arc.lock().unwrap();
            engine.hydrate_once(&settings::scan_cache_path(&scope));
            if now_sec - engine.last_scan_secs >= SCAN_GAP_LOCAL {
                engine.scan_all(
                    &kimi_homes(false, None),
                    &codex_homes(false, None),
                    &zcode_homes(false, None),
                    &omp_homes(false, None),
                    &kimi_work_homes(None),
                    now_sec,
                );
                engine.last_scan_secs = now_sec;
                engine.save_cache(&settings::scan_cache_path(&scope));
            }
            let complete = engine.last_scan_secs >= at;
            let tokens = engine.rolling_quota_tokens_for_account(key, at - elapsed, at, account_id);
            drop(engine);
            let mut last = LAST.get_or_init(Default::default).lock().unwrap();
            if let Some((last_gen, last_pct, last_tok, last_at)) = last.get(&map_key) {
                let same_gen = (gen - last_gen).abs() <= 120;
                if same_gen
                    && (*last_pct - pct).abs() < 0.1
                    && (*last_tok == tokens || at - *last_at < 300)
                {
                    continue;
                }
            }
            quota_history::record(
                &settings::quota_history_path(),
                key,
                account_id,
                win,
                "local",
                plan,
                at,
                elapsed,
                pct,
                tokens as f64,
                complete,
            );
            last.insert(map_key, (gen, pct, tokens, at));
        }
    }
}

/// 保存一个已完成的当前来源范围样本；评估结果同时供前端做质量门控。
async fn quota_history_record(axum::extract::Json(body): axum::extract::Json<Value>) -> Json<Value> {
    let result = tokio::task::spawn_blocking(move || {
        let provider = body.get("provider").and_then(Value::as_str).unwrap_or("").to_string();
        let account = body.get("account").and_then(Value::as_str).unwrap_or("default").to_string();
        let scope = body.get("scope").and_then(Value::as_str).unwrap_or("local").to_string();
        let plan = body.get("plan").and_then(Value::as_str).unwrap_or("").to_string();
        let window = body.get("window").and_then(Value::as_i64).unwrap_or(0);
        let at = body.get("at").and_then(Value::as_i64).unwrap_or(0);
        let elapsed = body.get("elapsed").and_then(Value::as_i64).unwrap_or(0);
        let pct = body.get("pct").and_then(Value::as_f64).unwrap_or(0.0);
        let tokens = body.get("tokens").and_then(Value::as_f64).unwrap_or(0.0);
        let complete = body.get("complete").and_then(Value::as_bool).unwrap_or(false);
        if provider.is_empty() || window <= 0 || at <= 0 || elapsed <= 0 {
            return error_payload("invalid quota history sample".into());
        }
        quota_history::record(
            &settings::quota_history_path(), &provider, &account, window, &scope, &plan,
            at, elapsed, pct, tokens, complete,
        )
    })
    .await
    .unwrap_or_else(|err| error_payload(format!("quota history worker failed: {err}")));
    Json(result)
}

/// 手动刷新：清空分析/配额缓存，下次请求强制增量重扫
async fn cache_clear(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Value> {
    state.cache.entries.lock().await.clear();
    // 重置扫描节流水位：下一次分析请求强制增量重扫（手动刷新语义）
    for engine in state.analytics.lock().unwrap().values() {
        engine.lock().unwrap().last_scan_secs = 0;
    }
    Json(serde_json::json!({ "ok": true }))
}

/// 重置成功后失效配额缓存：下一次 /api/usage 强制重新拉取（前端随即刷新
/// 看到的就是新窗口/新剩余次数）。
async fn invalidate_usage_cache(state: &AppState) {
    state.cache.entries.lock().await.remove("usage");
}

/// GLM Coding Plan：使用指定账号的一张 5h/7d 重置卡。
async fn quota_reset_glm(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let account_id = payload
        .get("account_id")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    let reset_type = payload
        .get("reset_type")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let result = tokio::task::spawn_blocking(move || {
        quota::use_glm_reset_card(&account_id, &reset_type)
    })
    .await
    .unwrap_or_else(|err| Err(format!("reset worker failed: {err}")));
    match result {
        Ok(data) => {
            invalidate_usage_cache(&state).await;
            Json(serde_json::json!({ "ok": true, "data": data }))
        }
        Err(err) => Json(error_payload(err)),
    }
}

/// OpenAI Codex：消耗指定账号的速率限制重置额度。
async fn quota_reset_codex(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let account_id = payload
        .get("account_id")
        .and_then(|value| value.as_str())
        .unwrap_or("default")
        .to_string();
    let result = tokio::task::spawn_blocking(move || quota::consume_codex_reset_credit(&account_id))
        .await
        .unwrap_or_else(|err| Err(format!("reset worker failed: {err}")));
    match result {
        Ok(data) => {
            // code=reset 才代表真正重置成功；其它代码（nothing_to_reset 等）
            // 缓存照样失效，前端刷新后能看到最新窗口状态
            invalidate_usage_cache(&state).await;
            Json(serde_json::json!({ "ok": true, "data": data }))
        }
        Err(err) => Json(error_payload(err)),
    }
}

/// Kimi 网页会话：保存 refresh_token 并验证。错误码区分“需重新授权”
///（kimi_web_session_expired / missing_token）与网络临时失败，前端据此引导。
async fn kimi_web_credential(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let result = tokio::task::spawn_blocking(move || quota::save_kimi_web_credential(&payload))
        .await
        .unwrap_or_else(|err| {
            Err(quota::KimiWebError {
                code: "kimi_web_worker".into(),
                message: format!("credential worker failed: {err}"),
            })
        });
    match result {
        Ok(data) => {
            invalidate_usage_cache(&state).await;
            Json(serde_json::json!({ "ok": true, "data": data }))
        }
        Err(err) => Json(serde_json::json!({
            "ok": false,
            "code": err.code,
            "error": err.message,
        })),
    }
}

async fn backend_status() -> Json<Value> {
    Json(settings::backend_status_payload())
}

async fn get_settings() -> Json<Value> {
    Json(settings::settings_payload())
}

async fn update_settings(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    // 环境切换影响后续 usage 缓存内容，保存成功后整体失效
    let result = settings::update_settings(&payload);
    if result
        .as_ref()
        .map(|r| r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false))
        .unwrap_or(false)
    {
        state.cache.entries.lock().await.clear();
    }
    Json(result.unwrap_or_else(|err| error_payload(err)))
}

async fn api_key_status(Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    match (params.get("provider"), params.get("account_id")) {
        (None, None) => Json(settings::api_key_status()),
        (Some(provider), Some(account_id)) => Json(
            settings::scoped_api_key_status(provider, account_id)
                .unwrap_or_else(|err| error_payload(err)),
        ),
        _ => Json(error_payload(
            "provider and account_id are required together".into(),
        )),
    }
}

async fn save_api_keys(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let result = settings::save_api_keys(&payload);
    if result
        .as_ref()
        .map(|value| value.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .unwrap_or(false)
    {
        invalidate_usage_cache(&state).await;
    }
    Json(result.unwrap_or_else(|err| error_payload(err)))
}

fn requested_provider(params: &HashMap<String, String>) -> Result<accounts::Provider, String> {
    let value = params
        .get("provider")
        .map(String::as_str)
        .unwrap_or("");
    accounts::Provider::parse(value)
        .ok_or_else(|| format!("Unsupported account provider: {value}"))
}

async fn get_accounts(Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    match requested_provider(&params) {
        Ok(provider) => Json(settings::accounts_payload(provider)),
        Err(err) => Json(error_payload(err)),
    }
}

async fn update_account_provider(
    state: AppState,
    provider: accounts::Provider,
    payload: Value,
) -> Json<Value> {
    let result = if provider == accounts::Provider::Codex {
        settings::update_codex_accounts(&payload)
    } else {
        settings::update_accounts(provider, &payload)
    };
    let changed = payload.get("action").and_then(Value::as_str) != Some("set-active");
    if changed
        && result
            .as_ref()
            .map(|value| value.get("ok").and_then(Value::as_bool).unwrap_or(false))
            .unwrap_or(false)
    {
        invalidate_usage_cache(&state).await;
    }
    Json(result.unwrap_or_else(|err| error_payload(err)))
}

async fn update_accounts(
    axum::extract::State(state): axum::extract::State<AppState>,
    Query(params): Query<HashMap<String, String>>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    match requested_provider(&params) {
        Ok(provider) => update_account_provider(state, provider, payload).await,
        Err(err) => Json(error_payload(err)),
    }
}

async fn get_codex_accounts() -> Json<Value> {
    Json(settings::codex_accounts_payload())
}

async fn update_codex_accounts(
    axum::extract::State(state): axum::extract::State<AppState>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    update_account_provider(state, accounts::Provider::Codex, payload).await
}

#[tokio::main]
async fn main() {
    // 固定动作提权助手：只执行 Jharu 白名单中的清理、启动项和系统空间动作。
    let process_args: Vec<String> = std::env::args().collect();
    if let Some(code) = cleaning::helper_main(&process_args) {
        std::process::exit(code);
    }
    if let Some(code) = startup::helper_main(&process_args) {
        std::process::exit(code);
    }
    if let Some(code) = system_space::helper_main(&process_args) {
        std::process::exit(code);
    }
    // apply-update 子命令：自升级解压/交换（Electron 退出前 detached 拉起），
    // 处理完直接退出，不起 server（不影响 LISTENING 探测协议）。
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    if raw_args.first().map(String::as_str) == Some("apply-update") {
        std::process::exit(apply_update::run(&raw_args[1..]));
    }
    let mut port: u16 = 8747;
    let mut token: Option<String> = None;
    let mut idle_exit_secs: u64 = 0;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(raw) = args.next() {
                    port = raw.parse().unwrap_or(port);
                }
            }
            "--monitor" => {
                // v0.6 兼容：python 引擎已移除，忽略该参数
                let _ = args.next();
            }
            "--token" => {
                if let Some(raw) = args.next() {
                    token = Some(raw);
                }
            }
            "--idle-exit-secs" => {
                if let Some(raw) = args.next() {
                    idle_exit_secs = raw.parse().unwrap_or(0);
                }
            }
            other => eprintln!("unknown argument: {other}"),
        }
    }

    let state = AppState {
        cache: Arc::new(Cache::new()),
        analytics: Arc::new(std::sync::Mutex::new(HashMap::new())),
        token,
        last_activity: Arc::new(std::sync::atomic::AtomicU64::new(now_millis())),
    };

    // 空闲自毁（v0.7.1）：应用异常退出留下的孤儿后端，超过阈值无任何请求
    // 即自行退出，避免长期驻留的旧版本进程。0 = 不启用（SSH/手动模式）。
    if idle_exit_secs > 0 {
        let state = state.clone();
        tokio::spawn(async move {
            // 小阈值（调试/烟测）按秒级检查，保证阈值附近及时退出；
            // 常态大阈值保持 30s 慢检查
            let tick_secs = if idle_exit_secs <= 30 { 1 } else { 30 };
            let mut ticker = tokio::time::interval(Duration::from_secs(tick_secs));
            loop {
                ticker.tick().await;
                let last = state
                    .last_activity
                    .load(std::sync::atomic::Ordering::Relaxed);
                if now_millis().saturating_sub(last) > idle_exit_secs * 1000 {
                    eprintln!("idle for {idle_exit_secs}s — exiting (orphan cleanup)");
                    std::process::exit(0);
                }
            }
        });
    }
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/analytics", get(analytics))
        .route("/api/analytics/rolling", get(analytics_rolling))
        .route("/api/disk/drives", get(disk_drives))
        .route("/api/disk/invoke", post(disk_invoke))
        .route("/api/disk/events", get(disk_events))
        .route("/api/disk/scan", get(disk_scan))
        .route("/api/usage", get(usage))
        .route("/api/quota/history/record", post(quota_history_record))
        .route("/api/backend-status", get(backend_status))
        .route("/api/settings", get(get_settings).post(update_settings))
        .route("/api/api-keys", get(api_key_status).post(save_api_keys))
        .route("/api/accounts", get(get_accounts).post(update_accounts))
        .route("/api/codex-accounts", get(get_codex_accounts).post(update_codex_accounts))
        .route("/api/cache-clear", post(cache_clear))
        .route("/api/quota/reset/glm", post(quota_reset_glm))
        .route("/api/quota/reset/codex", post(quota_reset_codex))
        .route("/api/kimi/web-credential", post(kimi_web_credential))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_guard,
        ))
        .with_state(state.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        // 端口被占（可能已有实例）时退回随机端口，仍保证可用
        Err(_) => {
            match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await {
                Ok(listener) => listener,
                Err(err) => {
                    eprintln!("bind failed: {err}");
                    std::process::exit(1);
                }
            }
        }
    };
    let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    println!("LISTENING {bound}");
    println!("env-tools-api {} on http://127.0.0.1:{bound}", APP_VERSION);
    if let Err(error) = jharu_migration::run() {
        eprintln!("legacy disk data migration failed: {error}");
    }
    // 自动养护后台任务（默认不自动清理；持续记录容量并按设置发送低空间提醒）。
    autocare::start(jharu_host::app());
    // 启动预热：local 与 aggregate 各扫一遍（WSL 9P 冷扫 20s+，赶在用户首次
    // 切换/打开看板之前）。scope 级锁保证预热不阻塞其它范围的请求。
    {
        let warm_state = state.clone();
        tokio::spawn(async move {
            let mut jobs: Vec<(bool, Option<String>, String)> = vec![
                (false, None, "local".to_string()),
                (true, None, "aggregate".to_string()),
            ];
            for distro in settings::available_wsl_distros() {
                jobs.push((false, Some(distro.clone()), format!("wsl:{distro}")));
            }
            for (aggregate, distro, scope) in jobs {
                let st = warm_state.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let started = std::time::Instant::now();
                    let value =
                        analytics_worker(&st, 30, "all", aggregate, distro.as_deref(), &scope);
                    let _ = value;
                    eprintln!(
                        "warmup {scope} done in {:.1}s",
                        started.elapsed().as_secs_f64()
                    );
                })
                .await;
            }
        });
    }
    axum::serve(listener, app).await.unwrap();
}

/// Jharu 同源命令桥：扫描与删除均进入对应专用实现，返回值保持其原始结构。
async fn disk_invoke(axum::extract::Json(body): axum::extract::Json<Value>) -> Json<Value> {
    let command = body.get("command").and_then(Value::as_str).unwrap_or("").to_string();
    let args = body.get("args").cloned().unwrap_or_else(|| serde_json::json!({}));
    if command.is_empty() {
        return Json(error_payload("disk command required".into()));
    }
    match jharu_api::execute(&command, args).await {
        Ok(result) => Json(serde_json::json!({ "ok": true, "result": result })),
        Err(error) => Json(error_payload(error)),
    }
}

async fn disk_events(Query(params): Query<HashMap<String, String>>) -> Json<Value> {
    let after = params.get("after").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    Json(jharu_host::events(after))
}

/// /api/disk/drives：驱动器列表（卷路径、总/可用/已用、使用率%）
async fn disk_drives() -> Json<Value> {
    Json(serde_json::json!({ "ok": true, "drives": disk::drives() }))
}

/// /api/disk/scan?path=<dir>&top=<n>&depth=<n>：目录体积排行
async fn disk_scan(
    Query(params): Query<HashMap<String, String>>,
) -> Json<Value> {
    let path = params.get("path").cloned().unwrap_or_default();
    let top = params.get("top").and_then(|v| v.parse().ok()).unwrap_or(30);
    let depth = params.get("depth").and_then(|v| v.parse().ok()).unwrap_or(2);
    if path.is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "path required" }));
    }
    // spawn_blocking：磁盘 IO 不阻塞运行时
    let result = tokio::task::spawn_blocking(move || {
        disk::scan_dir(&path, top.clamp(1, 200), depth.clamp(1, 6))
    })
    .await
    .unwrap_or(serde_json::json!({ "ok": false, "error": "scan worker failed" }));
    Json(result)
}
