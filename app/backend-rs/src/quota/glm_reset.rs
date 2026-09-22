//! GLM Coding Plan 重置卡（ZCode 通道）。
//!
//! 重置卡只下发给「登录 ZCode 并连接 Coding Plan」的账号（官方口径），纯 API key
//! 查询拿不到，因此复用 ZCode 桌面端的本机凭证查询。任何一步失败都静默降级为
//! None，绝不影响 GLM 主配额采集。
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

use std::path::PathBuf;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::http::get_json_headers;
use super::util::{env_timeout, iso_seconds, parse_timestamp};
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
        let mut expires: Vec<i64> = data
            .get(key)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| parse_timestamp(item.get("expire_at")))
                    .map(|at| at.timestamp())
                    .collect()
            })
            .unwrap_or_default();
        expires.retain(|at| *at > now.timestamp());
        expires.sort_unstable();
        expires
            .into_iter()
            .map(|at| {
                let moment = Utc
                    .timestamp_opt(at, 0)
                    .single()
                    .map(|m| iso_seconds(m.with_timezone(&Local)));
                serde_json::json!({
                    "expire_at": moment,
                    "expire_after_seconds": at - now.timestamp(),
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

/// 查询重置卡状态；无 ZCode 凭证 / 解密失败 / 接口异常均返回 None（静默跳过）。
pub fn collect_reset_cards() -> Option<Value> {
    if !env_enabled("GLM_RESET_CARDS", true) {
        return None;
    }
    let path = env_value("ZCODE_CREDENTIALS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| local_home().join(".zcode").join("v2").join("credentials.json"));
    let creds = crate::settings::read_json(&path).ok()?;
    let key = cipher_key();
    let jwt = credential_value(&creds, "zcodejwttoken", &key)?;
    let maas = credential_value(&creds, "oauth:bigmodel:access_token", &key)?;
    let url = env_value("GLM_RESET_URL").unwrap_or_else(|| RESET_STATUS_URL.into());
    let use_proxy = env_enabled("GLM_USE_PROXY", true);
    let timeout = env_timeout("GLM_RESET_TIMEOUT", 8);
    let authorization = format!("Bearer {jwt}");
    let response = get_json_headers(
        &url,
        &[
            ("Authorization", authorization.as_str()),
            ("X-Bigmodel-Authorization", maas.as_str()),
            ("Bigmodel-Target-Type", "PERSONAL"),
            ("User-Agent", "ZCode/3.11.2"),
        ],
        use_proxy,
        timeout,
    )
    .ok()?;
    if response.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return None;
    }
    let data = response.get("data").filter(|v| v.is_object())?;
    Some(normalize_reset_status(data, Local::now()))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(decrypt_value(&key, &packed).as_deref(), Some("secret-token"));
        // 密钥不符 / 非密文 / 段数错误均拒绝
        assert_eq!(decrypt_value(&[8u8; 32], &packed), None);
        assert_eq!(decrypt_value(&key, "plain-text"), None);
        assert_eq!(decrypt_value(&key, "enc:v1:only.two"), None);
    }
}
