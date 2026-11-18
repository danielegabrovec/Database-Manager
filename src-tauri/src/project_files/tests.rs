use crate::service::AppState;
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Command, Output},
};

fn table(name: &str) -> Value {
    json!({"name":name,"kind":"table","columns":[
        {"name":"id","dataType":"INTEGER","nullable":false,"primaryKey":true},
        {"name":"name","dataType":"TEXT","nullable":false,"primaryKey":false}
    ],"foreignKeys":[],"indexes":[]})
}

fn seed(table: &str, id: i64, name: &str) -> Value {
    json!({"table":{"name":table},"values":{
        "id":{"type":"integer","value":id.to_string()},"name":{"type":"text","value":name}
    }})
}

fn execute_python(path: &Path, args: &[&str]) -> Output {
    Command::new("python")
        .current_dir(path)
        .args(args)
        .env_remove("DBM_DATABASE_1_URL")
        .env_remove("DBM_DATABASE_2_URL")
        .env("PYTHONIOENCODING", "utf-8")
        .output()
        .unwrap()
}

fn successful(path: &Path, args: &[&str]) -> String {
    let output = execute_python(path, args);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

fn fixture(language: &str) -> Value {
    let orders = json!({"name":"orders","kind":"table","columns":[
        {"name":"id","dataType":"INTEGER","nullable":false,"primaryKey":true},
        {"name":"customer_id","dataType":"INTEGER","nullable":false,"primaryKey":false},
        {"name":"name","dataType":"TEXT","nullable":false,"primaryKey":false}
    ],"foreignKeys":[],"indexes":[]});
    let order_seed = json!({"table":{"name":"orders"},"values":{"id":{"type":"integer","value":"1"},"customer_id":{"type":"integer","value":"9007199254740993"},"name":{"type":"text","value":"Ordine è"}}});
    json!({"request":{"language":language,"project":{"version":1,"id":"qa","name":"QA","databases":[
        {"id":"a","name":"Vendite","engine":"sqlite","tables":[]},{"id":"b","name":"Archivio","engine":"sqlite","tables":[]}
    ]},"databases":[
     {"id":"a","name":"Vendite","engine":"sqlite","schema":{"engine":"sqlite","database":"vendite","tables":[table("customers"),orders]},
      "ddl":"CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE orders(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), name TEXT NOT NULL);",
      "seed":[order_seed,seed("customers",9007199254740993,"Èlena d'Udine")],
      "operations":[{"id":"customers-over","name":"Filtro clienti","table":{"name":"customers"},"plan":{"kind":"read","query":"SELECT id,name FROM customers WHERE id > :p1 ORDER BY id LIMIT 10;","params":{"p1":"9007199254740993"}}}]},
     {"id":"b","name":"Archivio","engine":"sqlite","schema":{"engine":"sqlite","database":"archivio","tables":[table("customers")]},
      "ddl":"CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT NOT NULL);","seed":[seed("customers",17,"Solo archivio")]}
    ]}})
}

#[tokio::test]
async fn migration_files_separate_designer_rebuilds_and_reviewable_sql() {
    let temp = tempfile::tempdir().unwrap();
    let manager = AppState::new(temp.path().join("state")).unwrap();
    let mut options = fixture("python");
    let baseline = options["request"]["databases"][0]["schema"].clone();
    options["request"]["databases"][0]["migration"] = json!({
        "baseline":baseline,"sql":"ALTER TABLE customers ADD COLUMN zipcode TEXT;","blockers":[],"warnings":[],
        "rebuildSqlite":false,"changes":[{"label":"Aggiungi codice postale","destructive":false}]
    });
    options["request"]["databases"][1]["migration"] = json!({
        "baseline":baseline,"sql":"DROP TABLE customers;","blockers":[],"warnings":["Usa il Designer"],
        "rebuildSqlite":true,"changes":[{"label":"Ricostruisci tabella","destructive":true}]
    });
    let package = manager
        .call("generate_application_package", options)
        .await
        .unwrap();
    let plans = package["migrations"].as_array().unwrap();
    assert_eq!(plans[0]["status"], "ready");
    assert_eq!(plans[0]["baselineSha256"], plans[1]["baselineSha256"]);
    assert_eq!(plans[1]["status"], "designer");
    assert_eq!(plans[1]["destructive"], true);
    assert!(plans[1]["scriptPath"].is_null());
    let script = package["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == plans[0]["scriptPath"])
        .unwrap()["content"]
        .as_str()
        .unwrap();
    let sqlite = rusqlite::Connection::open_in_memory().unwrap();
    sqlite.execute_batch("CREATE TABLE customers(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO customers VALUES(7, 'Ada');").unwrap();
    sqlite.execute_batch(script).unwrap();
    assert_eq!(
        sqlite
            .query_row(
                "SELECT name FROM customers WHERE zipcode IS NULL",
                [],
                |row| row.get::<_, String>(0)
            )
            .unwrap(),
        "Ada"
    );
    assert!(!package["files"]
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["content"].as_str().unwrap_or_default() == "DROP TABLE customers;"));
}

#[tokio::test]
async fn exported_python_package_initializes_and_operates_two_sqlite_databases() {
    let temp = tempfile::tempdir().unwrap();
    let manager = AppState::new(temp.path().join("state")).unwrap();
    let package = manager
        .call("generate_application_package", fixture("python"))
        .await
        .unwrap();
    let artifact = manager
        .call(
            "export_application_package",
            json!({"package":package, "destination":temp.path()}),
        )
        .await
        .unwrap();
    let path = Path::new(artifact.as_str().unwrap());
    successful(path, &["progetto.py", "inizializza", "01-vendite"]);
    successful(path, &["progetto.py", "inizializza", "02-archivio"]);
    assert!(
        !execute_python(path, &["progetto.py", "inizializza", "01-vendite"])
            .status
            .success()
    );
    let alpha = successful(
        path,
        &[
            "progetto.py",
            "esegui",
            "01-vendite",
            "01-customers",
            "list",
        ],
    );
    let beta = successful(
        path,
        &[
            "progetto.py",
            "esegui",
            "02-archivio",
            "01-customers",
            "list",
        ],
    );
    assert!(alpha.contains("Èlena d'Udine") && alpha.contains("9007199254740993"));
    assert!(beta.contains("Solo archivio") && !beta.contains("Èlena"));
    let child = successful(
        path,
        &["progetto.py", "esegui", "01-vendite", "02-orders", "list"],
    );
    assert!(child.contains("Ordine è"));
    successful(
        path,
        &[
            "progetto.py",
            "esegui",
            "02-archivio",
            "01-customers",
            "insert",
            r#"{"id":18,"name":"Nuovo"}"#,
        ],
    );
    successful(
        path,
        &[
            "progetto.py",
            "esegui",
            "02-archivio",
            "01-customers",
            "update",
            r#"{"id":18,"name":"Aggiornato"}"#,
        ],
    );
    let changed = successful(
        path,
        &[
            "progetto.py",
            "esegui",
            "02-archivio",
            "01-customers",
            "list",
        ],
    );
    assert!(changed.contains("Aggiornato"));
    successful(
        path,
        &[
            "progetto.py",
            "esegui",
            "02-archivio",
            "01-customers",
            "delete",
            r#"{"id":18}"#,
        ],
    );
    assert_eq!(
        beta,
        successful(
            path,
            &[
                "progetto.py",
                "esegui",
                "02-archivio",
                "01-customers",
                "list"
            ]
        )
    );
    assert_eq!(
        alpha,
        successful(
            path,
            &[
                "progetto.py",
                "esegui",
                "01-vendite",
                "01-customers",
                "list"
            ]
        )
    );

    let copied_runner = r#"
import importlib.util, json, sqlite3, sys
spec = importlib.util.spec_from_file_location('snippet', sys.argv[1]); snippet = importlib.util.module_from_spec(spec); spec.loader.exec_module(snippet)
with sqlite3.connect('dati/02-archivio.sqlite') as db:
    db.execute('PRAGMA foreign_keys=ON')
    print(json.dumps(snippet.esegui_operazione(db, json.loads(sys.argv[2])), ensure_ascii=False))
"#;
    let operation_path = |label: &str| -> &str {
        package["operations"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["name"] == label && item["databaseId"] == "b")
            .unwrap()["sourcePath"]
            .as_str()
            .unwrap()
    };
    for (label, input, expected) in [
        ("Inserisci", r#"[23,"Record copiato"]"#, "1"),
        ("Modifica", r#"["Record modificato",23]"#, "1"),
        (
            "Leggi",
            "[]",
            r#"[[17, "Solo archivio"], [23, "Record modificato"]]"#,
        ),
        ("Elimina", "[23]", "1"),
    ] {
        assert_eq!(
            successful(
                path,
                &["-B", "-c", copied_runner, operation_path(label), input]
            )
            .trim(),
            expected
        );
    }

    let operation = package["operations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["name"] == "Filtro clienti")
        .unwrap();
    let source = path.join(operation["sourcePath"].as_str().unwrap());
    let original = std::fs::read_to_string(&source).unwrap();
    let modified = original.replace(" > ?", " >= ?");
    assert_ne!(original, modified);
    let runner = r#"
import importlib.util, sqlite3, sys
spec = importlib.util.spec_from_file_location('snippet', sys.argv[1]); snippet = importlib.util.module_from_spec(spec); spec.loader.exec_module(snippet)
with sqlite3.connect('dati/01-vendite.sqlite') as db:
    print(len(snippet.esegui_operazione(db, (9007199254740993,))))
"#;
    assert_eq!(
        successful(path, &["-B", "-c", runner, source.to_str().unwrap()]).trim(),
        "0"
    );
    std::fs::write(&source, &modified).unwrap();
    assert_eq!(
        successful(path, &["-B", "-c", runner, source.to_str().unwrap()]).trim(),
        "1"
    );
    if let Ok(destination) = std::env::var("DBM_PACKAGE_EMITTED_SOURCE") {
        std::fs::write(destination, &modified).unwrap();
    }
}

#[tokio::test]
async fn package_generation_preserves_twelve_driver_capabilities_and_rejects_collisions() {
    let temp = tempfile::tempdir().unwrap();
    let manager = AppState::new(temp.path().join("state")).unwrap();
    for language in [
        "rust",
        "python",
        "javascript",
        "typescript",
        "php",
        "java",
        "csharp",
        "c",
        "cpp",
        "go",
        "kotlin",
        "ruby",
    ] {
        let package = manager
            .call("generate_application_package", fixture(language))
            .await
            .unwrap_or_else(|error| panic!("{language}: {error}"));
        assert_eq!(package["operations"].as_array().unwrap().len(), 13);
        assert!(package["operations"]
            .as_array()
            .unwrap()
            .iter()
            .all(|op| op["sourcePath"].is_string()));
        for engine in ["postgresql", "mysql", "mariadb", "mongodb"] {
            let mut request = fixture(language);
            request["request"]["project"]["databases"] =
                json!([{"id":"b","name":"Archivio","engine":engine,"tables":[]}]);
            let mut database = request["request"]["databases"][1].clone();
            database["engine"] = json!(engine);
            database["schema"]["engine"] = json!(engine);
            database["seed"] = json!([]);
            if engine == "mongodb" {
                database["schema"]["tables"] = json!([{"name":"customers","kind":"collection","columns":[
                    {"name":"_id","dataType":"objectid","nullable":false,"primaryKey":true},
                    {"name":"name","dataType":"string","nullable":true,"primaryKey":false}],"foreignKeys":[],"indexes":[] }]);
                database["ddl"] = json!("[{\"create\":\"customers\"}]");
            }
            request["request"]["databases"] = json!([database]);
            let bundle = manager
                .call("generate_application_package", request)
                .await
                .unwrap_or_else(|error| panic!("{engine}/{language}: {error}"));
            assert_eq!(bundle["operations"].as_array().unwrap().len(), 4);
            assert!(bundle["operations"]
                .as_array()
                .unwrap()
                .iter()
                .all(|op| op["sourcePath"].is_string()));
            let manifest: Value =
                serde_json::from_str(bundle["files"][0]["content"].as_str().unwrap()).unwrap();
            assert_eq!(manifest["language"], language);
            assert!(manifest["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(
                    |item| item["kind"] == "schema" && item["sha256"].as_str().unwrap().len() == 64
                ));
        }
    }
    let before = std::fs::read_dir(temp.path()).unwrap().count();
    let invalid = json!({"files":[{"path":"database-manager-project.json","content":"{}"},{"path":"FILE.txt","content":"one"},{"path":"file.txt","content":"two"}],"command":"","notes":[]});
    assert!(manager
        .call(
            "export_application_package",
            json!({"package":invalid,"destination":temp.path()})
        )
        .await
        .is_err());
    assert_eq!(before, std::fs::read_dir(temp.path()).unwrap().count());
}
