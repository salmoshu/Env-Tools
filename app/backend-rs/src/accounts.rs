use std::path::PathBuf;

use serde_json::Value;

use crate::settings::{env_value, local_home, read_json, write_private_json};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum Provider {
    Kimi,
    Codex,
    Glm,
    Deepseek,
}

pub struct ProviderSpec {
    pub provider: Provider,
    pub id: &'static str,
    pub display_name: &'static str,
    pub membership_prefix: &'static str,
    pub registry_file: &'static str,
    pub default_dir: &'static str,
    pub home_env: Option<&'static str>,
    pub credential_relative: &'static str,
}

const KIMI: ProviderSpec = ProviderSpec {
    provider: Provider::Kimi,
    id: "kimi",
    display_name: "Kimi Code",
    membership_prefix: "kimi",
    registry_file: "kimi-accounts.json",
    default_dir: ".kimi-code",
    home_env: Some("KIMI_CODE_HOME"),
    credential_relative: "credentials/kimi-code.json",
};
const CODEX: ProviderSpec = ProviderSpec {
    provider: Provider::Codex,
    id: "codex",
    display_name: "OpenAI Codex",
    membership_prefix: "openai",
    registry_file: "codex-accounts.json",
    default_dir: ".codex",
    home_env: Some("CODEX_HOME"),
    credential_relative: "auth.json",
};
const GLM: ProviderSpec = ProviderSpec {
    provider: Provider::Glm,
    id: "glm",
    display_name: "GLM",
    membership_prefix: "glm",
    registry_file: "glm-accounts.json",
    default_dir: ".glm",
    home_env: None,
    credential_relative: "credentials.json",
};
const DEEPSEEK: ProviderSpec = ProviderSpec {
    provider: Provider::Deepseek,
    id: "deepseek",
    display_name: "DeepSeek",
    membership_prefix: "deepseek",
    registry_file: "deepseek-accounts.json",
    default_dir: ".deepseek",
    home_env: None,
    credential_relative: "credentials.json",
};

impl Provider {
    pub const ALL: [Provider; 4] = [
        Provider::Kimi,
        Provider::Codex,
        Provider::Glm,
        Provider::Deepseek,
    ];

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "kimi" => Some(Self::Kimi),
            "codex" => Some(Self::Codex),
            "glm" => Some(Self::Glm),
            "deepseek" => Some(Self::Deepseek),
            _ => None,
        }
    }

    pub fn spec(self) -> &'static ProviderSpec {
        match self {
            Self::Kimi => &KIMI,
            Self::Codex => &CODEX,
            Self::Glm => &GLM,
            Self::Deepseek => &DEEPSEEK,
        }
    }

    pub fn id(self) -> &'static str {
        self.spec().id
    }

    pub fn display_name(self) -> &'static str {
        self.spec().display_name
    }
}

#[derive(Clone, Debug)]
pub struct AccountProfile {
    pub provider: Provider,
    pub id: String,
    pub label: String,
    pub home: PathBuf,
    pub is_default: bool,
}

impl AccountProfile {
    pub fn membership_key(&self) -> String {
        membership_key(self.provider, &self.id)
    }
}

pub fn membership_key(provider: Provider, account_id: &str) -> String {
    let prefix = provider.spec().membership_prefix;
    if account_id == "default" {
        prefix.to_string()
    } else {
        format!("{prefix}:{account_id}")
    }
}

fn config_dir() -> PathBuf {
    local_home()
        .join(".config")
        .join("ai-usage-monitor")
}

pub fn registry_path(provider: Provider) -> PathBuf {
    if provider == Provider::Codex {
        if let Some(path) = env_value("CODEX_ACCOUNTS_PATH") {
            return PathBuf::from(path);
        }
    }
    config_dir().join(provider.spec().registry_file)
}

pub fn default_home(provider: Provider) -> PathBuf {
    let spec = provider.spec();
    if let Some(name) = spec.home_env {
        if let Some(path) = env_value(name) {
            return PathBuf::from(path);
        }
    }
    local_home().join(spec.default_dir)
}

pub fn default_profile(provider: Provider) -> AccountProfile {
    AccountProfile {
        provider: provider.spec().provider,
        id: "default".into(),
        label: "Default".into(),
        home: default_home(provider),
        is_default: true,
    }
}

fn load_registry(provider: Provider) -> Value {
    read_json(&registry_path(provider)).unwrap_or_else(|_| serde_json::json!({}))
}

fn default_label(config: &Value) -> String {
    config
        .get("default_label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Default")
        .to_string()
}

