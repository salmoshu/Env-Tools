//! 四家配额采集引擎（v0.6.1 起原生实现，口径与原 Python 实现一致）。
//!
//! - Kimi / Codex：本地 OAuth 凭证发现 + 到期刷新 + 用量接口（kimi.rs / codex.rs）
//! - DeepSeek / GLM：API key 直连（deepseek.rs / glm.rs）
//! - 共享：http.rs（ureq agent、代理、重试与错误映射）、util.rs（JSON 数值与
//!   时间解析、窗口归一化）、membership.rs（会员到期手动配置）
//!
//! 代理语义与 Python 版相同：GLM/DeepSeek/Codex 默认走系统代理
//!（HTTP(S)_PROXY / ALL_PROXY，缺失时回退 Windows 注册表设置），可用对应
//! *_USE_PROXY=0 关闭；Kimi 默认不走。GET 重试 3 次（退避 1s/2s，timeout 为总预算——见 http.rs），POST 不重试；
//! v0.7.30 起四家并发采集（总耗时 = 最慢单家而非串行求和）。

use std::path::{Path, PathBuf};

use serde_json::Value;

mod codex;
mod deepseek;
mod glm;
mod glm_reset;
mod http;
mod kimi;
// settings::membership_settings 也复用归一化逻辑，需对 crate 可见
pub(crate) mod membership;
mod util;

pub use http::build_agent;
// 重置触发接口：/api/quota/reset/* 路由调用（失败原因透传前端）
pub use codex::consume_reset_credit as consume_codex_reset_credit;
// 轮次失败窗口测试（进程内静态状态，仅 quota_tests 按序触达）
#[cfg(test)]
pub(crate) use codex::{apply_retry_window, apply_retry_window_at, WindowOutcome};
pub use glm_reset::use_reset_card as use_glm_reset_card;
// 归一化函数供 quota_tests 调用（release 构建中 crate 内未直接引用）
#[cfg(test)]
pub use codex::normalize_codex;
#[cfg(test)]
pub use deepseek::normalize_deepseek;
#[cfg(test)]
pub use glm::{normalize_glm, normalize_glm_subscription};
#[cfg(test)]
pub use glm_reset::normalize_reset_status;
#[cfg(test)]
pub use kimi::normalize_kimi;

/// 凭证家目录（v0.7.1 起仅本机侧：配额不再跨 WSL 读取，避免 9P 慢与串源）。
/// 分析数据仍可跨源汇总（见 /api/analytics 的 aggregate 参数）。
fn credential_homes() -> Vec<PathBuf> {
    vec![crate::settings::local_home()]
}

