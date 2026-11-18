//! 回收站管理（1:1 移植自 Jharu bin.rs + trashlog.rs，Apache 2.0）。
//!
//! 三条设计原则（同 Jharu）：
//! - 永久删除是全应用唯一的不可逆操作，因此收窄到极限：请求里列出用户
//!   看到的每一项，删除前逐项重新核对；已消失、已变化、不再匹配所选
//!   规则（如"超过 30 天"）的项一律跳过。请求之外的项即使现在匹配也不动。
//! - 回收站本身不知道是谁把文件放进去的。清理日志（trashlog）知道，
//!   所以每个回收站项都与日志匹配：原路径相同且删除时间在日志时间附近。
//!   本应用从清理页移入的缓存标记 Safe（可放心清空）；其余是用户自己
//!   删除的文件，标记 Caution。
//! - Windows 上恢复时资源管理器会隐藏已知扩展名（foo.txt 显示为 foo），
//!   [`true_name`] 从回收站自身的 $I 元数据文件里找回真实文件名。

use crate::jharu::Safety;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
const BIN: &str = "Recycle Bin";
#[cfg(not(target_os = "windows"))]
const BIN: &str = "Trash";

/// 每次清空调用移交 shell 的项数：全部一次会掩盖单项失败且无法取消，
/// 逐项太慢。
const CHUNK: usize = 25;
/// 日志条目在移动完成后立刻写入；回收站对移动本身另行打时间戳。大文件夹
/// 的移动可能耗时数分钟，所以日志时间之前留足窗口，之后留几秒。
const WINDOW_BEFORE: i64 = 1800;
const WINDOW_AFTER: i64 = 15;
/// 恢复列表里展示的日志行数上限。
const LOG_LIMIT: usize = 500;

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn json_err(msg: &str) -> Value { serde_json::json!({ "ok": false, "error": msg }) }

pub fn hs(n: u64) -> String {
    let u: f64 = 1024.0;
    let v = n as f64;
    if v >= u.powi(4) { format!("{:.1}TB", v / u.powi(4)) }
    else if v >= u.powi(3) { format!("{:.1}GB", v / u.powi(3)) }
    else if v >= u.powi(2) { format!("{:.1}MB", v / u.powi(2)) }
    else if v >= u { format!("{:.0}KB", v) }
    else { format!("{n}B") }
}

// =============================================================== trashlog

/// 日志条目：一条 JSON 一行，追加写入；单次 write 调用保证两个并发清理
/// 不会交错出半行；损坏的行读取时跳过而不是丢掉整个文件。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// 移动前 item 所在的位置。
    pub path: String,
    /// 移动释放的字节数。
    pub size: u64,
    /// 移动完成后的 Unix 秒。
    pub time: u64,
    /// 做出移动的标签页/功能，如 "开发缓存"。
    pub source: String,
}

/// 最多保留的条目数；超过上限加缓冲时裁剪，避免每次调用都重写文件。
const MAX_ENTRIES: usize = 20_000;
const SLACK: usize = 2_000;

/// 序列化追加与偶发裁剪重写。
static LOCK: Mutex<()> = Mutex::new(());

fn journal_path() -> Option<PathBuf> {
    let home = crate::settings::local_home();
    if cfg!(target_os = "windows") {
        Some(home.join("AppData").join("Local").join("Env-Tools").join("trash-log.jsonl"))
    } else {
        Some(home.join(".cache").join("ai-usage-monitor").join("trash-log.jsonl"))
    }
}

/// 移动路径列表到回收站（trash crate 的 shell 调用，替代 PowerShell）。
pub fn to_bin<P: AsRef<Path>>(paths: &[P]) -> Result<(), String> {
    let refs: Vec<&Path> = paths.iter().map(|p| p.as_ref()).collect();
    trash::delete_all(refs).map_err(|e| e.to_string())
}

/// 记录 path 刚被移入回收站。绝不失败调用方：item 已经在回收站里了，
/// 清理不能因为一条日志而中断。
pub fn record(path: &Path, size: u64, source: &str) {
    let Some(file) = journal_path() else { return };
    let entry = Entry { path: path.to_string_lossy().into_owned(), size, time: now_secs() as u64, source: source.to_string() };
    let Ok(mut line) = serde_json::to_string(&entry) else { return };
    line.push('\n');
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(dir) = file.parent() { let _ = std::fs::create_dir_all(dir); }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&file) {
        use std::io::Write;
        let _ = f.write_all(line.as_bytes());
    }
}

fn parse(text: &str) -> Vec<Entry> {
    text.lines().filter_map(|l| serde_json::from_str::<Entry>(l.trim()).ok()).collect()
}

