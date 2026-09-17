//! 设置、凭据与 CLI 版本的原生实现（v0.7.0 起取代 usage_monitor.py 的对应部分）。
//!
//! 存储位置与 Python 版保持一致，避免升级后丢失配置：
//! - `~/.config/ai-usage-monitor/settings.json`  数据源环境（environment/wsl_distro）
//! - `~/.config/ai-usage-monitor/config.json`    会员到期手动配置（kimi/openai/glm/deepseek）
//! - `~/.cache/ai-usage-monitor/versions.json`   CLI 最新版本探测缓存（1 小时）
//! - `~/.deepseek/credentials.json`、`~/.glm/credentials.json`  API key（Electron 经 stdin 写入）

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

pub const MEMBERSHIP_PROVIDERS: &[&str] = &["kimi", "openai", "glm", "deepseek"];
const VERSION_CHECK_INTERVAL: u64 = 3600;
const KIMI_LATEST_VERSION_URL: &str = "https://code.kimi.com/kimi-code/latest";
const NPM_LATEST_VERSION_URL: &str = "https://registry.npmjs.org/{package}/latest";

pub fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub fn env_enabled(name: &str, default: bool) -> bool {
    match env_value(name) {
        Some(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
        None => default,
    }
}

pub fn local_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// WSL 发行版的用户家目录（Windows 侧经 9P UNC 访问）。
/// 根目录 \\wsl.localhost 不可枚举，发行版名改由 wsl.exe 获取，
/// 再列 `\\wsl.localhost\<distro>\home\*`。
pub fn wsl_homes() -> Vec<PathBuf> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let mut homes = Vec::new();
    for distro in available_wsl_distros() {
        let home_root = PathBuf::from(format!("\\\\wsl.localhost\\{distro}\\home"));
        let Ok(users) = std::fs::read_dir(&home_root) else { continue };
        for user in users.flatten() {
            let path = user.path();
            if path.is_dir() {
                homes.push(path);
            }
        }
    }
    homes.sort();
    homes
}

pub fn read_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|err| format!("Cannot parse {}: {err}", path.display()))
}

pub fn write_private_json(path: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        #[cfg(unix)]
        {
            let _ = std::fs::set_permissions(parent, std::os::unix::fs::PermissionsExt::from_mode(0o700));
        }
    }
    let text = serde_json::to_string_pretty(data).unwrap_or_else(|_| "{}".into());
    std::fs::write(path, text).map_err(|err| format!("Cannot write {}: {err}", path.display()))?;
    #[cfg(unix)]
    {
        let _ = std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(0o600));
    }
    Ok(())
}

// --- settings.json（数据源环境） --------------------------------------------

fn config_dir() -> PathBuf {
    local_home().join(".config").join("ai-usage-monitor")
}

pub fn settings_path() -> PathBuf {
    env_value("AI_USAGE_SETTINGS_PATH").map(PathBuf::from).unwrap_or_else(|| config_dir().join("settings.json"))
}

pub fn membership_config_path() -> PathBuf {
    env_value("AI_USAGE_CONFIG_PATH").map(PathBuf::from).unwrap_or_else(|| config_dir().join("config.json"))
}

pub fn load_settings() -> Value {
    read_json(&settings_path()).unwrap_or_else(|_| serde_json::json!({}))
}

/// 本机原生环境：Windows 上运行即 "windows"，WSL/Linux 内即 "wsl"。
pub fn native_environment() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else {
        "wsl"
    }
}

pub fn available_wsl_distros() -> Vec<String> {
    if cfg!(windows) {
        let output = std::process::Command::new("wsl.exe")
            .args(["--list", "--quiet"])
            .stdin(std::process::Stdio::null())
            .output();
        let mut names = Vec::new();
        if let Ok(out) = output {
            // wsl.exe 输出为 UTF-16；按字节过滤后只保留可打印 ASCII
            let text: String = out
                .stdout
                .iter()
                .filter(|b| b.is_ascii_alphanumeric() || b.is_ascii_whitespace() || **b == b'-' || **b == b'_' || **b == b'.')
                .map(|b| *b as char)
                .collect();
            for line in text.lines() {
                let name = line.trim();
                if !name.is_empty() && !names.iter().any(|n: &String| n == name) {
                    names.push(name.to_string());
                }
            }
        }
        names
    } else {
        Vec::new()
    }
}

/// 数据源环境列表：本机原生环境；Windows 上若装有 WSL 则追加 "wsl"。
pub fn available_environments() -> Vec<String> {
    let mut environments = vec![native_environment().to_string()];
    if cfg!(windows) && !available_wsl_distros().is_empty() {
        environments.push("wsl".into());
    }
    environments
}

