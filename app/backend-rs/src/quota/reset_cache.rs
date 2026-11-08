//! 重置机会的磁盘缓存：按 provider / 登录身份隔离，原子替换，仅保存重置元数据。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::Value;
use sha2::{Digest, Sha256};

static CACHE_LOCK: Mutex<()> = Mutex::new(());

pub fn key(identity: &str) -> String {
    format!("{:x}", Sha256::digest(identity.as_bytes()))
}

pub fn path(provider: &str, key: &str) -> PathBuf {
    crate::settings::local_home().join(".cache").join("ai-usage-monitor")
        .join("reset-expiry").join(provider).join(format!("{key}.json"))
}

pub fn update(path: &Path, merge: impl FnOnce(&Value) -> Option<Value>) -> Option<Value> {
    let _lock = CACHE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let previous = crate::settings::read_json(path).unwrap_or(Value::Null);
    let current = merge(&previous)?;
    if current != previous {
        let pending = path.with_extension(format!("json.{}.tmp", super::util::random_token()));
        let saved = crate::settings::write_private_json(&pending, &current)
            .and_then(|_| std::fs::rename(&pending, path).map_err(|error| error.to_string()));
        if let Err(error) = saved {
            let _ = std::fs::remove_file(&pending);
            eprintln!("[quota] cannot persist reset expiry cache: {error}");
        }
    }
    Some(current)
}

pub fn clear(path: &Path) {
    update(path, |previous| (!previous.is_null()).then_some(Value::Null));
}

#[cfg(test)]
pub struct TestCache(pub PathBuf);

#[cfg(test)]
impl TestCache {
    pub fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "env-tools-reset-cache-{}", super::util::random_token()
        ));
        Self(dir.join("account.json"))
    }
}

#[cfg(test)]
impl Drop for TestCache {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_dir(self.0.parent().unwrap());
    }
}
