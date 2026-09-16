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

use axum::{extract::Query, routing::get, Json, Router};
use serde_json::Value;
use tokio::sync::Mutex;

const ANALYTICS_TIMEOUT: Duration = Duration::from_secs(180);
const USAGE_TIMEOUT: Duration = Duration::from_secs(50);
const SETTINGS_TIMEOUT: Duration = Duration::from_secs(15);
const ANALYTICS_TTL: Duration = Duration::from_secs(60);
const USAGE_TTL: Duration = Duration::from_secs(20);

#[derive(Clone)]
struct AppState {
    monitor_script: PathBuf,
    cache: Arc<Cache>,
}

fn error_payload(message: String) -> Value {
    serde_json::json!({ "ok": false, "error": message })
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
    let mut command = tokio::process::Command::new("python3");
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
        .filter(|raw| ["all", "kimi", "codex", "glm", "deepseek"].contains(raw))
        .unwrap_or("all")
        .to_string();
    let key = format!("analytics:{days}:{agent}");
    let monitor = state.monitor_script.clone();
    let value = state
        .cache
        .get_or_fetch(key, ANALYTICS_TTL, move || async move {
            run_monitor(
                &monitor,
                &[
                    "--json".into(),
                    "--analytics".into(),
                    "--days".into(),
                    days.to_string(),
                    "--agent".into(),
                    agent,
                ],
                None,
                ANALYTICS_TIMEOUT,
            )
            .await
        })
        .await;
    Json(value)
}

async fn usage(axum::extract::State(state): axum::extract::State<AppState>) -> Json<Value> {
    let monitor = state.monitor_script.clone();
    let value = state
        .cache
        .get_or_fetch("usage".to_string(), USAGE_TTL, move || async move {
            run_monitor(
                &monitor,
                &["--json".into(), "--dashboard".into()],
                None,
                USAGE_TIMEOUT,
            )
            .await
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
            other => eprintln!("unknown argument: {other}"),
        }
    }

    let state = AppState { monitor_script: monitor, cache: Arc::new(Cache::new()) };
    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/analytics", get(analytics))
        .route("/api/usage", get(usage))
        .route("/api/backend-status", get(backend_status))
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