fn valid_account_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn account_id_from_label(label: &str) -> String {
    let mut id = String::new();
    for byte in label.bytes() {
        if byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-' {
            id.push(byte.to_ascii_lowercase() as char);
        } else if !id.ends_with('-') {
            id.push('-');
        }
        if id.len() >= 48 {
            break;
        }
    }
    let id = id.trim_matches('-');
    if id.is_empty() {
        "account".into()
    } else {
        id.to_string()
    }
}

fn profiles_from_config(provider: Provider, config: &Value) -> Vec<AccountProfile> {
    let mut profiles = Vec::new();
    if !config
        .get("default_removed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        profiles.push(AccountProfile {
            label: default_label(config),
            ..default_profile(provider)
        });
    }
    let Some(entries) = config.get("accounts").and_then(Value::as_array) else {
        return profiles;
    };
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id == "default"
            || !valid_account_id(id)
            || profiles.iter().any(|profile| profile.id == id)
        {
            continue;
        }
        let label = entry
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(id)
            .to_string();
        profiles.push(AccountProfile {
            provider,
            id: id.to_string(),
            label,
            home: config_dir()
                .join(format!("{}-accounts", provider.id()))
                .join(id),
            is_default: false,
        });
    }
    profiles
}

pub fn profiles(provider: Provider) -> Vec<AccountProfile> {
    profiles_from_config(provider, &load_registry(provider))
}

pub fn all_profiles() -> Vec<AccountProfile> {
    Provider::ALL
        .into_iter()
        .flat_map(profiles)
        .collect::<Vec<_>>()
}

pub fn account(provider: Provider, account_id: &str) -> Option<AccountProfile> {
    profiles(provider)
        .into_iter()
        .find(|profile| profile.id == account_id)
}

fn fallback_active(provider: Provider, config: &Value) -> Option<String> {
    profiles_from_config(provider, config)
        .first()
        .map(|profile| profile.id.clone())
}

fn effective_active(provider: Provider, config: &Value) -> Option<String> {
    let profiles = profiles_from_config(provider, config);
    if let Some(active) = config.get("active").and_then(Value::as_str) {
        if profiles.iter().any(|profile| profile.id == active) {
            return Some(active.to_string());
        }
    }
    profiles.first().map(|profile| profile.id.clone())
}

fn api_key_fields(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::Glm => &["api_key", "GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"],
        Provider::Deepseek => &["api_key", "DEEPSEEK_API_KEY"],
        _ => &[],
    }
}

fn api_key_env_names(provider: Provider) -> &'static [&'static str] {
    match provider {
        Provider::Glm => &["GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY"],
        Provider::Deepseek => &["DEEPSEEK_API_KEY"],
        _ => &[],
    }
}

fn credentials_env_name(provider: Provider) -> Option<&'static str> {
    match provider {
        Provider::Codex => Some("CODEX_AUTH_PATH"),
        Provider::Kimi => Some("KIMI_CREDENTIALS_PATH"),
        Provider::Glm => Some("GLM_CREDENTIALS_PATH"),
        Provider::Deepseek => Some("DEEPSEEK_CREDENTIALS_PATH"),
    }
}

pub fn credential_path(profile: &AccountProfile) -> Option<PathBuf> {
    let path = profile.home.join(profile.provider.spec().credential_relative);
    if !profile.is_default {
        return path.is_file().then_some(path);
    }
    match profile.provider {
        Provider::Codex => {
            if let Some(explicit) = env_value("CODEX_AUTH_PATH") {
                let explicit = PathBuf::from(explicit);
                if explicit.is_file() {
                    return Some(explicit);
                }
            }
            path.is_file().then_some(path)
        }
        Provider::Kimi => {
            if path.is_file() {
                return Some(path);
            }
            if let Some(explicit) = env_value("KIMI_CREDENTIALS_PATH") {
                let explicit = PathBuf::from(explicit);
                if explicit.is_file() {
                    return Some(explicit);
                }
            }
            for legacy in [
                local_home().join(".kimi-code").join("credentials/kimi-code.json"),
                local_home().join(".kimi").join("credentials/kimi-code.json"),
            ] {
                if legacy.is_file() {
                    return Some(legacy);
                }
            }
            None
        }
        Provider::Glm | Provider::Deepseek => {
            if let Some(explicit) = credentials_env_name(profile.provider)
                .and_then(env_value)
                .map(PathBuf::from)
            {
                return explicit.is_file().then_some(explicit);
            }
            path.is_file().then_some(path)
        }
    }
}

