//! 四家配额采集引擎（v0.6.1 起原生实现，口径与 usage_monitor.py 一致）。
//!
//! - Kimi / Codex：本地 OAuth 凭证发现 + 到期刷新 + 用量接口（kimi.rs / codex.rs）
//! - DeepSeek / GLM：API key 直连（deepseek.rs / glm.rs）
//! - 共享：http.rs（ureq agent、代理、重试与错误映射）、util.rs（JSON 数值与
//!   时间解析、窗口归一化）、membership.rs（会员到期手动配置）
//!
//! 代理语义与 Python 版相同：GLM/DeepSeek/Codex 默认走系统代理
//!（HTTP(S)_PROXY / ALL_PROXY，缺失时回退 Windows 注册表设置），可用对应
//! *_USE_PROXY=0 关闭；Kimi 默认不走。GET 重试 3 次（退避 1s/2s），POST 不重试。

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

/// 单家结果落地：成功进 accounts，失败以 errors 形式返回
///（与 python _collect_provider 的契约一致），不阻塞其他家。
fn push_result(
    accounts: &mut Vec<Value>,
    errors: &mut Vec<Value>,
    provider: &str,
    result: Result<Value, String>,
) {
    match result {
        Ok(account) => accounts.push(account),
        Err(err) => errors.push(serde_json::json!({ "provider": provider, "error": err })),
    }
}

/// 全量配额采集：Kimi/Codex/DeepSeek/GLM 四家全原生，凭证仅本机侧发现
///（Kimi 网页凭证例外，见 kimi.rs）。返回 (accounts, errors)；versions 由调用方附加。
pub fn collect_all() -> (Vec<Value>, Vec<Value>) {
    let homes = credential_homes();
    let mut accounts: Vec<Value> = Vec::new();
    let mut errors: Vec<Value> = Vec::new();

    // 顺序与 Python collect 一致：Kimi、Codex、DeepSeek、GLM
    match kimi::collect(&homes, &mut errors) {
        Some(account) => accounts.push(account),
        None if !errors.iter().any(|e| e["provider"] == "Kimi Code") => {
            errors.push(serde_json::json!({ "provider": "Kimi Code",
                "error": "Kimi credentials not found; run kimi and log in again" }));
        }
        None => {}
    }
    match codex::collect(&homes, &mut errors) {
        Some(account) => accounts.push(account),
        None if !errors.iter().any(|e| e["provider"] == "OpenAI Codex") => {
            errors.push(serde_json::json!({ "provider": "OpenAI Codex",
                "error": "Codex credentials not found; run `codex login`" }));
        }
        None => {}
    }
    push_result(&mut accounts, &mut errors, "DeepSeek", deepseek::collect());
    push_result(&mut accounts, &mut errors, "GLM", glm::collect());
    (accounts, errors)
}
