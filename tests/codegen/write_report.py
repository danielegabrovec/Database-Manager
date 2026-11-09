"""Consolidate completed checks, never infer a runtime pass from successful generation."""
import hashlib
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
QA=ROOT/'tests/codegen/generated'
def read(name):return json.loads((QA/name).read_text(encoding='utf-8'))
sqlite=read('sqlite-cli-results.json')
baseline=read('qa-results.json')
rest=read('rest-qa-results.json')
sqlite_rest=read('rest-sqlite-results.json')
regression=read('qa-dependency-regression.json')
assert len(sqlite)==12 and all(item['success'] for item in sqlite)
assert len(baseline)==4 and all(item['success'] for item in baseline)
assert len(regression)==3 and all(item['success'] for item in regression)
assert len(rest)==4 and all(item['success'] for item in rest)
assert len(sqlite_rest)==4 and all(item['success'] for item in sqlite_rest)
languages=['rust','python','javascript','typescript','php','java','csharp','c','cpp','go','kotlin','ruby']
engines=['sqlite','postgresql','mysql','mariadb','mongodb']
compiled={'rust','typescript','java','csharp','c','cpp','go','kotlin'}
combinations=[]
for engine in engines:
    proof=next((row for row in baseline if row['engine']==engine),None)
    for language in languages:
        if engine!='sqlite':assert language+': CRUD, Unicode, parameterization passed' in proof['stdout']
        folder=QA/f'{engine}-{language}-project'
        source_hashes={str(path.relative_to(folder)):hashlib.sha256(path.read_bytes()).hexdigest() for path in folder.rglob('*') if path.is_file() and path.suffix in ('.rs','.py','.js','.ts','.php','.java','.cs','.c','.cpp','.go','.kt','.rb') and not any(part in ('target','node_modules','vendor','dist','bin','obj','build','runtime') for part in path.relative_to(folder).parts)}
        combinations.append({'engine':engine,'language':language,'output':'project','generated':True,'compile':'pass' if language in compiled else 'not_applicable_interpreted','syntax':'pass','runtime':'pass','method':'CLI create/read/update/delete against real database','checks':['insert','read','update','delete','Unicode round trip','SQL-looking value kept as data' if engine!='mongodb' else 'Extended JSON/document round trip'],'pass':True,'skipped':False,'error':None,'sourceSha256':source_hashes,'dependencyRegression':'pass' if language=='csharp' and engine in ('mysql','mariadb','mongodb') else None})
    api_proof=sqlite_rest if engine=='sqlite' else json.loads(next(row for row in rest if row['engine']==engine)['stdout'])
    for language in ('rust','python','javascript','typescript'):
        assert next(row for row in api_proof if row['language']==language)['success']
        combinations.append({'engine':engine,'language':language,'output':'rest','framework':{'rust':'Axum','python':'FastAPI','javascript':'Fastify','typescript':'Fastify'}[language],'generated':True,'compile':'pass' if language in compiled else 'not_applicable_interpreted','syntax':'pass','runtime':'pass','method':'Real HTTP requests to loopback API','checks':['GET /health','POST /records','GET /records','PUT /records','DELETE /records','Unicode and quoted value round trip'],'pass':True,'skipped':False,'error':None})
report={'schemaVersion':1,'verifiedOn':'2026-11-09','timezone':'Europe/Rome','summary':{'catalog':80,'projectRuntimePass':60,'restRuntimePass':20,'runtimePass':80,'nativeOrTypeScriptCompilePass':50,'interpretedRuntimePass':30,'compileOnly':0,'skipped':0,'failed':0},'fixture':{'sql':'people(id BIGINT PRIMARY KEY, name TEXT NOT NULL); SQLite INTEGER PRIMARY KEY','mongodb':'people documents with _id and name','limits':'Certification covers the stated CRUD fixture, not every database type or every possible user-written query.'},'toolchains':{'rustc':'1.99.0','go':'1.27.0 windows/amd64','python':'3.11.15','node':'24.15.0','typescriptCompiler':'6.0.3','typescriptPackage':'5.9.3','dotnetSDK':'10.0.401','dotnetTarget':'net10.0','javaRuntime':'25.0.4.101','javaToolchain':'21.0.12.101','gradle':'9.7.1','kotlinPlugin':'2.1.10','php':'8.4.27 NTS x64','ruby':'4.0.9 x64-mingw-ucrt','gcc':'16.2.0','msvc':'19.51.36260','mongoCDriver':'2.5.8'},'drivers':{'rust':{'sqlx':'0.9.0','mongodb':'3.10.0'},'python':{'psycopg':'3.3.8','PyMySQL':'1.2.4','pymongo':'4.19.0','fastapi':'0.162.2','uvicorn':'0.54.0'},'node':{'better-sqlite3':'12.11.1','pg':'8.23.1','mariadb':'3.5.5','mongodb':'6.22.0','fastify':'5.12.8'},'dotnet':{'Microsoft.Data.Sqlite':'10.0.13','Npgsql':'10.0.3','MySqlConnector':'2.6.2','MongoDB.Driver':'3.13.0'},'ruby':{'sqlite3':'2.10.2','pg':'1.7.0','mysql2':'0.5.7','bson':'5.2.0','mongo':'2.26.1','logger':'1.7.0'},'php':{'ext-mongodb':'2.5.7','mongodb/mongodb':'2.5.1'}},'limitations':['Binary SQL columns are explicitly rejected in generators other than Rust/Python/JavaScript/TypeScript; script output remains supported.','The test fixture does not certify all date/decimal/custom-type mappings.','C++ deliberately uses official C APIs with RAII for native handles, instead of libpqxx/mongocxx.','Native MySQL examples may require DB_PLUGIN_DIR for connector authentication plugins.','API examples bind to 127.0.0.1:3000; external publication requires application authentication/authorization.','No AI generation or remote execution is performed by the generator.'],'combinations':combinations}
assert len(combinations)==80
(ROOT/'artifacts/qa-codegen-final.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report['summary']))
