//! Explicit Docker integration tests. Never operates on pre-existing projects.
use dbmanager_lib::{
    database::Session,
    environment::{CreateEnvironmentRequest, Engine, EnvironmentManager, Provider},
    models::ConnectionProfile,
};
use serde_json::json;
use std::{collections::BTreeMap, path::PathBuf};

#[tokio::test]
#[ignore = "Pulls verified Docker images and creates/removes four isolated app-owned QA Compose projects."]
async fn docker_lifecycle_and_crud_all_four_engines() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let manager = EnvironmentManager::new(
        workspace
            .join("artifacts/qa-docker")
            .join(uuid::Uuid::new_v4().to_string()),
    )
    .unwrap();
    manager.docker_available().await.expect(
        "Linux Docker engine must already be running; test never installs/configures Docker.",
    );
    let mut failures = Vec::new();
    let mut results = Vec::new();
    for (engine, version) in [
        (Engine::Postgresql, "18"),
        (Engine::Mysql, "8.4"),
        (Engine::Mariadb, "11.8"),
        (Engine::Mongodb, "8.0"),
    ] {
        eprintln!("Docker QA provisioning {engine:?}:{version}");
        let created = manager
            .create(CreateEnvironmentRequest {
                name: format!("Docker QA {engine:?}"),
                engine,
                provider: Provider::Docker,
                laboratory: true,
                version: Some(version.into()),
                image_digest: None,
                distribution_id: None,
                endpoint: None,
                port: None,
            })
            .await;
        let environment = match created {
            Ok(e) => e,
            Err(e) => {
                failures.push(format!("{engine:?}: {e}"));
                continue;
            }
        };
        let check=async{
            if environment.status!="running"{return Err(environment.last_error.clone().unwrap_or("Not running".into()));}
            let digest=environment.image_digest.as_deref().ok_or("No pinned digest")?;
            if digest.len()!=64{return Err("Invalid pinned digest".into());}
            let secret=manager.password(&environment.id)?;
            let engine_name=serde_json::to_value(engine).unwrap().as_str().unwrap().to_owned();
            let profile=ConnectionProfile{id:environment.id.clone(),name:environment.name.clone(),engine:engine_name.clone(),host:"127.0.0.1".into(),port:environment.port.unwrap(),database:"laboratory".into(),username:"dbm_lab".into(),laboratory:true,..Default::default()};
            let session=Session::open(profile.clone(),secret.clone()).await?;
            let create=if engine==Engine::Mongodb{json!({"insert":"qa_probe","documents":[{"_id":42,"name":"Ada"}]}).to_string()}else{"CREATE TABLE qa_probe(id INTEGER PRIMARY KEY, name VARCHAR(80)); INSERT INTO qa_probe VALUES(42, 'Ada');".into()};
            session.execute(&create,BTreeMap::new()).await?;
            let query=if engine==Engine::Mongodb{json!({"find":"qa_probe","filter":{"_id":42}}).to_string()}else{"SELECT id,name FROM qa_probe WHERE id=42".into()};
            let rows=session.execute(&query,BTreeMap::new()).await?;
            if rows.sets.first().map(|s|s.rows.len())!=Some(1){return Err("CRUD row missing".into());}
            drop(session);
            manager.stop(&environment.id).await?;
            let restarted=manager.start(&environment.id).await?;
            if restarted.status!="running"{return Err(restarted.last_error.unwrap_or("Restart failed".into()));}
            let session=Session::open(profile,secret).await?;
            let rows=session.execute(&query,BTreeMap::new()).await?;
            if rows.sets.first().map(|s|s.rows.len())!=Some(1){return Err("Data lost after restart".into());}
            drop(session);
            Ok::<_,String>(json!({"engine":engine_name,"status":"passed","imageDigest":digest,"crudRows":1,"restartPreservesData":true}))
        }.await;
        match check {
            Ok(result) => {
                eprintln!("Docker {engine:?}: passed");
                results.push(result);
            }
            Err(e) => {
                failures.push(format!("{engine:?}: {e}"));
                results.push(json!({"engine":engine,"status":"failed","error":e}));
            }
        }
        if let Err(e) = manager.delete(&environment.id, true).await {
            failures.push(format!("Cleanup {engine:?}: {e}"));
        }
    }
    std::fs::write(
        workspace.join("artifacts/qa-docker-results.json"),
        serde_json::to_vec_pretty(&results).unwrap(),
    )
    .unwrap();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
