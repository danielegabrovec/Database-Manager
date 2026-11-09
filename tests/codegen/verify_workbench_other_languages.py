"""Compile and execute the app's generated read/model modules against an isolated SQLite fixture.

Uses the running Rust RPC and existing toolchain/dependency caches. Generated source is
written verbatim; only separate consumer harnesses/build manifests are added.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "artifacts" / "qa-workbench-otherlanguages"
BIG = 9223372036854775806
HOSTILE = "SQL ' ; DROP TABLE people; --"
COLUMNS = [
    {"name": "id", "dataType": "INTEGER", "nullable": False, "primaryKey": True},
    {"name": "name", "dataType": "TEXT", "nullable": False, "primaryKey": False},
    {"name": "age", "dataType": "INTEGER", "nullable": True, "primaryKey": False},
    {"name": "active", "dataType": "BOOLEAN", "nullable": False, "primaryKey": False},
    {"name": "amount", "dataType": "NUMERIC", "nullable": True, "primaryKey": False},
    {"name": "payload", "dataType": "JSON", "nullable": True, "primaryKey": False},
    {"name": "created_at", "dataType": "DATETIME", "nullable": False, "primaryKey": False},
    {"name": "data", "dataType": "BLOB", "nullable": True, "primaryKey": False},
]
QUERY = """SELECT id,name,age,active,amount,payload,created_at,data
FROM people
WHERE active=:active AND (name=:search OR :search IS NULL)
  AND (id=:lookup_id OR :lookup_id IS NULL) AND age>=:minimum_age
