use dbmanager_lib::{database::Session, models::*, service::AppState};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc};
#[tokio::test]
#[ignore = "Requires app-owned servers from native_qa_supervisor; never connects to user profiles."]
async fn remote_adapters_live_contract() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/qa-active.json");
    let v: Value = serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
    for c in v["connections"].as_array().unwrap() {
        let engine = c["engine"].as_str().unwrap();
        eprintln!("Core adapter live: {engine}");
        let secret = keyring::Entry::new(
            c["credentialService"].as_str().unwrap(),
            c["credentialAccount"].as_str().unwrap(),
        )
        .unwrap()
        .get_password()
        .unwrap();
        let p = ConnectionProfile {
            id: c["id"].as_str().unwrap().into(),
            name: "QA core".into(),
            engine: engine.into(),
            host: "127.0.0.1".into(),
            port: c["port"].as_u64().unwrap() as u16,
            database: "laboratory".into(),
            username: "dbm_lab".into(),
            laboratory: true,
            ..Default::default()
        };
        let s = Arc::new(Session::open(p, secret).await.unwrap());
        if engine == "mongodb" {
            let _ = s
                .execute(r#"{"drop":"dbm_core_contract"}"#, BTreeMap::new())
                .await;
            let inserted=s.execute(r#"{"insert":"dbm_core_contract","documents":[{"_id":{"$oid":"507f1f77bcf86cd799439011"},"id":{"$numberLong":"9007199254740993"},"label":"Udine; città","amount":{"$numberDecimal":"12345678901234567890.1234567890"}}]}"#,BTreeMap::new()).await.unwrap();
            assert_eq!(inserted.affected_rows, 1);
            let r = s
                .execute(
                    r#"{"find":"dbm_core_contract","filter":{}}"#,
                    BTreeMap::new(),
                )
                .await
                .unwrap();
            let row = &r.sets[0].rows[0];
            assert_eq!(row["id"].text(), "9007199254740993");
            assert_eq!(row["amount"].text(), "12345678901234567890.1234567890");
            let mut key = BTreeMap::new();
            key.insert("_id".into(), row["_id"].clone());
            let mut values = BTreeMap::new();
            values.insert("label".into(), CellValue::string("text", "Aggiornato"));
            s.apply(
                "dbm_core_contract",
                vec![DataChange {
                    kind: "update".into(),
                    key,
                    original: row.clone(),
                    values,
                }],
            )
            .await
            .unwrap();
            s.execute(r#"{"drop":"dbm_core_contract"}"#, BTreeMap::new())
                .await
                .unwrap();
        } else {
            let q = quote_ident(engine, "dbm_core_contract");
            s.execute(&format!("DROP TABLE IF EXISTS {q}; CREATE TABLE {q}(id BIGINT PRIMARY KEY,label TEXT,amount DECIMAL(30,10));"),BTreeMap::new()).await.unwrap();
            let mut params = BTreeMap::new();
            let mut bind = Vec::new();
            for (i, val) in [
                json!("9007199254740993"),
                json!("Udine; città"),
                json!("12345678901234567890.1234567890"),
            ]
            .into_iter()
            .enumerate()
            {
                let k = if engine == "postgresql" {
                    (i + 1).to_string()
                } else {
                    format!("p{}", i + 1)
                };
                bind.push(if engine == "postgresql" {
                    format!("${k}")
                } else {
                    format!(":{k}")
                });
                params.insert(k, val);
            }
            s.execute(
                &format!("INSERT INTO {q} VALUES ({})", bind.join(",")),
                params,
            )
            .await
            .unwrap();
            let r = s
                .execute(&format!("SELECT * FROM {q}"), BTreeMap::new())
                .await
                .unwrap();
            let row = &r.sets[0].rows[0];
            assert_eq!(row["id"].text(), "9007199254740993");
            assert_eq!(row["amount"].text(), "12345678901234567890.1234567890");
            let binary = s
                .execute(
                    if engine == "postgresql" {
                        "SELECT decode('41420043','hex') AS bin"
                    } else {
                        "SELECT _binary 0x41420043 AS bin"
                    },
                    BTreeMap::new(),
                )
                .await
                .unwrap();
            assert_eq!(binary.sets[0].rows[0]["bin"].kind, "binary");
            assert_eq!(binary.sets[0].rows[0]["bin"].text(), "QUIAQw==");
            let schema = s.introspect().await.unwrap();
            assert!(schema
                .tables
                .iter()
                .find(|t| t.name == "dbm_core_contract")
                .unwrap()
                .columns
                .iter()
                .any(|c| c.name == "id" && c.primary_key));
            let mut key = BTreeMap::new();
            key.insert("id".into(), row["id"].clone());
            let mut values = BTreeMap::new();
            values.insert("label".into(), CellValue::string("text", "Aggiornato"));
            let change = DataChange {
                kind: "update".into(),
                key,
                original: row.clone(),
                values,
            };
            s.apply("dbm_core_contract", vec![change.clone()])
                .await
                .unwrap();
            assert!(s.apply("dbm_core_contract", vec![change]).await.is_err());
            s.execute("BEGIN", BTreeMap::new()).await.unwrap();
            s.execute(&format!("UPDATE {q} SET label='In tx'"), BTreeMap::new())
                .await
                .unwrap();
            let pending = s
                .execute(&format!("SELECT * FROM {q}"), BTreeMap::new())
                .await
                .unwrap()
                .sets[0]
                .rows[0]
                .clone();
            let key = BTreeMap::from([("id".into(), pending["id"].clone())]);
            let values = BTreeMap::from([("label".into(), CellValue::string("text", "Nested"))]);
            s.apply(
                "dbm_core_contract",
                vec![DataChange {
                    kind: "update".into(),
                    key,
                    original: pending,
                    values,
                }],
            )
            .await
            .unwrap();
            s.execute("ROLLBACK", BTreeMap::new()).await.unwrap();
            let restored = s
                .execute(&format!("SELECT label FROM {q}"), BTreeMap::new())
                .await
                .unwrap();
            assert_eq!(
                restored.sets[0].rows[0]["label"].text(),
                "Aggiornato",
                "grid apply must not commit the editor transaction"
            );
            let temp = tempfile::tempdir().unwrap();
            let state = AppState::new(temp.path().into()).unwrap();
            state.sessions.write().await.insert("qa".into(), s.clone());
            let exported=state.call("transfer_data",json!({"request":{"action":"export","sessionId":"qa","table":"dbm_core_contract","format":"csv"}})).await.unwrap();
            let csv = std::fs::read_to_string(exported["path"].as_str().unwrap()).unwrap();
            assert_eq!(csv.lines().count(), 2, "CSV must flush its final page");
            assert!(csv.contains("9007199254740993"));
            s.execute(&format!("DROP TABLE {q}"), BTreeMap::new())
                .await
                .unwrap();
        }
    }
}