/// 全部条目，旧在前。过长时裁剪文件。
pub fn read_all() -> Vec<Entry> {
    let Some(file) = journal_path() else { return vec![] };
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(text) = std::fs::read_to_string(&file) else { return vec![] };
    let mut entries = parse(&text);
    if entries.len() > MAX_ENTRIES + SLACK {
        entries.drain(..entries.len() - MAX_ENTRIES);
        let mut kept = String::new();
        for e in &entries {
            if let Ok(l) = serde_json::to_string(e) {
                kept.push_str(&l);
                kept.push('\n');
            }
        }
        // 先写在旁边再换名，崩溃不会留下半个文件。
        let tmp = file.with_extension("jsonl.tmp");
        if std::fs::write(&tmp, kept).is_ok() && std::fs::rename(&tmp, &file).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
    entries
}

// ================================================================ model

/// 平台报告的原始项，尚未做任何判断。
#[derive(Clone, Debug)]
struct Raw {
    /// 不透明 id，项留在回收站期间稳定。Windows：shell 解析名。
    id: String,
    /// 真实文件名（含扩展名）。
    name: String,
    /// 删除前所在的文件夹（平台知道时）。
    parent: Option<PathBuf>,
    /// Unix 秒。
    deleted: Option<i64>,
    size: u64,
    is_dir: bool,
}

impl Raw {
    fn original(&self) -> Option<PathBuf> {
        self.parent.as_ref().map(|p| p.join(&self.name))
    }
}

/// 可比较的路径形式：分隔符统一、去尾斜杠、大小写不敏感文件系统上折叠。
fn key(p: &Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(any(target_os = "windows", target_os = "macos")) { s.to_lowercase() } else { s }
}

fn file_name_of(path: &str) -> String {
    Path::new(&path.replace('\\', "/")).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.to_string())
}

fn age_days(deleted: Option<i64>, now: i64) -> Option<u64> {
    deleted.map(|d| (now - d).max(0) as u64 / 86_400)
}

// ==================================================== $I 元数据解析

/// Windows 在数据文件 $R 旁的 $I 文件里保存的删除记录。
#[derive(Debug, PartialEq, Eq)]
struct Info {
    original: PathBuf,
    size: u64,
}

/// 解析 $I 文件。版本 1（Vista~8）定长 260 字符路径；版本 2（Win10+）
/// 先存长度。
fn parse_info(b: &[u8]) -> Option<Info> {
    let u64_at = |at: usize| b.get(at..at + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap()));
    let version = u64_at(0)?;
    let size = u64_at(8)?;
    let (start, chars) = match version {
        1 => (24usize, 260usize),
        2 => (28, u32::from_le_bytes(b.get(24..28)?.try_into().ok()?) as usize),
        _ => return None,
    };
    let bytes = b.get(start..)?;
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .take(chars)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .take_while(|&u| u != 0)
        .collect();
    let text = String::from_utf16(&units).ok()?;
    if text.is_empty() { return None; }
    Some(Info { original: PathBuf::from(text), size })
}

/// 回收站项的真实名字（含扩展名）。
///
/// listed 是 shell 的显示名（隐藏已知扩展名）；id 是形如
/// `C:\$Recycle.Bin\S-1-5-21-…\$R1A2B3C.txt` 的解析名，其扩展名是原文件
/// 的。$I 文件可读时直接持有原路径，一锤定音；否则 listed 缺扩展名时补上
/// id 的扩展名。
fn true_name(listed: &str, id: &str, info: Option<&Info>) -> String {
    if let Some(name) = info.and_then(|i| i.original.file_name()) {
        let name = name.to_string_lossy();
        if name.to_lowercase().starts_with(&listed.to_lowercase()) {
            return name.into_owned();
        }
    }
    let ext = Path::new(&id.replace('\\', "/")).extension().map(|e| e.to_string_lossy().into_owned());
    match ext {
        Some(ext) if !listed.to_lowercase().ends_with(&format!(".{}", ext.to_lowercase())) => format!("{listed}.{ext}"),
        _ => listed.to_string(),
    }
}

// ================================================================ platform

#[cfg(target_os = "windows")]
mod plat {
    use super::*;
    use std::io::Read;

    pub const SUPPORTED: bool = true;

    /// 带 trash crate 操作句柄的回收站项。句携带修正后的名字，恢复时以
    /// 真名重建文件。
    pub struct Native {
        pub raw: Raw,
        pub item: trash::TrashItem,
    }