pub fn credentials_write_path(profile: &AccountProfile) -> PathBuf {
    if profile.is_default {
        if let Some(path) = credentials_env_name(profile.provider)
            .and_then(env_value)
            .map(PathBuf::from)
        {
            return path;
        }
    }
    profile.home.join(profile.provider.spec().credential_relative)
}

pub fn kimi_web_credential_path(profile: &AccountProfile) -> Option<PathBuf> {
    let path = profile.home.join("credentials/kimi-web.json");
    if !profile.is_default {
        return path.is_file().then_some(path);
    }
    if let Some(explicit) = env_value("KIMI_WEB_CREDENTIALS_PATH") {
        let explicit = PathBuf::from(explicit);
        if explicit.is_file() {
            return Some(explicit);
        }
    }
    if path.is_file() {
        return Some(path);
    }
    let legacy = local_home().join(".kimi-code/credentials/kimi-web.json");
    if legacy.is_file() {
        return Some(legacy);
    }
    for home in crate::settings::wsl_homes() {
        let path = home.join(".kimi-code/credentials/kimi-web.json");
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub fn glm_reset_credentials_path(profile: &AccountProfile) -> Option<PathBuf> {
    if profile.is_default {
        return Some(
            env_value("ZCODE_CREDENTIALS_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| local_home().join(".zcode/v2/credentials.json")),
        );
    }
    let config = load_registry(Provider::Glm);
    if let Some(entry) = config
        .get("accounts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(profile.id.as_str()))
    {
        for field in [
            "zcode_credentials_path",
            "glm_reset_credentials_path",
            "reset_credentials_path",
        ] {
            if let Some(path) = entry
                .get(field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(PathBuf::from(path));
            }
        }
    }
    for path in [
        profile.home.join("zcode/v2/credentials.json"),
        profile.home.join("zcode-credentials.json"),
    ] {
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

pub fn api_key(profile: &AccountProfile) -> Result<String, String> {
    let provider = profile.provider;
    if !matches!(provider, Provider::Glm | Provider::Deepseek) {
        return Err(format!("Unsupported API key provider: {}", provider.id()));
    }
    if profile.is_default {
        for name in api_key_env_names(provider) {
            if let Some(key) = env_value(name) {
                return Ok(key);
            }
        }
    }
    let display = provider.display_name();
    let path = credential_path(profile).ok_or_else(|| match provider {
        Provider::Glm if profile.is_default => "GLM_API_KEY not set; export it, write it to ~/.glm/credentials.json, or pass --glm-key".into(),
        Provider::Deepseek if profile.is_default => "DEEPSEEK_API_KEY not set; export it, write it to ~/.deepseek/credentials.json, or pass --deepseek-key".into(),
        _ => format!("{display} credentials not found for {}; configure this account's API key", profile.label),
    })?;
    let data = read_json(&path)?;
    for field in api_key_fields(provider) {
        if let Some(key) = data
            .get(*field)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Ok(key.to_string());
        }
    }
    Err(format!(
        "{display} credentials file {} is missing api_key",
        path.display()
    ))
}

pub fn credential_status(profile: &AccountProfile) -> Value {
    if profile.is_default
        && api_key_env_names(profile.provider)
            .iter()
            .any(|name| env_value(name).is_some())
    {
        return serde_json::json!({"configured": true, "source": "environment"});
    }
    let Some(path) = credential_path(profile) else {
        return serde_json::json!({"configured": false, "source": "missing"});
    };
    let source = if profile.is_default
        && credentials_env_name(profile.provider)
            .and_then(env_value)
            .map(PathBuf::from)
            .as_ref()
            == Some(&path)
    {
        "environment"
    } else {
        "file"
    };
    if !matches!(profile.provider, Provider::Glm | Provider::Deepseek) {
        return serde_json::json!({"configured": true, "source": source});
    }
    match read_json(&path) {
        Ok(data) => {
            let configured = api_key_fields(profile.provider).iter().any(|field| {
                data.get(*field)
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .is_some()
            });
            serde_json::json!({
                "configured": configured,
                "source": if configured { source } else { "missing" },
            })
        }
        Err(err) => serde_json::json!({
            "configured": false,
            "source": "invalid",
            "error": err,
        }),
    }
}

fn codex_launcher_installed() -> bool {
    let bin = local_home().join(".local").join("bin");
    if cfg!(windows) {
        bin.join("codex.cmd").is_file()
            && bin.join("codex.ps1").is_file()
            && bin.join("codex-resolve.cjs").is_file()
    } else {
        bin.join("codex").is_file() && bin.join("codex-resolve.cjs").is_file()
    }
}

fn payload_from_config(provider: Provider, config: &Value) -> Value {
    let profiles = profiles_from_config(provider, config);
    let active = config
        .get("active")
        .and_then(Value::as_str)
        .filter(|id| profiles.iter().any(|profile| profile.id == *id))
        .map(str::to_string)
        .or_else(|| profiles.first().map(|profile| profile.id.clone()));
    let accounts = profiles
        .into_iter()
        .map(|profile| {
            let status = credential_status(&profile);
            serde_json::json!({
                "id": profile.id,
                "label": profile.label,
                "is_default": profile.is_default,
                "membership_key": profile.membership_key(),
                "configured": status.get("configured").cloned().unwrap_or(Value::Bool(false)),
                "source": status.get("source").cloned().unwrap_or(Value::String("missing".into())),
                "home": profile.home.display().to_string(),
            })
        })
        .collect::<Vec<_>>();
    let mut payload = serde_json::json!({
        "ok": true,
        "provider": provider.id(),
        "active": active,
        "default_removed": config.get("default_removed").and_then(Value::as_bool).unwrap_or(false),
        "default_label": default_label(config),
        "accounts": accounts,
    });
    if provider == Provider::Codex {
        payload["launcher_installed"] = Value::Bool(codex_launcher_installed());
    }
    payload
}

pub fn accounts_payload(provider: Provider) -> Value {
    payload_from_config(provider, &load_registry(provider))
}

fn label_from_payload(payload: &Value) -> Result<String, String> {
    let label = payload
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Account label cannot be empty".to_string())?;
    if label.len() > 80 {
        return Err("Account label is too long (maximum 80 characters)".into());
    }
    Ok(label.to_string())
}

fn apply_action(provider: Provider, config: &Value, payload: &Value) -> Result<Value, String> {
    let action = payload.get("action").and_then(Value::as_str).unwrap_or("");
    let mut config = config.clone();
    if !config.is_object() {
        config = serde_json::json!({});
    }
    if !config.get("accounts").map(Value::is_array).unwrap_or(false) {
        config["accounts"] = Value::Array(Vec::new());
    }
    match action {
        "add" => {
            let label = label_from_payload(payload)?;
            let existing = profiles_from_config(provider, &config);
            let id = if let Some(id) = payload.get("id").and_then(Value::as_str) {
                if !valid_account_id(id) {
                    return Err("Invalid account id (use letters, digits, '_' or '-')".into());
                }
                id.to_string()
            } else {
                let base = account_id_from_label(&label);
                let mut generated = base.clone();
                let mut suffix = 2;
                while generated == "default"
                    || existing.iter().any(|profile| profile.id == generated)
                {
                    generated = format!("{base}-{suffix}");
                    suffix += 1;
                }
                generated
            };
            if id == "default" || existing.iter().any(|profile| profile.id == id) {
                return Err(format!("Account id is already reserved or registered: {id}"));
            }
            let had_no_active = effective_active(provider, &config).is_none();
            config["accounts"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({"id": id, "label": label}));
            if had_no_active {
                config["active"] = Value::String(id);
            }
        }
        "rename" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            let label = label_from_payload(payload)?;
            if account_from_config(provider, &config, id).is_none() {
                return Err(format!("{} account not found: {id}", provider.display_name()));
            }
            if id == "default" {
                config["default_label"] = Value::String(label);
            } else {
                let entry = config["accounts"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
                    .ok_or_else(|| format!("{} account not found: {id}", provider.display_name()))?;
                entry["label"] = Value::String(label);
            }
        }
        "remove" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            if account_from_config(provider, &config, id).is_none() {
                return Err(format!("{} account not found: {id}", provider.display_name()));
            }
            let was_active = effective_active(provider, &config).as_deref() == Some(id);
            if id == "default" {
                config["default_removed"] = Value::Bool(true);
            } else {
                config["accounts"]
                    .as_array_mut()
                    .unwrap()
                    .retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
            }
            if was_active {
                config["active"] = fallback_active(provider, &config)
                    .map(Value::String)
                    .unwrap_or(Value::Null);
            }
        }
        "restore-default" => {
            let old_active = effective_active(provider, &config);
            config["default_removed"] = Value::Bool(false);
            match old_active {
                Some(active) => config["active"] = Value::String(active),
                None => config["active"] = Value::String("default".into()),
            }
        }
        "set-active" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            if account_from_config(provider, &config, id).is_none() {
                return Err(format!("{} account not found: {id}", provider.display_name()));
            }
            config["active"] = Value::String(id.to_string());
        }
        _ => return Err(format!("Unsupported {} account action", provider.display_name())),
    }
    Ok(config)
}

fn account_from_config(provider: Provider, config: &Value, id: &str) -> Option<AccountProfile> {
    profiles_from_config(provider, config)
        .into_iter()
        .find(|profile| profile.id == id)
}

pub fn update_accounts(provider: Provider, payload: &Value) -> Result<Value, String> {
    let config = apply_action(provider, &load_registry(provider), payload)?;
    write_private_json(&registry_path(provider), &config)?;
    Ok(payload_from_config(provider, &config))
}

pub fn profile_for_membership_key(key: &str) -> Option<AccountProfile> {
    for provider in Provider::ALL {
        let prefix = provider.spec().membership_prefix;
        if key == prefix {
            return account(provider, "default");
        }
        if let Some(id) = key.strip_prefix(&format!("{prefix}:")) {
            if id != "default" {
                return account(provider, id);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn action(config: &Value, value: Value) -> Value {
        apply_action(Provider::Codex, config, &value).unwrap()
    }

    #[test]
    fn default_rename_remove_restore_and_active_fallback() {
        let mut config = action(&serde_json::json!({}), serde_json::json!({
            "action": "rename", "id": "default", "label": "Main"
        }));
        assert_eq!(config["default_label"], "Main");
        assert!(config["accounts"].as_array().unwrap().is_empty());

        config = action(&config, serde_json::json!({"action": "add", "label": "Work"}));
        config = action(&config, serde_json::json!({"action": "add", "label": "Second"}));
        config = action(&config, serde_json::json!({"action": "set-active", "id": "default"}));
        config = action(&config, serde_json::json!({"action": "remove", "id": "default"}));
        assert_eq!(config["default_removed"], true);
        assert_eq!(config["active"], "work");
        assert_eq!(profiles_from_config(Provider::Codex, &config)[0].id, "work");
        let error = apply_action(
            Provider::Codex,
            &config,
            &serde_json::json!({"action": "rename", "id": "default", "label": "Hidden"}),
        )
        .unwrap_err();
        assert!(error.contains("not found"), "removed default must not be renamed");

        config = action(&config, serde_json::json!({"action": "restore-default"}));
        assert_eq!(config["active"], "work", "restore must not replace a live active account");
        assert_eq!(config["default_label"], "Main");

        config = action(&config, serde_json::json!({"action": "set-active", "id": "work"}));
        config = action(&config, serde_json::json!({"action": "remove", "id": "work"}));
        assert_eq!(config["active"], "default");
        config = action(&config, serde_json::json!({"action": "set-active", "id": "second"}));
        config = action(&config, serde_json::json!({"action": "remove", "id": "second"}));
        assert_eq!(config["active"], "default");

        config = action(&config, serde_json::json!({"action": "remove", "id": "default"}));
        assert!(profiles_from_config(Provider::Codex, &config).is_empty());
        assert!(config["active"].is_null());
        config = action(&config, serde_json::json!({"action": "restore-default"}));
        assert_eq!(config["active"], "default");
        assert_eq!(config["default_label"], "Main");
    }

    #[test]
    fn add_reserves_default_id() {
        let config = serde_json::json!({"default_removed": true});
        let error = apply_action(
            Provider::Kimi,
            &config,
            &serde_json::json!({"action": "add", "id": "default", "label": "Other"}),
        )
        .unwrap_err();
        assert!(error.contains("reserved"));
        let added = apply_action(
            Provider::Kimi,
            &config,
            &serde_json::json!({"action": "add", "label": "Default"}),
        )
        .unwrap();
        assert_eq!(added["accounts"][0]["id"], "default-2");
    }

    #[test]
    fn membership_keys_are_isolated_for_all_providers() {
        for provider in Provider::ALL {
            let prefix = provider.spec().membership_prefix;
            assert_eq!(membership_key(provider, "default"), prefix);
            assert_eq!(membership_key(provider, "work"), format!("{prefix}:work"));
            assert_ne!(membership_key(provider, "work"), membership_key(provider, "other"));
        }
        assert_eq!(membership_key(Provider::Codex, "default"), "openai");
        assert_eq!(membership_key(Provider::Codex, "work"), "openai:work");
        assert_ne!(membership_key(Provider::Kimi, "work"), "kimi");
        assert_ne!(membership_key(Provider::Glm, "work"), "glm");
        assert_ne!(membership_key(Provider::Deepseek, "work"), "deepseek");
    }
}
