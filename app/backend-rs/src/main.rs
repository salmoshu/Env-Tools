//! Env-Tools 桌面应用的本地 API 网关（Rust + axum）。
//!
//! Electron 主进程拉起本服务，渲染层的数据请求统一走这里。v0.7.0 起数据
//! 引擎全部原生实现，不再依赖 Python：
//! - `GET /api/health`                     健康检查（含版本号）
//! - `GET /api/analytics?days=&agent=&aggregate=`  会话用量分析（原生引擎；
//!   aggregate=1 时合并本机与 WSL 家目录的会话数据）
//! - `GET /api/usage`                      四家配额全原生（Kimi/Codex OAuth 刷新
//!   + DeepSeek/GLM 直连；凭证跨本机与 WSL 家目录发现）
//! - `GET|POST /api/settings`              数据源环境与会员到期配置
//! - `GET|POST /api/api-keys`              API key 状态查询 / 保存
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

use axum::{extract::Query, response::IntoResponse, routing::{get, post}, Json, Router};
use serde_json::Value;
use tokio::sync::Mutex;

mod analytics;
mod apply_update;
mod quota;
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

#[derive(Clone)]
struct AppState {
    cache: Arc<Cache>,
    /// 原生分析引擎状态：按扫描范围（local / wsl:<distro> / aggregate）各一份，
    /// 进程内增量（std Mutex + spawn_blocking 避免阻塞运行时）
    analytics: Arc<std::sync::Mutex<HashMap<String, Arc<std::sync::Mutex<analytics::AnalyticsState>>>>>,
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
        let provided = req.headers().get("x-env-token").and_then(|v| v.to_str().ok());
        if !is_health && provided != Some(expected.as_str()) {
            return (
                axum::http::StatusCode::UNAUTHORIZED,
                Json(error_payload("invalid or missing x-env-token header".into())),
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
        Self { entries: Mutex::new(HashMap::new()) }
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
                    let entry =
                        Arc::new(Entry { created: Instant::now(), cell: tokio::sync::OnceCell::new() });
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
    let mut homes = vec![kimi_home()];
    if aggregate {
        for home in settings::wsl_homes() {
            homes.push(home.join(".kimi-code"));
            homes.push(home.join(".kimi"));
        }
    }
    homes
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
    let mut homes = vec![codex_home()];
    if aggregate {
        for home in settings::wsl_homes() {
            homes.push(home.join(".codex"));
        }
    }
    homes
}

fn kimi_home() -> PathBuf {
    if let Some(home) = std::env::var_os("KIMI_CODE_HOME") {
        return PathBuf::from(home);
    }
    default_home(".kimi-code")
}

fn codex_home() -> PathBuf {
    if let Some(home) = std::env::var_os("CODEX_HOME") {
        return PathBuf::from(home);
    }
    default_home(".codex")
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
    let scan_gap = if aggregate || wsl_distro.is_some() { SCAN_GAP_WSL } else { SCAN_GAP_LOCAL };
    let scan_started = std::time::Instant::now();
    let (dirty, scan_note) = if now_sec - engine.last_scan_secs >= scan_gap {
        let dirty = engine.scan(
            &kimi_homes(aggregate, wsl_distro),
            &codex_homes(aggregate, wsl_distro),
            &zcode_homes(aggregate, wsl_distro),
            now_sec,
        );
        engine.last_scan_secs = now_sec;
        (dirty, format!("scan {:.1}ms", scan_started.elapsed().as_secs_f64() * 1000.0))
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
        if let Some(name) = wsl_distro { format!("[{name}]") } else { String::new() },
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
    let aggregate = params.get("aggregate").map(|v| v == "1" || v == "true").unwrap_or(false);
    let wsl_distro = params.get("wsl_distro").map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    // 扫描范围标识：每个范围独立的引擎状态。引擎对"消失文件"保留历史记录
    //（增量语义），共享单个状态会让上一个目标的记录污染下一个目标的结果。
    let scope = match wsl_distro.as_deref() {
        Some(distro) => format!("wsl:{distro}"),
        None if aggregate => "aggregate".to_string(),
        None => "local".to_string(),
    };
    let key = format!("analytics:{days}:{agent}:{scope}");
    let ttl = if aggregate || wsl_distro.is_some() { ANALYTICS_WSL_TTL } else { ANALYTICS_TTL };
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
                    analytics_worker(&state, days, &agent, aggregate, wsl_distro.as_deref(), &scope)
                })
                .await
                .unwrap_or_else(|err| error_payload(format!("analytics worker failed: {err}")))
            }
        })
        .await;
    Json(value)
}

/// /api/usage：四家配额全原生（Kimi/Codex OAuth 刷新 + DeepSeek/GLM 直连）。
async fn usage(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Value> {
    let value = state
        .cache
        .get_or_fetch("usage".to_string(), USAGE_TTL, move || async move {
            tokio::task::spawn_blocking(|| {
                let (accounts, errors) = quota::collect_all();
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

/// 手动刷新：清空分析/配额缓存，下次请求强制增量重扫
async fn cache_clear(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Value> {
    state.cache.entries.lock().await.clear();
    // 重置扫描节流水位：下一次分析请求强制增量重扫（手动刷新语义）
    for engine in state.analytics.lock().unwrap().values() {
        engine.lock().unwrap().last_scan_secs = 0;
    }
    Json(serde_json::json!({ "ok": true }))
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
    if result.as_ref().map(|r| r.get("ok").and_then(|v| v.as_bool()).unwrap_or(false)).unwrap_or(false) {
        state.cache.entries.lock().await.clear();
    }
    Json(result.unwrap_or_else(|err| error_payload(err)))
}

async fn api_key_status() -> Json<Value> {
    Json(settings::api_key_status())
}

async fn save_api_keys(Json(payload): Json<Value>) -> Json<Value> {
    Json(settings::save_api_keys(&payload).unwrap_or_else(|err| error_payload(err)))
}

#[tokio::main]
async fn main() {
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
                let last = state.last_activity.load(std::sync::atomic::Ordering::Relaxed);
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
        .route("/api/usage", get(usage))
        .route("/api/backend-status", get(backend_status))
        .route("/api/settings", get(get_settings).post(update_settings))
        .route("/api/api-keys", get(api_key_status).post(save_api_keys))
        .route("/api/cache-clear", post(cache_clear))
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth_guard))
        .with_state(state.clone());

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(listener) => listener,
        // 端口被占（可能已有实例）时退回随机端口，仍保证可用
        Err(_) => match tokio::net::TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0))).await {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("bind failed: {err}");
                std::process::exit(1);
            }
        },
    };
    let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port);
    println!("LISTENING {bound}");
    println!(
        "env-tools-api {} on http://127.0.0.1:{bound}",
        APP_VERSION
    );
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
                    let value = analytics_worker(&st, 30, "all", aggregate, distro.as_deref(), &scope);
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
