"""Apply the selected seed rows to one explicitly configured project database."""
import argparse
import base64
import json
import os
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent


def sqlite_destination(target):
    configured = os.environ.get(target['environment'])
    return Path(configured).expanduser().resolve() if configured else ROOT / 'dati' / (target['alias'] + '.sqlite')


def identifier(value, engine):
    quote = '`' if engine in ('mysql', 'mariadb') else '"'
    return quote + value.replace(quote, quote * 2) + quote


def bind(cell, engine):
    kind, value = cell['type'], cell.get('value')
    if kind == 'null':
        return None
    if kind == 'integer':
        number = int(value)
        if engine == 'mongodb' and cell.get('nativeType', '').lower() == 'int64':
            from bson.int64 import Int64
            return Int64(number)
        return number
    if kind == 'float':
        return float(value)
    if kind == 'decimal':
        if engine == 'mongodb':
            from bson.decimal128 import Decimal128
            return Decimal128(Decimal(value))
        return value if engine == 'sqlite' else Decimal(value)
    if kind == 'boolean':
        if value in (True, 'true', '1', 1):
            return True
        if value in (False, 'false', '0', 0):
            return False
        raise ValueError('Valore booleano del seed non valido.')
    if kind == 'binary':
        return base64.b64decode(value, validate=True)
    if kind == 'datetime' and engine == 'mongodb':
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    if kind == 'json':
        if engine == 'mongodb':
            from bson import json_util
            return json_util.loads(value)
        data = json.loads(value)
        if engine == 'postgresql':
            from psycopg.types.json import Json
            return Json(data)
        return json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    return value


def connect_sql(target):
    engine = target['engine']
    if engine == 'sqlite':
        connection = sqlite3.connect(sqlite_destination(target).as_uri() + '?mode=rw', uri=True)
        connection.execute('PRAGMA foreign_keys=ON')
        return connection
    endpoint = os.environ.get(target['environment'])
    if not endpoint:
        raise ValueError('Configura la variabile ' + target['environment'] + '.')
    if engine == 'postgresql':
        import psycopg
        return psycopg.connect(endpoint)
    import pymysql
    parsed = urlsplit(endpoint)
    if parsed.scheme not in ('mysql', 'mariadb') or not parsed.hostname or not parsed.path.lstrip('/'):
        raise ValueError('Specifica URI mysql:// o mariadb:// con un nome di database.')
    if parsed.query:
        raise ValueError('Per opzioni TLS personalizzate passa una connessione esistente a insert_sql().')
    return pymysql.connect(host=parsed.hostname, port=parsed.port or 3306, user=unquote(parsed.username or ''),
                           password=unquote(parsed.password or ''), database=unquote(parsed.path.lstrip('/')), charset='utf8mb4')


def prepared_rows(engine, rows):
    groups = {}
    for row in rows:
        key = (row['table'].get('schema'), row['table']['name'])
        groups.setdefault(key, []).append(row)
    ordered = []
    while groups:
        ready = next((key for key, group in groups.items() if all(
            (dependency.get('schema'), dependency['name']) not in groups or (dependency.get('schema'), dependency['name']) == key
            for dependency in group[0].get('dependsOn', []))), next(iter(groups)))
        ordered.extend(groups.pop(ready))
    return [(row, {key: bind(value, engine) for key, value in row['values'].items()}) for row in ordered]


def insert_sql(connection, engine, rows):
    mark = '?' if engine == 'sqlite' else '%s'
    with closing(connection.cursor()) as cursor:
        for row, values in rows:
            table = identifier(row['table']['name'], engine)
            schema = row['table'].get('schema')
            if schema and engine == 'postgresql':
                table = identifier(schema, engine) + '.' + table
            if values:
                columns = ', '.join(identifier(field, engine) for field in values)
                if engine != 'sqlite':
                    table = table.replace('%', '%%')
                    columns = columns.replace('%', '%%')
                parameters = ', '.join(mark for _ in values)
                override = ' OVERRIDING SYSTEM VALUE' if engine == 'postgresql' and row.get('overrideIdentity') else ''
                cursor.execute(f'INSERT INTO {table} ({columns}){override} VALUES ({parameters})', tuple(values.values()))
            elif engine in ('mysql', 'mariadb'):
                cursor.execute(f'INSERT INTO {table} () VALUES ()')
            else:
                cursor.execute(f'INSERT INTO {table} DEFAULT VALUES')


def apply(target, rows):
    engine = target['engine']
    rows = prepared_rows(engine, rows)
    if engine == 'mongodb':
        from pymongo import MongoClient
        endpoint = os.environ.get(target['environment'])
        if not endpoint:
            raise ValueError('Configura la variabile ' + target['environment'] + '.')
        with MongoClient(endpoint, serverSelectionTimeoutMS=10000) as client:
            database = client.get_default_database()
            if database.name in ('admin', 'local', 'config'):
                raise ValueError('Scegli un database applicativo nel percorso dell’URI.')
            existing = set(database.list_collection_names())
            if any(row['table']['name'] not in existing for row, _ in rows):
                raise ValueError('Applica prima lo schema delle collezioni del pacchetto.')
            for row, values in rows:
                database[row['table']['name']].insert_one(values)
        return len(rows)
    with closing(connect_sql(target)) as connection:
        if engine == 'sqlite':
            connection.execute('BEGIN')
            connection.execute('PRAGMA defer_foreign_keys=ON')
        try:
            insert_sql(connection, engine, rows)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
    return len(rows)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('alias')
    parser.add_argument('--conferma', action='store_true', help='Scrive il seed nella destinazione configurata')
    choice = parser.parse_args()
    targets = json.loads((ROOT / 'destinazioni.json').read_text(encoding='utf-8'))
    target = next((item for item in targets if item['alias'] == choice.alias), None)
    if not target or not target['seed']:
        parser.error('Destinazione sconosciuta o senza seed.')
    if not choice.conferma:
        parser.error('Controlla schema/URI e aggiungi --conferma per scrivere il seed.')
    rows = json.loads((ROOT / target['seed']).read_text(encoding='utf-8'))
    print(f'{apply(target, rows)} righe caricate in {choice.alias}.')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not print a connector exception which may include an authenticated URI.
        print(f'Seed non completato ({type(error).__name__}). Controlla dipendenze, destinazione, vincoli e dati; MongoDB può aver confermato righe precedenti.', file=sys.stderr)
        raise SystemExit(1) from None
