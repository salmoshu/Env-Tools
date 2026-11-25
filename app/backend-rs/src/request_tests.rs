use super::*;
use tokio::{sync::oneshot, time::timeout};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);

#[tokio::test]
async fn client_timeout_does_not_duplicate_in_flight_work() {
    let cache = Arc::new(Cache::new());
    let (started, started_rx) = oneshot::channel();
    let (finish, finish_rx) = oneshot::channel();
    let first = tokio::spawn({
        let cache = cache.clone();
        async move {
            cache.get_or_fetch("analytics".into(), TEST_TIMEOUT, || async move {
                started.send(()).unwrap();
                finish_rx.await.unwrap();
                serde_json::json!({ "ok": true, "original": true })
            }).await
        }
    });
    timeout(TEST_TIMEOUT, started_rx).await.unwrap().unwrap();
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    finish.send(()).unwrap();
    let result = timeout(TEST_TIMEOUT, cache.get_or_fetch("analytics".into(), TEST_TIMEOUT, || async {
        panic!("request repeated the in-flight scan");
    })).await.unwrap();
    assert_eq!(result["original"], true);
}

#[tokio::test]
async fn cache_keeps_individual_ttl_and_retries_errors() {
    let cache = Cache::new();
    let usage = || async { serde_json::json!({ "ok": true, "data": true }) };
    cache.get_or_fetch("usage".into(), TEST_TIMEOUT, usage).await;
    let failed = cache.get_or_fetch("analysis".into(), TEST_TIMEOUT, || async {
        error_payload("temporary failure".into())
    }).await;
    assert_eq!(failed["ok"], false);
    let retried = cache.get_or_fetch("analysis".into(), Duration::ZERO, usage).await;
    assert_eq!(retried["ok"], true);
    let retained = cache.get_or_fetch("usage".into(), Duration::ZERO, || async {
        panic!("the analytics request must not expire the usage entry");
    }).await;
    assert_eq!(retained["data"], true);
}

#[tokio::test(flavor = "current_thread")]
async fn slow_analysis_does_not_block_invalidation_or_other_scopes() {
    let state = AppState {
        cache: Arc::new(Cache::new()),
        analytics: Arc::new(AnalyticsEngines::default()),
        token: None,
        last_activity: Arc::new(AtomicU64::new(0)),
    };
    let (started, started_rx) = oneshot::channel();
    let (finish, finish_rx) = std::sync::mpsc::channel();
    let running = tokio::spawn({
        let engines = state.analytics.clone();
        async move {
            engines.run("rolling:aggregate".into(), move |engine, _| {
                started.send(()).unwrap();
                finish_rx.recv_timeout(TEST_TIMEOUT).unwrap();
                engine.state.last_scan_secs = 123;
                engine.scan_finished = Some(Instant::now());
            }).await.unwrap();
        }
    });
    timeout(TEST_TIMEOUT, started_rx).await.unwrap().unwrap();
    let clearing = cache_clear(axum::extract::State(state.clone()));
    assert_eq!(timeout(TEST_TIMEOUT, clearing).await.unwrap().0["ok"], true);
    let local = state.analytics.run("local".into(), |_, scope| scope.to_owned());
    assert_eq!(timeout(TEST_TIMEOUT, local).await.unwrap().unwrap(), "local");
    finish.send(()).unwrap();
    running.await.unwrap();
    let scan_due = state.analytics.run("rolling:aggregate".into(), |engine, _| {
        engine.state.last_scan_secs == 0 && engine.scan_finished.is_none()
    }).await.unwrap();
    assert!(scan_due, "the in-flight scan must not swallow a refresh");
}
