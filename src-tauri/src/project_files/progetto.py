"""Dispatch the generated SQLite drivers to independent database destinations."""
import argparse
import json
import os
import sqlite3
import subprocess
import sys
from contextlib import closing
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def targets():
    return json.loads((ROOT / 'destinazioni.json').read_text(encoding='utf-8'))


def destination(target):
    if target['engine'] != 'sqlite':
        raise ValueError('Questo avvio integrato accetta SQLite. Usa il driver della destinazione indicato nel README.')
    configured = os.environ.get(target['environment'])
    return Path(configured).expanduser().resolve() if configured else ROOT / 'dati' / (target['alias'] + '.sqlite')


def initialize(target):
    path = destination(target)
    ddl = (ROOT / target['schema']).read_text(encoding='utf-8')
    seed = json.loads((ROOT / target['seed']).read_text(encoding='utf-8')) if target['seed'] else []
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb'):
        pass
    try:
        with closing(sqlite3.connect(path)) as connection:
            connection.execute('PRAGMA foreign_keys=ON')
            connection.executescript('BEGIN;\n' + ddl)
            connection.execute('PRAGMA defer_foreign_keys=ON')
            if seed:
                from carica_seed import insert_sql, prepared_rows
                insert_sql(connection, 'sqlite', prepared_rows('sqlite', seed))
            connection.commit()
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path


def execute(target, module, operation, payload):
    path = destination(target)
    if not path.is_file():
        raise ValueError('Inizializza la destinazione prima di eseguire un modulo.')
    driver = ROOT / module['directory'] / 'database.py'
    environment = dict(os.environ, DATABASE_URL=str(path))
    command = [sys.executable, str(driver), operation, payload]
    return subprocess.run(command, env=environment, cwd=driver.parent, check=False).returncode


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('elenco')
    init = actions.add_parser('inizializza')
    init.add_argument('alias')
    run = actions.add_parser('esegui')
    run.add_argument('alias')
    run.add_argument('module')
    run.add_argument('operation', choices=['list', 'insert', 'update', 'delete'])
    run.add_argument('payload', nargs='?', default='{}')
    options = parser.parse_args()
    databases = targets()
    if options.action == 'elenco':
        print(json.dumps(databases, ensure_ascii=False, indent=2))
        return 0
    target = next((item for item in databases if item['alias'] == options.alias), None)
    if target is None:
        parser.error('Alias di destinazione sconosciuto.')
    if options.action == 'inizializza':
        print(initialize(target))
        return 0
    module = next((item for item in target['modules'] if item['id'] == options.module), None)
    if module is None:
        parser.error('Modulo sconosciuto per questa destinazione.')
    return execute(target, module, options.operation, options.payload)


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, sqlite3.Error, ValueError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from None
