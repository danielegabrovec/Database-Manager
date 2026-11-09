//! Explicit integration checks against the app-owned QA supervisor only.
use dbmanager_lib::{
    database::Session,
    environment::EnvironmentManager,
    models::ConnectionProfile,
    tools::{ArtifactStore, BackupRequest},
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf};

#[tokio::test]
#[ignore = "Mutates only the four active app-owned laboratory QA databases to verify native backup and restore."]
async fn native_backup_restore_roundtrip_all_four_engines() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let manifest: Value = serde_json::from_slice(
        &std::fs::read(workspace.join("artifacts/qa-active.json"))
            .expect("Run the native QA supervisor first"),
    )
    .unwrap();
    assert_eq!(manifest["status"], "active");
    let manager = EnvironmentManager::with_archive_cache(
        PathBuf::from(
            manifest["appData"]
                .as_str()
                .expect("appData in QA manifest"),
        ),
        workspace.join("artifacts/cache"),
    )
    .unwrap();
    let store = ArtifactStore::new(&workspace.join("artifacts/qa-tools")).unwrap();
    let mut results = Vec::new();
    let mut failures = Vec::new();
    for connection in manifest["connections"].as_array().unwrap() {
        let id = connection["id"].as_str().unwrap();
        let engine = connection["engine"].as_str().unwrap();
        let secret = manager.password(id).unwrap();
        let outcome=async{
            let profile=ConnectionProfile{id:id.into(),name:format!("Tool QA {engine}"),engine:engine.into(),host:"127.0.0.1".into(),port:connection["port"].as_u64().unwrap() as u16,database:"laboratory".into(),username:"dbm_lab".into(),laboratory:true,..Default::default()};
            let session=Session::open(profile,secret.clone()).await?;
            if engine=="mongodb" {session.execute(&json!({"delete":"__dbm_backup_probe","deletes":[{"q":{},"limit":0}]}).to_string(),BTreeMap::new()).await?;}
            let create=if engine=="mongodb"{json!({"insert":"__dbm_backup_probe","documents":[{"_id":42,"value":"preserved"}]}).to_string()}else{"DROP TABLE IF EXISTS __dbm_backup_probe; CREATE TABLE __dbm_backup_probe(value INTEGER PRIMARY KEY); INSERT INTO __dbm_backup_probe VALUES(42);".into()};
            session.execute(&create,BTreeMap::new()).await?;
            let backup_name=match engine{"postgresql"=>"pg_dump","mysql"=>"mysqldump","mariadb"=>"mariadb-dump",_=>"mongodump"};
            let restore_name=match engine{"postgresql"=>"pg_restore","mysql"=>"mysql","mariadb"=>"mariadb",_=>"mongorestore"};
            let backup_binary=manager.ensure_client_tool(id,backup_name).await?;
            let restore_binary=manager.ensure_client_tool(id,restore_name).await?;
            let mut request=BackupRequest{engine:engine.into(),executable_path:backup_binary.to_string_lossy().into(),host:"127.0.0.1".into(),port:connection["port"].as_u64().unwrap() as u16,database:"laboratory".into(),username:"dbm_lab".into(),auth_database:Some("laboratory".into()),tls:false,ca_path:None};
            let backup=store.backup_native(request.clone(),Some(secret.clone())).await?;
            let delete=if engine=="mongodb"{json!({"delete":"__dbm_backup_probe","deletes":[{"q":{},"limit":0}]}).to_string()}else{"DELETE FROM __dbm_backup_probe;".into()};
            session.execute(&delete,BTreeMap::new()).await?;
            request.executable_path=restore_binary.to_string_lossy().into();
            assert!(store.restore_native(request.clone(),&PathBuf::from(&backup.path),Some(secret.clone()),false).await.is_err());
            let restored=store.restore_native(request,&PathBuf::from(&backup.path),Some(secret.clone()),true).await?;
            let query=if engine=="mongodb"{json!({"find":"__dbm_backup_probe","filter":{"_id":42}}).to_string()}else{"SELECT value FROM __dbm_backup_probe WHERE value=42;".into()};
            let result=session.execute(&query,BTreeMap::new()).await?;
            if result.sets.first().map(|s|s.rows.len())!=Some(1){return Err("Restored record not found".to_string());}
            let cleanup=if engine=="mongodb"{json!({"drop":"__dbm_backup_probe"}).to_string()}else{"DROP TABLE __dbm_backup_probe;".into()};
            session.execute(&cleanup,BTreeMap::new()).await?;
            Ok::<_,String>(json!({"engine":engine,"status":"passed","backupBytes":backup.bytes,"restore":restored,"probeRows":1}))
        }.await;
        match outcome {
            Ok(result) => {
                eprintln!("Native backup/restore {engine}: passed");
                results.push(result);
            }
            Err(error) => {
                let safe = error.replace(&secret, "[credential]");
                failures.push(format!("{engine}: {safe}"));
                results.push(json!({"engine":engine,"status":"failed","error":safe}));
            }
        }
    }
    std::fs::write(
        workspace.join("artifacts/qa-native-tools-results.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