    /// $R 路径对应的 $I 文件，回收站文件夹允许读取时。
    pub fn read_info(r_path: &Path) -> Option<Info> {
        let name = r_path.file_name()?.to_string_lossy().into_owned();
        let rest = name.get(2..).filter(|_| name[..2].eq_ignore_ascii_case("$R"))?;
        let i_path = r_path.with_file_name(format!("$I{rest}"));
        let mut bytes = Vec::new();
        std::fs::File::open(i_path).ok()?.take(16 * 1024).read_to_end(&mut bytes).ok()?;
        parse_info(&bytes)
    }

    fn folder_bytes(dir: &Path) -> u64 {
        walk_files(dir).map(|m| m.len()).sum()
    }

    fn walk_files(dir: &Path) -> impl Iterator<Item = std::fs::Metadata> {
        let mut stack = vec![dir.to_path_buf()];
        let mut out: Vec<std::fs::Metadata> = vec![];
        while let Some(p) = stack.pop() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                for e in rd.flatten() {
                    let path = e.path();
                    match std::fs::symlink_metadata(&path) {
                        Ok(m) if m.is_dir() => stack.push(path),
                        Ok(m) if m.is_file() => out.push(m),
                        _ => {}
                    }
                }
            }
        }
        out.into_iter()
    }

    pub fn list() -> Result<Vec<Native>, String> {
        let items = trash::os_limited::list().map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(items.len());
        for mut t in items {
            let id = t.id.to_string_lossy().into_owned();
            let r_path = PathBuf::from(&id);
            let info = read_info(&r_path);
            let name = true_name(&t.name.to_string_lossy(), &id, info.as_ref());
            t.name = name.clone().into();

            let (size, is_dir) = match r_path.symlink_metadata() {
                // 回收站在删除时记录文件夹大小；仅为列出而遍历一个巨大的
                // 已删 node_modules 要花数分钟。
                Ok(m) if m.is_dir() => {
                    let recorded = info.as_ref().map(|i| i.size).filter(|&s| s > 0);
                    (recorded.unwrap_or_else(|| folder_bytes(&r_path)), true)
                }
                Ok(m) => (m.len(), false),
                // 回收站自身文件夹不可读时：问 shell。
                Err(_) => (info.as_ref().map_or(0, |i| i.size), false),
            };
            out.push(Native {
                raw: Raw {
                    id,
                    name,
                    parent: Some(t.original_parent.clone()),
                    deleted: Some(t.time_deleted),
                    size,
                    is_dir,
                },
                item: t,
            });
        }
        Ok(out)
    }

    pub fn purge(batch: &[&Native]) -> Result<(), String> {
        trash::os_limited::purge_all(batch.iter().map(|n| &n.item)).map_err(|e| e.to_string())
    }

    /// 放回一项。dest 此处不用：Windows 自己知道它从哪来。
    pub fn restore(n: &Native, _dest: Option<&Path>) -> Result<PathBuf, String> {
        let target = n.item.original_path();
        if let Some(parent) = target.parent() {
            // 它所在的文件夹可能也没了（被删 worktree 的父目录）；
            // 资源管理器会重建，这里也一样。
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| format!("无法重建 {}: {e}", parent.display()))?;
            }
        }
        trash::os_limited::restore_all([n.item.clone()]).map_err(|e| e.to_string())?;
        Ok(target)
    }
}

#[cfg(not(target_os = "windows"))]
mod plat {
    use super::*;
    pub const SUPPORTED: bool = false;
    pub struct Native { pub raw: Raw }
    pub fn list() -> Result<Vec<Native>, String> { Ok(vec![]) }
    pub fn purge(_batch: &[&Native]) -> Result<(), String> {
        Err("回收站管理仅支持 Windows / macOS".into())
    }
    pub fn restore(_n: &Native, _dest: Option<&Path>) -> Result<PathBuf, String> {
        Err("回收站管理仅支持 Windows / macOS".into())
    }
}

use plat::Native;

// ==================================================== 日志匹配与评级

/// 各标签页在日志里对自己的移动所用的名字，其产物由工具自身重建。
/// "开发缓存" 只为评过 Safe 的发现写入；其余写作 "开发缓存（未评级安全）"，
/// 这里不给通行证。
fn rebuilds_itself(source: &str) -> bool {
    matches!(source, "开发缓存" | "系统文件夹")
}

