//! 版本号单一来源：仓库根目录的 VERSION 文件（setup/tools 各脚本均以它为准）。
//! Cargo.toml 的 version 仅作兜底；展示给用户的版本一律以 VERSION 为准，
//! 避免再次出现 Cargo.toml 已升、二进制仍显示旧版本的漂移。
use std::{env, fs, path::PathBuf};

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let version_file = manifest.join("../../VERSION");
    println!("cargo:rerun-if-changed={}", version_file.display());
    let version = fs::read_to_string(&version_file)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| env::var("CARGO_PKG_VERSION").unwrap());
    println!("cargo:rustc-env=APP_VERSION={version}");
}
