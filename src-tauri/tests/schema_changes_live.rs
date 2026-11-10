use dbmanager_lib::{database::Session, models::ConnectionProfile, schema_changes};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc};

#[tokio::test]
#[ignore = "Requires the explicitly started app-owned native QA supervisor; never uses user profiles."]
async fn schema_changes_roundtrip_four_real_servers() {
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/qa-active.json"))
            .unwrap(),
    )
    .unwrap();
    let mut results = Vec::new();
    for connection in manifest["connections"].as_array().unwrap() {
        let engine = connection["engine"].as_str().unwrap();
        let secret = keyring::Entry::new(
            connection["credentialService"].as_str().unwrap(),
            connection["credentialAccount"].as_str().unwrap(),
        )
        .unwrap()
        .get_password()
        .unwrap();
        let session = Arc::new(
            Session::open(
                ConnectionProfile {
                    id: connection["id"].as_str().unwrap().into(),
                    name: "QA schema".into(),
                    engine: engine.into(),
                    host: "127.0.0.1".into(),
                    port: connection["port"].as_u64().unwrap() as u16,
                    database: "laboratory".into(),
                    username: "dbm_lab".into(),
                    laboratory: true,
                    ..Default::default()
                },
                secret,
            )
            .await
            .unwrap(),
        );
        if engine == "mongodb" {
            let _ = session
                .execute(r#"{"drop":"dbm_schema_contract"}"#, BTreeMap::new())
                .await;
            let expected = session.introspect().await.unwrap();
            schema_changes::apply(session.clone(),expected,json!([{"create":"dbm_schema_contract"},{"createIndexes":"dbm_schema_contract","indexes":[{"key":{"name":1},"name":"idx_contract_name"}]}]).to_string(),false).await.unwrap();
            session
                .execute(
                    r#"{"insert":"dbm_schema_contract","documents":[{"_id":1,"name":"città €"}]}"#,
                    BTreeMap::new(),
                )
                .await
                .unwrap();
            let expected = session.introspect().await.unwrap();
            schema_changes::apply(session.clone(),expected,json!({"collMod":"dbm_schema_contract","validator":{"$jsonSchema":{"bsonType":"object","required":["name"],"properties":{"name":{"bsonType":"string"}}}},"validationLevel":"strict"}).to_string(),false).await.unwrap();
            assert!(session
                .execute(
                    r#"{"insert":"dbm_schema_contract","documents":[{"_id":2,"name":42}]}"#,
                    BTreeMap::new()
                )
                .await
                .is_err());
            session
                .execute(r#"{"drop":"dbm_schema_contract"}"#, BTreeMap::new())
                .await
                .unwrap();
        } else {
            session
                .execute("DROP TABLE IF EXISTS dbm_schema_contract", BTreeMap::new())
                .await
                .unwrap();
            let expected = session.introspect().await.unwrap();
            schema_changes::apply(session.clone(),expected,"-- Project header\nCREATE TABLE dbm_schema_contract(id INTEGER PRIMARY KEY,name VARCHAR(100));".into(),false).await.unwrap();
            session
                .execute(
                    "INSERT INTO dbm_schema_contract VALUES(1,'città €')",
                    BTreeMap::new(),
                )
                .await
                .unwrap();
            let before = session.introspect().await.unwrap();
            let modified=schema_changes::apply(session.clone(),before.clone(),"ALTER TABLE dbm_schema_contract RENAME COLUMN name TO display_name; ALTER TABLE dbm_schema_contract ADD COLUMN email VARCHAR(255); CREATE INDEX idx_dbm_contract_email ON dbm_schema_contract(email);".into(),false).await.unwrap();
            assert!(modified
                .tables
                .iter()
                .find(|t| t.name == "dbm_schema_contract")
                .unwrap()
                .columns
                .iter()
                .any(|c| c.name == "display_name"));
            let result = session
                .execute(
                    "SELECT display_name FROM dbm_schema_contract WHERE id=1",
                    BTreeMap::new(),
                )
                .await
                .unwrap();
            assert_eq!(result.sets[0].rows[0]["display_name"].text(), "città €");
            assert!(schema_changes::apply(
                session.clone(),
                before,
                "ALTER TABLE dbm_schema_contract ADD COLUMN stale INT".into(),
                false
            )
            .await
            .unwrap_err()
            .contains("cambiato"));
            if engine == "postgresql" {
                assert!(schema_changes::apply(session.clone(),modified.clone(),"ALTER TABLE dbm_schema_contract ADD COLUMN rolled_back TEXT; CREATE TABLE broken(;".into(),false).await.is_err());
                assert!(!session
                    .introspect()
                    .await
                    .unwrap()
                    .tables
                    .iter()
                    .find(|t| t.name == "dbm_schema_contract")
                    .unwrap()
                    .columns
                    .iter()
                    .any(|c| c.name == "rolled_back"));
                schema_changes::apply(session.clone(),modified,"ALTER TABLE dbm_schema_contract ALTER COLUMN display_name TYPE TEXT USING display_name::TEXT".into(),false).await.unwrap();
            }
            session
                .execute(
                    "BEGIN; INSERT INTO dbm_schema_contract(id,display_name) VALUES(2,'pending')",
                    BTreeMap::new(),
                )
                .await
                .unwrap();
            let current = session.introspect().await.unwrap();
            assert!(schema_changes::apply(
                session.clone(),
                current,
                "ALTER TABLE dbm_schema_contract ADD COLUMN blocked TEXT".into(),
                false
            )
            .await
            .unwrap_err()
            .contains("transazione"));
            session
                .execute("ROLLBACK; DROP TABLE dbm_schema_contract", BTreeMap::new())
                .await
                .unwrap();
        }
        eprintln!("Schema migration roundtrip: {engine} passed");
        results.push(json!({"engine":engine,"status":"passed"}));
    }
    std::fs::write(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/qa-schema-live-20261110.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
}
