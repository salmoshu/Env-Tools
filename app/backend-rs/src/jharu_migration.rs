use crate::autocare::{Settings, State};
use crate::spacehistory::{DriveReading, Record, Snapshot};
use serde_json::Value;
use std::io::Write;
use std::path::Path;

pub fn run() -> Result<(), String> {
    let new_dir = crate::jharu_host::app_data_dir().ok_or("cannot open Env-Tools data folder")?;
    let legacy_dir = crate::settings::local_home().join(".cache").join("ai-usage-monitor");
    if legacy_dir == new_dir {
        return Ok(());
    }
    migrate(&legacy_dir, &new_dir)
}

fn migrate(legacy_dir: &Path, new_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(new_dir).map_err(|e| e.to_string())?;
    migrate_settings(legacy_dir, new_dir)?;
    migrate_history(legacy_dir, new_dir)?;
    Ok(())
}

fn migrate_settings(legacy_dir: &Path, new_dir: &Path) -> Result<(), String> {
    let target = new_dir.join("space-settings.json");
    if target.exists() {
        return Ok(());
    }
    let legacy = legacy_dir.join("autocare.json");
    let Ok(text) = std::fs::read_to_string(legacy) else { return Ok(()) };
    let Ok(old) = serde_json::from_str::<Value>(&text) else { return Ok(()) };
    let interval = old["interval_hours"].as_u64().unwrap_or(6).clamp(1, 168) as u32;
    let low_space = old["alert_free_gb"].as_u64().unwrap_or(10).min(2000) as u32;
    let settings = Settings {
        check_hours: interval,
        alerts_enabled: low_space > 0,
        low_space_gb: low_space.max(1),
        clean_enabled: old["enabled"].as_bool().unwrap_or(false),
        clean_every_days: interval.div_ceil(24).clamp(1, 90),
        clean_idle_days: old["untouched_days"].as_u64().unwrap_or(7).clamp(1, 365) as u32,
    }
    .sanitized();
    crate::autocare::save_settings(new_dir, &settings).map_err(|e| e.to_string())?;
    if let Some(last_run) = old["last_run"].as_u64() {
        let state = State { last_check: 0, last_clean: last_run, last_alert: Default::default() };
        std::fs::write(new_dir.join("space-state.json"), serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn migrate_history(legacy_dir: &Path, new_dir: &Path) -> Result<(), String> {
    let target = new_dir.join("space-history.jsonl");
    if target.exists() {
        return Ok(());
    }
    let legacy = legacy_dir.join("space-history.jsonl");
    let Ok(text) = std::fs::read_to_string(legacy) else { return Ok(()) };
    let mut records = vec![];
    for line in text.lines() {
        let Ok(old) = serde_json::from_str::<Value>(line) else { continue };
        let Some(ts) = old["ts"].as_u64() else { continue };
        let drives: Vec<DriveReading> = old["drives"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|drive| {
                let mount = drive["mount"].as_str().or_else(|| drive["path"].as_str())?.to_string();
                let total = drive["total"].as_u64()?;
                let used = drive["used"].as_u64().unwrap_or_else(|| total.saturating_sub(drive["available"].as_u64().unwrap_or(0)));
                let free = drive["free"].as_u64().or_else(|| drive["available"].as_u64()).unwrap_or_else(|| total.saturating_sub(used));
                Some(DriveReading { mount, total, used, free, removable: drive["removable"].as_bool().unwrap_or(false) })
            })
            .collect();
        if drives.is_empty() {
            continue;
        }
        records.push(Record::Snapshot(Snapshot {
            ts,
            source: "legacy".into(),
            drives,
            root: None,
            folders: vec![],
            floor: 0,
            detail: vec![],
        }));
    }
    if records.is_empty() {
        return Ok(());
    }
    let tmp = new_dir.join("space-history.jsonl.migrating");
    let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    for record in records {
        let line = serde_json::to_string(&record).map_err(|e| e.to_string())?;
        writeln!(file, "{line}").map_err(|e| e.to_string())?;
    }
    drop(file);
    std::fs::rename(&tmp, target).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_settings_and_drive_readings_without_overwriting() {
        let root = std::env::temp_dir().join(format!("env-tools disk migration {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let legacy = root.join("legacy");
        let new = root.join("new");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(
            legacy.join("autocare.json"),
            r#"{"enabled":true,"interval_hours":12,"alert_free_gb":25,"untouched_days":14,"last_run":123}"#,
        )
        .unwrap();
        std::fs::write(
            legacy.join("space-history.jsonl"),
            r#"{"ts":100,"drives":[{"path":"C:\\","total":1000,"used":600,"available":400}]}"#,
        )
        .unwrap();
        migrate(&legacy, &new).unwrap();
        let settings = crate::autocare::load_settings(&new);
        assert!(settings.clean_enabled);
        assert_eq!(settings.check_hours, 12);
        assert_eq!(settings.low_space_gb, 25);
        assert_eq!(settings.clean_idle_days, 14);
        assert_eq!(crate::autocare::load_state(&new).last_clean, 123);
        let records = crate::spacehistory::load(&new);
        assert_eq!(records.len(), 1);
        let Record::Snapshot(snapshot) = &records[0] else { panic!("snapshot expected") };
        assert_eq!(snapshot.drives[0].mount, "C:\\");
        assert_eq!(snapshot.drives[0].free, 400);
        std::fs::write(new.join("space-settings.json"), "{}").unwrap();
        migrate(&legacy, &new).unwrap();
        assert_eq!(std::fs::read_to_string(new.join("space-settings.json")).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(root);
    }
}
