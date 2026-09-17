//! Env-Tools 桌面应用的本地 API 网关（Rust + axum）。
//!
//! Electron 主进程在 WSL 内拉起本服务，渲染层的数据请求统一走这里：
//! - `GET /api/health`                  健康检查（含版本号）
//! - `GET /api/analytics?days=&agent=`  会话用量分析（转调 usage_monitor.py）
//! - `GET /api/usage`                   各套餐配额（转调 usage_monitor.py）
//! - `GET /api/backend-status`          数据引擎与数据源环境信息
//!
//! 本服务只做进程编排、单飞缓存与超时管理，数据解析全部留在
//! usage_monitor.py（Python）里，避免两套实现漂移。任何后端失败都以
//! `{"ok": false, "error": ...}` 的 200 响应返回，由渲染层统一处理。
//!
//! 监听 127.0.0.1，启动完成后向 stdout 打印 `LISTENING <port>`，
//! 供 Electron 主进程探测就绪状态。

use std::{
    collections::HashMap,
    future::Future,
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{extract::Query, response::IntoResponse, routing::get, Json, Router};
use serde_json::Value;
use tokio::sync::Mutex;

mod analytics;
mod quota;

#[cfg(test)]
#[path = "analytics_tests.rs"]
mod analytics_tests;

#[cfg(test)]
#[path = "quota_tests.rs"]
mod quota_tests;

const ANALYTICS_TTL: Duration = Duration::from_secs(30);
const USAGE_TTL: Duration = Duration::from_secs(20);
const USAGE_TIMEOUT: Duration = Duration::from_secs(50);
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone)]
struct AppState {
    monitor_script: PathBuf,
    cache: Arc<Cache>,
    /// 原生分析引擎状态（进程内增量；std Mutex + spawn_blocking 避免阻塞运行时）
    analytics: Arc<std::sync::Mutex<analytics::AnalyticsState>>,
    /// 可选鉴权 token（--token）：设置后所有 /api 请求（除 /api/health）必须带
    /// x-env-token 头。用于 SSH 等跨机场景；本机 loopback 可省略。
    token: Option<String>,
}

fn error_payload(message: String) -> Value {
    serde_json::json!({ "ok": false, "error": message })
}

/// 鉴权中间件：设置了 --token 时，除 health 外的请求必须携带 x-env-token。
async fn auth_guard(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
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

/// 运行 usage_monitor.py 并把 stdout 作为 JSON 返回（失败返回 ok:false 结构）。
async fn run_monitor(
    monitor: &PathBuf,
    args: &[String],
    stdin_text: Option<&str>,
    timeout: Duration,
) -> Value {
    // Windows 上通常只有 `python`；Linux/WSL 用 `python3`，可用 AI_USAGE_PYTHON 覆盖
    let python = std::env::var("AI_USAGE_PYTHON").unwrap_or_else(|_| {
        if cfg!(windows) { "python".into() } else { "python3".into() }
    });
    let mut command = tokio::process::Command::new(python);
    command.arg(monitor).args(args);
    command.stdin(std::process::Stdio::piped());
    command.stdout(std::process::Stdio::piped());
    command.stderr(std::process::Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return error_payload(format!("Cannot spawn python3: {err}")),
    };
    if let Some(text) = stdin_text {
        use tokio::io::AsyncWriteExt;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes()).await;
            drop(stdin);
        }
    }
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(err)) => return error_payload(format!("python3 failed: {err}")),
        Err(_) => {
            return error_payload(format!(
                "Data engine timed out after {}s",
                timeout.as_secs()
            ))
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    match serde_json::from_str::<Value>(stdout.trim()) {
        Ok(value) => value,
        Err(_) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            error_payload(format!(
                "Data engine failed (exit {:?}): {}",
                output.status.code(),
                stderr.trim().chars().take(300).collect::<String>()
            ))
        }
    }
}

