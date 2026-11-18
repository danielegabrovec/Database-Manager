use dbmanager_lib::service::AppState;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

async fn execute(app: &AppState, id: &str, query: &str, parameters: Value) -> Value {
    app.call(
        "quick_query_execute",
        json!({"sessionId":id,"query":query,"parameters":parameters}),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn project_schema_seed_read_and_write_run_in_independent_scratch_databases() {
    let root = tempfile::tempdir().unwrap();
    let app = AppState::new(root.path().into()).unwrap();
    let left = app
        .call(
            "quick_query_open",
            json!({"engine":"sqlite","dataset":"empty"}),
        )
        .await
        .unwrap();
    let right = app
        .call(
            "quick_query_open",
            json!({"engine":"sqlite","dataset":"empty"}),
        )
        .await
        .unwrap();
    let left_id = left["sessionId"].as_str().unwrap();
    let right_id = right["sessionId"].as_str().unwrap();
    assert_ne!(left_id, right_id);
    assert_eq!(left["schema"]["tables"], json!([]));
    assert_eq!(right["schema"]["tables"], json!([]));

    execute(
        &app,
        left_id,
        "CREATE TABLE contacts(id INTEGER PRIMARY KEY, name TEXT NOT NULL);",
        json!({}),
    )
    .await;
    let schema = app
        .call("quick_query_schema", json!({"sessionId":left_id}))
        .await
        .unwrap();
    let seed = app.call("compile_project_write", json!({
        "schema": schema,
        "operation": {
            "kind":"insert", "table":{"name":"contacts"},
            "values":{"id":{"type":"integer","value":"1"},"name":{"type":"text","value":"Ada"}}
        }
    })).await.unwrap();
    execute(
        &app,
        left_id,
        seed["query"].as_str().unwrap(),
        seed["parameters"].clone(),
    )
    .await;
    let update = app.call("compile_project_write", json!({
        "schema": schema,
        "operation": {
            "kind":"update", "table":{"name":"contacts"},
            "filters":[{"column":"id","operator":"=","value":{"type":"integer","value":"1"}}],
            "values":{"name":{"type":"text","value":"René"}}
        }
    })).await.unwrap();
    let write = execute(
        &app,
        left_id,
        update["query"].as_str().unwrap(),
        update["parameters"].clone(),
    )
    .await;
    assert_eq!(write["affectedRows"], 1);
    let rows = execute(&app, left_id, "SELECT name FROM contacts;", json!({})).await;
    assert_eq!(rows["sets"][0]["rows"][0]["name"]["value"], "René");
    let untouched = app
        .call("quick_query_schema", json!({"sessionId":right_id}))
        .await
        .unwrap();
    assert_eq!(untouched["tables"], json!([]));

    for id in [left_id, right_id] {
        app.call("quick_query_close", json!({"sessionId": id}))
            .await
            .unwrap();
        assert!(app
            .call("quick_query_schema", json!({"sessionId":id}))
            .await
            .is_err());
    }
}

#[tokio::test]
async fn app_integration_reloads_interrupted_journal_and_preserves_manual_files() {
    let state = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let app = AppState::new(state.path().into()).unwrap();
    let package = json!({
        "root":root.path(),"projectId":"integrazione",
        "files":[{"path":"import.js","content":"generated"}],
    });
    let preview = app
        .call("preview_app_integration", package.clone())
        .await
        .unwrap();
    let scope = std::path::PathBuf::from(preview["destination"].as_str().unwrap());
    assert!(!scope.exists());
    let marker = scope.join(".dbm-state").join("pending.json");
    std::fs::create_dir_all(marker.parent().unwrap()).unwrap();
    let saved = scope.join("import.js");
    std::fs::write(&saved, "user edit").unwrap();
    std::fs::write(&marker, json!({
        "before_state":null,"after_state":hex::encode(Sha256::digest(b"incomplete")),
        "changes":[{"path":"import.js","before":null,"after":hex::encode(Sha256::digest(b"generated"))}],
        "discard_if_undone":null,"discard_if_committed":null,
    }).to_string()).unwrap();
    // Reload through a fresh application state, as a subsequent launch would do.
    let restarted = AppState::new(state.path().into()).unwrap();
    let interrupted = restarted
        .call("preview_app_integration", package.clone())
        .await
        .unwrap();
    assert_eq!(interrupted["interrupted"], true);
    let comparison = restarted
        .call("diff_app_integration", package.clone())
        .await
        .unwrap();
    assert_eq!(comparison["before"], "user edit");
    assert!(restarted
        .call("recover_app_integration", package.clone())
        .await
        .is_err());
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), "user edit");
    std::fs::write(&saved, "generated").unwrap();
    let recovered = restarted
        .call("recover_app_integration", package)
        .await
        .unwrap();
    assert_eq!(recovered["changed"], 1);
    assert!(!saved.exists());
    assert!(!marker.exists());
}

#[tokio::test]
#[ignore = "Requires the app-owned native QA supervisor and cached server packages."]
async fn project_transient_laboratories_on_four_native_servers() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts");
    let manifest: Value =
        serde_json::from_slice(&std::fs::read(root.join("qa-active.json")).unwrap()).unwrap();
    assert_eq!(manifest["status"], "active");
    let app = AppState::new(manifest["appData"].as_str().unwrap().into()).unwrap();
    let initial = app.environments.list().await.unwrap();
    for engine in ["postgresql", "mysql", "mariadb", "mongodb"] {
        assert!(initial.iter().any(|env| {
            serde_json::to_value(env.engine).unwrap() == engine && env.status == "running"
        }));
        let ddl = if engine == "mongodb" {
            r#"{"create":"dbm_project_rows"}"#
        } else {
            "CREATE TABLE dbm_project_rows(id INTEGER PRIMARY KEY, name VARCHAR(100) NOT NULL);"
        };
        let read = if engine == "mongodb" {
            r#"{"find":"dbm_project_rows","filter":{}}"#
        } else {
            "SELECT name FROM dbm_project_rows;"
        };
        let values = if engine == "mongodb" {
            json!({"name":{"type":"text","value":"Ada"}})
        } else {
            json!({"id":{"type":"integer","value":"1"},"name":{"type":"text","value":"Ada"}})
        };
        let report = app.call("test_project_remote", json!({
            "engine":engine,"ddl":ddl,
            "steps":[
                {"name":"Dato di prova","kind":"write","operation":{"table":{"name":"dbm_project_rows", "schema":if engine=="postgresql"{json!("public")}else{Value::Null}},"kind":"insert","values":values}},
                {"name":"Lettura","kind":"read","query":read,"params":{}}
            ]
        })).await.unwrap();
        eprintln!(
            "{engine}: {:?}",
            report["steps"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| (&s["name"], &s["status"], &s["detail"]))
                .collect::<Vec<_>>()
        );
        assert_eq!(report["steps"].as_array().unwrap().len(), 3);
        assert!(report["steps"]
            .as_array()
            .unwrap()
            .iter()
            .all(|step| step["status"] == "passed"));
        assert_eq!(
            report["steps"][2]["result"]["sets"][0]["rows"][0]["name"]["value"],
            "Ada"
        );
        assert_eq!(app.environments.list().await.unwrap().len(), initial.len());
    }
}
