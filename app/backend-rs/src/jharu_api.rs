use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;

use crate::jharu_host::AppHandle;

#[derive(Serialize)]
struct CleanOutcome {
    freed_bytes: u64,
    errors: Vec<String>,
}

async fn scan_system() -> Result<crate::scanner::ScanResult, String> {
    tokio::task::spawn_blocking(|| {
        let _busy = crate::autocare::activity();
        crate::scanner::scan()
    })
    .await
    .map_err(|e| e.to_string())
}

async fn clean_paths(paths: Vec<String>, source: Option<String>) -> Result<CleanOutcome, String> {
    tokio::task::spawn_blocking(move || {
        let _busy = crate::autocare::activity();
        let mut freed = 0u64;
        let mut errors = vec![];
        for raw in paths {
            let path = PathBuf::from(&raw);
            if !path.exists() {
                continue;
            }
            let size = crate::usage::reclaimable(&path);
            match crate::trashlog::to_bin(std::slice::from_ref(&path)) {
                Ok(()) => {
                    freed += size;
                    crate::trashlog::record(&path, size, source.as_deref().unwrap_or("Env-Tools"));
                }
                Err(e) if path.exists() && e.to_string().contains("aborted") => errors.push(format!(
                    "{raw}: something inside is open in another program, so nothing was moved. Close programs that may be using it and try again."
                )),
                Err(e) => errors.push(format!("{raw}: {e}")),
            }
        }
        CleanOutcome { freed_bytes: freed, errors }
    })
    .await
    .map_err(|e| e.to_string())
}

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    let value = args.get(name).ok_or_else(|| format!("missing argument: {name}"))?;
    serde_json::from_value(value.clone()).map_err(|e| format!("invalid argument {name}: {e}"))
}

fn optional<T: DeserializeOwned>(args: &Value, name: &str) -> Result<Option<T>, String> {
    match args.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => serde_json::from_value(value.clone())
            .map(Some)
            .map_err(|e| format!("invalid argument {name}: {e}")),
    }
}

fn response<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|e| e.to_string()))
}

fn value<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

