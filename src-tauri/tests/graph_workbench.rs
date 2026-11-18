use dbmanager_lib::{database::Session, models::ConnectionProfile, service::AppState};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};

async fn query(state: &AppState, id: &str, text: &str) -> Value {
    state
        .call("execute_query", json!({"sessionId":id,"query":text}))
        .await
        .unwrap()
}

async fn preview(state: &AppState, id: &str, operation: &Value) -> Value {
    state
        .call(
            "preview_graph_write",
            json!({"sessionId":id,"operation":operation}),
        )
        .await
        .unwrap()
}

async fn execute(
    state: &AppState,
    id: &str,
    operation: &Value,
    preview: &Value,
) -> Result<Value, String> {
    state
        .call(
            "execute_graph_write",
            json!({"sessionId":id,"operation":operation,"fingerprint":preview["fingerprint"]}),
        )
        .await
}

#[tokio::test]
async fn sqlite_creation_and_graph_preview_are_explicit() {
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().join("settings")).unwrap();
    let path = dir.path().join("nuovo città.sqlite");
    let profile = ConnectionProfile {
        file_path: path.to_string_lossy().into_owned(),
        create_if_missing: true,
        ..Default::default()
    };
    assert!(state
        .call("test_connection", json!({"profile":profile}))
        .await
        .is_err());
    assert!(!path.exists());
    let opened = state
        .call("create_workspace_sqlite", json!({"path":path}))
        .await
        .unwrap();
    assert!(state
        .call("create_workspace_sqlite", json!({"path":path}))
        .await
        .is_err());
    let id = opened["sessionId"].as_str().unwrap();
    query(&state, id, "CREATE TABLE \"people.archive\" (id INTEGER PRIMARY KEY, name TEXT DEFAULT 'Anonimo', slug TEXT GENERATED ALWAYS AS (lower(name)) VIRTUAL)").await;
    let insert = json!({"table":{"name":"people.archive"},"kind":"insert","values":{}});
    let prepared = preview(&state, id, &insert).await;
    assert!(prepared["query"]
        .as_str()
        .unwrap()
        .contains("DEFAULT VALUES"));
    assert_eq!(
        execute(&state, id, &insert, &prepared).await.unwrap()["affectedRows"],
        1
    );
    assert!(execute(&state, id, &insert, &prepared).await.is_err());
    let update = json!({"table":{"name":"people.archive"},"kind":"update","filters":[{"column":"id","operator":"=","value":{"type":"integer","value":"1"}}],"values":{"name":{"type":"text","value":"Città ' €"}}});
    let prepared = preview(&state, id, &update).await;
    assert!(!prepared["query"].as_str().unwrap().contains("Città"));
    let mut changed = update.clone();
    changed["values"]["name"]["value"] = json!("Non approvato");
    assert!(execute(&state, id, &changed, &prepared).await.is_err());
    let prepared = preview(&state, id, &update).await;
    assert_eq!(
        execute(&state, id, &update, &prepared).await.unwrap()["affectedRows"],
        1
    );
    let read = state
        .call(
            "read_table",
            json!({"sessionId":id,"table":{"name":"people.archive"}}),
        )
        .await
        .unwrap();
    assert_eq!(read["sets"][0]["rows"][0]["name"]["value"], "Città ' €");
    assert_eq!(read["sets"][0]["columns"][0]["identity"], true);
    assert_eq!(read["sets"][0]["columns"][2]["generated"], true);
    assert!(state
        .call(
            "preview_graph_write",
            json!({"sessionId":id,"operation":{"table":{"name":"people.archive"},"kind":"delete"}})
        )
        .await
        .is_err());
}

