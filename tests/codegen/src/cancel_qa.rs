use mongodb::{bson::{doc, Document}, Client};
use std::time::Duration;

fn escaped(value:&str)->String{value.bytes().map(|byte|if byte.is_ascii_alphanumeric()||b"-._~".contains(&byte){(byte as char).to_string()}else{format!("%{byte:02X}")}).collect()}
pub async fn run(){
    let root=std::env::current_dir().unwrap();
    let manifest:serde_json::Value=serde_json::from_slice(&std::fs::read(root.join("artifacts/qa-active.json")).unwrap()).unwrap();
    let profile=manifest["connections"].as_array().unwrap().iter().find(|entry|entry["engine"]=="mongodb").unwrap();
    let password=keyring::Entry::new(profile["credentialService"].as_str().unwrap(),profile["credentialAccount"].as_str().unwrap()).unwrap().get_password().unwrap();
    let uri=format!("mongodb://{}:{}@127.0.0.1:{}/laboratory?authSource=laboratory&directConnection=true",profile["username"].as_str().unwrap(),escaped(&password),profile["port"].as_u64().unwrap());
    let client=Client::with_uri_str(uri).await.unwrap();let db=client.database("laboratory");
    let name=format!("__dbm_cancel_probe_{}",uuid::Uuid::new_v4().simple());
    let collection=db.collection::<Document>(&name);
    collection.insert_many((0..600).map(|n|doc!{"_id":n})).await.unwrap();
    let job=format!("dbm-{}",uuid::Uuid::new_v4());let other_job=format!("dbm-{}",uuid::Uuid::new_v4());
    let pipeline=vec![doc!{"$project":{"numbers":{"$range":[0,25000]}}},doc!{"$unwind":"$numbers"},doc!{"$group":{"_id":0,"total":{"$sum":"$numbers"}}}];
    let mut command=doc!{"aggregate":&name,"pipeline":pipeline,"cursor":{},"maxTimeMS":25000};
    super::mongo_cancel::tag(&mut command,&job).unwrap();
    let mut other_command=command.clone();super::mongo_cancel::tag(&mut other_command,&other_job).unwrap();
    let query_db=db.clone();let other_db=db.clone();
    let query=tokio::spawn(async move{query_db.run_command(command).await});
    let other_query=tokio::spawn(async move{other_db.run_command(other_command).await});
    tokio::time::sleep(Duration::from_millis(80)).await;
    let report=super::mongo_cancel::cancel(&db,&job).await;
    let other_was_running=!other_query.is_finished();
    let outcome=tokio::time::timeout(Duration::from_secs(5),query).await.unwrap().unwrap();
    let code=outcome.as_ref().err().and_then(|error|match error.kind.as_ref(){mongodb::error::ErrorKind::Command(command)=>Some(command.code),_=>None});
    let cleanup=super::mongo_cancel::cancel(&db,&other_job).await;
    let _=tokio::time::timeout(Duration::from_secs(5),other_query).await;
    collection.drop().await.unwrap();
    let confirmed=report.as_ref().map(|report|report.terminated&&report.marked>0).unwrap_or(false);
    let result=serde_json::json!({"test":"MongoDB own-operation cancellation","pass":confirmed&&code==Some(11601)&&other_was_running,"cancelReport":report.as_ref().ok(),"error":report.as_ref().err(),"queryErrorCode":code,"otherJobStillRunningAfterTargetCancellation":other_was_running,"cleanupOtherJob":cleanup.as_ref().ok(),"scope":"same readWrite laboratory account; no admin privileges added","sources":["https://www.mongodb.com/docs/manual/reference/operator/aggregation/currentop/","https://www.mongodb.com/docs/manual/reference/command/killop/"]});
    std::fs::write(root.join("artifacts/qa-mongo-cancel.json"),serde_json::to_vec_pretty(&result).unwrap()).unwrap();
    println!("{}",result);
    assert!(result["pass"].as_bool().unwrap(),"Cancellation did not meet the declared criteria");
}
