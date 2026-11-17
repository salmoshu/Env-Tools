//! 磁盘管理核心（移植自 Jharu github.com/riponcm/Jharu，Apache 2.0）。
//! 三大能力：开发者缓存检测（25+ 规则）、AI 工具痕迹、ML 模型追踪。
//! 安全分级：Safe（自动恢复）/ Caution（恢复需下载或手动）/ Risky（不可恢复）。

use serde_json::Value;
use std::path::PathBuf;

/// 安全等级（同 Jharu rules.rs Safety）
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Safety {
    Safe,
    Caution,
    Risky,
}

impl Safety {
    pub fn as_str(&self) -> &'static str {
        match self {
            Safety::Safe => "safe",
            Safety::Caution => "caution",
            Safety::Risky => "risky",
        }
    }
}

/// 恢复方式（同 Jharu rules.rs Restore）
pub enum Restore {
    Automatic,
    Download,
    Manual(&'static str),
    Never(&'static str),
}

pub struct DevRule {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub safety: Safety,
    pub restore: Restore,
    /// 工具进程名（小写无后缀），正在运行时降为 Caution
    pub tools: &'static [&'static str],
}

/// Windows 下各开发缓存/工具的路径解析
pub fn dev_rule_paths(rule_id: &str) -> Vec<PathBuf> {
    let home = dirs_home();
    let local = home.join("AppData").join("Local");
    let roaming = home.join("AppData").join("Roaming");
    let p = |s: &str| home.join(s);

    match rule_id {
        "npm" => vec![local.join("npm-cache"), p(".npm/_cacache")],
        "pnpm" => vec![local.join("pnpm-cache"), local.join("pnpm/store")],
        "yarn" => vec![local.join("Yarn/Cache"), p(".yarn/cache")],
        "pip" => vec![local.join("pip/cache"), p(".cache/pip")],
        "uv" => vec![local.join("uv/cache"), p(".cache/uv")],
        "conda-pkgs" => vec![
            p("miniconda3/pkgs"),
            p("anaconda3/pkgs"),
            p("miniforge3/pkgs"),
            p(".conda/pkgs"),
            p("D:/ProgramData/anaconda3/pkgs"),
        ],
        "conda-envs" => vec![
            p("miniconda3/envs"),
            p("anaconda3/envs"),
            p("miniforge3/envs"),
            p(".conda/envs"),
            p("D:/ProgramData/anaconda3/envs"),
        ],
        "cargo-registry" => vec![p(".cargo/registry")],
        "go-mod" => vec![p("go/pkg/mod")],
        "gradle" => vec![home.join(".gradle/caches")],
        "maven" => vec![p(".m2/repository")],
        "nuget" => vec![home.join(".nuget/packages")],
        "docker" => vec![
            PathBuf::from("C:\\ProgramData\\Docker"),
            local.join("Docker"),
        ],
        "playwright" => vec![local.join("ms-playwright")],
        "puppeteer" => vec![p(".cache/puppeteer")],
        "jetbrains" => vec![local.join("JetBrains")],
        "hf-hub" => vec![p(".cache/huggingface")],
        "ollama" => vec![p(".ollama/models")],
        "torch" => vec![p(".cache/torch")],
        "keras" => vec![p(".keras/models")],
        "whisper" => vec![p(".cache/whisper")],
        "lm-studio" => vec![p(".cache/lm-studio/models"), p(".lmstudio/models")],
        "vscode-ext" => vec![home.join(".vscode").join("extensions")],
        "rustup" => vec![p(".rustup/toolchains")],
        _ => vec![],
    }
}

pub fn dev_rules() -> Vec<DevRule> {
    vec![
        DevRule { id:"npm", name:"npm cache", description:"npm package cache", safety:Safety::Safe, restore:Restore::Automatic, tools:&["npm","node"] },
        DevRule { id:"pnpm", name:"pnpm store", description:"pnpm content-addressable store", safety:Safety::Safe, restore:Restore::Automatic, tools:&["pnpm"] },
        DevRule { id:"yarn", name:"Yarn cache", description:"Yarn package cache", safety:Safety::Safe, restore:Restore::Automatic, tools:&["yarn"] },
        DevRule { id:"pip", name:"pip cache", description:"Python pip wheel cache", safety:Safety::Safe, restore:Restore::Automatic, tools:&["pip","python"] },
        DevRule { id:"uv", name:"uv cache", description:"Astral uv package cache", safety:Safety::Safe, restore:Restore::Automatic, tools:&["uv"] },
        DevRule { id:"conda-pkgs", name:"conda packages", description:"Conda package cache (not envs)", safety:Safety::Caution, restore:Restore::Download, tools:&["conda"] },
        DevRule { id:"conda-envs", name:"conda environments", description:"Conda environments — deleting removes installed packages", safety:Safety::Risky, restore:Restore::Never("installed packages"), tools:&["conda","python"] },
        DevRule { id:"cargo-registry", name:"Cargo registry", description:"Rust crate download cache", safety:Safety::Safe, restore:Restore::Download, tools:&["cargo","rustc"] },
        DevRule { id:"go-mod", name:"Go modules", description:"Go module download cache", safety:Safety::Safe, restore:Restore::Download, tools:&["go"] },
        DevRule { id:"gradle", name:"Gradle caches", description:"Gradle build cache + dependency cache", safety:Safety::Caution, restore:Restore::Download, tools:&["gradle","java"] },
        DevRule { id:"maven", name:"Maven repository", description:"Maven local repository (~/.m2)", safety:Safety::Caution, restore:Restore::Download, tools:&["mvn","java"] },
        DevRule { id:"nuget", name:"NuGet packages", description:"NuGet global packages folder", safety:Safety::Safe, restore:Restore::Download, tools: &["dotnet"] },
        DevRule { id:"docker", name:"Docker data", description:"Docker images, containers and volumes", safety:Safety::Risky, restore:Restore::Never("containers and volumes"), tools:&["docker"] },
        DevRule { id:"playwright", name:"Playwright browsers", description:"Browser binaries for Playwright tests", safety:Safety::Caution, restore:Restore::Manual("npx playwright install"), tools:&["node","npx"] },
        DevRule { id:"puppeteer", name:"Puppeteer Chrome", description:"Chromium binaries for Puppeteer", safety:Safety::Caution, restore:Restore::Manual("npx puppeteer browsers install"), tools:&["node"] },
        DevRule { id:"jetbrains", name:"JetBrains IDE caches", description:"IDE indexes, caches and logs", safety:Safety::Caution, restore:Restore::Manual("rebuild indexes on open"), tools:&["idea","pycharm","webstorm","clion"] },
        DevRule { id:"hf-hub", name:"HuggingFace models", description:"Downloaded models and datasets from HuggingFace Hub", safety:Safety::Caution, restore:Restore::Download, tools: &["python","huggingface-cli"] },
        DevRule { id:"ollama", name:"Ollama models", description:"Local LLM models managed by Ollama", safety:Safety::Caution, restore:Restore::Manual("ollama pull <model>"), tools:&["ollama"] },
        DevRule { id:"torch", name:"PyTorch hub cache", description:"Pre-trained model cache from torch.hub", safety:Safety::Caution, restore:Restore::Download, tools:&["python"] },
        DevRule { id:"keras", name:"Keras models", description:"Keras model cache (~/.keras/models)", safety:Safety::Caution, restore:Restore::Download, tools:&["python"] },
        DevRule { id:"whisper", name:"Whisper models", description:"OpenAI Whisper model weights", safety:Safety::Caution, restore:Restore::Download, tools:&["python","whisper"] },
        DevRule { id:"lm-studio", name:"LM Studio models", description:"Models downloaded via LM Studio", safety:Safety::Caution, restore:Restore::Manual("re-download in LM Studio"), tools:&["lm-studio"] },
        DevRule { id:"vscode-ext", name:"VS Code extensions", description:"Installed VS Code extensions", safety:Safety::Caution, restore:Restore::Manual("reinstall from marketplace"), tools:&["code"] },
        DevRule { id:"rustup", name:"Rust toolchains", description:"Rust compiler toolchains managed by rustup", safety:Safety::Caution, restore:Restore::Manual("rustup toolchain install"), tools:&["rustup","rustc"] },
    ]
}

/// AI 工具痕迹检测：kimi/codex/zcode/claude/omp 等在工作目录外的遗留
pub fn ai_tool_locations() -> Vec<Value> {
    let home = dirs_home();
    let local = home.join("AppData").join("Local");
    let roaming = home.join("AppData").join("Roaming");
    let mut out = Vec::new();

    let add = |out: &mut Vec<Value>, tool: &str, kind: &str, path: &PathBuf, safety: Safety, desc: &str| {
        if !path.exists() {
            return;
        }
        let (size, file_count) = dir_stats(path, 2);
        if size == 0 && file_count == 0 {
            return;
        }
        out.push(serde_json::json!({
            "tool": tool, "kind": kind, "path": path.display().to_string(),
            "size": size, "size_h": human_size(size), "files": file_count,
            "safety": safety.as_str(), "description": desc,
        }));
    };

    // Kimi Code
    add(&mut out, "Kimi Code", "cache", &home.join(".kimi-code/sessions"), Safety::Risky, "Session transcripts and history");
    add(&mut out, "Kimi Code", "cache", &home.join(".kimi-code/bin"), Safety::Caution, "Downloaded CLI binaries");

    // Codex
    add(&mut out, "Codex", "cache", &home.join(".codex/sessions"), Safety::Risky, "Session transcripts and history");

    // ZCode / Z.ai
    add(&mut out, "ZCode", "cache", &home.join(".zcode/cli"), Safety::Caution, "CLI data and caches");
    add(&mut out, "ZCode", "cache", &home.join(".zcode/server"), Safety::Caution, "Server binaries");

    // OMP
    add(&mut out, "OMP", "cache", &home.join(".omp/agent/sessions"), Safety::Risky, "Session transcripts");
    add(&mut out, "OMP", "cache", &home.join(".omp/agent/cache"), Safety::Safe, "Downloaded model caches");
    add(&mut out, "OMP", "cache", &home.join(".omp/natives"), Safety::Safe, "Native runtime caches");

    // Claude Code (if present)
    add(&mut out, "Claude Code", "history", &home.join(".claude"), Safety::Risky, "Conversation history and settings");

    // Cursor
    add(&mut out, "Cursor", "cache", &roaming.join("Cursor/User/workspaceStorage"), Safety::Caution, "Per-project workspace storage");
    add(&mut out, "Cursor", "cache", &local.join("Cursor/Cache"), Safety::Safe, "App cache");

    // GitHub Copilot
    add(&mut out, "Copilot", "cache", &local.join("GitHub Copilot"), Safety::Safe, "Copilot chat cache");

    // npm global (often has stale CLIs)
    add(&mut out, "npm global", "cache", &roaming.join("npm/node_modules"), Safety::Caution, "Globally installed npm packages");

    out
}

/// 驱动器概览
pub fn drives_overview() -> Vec<Value> {
    crate::disk::drives()
}

// ─── 扫描引擎 ─────────────────────────────────────────────────────────────

/// 扫描开发缓存：返回每条规则的命中结果
pub fn scan_dev_caches() -> Vec<Value> {
    let mut results = Vec::new();
    for rule in dev_rules() {
        let paths = dev_rule_paths(rule.id);
        let mut total_size = 0u64;
        let mut total_files = 0u64;
        let mut found_paths = Vec::new();
        for path in &paths {
            if !path.exists() {
                continue;
            }
            let (size, files) = dir_stats(path, 3);
            if size > 0 {
                total_size += size;
                total_files += files;
                found_paths.push(path.display().to_string());
            }
        }
        if total_size > 0 {
            let safety_str = if is_any_tool_running(rule.tools) && rule.safety == Safety::Safe {
                "caution" // 运行中自动降级
            } else {
                rule.safety.as_str()
            };
            results.push(serde_json::json!({
                "id": rule.id, "name": rule.name, "description": rule.description,
                "safety": safety_str, "size": total_size, "size_h": human_size(total_size),
                "files": total_files, "paths": found_paths,
            }));
        }
    }
    results.sort_by(|a, b| b["size"].as_u64().cmp(&a["size"].as_u64()));
    results
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────

fn dirs_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn dir_stats(path: &PathBuf, max_depth: usize) -> (u64, u64) {
    let mut size = 0u64;
    let mut files = 0u64;
    fn walk(p: &std::path::Path, depth: usize, max: usize, size: &mut u64, files: &mut u64) {
        if depth > max { return; }
        if let Ok(entries) = std::fs::read_dir(p) {
            for e in entries.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_dir() {
                        walk(&e.path(), depth + 1, max, size, files);
                    } else {
                        *size += meta.len();
                        *files += 1;
                    }
                }
            }
        }
    }
    walk(path, 0, max_depth, &mut size, &mut files);
    (size, files)
}

fn is_any_tool_running(names: &[&str]) -> bool {
    use std::process::Command;
    let output = Command::new("tasklist")
        .arg("/FO").arg("CSV").arg("/NH")
        .output();
    match output {
        Ok(o) => {
            let text = String::from_utf8_lossy(&o.stdout).to_lowercase();
            names.iter().any(|n| text.contains(&n.to_lowercase()))
        }
        Err(_) => false,
    }
}

fn human_size(bytes: u64) -> String {
    if bytes >= 1_099_511_627_776 {
        format!("{:.1} TB", bytes as f64 / 1_099_511_627_776.0)
    } else if bytes >= 1_073_741_824 {
        format!("{:.1} GB", bytes as f64 / 1_073_741_824.0)
    } else if bytes >= 1_048_576 {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}