/// 每个回收站项对应的日志条目（若有）。
///
/// 原路径匹配（macOS 上回收站不保留原路径，用文件名）且删除时间在条目
/// 时间的窗口内时，条目描述该项。同一路径多次入站时，每条目取最近的
/// 未被认领项，新条目优先，老行不会认领新的删除。
fn match_journal(items: &[Raw], log: &[Entry]) -> Vec<Option<usize>> {
    let mut taken: Vec<Option<usize>> = vec![None; items.len()];
    // 一次性建索引：日志最多 2 万行、回收站数千项，两两比较要数分钟。
    let mut by_path: HashMap<String, Vec<usize>> = HashMap::new();
    let mut by_name: HashMap<String, Vec<usize>> = HashMap::new();
    for (ii, it) in items.iter().enumerate() {
        match it.original() {
            Some(orig) => by_path.entry(key(&orig)).or_default().push(ii),
            None => by_name.entry(it.name.to_lowercase()).or_default().push(ii),
        }
    }
    let mut order: Vec<usize> = (0..log.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(log[i].time));
    for li in order {
        let e = &log[li];
        let candidates = by_path
            .get(&key(Path::new(&e.path)))
            .into_iter()
            .chain(by_name.get(&file_name_of(&e.path).to_lowercase()))
            .flatten();
        let mut best: Option<(i64, usize)> = None;
        for &ii in candidates {
            if taken[ii].is_some() { continue; }
            let Some(deleted) = items[ii].deleted else { continue };
            let delta = e.time as i64 - deleted;
            if delta < -WINDOW_AFTER || delta > WINDOW_BEFORE { continue; }
            if best.map_or(true, |(d, _)| delta.abs() < d) {
                best = Some((delta.abs(), ii));
            }
        }
        if let Some((_, ii)) = best { taken[ii] = Some(li); }
    }
    taken
}

fn ago(days: Option<u64>) -> String {
    match days {
        None => "于未知时间".into(),
        Some(0) => "今天".into(),
        Some(1) => "1 天前".into(),
        Some(n) => format!("{n} 天前"),
    }
}

/// 清空此项的安全性及依据。每行都是关于该项的事实，评级可核查而非凭信。
fn rate(entry: Option<&Entry>, age: Option<u64>) -> (Safety, String, Vec<Value>) {
    let mut reasons: Vec<Value> = vec![];
    let (safety, summary) = match entry {
        Some(e) if rebuilds_itself(&e.source) => {
            reasons.push(serde_json::json!({"level":"ok","text":format!("本应用于{}从「{}」移入（{}）。", ago(age), e.source, "")}));
            reasons.push(serde_json::json!({"level":"ok","text":"这是评级 Safe 的缓存：产出它的工具需要时会自行重建，清空不损失任何独有数据。"}));
            (Safety::Safe, "本应用移除的缓存".to_string())
        }
        Some(e) => {
            reasons.push(serde_json::json!({"level":"ok","text":format!("本应用于{}从「{}」移入。", ago(age), e.source)}));
            let warn_text = match e.source.as_str() {
                "ML 模型" => "模型可以重新下载，但体积很大；需要时要重新下载。".to_string(),
                "开发缓存（未评级安全）" => "该项不是纯缓存（重建需手动步骤或含独有数据）；清空前请先查看内容。".to_string(),
                "Python" => "环境与包在项目仍需要时必须重装。".to_string(),
                "Git worktree" => "仓库文件夹的副本。分支仍在 git 里，但未提交的内容只在这里。".to_string(),
                "浏览器" => "浏览器文件夹除缓存外可能保存登录态与历史。".to_string(),
                other => format!("「{other}」可能包含仅此一份的文件；清空前请查看。"),
            };
            reasons.push(serde_json::json!({"level":"warn","text":warn_text}));
            (Safety::Caution, "本应用移入，请先核查".to_string())
        }
        None => {
            reasons.push(serde_json::json!({"level":"warn","text":"非本应用移入，无法判断内容。这是你自己删除的文件；清空前请检查。"}));
            if age == Some(0) {
                reasons.push(serde_json::json!({"level":"warn","text":"今天刚删除，你可能还想要它。"}));
            }
            (Safety::Caution, "你自己删除的文件".to_string())
        }
    };
    if let Some(n) = age.filter(|&n| n >= 7) {
        reasons.push(serde_json::json!({"level":"ok","text":format!("已在{BIN}中 {n} 天未被放回。")}));
    }
    (safety, summary, reasons)
}

fn build_items(raws: &[Raw], log: &[Entry], now: i64) -> Vec<Value> {
    let matched = match_journal(raws, log);
    let mut items: Vec<Value> = raws
        .iter()
        .zip(&matched)
        .map(|(r, m)| {
            let entry = m.map(|li| &log[li]);
            let age = age_days(r.deleted, now);
            let (safety, summary, reasons) = rate(entry, age);
            let original = r.original().map(|p| p.to_string_lossy().into_owned())
                .or_else(|| entry.map(|e| e.path.clone()));
            let folder = original.as_ref().and_then(|p| Path::new(p).parent().map(|d| d.to_string_lossy().into_owned()));
            serde_json::json!({
                "id": r.id, "name": r.name,
                "original_path": original, "original_folder": folder,
                "deleted_at": r.deleted, "age_days": age,
                "size_bytes": r.size, "size_h": hs(r.size), "is_dir": r.is_dir,
                "by_app": entry.is_some(), "source": entry.map(|e| e.source.clone()),
                "safety": safety.as_str(), "summary": summary, "reasons": reasons,
            })
        })
        .collect();
    items.sort_by(|a, b| b["size_bytes"].as_u64().unwrap_or(0).cmp(&a["size_bytes"].as_u64().unwrap_or(0)));
    items
}

