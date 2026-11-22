use serde::Serialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const EVENT_LIMIT: usize = 4_000;

#[derive(Clone, Copy, Default)]
pub struct AppHandle;

#[derive(Clone)]
struct Event {
    id: u64,
    name: String,
    payload: Value,
}

static EVENTS: Mutex<VecDeque<Event>> = Mutex::new(VecDeque::new());
static NEXT_EVENT: AtomicU64 = AtomicU64::new(1);

pub trait Emitter {
    fn emit<T: Serialize>(&self, name: &str, payload: T) -> Result<(), String>;
}

impl Emitter for AppHandle {
    fn emit<T: Serialize>(&self, name: &str, payload: T) -> Result<(), String> {
        let payload = serde_json::to_value(payload).map_err(|e| e.to_string())?;
        let id = NEXT_EVENT.fetch_add(1, Ordering::Relaxed);
        let mut events = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
        events.push_back(Event { id, name: name.to_string(), payload });
        while events.len() > EVENT_LIMIT {
            events.pop_front();
        }
        Ok(())
    }
}

pub fn app() -> AppHandle {
    AppHandle
}

pub fn app_data_dir() -> Option<PathBuf> {
    let dir = std::env::var_os("ENVTOOLS_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::data_local_dir().map(|dir| dir.join("Env-Tools")))?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

pub fn events(after: u64) -> Value {
    let events = EVENTS.lock().unwrap_or_else(|e| e.into_inner());
    let items: Vec<Value> = events
        .iter()
        .filter(|event| event.id > after)
        .map(|event| {
            serde_json::json!({
                "id": event.id,
                "event": event.name,
                "payload": event.payload,
            })
        })
        .collect();
    let next = items.last().and_then(|event| event["id"].as_u64()).unwrap_or(after);
    serde_json::json!({ "ok": true, "events": items, "next": next })
}

pub fn notify(title: &str, body: &str) -> Result<(), String> {
    let notification = serde_json::json!({ "title": title, "body": body });
    let mut stdout = std::io::stdout().lock();
    writeln!(stdout, "ENVTOOLS_NOTIFICATION {notification}").map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())?;
    let _ = app().emit("desktop-notification", notification);
    Ok(())
}
