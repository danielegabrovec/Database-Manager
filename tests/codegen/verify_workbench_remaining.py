"""Run remaining generated read/model modules using existing cached toolchains only."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

WORKSPACE = Path(__file__).resolve().parents[2]
FIXTURES = WORKSPACE / "artifacts/qa-workbench-fixtures"
OUT = WORKSPACE / "artifacts/qa-workbench-remaining"
TOOLS = Path(__file__).resolve().parent / "toolchains"
OUT.mkdir(parents=True, exist_ok=True)
env = dict(os.environ, GEM_HOME=str(TOOLS / "gems"), GEM_PATH=str(TOOLS / "gems"))
env["PATH"] = str(TOOLS / "ruby/rubyinstaller-4.0.9-1-x64/bin") + os.pathsep + "C:/msys64/ucrt64/bin" + os.pathsep + env.get("PATH", "")

def run(command, folder):
    result = subprocess.run(command, cwd=folder, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    if result.returncode:
        raise AssertionError(f"exit={result.returncode}: {result.stderr[-5000:]} {result.stdout[-1200:]}")
    return result.stdout

results = []
for language in ["c", "cpp", "php", "ruby"]:
    target = OUT / language
    target.mkdir(parents=True, exist_ok=True)
    read = FIXTURES / language / "read/workbench" / {"c":"read_records.h", "cpp":"read_records.hpp", "php":"read_records.php", "ruby":"read_records.rb"}[language]
    model = FIXTURES / language / "model/workbench" / {"c":"model.h", "cpp":"model.hpp", "php":"Model.php", "ruby":"model.rb"}[language]
    original = {str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in [read, model]}
    try:
        if language in ["c", "cpp"]:
            filename = target / ("runner.c" if language == "c" else "runner.cpp")
            includes = f'#include {json.dumps(read.as_posix())}\n#include {json.dumps(model.as_posix())}\n'
            constructor = "PeopleRow model={0};model.id=2;model.name_is_null=true;" if language == "c" else "PeopleRow model{};model.id=2;model.name=std::nullopt;"
            source = includes + r'''
static int seen=0;
static void consume(const DbmReadCell *cells,size_t count,void *unused){
    (void)unused; if(count!=2) abort();
    int64_t id=(int64_t)strtoll((const char*)cells[0].data,NULL,10);
    if(id!=2 && id!=9223372036854775806LL) abort();
    seen++;
}
int main(void){
    sqlite3 *db=NULL;if(sqlite3_open(":memory:",&db)!=SQLITE_OK)return 1;
    if(sqlite3_exec(db,"CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO people VALUES(1,'Ada'),(2,'Grace'),(9223372036854775806,'last');",NULL,NULL,NULL)!=SQLITE_OK)return 2;
    DbmSqlParameter parameter={0};parameter.integer=2;
    if(read_records(db,&parameter,1,consume,NULL)!=2 || seen!=2)return 3;
    if(read_records(db,&parameter,0,consume,NULL)!=-1)return 4;
''' + constructor + r'''
    sqlite3_close(db);return model.id==2?0:5;
}
'''
            filename.write_text(source, encoding="utf8")
            exe = target / "runner.exe"
            compiler = "C:/msys64/ucrt64/bin/gcc.exe" if language == "c" else "C:/msys64/ucrt64/bin/g++.exe"
            run([compiler, "-std=c11" if language == "c" else "-std=c++20", str(filename), "-lsqlite3", "-o", str(exe)], target)
            run([str(exe)], target)
        elif language == "php":
            script = target / "runner.php"
            script.write_text("<?php\nrequire " + repr(read.as_posix()) + ";\nrequire " + repr(model.as_posix()) + ";\n" + r'''
$db=new PDO('sqlite::memory:');$db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);
$db->exec("CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO people VALUES(1,'Ada'),(2,'Grace'),(9223372036854775806,'last');");
$rows=DatabaseWorkbench\read_records($db,['p1'=>2]);
if(count($rows)!==2 || $rows[1]['id']!==9223372036854775806)throw new RuntimeException('rows/int64 mismatch');
$model=new DatabaseWorkbench\PeopleRow($rows[0]['id'],$rows[0]['name']);if($model->id!==2)throw new RuntimeException('model mismatch');
try{DatabaseWorkbench\read_records($db,[]);throw new RuntimeException('missing parameter accepted');}catch(InvalidArgumentException $expected){}
'''.replace("\\", "\\"), encoding="utf8")
            run([str(TOOLS / "php/php.exe"), "-n", "-d", "extension_dir="+str(TOOLS / "php/ext"), "-d", "extension=pdo_sqlite", str(script)], target)
        else:
            script = target / "runner.rb"
            script.write_text("require 'sqlite3'\nrequire " + repr(read.as_posix()) + "\nrequire " + repr(model.as_posix()) + "\n" + r'''
db=SQLite3::Database.new(':memory:');db.results_as_hash=true
db.execute_batch("CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT); INSERT INTO people VALUES(1,'Ada'),(2,'Grace'),(9223372036854775806,'last');")
rows=DatabaseWorkbench.read_records(db,{'p1'=>2})
raise 'rows/int64 mismatch' unless rows.length==2 && rows.last['id']==9223372036854775806
model=DatabaseWorkbench::PeopleRow.new(id: rows.first['id'],name: nil)
raise 'model mismatch' unless model.id==2 && model.name.nil?
begin
  DatabaseWorkbench.read_records(db,{})
  raise 'missing parameter accepted'
rescue KeyError
end
db.close
''', encoding="utf8")
            run([str(TOOLS / "ruby/rubyinstaller-4.0.9-1-x64/bin/ruby.exe"), str(script)], target)
        current = {str(path):hashlib.sha256(path.read_bytes()).hexdigest() for path in [read, model]}
        assert original == current, "generated fixture modified"
        results.append({"language":language,"compileOrParse":"passed","sqliteRuntime":"passed","modelRuntime":"passed","int64Exact":True,"missingParameterRejected":True,"fixtureUnchanged":True,"sourceSha256":original})
        print(language, "passed", flush=True)
    except Exception as error:
        results.append({"language":language,"status":"failed","error":str(error),"sourceSha256":original})
        print(language, "FAILED", str(error), flush=True)
(OUT / "receipt.json").write_text(json.dumps({"allPassed":all(r.get("sqliteRuntime")=="passed" for r in results),"results":results},ensure_ascii=False,indent=2),encoding="utf8")
if any(r.get("status")=="failed" for r in results):raise SystemExit(1)
