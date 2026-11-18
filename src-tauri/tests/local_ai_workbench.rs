use axum::{
    body::{Body, Bytes},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use dbmanager_lib::service::AppState;
use serde_json::{json, Value};
use std::{convert::Infallible, time::Duration};

#[tokio::test]
async fn stop_cancels_a_pending_probe_and_disarms_delayed_automatic_start() {
    use std::sync::Arc;
    use tokio::sync::Notify;
    let probe_entered = Arc::new(Notify::new());
    let probe_release = Arc::new(Notify::new());
    let route = {
        let probe_entered = probe_entered.clone();
        let probe_release = probe_release.clone();
        Router::new().route(
            "/api/tags",
            get(move || {
                let probe_entered = probe_entered.clone();
                let probe_release = probe_release.clone();
                async move {
                    probe_entered.notify_one();
                    probe_release.notified().await;
                    Json(json!({"models":[]}))
                }
            }),
        )
    };
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, route).await.unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let app = Arc::new(AppState::new(temp.path().into()).unwrap());
    app.call(
        "local_ai_config",
        json!({"config":{
            "endpoint":format!("http://{address}"), "model":"", "startup":"automatic"
        }}),
    )
    .await
    .unwrap();
    let request_id = uuid::Uuid::new_v4().to_string();
    let launch = {
        let app = app.clone();
        let request_id = request_id.clone();
        tokio::spawn(async move {
            app.call(
                "local_ai_start",
                json!({"requestId":request_id,"automatic":true}),
            )
            .await
            .unwrap()
        })
    };
    tokio::time::timeout(Duration::from_secs(3), probe_entered.notified())
        .await
        .unwrap();
    // A cancellable startup must allow stopping while the HTTP probe is still waiting.
    tokio::time::timeout(
        Duration::from_millis(150),
        app.call(
            "local_ai_stop",
            json!({
                "cancelStart":request_id
            }),
        ),
    )
    .await
    .unwrap()
    .unwrap();
    probe_release.notify_one();
    assert_eq!(launch.await.unwrap()["accepted"], false);
    let delayed = app
        .call("local_ai_start", json!({"automatic":true}))
        .await
        .unwrap();
    assert_eq!(delayed["accepted"], false);
    let replayed = app
        .call("local_ai_start", json!({"requestId":request_id}))
        .await
        .unwrap();
    assert_eq!(replayed["accepted"], false);
    server.abort();
}

#[tokio::test]
async fn an_unreadable_chat_archive_does_not_block_database_manager() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("assistant-chats.sqlite"),
        b"invalid database",
    )
    .unwrap();
    let app = AppState::new(temp.path().into()).unwrap();
    assert!(app.call("bootstrap", json!({})).await.is_ok());
    assert!(app
        .call("local_ai_conversations", json!({"scope":"work"}))
        .await
        .is_err());
}