/// GET /api/settings 的载荷（契约与 Python get_settings_payload 一致）。
pub fn settings_payload() -> Value {
    let settings = load_settings();
    let available = available_environments();
    let configured = settings.get("environment").and_then(|v| v.as_str()).unwrap_or("");
    let environment = if available.iter().any(|env| env == configured) && !configured.is_empty() {
        configured.to_string()
    } else {
        available[0].clone()
    };
    let wsl_distros = available_wsl_distros();
    let configured_distro = settings.get("wsl_distro").and_then(|v| v.as_str()).unwrap_or("");
    let wsl_distro = if wsl_distros.iter().any(|d| d == configured_distro) {
        configured_distro.to_string()
    } else {
        wsl_distros.first().cloned().unwrap_or_default()
    };
    let exe = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    serde_json::json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "environment": environment,
        "available_environments": available,
        "wsl_distros": wsl_distros,
        "wsl_distro": wsl_distro,
        "membership": membership_settings(),
        "script": exe,
    })
}

/// POST /api/settings：保存环境与会员时间（契约与 Python update_settings 一致）。
pub fn update_settings(payload: &Value) -> Result<Value, String> {
    if !payload.is_object() {
        return Err("Settings must be a JSON object".into());
    }
    let allowed = ["environment", "wsl_distro", "membership"];
    let mut settings = load_settings();
    let obj = settings.as_object_mut().unwrap();
    for key in payload.as_object().unwrap().keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("Unsupported setting: {key}"));
        }
    }
    let mut membership_result: Option<Value> = None;
    if let Some(membership) = payload.get("membership") {
        membership_result = Some(update_membership_config(membership)?);
    }
    let available = available_environments();
    let wsl_distros = available_wsl_distros();
    if let Some(value) = payload.get("wsl_distro") {
        let value = value.as_str().unwrap_or("");
        if value.trim().is_empty() || !wsl_distros.iter().any(|d| d == value) {
            return Err(format!(
                "WSL distro '{value}' is not available (choose from: {})",
                wsl_distros.join(", ")
            ));
        }
        obj.insert("wsl_distro".into(), Value::String(value.to_string()));
    }
    if let Some(value) = payload.get("environment") {
        let value = value.as_str().unwrap_or("");
        if !available.iter().any(|env| env == value) {
            return Err(format!(
                "Environment '{value}' is not available (choose from: {})",
                available.join(", ")
            ));
        }
        obj.insert("environment".into(), Value::String(value.to_string()));
    }
    if obj.get("environment").and_then(|v| v.as_str()) == Some("wsl") {
        let distro = obj.get("wsl_distro").and_then(|v| v.as_str()).unwrap_or("");
        if distro.is_empty() || !wsl_distros.iter().any(|d| d == distro) {
            return Err("Select an available WSL distro before using the WSL environment".into());
        }
    }
    write_private_json(&settings_path(), &settings)?;
    let mut result = serde_json::json!({ "ok": true, "settings": settings });
    if let Some(membership) = membership_result {
        result["membership"] = membership;
    }
    Ok(result)
}

// --- config.json（会员到期手动配置） ----------------------------------------

pub fn load_membership_config() -> Value {
    read_json(&membership_config_path()).unwrap_or_else(|_| serde_json::json!({}))
}

/// 设置页的会员配置概览（仅 kimi/openai/glm/deepseek 小节）。
pub fn membership_settings() -> Value {
    let config = load_membership_config();
    let mut sections = serde_json::Map::new();
    for provider in MEMBERSHIP_PROVIDERS {
        if let Some(section) = config.get(*provider).filter(|v| v.is_object()) {
            if section.get("membership_purchased_at").and_then(|v| v.as_str()).is_some() {
                sections.insert(provider.to_string(), section.clone());
            }
        }
    }
    Value::Object(sections)
}

