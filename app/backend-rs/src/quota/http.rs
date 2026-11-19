//! HTTP 层：ureq agent 构建（代理语义与 Python urllib 一致）与 JSON 请求辅助。

use std::time::Duration;

use serde_json::Value;

use crate::settings::env_value;

/// 构建 HTTP agent（代理语义与 Python 版一致）；settings.rs 的版本探测也复用。
pub fn build_agent(use_proxy: bool, timeout_secs: u64) -> ureq::Agent {
    let mut builder = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(15))
        .timeout(Duration::from_secs(timeout_secs));
    if use_proxy {
        // 与 urllib 的环境代理语义对齐（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY）
        let raw = env_value("HTTPS_PROXY")
            .or_else(|| env_value("https_proxy"))
            .or_else(|| env_value("HTTP_PROXY"))
            .or_else(|| env_value("http_proxy"))
            .or_else(|| env_value("ALL_PROXY"))
            .or_else(|| env_value("all_proxy"))
            // 环境变量缺失时（GUI 启动常如此）回退 Windows 系统代理：
            // Codex/GLM 等经代理访问的接口与浏览器行为保持一致
            .or_else(system_proxy);
        if let Some(raw) = raw {
            if let Ok(proxy) = ureq::Proxy::new(&raw) {
                builder = builder.proxy(proxy);
            }
        }
    }
    builder.build()
}

/// 读 Windows 系统代理（IE/WinINET 设置）：注册表 ProxyEnable + ProxyServer。
/// 非 Windows 或读取失败返回 None。
fn system_proxy() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let output = std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyEnable",
        ])
        .output()
        .ok()?;
    if !String::from_utf8_lossy(&output.stdout).contains("0x1") {
        return None;
    }
    let output = std::process::Command::new("reg.exe")
        .args([
            "query",
            r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            "/v",
            "ProxyServer",
        ])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    // 形如 "    ProxyServer    REG_SZ    127.0.0.1:7890"
    let server = text
        .lines()
        .find(|line| line.contains("ProxyServer"))
        .and_then(|line| line.split_whitespace().last())
        .filter(|value| value.contains(':') || value.contains('.'))?
        .to_string();
    // "http=...;https=..." 分段形式取 https 段；裸 host:port 补 scheme
    if let Some(https_part) = server.split(';').find(|part| part.starts_with("https=")) {
        return Some(format!("https://{}", &https_part[6..]));
    }
    if server.contains('=') {
        return None;
    }
    if server.starts_with("http") {
        Some(server)
    } else {
        Some(format!("http://{server}"))
    }
}

/// ureq 调用结果 → JSON 的统一映射（状态错误/网络错误/解析失败的文案与 Python 一致）。
fn into_json(result: Result<ureq::Response, ureq::Error>) -> Result<Value, String> {
    match result {
        Ok(response) => response
            .into_json()
            .map_err(|err| format!("Invalid API response: {err}")),
        Err(ureq::Error::Status(code, response)) => {
            let reason = response
                .header("http_status_message")
                .unwrap_or("error")
                .to_string();
            Err(format!("HTTP {code}: {reason}"))
        }
        Err(err) => Err(format!("Network request failed: {err}")),
    }
}

/// 带 Bearer 的 JSON GET。重试 3 次（退避 1s/2s，HTTP 错误不重试），
/// 但 timeout_secs 是**总预算**：每次尝试前按剩余时间收缩单次超时，
/// 预算耗尽即停——单接口最坏耗时 = timeout_secs（原实现为 3 倍，
/// 代理故障期串行累加会突破 /api/usage 的整体时限，前端只能拿到
/// "配额不可用"而失去逐家降级）。
pub fn get_json(
    url: &str,
    bearer: &str,
    use_proxy: bool,
    timeout_secs: u64,
) -> Result<Value, String> {
    get_json_headers(
        url,
        &[("Authorization", &format!("Bearer {bearer}"))],
        use_proxy,
        timeout_secs,
    )
}