ORDER BY id;"""
PARAMETERS = [
    {"name": "active", "dataType": "BOOLEAN", "nullable": False, "value": True},
    {"name": "search", "dataType": "TEXT", "nullable": True, "value": None},
    {"name": "lookup_id", "dataType": "BIGINT", "nullable": True, "value": None},
    {"name": "minimum_age", "dataType": "INTEGER", "nullable": False, "value": 18},
]


def rpc(language: str, artifact: str) -> dict:
    body = {"request": {"engine": "sqlite", "language": language, "artifact": artifact,
                        "table": "people", "columns": COLUMNS, "operation": "custom",
                        "query": QUERY if artifact == "read" else "",
                        "parameters": PARAMETERS if artifact == "read" else [], "educational": True}}
    request = urllib.request.Request("http://127.0.0.1:8787/api/generate_workbench",
                                    json.dumps(body).encode(), {"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def generate(language: str) -> Path:
    folder = OUTPUT / language
    for artifact in ("read", "model"):
        project = rpc(language, artifact)
        write(folder / f"generated-{artifact}.json", json.dumps(project, ensure_ascii=False, indent=2))
        for file in project["files"]:
            relative = Path(file["path"])
            if relative.is_absolute() or ".." in relative.parts:
                raise AssertionError("Unsafe output path in app response")
            write(folder / relative, file["content"])
    return folder


def fixture() -> Path:
    database = OUTPUT / "fixture.sqlite"
    with sqlite3.connect(database) as connection:
        connection.execute("DROP TABLE IF EXISTS people")
        connection.execute("CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL,age INTEGER,active BOOLEAN NOT NULL,amount NUMERIC,payload JSON,created_at DATETIME NOT NULL,data BLOB)")
        connection.executemany("INSERT INTO people VALUES(?,?,?,?,?,?,?,?)", [
            (1, "Anna", 20, 1, "12.50", '{"kind":"sample"}', "2026-11-09T12:00:00", b"\x00\xff"),
            (2, "Marco", 17, 1, None, None, "2026-11-09T12:00:00", None),
            (3, "Sara", 30, 0, "3.25", None, "2026-11-09T12:00:00", None),
            (BIG, HOSTILE, 22, 1, "19.75", '{"kind":"quoted"}', "2026-11-09T12:00:00", None),
        ])
    return database


def command(label: str, args: list[str], cwd: Path, timeout: int = 240, env: dict | None = None) -> dict:
    started = time.monotonic()
    try:
        completed = subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                                   errors="replace", timeout=timeout, env=env)
        result = {"label": label, "argv": args, "cwd": str(cwd), "exitCode": completed.returncode,
                  "seconds": round(time.monotonic() - started, 3), "passed": completed.returncode == 0}
        write(cwd / f"qa-{label}.log", completed.stdout + "\n" + completed.stderr)
        result["log"] = str(cwd / f"qa-{label}.log")
        result["tail"] = (completed.stdout + completed.stderr)[-5000:]
    except subprocess.TimeoutExpired as error:
        result = {"label": label, "argv": args, "cwd": str(cwd), "passed": False, "error": f"Timeout {error.timeout}s"}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return result


def rust(folder: Path, database: Path) -> list[dict]:
    write(folder / "Cargo.toml", '''[package]
name = "qa-workbench-rust"
version = "0.1.0"
edition = "2021"
[workspace]
[[bin]]
name = "qa-workbench-rust"
path = "qa.rs"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
sqlx = { version = "0.9", default-features = false, features = ["runtime-tokio", "tls-rustls-ring", "sqlite", "chrono", "uuid", "bigdecimal", "json"] }
''')
    write(folder / "qa.rs", '''#[path="workbench/read_records.rs"] mod read;
#[path="workbench/model.rs"] mod model;
use serde_json::{json,Value};
use sqlx::Row;
#[tokio::main]
async fn main()->Result<(),Box<dyn std::error::Error+Send+Sync>> {
 let file=std::env::args().nth(1).ok_or("fixture required")?;
 let pool=sqlx::SqlitePool::connect(&format!("sqlite:{}?mode=ro",file.replace('\\\\',"/"))).await?;
 let mut parameters=json!({"active":true,"search":null,"lookup_id":null,"minimum_age":18}).as_object().unwrap().clone();
 let rows=read::read_records(&pool,&parameters).await?;
 let ids=rows.iter().map(|row|row.try_get::<i64,_>("id")).collect::<Result<Vec<_>,_>>()?;
 assert_eq!(ids,vec![1,9223372036854775806]);
 parameters.insert("lookup_id".into(),Value::String("9223372036854775806".into()));
 let rows=read::read_records(&pool,&parameters).await?;assert_eq!(rows.len(),1);assert_eq!(rows[0].try_get::<i64,_>("id")?,9223372036854775806);
 parameters.insert("search".into(),json!("SQL ' ; DROP TABLE people; --"));assert_eq!(read::read_records(&pool,&parameters).await?.len(),1);
 parameters.remove("minimum_age");assert!(read::read_records(&pool,&parameters).await.is_err());
 let value=model::PeopleRow{id:1,name:"Model".into(),age:None,active:true,amount:Some("123.45000000".into()),payload:Some(json!({"kind":"model"})),created_at:"2026-11-09T12:00:00".into(),data:Some(vec![0,255])};
 assert_eq!(serde_json::to_value(value)?["amount"],"123.45000000");assert_eq!(model::PRIMARY_KEYS,&["id"]);
 println!("PASS read+model: filtered read, repeated NULL binds, bigint input/output, hostile data, missing parameter, exact model decimal");
 pool.close().await;Ok(())
}
''')
    env = dict(os.environ, CARGO_TARGET_DIR=str(ROOT / "tests/codegen/target"))
    built = command("compile", ["cargo", "build", "--offline", "--manifest-path", str(folder / "Cargo.toml")], folder, 300, env)
    results = [built]
    if built["passed"]:
        results.append(command("runtime", [str(ROOT / "tests/codegen/target/debug/qa-workbench-rust.exe"), str(database)], folder, 60, env))
    return results


def csharp(folder: Path, database: Path) -> list[dict]:
    write(folder / "Qa.csproj", '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.Data.Sqlite" Version="10.0.13" /></ItemGroup></Project>')
    write(folder / "Qa.cs", '''using Microsoft.Data.Sqlite;
using System.Text.Json;
internal static class Qa {
 static void Check(bool condition,string message){if(!condition)throw new Exception(message);}
 static async Task Main(string[] args){
 await using var connection=new SqliteConnection("Data Source="+args[0]+";Mode=ReadOnly");await connection.OpenAsync();
 var parameters=new Dictionary<string,object?>{{"active",true},{"search",null},{"lookup_id",null},{"minimum_age",18L}};
 var rows=await DatabaseReadQueries.ReadRecordsAsync(connection,parameters);
 Check(rows.Count==2,"filtered row count");Check(Convert.ToInt64(rows[1]["id"])==9223372036854775806L,"int64 output precision");
 parameters["lookup_id"]=9223372036854775806L;rows=await DatabaseReadQueries.ReadRecordsAsync(connection,parameters);Check(rows.Count==1,"int64 parameter");
 parameters["search"]="SQL ' ; DROP TABLE people; --";rows=await DatabaseReadQueries.ReadRecordsAsync(connection,parameters);Check(rows.Count==1,"SQL-looking value treated as data");
 parameters.Remove("minimum_age");try{await DatabaseReadQueries.ReadRecordsAsync(connection,parameters);throw new Exception("missing parameter accepted");}catch(ArgumentException){}
 var model=new PeopleRow(1,"Model",null,true,123.45000000m,null,"2026-11-09T12:00:00",new byte[]{0,255});Check(model.Amount==123.45000000m,"model decimal");Check(PeopleRow.PrimaryKeys.SequenceEqual(new[]{"id"}),"model key metadata");
 Console.WriteLine("PASS read+model: filtered read, repeated NULL binds, bigint input/output, hostile data, missing parameter, exact model decimal");
 }
}
''')
    restored = command("restore", ["dotnet", "restore", "Qa.csproj", "--ignore-failed-sources"], folder)
    results = [restored]
    if not restored["passed"]:
        return results
    built = command("compile", ["dotnet", "build", "Qa.csproj", "--no-restore", "--nologo"], folder)
    results.append(built)
    if built["passed"]:
        results.append(command("runtime", ["dotnet", str(folder / "bin/Debug/net10.0/Qa.dll"), str(database)], folder, 60))
    return results


def java(folder: Path, database: Path) -> list[dict]:
    write(folder / "Qa.java", '''import java.sql.*;import java.util.*;import java.math.BigDecimal;
public final class Qa {
 static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
 public static void main(String[] args)throws Exception{
 Class.forName("org.sqlite.JDBC");try(Connection connection=DriverManager.getConnection("jdbc:sqlite:"+args[0])){
 Map<String,Object> parameters=new HashMap<>();parameters.put("active",true);parameters.put("search",null);parameters.put("lookup_id",null);parameters.put("minimum_age",18L);
 var rows=ReadRecords.readRecords(connection,parameters);check(rows.size()==2,"filtered row count");check(((Number)rows.get(1).get("id")).longValue()==9223372036854775806L,"int64 output");
 parameters.put("lookup_id",9223372036854775806L);check(ReadRecords.readRecords(connection,parameters).size()==1,"int64 input");parameters.put("search","SQL ' ; DROP TABLE people; --");check(ReadRecords.readRecords(connection,parameters).size()==1,"hostile value as data");
 parameters.remove("minimum_age");try{ReadRecords.readRecords(connection,parameters);throw new AssertionError("missing parameter accepted");}catch(IllegalArgumentException expected){}
 PeopleRow model=new PeopleRow(1L,"Model",null,true,new BigDecimal("123.45000000"),null,"2026-11-09T12:00:00",new byte[]{0,(byte)255});check(model.amount().toPlainString().equals("123.45000000"),"model decimal precision");check(PeopleRow.PRIMARY_KEYS.equals(List.of("id")),"model keys");
 System.out.println("PASS read+model: filtered read, repeated NULL binds, bigint input/output, hostile data, missing parameter, exact model decimal");
 }
 }
}
''')
    libraries = ROOT / "tests/codegen/generated/sqlite-java-project/runtime/database-example/lib"
    jars = sorted(libraries.glob("*.jar"))
    if not jars:
        raise RuntimeError("Cached SQLite JDBC runtime not found")
    classpath = os.pathsep.join(map(str, jars))
    sources = [str(path) for path in (folder / "workbench").glob("*.java")] + [str(folder / "Qa.java")]
    built = command("compile", ["javac", "-encoding", "UTF-8", "--release", "17", "-cp", classpath, "-d", str(folder / "classes")] + sources, folder)
    results = [built]
    if built["passed"]:
        results.append(command("runtime", ["java", "--enable-native-access=ALL-UNNAMED", "-cp", str(folder / "classes") + os.pathsep + classpath, "Qa", str(database)], folder, 60))
    return results


def typescript(folder: Path, database: Path) -> list[dict]:
    write(folder / "package.json", '{"private":true,"type":"module"}')
    write(folder / "tsconfig.json", json.dumps({"compilerOptions": {"target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext", "strict": True, "esModuleInterop": True, "skipLibCheck": True, "outDir": "dist", "typeRoots": [str(ROOT / "tests/codegen/node_modules/@types"), str(ROOT / "node_modules/@types")], "baseUrl": str(ROOT), "paths": {"better-sqlite3": ["tests/codegen/node_modules/@types/better-sqlite3"]}}, "include": ["workbench/*.ts", "qa.ts"]}, indent=2))
    require_path = json.dumps(str(ROOT / "tests/codegen/package.json"))
    write(folder / "qa.ts", '''import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {readRecords} from './workbench/read_records.js';import type {PeopleRow} from './workbench/model.js';
const require=createRequire(@@REQUIRE@@);const Database=require('better-sqlite3') as typeof import('better-sqlite3');
const connection=new Database(process.argv[2],{readonly:true});
try{
 const parameters:Record<string,any>={active:true,search:null,lookup_id:null,minimum_age:18};
 const rows=await readRecords(connection,parameters);assert.deepEqual(rows.map(row=>row.id),[1n,9223372036854775806n]);
 parameters.lookup_id=9223372036854775806n;assert.equal((await readRecords(connection,parameters)).length,1);parameters.search="SQL ' ; DROP TABLE people; --";assert.equal((await readRecords(connection,parameters)).length,1);
 delete parameters.minimum_age;await assert.rejects(()=>readRecords(connection,parameters),/Parametro mancante/);
 const model:PeopleRow={id:1n,name:'Model',age:null,active:true,amount:'123.45000000',payload:{kind:'model'},created_at:'2026-11-09T12:00:00',data:new Uint8Array([0,255])};assert.equal(model.amount,'123.45000000');
 console.log('PASS read+model: filtered read, repeated NULL binds, bigint input/output, hostile data, missing parameter, exact model decimal');
}finally{connection.close();}
'''.replace("@@REQUIRE@@", require_path))
    built = command("compile", ["node", str(ROOT / "node_modules/typescript/bin/tsc"), "-p", str(folder / "tsconfig.json")], folder)
    results = [built]
    if built["passed"]:
        results.append(command("runtime", ["node", str(folder / "dist/qa.js"), str(database)], folder, 60))
    return results


def go(folder: Path, database: Path) -> list[dict]:
    write(folder / "go.mod", "module qa-workbench-go\n\ngo 1.23\n\nrequire modernc.org/sqlite v1.34.5\n")
    shutil.copyfile(ROOT/"tests/codegen/generated/sqlite-go-project/go.sum", folder/"go.sum")
    write(folder / "qa/main.go", '''package main
import("context";"database/sql";"encoding/json";"fmt";"os";"reflect";"qa-workbench-go/workbench";_ "modernc.org/sqlite")
func check(ok bool,message string){if !ok{panic(message)}}
func main(){db,err:=sql.Open("sqlite",os.Args[1]);if err!=nil{panic(err)};defer db.Close();parameters:=map[string]any{"active":true,"search":nil,"lookup_id":nil,"minimum_age":int64(18)}
 rows,err:=workbench.ReadRecords(context.Background(),db,parameters);if err!=nil{panic(err)};check(len(rows)==2,"filtered row count");check(rows[1]["id"].(int64)==9223372036854775806,"int64 output");
 parameters["lookup_id"]=int64(9223372036854775806);rows,err=workbench.ReadRecords(context.Background(),db,parameters);if err!=nil{panic(err)};check(len(rows)==1,"int64 input");parameters["search"]="SQL ' ; DROP TABLE people; --";rows,err=workbench.ReadRecords(context.Background(),db,parameters);if err!=nil{panic(err)};check(len(rows)==1,"hostile text value");delete(parameters,"minimum_age");_,err=workbench.ReadRecords(context.Background(),db,parameters);check(err!=nil,"missing parameter accepted");
 amount:="123.45000000";payload:=json.RawMessage(`{"kind":"model"}`);data:=[]byte{0,255};model:=workbench.PeopleRow{Id:1,Name:"Model",Age:nil,Active:true,Amount:&amount,Payload:&payload,CreatedAt:"2026-11-09T12:00:00",Data:&data};encoded,err:=json.Marshal(model);if err!=nil{panic(err)};check(len(encoded)>0&&*model.Amount==amount,"model decimal precision");check(reflect.DeepEqual(workbench.PrimaryKeys,[]string{"id"}),"model keys");
 fmt.Println("PASS read+model: filtered read, repeated NULL binds, bigint input/output, hostile data, missing parameter, exact model decimal")
}
''')
    env=dict(os.environ,GOPROXY="off",GOWORK="off")
    built=command("compile",["go","build","-mod=mod","-o",str(folder/"qa-workbench-go.exe"),"./qa"],folder,240,env)
    results=[built]
    if built["passed"]:
        results.append(command("runtime",[str(folder/"qa-workbench-go.exe"),str(database)],folder,60,env))
    return results


def kotlin(folder: Path, database: Path) -> list[dict]:
    write(folder/"settings.gradle.kts",'rootProject.name = "qa-workbench-kotlin"\n')
    write(folder/"build.gradle.kts",'''plugins { kotlin("jvm") version "2.1.10" }
repositories { mavenCentral() }
dependencies { implementation("org.xerial:sqlite-jdbc:3.47.2.0") }
kotlin { jvmToolchain(21); sourceSets.main { kotlin.setSrcDirs(listOf("workbench", "qa")) } }
''')
    write(folder/"qa/Qa.kt",'''import java.sql.DriverManager
import java.math.BigDecimal
fun main(args:Array<String>){
 Class.forName("org.sqlite.JDBC")
 DriverManager.getConnection("jdbc:sqlite:"+args[0]).use { connection ->
  val parameters=mutableMapOf<String,Any?>("active" to true,"search" to null,"lookup_id" to null,"minimum_age" to 18L)
  var rows=readRecords(connection,parameters);check(rows.size==2);check((rows[1]["id"] as Number).toLong()==9223372036854775806L)
  parameters["lookup_id"]=9223372036854775806L;rows=readRecords(connection,parameters);check(rows.size==1)
  parameters["search"]="SQL ' ; DROP TABLE people; --";check(readRecords(connection,parameters).size==1)
  parameters.remove("minimum_age");try{readRecords(connection,parameters);error("missing parameter accepted")}catch(expected:IllegalArgumentException){}
  val model=PeopleRow(1L,"Model",null,true,BigDecimal("123.45000000"),null,"2026-11-09T12:00:00",byteArrayOf(0,-1))
  check(model.amount!!.toPlainString()=="123.45000000");check(PeopleRow.PRIMARY_KEYS==listOf("id"))
  println("PASS read+model: filtered read, repeated NULL binds, bigint input/output, hostile data, missing parameter, exact model decimal")
 }
}
''')
    jdk=Path("C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot")
    env=dict(os.environ,JAVA_HOME=str(jdk))
    gradle=shutil.which("gradle")
    if not gradle:
        raise RuntimeError("Existing Gradle toolchain not found; no installation attempted")
    built=command("compile",[gradle,"--offline","--no-daemon","--console=plain","classes"],folder,240,env)
    results=[built]
    if built["passed"]:
        libraries=ROOT/"tests/codegen/generated/sqlite-kotlin-project/runtime/database-example/lib"
        classpath=os.pathsep.join([str(folder/"build/classes/kotlin/main")]+[str(path) for path in sorted(libraries.glob("*.jar"))])
        results.append(command("runtime",[str(jdk/"bin/java.exe"),"-cp",classpath,"QaKt",str(database)],folder,60,env))
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--languages", nargs="+", default=["rust", "csharp", "java", "typescript", "go", "kotlin"])
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    database = fixture()
    before = hashlib.sha256(database.read_bytes()).hexdigest()
    def version(args: list[str]) -> str:
        result = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15)
        return (result.stdout + result.stderr).strip().splitlines()[0]
    receipt = {"generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "endpoint": "http://127.0.0.1:8787/api/generate_workbench", "fixture": str(database), "columns": COLUMNS, "query": QUERY, "parameters": PARAMETERS, "results": {}, "toolchains": {"rust":version(["rustc","--version"]),"csharp":version(["dotnet","--version"]),"java":version(["javac","--version"]),"node":version(["node","--version"]),"typescript":version(["node",str(ROOT/"node_modules/typescript/bin/tsc"),"--version"]),"go":version(["go","version"]),"kotlin":"Kotlin JVM plugin 2.1.10, JDK 21.0.12.101, cached Gradle"}, "generatedSources":{}}
    runners = {"rust": rust, "csharp": csharp, "java": java, "typescript": typescript,"go":go,"kotlin":kotlin}
    for language in args.languages:
        try:
            folder = generate(language)
            receipt["results"][language] = runners[language](folder, database)
        except Exception as error:
            receipt["results"][language] = [{"passed": False, "error": repr(error)}]
            print(json.dumps({"language": language, "error": repr(error)}), flush=True)
        write(OUTPUT / "receipt.json", json.dumps(receipt, ensure_ascii=False, indent=2))
    receipt["fixtureUnchanged"] = hashlib.sha256(database.read_bytes()).hexdigest() == before
    for language in args.languages:
        sources=[]
        for artifact in ("read","model"):
            response=OUTPUT/language/f"generated-{artifact}.json"
            if not response.is_file():
                continue
            for item in json.loads(response.read_text(encoding="utf-8"))["files"]:
                path=OUTPUT/language/item["path"]
                expected=item["content"].encode("utf-8")
                sources.append({"artifact":artifact,"path":str(path),"sha256":hashlib.sha256(expected).hexdigest(),"unchanged":path.read_bytes()==expected})
        receipt["generatedSources"][language]=sources
    receipt["allPassed"] = receipt["fixtureUnchanged"] and all(step["passed"] for checks in receipt["results"].values() for step in checks) and all(source["unchanged"] for sources in receipt["generatedSources"].values() for source in sources)
    write(OUTPUT / "receipt.json", json.dumps(receipt, ensure_ascii=False, indent=2))
    print(json.dumps({"receipt": str(OUTPUT / "receipt.json"), "allPassed": receipt["allPassed"]}, ensure_ascii=False), flush=True)
    return 0 if receipt["allPassed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
