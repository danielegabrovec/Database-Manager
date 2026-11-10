use dbmanager_lib::codegen_workbench::{generate_workbench, WorkbenchRequest};
use serde_json::json;
use std::{path::PathBuf, process::Command};

#[test]
fn generated_schema_functions_cover_twelve_languages_and_execute_on_sqlite() {
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("artifacts/qa-schema-code-20261110");
    let sql="CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT); CREATE INDEX idx_people_name ON people(name);";
    for language in ["rust","python","javascript","typescript","java","kotlin","csharp","go","php","ruby","c","cpp"] {
        for engine in ["sqlite","postgresql","mysql","mariadb"] {
            let request:WorkbenchRequest=serde_json::from_value(json!({"engine":engine,"language":language,"artifact":"schema","table":"people","columns":[],"query":sql})).unwrap();
            let project=generate_workbench(request).unwrap();
            assert_eq!(project.files.len(),3);
            for file in project.files { let path=root.join(engine).join(language).join(file.path);std::fs::create_dir_all(path.parent().unwrap()).unwrap();std::fs::write(path,file.content).unwrap(); }
        }
    }
    let python=root.join("sqlite/python");
    std::fs::write(python.join("runner.py"),"import sqlite3\nfrom schema import apply_schema\nc=sqlite3.connect(':memory:')\nassert apply_schema(c)==2\nc.execute(\"INSERT INTO people VALUES(1,'città €')\")\nassert c.execute('SELECT name FROM people').fetchone()[0]=='città €'\nprint('Python schema: passed')\n").unwrap();
    let result=Command::new("python").arg(python.join("runner.py")).output().unwrap();
    assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
    let js=root.join("sqlite/javascript");
    std::fs::write(js.join("runner.mjs"),"import {DatabaseSync} from 'node:sqlite';\nimport {applySchema} from './schema.mjs';\nconst db=new DatabaseSync(':memory:');\nif(await applySchema(db)!==2) throw Error('schema count');\ndb.exec(\"INSERT INTO people VALUES(1,'città €')\");\nif(db.prepare('SELECT name FROM people').get().name!=='città €') throw Error('data');\nconsole.log('JS schema: passed');\n").unwrap();
    let result=Command::new("node").arg(js.join("runner.mjs")).output().unwrap();
    assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
}

#[test]
fn generated_python_sqlite_read_runs_with_bound_values() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("artifacts/qa-workbench-python-js");
    std::fs::create_dir_all(&root).unwrap();
    let request:WorkbenchRequest=serde_json::from_value(json!({"engine":"sqlite","language":"python","artifact":"read","table":"people","columns":[{"name":"id","dataType":"integer","primaryKey":true},{"name":"name","dataType":"text","nullable":true}],"query":"SELECT id,name FROM people WHERE id >= :p1 AND name != :p2 ORDER BY id","parameters":[{"name":"p1","dataType":"integer"},{"name":"p2","dataType":"text"}]})).unwrap();
    let generated = generate_workbench(request).unwrap();
    let source = &generated
        .files
        .iter()
        .find(|f| f.path.ends_with("read_records.py"))
        .unwrap()
        .content;
    let file = root.join("read_records.py");
    std::fs::write(&file, source).unwrap();
    let runner = root.join("runner.py");
    std::fs::write(&runner,"import sqlite3\nfrom read_records import read_records\nc=sqlite3.connect(':memory:')\nc.executescript(\"CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO people VALUES(1,'Ada'),(2,'Grace'),(3,'x OR 1=1');\")\nassert read_records(c,{'p1':2,'p2':'Grace'}) == [{'id':3,'name':'x OR 1=1'}]\ntry:\n read_records(c,{'p1':1})\n raise AssertionError('missing parameter accepted')\nexcept ValueError: pass\nprint('Python SQLite workbench read: passed')\n").unwrap();
    let result = Command::new("python").arg(&runner).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let receipt =
        json!({"pythonSqliteRead":"passed","boundParameters":true,"missingParameterRejected":true});
    std::fs::write(
        root.join("python-receipt.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
}

#[test]
fn export_workbench_syntax_fixtures_for_all_twelve_languages() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("artifacts/qa-workbench-fixtures");
    for language in [
        "rust",
        "python",
        "javascript",
        "typescript",
        "java",
        "kotlin",
        "csharp",
        "go",
        "php",
        "ruby",
        "c",
        "cpp",
    ] {
        for artifact in ["read", "model", "repository"] {
            let request:WorkbenchRequest=serde_json::from_value(json!({"engine":"sqlite","language":language,"artifact":artifact,"table":"people","columns":[{"name":"id","dataType":"bigint","primaryKey":true},{"name":"name","dataType":"text","nullable":true}],"query":"SELECT id,name FROM people WHERE id >= :p1 ORDER BY id","parameters":[{"name":"p1","dataType":"integer"}]})).unwrap();
            let generated = generate_workbench(request).unwrap();
            for file in generated.files {
                let path = root.join(language).join(artifact).join(&file.path);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, file.content).unwrap();
            }
        }
    }
}