fn report_from(items: Vec<Value>, note: Option<String>) -> Value {
    let sum = |f: &dyn Fn(&Value) -> bool| items.iter().filter(|i| f(i)).map(|i| i["size_bytes"].as_u64().unwrap_or(0)).sum::<u64>();
    let count = |f: &dyn Fn(&Value) -> bool| items.iter().filter(|i| f(i)).count();
    serde_json::json!({
        "ok": true, "supported": plat::SUPPORTED, "bin_name": BIN,
        "total_items": items.len(), "total_bytes": sum(&|_| true), "total_h": hs(sum(&|_| true)),
        "app_items": count(&|i| i["by_app"].as_bool().unwrap_or(false)),
        "app_bytes": sum(&|i| i["by_app"].as_bool().unwrap_or(false)),
        "other_items": count(&|i| !i["by_app"].as_bool().unwrap_or(false)),
        "other_bytes": sum(&|i| !i["by_app"].as_bool().unwrap_or(false)),
        "items": items, "note": note,
    })
}

/// 项是否属于本次清空范围。
fn in_scope(item: &Value, scope: &str, days: u32) -> bool {
    let old_enough = item["age_days"].as_u64().is_some_and(|a| a >= days as u64);
    match scope {
        "older" => old_enough,
        "app_older" => item["by_app"].as_bool().unwrap_or(false) && old_enough,
        _ => true,
    }
}

fn log_report(raws: &[Raw], log: &[Entry]) -> Value {
    let matched = match_journal(raws, log);
    let mut bin_of: HashMap<usize, &Raw> = HashMap::new();
    for (ri, m) in matched.iter().enumerate() {
        if let Some(li) = m { bin_of.insert(*li, &raws[ri]); }
    }
    let mut order: Vec<usize> = (0..log.len()).collect();
    order.sort_by_key(|&i| std::cmp::Reverse(log[i].time));
    let in_bin = bin_of.len();
    let entries = order
        .into_iter()
        .take(LOG_LIMIT)
        .map(|li| {
            let e = &log[li];
            let raw = bin_of.get(&li);
            serde_json::json!({
                "path": e.path, "name": file_name_of(&e.path),
                "size_bytes": e.size, "size_h": hs(e.size), "time": e.time,
                "source": e.source,
                "in_bin": raw.is_some(), "bin_id": raw.map(|r| r.id.clone()),
                "destination_taken": raw.is_some() && Path::new(&e.path).symlink_metadata().is_ok(),
            })
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "ok": true, "supported": plat::SUPPORTED, "bin_name": BIN,
        "total_logged": log.len(), "in_bin": in_bin, "entries": entries,
    })
}

// ==================================================== 取消令牌

static CANCELLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn cancel(token: &str) {
    CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashSet::new).insert(token.to_string());
}

fn is_cancelled(token: &str) -> bool {
    CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).as_ref().is_some_and(|s| s.contains(token))
}

fn forget(token: &str) {
    if let Some(s) = CANCELLED.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        s.remove(token);
    }
}

// ==================================================== 操作

pub fn bin_list() -> Value {
    let natives = match plat::list() {
        Ok(n) => n,
        Err(e) => return json_err(&e),
    };
    let raws: Vec<Raw> = natives.iter().map(|n| n.raw.clone()).collect();
    report_from(build_items(&raws, &read_all(), now_secs()), None)
}

pub fn bin_log() -> Value {
    let raws: Vec<Raw> = match plat::list() {
        Ok(n) => n.iter().map(|n| n.raw.clone()).collect(),
        Err(e) => return json_err(&e),
    };
    log_report(&raws, &read_all())
}

/// 清空范围的请求项：id + 用户看到的删除时间（时间不同说明已是另一项）。
#[derive(Clone)]
pub struct PurgeRequest {
    pub id: String,
    pub deleted: Option<i64>,
}

/// 永久移除请求的项，每项仅在仍在、未变、仍在所选范围时执行。
/// ids 为空时自动选取当前范围内全部项（"清空"按钮）。
pub fn bin_purge(ids: &[PurgeRequest], scope: &str, days: u32, token: &str) -> Value {
    let (_, _, _, result) = purge_core(ids, scope, days, token, &mut |_, _, _| {});
    result
}

