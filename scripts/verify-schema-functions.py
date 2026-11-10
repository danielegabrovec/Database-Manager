"""Compile/run verbatim schema functions against isolated SQLite connections.

Uses preinstalled toolchains and cached dependencies; never installs runtimes or
connects to a user database. Run the Rust workbench_generation test first.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'artifacts/qa-schema-code-20261110/sqlite'
OUT = ROOT / 'artifacts/qa-schema-functions-runtime-20261110'
TOOLS = ROOT / 'tests/codegen/toolchains'
OUT.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, GEM_HOME=str(TOOLS/'gems'), GEM_PATH=str(TOOLS/'gems'), CARGO_NET_OFFLINE='true', GOPROXY='off')
env['PATH'] = 'C:/msys64/ucrt64/bin' + os.pathsep + env.get('PATH','')

def run(args, cwd):
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, env=env, capture_output=True, text=True, encoding='utf8', errors='replace', timeout=180)
    if result.returncode: raise RuntimeError(result.stderr[-4000:] + result.stdout[-1000:])
    return result.stdout

def write(folder, name, content):
    path=folder/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(content,encoding='utf8');return path

results=[]
for language in ['python','javascript','typescript','c','cpp','php','ruby','java','csharp','go','rust','kotlin']:
    folder=OUT/language;folder.mkdir(parents=True,exist_ok=True)
    sources=[p for p in (FIXTURES/language).iterdir() if p.suffix not in {'.sql','.md'} and p.name not in {'runner.py','runner.mjs'} and p.is_file()]
    original={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}
    for source in sources:shutil.copyfile(source,folder/source.name)
    try:
        if language=='python':
            write(folder,'qa.py',"import sqlite3\nfrom schema import apply_schema\nc=sqlite3.connect(':memory:')\nassert apply_schema(c)==2\nc.execute(\"INSERT INTO people VALUES(1,'città €')\")\nassert c.execute('SELECT name FROM people').fetchone()[0]=='città €'\n")
            run(['python','qa.py'],folder)
        elif language=='javascript':
            write(folder,'qa.mjs',"import {DatabaseSync} from 'node:sqlite';import {applySchema} from './schema.mjs';const db=new DatabaseSync(':memory:');if(await applySchema(db)!==2)throw Error('count');db.exec(\"INSERT INTO people VALUES(1,'città €')\");if(db.prepare('SELECT name FROM people').get().name!=='città €')throw Error('row');")
            run(['node','qa.mjs'],folder)
        elif language=='typescript':
            run(['node',ROOT/'node_modules/typescript/bin/tsc','schema.ts','--target','ES2022','--module','NodeNext','--strict','--skipLibCheck','--outDir','compiled'],folder)
            write(folder,'compiled/qa.mjs',"import {DatabaseSync} from 'node:sqlite';import {applySchema} from './schema.js';const db=new DatabaseSync(':memory:');if(await applySchema(db)!==2)throw Error('schema');db.exec(\"INSERT INTO people VALUES(1,'città €')\");if(db.prepare('SELECT COUNT(*) AS n FROM people').get().n!==1)throw Error('row');")
            run(['node','compiled/qa.mjs'],folder)
        elif language in ['c','cpp']:
            write(folder,'qa.'+('c' if language=='c' else 'cpp'),'#include "schema.'+('c' if language=='c' else 'cpp')+'"\nint main(void){sqlite3 *db=NULL;if(sqlite3_open(":memory:",&db)!=SQLITE_OK)return 1;if(apply_schema(db)!=2)return 2;if(sqlite3_exec(db,"INSERT INTO people VALUES(1,\'Ada\')",NULL,NULL,NULL)!=SQLITE_OK)return 3;sqlite3_close(db);return 0;}')
            compiler='gcc.exe' if language=='c' else 'g++.exe'
            run(['C:/msys64/ucrt64/bin/'+compiler,'-std=c11' if language=='c' else '-std=c++20','qa.'+('c' if language=='c' else 'cpp'),'-lsqlite3','-o','qa.exe'],folder)
            run([folder/'qa.exe'],folder)
        elif language=='php':
            write(folder,'qa.php',"<?php\nrequire 'schema.php';\n$c=new PDO('sqlite::memory:');$c->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);if(applySchema($c)!==2)throw new RuntimeException('count');$c->exec(\"INSERT INTO people VALUES(1,'Ada')\");if((int)$c->query('SELECT COUNT(*) FROM people')->fetchColumn()!==1)throw new RuntimeException('row');")
            run([TOOLS/'php/php.exe','-n','-d','extension_dir='+str(TOOLS/'php/ext'),'-d','extension=pdo_sqlite','qa.php'],folder)
        elif language=='ruby':
            write(folder,'qa.rb',"require 'sqlite3'\nrequire_relative 'schema'\nc=SQLite3::Database.new(':memory:')\nraise 'count' unless apply_schema(c)==2\nc.execute(\"INSERT INTO people VALUES(1,'Ada')\")\nraise 'row' unless c.get_first_value('SELECT COUNT(*) FROM people')==1\nc.close\n")
            run([TOOLS/'ruby/rubyinstaller-4.0.9-1-x64/bin/ruby.exe','qa.rb'],folder)
        elif language=='java':
            libs=ROOT/'tests/codegen/generated/sqlite-java-project/runtime/database-example/lib'
            cp=os.pathsep.join(str(p) for p in libs.glob('*.jar'))
            write(folder,'Qa.java','import java.sql.*;public class Qa{public static void main(String[] args)throws Exception{Class.forName("org.sqlite.JDBC");try(Connection c=DriverManager.getConnection("jdbc:sqlite::memory:")){DatabaseSchema.applySchema(c);c.createStatement().executeUpdate("INSERT INTO people VALUES(1,\'Ada\')");ResultSet r=c.createStatement().executeQuery("SELECT COUNT(*) FROM people");if(!r.next()||r.getInt(1)!=1)throw new RuntimeException("row");}}}')
            run(['javac','-encoding','UTF-8','DatabaseSchema.java','Qa.java'],folder)
            run(['java','-cp',str(folder)+os.pathsep+cp,'Qa'],folder)
        elif language=='csharp':
            write(folder,'Qa.csproj','<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Microsoft.Data.Sqlite" Version="10.0.13" /></ItemGroup></Project>')
            write(folder,'Program.cs','using Microsoft.Data.Sqlite;using System;using var c=new SqliteConnection("Data Source=:memory:");c.Open();if(await DatabaseSchema.ApplySchemaAsync(c)!=2)throw new Exception("count");using var cmd=c.CreateCommand();cmd.CommandText="INSERT INTO people VALUES(1,\'Ada\')";cmd.ExecuteNonQuery();cmd.CommandText="SELECT COUNT(*) FROM people";if(Convert.ToInt64(cmd.ExecuteScalar())!=1)throw new Exception("row");')
            run(['dotnet','restore','--ignore-failed-sources'],folder);run(['dotnet','run','--no-restore'],folder)
        elif language=='go':
            (folder/'schema').mkdir(exist_ok=True);shutil.move(folder/'schema.go',folder/'schema/schema.go')
            write(folder,'go.mod','module qa-schema\n\ngo 1.23\n\nrequire modernc.org/sqlite v1.34.5\n')
            shutil.copyfile(ROOT/'tests/codegen/generated/sqlite-go-project/go.sum',folder/'go.sum')
            write(folder,'main.go','package main\nimport("context";"database/sql";dbschema "qa-schema/schema";_ "modernc.org/sqlite")\nfunc main(){c,e:=sql.Open("sqlite",":memory:");if e!=nil{panic(e)};defer c.Close();if e=dbschema.ApplySchema(context.Background(),c);e!=nil{panic(e)};if _,e=c.Exec("INSERT INTO people VALUES(1,\'Ada\')");e!=nil{panic(e)}}\n')
            run(['go','run','-mod=mod','.'],folder)
        elif language=='rust':
            write(folder,'Cargo.toml','[package]\nname="qa-schema"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nsqlx={version="0.9",default-features=false,features=["runtime-tokio","sqlite"]}\ntokio={version="1",features=["macros","rt-multi-thread"]}\n')
            write(folder,'src/main.rs','#[path="../schema.rs"]mod schema;\n#[tokio::main]async fn main()->Result<(),Box<dyn std::error::Error>>{let pool=sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await?;assert_eq!(schema::apply_schema(&pool).await?,2);sqlx::query("INSERT INTO people VALUES(1,\'Ada\')").execute(&pool).await?;Ok(())}\n')
            run(['cargo','run','--offline','--quiet'],folder)
        else:
            # Reuse the existing cached Gradle/JDBC toolchain, with the new source verbatim.
            write(folder,'settings.gradle.kts','rootProject.name = "qa-schema-kotlin"\n')
            write(folder,'build.gradle.kts','plugins { kotlin("jvm") version "2.1.10"; application }\nrepositories { mavenCentral() }\ndependencies { implementation("org.xerial:sqlite-jdbc:3.47.2.0") }\nkotlin { jvmToolchain(21); sourceSets.main { kotlin.setSrcDirs(listOf("src")) } }\napplication { mainClass.set("QaKt") }\n')
            (folder/'src').mkdir(exist_ok=True);shutil.move(folder/'DatabaseSchema.kt',folder/'src/DatabaseSchema.kt')
            write(folder,'src/Qa.kt','import java.sql.DriverManager\nfun main(){Class.forName("org.sqlite.JDBC");DriverManager.getConnection("jdbc:sqlite::memory:").use { c -> check(applySchema(c)==2);c.createStatement().use { it.executeUpdate("INSERT INTO people VALUES(1,\'Ada\')") } }}\n')
            run(['gradle.bat','--offline','--no-daemon','run'],folder)
        assert original=={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},'generated source changed'
        results.append({'language':language,'compileAndSqliteRuntime':'passed','sourceUnchanged':True})
        print(language,'passed',flush=True)
    except Exception as error:
        results.append({'language':language,'status':'failed','error':str(error)});print(language,'FAILED',str(error)[-1800:],flush=True)
(OUT/'receipt.json').write_text(json.dumps({'allPassed':all(r.get('compileAndSqliteRuntime')=='passed' for r in results),'results':results},ensure_ascii=False,indent=2),encoding='utf8')
if any(r.get('status')=='failed' for r in results):raise SystemExit(1)