#[test]
fn generated_javascript_sqlite_reads_boolean_null_and_int64() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    let root = workspace.join("artifacts/qa-workbench-python-js");
    std::fs::create_dir_all(&root).unwrap();
    let req:WorkbenchRequest=serde_json::from_value(json!({"engine":"sqlite","language":"javascript","artifact":"read","table":"people","query":"SELECT id,name FROM people WHERE active=:active AND (:search IS NULL OR name=:search) AND id>=:minimum ORDER BY id","columns":[{"name":"id","dataType":"bigint","primaryKey":true},{"name":"name","dataType":"text","nullable":true}],"parameters":[{"name":"active","dataType":"boolean"},{"name":"search","dataType":"text","nullable":true},{"name":"minimum","dataType":"bigint"}]})).unwrap();
    let generated = generate_workbench(req).unwrap();
    let source = &generated
        .files
        .iter()
        .find(|f| f.path.ends_with("read_records.mjs"))
        .unwrap()
        .content;
    std::fs::write(root.join("read_records.mjs"), source).unwrap();
    let package = workspace.join("tests/codegen/package.json");
    assert!(
        package.is_file(),
        "Existing driver QA harness must be present; no implicit npm install is performed"
    );
    let runner=format!("import {{ createRequire }} from 'node:module';\nimport assert from 'node:assert/strict';\nimport {{ readRecords }} from './read_records.mjs';\nconst require=createRequire({});const Database=require('better-sqlite3');const db=new Database(':memory:');\ndb.exec(\"CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT,active INTEGER); INSERT INTO people VALUES(1,'Ada',1),(2,'Grace',0);\");\ndb.prepare('INSERT INTO people VALUES(?,?,?)').run(9007199254740993n,\"x' OR 1=1 --\",1);\nconst rows=await readRecords(db,{{active:true,search:null,minimum:3n}});assert.equal(rows.length,1);assert.equal(rows[0].id,9007199254740993n);assert.equal(rows[0].name,\"x' OR 1=1 --\");\nassert.equal((await readRecords(db,{{active:true,search:\"' OR 1=1 --\",minimum:0n}})).length,0);\nawait assert.rejects(()=>readRecords(db,{{active:true,minimum:0n}}),/Parametro mancante/);\ndb.close();console.log('JavaScript SQLite read: passed');\n",serde_json::to_string(&package.to_string_lossy()).unwrap());
    let script = root.join("runner.mjs");
    std::fs::write(&script, runner).unwrap();
    let result = Command::new("node").arg(script).output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    std::fs::write(root.join("javascript-receipt.json"),serde_json::to_vec_pretty(&json!({"javascriptSqliteRead":"passed","booleanNormalized":true,"nullAndRepeatedParameters":true,"int64Exact":true,"hostileValueBound":true})).unwrap()).unwrap();
}
