use dbmanager_lib::service::AppState;
use serde_json::{json, Value};

async fn setup(read_only: bool) -> (tempfile::TempDir, AppState, String) {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("fixture.db");
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE people(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL); INSERT INTO people(id,name) VALUES(1,'città €'),(99,'high water'); DELETE FROM people WHERE id=99;").unwrap();
    drop(conn);
    let app = AppState::new(temp.path().join("workspace")).unwrap();
    let opened = app
        .call(
            "open_existing_sqlite",
            json!({"path":path,"readOnly":read_only}),
        )
        .await
        .unwrap();
    let session = opened["sessionId"].as_str().unwrap().to_string();
    (temp, app, session)
}
async fn schema(app: &AppState, id: &str) -> Value {
    app.call("introspect", json!({"sessionId":id}))
        .await
        .unwrap()
}

#[tokio::test]
async fn schema_plan_is_atomic_checks_drift_and_preserves_sequences() {
    let (_temp, app, id) = setup(false).await;
    let before = schema(&app, &id).await;
    let rebuild="CREATE TABLE __tmp(id INTEGER PRIMARY KEY AUTOINCREMENT,display_name TEXT NOT NULL UNIQUE); INSERT INTO __tmp SELECT id,name FROM people; DROP TABLE people; ALTER TABLE __tmp RENAME TO people;";
    app.call("apply_schema_changes",json!({"sessionId":id,"confirmed":true,"expectedSchema":before,"script":rebuild,"rebuildSqlite":true})).await.unwrap();
    let result=app.call("execute_query",json!({"sessionId":id,"query":"INSERT INTO people(display_name) VALUES('next'); SELECT id,display_name FROM people ORDER BY id"})).await.unwrap();
    assert_eq!(
        result["sets"][0]["rows"][0]["display_name"]["value"],
        "città €"
    );
    assert_eq!(result["sets"][0]["rows"][1]["id"]["value"], "100");
    assert!(app.call("apply_schema_changes",json!({"sessionId":id,"confirmed":true,"expectedSchema":before,"script":"ALTER TABLE people ADD COLUMN stale TEXT"})).await.unwrap_err().contains("cambiato"));
    let expected = schema(&app, &id).await;
    assert!(app.call("apply_schema_changes",json!({"sessionId":id,"confirmed":true,"expectedSchema":expected,"script":"ALTER TABLE people ADD COLUMN extra TEXT; CREATE TABLE broken(;"})).await.is_err());
    assert_eq!(schema(&app, &id).await, expected);
    let fk = app
        .call(
            "execute_query",
            json!({"sessionId":id,"query":"PRAGMA foreign_keys"}),
        )
        .await
        .unwrap();
    assert_eq!(fk["sets"][0]["rows"][0]["foreign_keys"]["value"], "1");
}

#[tokio::test]
async fn schema_plan_refuses_unconfirmed_readonly_and_editor_transactions() {
    let (_temp, app, id) = setup(false).await;
    let expected = schema(&app, &id).await;
    let request = json!({"sessionId":id,"confirmed":true,"expectedSchema":expected,"script":"ALTER TABLE people ADD COLUMN extra TEXT"});
    let mut unconfirmed = request.clone();
    unconfirmed["confirmed"] = json!(false);
    assert!(app.call("apply_schema_changes", unconfirmed).await.is_err());
    app.call(
        "execute_query",
        json!({"sessionId":id,"query":"BEGIN; INSERT INTO people(name) VALUES('pending')"}),
    )
    .await
    .unwrap();
    assert!(app
        .call("apply_schema_changes", request)
        .await
        .unwrap_err()
        .contains("transazione"));
    app.call("execute_query", json!({"sessionId":id,"query":"ROLLBACK"}))
        .await
        .unwrap();
    let (_temp, readonly, id) = setup(true).await;
    assert!(readonly.call("apply_schema_changes",json!({"sessionId":id,"confirmed":true,"expectedSchema":schema(&readonly,&id).await,"script":"DROP TABLE people"})).await.unwrap_err().contains("sola lettura"));
}
