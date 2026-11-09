#[path = "../../../src-tauri/src/codegen.rs"]
mod codegen;
#[path = "../../../src-tauri/src/mongo_cancel.rs"]
mod mongo_cancel;
mod cancel_qa;
use codegen::*;
fn main() {
    let destination = std::env::args().nth(1).expect("output directory");
    if destination == "mongo-cancel" { tokio::runtime::Runtime::new().unwrap().block_on(cancel_qa::run()); return; }
    if destination == "verify" { verify_servers(); return; }
    for engine in ["sqlite","postgresql","mysql","mariadb","mongodb"] {
        for language in ["rust","python","javascript","typescript","php","java","csharp","c","cpp","go","kotlin","ruby"] {
            for output in ["project","rest"] {
                if output == "rest" && !["rust","python","javascript","typescript"].contains(&language) {continue;}
                let request=GenerateRequest{engine:engine.into(),language:language.into(),output:output.into(),table:"people".into(),query:String::new(),educational:true,columns:vec![CodeColumn{name:"id".into(),data_type:"integer".into(),primary_key:true,nullable:false},CodeColumn{name:"name".into(),data_type:"text".into(),primary_key:false,nullable:false}]};
                let project=generate_project(request).unwrap();
                let root=std::path::Path::new(&destination).join(format!("{engine}-{language}-{output}"));
                for file in project.files {let path=root.join(file.path);std::fs::create_dir_all(path.parent().unwrap()).unwrap();std::fs::write(path,file.content).unwrap();}
            }
        }
    }
}

fn verify_servers() {
    let root = std::env::current_dir().unwrap();
    let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("artifacts/qa-active.json")).unwrap()).unwrap();
    let entries = manifest.as_array().or_else(||manifest.get("connections").and_then(|v|v.as_array())).expect("QA connections array");
    let mut result=Vec::new();
    for env in entries {
        if let Ok(engines)=std::env::var("CODEGEN_QA_ENGINES"){if !engines.split(',').any(|engine|Some(engine)==env["engine"].as_str()){continue;}}
        let service=env["credentialService"].as_str().unwrap();let account=env["credentialAccount"].as_str().unwrap();
        let password=keyring::Entry::new(service,account).unwrap().get_password().unwrap();
        let engine=env["engine"].as_str().unwrap();
        let port=env["port"].as_u64().unwrap();let user=env["username"].as_str().unwrap();let database=env["database"].as_str().unwrap();
        let url=format!("{}://{}:{}@127.0.0.1:{}/{}{}",if engine=="postgresql"{"postgresql"}else if engine=="mongodb"{"mongodb"}else{"mysql"},user,password,port,database,if engine=="mongodb"{"?authSource=laboratory&directConnection=true"}else{""});
        let script=if std::env::args().nth(2).as_deref()==Some("rest"){"verify_rest.py"}else{"verify_database.py"};
        let output=std::process::Command::new("python").arg(root.join("tests/codegen").join(script)).arg(engine)
            .env("DATABASE_URL",url).env("DATABASE_NAME",database)
            .env("DB_HOST","127.0.0.1").env("DB_PORT",port.to_string()).env("DB_USER",user).env("DB_PASSWORD",&password).env("DB_NAME",database)
            .env("DB_PLUGIN_DIR",root.join("artifacts/qa-native/fdffa688-5d8b-4b25-8dd1-652ec43b7666/native-runtimes/mariadb-11-8-5/mariadb-11.8.5-winx64/lib/plugin"))
            .env("PYTHONPATH",root.join("tests/codegen/toolchains/python-packages")).output().unwrap();
        let stdout=String::from_utf8_lossy(&output.stdout).replace(&password,"[redacted]");
        let stderr=String::from_utf8_lossy(&output.stderr).replace(&password,"[redacted]");
        println!("{engine}: {}",if output.status.success(){"PASS"}else{"FAIL"});
        result.push(serde_json::json!({"engine":engine,"success":output.status.success(),"stdout":stdout,"stderr":stderr}));
    }
    std::fs::write(root.join(if std::env::var_os("CODEGEN_QA_REGRESSION").is_some(){"tests/codegen/generated/qa-dependency-regression.json"}else if std::env::args().nth(2).as_deref()==Some("rest"){"tests/codegen/generated/rest-qa-results.json"}else{"tests/codegen/generated/qa-results.json"}),serde_json::to_vec_pretty(&result).unwrap()).unwrap();
}
