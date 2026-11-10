use dbmanager_lib::{
    database::Session,
    models::ConnectionProfile,
    service::AppState,
    workspace_files::{self, FileKind, InspectFileRequest},
};
use serde_json::json;
use std::collections::BTreeMap;

#[tokio::test]
async fn existing_sqlite_opens_readonly_reuses_profile_and_never_creates_a_typo() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("existing.db");
    let connection = rusqlite::Connection::open(&db).unwrap();
    connection.execute_batch("CREATE TABLE records(id INTEGER PRIMARY KEY,note TEXT); INSERT INTO records VALUES(1,'PRIVATE_ROW_NOT_IN_PREVIEW');").unwrap();
    drop(connection);
    let original = std::fs::read(&db).unwrap();
    let state = AppState::new(temp.path().join("app")).unwrap();
    let preview = state
        .call("inspect_workspace_file", json!({"path":db}))
        .await
        .unwrap();
    assert_eq!(preview["kind"], "sqlite");
    assert_eq!(preview["sqlite"]["tableCount"], 1);
    assert!(preview["content"].is_null());
    assert!(!preview.to_string().contains("PRIVATE_ROW_NOT_IN_PREVIEW"));
    let opened = state
        .call("open_existing_sqlite", json!({"path":db}))
        .await
        .unwrap();
    assert_eq!(opened["profile"]["readOnly"], true);
    assert_eq!(opened["profile"]["createIfMissing"], false);
    let id = opened["sessionId"].as_str().unwrap();
    assert!(state
        .session(id)
        .await
        .unwrap()
        .execute("INSERT INTO records VALUES(2,'blocked')", BTreeMap::new())
        .await
        .is_err());
    let again = state
        .call("open_existing_sqlite", json!({"path":db,"readOnly":true}))
        .await
        .unwrap();
    assert_eq!(again["profile"]["id"], opened["profile"]["id"]);
    let writable = state
        .call("open_existing_sqlite", json!({"path":db,"readOnly":false}))
        .await
        .unwrap();
    assert_ne!(writable["profile"]["id"], opened["profile"]["id"]);
    assert_eq!(state.store.profiles().unwrap().len(), 2);
    let missing = temp.path().join("typo.db");
    assert!(state
        .call("open_existing_sqlite", json!({"path":missing}))
        .await
        .is_err());
    assert!(!missing.exists());
    assert_eq!(std::fs::read(db).unwrap(), original);
}

#[tokio::test]
async fn sql_and_source_open_without_execution_and_recents_store_metadata_only() {
    let temp = tempfile::tempdir().unwrap();
    let sql = temp.path().join("instructions.sql");
    std::fs::write(
        &sql,
        "CREATE TABLE should_not_exist(id); -- SECRET_TEXT_CONTENT",
    )
    .unwrap();
    let source = temp.path().join("program.py");
    let marker = temp.path().join("executed.txt");
    std::fs::write(
        &source,
        format!(
            "open({:?},'w').write('executed')\n# SQL instructions are only text",
            marker.to_str().unwrap()
        ),
    )
    .unwrap();
    let state = AppState::new(temp.path().join("app")).unwrap();
    assert_eq!(
        state
            .call("inspect_workspace_file", json!({"path":sql}))
            .await
            .unwrap()["kind"],
        "sql"
    );
    assert_eq!(
        state
            .call("inspect_workspace_file", json!({"path":source}))
            .await
            .unwrap()["kind"],
        "source"
    );
    assert!(!marker.exists());
    assert_eq!(state.sessions.read().await.len(), 0);
    assert!(state.store.profiles().unwrap().is_empty());
    let recent = state
        .call("recent_workspace_files", json!({}))
        .await
        .unwrap();
    assert_eq!(recent.as_array().unwrap().len(), 2);
    assert!(!recent.to_string().contains("SECRET_TEXT_CONTENT"));
    assert!(recent[0].get("content").is_none());
    assert!(state
        .call("open_existing_sqlite", json!({"path":sql}))
        .await
        .is_err());
    state
        .call("clear_workspace_recents", json!({}))
        .await
        .unwrap();
    assert!(state.store.recent_workspace_files().unwrap().is_empty());
}

#[tokio::test]
async fn sqlite_creation_is_explicit_initializes_header_and_reopens_as_existing() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("new.sqlite");
    let mut profile = ConnectionProfile {
        file_path: path.to_string_lossy().into(),
        ..Default::default()
    };
    assert!(Session::open(profile.clone(), String::new()).await.is_err());
    assert!(!path.exists());
    profile.create_if_missing = true;
    let created = Session::open(profile, String::new()).await.unwrap();
    assert!(!created.profile.create_if_missing);
    drop(created);
    assert!(std::fs::read(&path)
        .unwrap()
        .starts_with(workspace_files::SQLITE_HEADER));
    let file = workspace_files::inspect_file(InspectFileRequest {
        path: path.to_string_lossy().into(),
        encoding: None,
    })
    .unwrap();
    assert_eq!(file.kind, FileKind::Sqlite);
    assert_eq!(file.sqlite.unwrap().table_count, 0);
    let state = AppState::new(temp.path().join("app")).unwrap();
    state
        .call("open_existing_sqlite", json!({"path":path}))
        .await
        .unwrap();
    let blank = temp.path().join("arbitrary-empty.db");
    std::fs::write(&blank, []).unwrap();
    assert!(state
        .call("open_existing_sqlite", json!({"path":blank}))
        .await
        .is_err());
    assert_eq!(std::fs::metadata(blank).unwrap().len(), 0);
}

#[tokio::test]
async fn text_save_rpc_uses_fingerprints_and_save_as_does_not_overwrite() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("query.sql");
    let state = AppState::new(temp.path().join("app")).unwrap();
    let saved=state.call("save_workspace_text",json!({"path":path,"content":"SELECT 1;\r\n","encoding":"utf-16le-bom","expectedFingerprint":null})).await.unwrap();
    assert_eq!(saved["encoding"], "utf-16le-bom");
    state.call("save_workspace_text",json!({"path":saved["path"],"content":"SELECT 2;\r\n","encoding":saved["encoding"],"expectedFingerprint":saved["fingerprint"]})).await.unwrap();
    assert!(state.call("save_workspace_text",json!({"path":saved["path"],"content":"SELECT 3;","encoding":"utf-8","expectedFingerprint":saved["fingerprint"]})).await.is_err());
    assert!(state.call("save_workspace_text",json!({"path":saved["path"],"content":"SELECT 4;","encoding":"utf-8","expectedFingerprint":null})).await.is_err());
}

#[tokio::test]
async fn startup_queue_deduplicates_and_drains_without_opening_or_executing() {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("request.sql");
    std::fs::write(&source, "DELETE FROM anything;").unwrap();
    let state = AppState::new(temp.path().join("app")).unwrap();
    let args = vec![
        "app.exe".into(),
        "request.sql".into(),
        "request.sql".into(),
        "--flag".into(),
    ];
    assert_eq!(state.queue_workspace_arguments(&args, temp.path()), 1);
    let requests = state
        .call("read_workspace_open_requests", json!({}))
        .await
        .unwrap();
    assert_eq!(requests.as_array().unwrap().len(), 1);
    assert!(state
        .call("read_workspace_open_requests", json!({}))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    assert!(state.sessions.read().await.is_empty());
}
