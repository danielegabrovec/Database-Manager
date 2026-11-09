import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent
GENERATED = ROOT / 'generated'
toolchains = ROOT / 'toolchains'
ruby = toolchains / 'ruby/rubyinstaller-4.0.9-1-x64/bin/ruby.exe'
php = toolchains / 'php/php.exe'
recipes = {
    'python': ['python', 'database.py'],
    'javascript': ['node', 'database.js'],
    'typescript': ['node', 'dist/database.js'],
    'csharp': ['dotnet', 'bin/Debug/net10.0/DatabaseExample.dll'],
    'go': [str(GENERATED / 'sqlite-go-project/database-example.exe')],
    'c': [str(GENERATED / 'sqlite-c-project/database-example.exe')],
    'cpp': [str(GENERATED / 'sqlite-cpp-project/database-example.exe')],
    'php': [str(php), '-n', '-d', 'extension_dir=' + str(toolchains / 'php/ext'), '-d', 'extension=pdo_sqlite', 'database.php'],
    'ruby': [str(ruby), 'database.rb'],
}
for language in ('java', 'kotlin'):
    folder = GENERATED / f'sqlite-{language}-project'
    package = folder / 'build/distributions/database-example.zip'
    if package.exists():
        with zipfile.ZipFile(package) as archive: archive.extractall(folder / 'runtime')
        jars = sorted((folder / 'runtime/database-example/lib').glob('*.jar'))
        recipes[language] = ['java', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8', '-cp', os.pathsep.join(str(path) for path in jars), 'Database' if language == 'java' else 'MainKt']
rust = GENERATED / 'sqlite-rust-project/database-example.exe'
if rust.exists(): recipes['rust'] = [str(rust)]

environment = dict(os.environ, PYTHONIOENCODING='utf-8', GEM_HOME=str(toolchains / 'gems'), GEM_PATH=str(toolchains / 'gems'))
environment['PATH'] = str(ruby.parent) + os.pathsep + 'C:/msys64/ucrt64/bin' + os.pathsep + environment.get('PATH', '')
results = []
with tempfile.TemporaryDirectory(prefix='sqlite-matrix-', dir=GENERATED) as temporary:
    database = Path(temporary) / 'database.sqlite'
    connection = sqlite3.connect(database)
    connection.execute('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    connection.commit()
    connection.close()
    environment['DATABASE_URL'] = str(database)
    for language, command in recipes.items():
        folder = GENERATED / f'sqlite-{language}-project'
        def run(operation, payload=None):
            completed = subprocess.run(command + [operation] + ([json.dumps(payload)] if payload else []), cwd=folder, env=environment, capture_output=True, encoding='utf-8', timeout=60)
            if completed.returncode: raise AssertionError(f'{completed.returncode}: {completed.stderr} {completed.stdout}')
            return json.loads(completed.stdout)
        try:
            run('insert', {'id': 12, 'name': "È un dato '; DROP TABLE people; --"})
            rows = run('list')
            assert rows[0]['name'] == "È un dato '; DROP TABLE people; --", rows
            run('update', {'id': 12, 'name': 'Aggiornato'})
            assert run('list')[0]['name'] == 'Aggiornato'
            run('delete', {'id': 12})
            assert run('list') == []
            results.append({'language': language, 'success': True})
        except Exception as error:
            results.append({'language': language, 'success': False, 'error': str(error)})
            connection = sqlite3.connect(database)
            connection.execute('DELETE FROM people')
            connection.commit()
            connection.close()
print(json.dumps(results, ensure_ascii=False, indent=2))
(GENERATED / 'sqlite-cli-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