/// 带进度回调的清空内核。每批处理前回调 progress(done, total, 当前项名)。
/// 返回 (purged, freed, cancelled, 最终结果)。
pub(crate) fn purge_core(
    ids: &[PurgeRequest],
    scope: &str,
    days: u32,
    token: &str,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> (usize, u64, bool, Value) {
    let mut purged = 0usize;
    let mut freed: u64 = 0;
    let mut already_gone = 0usize;
    let mut skipped: Vec<String> = vec![];
    let mut errors: Vec<String> = vec![];
    let mut cancelled = false;

    let natives = match plat::list() {
        Ok(n) => n,
        Err(e) => return (0, 0, false, json_err(&e)),
    };
    let raws: Vec<Raw> = natives.iter().map(|n| n.raw.clone()).collect();
    let items = build_items(&raws, &read_all(), now_secs());
    let by_id: HashMap<&str, usize> = natives.iter().enumerate().map(|(i, n)| (n.raw.id.as_str(), i)).collect();
    let item_of: HashMap<&str, &Value> = items.iter().map(|i| (i["id"].as_str().unwrap_or(""), i)).collect();

    let mut seen: HashSet<&str> = HashSet::new();
    let mut chosen: Vec<&Native> = vec![];
    // 未指定 ids：按范围全选（当前列表即用户所见）。
    let requests: Vec<PurgeRequest> = if ids.is_empty() {
        items.iter()
            .filter(|i| in_scope(i, scope, days))
            .filter_map(|i| Some(PurgeRequest {
                id: i["id"].as_str()?.to_string(),
                deleted: i["deleted_at"].as_i64(),
            }))
            .collect()
    } else {
        ids.to_vec()
    };
    for req in &requests {
        if !seen.insert(req.id.as_str()) { continue; }
        let (Some(&ni), Some(item)) = (by_id.get(req.id.as_str()), item_of.get(req.id.as_str())) else {
            already_gone += 1;
            continue;
        };
        // 用户看到的删除时间必须与项当前的时间一致；不带时间的请求无法
        // 证明是同一项。
        if req.deleted != item["deleted_at"].as_i64() {
            skipped.push(format!("{}：这个位置现在已是另一项", item["name"].as_str().unwrap_or("?")));
        } else if !in_scope(item, scope, days) {
            skipped.push(format!("{}：不再匹配所选清空条件", item["name"].as_str().unwrap_or("?")));
        } else {
            chosen.push(&natives[ni]);
        }
    }

    let total = chosen.len();
    let mut done = 0usize;
    // (id, 消息)：留到重新列举后确定哪些真失败了。
    let mut failed: Vec<(&str, String)> = vec![];
    for batch in chosen.chunks(CHUNK) {
        if is_cancelled(token) { cancelled = true; break; }
        progress(done, total, &batch[0].raw.name);
        if plat::purge(batch).is_err() {
            // 一个坏项可能让整批在移除任何东西前停下；给每项单独机会，
            // 让错误能点名责任者。
            for n in batch {
                if let Err(e) = plat::purge(&[*n]) {
                    failed.push((n.raw.id.as_str(), format!("{}: {e}", n.raw.name)));
                }
            }
        }
        done += batch.len();
        progress(done, total, "");
    }

    // 真相是不再在回收站里的东西。半途失败的批可能已移除了部分项，这些
    // 项再单独重试会报"未找到"；只有仍在的才算失败。
    let after: HashSet<String> = match plat::list() {
        Ok(l) => l.into_iter().map(|n| n.raw.id).collect(),
        Err(_) => HashSet::new(),
    };
    for (id, msg) in &failed {
        if after.contains(*id) { errors.push(msg.clone()); }
    }
    // 取消点之后未尝试的项从未被处理。
    let attempted = if cancelled { done } else { total };
    for n in chosen.iter().take(attempted) {
        if !after.contains(&n.raw.id) {
            purged += 1;
            freed += n.raw.size;
        }
    }
    let still: usize = chosen.iter().take(attempted).filter(|n| after.contains(&n.raw.id)).count();
    if still > errors.len() {
        errors.push(format!("{still} 项仍在{BIN}中"));
    }
    forget(token);
    (purged, freed, cancelled, serde_json::json!({
        "ok": errors.is_empty() && !cancelled, "purged": purged, "freed_bytes": freed, "freed_h": hs(freed),
        "already_gone": already_gone, "skipped": skipped, "errors": errors, "cancelled": cancelled,
    }))
}

/// 把给定的回收站项放回原处。
pub fn bin_restore(ids: &[String]) -> Value {
    let mut restored: Vec<String> = vec![];
    let mut skipped: Vec<String> = vec![];
    let mut errors: Vec<String> = vec![];

    let natives = match plat::list() {
        Ok(n) => n,
        Err(e) => return json_err(&e),
    };
    let raws: Vec<Raw> = natives.iter().map(|n| n.raw.clone()).collect();
    let log = read_all();
    let matched = match_journal(&raws, &log);
    let by_id: HashMap<&str, usize> = natives.iter().enumerate().map(|(i, n)| (n.raw.id.as_str(), i)).collect();

    let mut seen: HashSet<&str> = HashSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) { continue; }
        let Some(&ni) = by_id.get(id.as_str()) else {
            skipped.push(format!("一项已不在{BIN}中（已还原或已清空）"));
            continue;
        };
        let n = &natives[ni];
        // 放回哪里：回收站自己的记录，否则日志的。
        let dest: Option<PathBuf> = n.raw.original()
            .or_else(|| matched[ni].map(|li| PathBuf::from(&log[li].path)));
        let Some(dest) = dest else {
            skipped.push(format!("{}：不知道它原来在哪", n.raw.name));
            continue;
        };
        if dest.symlink_metadata().is_ok() {
            skipped.push(format!("{}：{} 处已存在同名项", n.raw.name, dest.display()));
            continue;
        }
        match plat::restore(n, Some(&dest)) {
            Ok(path) if path.symlink_metadata().is_ok() => restored.push(path.to_string_lossy().into_owned()),
            Ok(path) => errors.push(format!("{}：已还原，但 {} 处没有文件", n.raw.name, path.display())),
            Err(e) => errors.push(format!("{}: {e}", n.raw.name)),
        }
    }
    serde_json::json!({ "ok": errors.is_empty(), "restored": restored, "skipped": skipped, "errors": errors })
}

