use dbmanager_lib::{database::Session, models::*, service::AppState, sqlite};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc, time::Duration};

#[tokio::test]
async fn cancel_interrupts_real_sqlite_query() {
    let tmp = tempfile::tempdir().unwrap();
    let profile = ConnectionProfile {
        file_path: tmp
            .path()
            .join("cancel.sqlite")
            .to_string_lossy()
            .to_string(),
        ..Default::default()
    };
    let session = Arc::new(Session::open(profile, String::new()).await.unwrap());
    let worker = session.clone();
    let running = tokio::spawn(async move {
        worker.execute("WITH RECURSIVE n(x)AS(VALUES(1)UNION ALL SELECT x+1 FROM n WHERE x<1000000000)SELECT SUM(x) FROM n",BTreeMap::new()).await
    });
    tokio::time::sleep(Duration::from_millis(60)).await;
    session.cancel().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(3), running)
        .await
        .unwrap()
        .unwrap();
    assert!(result.is_err());
}
#[test]
fn million_rows_are_bounded_without_losing_duplicate_columns() {
    let c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);WITH RECURSIVE n(x)AS(VALUES(1)UNION ALL SELECT x+1 FROM n WHERE x<1000000)INSERT INTO t SELECT x,'record '||x FROM n;").unwrap();
    let r = sqlite::execute(&c, "SELECT id,id AS id FROM t", &BTreeMap::new(), true).unwrap();
    assert_eq!(r.sets[0].rows.len(), 10000);
    assert!(r.sets[0].truncated);
    assert_eq!(r.sets[0].rows[0].len(), 2);
}
#[tokio::test]
async fn laboratory_schema_generates_all_languages_and_checks_exercises() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path().into()).unwrap();
    let opened = state
        .call("lab_open", json!({"engine":"sqlite","dataset":"shop"}))
        .await
        .unwrap();
    let id = opened["sessionId"].as_str().unwrap();
    let schema = state
        .call("introspect", json!({"sessionId":id}))
        .await
        .unwrap();
    let table = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["name"] == "customers")
        .unwrap();
    assert_eq!(table["columns"][0]["nullable"], false);
    for language in [
        "rust",
        "python",
        "javascript",
        "typescript",
        "php",
        "java",
        "csharp",
        "c",
        "cpp",
        "go",
        "kotlin",
        "ruby",
    ] {
        let generated=state.call("generate_code",json!({"request":{"engine":"sqlite","language":language,"output":"project","table":"customers","query":"","columns":table["columns"],"educational":true}})).await.unwrap();
        assert!(!generated["files"].as_array().unwrap().is_empty());
    }
    let checked=state.call("lab_check",json!({"sessionId":id,"dataset":"shop","exerciseId":"filter","query":"SELECT id,name FROM customers WHERE city='Udine' ORDER BY id DESC;"})).await.unwrap();
    assert_eq!(checked["passed"], true);
    let boot = state.call("bootstrap", json!({})).await.unwrap();
    assert_eq!(boot["profiles"].as_array().unwrap().len(), 1);
}
#[test]
fn grid_savepoint_does_not_commit_editor_transaction() {
    let mut c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);INSERT INTO t VALUES(1,'original');BEGIN;UPDATE t SET v='pending' WHERE id=1;").unwrap();
    let key = BTreeMap::from([("id".into(), CellValue::string("integer", 1))]);
    let original = BTreeMap::from([("v".into(), CellValue::string("text", "pending"))]);
    let values = BTreeMap::from([("v".into(), CellValue::string("text", "grid"))]);
    sqlite::apply(
        &mut c,
        "t",
        &[DataChange {
            kind: "update".into(),
            key,
            original,
            values,
        }],
    )
    .unwrap();
    assert!(!c.is_autocommit());
    c.execute_batch("ROLLBACK").unwrap();
    assert_eq!(
        c.query_row("SELECT v FROM t", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "original"
    );
}
#[test]
fn inserts_do_not_require_a_primary_key() {
    let mut c = rusqlite::Connection::open_in_memory().unwrap();
    c.execute_batch("CREATE TABLE logs(message TEXT)").unwrap();
    let values = BTreeMap::from([("message".into(), CellValue::string("text", "hello"))]);
    let r = sqlite::apply(
        &mut c,
        "logs",
        &[DataChange {
            kind: "insert".into(),
            key: BTreeMap::new(),
            original: BTreeMap::new(),
            values,
        }],
    )
    .unwrap();
    assert_eq!(r.affected_rows, 1);
}

#[tokio::test]
async fn sql_transfer_roundtrip_is_not_json_and_exports_respect_limits() {
    let tmp = tempfile::tempdir().unwrap();
    let state = AppState::new(tmp.path().into()).unwrap();
    let lab = state
        .call("lab_open", json!({"engine":"sqlite","dataset":"shop"}))
        .await
        .unwrap();
    let id = lab["sessionId"].as_str().unwrap();
    let exported = state
        .call(
            "transfer_data",
            json!({"request":{"sessionId":id,"action":"export","format":"sql","scope":"database"}}),
        )
        .await
        .unwrap();
    let path = exported["path"].as_str().unwrap();
    let script = std::fs::read_to_string(path).unwrap();
    assert!(script.contains("CREATE TABLE customers"));
    assert!(script.contains("INSERT INTO"));
    assert!(script.contains("CREATE VIEW"));
    let profile = ConnectionProfile {
        id: "import-target".into(),
        name: "Import target".into(),
        file_path: tmp.path().join("imported.sqlite").to_string_lossy().into(),
        ..Default::default()
    };
    state.store.save_profile(&profile).unwrap();
    state
        .call(
            "open_session",
            json!({"profileId":"import-target","sessionId":"target"}),
        )
        .await
        .unwrap();
    let preview=state.call("transfer_data",json!({"request":{"sessionId":"target","action":"previewImport","format":"sql","path":path}})).await.unwrap();
    assert!(preview["bytes"].as_u64().unwrap() > 0);
    assert!(state
        .call(
            "transfer_data",
            json!({"request":{"sessionId":"target","action":"import","format":"sql","path":path}})
        )
        .await
        .is_err());
    state.call("transfer_data",json!({"request":{"sessionId":"target","action":"import","format":"sql","path":path,"confirmed":true}})).await.unwrap();
    let result = state
        .call(
            "read_table",
            json!({"sessionId":"target","table":"orders","limit":20}),
        )
        .await
        .unwrap();
    assert_eq!(result["sets"][0]["rows"].as_array().unwrap().len(), 5);
    for format in ["csv", "json"] {
        let result=state.call("transfer_data",json!({"request":{"sessionId":id,"action":"export","format":format,"table":"customers","limit":1}})).await.unwrap();
        assert_eq!(result["rows"], 1);
        let text = std::fs::read_to_string(result["path"].as_str().unwrap()).unwrap();
        if format == "csv" {
            assert_eq!(text.lines().count(), 2)
        } else {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(&text)
                    .unwrap()
                    .as_array()
                    .unwrap()
                    .len(),
                1
            )
        }
    }
}
