//! 官方 Codex app-server 额度查询（借鉴 codex-account-switcher 的 native 适配层）。
//!
//! 通过 `codex app-server` 的 JSONL RPC 调 `account/rateLimits/read`：
//! 官方负责 token 续期与协议兼容，不创建对话、不做模型推理。
//! 相比直连 wham/usage，字段更全（resetsAt / windowDurationMins / Credits /
//! rateLimitResetCredits），planType 为官方口径。
//!
//! 每次查询一个短生命周期子进程：initialize → initialized → rateLimits/read，
//! 到时即杀；调用方失败可回退 HTTP。Windows 经 cmd /c 解析 codex.cmd 垫片。

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::settings::env_value;

struct KillOnDrop(Option<Child>);
impl Drop for KillOnDrop {
    fn drop(&mut self) {
        if let Some(child) = self.0.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn spawn_appserver(home: &Path) -> Result<Child, String> {
    let cli = env_value("CODEX_CLI").unwrap_or_else(|| "codex".into());
    #[cfg(windows)]
    let mut command = {
        let mut cmd = Command::new("cmd");
        // cmd /c 的引号规则：整串只在路径含空格时才整体加引号，
        // 否则 cmd 会把 "\"codex\"" 当成命令名而报"不是内部或外部命令"
        let line = if cli.contains(' ') {
            format!("\"\"{cli}\" app-server -c cli_auth_credentials_store=\"file\"")
        } else {
            format!("{cli} app-server -c cli_auth_credentials_store=\"file\"")
        };
        cmd.arg("/d").arg("/c").arg(line);
        cmd
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut cmd = Command::new(&cli);
        cmd.arg("app-server")
            .arg("-c")
            .arg("cli_auth_credentials_store=\"file\"");
        cmd
    };
    command
        .current_dir(home)
        .env("CODEX_HOME", home)
        // 与参考实现一致：避免环境里的 key/token 污染按 profile 的查询
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("CODEX_ACCESS_TOKEN")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    command
        .spawn()
        .map_err(|err| format!("cannot start codex app-server: {err}"))
}

pub fn query_rate_limits(home: &Path, timeout_secs: u64) -> Result<Value, String> {
    let child = spawn_appserver(home)?;
    let mut child = KillOnDrop(Some(child));
    let process = child.0.as_mut().unwrap();
    let mut stdin = process.stdin.take().ok_or("app-server stdin unavailable")?;
    let stdout = process.stdout.take().ok_or("app-server stdout unavailable")?;
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(timeout_secs.max(1));
    let mut send = |value: Value| -> Result<(), String> {
        let mut text = value.to_string();
        text.push('\n');
        stdin
            .write_all(text.as_bytes())
            .and_then(|_| stdin.flush())
            .map_err(|err| format!("app-server write failed: {err}"))
    };
    send(serde_json::json!({
        "id": 1,
        "method": "initialize",
        "params": {"clientInfo": {"name": "env-tools", "version": crate::APP_VERSION}},
    }))?;
    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err("codex app-server rate limits query timed out".into());
        }
        let line = rx
            .recv_timeout(deadline - now)
            .map_err(|_| "codex app-server rate limits query timed out".to_string())?;
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        // 官方会反向请求（如输出重定向能力协商），一律回 -32601
        if message.get("method").is_some() && message.get("id").is_some() {
            send(serde_json::json!({
                "id": message["id"],
                "error": {"code": -32601, "message": "Unsupported request"},
            }))?;
            continue;
        }
        let id = message.get("id").and_then(|v| v.as_i64()).unwrap_or(-1);
        if id == 1 {
            send(serde_json::json!({"method": "initialized", "params": {}}))?;
            send(serde_json::json!({"id": 2, "method": "account/rateLimits/read", "params": {}}))?;
            continue;
        }
        if id != 2 {
            continue;
        }
        if let Some(error) = message.get("error") {
            let code = error.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
            return Err(if code == -32601 {
                "codex CLI does not support account/rateLimits/read; upgrade Codex".into()
            } else {
                "codex app-server rate limits query failed".into()
            });
        }
        return message
            .get("result")
            .cloned()
            .filter(|v| v.is_object())
            .ok_or_else(|| "codex app-server returned an unexpected result".into());
    }
}

/// 把 app-server 响应折算成 wham/usage 形状，归一化继续复用 normalize_codex。
/// 只搬字段，不做套餐别名转换或回退。
pub fn to_wham_shape(result: &Value, now_unix: i64) -> Value {
    let group = result
        .get("rateLimitsByLimitId")
        .and_then(|v| v.get("codex"))
        .filter(|v| v.is_object())
        .or_else(|| result.get("rateLimits").filter(|v| v.is_object()))
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let convert_window = |key: &str| -> Value {
        let window = group.get(key).filter(|v| v.is_object()).cloned();
        let Some(window) = window else { return Value::Null };
        let minutes = window
            .get("windowDurationMins")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let reset_after = window
            .get("resetsAt")
            .and_then(|v| v.as_i64())
            .map(|ts| (ts - now_unix).max(0));
        serde_json::json!({
            "used_percent": window.get("usedPercent").cloned().unwrap_or(Value::Null),
            "limit_window_seconds": minutes * 60,
            "reset_after_seconds": reset_after,
        })
    };
    let camel = match group.get("planType").and_then(|v| v.as_str()) {
        Some(plan) => Value::String(plan.to_string()),
        None => Value::Null,
    };
    serde_json::json!({
        "planType": camel,
        "rateLimit": {
            "primaryWindow": convert_window("primary"),
            "secondaryWindow": convert_window("secondary"),
        },
        "credits": group.get("credits").cloned().unwrap_or(Value::Null),
        "rateLimitResetCredits": result.get("rateLimitResetCredits").cloned().unwrap_or(Value::Null),
    })
}
