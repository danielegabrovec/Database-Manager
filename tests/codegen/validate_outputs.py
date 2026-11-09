"""Validate generated source syntax and real SQLite CRUD without executing other engines."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent / 'generated'
counts = {}
for path in ROOT.rglob('*.py'):
    ast.parse(path.read_text(encoding='utf-8'), filename=str(path))
    counts['python_syntax'] = counts.get('python_syntax', 0) + 1
for pattern in ('*.js', '*.ts'):
    for path in ROOT.rglob(pattern):
        result = subprocess.run(['node', '--check', str(path)], capture_output=True, text=True)
        if result.returncode:
            raise AssertionError(f'{path}\n{result.stderr}')
        counts['node_syntax'] = counts.get('node_syntax', 0) + 1
for path in ROOT.rglob('*.go'):
    result = subprocess.run(['gofmt', '-e', str(path)], capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(f'{path}\n{result.stderr}')
    counts['go_syntax'] = counts.get('go_syntax', 0) + 1
for path in ROOT.rglob('*.rs'):
    result = subprocess.run(['rustfmt', '--edition', '2021', '--emit', 'stdout', str(path)], capture_output=True, text=True)
    if result.returncode:
        raise AssertionError(f'{path}\n{result.stderr}')
    counts['rust_syntax'] = counts.get('rust_syntax', 0) + 1

with tempfile.TemporaryDirectory(prefix='codegen-sqlite-', dir=ROOT) as temporary:
    database = Path(temporary) / 'test.sqlite'
    os.environ['DATABASE_URL'] = str(database)
    with sqlite3.connect(database) as connection:
        connection.execute('CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    connection.close()
    path = ROOT / 'sqlite-python-project' / 'database.py'
    spec = importlib.util.spec_from_file_location('generated_database', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    big = 9223372036854775806
    # Keep the SQL-looking string as data, including quoting and Unicode.
    hostile = "Unicode è '; DROP TABLE people; --"
    assert module.execute('insert', {'id': big, 'name': hostile})['affected'] == 1
    assert module.execute('list') == [{'id': big, 'name': hostile}]
    assert module.execute('update', {'id': big, 'name': 'Aggiornato'})['affected'] == 1
    assert module.execute('list') == [{'id': big, 'name': 'Aggiornato'}]
    try:
        module.execute('delete', {})
        raise AssertionError('Missing key accepted')
    except ValueError:
        pass
    assert module.execute('delete', {'id': big})['affected'] == 1
    assert module.execute('list') == []
    counts['python_sqlite_crud'] = 'passed: int64, Unicode, SQL injection payload, missing PK, CRUD'
print(json.dumps(counts, ensure_ascii=False, indent=2))
