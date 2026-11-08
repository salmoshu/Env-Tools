//! GLM Coding Plan 重置卡（ZCode 通道）。
//!
//! 重置卡只下发给「登录 ZCode 并连接 Coding Plan」的账号（官方口径），纯 API key
//! 查询拿不到。默认 GLM 账号沿用 ZCode 本机凭证；额外账号必须有独立绑定，
//! 绝不回退默认凭证。状态查询失败静默降级，不影响 GLM 主配额采集。
//!
//! 接口（逆向自 ZCode 客户端 BigModelUsageQuotaProvider）：
//!   GET https://zcode.z.ai/api/v1/coding-plan/reset/status
//!   Authorization: Bearer <zcodejwttoken>
//!   X-Bigmodel-Authorization: <oauth:bigmodel:access_token>
//!   Bigmodel-Target-Type: PERSONAL
//!
//! 凭证文件 ~/.zcode/v2/credentials.json 的敏感值可加密存放：
//!   enc:v1:<iv>.<authtag>.<cipher>（base64url 无填充，AES-256-GCM）
//!   密钥 = sha256(ZCODE_CREDENTIAL_SECRET，缺省时
//!          "zcode-credential-fallback:<Node 平台名>:<家目录>:<用户名>")

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::http::{get_json_headers, post_json};
use super::util::{env_timeout, iso_seconds, parse_timestamp};
use crate::accounts::AccountProfile;
use crate::settings::{env_enabled, env_value, local_home};

const RESET_STATUS_URL: &str = "https://zcode.z.ai/api/v1/coding-plan/reset/status";
const ENC_PREFIX: &str = "enc:v1:";

/// Node process.platform 取值：密钥派生串的一部分，必须与 ZCode 完全一致。
fn node_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// Node os.homedir() 语义：Windows 取 USERPROFILE，POSIX 取 HOME。
fn node_home() -> String {
    let primary = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(primary)
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| local_home().to_string_lossy().into_owned())
}

/// Node os.userInfo().username 的常规环境来源。
fn node_username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .ok()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