/// 停止正在进行的清空（当前批之后）。
pub fn bin_cancel(token: &str) -> Value {
    cancel(token);
    serde_json::json!({ "ok": true })
}

/// 清理入口：移入回收站并记日志（供磁盘各清理页调用）。
/// items: [{path, size, source}]，size 已知时免于重扫。
pub fn clean_and_journal(items: &[Value]) -> Value {
    let (_, _, _, result) = clean_core(items, "", &mut |_, _, _| {});
    result
}

/// 带进度回调与取消的清理内核（Jharu cleaning.rs 的逐项进度对齐）。
/// 每项移动前回调 progress(done, total, 当前项名)；token 非空时每项前
/// 检查取消标记。返回 (moved, freed, cancelled, 最终结果)。
pub(crate) fn clean_core(
    items: &[Value],
    token: &str,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> (usize, u64, bool, Value) {
    let mut meta: Vec<(PathBuf, u64, String)> = vec![];
    for it in items {
        let Some(p) = it["path"].as_str() else { continue };
        let path = PathBuf::from(p);
        if !path.exists() { continue; }
        let size = it["size"].as_u64().unwrap_or(0);
        let source = it["source"].as_str().unwrap_or("清理").to_string();
        meta.push((path, size, source));
    }
    if meta.is_empty() {
        return (0, 0, false, json_err("没有可清理的有效路径"));
    }
    // 逐项移动 + 记日志（尺寸未知时现算）。
    let total = meta.len();
    let mut moved = 0usize;
    let mut failed: Vec<String> = vec![];
    let mut freed: u64 = 0;
    let mut cancelled = false;
    for (done, (path, known_size, source)) in meta.iter().enumerate() {
        if !token.is_empty() && is_cancelled(token) { cancelled = true; break; }
        progress(done, total, &path.file_name().map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string()));
        let size = if *known_size > 0 { *known_size } else {
            match std::fs::symlink_metadata(path) {
                Ok(m) if m.is_file() => m.len(),
                Ok(_) => dir_size(path),
                Err(_) => 0,
            }
        };
        match to_bin(std::slice::from_ref(path)) {
            Ok(()) => {
                record(path, size, source);
                moved += 1;
                freed += size;
            }
            Err(e) => failed.push(format!("{}: {e}", path.display())),
        }
        progress(done + 1, total, "");
    }
    (moved, freed, cancelled, serde_json::json!({
        "ok": failed.is_empty() && !cancelled, "moved": moved,
        "freed_bytes": freed, "freed_h": hs(freed),
        "failed": failed, "cancelled": cancelled,
    }))
}

// ============================================================ 清理/清空任务（进度轮询）

use std::sync::atomic::{AtomicU64, Ordering};

/// 一个后台清理任务的进度快照（前端 400ms 轮询；Electron IPC 桥无法直接
/// 消费 SSE，轮询是等价且更稳的形态）。
#[derive(Clone)]
struct JobState {
    kind: &'static str, // "clean" | "purge"
    state: &'static str, // running | done | cancelled | error
    done: usize,
    total: usize,
    current: String,
    moved: usize,
    freed_h: String,
    failed: Vec<String>,
    result: Option<Value>,
}

