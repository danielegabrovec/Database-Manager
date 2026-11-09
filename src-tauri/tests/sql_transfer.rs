use dbmanager_lib::{
    database::Session,
    environment::{CreateEnvironmentRequest, Engine, EnvironmentManager, Provider},
    models::ConnectionProfile,
    tools::{ArtifactStore, BackupRequest},
};
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};

#[tokio::test]
#[ignore = "Starts one app-owned native SQL laboratory at a time to verify real SQL dump/import; requires the verified ZIP/runtime cache."]
async fn sql_dump_import_roundtrip_three_native_engines() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let app_data = PathBuf::from(
        std::env::var_os("DBM_NATIVE_QA_DATA")
            .expect("Select explicit app-owned QA data directory"),
    );
    assert!(app_data
        .canonicalize()
        .unwrap()
        .starts_with(workspace.join("artifacts").canonicalize().unwrap()));
    let manager =
        EnvironmentManager::with_archive_cache(app_data, workspace.join("artifacts/cache"))
            .unwrap();
    assert!(
        manager.list().await.unwrap().is_empty(),
        "QA registry must be idle; this test never operates on existing environments"
    );
    let store = ArtifactStore::new(&workspace.join("artifacts/qa-sql-transfer")).unwrap();
    let mut failures = Vec::new();
    let mut results = Vec::new();
    for engine in [Engine::Postgresql, Engine::Mysql, Engine::Mariadb] {
        eprintln!("SQL transfer QA: {engine:?}");
        let distribution = manager
            .catalog()
            .await
            .unwrap()
            .into_iter()
            .find(|d| d.engine == engine)
            .unwrap();
        let environment = manager
            .create(CreateEnvironmentRequest {
                name: format!("SQL transfer QA {engine:?}"),
                engine,
                provider: Provider::Native,
                laboratory: true,
                version: None,
                image_digest: None,
                distribution_id: Some(distribution.id),
                endpoint: None,
                port: None,
            })
            .await
            .unwrap();
        let secret = manager.password(&environment.id).unwrap();
        let check=async{
            if environment.status!="running"{return Err(environment.last_error.clone().unwrap_or("Not running".into()));}
            let engine_name=serde_json::to_value(engine).unwrap().as_str().unwrap().to_owned();
            let session=Session::open(ConnectionProfile{id:environment.id.clone(),name:environment.name.clone(),engine:engine_name.clone(),host:"127.0.0.1".into(),port:environment.port.unwrap(),database:"laboratory".into(),username:"dbm_lab".into(),laboratory:true,..Default::default()},secret.clone()).await?;
            let multiline="prima\n\\! NON_ESEGUIRE\nultima";
            let escaped_multiline=if engine==Engine::Postgresql{multiline.to_string()}else{multiline.replace('\\',"\\\\")};
            session.execute(&format!("CREATE TABLE qa_transfer(id BIGINT PRIMARY KEY,note TEXT); INSERT INTO qa_transfer VALUES(1,'città d''acqua'),(2,'{escaped_multiline}'); CREATE TABLE qa_other(id INTEGER PRIMARY KEY); INSERT INTO qa_other VALUES(99);"),BTreeMap::new()).await?;
            let backup_name=match engine{Engine::Postgresql=>"pg_dump",Engine::Mysql=>"mysqldump",_=>"mariadb-dump"};
            let import_name=match engine{Engine::Postgresql=>"psql",Engine::Mysql=>"mysql",_=>"mariadb"};
            let mut request=BackupRequest{engine:engine_name.clone(),executable_path:manager.ensure_client_tool(&environment.id,backup_name).await?.to_string_lossy().into(),host:"127.0.0.1".into(),port:environment.port.unwrap(),database:"laboratory".into(),username:"dbm_lab".into(),auth_database:None,tls:false,ca_path:None};
            let table=if engine==Engine::Postgresql{"\"public\".\"qa_transfer\""}else{"qa_transfer"};
            let exported=store.export_sql_table(request.clone(),table,Some(secret.clone())).await?;
            let script=std::fs::read_to_string(&exported.path).map_err(|e|e.to_string())?;
            if script.trim_start().starts_with('[')||!script.contains("INSERT")||script.contains("qa_other"){return Err("Table SQL export format/scope incorrect".into());}
            let whole=store.export_sql_table(request.clone(),"",Some(secret.clone())).await?;
            let full=std::fs::read_to_string(&whole.path).map_err(|e|e.to_string())?;
            if !full.contains("qa_other")||!full.contains("qa_transfer")||!full.contains("INSERT"){return Err("Whole database SQL export incomplete".into());}
            session.execute("DROP TABLE qa_transfer;",BTreeMap::new()).await?;
            request.executable_path=manager.ensure_client_tool(&environment.id,import_name).await?.to_string_lossy().into();
            if store.import_sql_script(request.clone(),&PathBuf::from(&exported.path),Some(secret.clone()),false).await.is_ok(){return Err("Import did not require confirmation".into());}
            store.import_sql_script(request.clone(),&PathBuf::from(&exported.path),Some(secret.clone()),true).await?;
            let result=session.execute("SELECT note FROM qa_transfer ORDER BY id;",BTreeMap::new()).await?;
            let notes=result.sets[0].rows.iter().map(|r|r["note"].text()).collect::<Vec<_>>();
            if notes!=vec!["città d'acqua".to_owned(),multiline.to_owned()]{return Err(format!("Text roundtrip differs: {notes:?}"));}
            if engine!=Engine::Postgresql{
                let path=workspace.join("artifacts/qa-sql-delimiter.sql");std::fs::write(&path,"DELIMITER //\nCREATE PROCEDURE qa_delimiter()\nBEGIN\n SELECT 'semicolon;inside' AS note;\nEND//\nDELIMITER ;\n").map_err(|e|e.to_string())?;
                store.import_sql_script(request.clone(),&path,Some(secret.clone()),true).await?;
                let exists=session.execute("SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE() AND ROUTINE_NAME='qa_delimiter';",BTreeMap::new()).await?;
                if exists.sets[0].rows.len()!=1{return Err("DELIMITER procedure not imported".into());}
                let _=std::fs::remove_file(path);
            }else{
                let path=workspace.join("artifacts/qa-psql-local-command.sql");let marker=workspace.join("artifacts/qa-forbidden-local-command.txt");
                std::fs::write(&path,format!("\\! echo forbidden > \"{}\"\n",marker.display())).map_err(|e|e.to_string())?;
                if store.import_sql_script(request,&path,Some(secret.clone()),true).await.is_ok()||marker.exists(){return Err("psql local shell meta-command was not blocked".into());}
                let _=std::fs::remove_file(path);
            }
            Ok::<_,String>(json!({"engine":engine_name,"status":"passed","tableSqlBytes":exported.bytes,"wholeDatabaseSqlBytes":whole.bytes,"textRoundtrip":true,"confirmationRequired":true,"clientMetaSafety":true}))
        }.await;
        match check {
            Ok(result) => {
                eprintln!("SQL transfer {engine:?}: passed");
                results.push(result);
            }
            Err(e) => {
                let e = e.replace(&secret, "[credential]");
                failures.push(format!("{engine:?}: {e}"));
                results.push(json!({"engine":engine,"status":"failed","error":e}));
            }
        }
        if let Err(e) = manager.delete(&environment.id, true).await {
            failures.push(format!("Cleanup {engine:?}: {e}"));
        }
    }
    std::fs::write(
        workspace.join("artifacts/qa-sql-transfer.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
