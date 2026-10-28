//! 四家配额采集引擎（v0.6.1 起原生实现，口径与原 Python 实现一致）。
//!
//! - Kimi / Codex：本地 OAuth 凭证发现与用量接口（Kimi 支持到期刷新）
//! - DeepSeek / GLM：API key 直连（deepseek.rs / glm.rs）
//! - 共享：http.rs（ureq agent、代理、重试与错误映射）、util.rs（JSON 数值与
//!   时间解析、窗口归一化）、membership.rs（会员到期手动配置）
//!
//! 代理语义与 Python 版相同：GLM/DeepSeek/Codex 默认走系统代理
//!（HTTP(S)_PROXY / ALL_PROXY，缺失时回退 Windows 注册表设置），可用对应
//! *_USE_PROXY=0 关闭；Kimi 默认不走。GET 重试 3 次（退避 1s/2s，timeout 为总预算——见 http.rs），POST 不重试；
//! 四家全部可见 profile 并发采集（总耗时 = 最慢账号而非串行求和）。

use std::path::Path;

use serde_json::Value;

use crate::accounts::{AccountProfile, Provider};

mod codex;
mod codex_appserver;
mod deepseek;
mod glm;
mod glm_reset;
mod http;
mod kimi;
// settings::membership_settings 也复用归一化逻辑，需对 crate 可见
pub(crate) mod membership;
mod util;
mod zcode_plan;

pub use http::build_agent;
// 重置触发接口：/api/quota/reset/* 路由调用（失败原因透传前端）
pub use codex::{
    consume_reset_credit as consume_codex_reset_credit,
    invalidate_retry_state as invalidate_codex_retry_state,
};
// 轮次失败窗口测试（进程内静态状态，仅 quota_tests 按序触达）
#[cfg(test)]
pub(crate) use codex::{apply_retry_window_at, WindowOutcome};
pub use glm_reset::use_reset_card as use_glm_reset_card;
// 归一化函数供 quota_tests 调用（release 构建中 crate 内未直接引用）
#[cfg(test)]
pub use codex::normalize_codex;
#[cfg(test)]
pub use codex_appserver::to_wham_shape;
#[cfg(test)]
pub use deepseek::normalize_deepseek;
#[cfg(test)]
pub use glm::{normalize_glm, normalize_glm_subscription};
#[cfg(test)]
pub use glm_reset::normalize_reset_status;
#[cfg(test)]
pub use kimi::{collect as collect_kimi_profile, normalize_kimi};
#[cfg(test)]
pub use zcode_plan::normalize_start_plan;

/// 刷新后的凭证回写失败不阻断本次查询，仅记录。
fn write_credentials(path: &Path, value: &Value) {
    if let Err(err) = crate::settings::write_private_json(path, value) {
        eprintln!(
            "[quota] cannot persist credentials {}: {err}",
            path.display()
        );
    }
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
fn account_error(provider: &str, profile: &AccountProfile, error: String) -> Value {
    serde_json::json!({
        "provider": provider,
        "account_id": profile.id,
        "account_label": profile.label,
        "error": error,
    })
}

fn collect_profile(profile: &AccountProfile) -> (Vec<Value>, Vec<Value>) {
    match profile.provider {
        Provider::Kimi => {
            let mut errors = Vec::new();
            let accounts = kimi::collect(profile, &mut errors)
                .map(|account| vec![account])
                .unwrap_or_default();
            (accounts, errors)
        }
        Provider::Codex => {
            let mut errors = Vec::new();
            let accounts = codex::collect(profile, &mut errors)
                .map(|account| vec![account])
                .unwrap_or_default();
            (accounts, errors)
        }
        Provider::Glm => match glm::collect(profile) {
            Ok(account) => (vec![account], Vec::new()),
            Err(err) => (
                Vec::new(),
                vec![account_error(profile.provider.display_name(), profile, err)],
            ),
        },
        Provider::Deepseek => match deepseek::collect(profile) {
            Ok(account) => (vec![account], Vec::new()),
            Err(err) => (
                Vec::new(),
                vec![account_error(profile.provider.display_name(), profile, err)],
            ),
        },
    }
}

pub fn collect_all() -> (Vec<Value>, Vec<Value>) {
    const COLLECT_DEADLINE_SECS: u64 = 45;
    let profiles = crate::accounts::all_profiles();
    let expected = profiles.len();
    let (tx, rx) = std::sync::mpsc::channel::<(
        (Provider, String),
        Vec<Value>,
        Vec<Value>,
    )>();

    for profile in profiles.iter().cloned() {
        let tx = tx.clone();
        std::thread::spawn(move || {
            let tag = (profile.provider, profile.id.clone());
            let (mut accounts, mut errors) = collect_profile(&profile);
            for value in accounts.iter_mut().chain(errors.iter_mut()) {
                value["account_id"] = Value::String(profile.id.clone());
                value["account_label"] = Value::String(profile.label.clone());
            }
            let _ = tx.send((tag, accounts, errors));
        });
    }
    drop(tx);

    let mut slots: std::collections::HashMap<
        (Provider, String),
        (Vec<Value>, Vec<Value>),
    > = std::collections::HashMap::new();
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_secs(COLLECT_DEADLINE_SECS);
    while slots.len() < expected {
        let wait = deadline.saturating_duration_since(std::time::Instant::now());
        if wait.is_zero() {
            break;
        }
        match rx.recv_timeout(wait) {
            Ok((tag, accounts, errors)) => {
                slots.insert(tag, (accounts, errors));
            }
            Err(_) => break,
        }
    }

    let mut accounts = Vec::new();
    let mut errors = Vec::new();
    for profile in &profiles {
        let tag = (profile.provider, profile.id.clone());
        match slots.remove(&tag) {
            Some((profile_accounts, profile_errors)) => {
                accounts.extend(profile_accounts);
                errors.extend(profile_errors);
            }
            None => errors.push(account_error(
                profile.provider.display_name(),
                profile,
                "query timed out (slow network or proxy); retrying next round".into(),
            )),
        }
    }

    let with_account: std::collections::HashSet<(String, String)> = accounts
        .iter()
        .map(|account| {
            (
                account
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                account
                    .get("account_id")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    .to_string(),
            )
        })
        .collect();
    let mut seen = std::collections::HashSet::new();
    errors.retain(|error| {
        let identity = (
            error
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            error
                .get("account_id")
                .and_then(Value::as_str)
                .unwrap_or("default")
                .to_string(),
        );
        !with_account.contains(&identity) && seen.insert(identity)
    });
    (accounts, errors)
}