async fn health() -> Json<Value> {
    Json(serde_json::json!({
        "ok": true,
        "service": "env-tools-api",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

/// /api/analytics：原生引擎扫描 + 聚合（无网络、无子进程）。
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
    let key = format!("analytics:{days}:{agent}");
    let state = state.clone();
    let value = state
        .cache
        .get_or_fetch(key, ANALYTICS_TTL, move || async move {
            tokio::task::spawn_blocking(move || {
                let now = chrono::Local::now();
                let now_sec = now.timestamp();
                let mut engine = state.analytics.lock().unwrap();
                let scan_started = std::time::Instant::now();
                let dirty = engine.scan(
                    Some(&kimi_home()),
                    Some(&codex_home()),
                    now_sec,
                );
                let payload = engine.aggregate(days, &agent, now);
                drop(engine);
                let engine_note = format!(
                    "native-rust (scan {:.1}ms, dirty={dirty})",
                    scan_started.elapsed().as_secs_f64() * 1000.0
                );
                serde_json::json!({
                    "ok": true,
                    "engine": engine_note,
                    "analytics": payload,
                })
            })
            .await
            .unwrap_or_else(|err| error_payload(format!("analytics worker failed: {err}")))
        })
        .await;
    Json(value)
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

async fn usage(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Value> {
    let monitor = state.monitor_script.clone();
    let value = state
        .cache
        .get_or_fetch("usage".to_string(), USAGE_TTL, move || async move {
            // DeepSeek/GLM 原生采集；Kimi/Codex 仍由 python 引擎承载
            //（OAuth 刷新流尚未迁移，见 v0.6.x 计划）。python 跑全量，
            // 合并时把 DeepSeek/GLM 替换为原生结果。
            let python = run_monitor(
                &monitor,
                &["--json".into(), "--dashboard".into()],
                None,
                USAGE_TIMEOUT,
            )
            .await;
            let native = tokio::task::spawn_blocking(quota::collect_native)
                .await
                .unwrap_or_else(|err| {
                    (
                        Vec::new(),
                        vec![serde_json::json!({"provider": "DeepSeek", "error": format!("native worker failed: {err}")}),
                             serde_json::json!({"provider": "GLM", "error": format!("native worker failed: {err}")})],
                    )
                });

            let mut accounts: Vec<Value> = Vec::new();
            let mut errors: Vec<Value> = Vec::new();
            let mut versions: Value = serde_json::json!({});
            if python.get("accounts").is_some() {
                let parsed = &python;
                if let Some(list) = parsed.get("accounts").and_then(|v| v.as_array()) {
                    for account in list {
                        let provider = account.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                        if matches!(provider, "DeepSeek" | "GLM") {
                            continue;
                        }
                        accounts.push(account.clone());
                    }
                }
                if let Some(list) = parsed.get("errors").and_then(|v| v.as_array()) {
                    for err in list {
                        let provider = err.get("provider").and_then(|v| v.as_str()).unwrap_or("");
                        if matches!(provider, "DeepSeek" | "GLM") {
                            continue;
                        }
                        errors.push(err.clone());
                    }
                }
                versions = parsed.get("versions").cloned().unwrap_or(serde_json::json!({}));
            } else {
                let detail = python
                    .get("error")
                    .and_then(|v| v.as_str())
                    .unwrap_or("python engine unavailable");
                errors.push(serde_json::json!({"provider": "Kimi Code", "error": detail}));
                errors.push(serde_json::json!({"provider": "OpenAI Codex", "error": detail}));
            }
            accounts.extend(native.0);
            errors.extend(native.1);

            let data = serde_json::json!({
                "accounts": accounts,
                "errors": errors,
                "versions": versions,
                "monitor_version": env!("CARGO_PKG_VERSION"),
            });
            serde_json::json!({ "ok": true, "data": data })
        })
        .await;
    Json(value)
}

async fn backend_status(
    axum::extract::State(state): axum::extract::State<AppState>,
) -> Json<Value> {
    let monitor = state.monitor_script.clone();
    let settings = run_monitor(&monitor, &["--get-settings".into()], None, SETTINGS_TIMEOUT).await;
    Json(serde_json::json!({
        "ok": true,
        "engine": "python3",
        "script": state.monitor_script.display().to_string(),
        "environment": settings.get("environment").cloned().unwrap_or(Value::Null),
        "wsl_distro": settings.get("wsl_distro").cloned().unwrap_or(Value::Null),
    }))
}

#[tokio::main]
async fn main() {
    let mut port: u16 = 8747;
    let mut monitor = PathBuf::from("usage_monitor.py");
    let mut token: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                if let Some(raw) = args.next() {
                    port = raw.parse().unwrap_or(port);
                }
            }
            "--monitor" => {
                if let Some(raw) = args.next() {
                    monitor = PathBuf::from(raw);
                }
            }
            "--token" => {
                if let Some(raw) = args.next() {
                    token = Some(raw);
                }
            }
            other => eprintln!("unknown argument: {other}"),
        }
    }

    let state = AppState {
        monitor_script: monitor,
        cache: Arc::new(Cache::new()),
        analytics: Arc::new(std::sync::Mutex::new(analytics::AnalyticsState::default())),
        token: token.clone(),
    };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/analytics", get(analytics))
        .route("/api/usage", get(usage))
        .route("/api/backend-status", get(backend_status))
        .layer(axum::middleware::from_fn_with_state(state.clone(), auth_guard))
        .with_state(state);

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
        env!("CARGO_PKG_VERSION")
    );
    axum::serve(listener, app).await.unwrap();
}