/// 自定义请求头的 JSON GET（重试语义同 get_json：3 次，退避 1s/2s，
/// HTTP 错误不重试；timeout_secs 为总预算，见 get_json 注释）
pub fn get_json_headers(
    url: &str,
    headers: &[(&str, &str)],
    use_proxy: bool,
    timeout_secs: u64,
) -> Result<Value, String> {
    let started = std::time::Instant::now();
    let mut last_error = String::new();
    for attempt in 1..=3 {
        let remaining = timeout_secs.saturating_sub(started.elapsed().as_secs());
        if attempt > 1 && remaining < 2 {
            // 预算不足以再跑一次尝试（连接期就要 15s），及时放弃
            break;
        }
        let agent = build_agent(use_proxy, remaining.max(1));
        let mut request = agent.get(url).set("Accept", "application/json");
        for (name, value) in headers {
            request = request.set(name, value);
        }
        let result = request.call();
        match result {
            Err(ureq::Error::Status(..)) => return into_json(result),
            Err(err) => {
                last_error = format!("Network request failed: {err}");
                if attempt < 3 {
                    std::thread::sleep(Duration::from_secs(attempt as u64));
                }
            }
            Ok(_) => return into_json(result),
        }
    }
    Err(last_error)
}

/// POST 版请求（Python request_json 的 data 分支：不重试）。
pub fn post_json(
    url: &str,
    headers: &[(&str, &str)],
    body: &str,
    use_proxy: bool,
    timeout_secs: u64,
) -> Result<Value, String> {
    let agent = build_agent(use_proxy, timeout_secs);
    let mut request = agent.post(url);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    into_json(request.send_string(body))
}

/// POST 失败时保留状态码与响应体：Kimi 网页接口会在 401 body 里给出
/// unauthenticated / Session expired 明细，统一错误映射会把这些信息丢掉。
pub struct HttpFailure {
    pub status: Option<u16>,
    pub message: String,
}

impl HttpFailure {
    pub fn is_network(&self) -> bool {
        self.status.is_none()
    }
}

/// 从错误响应体提取可读原因（Kimi 网关：details[].debug.localizedMessage.message）。
fn reason_from_body(text: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        let find = |pointer: &str| {
            value
                .pointer(pointer)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|text| !text.is_empty())
        };
        if let Some(message) = find("/details/0/debug/localizedMessage/message")
            .or_else(|| find("/debug/localizedMessage/message"))
            .or_else(|| find("/message"))
        {
            return message.to_string();
        }
        if let Some(reason) = find("/details/0/debug/reason").or_else(|| find("/debug/reason")) {
            return reason.to_string();
        }
        if let Some(code) = find("/code") {
            return code.to_string();
        }
    }
    let trimmed = text.trim();
    if trimmed.is_empty() {
        "error".into()
    } else {
        trimmed.chars().take(160).collect()
    }
}

pub fn post_json_detailed(
    url: &str,
    headers: &[(&str, &str)],
    body: &str,
    use_proxy: bool,
    timeout_secs: u64,
) -> Result<Value, HttpFailure> {
    let agent = build_agent(use_proxy, timeout_secs);
    let mut request = agent.post(url);
    for (name, value) in headers {
        request = request.set(name, value);
    }
    match request.send_string(body) {
        Ok(response) => {
            let status = response.status();
            response.into_json().map_err(|err| HttpFailure {
                status: Some(status),
                message: format!("Invalid API response: {err}"),
            })
        }
        Err(ureq::Error::Status(code, response)) => {
            let text = response.into_string().unwrap_or_default();
            Err(HttpFailure {
                status: Some(code),
                message: format!("HTTP {code}: {}", reason_from_body(&text)),
            })
        }
        Err(err) => Err(HttpFailure {
            status: None,
            message: format!("Network request failed: {err}"),
        }),
    }
}
