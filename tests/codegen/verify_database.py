"""Run generated Python/JS/TS CLI code against an isolated QA database. Credentials remain in child env."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit, unquote
import zipfile

engine = sys.argv[1]
root = Path(__file__).resolve().parent
url = urlsplit(os.environ['DATABASE_URL'])
if engine == 'mongodb':
    from pymongo import MongoClient
    with MongoClient(os.environ['DATABASE_URL']) as client:
        client[os.environ['DATABASE_NAME']]['people'].delete_many({})
else:
    if engine == 'postgresql':
        import psycopg
        connection = psycopg.connect(os.environ['DATABASE_URL'])
    else:
        import pymysql
        connection = pymysql.connect(host=url.hostname, port=url.port, user=unquote(url.username), password=unquote(url.password), database=unquote(url.path.lstrip('/')))
    with connection.cursor() as cursor:
        cursor.execute('DROP TABLE IF EXISTS people')
        cursor.execute('CREATE TABLE people (id BIGINT PRIMARY KEY, name TEXT NOT NULL)')
    connection.commit()
    connection.close()

def run_cli(command, cwd, operation, payload=None):
    child_environment = dict(os.environ, PYTHONIOENCODING='utf-8')
    result = subprocess.run(command + [operation] + ([json.dumps(payload)] if payload is not None else []), cwd=cwd, capture_output=True, encoding='utf-8', timeout=60, env=child_environment)
    if result.returncode:
        raise AssertionError(f'{operation}: exit={result.returncode} {result.stderr} {result.stdout}')
    return json.loads(result.stdout)

languages = ['python','javascript','typescript','rust']
if (root / 'generated' / f'{engine}-go-project/database-example.exe').exists(): languages.append('go')
if (root / 'generated' / f'{engine}-csharp-project/bin/Debug/net10.0/DatabaseExample.dll').exists(): languages.append('csharp')
for candidate in ('java','kotlin'):
    if (root/'generated'/f'{engine}-{candidate}-project/build/distributions/database-example.zip').exists():languages.append(candidate)
languages.append('php')
languages.append('ruby')
for candidate in ('c','cpp'):
    if (root/'generated'/f'{engine}-{candidate}-project/database-example.exe').exists():languages.append(candidate)
if os.environ.get('CODEGEN_QA_LANGUAGES'):
    languages=[language for language in languages if language in os.environ['CODEGEN_QA_LANGUAGES'].split(',')]
native=root.parents[1]/'artifacts/qa-native/fdffa688-5d8b-4b25-8dd1-652ec43b7666/native-runtimes'
os.environ['PATH']=str(root/'toolchains/mongo-native/bin')+os.pathsep+str(native/'postgresql-18-6/pgsql/bin')+os.pathsep+str(native/'mariadb-11-8-5/mariadb-11.8.5-winx64/lib')+os.pathsep+str(native/'mariadb-11-8-5/mariadb-11.8.5-winx64/bin')+os.pathsep+'C:/msys64/ucrt64/bin'+os.pathsep+os.environ['PATH']
for language in languages:
    folder = root / 'generated' / f'{engine}-{language}-project'
    command = [sys.executable, 'database.py'] if language == 'python' else ['node', 'database.js' if language == 'javascript' else 'dist/database.js'] if language in ('javascript','typescript') else [str(folder / 'database-example.exe')] if language in ('rust','go') else ['dotnet','bin/Debug/net10.0/DatabaseExample.dll']
    if language in ('c','cpp'):command=[str(folder/'database-example.exe')]
    if language=='php':command=[str(root/'toolchains/php/php.exe'),'-n','-d','extension_dir='+str(root/'toolchains/php/ext'),'-d','extension=mongodb' if engine=='mongodb' else 'extension=pdo_pgsql' if engine=='postgresql' else 'extension=pdo_mysql','database.php']
    if language=='ruby':
        command=[str(root/'toolchains/ruby/rubyinstaller-4.0.9-1-x64/bin/ruby.exe'),'database.rb']
        os.environ['GEM_HOME']=str(root/'toolchains/gems');os.environ['GEM_PATH']=str(root/'toolchains/gems')
    if language in ('java','kotlin'):
        with zipfile.ZipFile(folder/'build/distributions/database-example.zip') as archive:archive.extractall(folder/'runtime')
        jars=sorted((folder/'runtime/database-example/lib').glob('*.jar'))
        command=['java','-Dstdout.encoding=UTF-8','-Dstderr.encoding=UTF-8','-cp',os.pathsep.join(str(path) for path in jars),'Database' if language=='java' else 'MainKt']
    record = {'_id': 1042, 'name': "È un dato '; DROP TABLE people; --"} if engine == 'mongodb' else {'id': 1042, 'name': "È un dato '; DROP TABLE people; --"}
    run_cli(command, folder, 'insert', record)
    rows = run_cli(command, folder, 'list')
    assert len(rows) == 1 and rows[0]['name'] == record['name'], (language, rows)
    record['name'] = 'Aggiornato'
    run_cli(command, folder, 'update', record)
    rows = run_cli(command, folder, 'list')
    assert len(rows) == 1 and rows[0]['name'] == 'Aggiornato', (language, rows)
    key = {'_id': 1042} if engine == 'mongodb' else {'id': 1042}
    run_cli(command, folder, 'delete', key)
    assert run_cli(command, folder, 'list') == []
    print(language + ': CRUD, Unicode, parameterization passed')