pub fn update_membership_config(payload: &Value) -> Result<Value, String> {
    let Some(payload) = payload.as_object() else {
        return Err("membership must be an object".into());
    };
    let mut config = load_membership_config();
    let obj = config.as_object_mut().unwrap();
    for (provider, section) in payload {
        if !MEMBERSHIP_PROVIDERS.contains(&provider.as_str()) {
            return Err(format!("Unsupported membership provider: {provider}"));
        }
        let Some(section) = section.as_object() else {
            obj.remove(provider);
            continue;
        };
        let mut cleaned = serde_json::Map::new();
        if let Some(purchased) = section.get("membership_purchased_at").and_then(|v| v.as_str()) {
            let trimmed = purchased.trim();
            if !trimmed.is_empty() {
                chrono::DateTime::parse_from_rfc3339(trimmed)
                    .map(|_| ())
                    .or_else(|_| chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M").map(|_| ()))
                    .map_err(|_| format!("Invalid membership_purchased_at for {provider}: {trimmed}"))?;
                cleaned.insert("membership_purchased_at".into(), Value::String(trimmed.to_string()));
            }
        }
        if let Some(months) = section.get("membership_duration_months") {
            let months = months.as_i64().unwrap_or(1).max(1);
            cleaned.insert("membership_duration_months".into(), Value::from(months));
        }
        if cleaned.is_empty() {
            obj.remove(provider);
        } else {
            obj.insert(provider.clone(), Value::Object(cleaned));
        }
    }
    write_private_json(&membership_config_path(), &config)?;
    Ok(membership_settings())
}

/// 会员手动配置读取（quota.rs attach 用）。
pub fn membership_section(provider: &str) -> Option<Value> {
    let config = load_membership_config();
    let section = config.get(provider)?.as_object()?.clone();
    if section.get("membership_purchased_at").and_then(|v| v.as_str()).is_some() {
        Some(Value::Object(section))
    } else {
        None
    }
}

// --- API keys ---------------------------------------------------------------

fn deepseek_credentials_path() -> PathBuf {
    env_value("DEEPSEEK_CREDENTIALS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| local_home().join(".deepseek").join("credentials.json"))
}

fn glm_credentials_path() -> PathBuf {
    env_value("GLM_CREDENTIALS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| local_home().join(".glm").join("credentials.json"))
}

fn key_configured(path: &Path, env_names: &[&str], fields: &[&str]) -> Value {
    if env_names.iter().any(|name| env_value(name).is_some()) {
        return serde_json::json!({ "configured": true, "source": "environment" });
    }
    if !path.is_file() {
        return serde_json::json!({ "configured": false, "source": "missing" });
    }
    match read_json(path) {
        Ok(data) => {
            let configured = fields.iter().any(|field| {
                data.get(*field).and_then(|v| v.as_str()).map(|v| !v.trim().is_empty()).unwrap_or(false)
            });
            serde_json::json!({ "configured": configured, "source": if configured { "file" } else { "missing" } })
        }
        Err(err) => serde_json::json!({ "configured": false, "source": "invalid", "error": err }),
    }
}

/// GET /api/api-key-status：绝不返回密钥内容。
pub fn api_key_status() -> Value {
    serde_json::json!({
        "ok": true,
        "status": {
            "deepseek": key_configured(
                &deepseek_credentials_path(),
                &["DEEPSEEK_API_KEY"],
                &["api_key", "DEEPSEEK_API_KEY"],
            ),
            "glm": key_configured(
                &glm_credentials_path(),
                &["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"],
                &["api_key", "GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"],
            ),
        },
    })
}

pub fn save_api_keys(payload: &Value) -> Result<Value, String> {
    let Some(payload) = payload.as_object() else {
        return Err("API key settings must be a JSON object".into());
    };
    let mut saved = Vec::new();
    for (provider, value) in payload {
        let value = value.as_str().unwrap_or("").trim().to_string();
        if value.is_empty() {
            return Err(format!("{provider} API key cannot be empty"));
        }
        let path = match provider.as_str() {
            "deepseek" => deepseek_credentials_path(),
            "glm" => glm_credentials_path(),
            other => return Err(format!("Unsupported API key provider: {other}")),
        };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut data = if path.is_file() { read_json(&path).unwrap_or_else(|_| serde_json::json!({})) } else { serde_json::json!({}) };
        data["api_key"] = Value::String(value);
        write_private_json(&path, &data)?;
        saved.push(provider.clone());
    }
    Ok(serde_json::json!({ "ok": true, "saved": saved, "status": api_key_status()["status"] }))
}

// --- CLI 版本探测（当前版本实时，最新版本 1h 缓存） ---------------------------

fn version_cache_path() -> PathBuf {
    local_home().join(".cache").join("ai-usage-monitor").join("versions.json")
}

fn semver_key(text: &str) -> Vec<u64> {
    // 点号也是分隔符：'0.10.0' 必须切成 [0, 10, 0] 才能正确比较
    text.trim_start_matches('v')
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|part| part.parse().ok())
        .collect()
}

fn semver_in(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut best: Option<String> = None;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_digit() {
            let mut end = index;
            let mut dots = 0;
            while end < bytes.len() && (bytes[end].is_ascii_digit() || (bytes[end] == b'.' && dots < 2)) {
                if bytes[end] == b'.' {
                    if end + 1 >= bytes.len() || !bytes[end + 1].is_ascii_digit() {
                        break;
                    }
                    dots += 1;
                }
                end += 1;
            }
            let candidate = &text[index..end];
            if candidate.matches('.').count() == 2 {
                best = Some(candidate.to_string());
                break;
            }
            index = end;
        } else {
            index += 1;
        }
    }
    best
}

fn request_text(url: &str, use_proxy: bool) -> Option<String> {
    let agent = super::quota::build_agent(use_proxy, 15);
    match agent.get(url).set("Accept", "text/plain, application/json").call() {
        Ok(response) => response.into_string().ok(),
        Err(_) => None,
    }
}

fn fetch_latest_version(provider: &str) -> Option<String> {
    match provider {
        "Kimi Code" => request_text(KIMI_LATEST_VERSION_URL, env_enabled("KIMI_USE_PROXY", false))
            .and_then(|text| semver_in(&text)),
        "OpenAI Codex" => {
            let url = NPM_LATEST_VERSION_URL.replace("{package}", "@openai/codex");
            let text = request_text(&url, true)?;
            let value: Value = serde_json::from_str(&text).ok()?;
            semver_in(value.get("version")?.as_str()?)
        }
        _ => None,
    }
}

/// `cmd --version`：Windows 上 npm 安装的是 .cmd 垫片，必须经 cmd.exe 解析。
fn detect_cli_version(command: &str) -> Option<String> {
    let output = if cfg!(windows) {
        std::process::Command::new("cmd.exe").args(["/C", command, "--version"]).output()
    } else {
        std::process::Command::new(command).arg("--version").output()
    };
    let stdout = output.ok()?.stdout;
    let text = String::from_utf8_lossy(&stdout);
    semver_in(&text)
}

/// GET /api/usage 里的 versions 字段：Kimi/Codex 当前与最新版本。
pub fn collect_versions() -> Value {
    let providers = ["Kimi Code", "OpenAI Codex"];
    let cache_path = version_cache_path();
    let mut cache = read_json(&cache_path).unwrap_or_else(|_| serde_json::json!({}));
    let now = Instant::now();
    let mut versions = serde_json::Map::new();
    for provider in providers {
        let tool_command = if provider == "Kimi Code" { "kimi" } else { "codex" };
        let entry = cache.get(provider).cloned().unwrap_or_else(|| serde_json::json!({}));
        let current = detect_cli_version(tool_command)
            .or_else(|| entry.get("current").and_then(|v| v.as_str()).map(String::from));
        let (latest, checked_at) = {
            let age = entry
                .get("checked_at")
                .and_then(|v| v.as_f64())
                .map(|stamp| Duration::from_secs_f64(stamp));
            match age {
                Some(age) if age < Duration::from_secs(VERSION_CHECK_INTERVAL) => (
                    entry.get("latest").and_then(|v| v.as_str()).map(String::from),
                    age,
                ),
                _ => {
                    let latest = fetch_latest_version(provider).or_else(|| {
                        entry.get("latest").and_then(|v| v.as_str()).map(String::from)
                    });
                    (latest, now.elapsed())
                }
            }
        };
        let mut info = serde_json::Map::new();
        if let Some(current) = &current {
            info.insert("current".into(), Value::String(current.clone()));
        }
        if let Some(latest) = &latest {
            info.insert("latest".into(), Value::String(latest.clone()));
        }
        versions.insert(provider.to_string(), Value::Object(info));
        let mut cache_entry = serde_json::Map::new();
        if let Some(current) = &current {
            cache_entry.insert("current".into(), Value::String(current.clone()));
        }
        if let Some(latest) = &latest {
            cache_entry.insert("latest".into(), Value::String(latest.clone()));
        }
        cache_entry.insert(
            "checked_at".into(),
            Value::from(checked_at.as_secs_f64()),
        );
        cache[provider] = Value::Object(cache_entry);
    }
    let _ = write_private_json(&cache_path, &cache);
    let outdated = versions.iter().any(|(_, info)| {
        let current = info.get("current").and_then(|v| v.as_str()).unwrap_or("");
        let latest = info.get("latest").and_then(|v| v.as_str()).unwrap_or("");
        !current.is_empty() && !latest.is_empty() && semver_key(latest) > semver_key(current)
    });
    serde_json::json!({ "providers": versions, "outdated": outdated })
}

/// 供 /api/backend-status 使用。
pub fn backend_status_payload() -> Value {
    let settings = load_settings();
    serde_json::json!({
        "ok": true,
        "engine": format!("env-tools-api (native rust {})", env!("CARGO_PKG_VERSION")),
        "environment": settings.get("environment").cloned().unwrap_or(Value::Null),
        "wsl_distro": settings.get("wsl_distro").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_in_extracts_triplet() {
        assert_eq!(semver_in("kimi 1.2.3 (build 7)").as_deref(), Some("1.2.3"));
        assert_eq!(semver_in("v0.154.0").as_deref(), Some("0.154.0"));
        assert_eq!(semver_in("no version here"), None);
    }

    #[test]
    fn semver_key_orders() {
        assert!(semver_key("0.10.0") > semver_key("0.9.9"));
        assert!(semver_key("1.0.0") > semver_key("0.99.99"));
    }
}
