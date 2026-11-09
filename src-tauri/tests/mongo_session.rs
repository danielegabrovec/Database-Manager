use dbmanager_lib::{
    database::{Handle, Session},
    models::*,
};
use mongodb::bson::{doc, Document};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};

async fn session() -> Arc<Session> {
    let v: Value = serde_json::from_slice(
        &std::fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/qa-active.json"))
            .unwrap(),
    )
    .unwrap();
    let c = v["connections"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["engine"] == "mongodb")
        .unwrap();
    let secret = keyring::Entry::new(
        c["credentialService"].as_str().unwrap(),
        c["credentialAccount"].as_str().unwrap(),
    )
    .unwrap()
    .get_password()
    .unwrap();
    Arc::new(
        Session::open(
            ConnectionProfile {
                engine: "mongodb".into(),
                host: "127.0.0.1".into(),
                port: c["port"].as_u64().unwrap() as u16,
                database: "laboratory".into(),
                username: "dbm_lab".into(),
                laboratory: true,
                ..Default::default()
            },
            secret,
        )
        .await
        .unwrap(),
    )
}
async fn row(s: &Session, table: &str, id: i32) -> DataRow {
    s.execute(
        &json!({"find":table,"filter":{"_id":id}}).to_string(),
        BTreeMap::new(),
    )
    .await
    .unwrap()
    .sets[0]
        .rows[0]
        .clone()
}
fn change(original: DataRow, name: &str, new: CellValue) -> DataChange {
    DataChange {
        kind: "update".into(),
        key: BTreeMap::from([("_id".into(), original["_id"].clone())]),
        original,
        values: BTreeMap::from([(name.into(), new)]),
    }
}

#[tokio::test]
#[ignore = "Requires the explicitly started app-owned MongoDB QA replica set."]
async fn cancellation_runs_through_application_session() {
    let s = session().await;
    let name = format!("dbm_session_cancel_{}", uuid::Uuid::new_v4().simple());
    if let Handle::Mongo { db } = &s.handle {
        db.collection::<Document>(&name)
            .insert_many((0..600).map(|n| doc! {"_id":n}))
            .await
            .unwrap();
    }
    let query=json!({"aggregate":name,"pipeline":[{"$project":{"numbers":{"$range":[0,25000]}}},{"$unwind":"$numbers"},{"$group":{"_id":0,"total":{"$sum":"$numbers"}}}],"cursor":{},"maxTimeMS":20000}).to_string();
    let worker = s.clone();
    let running = tokio::spawn(async move { worker.execute(&query, BTreeMap::new()).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    let report = s.cancel().await.unwrap();
    assert!(report.contains("confermata"), "{report}");
    let result = tokio::time::timeout(Duration::from_secs(4), running)
        .await
        .unwrap()
        .unwrap();
    assert!(result.unwrap_err().to_lowercase().contains("interrupt"));
    s.execute(&json!({"drop":name}).to_string(), BTreeMap::new())
        .await
        .unwrap();
}

#[tokio::test]
#[ignore = "Requires the explicitly started app-owned MongoDB QA replica set."]
async fn staged_edits_preserve_bson_and_rollback_conflicts() {
    let s = session().await;
    let name = format!("dbm_snapshot_{}", uuid::Uuid::new_v4().simple());
    s.execute(&json!({"insert":name,"documents":[{"_id":1,"small":{"$numberInt":"7"},"optional":null,"label":"original"},{"_id":2,"label":"second"}]}).to_string(),BTreeMap::new()).await.unwrap();
    let original = row(&s, &name, 1).await;
    assert_eq!(original["small"].native_type.as_deref(), Some("int32"));
    s.apply(
        &name,
        vec![change(original, "small", CellValue::string("integer", 8))],
    )
    .await
    .unwrap();
    let current = row(&s, &name, 1).await;
    assert_eq!(current["small"].text(), "8");
    assert_eq!(current["small"].native_type.as_deref(), Some("int32"));
    let mut stale = row(&s, &name, 2).await;
    stale.insert("label".into(), CellValue::string("text", "stale"));
    assert!(s
        .apply(
            &name,
            vec![
                change(
                    current.clone(),
                    "label",
                    CellValue::string("text", "temporary")
                ),
                change(stale, "label", CellValue::string("text", "lost"))
            ]
        )
        .await
        .is_err());
    assert_eq!(row(&s, &name, 1).await["label"].text(), "original");
    s.execute(
        &json!({"update":name,"updates":[{"q":{"_id":1},"u":{"$unset":{"optional":""}}}]})
            .to_string(),
        BTreeMap::new(),
    )
    .await
    .unwrap();
    assert!(s
        .apply(
            &name,
            vec![change(current, "label", CellValue::string("text", "lost"))]
        )
        .await
        .is_err());
    s.execute(&json!({"drop":name}).to_string(), BTreeMap::new())
        .await
        .unwrap();
}