pub async fn execute(command: &str, args: Value) -> Result<Value, String> {
    let app = AppHandle;
    match command {
        "scan_system" => response(scan_system().await),
        "clean_paths" => response(clean_paths(arg(&args, "paths")?, optional(&args, "source")?).await),
        "reclaimable_size" => {
            let path: String = arg(&args, "path")?;
            response(
                tokio::task::spawn_blocking(move || crate::usage::reclaimable(&PathBuf::from(path)))
                    .await
                    .map_err(|e| e.to_string()),
            )
        }
        "deep_scan" => response(crate::deep::deep_scan(app, optional(&args, "path")?, arg(&args, "token")?).await),
        "browser_scan" => response(crate::browsers::browser_scan().await),
        "list_apps" => response(crate::apps::list_apps().await),
        "app_leftovers" => response(
            crate::apps::app_leftovers(optional(&args, "bundle_id")?, arg(&args, "name")?).await,
        ),
        "run_uninstaller" => response(crate::apps::run_uninstaller(arg(&args, "command")?).await),
        "drive_health" => response(crate::health::drive_health(app).await),
        "junk_scan" => response(crate::junk::junk_scan().await),
        "model_scan" => response(crate::models::model_scan().await),
        "python_scan" => response(crate::python::python_scan().await),
        "desktop_scan" => response(crate::desktop::desktop_scan().await),
        "move_to_folder" => response(
            crate::desktop::move_to_folder(arg(&args, "paths")?, arg(&args, "destination")?).await,
        ),
        "worktree_scan" => response(crate::worktrees::worktree_scan().await),
        "remove_worktrees" => response(
            crate::worktrees::remove_worktrees(app, arg(&args, "items")?, arg(&args, "token")?).await,
        ),
        "clean_locations" => response(
            crate::cleaning::clean_locations(app, arg(&args, "ids")?, arg(&args, "token")?).await,
        ),
        "bin_list" => response(crate::bin::bin_list().await),
        "bin_log" => response(crate::bin::bin_log().await),
        "bin_purge" => response(
            crate::bin::bin_purge(
                app,
                arg(&args, "items")?,
                arg(&args, "scope")?,
                optional(&args, "days")?,
                arg(&args, "token")?,
            )
            .await,
        ),
        "bin_restore" => response(
            crate::bin::bin_restore(app, arg(&args, "ids")?, arg(&args, "token")?).await,
        ),
        "bin_cancel" => {
            crate::bin::bin_cancel(arg(&args, "token")?);
            value(())
        }
        "build_scan" => response(
            crate::projects::build_scan(app, arg(&args, "extra_roots")?, arg(&args, "token")?).await,
        ),
        "remove_build_folders" => response(
            crate::projects::remove_build_folders(app, arg(&args, "items")?, arg(&args, "token")?).await,
        ),
        "cancel_build_work" => {
            crate::projects::cancel_build_work(arg(&args, "token")?);
            value(())
        }
        "system_space_scan" => response(crate::system_space::system_space_scan().await),
        "system_space_inspect" => response(
            crate::system_space::system_space_inspect(app, arg(&args, "item_id")?, arg(&args, "token")?).await,
        ),
        "system_space_run" => response(
            crate::system_space::system_space_run(app, arg(&args, "action_id")?, arg(&args, "token")?).await,
        ),
        "system_space_cancel" => {
            crate::system_space::system_space_cancel(arg(&args, "token")?);
            value(())
        }
        "dupes_default_roots" => value(crate::dupes::dupes_default_roots()),
        "dupes_check_folder" => response(crate::dupes::dupes_check_folder(arg(&args, "path")?)),
        "dupes_scan" => response(
            crate::dupes::dupes_scan(app, arg(&args, "request")?, arg(&args, "token")?).await,
        ),
        "dupes_remove" => response(
            crate::dupes::dupes_remove(app, arg(&args, "groups")?, arg(&args, "token")?).await,
        ),
        "dupes_cancel" => {
            crate::dupes::dupes_cancel(arg(&args, "token")?);
            value(())
        }
        "history_overview" => response(crate::spacehistory::history_overview(app).await),
        "history_compare" => response(
            crate::spacehistory::history_compare(app, optional(&args, "root")?, optional(&args, "from_ts")?).await,
        ),
        "history_forecasts" => response(crate::spacehistory::history_forecasts(app).await),
        "history_verdict" => response(crate::spacehistory::history_verdict(arg(&args, "path")?).await),
        "history_snapshot_now" => response(
            crate::spacehistory::history_snapshot_now(app, optional(&args, "root")?).await,
        ),
        "history_cancel" => {
            crate::spacehistory::history_cancel();
            value(())
        }
        "autocare_set" => response(crate::autocare::autocare_set(app, arg(&args, "settings")?).await),
        "autocare_preview" => response(
            crate::autocare::autocare_preview(app, optional(&args, "settings")?).await,
        ),
        "autocare_run_now" => response(
            crate::autocare::autocare_run_now(app, arg(&args, "paths")?, optional(&args, "settings")?).await,
        ),
        "autocare_test_alert" => response(crate::autocare::autocare_test_alert(app)),
        "sandbox_scan" => response(crate::sandboxes::sandbox_scan(app, arg(&args, "token")?).await),
        "remove_sandbox_items" => response(
            crate::sandboxes::remove_sandbox_items(app, arg(&args, "items")?, arg(&args, "token")?).await,
        ),
        "cancel_sandbox_task" => {
            crate::sandboxes::cancel_sandbox_task(arg(&args, "token")?);
            value(())
        }
        "ai_tools_scan" => response(crate::ai_tools::ai_tools_scan().await),
        "remove_ai_leftovers" => response(
            crate::ai_tools::remove_ai_leftovers(app, arg(&args, "items")?, arg(&args, "token")?).await,
        ),
        "cancel_ai_removal" => {
            crate::ai_tools::cancel_ai_removal(arg(&args, "token")?);
            value(())
        }
        "startup_scan" => response(crate::startup::startup_scan().await),
        "set_startup_enabled" => response(
            crate::startup::set_startup_enabled(arg(&args, "ids")?, arg(&args, "enable")?).await,
        ),
        "overview_quick" => response(crate::overview::overview_quick(app).await),
        "overview_cleanable" => response(crate::overview::overview_cleanable().await),
        "overview_star_done" => response(crate::overview::overview_star_done(app).await),
        "process_list" => response(crate::processes::process_list().await),
        "process_close" => response(
            crate::processes::process_close(app, arg(&args, "items")?, arg(&args, "token")?).await,
        ),
        "process_force_quit" => response(crate::processes::process_force_quit(arg(&args, "items")?).await),
        "process_cancel" => {
            crate::processes::process_cancel(arg(&args, "token")?);
            value(())
        }
        "gadget_get" => response(crate::gadget::gadget_get()),
        "gadget_set" => response(crate::gadget::gadget_set(arg(&args, "enabled")?, arg(&args, "mode")?)),
        "gadget_position" => response(crate::gadget::gadget_position(optional(&args, "right")?, optional(&args, "y")?)),
        "gadget_snapshot" => response(crate::gadget::gadget_snapshot().await),
        _ => Err(format!("unknown disk command: {command}")),
    }
}
