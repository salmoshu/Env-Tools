use crate::spacehistory;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    #[default]
    Bar,
    Card,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(default)]
pub struct Settings {
    /// Off by default: the gadget only exists when the user asks for it.
    pub enabled: bool,
    pub mode: Mode,
    /// Where the user last left it: `right` is its right edge, which stays
    /// put when it takes its content's width (gadget_fit), and `y` its top.
    /// Physical pixels, or points on macOS, where screens of different
    /// scales share one space of points. None puts it in the top-right
    /// corner of the main screen. Older versions saved the left edge as
    /// `x`; that is ignored, so the gadget starts top-right once.
    pub right: Option<i32>,
    pub y: Option<i32>,
}

fn settings_file(dir: &Path) -> PathBuf {
    dir.join("gadget.json")
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(settings_file(dir)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn save(dir: &Path, s: &Settings) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(settings_file(dir), serde_json::to_string_pretty(s).unwrap_or_default())
        .map_err(|e| format!("Could not save the gadget settings: {e}"))
}

fn dir_of() -> Result<PathBuf, String> {
    crate::jharu_host::app_data_dir().ok_or_else(|| "Env-Tools could not open its data folder.".to_string())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Program {
    pub name: String,
    /// Share of the whole machine, 0 to 100.
    pub cpu: f32,
    pub memory: u64,
    pub processes: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct Drive {
    pub mount: String,
    pub free: u64,
    pub total: u64,
    pub days_until_full: Option<u64>,
    /// Space history's sentence, or why there is no forecast yet.
    pub forecast: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Snapshot {
    pub cpu: f32,
    pub memory_used: u64,
    pub memory_total: u64,
    pub drive: Option<Drive>,
    /// Busiest programs by CPU, then memory. Env-Tools's own windows excluded.
    pub top: Vec<Program>,
    pub processes: usize,
}

/// One System kept between refreshes: CPU use is measured as the change
/// since the last refresh, so a fresh System would always read 0 %.
fn system() -> &'static Mutex<sysinfo::System> {
    static SYS: std::sync::OnceLock<Mutex<sysinfo::System>> = std::sync::OnceLock::new();
    SYS.get_or_init(|| Mutex::new(sysinfo::System::new()))
}

/// Groups processes by name and returns the busiest `n`. Idle pseudo
/// processes and this app itself are left out.
pub fn busiest(rows: &[(String, f32, u64)], cpus: usize, n: usize) -> Vec<Program> {
    let mut by: Vec<Program> = vec![];
    for (name, cpu, mem) in rows {
        let lower = name.to_lowercase();
        let key = lower.strip_suffix(".exe").unwrap_or(&lower);
        if matches!(key, "system idle process" | "idle" | "jharu" | "env-tools" | "env-tools-api" | "msedgewebview2" | "kernel_task") {
            continue;
        }
        let pretty = name.strip_suffix(".exe").unwrap_or(name).to_string();
        match by.iter_mut().find(|p| p.name.eq_ignore_ascii_case(&pretty)) {
            Some(p) => {
                p.cpu += cpu;
                p.memory += mem;
                p.processes += 1;
            }
            None => by.push(Program { name: pretty, cpu: *cpu, memory: *mem, processes: 1 }),
        }
    }
    // sysinfo gives each process up to 100 % per core.
    let cores = cpus.max(1) as f32;
    for p in &mut by {
        p.cpu = (p.cpu / cores).min(100.0);
    }
    by.sort_by(|a, b| b.cpu.total_cmp(&a.cpu).then(b.memory.cmp(&a.memory)));
    by.truncate(n);
    by
}

fn system_mount() -> String {
    #[cfg(target_os = "windows")]
    {
        format!("{}\\", std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()))
    }
    #[cfg(not(target_os = "windows"))]
    {
        "/".into()
    }
}

fn drive(dir: Option<&Path>) -> Option<Drive> {
    let mount = system_mount();
    let key = spacehistory::path_key(&mount);
    let reading = spacehistory::read_drives().into_iter().find(|d| spacehistory::path_key(&d.mount) == key)?;
    let forecast = dir.and_then(|dir| {
        spacehistory::forecasts(&spacehistory::load(dir), spacehistory::now())
            .into_iter()
            .find(|f| spacehistory::path_key(&f.mount) == key)
    });
    // "C:\" reads as "C:"; the root "/" stays "/".
    let shown = reading.mount.trim_end_matches(['\\', '/']);
    Some(Drive {
        mount: if shown.is_empty() { "/".into() } else { shown.into() },
        free: reading.free,
        total: reading.total,
        days_until_full: forecast.as_ref().and_then(|f| f.days_until_full),
        forecast: match forecast {
            // Space history's own sentence explains the readings it still
            // needs at length; the gadget has room for one line.
            Some(f) if f.confidence != "none" => f.summary,
            _ => "No forecast yet: it needs a few days of free-space readings.".into(),
        },
    })
}

fn snapshot_impl(dir: Option<&Path>) -> Snapshot {
    let mut sys = system().lock().unwrap_or_else(|e| e.into_inner());
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing().with_cpu().with_memory(),
    );
    let rows: Vec<(String, f32, u64)> =
        sys.processes().values().map(|p| (p.name().to_string_lossy().into_owned(), p.cpu_usage(), p.memory())).collect();
    Snapshot {
        cpu: sys.global_cpu_usage(),
        memory_used: sys.used_memory(),
        memory_total: sys.total_memory(),
        drive: drive(dir),
        top: busiest(&rows, sys.cpus().len(), 3),
        processes: rows.len(),
    }
}

pub fn gadget_get() -> Result<Settings, String> {
    Ok(load(&dir_of()?))
}

pub fn gadget_set(enabled: bool, mode: Mode) -> Result<Settings, String> {
    let dir = dir_of()?;
    let mut settings = load(&dir);
    settings.enabled = enabled;
    settings.mode = mode;
    save(&dir, &settings)?;
    Ok(settings)
}

pub fn gadget_position(right: Option<i32>, y: Option<i32>) -> Result<Settings, String> {
    let dir = dir_of()?;
    let mut settings = load(&dir);
    settings.right = right;
    settings.y = y;
    save(&dir, &settings)?;
    Ok(settings)
}

pub async fn gadget_snapshot() -> Result<Snapshot, String> {
    let dir = crate::jharu_host::app_data_dir();
    tokio::task::spawn_blocking(move || snapshot_impl(dir.as_deref()))
        .await
        .map_err(|e| e.to_string())
}