#[tokio::test]
async fn chat_streams_filters_models_cancels_and_persists_separate_scopes() {
    let application = Router::new()
        .route("/api/tags", get(|| async {
            Json(json!({"models":[{"name":"local-chat"},{"name":"embed-only"},{"name":"alias"}]}))
        }))
        .route("/api/show", post(|Json(request): Json<Value>| async move {
            Json(match request["model"].as_str() {
                Some("embed-only") => json!({"capabilities":["embedding"]}),
                Some("alias") => json!({"capabilities":["completion"],"remote_host":"https://test.invalid"}),
                _ => json!({"capabilities":["completion"],"details":{"family":"test"}}),
            })
        }))
        .route("/api/chat", post(|Json(request): Json<Value>| async move {
            assert_eq!(request["stream"], true);
            assert_eq!(request["model"], "local-chat");
            let wire = request.to_string();
            assert!(!wire.contains("PRIVATE_ROW_SENTINEL"));
            assert!(!wire.contains("UNSELECTED_QUERY_SENTINEL"));
            if wire.contains("Proponi un esempio.") {
                assert!(wire.contains("SELECTED_QUERY_SENTINEL"));
            }
            let mut first = br#"{"message":{"content":"Citt"#.to_vec();
            first.push(0xc3);
            let mut second = vec![0xa0];
            second.extend_from_slice(b"\"},\"done\":false}\n");
            let chunks = [
                (Duration::ZERO, first),
                (Duration::ZERO, second),
                (Duration::from_millis(350), b"{\"message\":{\"content\":\" locale\"},\"done\":true}\n".to_vec()),
            ];
            let stream = futures_util::stream::unfold(chunks.into_iter(), |mut pending| async move {
                let (delay, bytes) = pending.next()?;
                tokio::time::sleep(delay).await;
                Some((Ok::<Bytes, Infallible>(Bytes::from(bytes)), pending))
            });
            Response::builder().header("content-type", "application/x-ndjson")
                .body(Body::from_stream(stream)).unwrap()
        }));
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, application).await.unwrap() });
    let temp = tempfile::tempdir().unwrap();
    let app = AppState::new(temp.path().into()).unwrap();
    let mut config = app.call("local_ai_config", json!({})).await.unwrap();
    assert!(config["startup"].is_null());
    config["endpoint"] = json!(format!("http://127.0.0.1:{port}"));
    config["model"] = json!("local-chat");
    config["startup"] = json!("manual");
    app.call("local_ai_config", json!({"config":config}))
        .await
        .unwrap();
    let models = app.call("local_ai_models", json!({})).await.unwrap();
    assert_eq!(models.as_array().unwrap().len(), 1);
    assert_eq!(models[0]["name"], "local-chat");
    let request_id = uuid::Uuid::new_v4().to_string();
    let started = app
        .call(
            "local_ai_chat_start",
            json!({
                "scope":"work", "requestId":request_id, "message":"Come funziona una città?",
                "context":{"engine":"sqlite","query":"UNSELECTED_QUERY_SENTINEL","rows":[["PRIVATE_ROW_SENTINEL"]]}
            }),
        )
        .await
        .unwrap();
    let id = started["conversationId"].as_str().unwrap();
    let partial = wait_for(&app, &request_id, |value| value["content"] == "Città").await;
    assert_eq!(partial["status"], "running");
    let finished = wait_for(&app, &request_id, |value| value["status"] == "complete").await;
    assert_eq!(finished["content"], "Città locale");
    app.call(
        "local_ai_rename_conversation",
        json!({"id":id,"scope":"work","name":"Chat cittadina"}),
    )
    .await
    .unwrap();
    assert!(app
        .call("local_ai_conversation", json!({"id":id,"scope":"quick"}))
        .await
        .is_err());
    drop(app);
    let app = AppState::new(temp.path().into()).unwrap();
    let restored = app
        .call("local_ai_conversation", json!({"id":id,"scope":"work"}))
        .await
        .unwrap();
    assert_eq!(restored["name"], "Chat cittadina");
    assert_eq!(restored["turns"][0]["assistant"], "Città locale");
    let request_id = uuid::Uuid::new_v4().to_string();
    let started = app
        .call(
            "local_ai_chat_start",
            json!({
                "scope":"quick", "requestId":request_id, "message":"Proponi un esempio.",
                "context":{"includeQuery":true,"query":"SELECTED_QUERY_SENTINEL","rows":[["PRIVATE_ROW_SENTINEL"]]}
            }),
        )
        .await
        .unwrap();
    let quick = started["conversationId"].as_str().unwrap();
    wait_for(&app, &request_id, |value| value["content"] == "Città").await;
    app.call("local_ai_chat_cancel", json!({"requestId":request_id}))
        .await
        .unwrap();
    let cancelled = wait_for(&app, &request_id, |value| value["status"] == "cancelled").await;
    assert_eq!(cancelled["content"], "Città");
    let unsaved = app
        .call("local_ai_conversation", json!({"id":quick,"scope":"quick"}))
        .await
        .unwrap();
    assert!(unsaved["turns"].as_array().unwrap().is_empty());
    app.call(
        "local_ai_delete_conversation",
        json!({"id":id,"scope":"work"}),
    )
    .await
    .unwrap();
    assert!(app
        .call("local_ai_conversations", json!({"scope":"work"}))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    server.abort();
}

async fn wait_for(app: &AppState, id: &str, done: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let status = app
                .call("local_ai_chat_poll", json!({"requestId":id}))
                .await
                .unwrap();
            if done(&status) {
                return status;
            }
            assert_ne!(status["status"], "failed", "{status}");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap()
}

#[cfg(windows)]
#[tokio::test]
#[ignore = "Starts Ollama only on a fresh private loopback port, then stops that owned PID."]
async fn a_real_private_daemon_starts_and_stops_without_touching_shared_ollama() {
    let temp = tempfile::tempdir().unwrap();
    let app = AppState::new(temp.path().into()).unwrap();
    let reservation = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = reservation.local_addr().unwrap();
    let endpoint = format!("http://{address}");
    app.call(
        "local_ai_config",
        json!({"config":{
            "endpoint":endpoint,"model":"","startup":"manual","completionMode":"off"
        }}),
    )
    .await
    .unwrap();
    drop(reservation);
    let request = uuid::Uuid::new_v4().to_string();
    let starting = app
        .call("local_ai_start", json!({"requestId":request}))
        .await
        .unwrap();
    assert_eq!(starting["state"]["online"], false);
    assert_eq!(starting["state"]["ownership"], "owned");
    app.call("local_ai_stop", json!({"cancelStart":request}))
        .await
        .unwrap();
    assert_eq!(
        app.call("local_ai_status", json!({})).await.unwrap()["state"]["online"],
        false
    );
    app.call("local_ai_start", json!({})).await.unwrap();
    let status = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            let report = app.call("local_ai_status", json!({})).await.unwrap();
            if report["state"]["online"] == true {
                break report;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(status["state"]["online"], true);
    assert_eq!(status["state"]["ownership"], "owned");
    let fingerprint = status["state"]["stopFingerprint"].as_str().unwrap();
    assert!(app
        .call(
            "local_ai_stop",
            json!({"fingerprint":"stale","confirmed":false})
        )
        .await
        .is_err());
    app.call(
        "local_ai_stop",
        json!({"fingerprint":fingerprint,"confirmed":false}),
    )
    .await
    .unwrap();
    let status = app.call("local_ai_status", json!({})).await.unwrap();
    assert_eq!(status["state"]["online"], false);
}
