//! 设置、凭据与 CLI 版本的原生实现（v0.7.0 起取代原 Python 实现的对应部分）。
//!
//! 存储位置与 Python 版保持一致，避免升级后丢失配置：
//! - `~/.config/ai-usage-monitor/settings.json`  数据源环境（environment/wsl_distro）
//! - `~/.config/ai-usage-monitor/config.json`    会员到期手动配置（kimi/openai/glm/deepseek）
//! - `~/.cache/ai-usage-monitor/versions.json`   CLI 最新版本探测缓存（1 小时）
//! - `~/.deepseek/credentials.json`、`~/.glm/credentials.json`  API key（Electron 经 stdin 写入）

use std::path::{Path, PathBuf};

use serde_json::Value;

#[cfg(test)]
pub(crate) static TEST_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const VERSION_CHECK_INTERVAL: u64 = 3600;
const KIMI_LATEST_VERSION_URL: &str = "https://code.kimi.com/kimi-code/latest";
const NPM_LATEST_VERSION_URL: &str = "https://registry.npmjs.org/{package}/latest";
const ZCODE_LATEST_PAGE_URL: &str = "https://zcode.z.ai/cn";

pub fn env_value(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub fn env_enabled(name: &str, default: bool) -> bool {
    match env_value(name) {
        Some(v) => matches!(
            v.trim().to_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        None => default,
    }
}

pub fn local_home() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub use crate::accounts::{AccountProfile, Provider};

pub fn codex_accounts() -> Vec<AccountProfile> {
    crate::accounts::profiles(Provider::Codex)
}

pub fn codex_account(id: &str) -> Option<AccountProfile> {
    crate::accounts::account(Provider::Codex, id)
}

pub fn codex_membership_key(account_id: &str) -> String {
    crate::accounts::membership_key(Provider::Codex, account_id)
}

pub fn codex_accounts_payload() -> Value {
    crate::accounts::accounts_payload(Provider::Codex)
}

pub fn accounts_payload(provider: Provider) -> Value {
    crate::accounts::accounts_payload(provider)
}

pub fn update_accounts(provider: Provider, payload: &Value) -> Result<Value, String> {
    let result = if payload.get("action").and_then(Value::as_str) == Some("set-active") {
        crate::accounts::update_active_all_scopes(provider, payload)?
    } else {
        crate::accounts::update_accounts(provider, payload)?
    };
    if provider == Provider::Codex
        && payload.get("action").and_then(Value::as_str) != Some("set-active")
    {
        crate::quota::invalidate_codex_retry_state();
    }
    Ok(result)
}

pub fn update_codex_accounts(payload: &Value) -> Result<Value, String> {
    update_accounts(Provider::Codex, payload)
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
        let Ok(users) = std::fs::read_dir(&home_root) else {
            continue;
        };
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

/// 指定 WSL 发行版的用户家目录（UNC）。找不到时返回空列表。
pub fn wsl_distro_homes(distro: &str) -> Vec<PathBuf> {
    if !cfg!(windows) || distro.trim().is_empty() {
        return Vec::new();
    }
    let home_root = PathBuf::from(format!("\\\\wsl.localhost\\{distro}\\home"));
    let mut homes = Vec::new();
    if let Ok(users) = std::fs::read_dir(&home_root) {
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
    serde_json::from_str(&text).map_err(|err| format!("Cannot parse {}: {err}", path.display()))
}

pub fn write_private_json(path: &Path, data: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        #[cfg(unix)]
        {
            let _ = std::fs::set_permissions(
                parent,
                std::os::unix::fs::PermissionsExt::from_mode(0o700),
            );
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
    env_value("AI_USAGE_SETTINGS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| config_dir().join("settings.json"))
}

pub fn membership_config_path() -> PathBuf {
    env_value("AI_USAGE_CONFIG_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| config_dir().join("config.json"))
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

fn wsl_distro_names(args: &[&str]) -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    let output = std::process::Command::new("wsl.exe")
        .args(args)
        .stdin(std::process::Stdio::null())
        .output();
    let mut names = Vec::new();
    if let Ok(out) = output {
        // wsl.exe 输出为 UTF-16；按字节过滤后只保留可打印 ASCII
        let text: String = out
            .stdout
            .iter()
            .filter(|b| {
                b.is_ascii_alphanumeric()
                    || b.is_ascii_whitespace()
                    || **b == b'-'
                    || **b == b'_'
                    || **b == b'.'
            })
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
}

pub fn available_wsl_distros() -> Vec<String> {
    wsl_distro_names(&["--list", "--quiet"])
}

/// 仅当前正在运行的发行版：进程检测等场景不为查询去启动已停止的发行版。
pub fn running_wsl_distros() -> Vec<String> {
    wsl_distro_names(&["--list", "--running", "--quiet"])
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
    let configured = settings
        .get("environment")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let environment = if available.iter().any(|env| env == configured) && !configured.is_empty() {
        configured.to_string()
    } else {
        available[0].clone()
    };
    let wsl_distros = available_wsl_distros();
    let configured_distro = settings
        .get("wsl_distro")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let wsl_distro = if wsl_distros.iter().any(|d| d == configured_distro) {
        configured_distro.to_string()
    } else {
        wsl_distros.first().cloned().unwrap_or_default()
    };
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    // 周起点（趋势按周分桶用）：monday（默认）| sunday
    let week_start = settings
        .get("week_start")
        .and_then(|v| v.as_str())
        .filter(|v| *v == "monday" || *v == "sunday")
        .unwrap_or("monday");
    // 速度口径：gen = 纯生成速度 TPOT（默认）| throughput = 输出 ÷ 会话总时长
    let speed_mode = settings
        .get("speed_mode")
        .and_then(|v| v.as_str())
        .filter(|v| *v == "gen" || *v == "throughput")
        .unwrap_or("gen");
    serde_json::json!({
        "ok": true,
        "version": crate::APP_VERSION,
        "environment": environment,
        "available_environments": available,
        "wsl_distros": wsl_distros,
        "wsl_distro": wsl_distro,
        "membership": membership_settings(),
        "week_start": week_start,
        "speed_mode": speed_mode,
        "script": exe,
    })
}

/// POST /api/settings：保存环境与会员时间（契约与 Python update_settings 一致）。
pub fn update_settings(payload: &Value) -> Result<Value, String> {
    if !payload.is_object() {
        return Err("Settings must be a JSON object".into());
    }
    let allowed = [
        "environment",
        "wsl_distro",
        "membership",
        "week_start",
        "speed_mode",
    ];
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
    if let Some(value) = payload.get("speed_mode") {
        let value = value.as_str().unwrap_or("");
        if value != "gen" && value != "throughput" {
            return Err(format!(
                "Invalid speed_mode '{value}' (use gen or throughput)"
            ));
        }
        obj.insert("speed_mode".into(), Value::String(value.to_string()));
    }
    if let Some(value) = payload.get("week_start") {
        let value = value.as_str().unwrap_or("");
        if value != "monday" && value != "sunday" {
            return Err(format!(
                "Invalid week_start '{value}' (use monday or sunday)"
            ));
        }
        obj.insert("week_start".into(), Value::String(value.to_string()));
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

/// 设置页只展开当前可见账号；被移除账号的配置仍原样保留在 config.json。
pub fn membership_settings() -> Value {
    let mut sections = serde_json::Map::new();
    for profile in crate::accounts::all_profiles() {
        let key = profile.membership_key();
        if let Some(entry) = crate::quota::membership::normalized_manual_entry(&key) {
            sections.insert(key, entry);
        }
    }
    Value::Object(sections)
}

fn membership_provider_supported(provider: &str) -> bool {
    crate::accounts::profile_for_membership_key(provider).is_some()
}

pub fn update_membership_config(payload: &Value) -> Result<Value, String> {
    let Some(payload) = payload.as_object() else {
        return Err("membership must be an object".into());
    };
    let mut config = load_membership_config();
    let obj = config.as_object_mut().unwrap();
    for (provider, section) in payload {
        if !membership_provider_supported(provider) {
            return Err(format!("Unsupported membership provider: {provider}"));
        }
        let Some(section) = section.as_object() else {
            obj.remove(provider);
            continue;
        };
        // UI 契约：{ purchased_at, duration_months }（purchased_at 为 datetime-local
        // 格式，如 2026-09-20T15:30）；config.json 落盘键为 membership_purchased_at
        let purchased = section
            .get("purchased_at")
            .or_else(|| section.get("membership_purchased_at"))
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let months = section
            .get("duration_months")
            .or_else(|| section.get("membership_duration_months"))
            .and_then(|v| v.as_i64())
            .unwrap_or(1)
            .max(1);
        let mut cleaned = serde_json::Map::new();
        if !purchased.is_empty() {
            chrono::DateTime::parse_from_rfc3339(&purchased)
                .map(|_| ())
                .or_else(|_| {
                    for format in [
                        "%Y-%m-%dT%H:%M",
                        "%Y-%m-%dT%H:%M:%S",
                        "%Y-%m-%d %H:%M",
                        "%Y-%m-%d %H:%M:%S",
                    ] {
                        if chrono::NaiveDateTime::parse_from_str(&purchased, format).is_ok() {
                            return Ok(());
                        }
                    }
                    Err(())
                })
                .map_err(|_| {
                    format!("Invalid membership_purchased_at for {provider}: {purchased}")
                })?;
            cleaned.insert("membership_purchased_at".into(), Value::String(purchased));
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
    if section
        .get("membership_purchased_at")
        .and_then(|v| v.as_str())
        .is_some()
    {
        Some(Value::Object(section))
    } else {
        None
    }
}

// --- API keys ---------------------------------------------------------------

fn api_key_provider(value: &str) -> Result<Provider, String> {
    match Provider::parse(value) {
        Some(provider @ (Provider::Glm | Provider::Deepseek)) => Ok(provider),
        _ => Err(format!("Unsupported API key provider: {value}")),
    }
}

fn scoped_api_key_profile(provider: &str, account_id: &str) -> Result<AccountProfile, String> {
    let provider = api_key_provider(provider)?;
    if account_id.trim().is_empty() {
        return Err("account_id cannot be empty".into());
    }
    crate::accounts::account(provider, account_id)
        .ok_or_else(|| format!("{} account not found: {account_id}", provider.display_name()))
}

/// 旧版 GET：始终报告两家默认账号，响应形状保持不变。
pub fn api_key_status() -> Value {
    serde_json::json!({
        "ok": true,
        "status": {
            "deepseek": crate::accounts::credential_status(
                &crate::accounts::default_profile(Provider::Deepseek),
            ),
            "glm": crate::accounts::credential_status(
                &crate::accounts::default_profile(Provider::Glm),
            ),
        },
    })
}

pub fn scoped_api_key_status(provider: &str, account_id: &str) -> Result<Value, String> {
    let profile = scoped_api_key_profile(provider, account_id)?;
    Ok(serde_json::json!({
        "ok": true,
        "provider": profile.provider.id(),
        "account_id": profile.id,
        "status": crate::accounts::credential_status(&profile),
    }))
}

fn write_api_key(profile: &AccountProfile, value: &str) -> Result<(), String> {
    let path = crate::accounts::credentials_write_path(profile);
    let mut data = if path.is_file() {
        read_json(&path).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    data["api_key"] = Value::String(value.to_string());
    write_private_json(&path, &data)
}

fn save_scoped_api_key(payload: &Value) -> Result<Value, String> {
    let provider = payload
        .get("provider")
        .and_then(Value::as_str)
        .ok_or_else(|| "provider is required for scoped API key settings".to_string())?;
    let account_id = payload
        .get("account_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "account_id is required for scoped API key settings".to_string())?;
    let profile = scoped_api_key_profile(provider, account_id)?;
    let value = payload
        .get("api_key")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{} API key cannot be empty", profile.provider.id()))?;
    write_api_key(&profile, value)?;
    Ok(serde_json::json!({
        "ok": true,
        "provider": profile.provider.id(),
        "account_id": profile.id,
        "saved": true,
        "status": crate::accounts::credential_status(&profile),
    }))
}

pub fn save_api_keys(payload: &Value) -> Result<Value, String> {
    let Some(object) = payload.as_object() else {
        return Err("API key settings must be a JSON object".into());
    };
    if object.contains_key("provider")
        || object.contains_key("account_id")
        || object.contains_key("api_key")
    {
        return save_scoped_api_key(payload);
    }

    let mut plans = Vec::new();
    for (provider, value) in object {
        let provider = api_key_provider(provider)?;
        let value = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("{} API key cannot be empty", provider.id()))?
            .to_string();
        plans.push((provider, value));
    }
    let mut saved = Vec::new();
    for (provider, value) in plans {
        write_api_key(&crate::accounts::default_profile(provider), &value)?;
        saved.push(provider.id().to_string());
    }
    Ok(serde_json::json!({
        "ok": true,
        "saved": saved,
        "status": api_key_status()["status"],
    }))
}

// --- CLI 版本探测（当前版本实时，最新版本 1h 缓存） ---------------------------

fn version_cache_path() -> PathBuf {
    local_home()
        .join(".cache")
        .join("ai-usage-monitor")
        .join("versions.json")
}

/// 增量扫描磁盘缓存：~/.cache/ai-usage-monitor/scan-cache-<scope>.json
///（scope 含 ':' 时替换为 '_'，Windows 文件名不允许冒号）
pub fn scan_cache_path(scope: &str) -> PathBuf {
    let safe = scope.replace(':', "_");
    local_home()
        .join(".cache")
        .join("ai-usage-monitor")
        .join(format!("scan-cache-{safe}.json"))
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
            while end < bytes.len()
                && (bytes[end].is_ascii_digit() || (bytes[end] == b'.' && dots < 2))
            {
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
    match agent
        .get(url)
        .set("Accept", "text/plain, application/json")
        .call()
    {
        Ok(response) => response.into_string().ok(),
        Err(_) => None,
    }
}

fn fetch_latest_version(provider: &str) -> Option<String> {
    match provider {
        "Kimi Code" => request_text(
            KIMI_LATEST_VERSION_URL,
            env_enabled("KIMI_USE_PROXY", false),
        )
        .and_then(|text| semver_in(&text)),
        "OpenAI Codex" => {
            let url = NPM_LATEST_VERSION_URL.replace("{package}", "@openai/codex");
            let text = request_text(&url, true)?;
            let value: Value = serde_json::from_str(&text).ok()?;
            semver_in(value.get("version")?.as_str()?)
        }
        // ZCode 桌面版无独立 latest 端点：官网首页解析 windows-x64 安装包链接，
        // 取 semver 最大者
        "ZCode" => {
            let html = request_text(ZCODE_LATEST_PAGE_URL, true)?;
            let mut best: Option<(Vec<u64>, String)> = None;
            let mut rest = html.as_str();
            while let Some(pos) = rest.find("ZCode-") {
                rest = &rest[pos + "ZCode-".len()..];
                let mut parts: Vec<u64> = Vec::new();
                let mut consumed = 0;
                let bytes = rest.as_bytes();
                let mut ok = true;
                for expected in 0..3 {
                    let mut num_end = consumed;
                    while num_end < bytes.len() && bytes[num_end].is_ascii_digit() {
                        num_end += 1;
                    }
                    if num_end == consumed {
                        ok = false;
                        break;
                    }
                    let part: u64 = rest[consumed..num_end].parse().ok()?;
                    parts.push(part);
                    consumed = num_end;
                    if expected < 2 {
                        if bytes.get(consumed) == Some(&b'.') {
                            consumed += 1;
                        } else {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok && rest[consumed..].starts_with("-win-x64.exe") {
                    let version = rest[..consumed].to_string();
                    if best.as_ref().map(|(b, _)| parts > *b).unwrap_or(true) {
                        best = Some((parts, version));
                    }
                }
            }
            best.map(|(_, version)| version)
        }
        _ => None,
    }
}

/// ZCode 桌面版已装版本：卸载注册表（HKCU 优先，回退 HKLM 64/32）。
/// 与 electron 侧 component-detect 同口径（DisplayName = "ZCode x.y.z"）。
fn detect_zcode_version() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    const PS: &str = concat!(
        "$v=$null;",
        "foreach($root in 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
        "'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
        "'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'){",
        "if($v){break};",
        "foreach($k in Get-ChildItem $root -ErrorAction SilentlyContinue){",
        "$p=Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue;",
        "if($p.DisplayName -match '^ZCode\\s+\\d' -and $p.DisplayVersion){$v=$p.DisplayVersion.Trim();break}}}",
        "Write-Output $v",
    );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", PS])
        .output()
        .ok()?;
    semver_in(&String::from_utf8_lossy(&output.stdout))
}

/// `cmd --version`：Windows 上 npm 安装的是 .cmd 垫片，必须经 cmd.exe 解析。
fn detect_cli_version(command: &str) -> Option<String> {
    let output = if cfg!(windows) {
        std::process::Command::new("cmd.exe")
            .args(["/C", command, "--version"])
            .output()
    } else {
        std::process::Command::new(command)
            .arg("--version")
            .output()
    };
    let stdout = output.ok()?.stdout;
    let text = String::from_utf8_lossy(&stdout);
    semver_in(&text)
}

/// GET /api/usage 里的 versions 字段：Kimi/Codex 当前与最新版本。
pub fn collect_versions() -> Value {
    let providers = ["Kimi Code", "OpenAI Codex", "ZCode"];
    let cache_path = version_cache_path();
    let mut cache = read_json(&cache_path).unwrap_or_else(|_| serde_json::json!({}));
    // checked_at 落盘为 Unix 秒：跨进程可比（Instant 基准仅在当前进程有意义）
    let now_epoch = chrono::Utc::now().timestamp() as f64;
    let mut versions = serde_json::Map::new();
    for provider in providers {
        let tool_command = if provider == "Kimi Code" {
            "kimi"
        } else if provider == "ZCode" {
            // ZCode 是桌面应用不在 PATH，版本读卸载注册表
            "zcode"
        } else {
            "codex"
        };
        let entry = cache
            .get(provider)
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        let current = if provider == "ZCode" {
            detect_zcode_version()
        } else {
            detect_cli_version(tool_command)
        }
        .or_else(|| {
            entry
                .get("current")
                .and_then(|v| v.as_str())
                .map(String::from)
        });
        let cached_at = entry.get("checked_at").and_then(|v| v.as_f64());
        let fresh = cached_at
            .map(|stamp| now_epoch - stamp < VERSION_CHECK_INTERVAL as f64)
            .unwrap_or(false);
        let (latest, checked_at) = if fresh {
            (
                entry
                    .get("latest")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                cached_at.unwrap_or(now_epoch),
            )
        } else {
            (
                fetch_latest_version(provider).or_else(|| {
                    entry
                        .get("latest")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                }),
                now_epoch,
            )
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
        cache_entry.insert("checked_at".into(), Value::from(checked_at));
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
        "engine": format!("env-tools-api (native rust {})", crate::APP_VERSION),
        "environment": settings.get("environment").cloned().unwrap_or(Value::Null),
        "wsl_distro": settings.get("wsl_distro").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestEnv {
        dir: PathBuf,
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
    }

    impl TestEnv {
        fn new(label: &str) -> Self {
            const NAMES: &[&str] = &[
                "HOME",
                "USERPROFILE",
                "PATH",
                "AI_USAGE_CONFIG_PATH",
                "AI_USAGE_SETTINGS_PATH",
                "CODEX_ACCOUNTS_PATH",
                "CODEX_HOME",
                "CODEX_AUTH_PATH",
                "KIMI_CODE_HOME",
                "KIMI_CREDENTIALS_PATH",
                "KIMI_WEB_CREDENTIALS_PATH",
                "KIMI_USAGE_URL",
                "KIMI_USE_PROXY",
                "KIMI_TIMEOUT",
                "KIMI_WEB_STATS_URL",
                "KIMI_WEB_SUBSCRIPTION_URL",
                "GLM_CREDENTIALS_PATH",
                "GLM_API_KEY",
                "ZHIPU_API_KEY",
                "ZHIPUAI_API_KEY",
                "DEEPSEEK_CREDENTIALS_PATH",
                "DEEPSEEK_API_KEY",
                "ZCODE_CREDENTIALS_PATH",
                "ZCODE_CREDENTIAL_SECRET",
                "GLM_RESET_CARDS",
            ];
            let dir = std::env::temp_dir().join(format!(
                "env-tools-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            let saved = NAMES
                .iter()
                .map(|name| (*name, std::env::var_os(name)))
                .collect::<Vec<_>>();
            for name in NAMES {
                std::env::remove_var(name);
            }
            let empty_path = dir.join("empty-path");
            std::fs::create_dir_all(&empty_path).unwrap();
            std::env::set_var("HOME", &dir);
            std::env::set_var("USERPROFILE", &dir);
            std::env::set_var("PATH", &empty_path);
            std::env::set_var("KIMI_USE_PROXY", "0");
            std::env::set_var("GLM_RESET_CARDS", "1");
            Self { dir, saved }
        }
    }

    impl Drop for TestEnv {
        fn drop(&mut self) {
            for (name, value) in &self.saved {
                if let Some(value) = value {
                    std::env::set_var(name, value);
                } else {
                    std::env::remove_var(name);
                }
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

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

    #[test]
    fn scoped_api_keys_validate_accounts_and_batch_before_writing() {
        let _lock = env_lock();
        let env = TestEnv::new("scoped-keys");
        assert!(scoped_api_key_status("glm", "unknown").is_err());
        crate::accounts::update_accounts(
            Provider::Glm,
            &serde_json::json!({"action": "add", "id": "work", "label": "Work"}),
        )
        .unwrap();

        std::env::set_var("GLM_API_KEY", "default-test-key");
        let work = crate::accounts::account(Provider::Glm, "work").unwrap();
        assert_eq!(
            crate::accounts::credential_status(&work)["configured"],
            false,
            "extra profiles must not inherit the default environment key"
        );
        assert!(crate::accounts::api_key(&work).is_err());

        let zcode = env.dir.join("default-zcode.json");
        std::fs::write(
            &zcode,
            r#"{"zcodejwttoken":"fake-jwt","oauth:bigmodel:access_token":"fake-maas"}"#,
        )
        .unwrap();
        std::env::set_var("ZCODE_CREDENTIALS_PATH", &zcode);
        assert!(crate::accounts::glm_reset_credentials_path(&work).is_none());
        let reset = crate::quota::use_glm_reset_card("work", "FIVE_HOUR").unwrap_err();
        assert!(reset.contains("independently bound"));

        let saved = save_api_keys(&serde_json::json!({
            "provider": "glm",
            "account_id": "work",
            "api_key": "work-test-key",
        }))
        .unwrap();
        assert_eq!(saved["saved"], true);
        assert_eq!(saved["provider"], "glm");
        assert_eq!(saved["account_id"], "work");
        assert_eq!(saved["status"]["configured"], true);
        assert_eq!(saved["status"]["source"], "file");
        assert!(!saved.to_string().contains("work-test-key"));
        assert_eq!(crate::accounts::api_key(&work).as_deref(), Ok("work-test-key"));
        let work_credentials = crate::accounts::credentials_write_path(&work);
        assert!(work_credentials.is_file());
        assert_eq!(
            scoped_api_key_status("glm", "default").unwrap()["status"]["source"],
            "environment"
        );
        std::env::remove_var("GLM_API_KEY");

        let default_glm = env.dir.join(".glm").join("credentials.json");
        let rejected = save_api_keys(&serde_json::json!({
            "glm": "must-not-be-written",
            "deepseek": 42,
        }));
        assert!(rejected.is_err());
        assert!(
            !default_glm.exists(),
            "a later invalid entry must not leave an earlier partial write"
        );

        let legacy = save_api_keys(&serde_json::json!({
            "glm": "legacy-glm-key",
            "deepseek": "legacy-deepseek-key",
        }))
        .unwrap();
        assert!(legacy["saved"].is_array());
        assert_eq!(legacy["status"]["glm"]["configured"], true);
        assert_eq!(legacy["status"]["deepseek"]["configured"], true);
        assert!(!legacy.to_string().contains("legacy-glm-key"));
        assert!(!legacy.to_string().contains("legacy-deepseek-key"));

        crate::accounts::update_accounts(
            Provider::Glm,
            &serde_json::json!({"action": "remove", "id": "work"}),
        )
        .unwrap();
        assert!(work_credentials.is_file(), "registry removal must preserve credentials");
        assert!(scoped_api_key_status("glm", "work").is_err());
        assert!(save_api_keys(&serde_json::json!({
            "provider": "glm",
            "account_id": "work",
            "api_key": "removed-account-key",
        }))
        .is_err());
    }

    #[test]
    fn membership_keys_cover_four_providers_and_hidden_entries_survive() {
        let _lock = env_lock();
        let _env = TestEnv::new("membership-keys");
        let mut payload = serde_json::Map::new();
        for (index, provider) in Provider::ALL.into_iter().enumerate() {
            crate::accounts::update_accounts(
                provider,
                &serde_json::json!({"action": "add", "id": "work", "label": "Work"}),
            )
            .unwrap();
            for account_id in ["default", "work"] {
                let key = crate::accounts::membership_key(provider, account_id);
                payload.insert(
                    key,
                    serde_json::json!({
                        "purchased_at": "2026-01-10T09:00",
                        "duration_months": index + 1,
                    }),
                );
            }
        }
        let visible = update_membership_config(&Value::Object(payload)).unwrap();
        assert_eq!(visible.as_object().unwrap().len(), 8);
        for provider in Provider::ALL {
            let prefix = provider.spec().membership_prefix;
            assert!(visible.get(prefix).is_some());
            assert!(visible.get(format!("{prefix}:work")).is_some());
        }

        for provider in Provider::ALL {
            crate::accounts::update_accounts(
                provider,
                &serde_json::json!({"action": "remove", "id": "work"}),
            )
            .unwrap();
        }
        let visible = membership_settings();
        assert_eq!(visible.as_object().unwrap().len(), 4);
        let stored = load_membership_config();
        assert_eq!(stored.as_object().unwrap().len(), 8);
        for provider in Provider::ALL {
            let key = crate::accounts::membership_key(provider, "work");
            assert!(visible.get(&key).is_none());
            assert!(stored.get(&key).is_some());
        }
    }

    #[test]
    fn quota_collection_expands_profiles_and_attaches_error_identity() {
        let _lock = env_lock();
        let _env = TestEnv::new("quota-profiles");
        crate::quota::invalidate_codex_retry_state();
        for provider in Provider::ALL {
            crate::accounts::update_accounts(
                provider,
                &serde_json::json!({"action": "add", "id": "work", "label": "Work"}),
            )
            .unwrap();
        }
        let (accounts, errors) = crate::quota::collect_all();
        crate::quota::invalidate_codex_retry_state();
        assert!(accounts.is_empty());
        assert_eq!(errors.len(), 8);
        let mut identities = std::collections::HashSet::new();
        for error in errors {
            let id = error["account_id"].as_str().unwrap();
            assert!(!id.is_empty());
            assert!(!error["account_label"].as_str().unwrap().is_empty());
            identities.insert((error["provider"].as_str().unwrap().to_string(), id.to_string()));
        }
        assert_eq!(identities.len(), 8);
        for provider in Provider::ALL {
            for account_id in ["default", "work"] {
                assert!(identities.contains(&(
                    provider.display_name().to_string(),
                    account_id.to_string(),
                )));
            }
        }
    }

    #[test]
    fn quota_errors_preserve_membership_and_credential_details() {
        let _lock = env_lock();
        let _env = TestEnv::new("quota-card-error-dedup");
        crate::quota::invalidate_codex_retry_state();
        update_membership_config(&serde_json::json!({
            "openai": {"purchased_at": "2026-01-01T08:00", "duration_months": 12},
            "kimi": {"purchased_at": "2026-02-01T08:00", "duration_months": 6},
        }))
        .unwrap();
        let (accounts, errors) = crate::quota::collect_all();
        crate::quota::invalidate_codex_retry_state();
        assert!(accounts.is_empty());
        assert_eq!(errors.len(), 4);
        let codex = errors
            .iter()
            .find(|error| error["provider"] == "OpenAI Codex")
            .unwrap();
        assert_eq!(codex["membership"]["duration_months"], 12);
        assert!(codex["error"].as_str().unwrap().contains("credentials"));
        let kimi = errors
            .iter()
            .find(|error| error["provider"] == "Kimi Code")
            .unwrap();
        assert_eq!(kimi["membership"]["duration_months"], 6);
        assert!(kimi["error"].as_str().unwrap().contains("credentials"));
    }

    fn collect_kimi_with_mock(profile: &AccountProfile) -> (Option<Value>, Vec<Value>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::env::set_var("KIMI_USAGE_URL", format!("http://{address}/usage"));
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = std::io::Read::read(&mut stream, &mut request);
            let body = serde_json::json!({
                "limits": [],
                "usage": {"used_percent": 0},
                "user": {"membership": {"level": "allegro"}},
            })
            .to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len(),
            );
            let _ = std::io::Write::write_all(&mut stream, response.as_bytes());
        });
        let mut errors = Vec::new();
        let account = crate::quota::collect_kimi_profile(profile, &mut errors);
        worker.join().unwrap();
        (account, errors)
    }

    fn write_kimi_cli_credentials(profile: &AccountProfile) {
        write_private_json(
            &profile.home.join("credentials/kimi-code.json"),
            &serde_json::json!({
                "access_token": "temporary-test-token",
                "expires_at": chrono::Utc::now().timestamp() + 3600,
            }),
        )
        .unwrap();
    }

    #[test]
    fn kimi_manual_membership_survives_missing_or_broken_web() {
        let _lock = env_lock();
        let env = TestEnv::new("kimi-decoupling");
        write_private_json(
            &membership_config_path(),
            &serde_json::json!({
                "kimi": {
                    "membership_purchased_at": "2026-01-10T09:00",
                    "membership_duration_months": 12,
                },
                "kimi:work": {
                    "membership_purchased_at": "2026-02-10T09:00",
                    "membership_duration_months": 3,
                },
            }),
        )
        .unwrap();

        let default = crate::accounts::default_profile(Provider::Kimi);
        write_kimi_cli_credentials(&default);
        let (account, errors) = collect_kimi_with_mock(&default);
        let account = account.expect("CLI result must survive missing web credentials");
        assert!(errors.is_empty());
        assert_eq!(account["account_id"], "default");
        assert_eq!(account["membership"]["source"], "manual");
        assert_eq!(account["membership"]["duration_months"], 12);

        crate::accounts::update_accounts(
            Provider::Kimi,
            &serde_json::json!({"action": "add", "id": "work", "label": "Work"}),
        )
        .unwrap();
        let work = crate::accounts::account(Provider::Kimi, "work").unwrap();
        write_kimi_cli_credentials(&work);
        let work_web = work.home.join("credentials/kimi-web.json");
        std::fs::create_dir_all(work_web.parent().unwrap()).unwrap();
        std::fs::write(&work_web, "not-json").unwrap();

        let default_web = env.dir.join("default-web.json");
        std::fs::write(&default_web, "{}").unwrap();
        std::env::set_var("KIMI_WEB_CREDENTIALS_PATH", &default_web);
        assert_eq!(
            crate::accounts::kimi_web_credential_path(&default).as_deref(),
            Some(default_web.as_path())
        );
        let other = AccountProfile {
            provider: Provider::Kimi,
            id: "other".into(),
            label: "Other".into(),
            home: work.home.with_file_name("other"),
            is_default: false,
        };
        assert!(crate::accounts::kimi_web_credential_path(&other).is_none());

        let (account, errors) = collect_kimi_with_mock(&work);
        let account = account.expect("CLI result and manual membership must survive broken web JSON");
        assert!(errors.is_empty());
        assert_eq!(account["account_id"], "work");
        assert_eq!(account["membership"]["source"], "manual");
        assert_eq!(account["membership"]["duration_months"], 3);
    }
}