/// 在多个家目录下按相对路径找第一个存在的文件；env_name 可显式指定全路径。
fn find_file_across_homes(
    homes: &[PathBuf],
    relatives: &[&str],
    env_name: &str,
) -> Option<PathBuf> {
    if let Some(explicit) = crate::settings::env_value(env_name) {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    for home in homes {
        for relative in relatives {
            let path = home.join(relative);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

/// 刷新后的凭证回写失败不阻断本次查询，仅记录。
fn write_credentials(path: &Path, value: &Value) {
    if let Err(err) = crate::settings::write_private_json(path, value) {
        eprintln!(
            "[quota] cannot persist credentials {}: {err}",
            path.display()
        );
    }
}

/// 从 credentials.json 提取 API key（DeepSeek/GLM 共用，字段优先级同 Python）。
fn api_key_from_file(path: &Path, provider: &str, fields: &[&str]) -> Result<String, String> {
    let text = std::fs::read_to_string(path).map_err(|err| {
        format!(
            "Cannot read {provider} credentials file {}: {err}",
            path.display()
        )
    })?;
    let data: Value = serde_json::from_str(&text).map_err(|err| {
        format!(
            "Cannot read {provider} credentials file {}: {err}",
            path.display()
        )
    })?;
    for field in fields {
        if let Some(key) = data.get(*field).and_then(|v| v.as_str()) {
            return Ok(key.to_string());
        }
    }
    Err(format!(
        "{provider} credentials file {} is missing api_key",
        path.display()
    ))
}

/// 全量配额采集：Kimi/Codex/DeepSeek/GLM 四家全原生，凭证仅本机侧发现
///（Kimi 网页凭证例外，见 kimi.rs）。返回 (accounts, errors)；versions 由调用方附加。
///
/// v0.7.30 起四家**并发**采集 + 45s 看门狗：原串行实现把各家的超时/重试
/// 耗时累加（最坏数百秒），代理故障期 /api/usage 会超过 electron 侧整体
/// 超时被中断——前端只拿到"配额不可用"，逐家降级（含 codex 失败窗口）
/// 全部失效。并发后总耗时 = 最慢单家（各家预算 ≤40s），看门狗兜底极端
/// 环境：超时家本轮回错误条目，慢线程的迟到结果仍会更新自身状态
///（codex 窗口）供下轮使用。
pub fn collect_all() -> (Vec<Value>, Vec<Value>) {
    const COLLECT_DEADLINE_SECS: u64 = 45;
    let homes = credential_homes();
    let (tx, rx) = std::sync::mpsc::channel::<(&'static str, Vec<Value>, Vec<Value>)>();

    let kimi_homes = homes.clone();
    let kimi_tx = tx.clone();
    std::thread::spawn(move || {
        let mut errors = Vec::new();
        let accounts = kimi::collect(&kimi_homes, &mut errors)
            .map(|account| vec![account])
            .unwrap_or_default();
        let _ = kimi_tx.send(("kimi", accounts, errors));
    });
    let codex_homes = homes;
    let codex_tx = tx.clone();
    std::thread::spawn(move || {
        let mut errors = Vec::new();
        let accounts = codex::collect(&codex_homes, &mut errors)
            .map(|account| vec![account])
            .unwrap_or_default();
        let _ = codex_tx.send(("codex", accounts, errors));
    });
    let deepseek_tx = tx.clone();
    std::thread::spawn(move || {
        let (accounts, errors) = match deepseek::collect() {
            Ok(account) => (vec![account], Vec::new()),
            Err(err) => (
                Vec::new(),
                vec![serde_json::json!({ "provider": "DeepSeek", "error": err })],
            ),
        };
        let _ = deepseek_tx.send(("deepseek", accounts, errors));
    });
    let glm_tx = tx;
    std::thread::spawn(move || {
        let (accounts, errors) = match glm::collect() {
            Ok(account) => (vec![account], Vec::new()),
            Err(err) => (
                Vec::new(),
                vec![serde_json::json!({ "provider": "GLM", "error": err })],
            ),
        };
        let _ = glm_tx.send(("glm", accounts, errors));
    });

    let mut slots: std::collections::HashMap<&'static str, (Vec<Value>, Vec<Value>)> =
        std::collections::HashMap::new();
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(COLLECT_DEADLINE_SECS);
    while slots.len() < 4 {
        let wait = deadline.saturating_duration_since(std::time::Instant::now());
        if wait.is_zero() {
            break;
        }
        match rx.recv_timeout(wait) {
            Ok((tag, accounts, errors)) => {
                slots.insert(tag, (accounts, errors));
            }
            Err(_) => break, // 超时或全部发送端结束
        }
    }

    let mut accounts: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();
    for (tag, provider) in [
        ("kimi", "Kimi Code"),
        ("codex", "OpenAI Codex"),
        ("deepseek", "DeepSeek"),
        ("glm", "GLM"),
    ] {
        match slots.remove(tag) {
            Some((provider_accounts, provider_errors)) => {
                accounts.extend(provider_accounts);
                errors.extend(provider_errors);
            }
            None => {
                errors.push(serde_json::json!({
                    "provider": provider,
                    "error": "query timed out (slow network or proxy); retrying next round",
                }));
            }
        }
    }

    // 缺凭证静默返回的兜底（原语义）：无账号卡也无错误条目时补一条可读错误
    for (provider, hint) in [
        ("Kimi Code", "Kimi credentials not found; run kimi and log in again"),
        ("OpenAI Codex", "Codex credentials not found; run `codex login`"),
    ] {
        let has_account = accounts
            .iter()
            .any(|a| a.get("provider").and_then(|v| v.as_str()) == Some(provider));
        let has_error = errors
            .iter()
            .any(|e| e.get("provider").and_then(|v| v.as_str()) == Some(provider));
        if !has_account && !has_error {
            errors.push(serde_json::json!({ "provider": provider, "error": hint }));
        }
    }

    // 一个 provider 只出一张卡的兜底：已有账号卡片时丢弃其错误条目，
    // 防止任何路径同时产出账号与错误导致前端双卡
    let with_account: std::collections::HashSet<String> = accounts
        .iter()
        .filter_map(|a| a.get("provider").and_then(|v| v.as_str()).map(String::from))
        .collect();
    errors.retain(|e| {
        !with_account.contains(e.get("provider").and_then(|v| v.as_str()).unwrap_or(""))
    });
    (accounts, errors)
}