static JOBS: Mutex<Option<HashMap<u64, JobState>>> = Mutex::new(None);
static NEXT_JOB: AtomicU64 = AtomicU64::new(1);

fn job_update(id: u64, f: impl FnOnce(&mut JobState)) {
    let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    let jobs = guard.get_or_insert_with(HashMap::new);
    if let Some(st) = jobs.get_mut(&id) { f(st); }
}

/// 完成的任务只留最近 20 个，注册表不无限增长。
fn prune_jobs() {
    let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(jobs) = guard.as_mut() else { return };
    let finished: Vec<u64> = jobs.iter()
        .filter(|(_, s)| s.state != "running")
        .map(|(k, _)| *k)
        .collect();
    if finished.len() > 20 {
        let mut dead: Vec<u64> = finished;
        dead.sort_unstable();
        for k in dead.drain(..dead.len() - 20) { jobs.remove(&k); }
    }
}

fn spawn_job(kind: &'static str, total_hint: usize, run: impl FnOnce(u64, &str) -> (usize, String, bool, Option<Value>) + Send + 'static) -> Value {
    let id = NEXT_JOB.fetch_add(1, Ordering::Relaxed);
    {
        let mut guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
        guard.get_or_insert_with(HashMap::new).insert(id, JobState {
            kind, state: "running", done: 0, total: total_hint,
            current: String::new(), moved: 0, freed_h: String::new(),
            failed: vec![], result: None,
        });
    }
    std::thread::spawn(move || {
        let token = format!("job-{id}");
        let (moved, freed_h, cancelled, result) = run(id, &token);
        forget(&token);
        job_update(id, |s| {
            s.state = if cancelled { "cancelled" } else { "done" };
            s.current.clear();
            s.moved = moved;
            s.freed_h = freed_h;
            s.result = result;
        });
        prune_jobs();
    });
    serde_json::json!({ "ok": true, "job": id })
}

/// 启动后台清理任务（移入回收站 + 日志），返回任务 id。
pub fn start_clean_job(items: &[Value]) -> Value {
    let total = items.len();
    let items = items.to_vec();
    spawn_job("clean", total, move |id, token| {
        let (moved, freed, cancelled, result) = clean_core(&items, token, &mut |done, total, cur| {
            job_update(id, |s| { s.done = done; s.total = total; s.current = cur.to_string(); });
        });
        (moved, hs(freed), cancelled, Some(result))
    })
}

/// 启动后台回收站清空任务，返回任务 id。
pub fn start_purge_job(ids: &[PurgeRequest], scope: &str, days: u32) -> Value {
    let ids = ids.to_vec();
    let scope = scope.to_string();
    spawn_job("purge", 0, move |id, token| {
        let (purged, freed, cancelled, result) = purge_core(&ids, &scope, days, token, &mut |done, total, cur| {
            job_update(id, |s| { s.done = done; s.total = total; s.current = cur.to_string(); });
        });
        (purged, hs(freed), cancelled, Some(result))
    })
}

/// 查询任务进度。
pub fn job_progress(id: u64) -> Value {
    let guard = JOBS.lock().unwrap_or_else(|e| e.into_inner());
    let Some(st) = guard.as_ref().and_then(|j| j.get(&id)) else {
        return json_err("任务不存在或已被清理");
    };
    serde_json::json!({
        "ok": true, "job": id, "kind": st.kind, "state": st.state,
        "done": st.done, "total": st.total, "current": st.current,
        "moved": st.moved, "freed_h": st.freed_h, "failed": st.failed,
        "result": st.result,
    })
}

/// 取消任务：停止处理后续项，已完成的保持不变（可从回收站还原）。
pub fn cancel_job(id: u64) -> Value {
    cancel(&format!("job-{id}"));
    serde_json::json!({ "ok": true })
}

fn dir_size(path: &Path) -> u64 {
    match std::fs::symlink_metadata(path) {
        Ok(m) if !m.is_dir() => m.len(),
        _ => {
            let mut stack = vec![path.to_path_buf()];
            let mut total: u64 = 0;
            while let Some(p) = stack.pop() {
                if let Ok(rd) = std::fs::read_dir(&p) {
                    for e in rd.flatten() {
                        let ep = e.path();
                        match std::fs::symlink_metadata(&ep) {
                            Ok(m) if m.is_dir() => stack.push(ep),
                            Ok(m) => total += m.len(),
                            _ => {}
                        }
                    }
                }
            }
            total
        }
    }
}