fn cipher_key() -> [u8; 32] {
    let secret = env_value("ZCODE_CREDENTIAL_SECRET").unwrap_or_else(|| {
        format!(
            "zcode-credential-fallback:{}:{}:{}",
            node_platform(),
            node_home(),
            node_username()
        )
    });
    let digest = Sha256::digest(secret.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

/// base64url（无填充）解码；出现填充或非法字符即失败。
fn b64url_decode(text: &str) -> Option<Vec<u8>> {
    let mut table = [0xffu8; 256];
    for (i, b) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        .iter()
        .enumerate()
    {
        table[*b as usize] = i as u8;
    }
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &b in text.as_bytes() {
        let v = table[b as usize];
        if v == 0xff {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}

/// 解密 enc:v1 密文；格式/长度/MAC 任一不符返回 None。
fn decrypt_value(key: &[u8; 32], value: &str) -> Option<String> {
    let body = value.strip_prefix(ENC_PREFIX)?;
    let mut parts = body.split('.');
    let iv = b64url_decode(parts.next()?)?;
    let tag = b64url_decode(parts.next()?)?;
    let mut cipher = b64url_decode(parts.next()?)?;
    if parts.next().is_some() || iv.len() != 12 || tag.len() != 16 {
        return None;
    }
    cipher.extend_from_slice(&tag); // RustCrypto aead 约定 tag 尾随密文
    let aead = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let plain = aead.decrypt(Nonce::from_slice(&iv), cipher.as_ref()).ok()?;
    String::from_utf8(plain).ok()
}

/// 读取一个凭证字段：enc:v1 则解密，明文（旧版 ZCode）原样返回。
fn credential_value(creds: &Value, name: &str, key: &[u8; 32]) -> Option<String> {
    let raw = creds.get(name)?.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with(ENC_PREFIX) {
        decrypt_value(key, raw)
    } else {
        Some(raw.into())
    }
}

/// 响应归一化：丢弃已过期卡片、按到期升序；时间戳入参为毫秒 epoch。
pub fn normalize_reset_status(data: &Value, now: DateTime<Local>) -> Value {
    let cards_of = |key: &str| -> Vec<Value> {
        let mut expires: Vec<Option<i64>> = data
            .get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| match parse_timestamp(item.get("expire_at")) {
                        Some(at) if at.timestamp() <= now.timestamp() => None,
                        at => Some(at.map(|at| at.timestamp())),
                    })
                    .collect()
            })
            .unwrap_or_default();
        expires.sort_unstable_by_key(|at| at.unwrap_or(i64::MAX));
        expires
            .into_iter()
            .map(|at| {
                let moment = at.and_then(|at| Utc.timestamp_opt(at, 0)
                    .single()
                    .map(|m| iso_seconds(m.with_timezone(&Local))));
                serde_json::json!({
                    "expire_at": moment,
                    "expire_after_seconds": at.map(|at| at - now.timestamp()),
                })
            })
            .collect()
    };
    let used_of = |key: &str| -> Value {
        data.get(key)
            .and_then(|history| parse_timestamp(history.get("used_at")))
            .map(|at| Value::from(iso_seconds(at.with_timezone(&Local))))
            .unwrap_or(Value::Null)
    };
    serde_json::json!({
        "five_hour": cards_of("available_five_hour_resets"),
        "week": cards_of("available_week_resets"),
        "latest_five_hour_used_at": used_of("latest_five_hour_reset_history"),
        "latest_week_used_at": used_of("latest_week_reset_history"),
        "has_unread_history": data.get("has_unread_history").and_then(|v| v.as_bool()).unwrap_or(false),
    })
}

fn reset_cache_path(profile: &AccountProfile, jwt: &str, maas: &str) -> std::path::PathBuf {
    // API key 对应实际 GLM 账号，续期 ZCode token 不改变缓存身份；仅重置授权的
    // 账号无 API key 时按授权摘要隔离。显式绑定路径变化也不沿用旧绑定的卡片。
    let identity = crate::accounts::api_key(profile).unwrap_or_else(|_| format!("{jwt}:{maas}"));
    let binding = crate::accounts::glm_reset_credentials_path(profile);
    let material = serde_json::json!([profile.id, identity, binding]).to_string();
    super::reset_cache::path("glm", &super::reset_cache::key(&material))
}

fn cached_reset_status(data: Option<&Value>, previous: &Value, now: DateTime<Local>) -> Option<Value> {
    if data.is_none() && !previous.is_object() {
        return None;
    }
    let mut merged = data.cloned().unwrap_or_else(|| serde_json::json!({}));
    for (raw_key, key) in [("available_five_hour_resets", "five_hour"), ("available_week_resets", "week")] {
        let cached: Vec<Value> = previous[key].as_array().into_iter().flatten()
            .filter(|card| parse_timestamp(card.get("expire_at")).is_some_and(|at| at > now))
            .cloned().collect();
        match merged.get_mut(raw_key).and_then(Value::as_array_mut) {
            Some(current) if previous[key].as_array().is_some_and(|old| old.len() == current.len()) => {
                // 接口可能调整排列顺序，按已知日期逐个匹配，保留相同日期的多张卡。
                let mut remaining = cached;
                let compatible = current.iter().filter_map(|card| parse_timestamp(card.get("expire_at")))
                    .filter(|at| *at > now).all(|at| {
                        if let Some(index) = remaining.iter().position(|card| parse_timestamp(card.get("expire_at")) == Some(at)) {
                            remaining.remove(index);
                            true
                        } else { false }
                    });
                if compatible {
                    let mut old_dates = remaining.iter();
                    for card in current.iter_mut().filter(|card| parse_timestamp(card.get("expire_at")).is_none()) {
                        if let Some(old) = old_dates.next().filter(|_| card.is_object()) {
                            card["expire_at"] = old["expire_at"].clone();
                        }
                    }
                }
            }
            Some(_) => {}, // 包含明确的空数组：确认为已用完，不恢复旧卡。
            None => { merged[raw_key] = Value::Array(cached); }
        }
    }
    let mut result = normalize_reset_status(&merged, now);
    if data.is_none() || data.is_some_and(|data| {
        ["available_five_hour_resets", "available_week_resets"].iter()
            .any(|key| data.get(*key).and_then(Value::as_array).is_none())
    }) {
        result["stale"] = Value::Bool(true);
    }
    for (raw_key, key) in [("latest_five_hour_reset_history", "latest_five_hour_used_at"),
        ("latest_week_reset_history", "latest_week_used_at")] {
        if merged.get(raw_key).is_none() && !previous[key].is_null() {
            result[key] = previous[key].clone();
        }
    }
    Some(result)
}

pub(crate) fn load_zcode_credentials(profile: &AccountProfile) -> Option<(String, String)> {
    let path = crate::accounts::glm_reset_credentials_path(profile)?;
    let creds = crate::settings::read_json(&path).ok()?;
    let key = cipher_key();
    let jwt = credential_value(&creds, "zcodejwttoken", &key)?;
    let maas = credential_value(&creds, "oauth:bigmodel:access_token", &key)?;
    Some((jwt, maas))
}

/// 状态接口地址（env 可覆盖）。
fn reset_status_url() -> String {
    env_value("GLM_RESET_URL").unwrap_or_else(|| RESET_STATUS_URL.into())
}

/// 触发接口地址：由状态地址推导（去尾部 /status 换 /use，与 ZCode 一致）。
fn reset_use_url() -> String {
    let base = reset_status_url();
    let base = base.trim_end_matches('/');
    match base.strip_suffix("/status") {
        Some(stem) => format!("{stem}/use"),
        None => format!("{base}/use"),
    }
}

/// ZCode 重置接口的公共请求头（status / use 一致，逆向自 ZCode 客户端）。
pub(crate) fn zcode_headers(jwt: &str, maas: &str) -> [(String, String); 4] {
    [
        ("Authorization".to_string(), format!("Bearer {jwt}")),
        ("X-Bigmodel-Authorization".to_string(), maas.to_string()),
        ("Bigmodel-Target-Type".to_string(), "PERSONAL".to_string()),
        ("User-Agent".to_string(), "ZCode/3.11.2".to_string()),
    ]
}

/// 查询失败或日期缺失时沿用缓存；无独立绑定、解密失败或禁用时仍跳过。
pub fn collect_reset_cards(profile: &AccountProfile) -> Option<Value> {
    if !env_enabled("GLM_RESET_CARDS", true) {
        return None;
    }
    let (jwt, maas) = load_zcode_credentials(profile)?;
    let use_proxy = env_enabled("GLM_USE_PROXY", true);
    let timeout = env_timeout("GLM_RESET_TIMEOUT", 8);
    let headers = zcode_headers(&jwt, &maas);
    let refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    let response = get_json_headers(&reset_status_url(), &refs, use_proxy, timeout).ok();
    let data = response.as_ref().filter(|response| response["code"].as_i64() == Some(0))
        .and_then(|response| response.get("data")).filter(|data| data.is_object());
    super::reset_cache::update(&reset_cache_path(profile, &jwt, &maas), |previous| {
        cached_reset_status(data, previous, Local::now())
    })
}

/// 使用一张重置卡（POST {base}/use，逆向自 ZCode useCodingPlanReset）。
/// reset_type 仅接受 FIVE_HOUR / WEEK；与状态查询的静默降级不同，这里把
/// 失败原因透传给前端展示。幂等键一次一换，服务端按 key 去重。
pub fn use_reset_card(account_id: &str, reset_type: &str) -> Result<Value, String> {
    let profile = crate::accounts::account(crate::accounts::Provider::Glm, account_id)
        .ok_or_else(|| format!("GLM account not found: {account_id}"))?;
    let reset_type = match reset_type.trim().to_ascii_uppercase().as_str() {
        "FIVE_HOUR" | "5H" => "FIVE_HOUR",
        "WEEK" | "7D" => "WEEK",
        other => return Err(format!("invalid reset_type: {other}")),
    };
    if !env_enabled("GLM_RESET_CARDS", true) {
        return Err("GLM reset cards disabled (GLM_RESET_CARDS=0)".into());
    }
    if !profile.is_default && crate::accounts::glm_reset_credentials_path(&profile).is_none() {
        return Err(format!(
            "GLM reset cards are not independently bound to account {account_id}; set zcode_credentials_path for this profile"
        ));
    }
    let (jwt, maas) = load_zcode_credentials(&profile).ok_or_else(|| {
        if profile.is_default {
            "ZCode credentials unavailable; open ZCode once and retry".to_string()
        } else {
            format!("ZCode credentials unavailable for GLM account {account_id}")
        }
    })?;
    let use_proxy = env_enabled("GLM_USE_PROXY", true);
    let timeout = env_timeout("GLM_RESET_TIMEOUT", 8);
    let headers = zcode_headers(&jwt, &maas);
    let mut refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    refs.push(("Content-Type", "application/json"));
    let body = serde_json::json!({
        "idempotency_key": super::util::random_token(),
        "reset_type": reset_type,
    })
    .to_string();
    let response = post_json(&reset_use_url(), &refs, &body, use_proxy, timeout)?;
    if response.get("code").and_then(|v| v.as_i64()) != Some(0) {
        let msg = response
            .get("msg")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown error");
        return Err(format!("GLM reset rejected: {msg}"));
    }
    let used = response
        .get("data")
        .and_then(|d| d.get("used"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !used {
        return Err("GLM reset not confirmed by server".into());
    }
    // 消耗成功后立即失效对应类型，后续状态接口暂时失败也不复活已用过的卡。
    clear_used_cards(&reset_cache_path(&profile, &jwt, &maas), reset_type);
    Ok(serde_json::json!({
        "used": true,
        "reset_type": reset_type,
        "account_id": profile.id,
    }))
}

fn clear_used_cards(path: &std::path::Path, reset_type: &str) {
    super::reset_cache::update(path, |previous| {
        if !previous.is_object() { return None; }
        let mut updated = previous.clone();
        updated[if reset_type == "FIVE_HOUR" { "five_hour" } else { "week" }] = serde_json::json!([]);
        Some(updated)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::reset_cache::{self, TestCache};
    use serde_json::json;

    fn cached_cards() -> Value {
        let now = Local.timestamp_opt(1_800_000_000, 0).unwrap();
        normalize_reset_status(&json!({
            "available_five_hour_resets": [{"expire_at": 1_800_000_100_000i64}, {"expire_at": 1_800_000_200_000i64}],
            "available_week_resets": [{"expire_at": 1_800_000_300_000i64}],
        }), now)
    }

    #[test]
    fn glm_cards_survive_failed_query_and_reload_with_absolute_expiry() {
        let file = TestCache::new();
        reset_cache::update(&file.0, |_| Some(cached_cards()));
        let now = Local.timestamp_opt(1_800_000_050, 0).unwrap();
        let restored = reset_cache::update(&file.0, |previous| cached_reset_status(None, previous, now)).unwrap();
        assert_eq!(restored["five_hour"].as_array().unwrap().len(), 2);
        assert_eq!(restored["week"].as_array().unwrap().len(), 1);
        assert_eq!(restored["five_hour"][0]["expire_after_seconds"], 50);
        assert_eq!(restored["stale"], true);
        let later = cached_reset_status(None, &restored, now + chrono::Duration::seconds(160)).unwrap();
        assert!(later["five_hour"].as_array().unwrap().is_empty());
        assert_eq!(later["week"][0]["expire_after_seconds"], 90);
    }

    #[test]
    fn glm_missing_dates_reuse_matching_cards_after_reordering() {
        let now = Local.timestamp_opt(1_800_000_000, 0).unwrap();
        let result = cached_reset_status(Some(&json!({
            "available_five_hour_resets": [{"expire_at": 1_800_000_200_000i64}, {"expire_at": null}],
            "available_week_resets": [{"expire_at": null}],
        })), &cached_cards(), now).unwrap();
        assert_eq!(result["five_hour"][0]["expire_after_seconds"], 100);
        assert_eq!(result["five_hour"][1]["expire_after_seconds"], 200);
        assert_eq!(result["week"][0]["expire_after_seconds"], 300);
        assert!(result.get("stale").is_none());
    }

    #[test]
    fn glm_new_dates_and_explicit_empty_lists_replace_cached_cards() {
        let now = Local.timestamp_opt(1_800_000_000, 0).unwrap();
        let result = cached_reset_status(Some(&json!({
            "available_five_hour_resets": [],
            "available_week_resets": [{"expire_at": 1_800_000_400_000i64}],
        })), &cached_cards(), now).unwrap();
        assert!(result["five_hour"].as_array().unwrap().is_empty());
        assert_eq!(result["week"][0]["expire_after_seconds"], 400);
        let unknown = cached_reset_status(Some(&json!({
            "available_five_hour_resets": [{"expire_at": null}],
        })), &cached_cards(), now).unwrap();
        assert_eq!(unknown["five_hour"].as_array().unwrap().len(), 1);
        assert!(unknown["five_hour"][0]["expire_at"].is_null());
        assert_eq!(unknown["week"][0]["expire_after_seconds"], 300);
    }

    #[test]
    fn glm_consumed_type_stays_empty_on_subsequent_query_failure() {
        let file = TestCache::new();
        reset_cache::update(&file.0, |_| Some(cached_cards()));
        clear_used_cards(&file.0, "FIVE_HOUR");
        let now = Local.timestamp_opt(1_800_000_000, 0).unwrap();
        let restored = reset_cache::update(&file.0, |previous| cached_reset_status(None, previous, now)).unwrap();
        assert!(restored["five_hour"].as_array().unwrap().is_empty());
        assert_eq!(restored["week"].as_array().unwrap().len(), 1);
        clear_used_cards(&file.0, "WEEK");
        let empty = reset_cache::update(&file.0, |previous| cached_reset_status(None, previous, now)).unwrap();
        assert!(empty["week"].as_array().unwrap().is_empty());
        assert!(cached_reset_status(None, &Value::Null, now).is_none());
    }

    #[test]
    fn reset_cache_provider_and_identity_paths_are_distinct() {
        let first = reset_cache::key("first-account");
        let second = reset_cache::key("second-account");
        assert_ne!(reset_cache::path("glm", &first), reset_cache::path("codex", &first));
        assert_ne!(reset_cache::path("glm", &first), reset_cache::path("glm", &second));
    }

    fn b64url_encode(bytes: &[u8]) -> String {
        const A: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let acc = (b0 << 16) | (b1 << 8) | b2;
            out.push(A[((acc >> 18) & 63) as usize] as char);
            out.push(A[((acc >> 12) & 63) as usize] as char);
            if chunk.len() > 1 {
                out.push(A[((acc >> 6) & 63) as usize] as char);
            }
            if chunk.len() > 2 {
                out.push(A[(acc & 63) as usize] as char);
            }
        }
        out
    }

    #[test]
    fn b64url_decode_ok_and_rejects_bad_input() {
        assert_eq!(b64url_decode("aGVsbG8").unwrap(), b"hello");
        assert_eq!(b64url_decode("dGVzdA").unwrap(), b"test");
        assert!(b64url_decode("aGVsbG8=").is_none());
        assert!(b64url_decode("aGVsbG8!").is_none());
    }

    #[test]
    fn decrypt_roundtrip_with_known_key() {
        let key = [7u8; 32];
        let aead = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
        let iv = [1u8; 12];
        let sealed = aead
            .encrypt(Nonce::from_slice(&iv), b"secret-token".as_ref())
            .unwrap();
        let (cipher, tag) = sealed.split_at(sealed.len() - 16);
        let packed = format!(
            "enc:v1:{}.{}.{}",
            b64url_encode(&iv),
            b64url_encode(tag),
            b64url_encode(cipher)
        );
        assert_eq!(
            decrypt_value(&key, &packed).as_deref(),
            Some("secret-token")
        );
        // 密钥不符 / 非密文 / 段数错误均拒绝
        assert_eq!(decrypt_value(&[8u8; 32], &packed), None);
        assert_eq!(decrypt_value(&key, "plain-text"), None);
        assert_eq!(decrypt_value(&key, "enc:v1:only.two"), None);
    }
}