#[tokio::test]
#[ignore = "Requires the app-owned native QA supervisor and its synthetic databases."]
async fn graph_writes_and_qualified_schema_cover_four_native_servers() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/qa-active.json");
    let manifest: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::new(dir.path().to_path_buf()).unwrap();
    for connection in manifest["connections"].as_array().unwrap() {
        let engine = connection["engine"].as_str().unwrap();
        eprintln!("Grafo e introspezione: {engine}");
        let id = connection["id"].as_str().unwrap();
        let secret = keyring::Entry::new(
            connection["credentialService"].as_str().unwrap(),
            connection["credentialAccount"].as_str().unwrap(),
        )
        .unwrap()
        .get_password()
        .unwrap();
        let profile = ConnectionProfile {
            id: id.into(),
            engine: engine.into(),
            host: "127.0.0.1".into(),
            port: connection["port"].as_u64().unwrap() as u16,
            database: "laboratory".into(),
            username: "dbm_lab".into(),
            laboratory: true,
            ..Default::default()
        };
        let session = Arc::new(Session::open(profile, secret).await.unwrap());
        state
            .sessions
            .write()
            .await
            .insert(id.into(), session.clone());
        let target = match engine {
            "mongodb" => {
                let _ = state
                    .call(
                        "execute_query",
                        json!({"sessionId":id,"query":r#"{"drop":"dbm_graph_fixture"}"#}),
                    )
                    .await;
                query(&state, id, r#"{"create":"dbm_graph_fixture","validator":{"$jsonSchema":{"bsonType":"object","properties":{"name":{"bsonType":"string"}}}},"validationAction":"warn"}"#).await;
                let schema = session.introspect().await.unwrap();
                let col = schema
                    .tables
                    .iter()
                    .find(|table| table.name == "dbm_graph_fixture")
                    .unwrap();
                assert_eq!(col.kind, "collection");
                assert!(col.columns.is_empty());
                assert_eq!(
                    col.mongo.as_ref().unwrap().validation_action.as_deref(),
                    Some("warn")
                );
                json!({"name":"dbm_graph_fixture"})
            }
            "postgresql" => {
                query(&state, id, "DROP SCHEMA IF EXISTS dbm_graph_z CASCADE; DROP SCHEMA IF EXISTS dbm_graph_a CASCADE").await;
                query(&state, id, "CREATE SCHEMA dbm_graph_a; CREATE SCHEMA dbm_graph_z; CREATE TABLE dbm_graph_a.\"rows.v1\"(id BIGINT, part BIGINT, name TEXT, PRIMARY KEY(id,part)); CREATE TABLE dbm_graph_z.\"rows.v1\"(id BIGINT, part BIGINT, name TEXT, PRIMARY KEY(id,part), CONSTRAINT external_pair FOREIGN KEY(id,part) REFERENCES dbm_graph_a.\"rows.v1\"(id,part) ON UPDATE CASCADE); INSERT INTO dbm_graph_a.\"rows.v1\" VALUES(11,3,'originale'); INSERT INTO dbm_graph_z.\"rows.v1\" VALUES(11,3,'originale')").await;
                let schema = session.introspect().await.unwrap();
                let table = schema
                    .tables
                    .iter()
                    .find(|table| {
                        table.schema.as_deref() == Some("dbm_graph_z") && table.name == "rows.v1"
                    })
                    .unwrap();
                let fk = &table.foreign_keys[0];
                assert_eq!(fk.columns, ["id", "part"]);
                assert_eq!(fk.referenced_columns, ["id", "part"]);
                assert_eq!(fk.referenced_schema.as_deref(), Some("dbm_graph_a"));
                assert_eq!(fk.on_update.as_deref(), Some("CASCADE"));
                assert!(state
                    .call("read_table", json!({"sessionId":id,"table":"rows.v1"}))
                    .await
                    .is_err());
                let edit = json!({"sessionId":id,"table":{"schema":"dbm_graph_z","name":"rows.v1"},"changes":[{"kind":"update","key":{"id":{"type":"integer","value":"11"},"part":{"type":"integer","value":"3"}},"original":{"name":{"type":"text","value":"originale"}},"values":{"name":{"type":"text","value":"solo z"}}}]});
                assert_eq!(
                    state.call("apply_changes", edit).await.unwrap()["affectedRows"],
                    1
                );
                let prior = query(
                    &state,
                    id,
                    "SELECT name FROM dbm_graph_a.\"rows.v1\" WHERE id=11",
                )
                .await;
                assert_eq!(prior["sets"][0]["rows"][0]["name"]["value"], "originale");
                json!({"schema":"dbm_graph_z","name":"rows.v1"})
            }
            _ => {
                query(&state, id, "DROP TABLE IF EXISTS dbm_graph_fixture").await;
                query(
                    &state,
                    id,
                    "CREATE TABLE dbm_graph_fixture (id BIGINT PRIMARY KEY, name VARCHAR(100))",
                )
                .await;
                json!({"schema":"laboratory","name":"dbm_graph_fixture"})
            }
        };
        let insert = json!({"table":target,"kind":"insert","values":{"id":{"type":"integer","value":"9007199254740993"},"name":{"type":"text","value":"città €"},"part":{"type":"integer","value":"3"}}});
        let mut insert = insert;
        if engine != "postgresql" {
            insert["values"].as_object_mut().unwrap().remove("part");
        }
        let prepared = preview(&state, id, &insert).await;
        if engine == "postgresql" {
            // The table references a different schema. Create the same composite parent first.
            query(
                &state,
                id,
                "INSERT INTO dbm_graph_a.\"rows.v1\" VALUES(9007199254740993,3,'parent')",
            )
            .await;
        }
        assert_eq!(
            execute(&state, id, &insert, &prepared).await.unwrap()["affectedRows"],
            1
        );
        let filters = json!([{"column":"id","operator":"=","value":{"type":"integer","value":"9007199254740993"}}]);
        let update = json!({"table":target,"kind":"update","filters":filters,"values":{"name":{"type":"text","value":"aggiornato"}}});
        let prepared = preview(&state, id, &update).await;
        assert_eq!(
            execute(&state, id, &update, &prepared).await.unwrap()["affectedRows"],
            1
        );
        let delete = json!({"table":target,"kind":"delete","filters":filters});
        let prepared = preview(&state, id, &delete).await;
        assert_eq!(
            execute(&state, id, &delete, &prepared).await.unwrap()["affectedRows"],
            1
        );
    }
}
