use dbmanager_lib::service::AppState;
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

async fn query(state: &AppState, command: &str, id: &str, sql: &str) -> Value {
    state
        .call(command, json!({"sessionId": id, "query": sql}))
        .await
        .unwrap()
}

#[tokio::test]
async fn separate_simulator_resets_without_persisting_profiles_or_history() {
    let root = tempfile::tempdir().unwrap();
    let setup = AppState::new(root.path().to_path_buf()).unwrap();
    let opened = setup
        .call("quick_query_open", json!({"dataset":"shop"}))
        .await
        .unwrap();
    let id = opened["sessionId"].as_str().unwrap();
    assert_eq!(opened["mode"], "synthetic");
    assert_eq!(opened["profile"]["filePath"], ":memory:");
    assert!(opened["schema"]["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "customers"));
    assert!(setup.session(id).await.is_err());
    let previous_history = setup.call("get_history", json!({})).await.unwrap();
    let written = setup.call("quick_query_execute", json!({"sessionId":id,"query":"DELETE FROM customers WHERE id=:id", "parameters":{"id":5}})).await.unwrap();
    assert_eq!(written["affectedRows"], 1);
    query(&setup, "quick_query_execute", id, "CREATE TABLE draft(value TEXT); CREATE TEMP TABLE tmp_draft(value TEXT); BEGIN; INSERT INTO draft VALUES('draft');").await;
    assert!(setup
        .call("quick_query_schema", json!({"sessionId":id}))
        .await
        .unwrap()["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "draft"));
    let reset = setup
        .call("quick_query_reset", json!({"sessionId":id}))
        .await
        .unwrap();
    assert_eq!(reset["sessionId"], id);
    assert!(!reset["schema"]["tables"]
        .as_array()
        .unwrap()
        .iter()
        .any(|t| t["name"] == "draft"));
    let returned = query(
        &setup,
        "quick_query_execute",
        id,
        "SELECT COUNT(*) AS n FROM customers; SELECT COUNT(*) AS n FROM temp.sqlite_master;",
    )
    .await;
    assert_eq!(returned["sets"][0]["rows"][0]["n"]["value"], "5");
    assert_eq!(returned["sets"][1]["rows"][0]["n"]["value"], "0");
    assert_eq!(
        previous_history,
        setup.call("get_history", json!({})).await.unwrap()
    );
    assert!(setup
        .call("quick_query_open", json!({"engine":"postgresql"}))
        .await
        .is_err());
    assert!(setup
        .call("quick_query_open", json!({"sourceSessionId":id}))
        .await
        .is_err());
    setup
        .call("quick_query_close", json!({"sessionId":id}))
        .await
        .unwrap();
    assert!(setup
        .call("quick_query_schema", json!({"sessionId":id}))
        .await
        .is_err());
}

#[tokio::test]
async fn sqlite_copy_preserves_snapshot_and_denies_file_access() {
    let root = tempfile::tempdir().unwrap();
    let setup = AppState::new(root.path().join("app")).unwrap();
    let file = root.path().join("source città.sqlite");
    let source = setup
        .call("create_workspace_sqlite", json!({"path":file}))
        .await
        .unwrap();
    let real = source["sessionId"].as_str().unwrap();
    query(
        &setup,
        "execute_query",
        real,
        "PRAGMA page_size=8192; VACUUM; CREATE TABLE records(note TEXT); INSERT INTO records VALUES ('originale');",
    )
    .await;
    query(
        &setup,
        "execute_query",
        real,
        "BEGIN; INSERT INTO records VALUES ('non confermato');",
    )
    .await;
    assert!(setup
        .call("quick_query_open", json!({"sourceSessionId":real}))
        .await
        .is_err());
    query(&setup, "execute_query", real, "ROLLBACK").await;
    let copied = setup
        .call("quick_query_open", json!({"sourceSessionId":real}))
        .await
        .unwrap();
    let id = copied["sessionId"].as_str().unwrap();
    assert_eq!(copied["mode"], "sqlite_copy");
    assert_ne!(id, real);
    assert!(setup
        .call(
            "quick_query_execute",
            json!({"sessionId":real,"query":"DELETE FROM records"})
        )
        .await
        .is_err());
    let attempted = root.path().join("prohibited.sqlite");
    let literal = attempted.to_string_lossy().replace('\'', "''");
    for sql in [
        format!("ATTACH DATABASE '{literal}' AS forbidden"),
        format!("VACUUM INTO '{literal}'"),
        "PRAGMA temp_store=FILE".into(),
        "PRAGMA hard_heap_limit=1".into(),
    ] {
        assert!(setup
            .call("quick_query_execute", json!({"sessionId":id,"query":sql}))
            .await
            .is_err());
        assert!(!attempted.exists());
    }
    query(
        &setup,
        "quick_query_execute",
        id,
        "UPDATE records SET note='simulata'",
    )
    .await;
    let source_read = query(&setup, "execute_query", real, "SELECT note FROM records").await;
    assert_eq!(
        source_read["sets"][0]["rows"][0]["note"]["value"],
        "originale"
    );
    query(
        &setup,
        "execute_query",
        real,
        "UPDATE records SET note='cambiata dopo la copia'",
    )
    .await;
    setup
        .call("quick_query_reset", json!({"sessionId":id}))
        .await
        .unwrap();
    let simulated_read = query(
        &setup,
        "quick_query_execute",
        id,
        "SELECT note FROM records",
    )
    .await;
    assert_eq!(
        simulated_read["sets"][0]["rows"][0]["note"]["value"],
        "originale"
    );
    let stored = rusqlite::Connection::open(&file).unwrap();
    let value: String = stored
        .query_row("SELECT note FROM records", [], |r| r.get(0))
        .unwrap();
    assert_eq!(value, "cambiata dopo la copia");
}

#[tokio::test]
async fn simulator_assistant_refuses_cloud_before_contacting_a_provider() {
    let root = tempfile::tempdir().unwrap();
    let setup = AppState::new(root.path().to_path_buf()).unwrap();
    let opened = setup.call("quick_query_open", json!({})).await.unwrap();
    setup.call("update_settings", json!({"settings":{"ai":{"provider":"openai-compatible","baseUrl":"https://example.invalid","model":"remote-model"}}})).await.unwrap();
    let error = setup.call("assistant_chat", json!({"request":{"quickSessionId":opened["sessionId"],"includeSchema":true,"message":"Descrivi lo schema"}})).await.unwrap_err();
    assert!(error.contains("solo Ollama locale"), "{error}");
}

#[tokio::test]
async fn cancel_targets_fresh_connection_after_a_simulator_reset() {
    let root = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new(root.path().to_path_buf()).unwrap());
    let opened = state.call("quick_query_open", json!({})).await.unwrap();
    let id = opened["sessionId"].as_str().unwrap().to_owned();
    state
        .call("quick_query_reset", json!({"sessionId":id}))
        .await
        .unwrap();
    let job = tokio::spawn({
        let state = state.clone();
        let id = id.clone();
        async move {
            state.call("quick_query_execute", json!({"sessionId":id,"query":"WITH RECURSIVE series(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM series WHERE i<1000000000) SELECT sum(i) FROM series"})).await
        }
    });
    let outcome = tokio::time::timeout(Duration::from_secs(5), async {
        while !job.is_finished() {
            tokio::time::sleep(Duration::from_millis(10)).await;
            state
                .call("quick_query_cancel", json!({"sessionId":id}))
                .await
                .unwrap();
        }
        job.await.unwrap()
    })
    .await
    .unwrap();
    assert!(outcome
        .unwrap_err()
        .to_ascii_lowercase()
        .contains("interrupt"));
    assert!(state
        .call("quick_query_schema", json!({"sessionId":id}))
        .await
        .is_ok());
}
