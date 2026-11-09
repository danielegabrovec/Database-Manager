use super::*;

pub(super) struct Template {
    pub source: String,
    pub path: String,
    pub files: Vec<GeneratedFile>,
    pub command: String,
    pub dependencies: String,
}
pub(super) fn generate(ctx: &Context) -> Result<GeneratedProject, String> {
    let t = build(ctx)?;
    let mut files = vec![file(&t.path, &t.source)];
    let mut notes = Vec::new();
    if ctx.req.output == "snippet" {
        notes.push(format!("Esempio driver autonomo. Dipendenze: {}. Il programma esegue list di default; passa insert/update/delete e un payload JSON per scrivere.",t.dependencies));
    } else {
        files.extend(t.files);
        files.extend(common_files(ctx, &t.command, &t.dependencies));
        files.extend(super::script(ctx)?.files);
    }
    if ctx.req.language == "cpp" {
        notes.push("C++ usa le API C ufficiali SQLite, MariaDB Connector/C, libpq e libmongoc; unique_ptr con deleter specifici gestisce gli handle. Scelta esplicita per ridurre dipendenze e problemi ABI su Windows.".into());
    }
    Ok(GeneratedProject {
        files,
        command: t.command,
        notes,
    })
}
pub(super) fn common_files(ctx: &Context, command: &str, dependencies: &str) -> Vec<GeneratedFile> {
    let example = if ctx.req.engine == "sqlite" {
        "DATABASE_URL=./database.sqlite\nDATABASE_NAME=database\n".into()
    } else {
        format!("DATABASE_URL={}\nDATABASE_NAME=database\n", ctx.url())
    };
    let readme=format!("# Esempio {} / {}\n\nDipendenze: {}\n\nImpostare DATABASE_URL e, per MongoDB, DATABASE_NAME nel terminale. `.env.example` è documentazione: il programma legge le variabili d'ambiente, non carica automaticamente il file. Non salvare credenziali nel repository.\n\n## Esecuzione\n\n```powershell\n$env:DATABASE_URL = '{}'\n{}\n```\n\nL'esecuzione senza argomenti legge al massimo 100 righe con la query configurata. Le operazioni `insert`, `update`, `delete` prendono un oggetto JSON come secondo argomento. `update` richiede tutti i campi non chiave; `delete` richiede tutte le chiavi. `insert` include anche le chiavi: gli ID sono forniti dal chiamante. Provare su un database di sviluppo. Le tabelle devono già esistere.\n\nValori binari: array JSON di byte; date e decimal: stringhe senza arrotondamento. Per MongoDB usare Extended JSON, ad esempio {{\"_id\":{{\"$oid\":\"507f1f77bcf86cd799439011\"}}}}. Le modifiche sono esplicite e i valori SQL sono parametri.\n\nLe query libere possono leggere colonne arbitrarie; i CRUD usano le colonne selezionate nel generatore. I tipi specifici del motore non mappabili producono un errore e non sono convertiti silenziosamente.\n",ctx.req.language,ctx.req.engine,dependencies,if ctx.req.engine=="sqlite"{"./database.sqlite"}else{ctx.url()},command);
    vec![
        file(".env.example", example),
        file(
            ".gitignore",
            ".env\nnode_modules/\ntarget/\nbuild/\n.venv/\n__pycache__/\nbin/\nobj/\n",
        ),
        file("README.md", readme),
        file(
            ".vscode/settings.json",
            "{\n  \"files.insertFinalNewline\": true,\n  \"editor.formatOnSave\": false\n}\n",
        ),
    ]
}
pub(super) fn build(ctx: &Context) -> Result<Template, String> {
    let mut template = match ctx.req.language.as_str() {
        "python" => python(ctx),
        "javascript" | "typescript" => javascript(ctx),
        "php" => php(ctx),
        "ruby" => ruby(ctx),
        "go" => go(ctx),
        _ => super::native::build(ctx),
    }?;
    if ctx.req.educational {
        let comment="I valori sono parametri, separati dal testo SQL. Le credenziali restano nelle variabili d'ambiente. list legge; insert/update/delete applicano modifiche al database.";
        template.source = if ctx.req.language == "php" {
            template
                .source
                .replacen("<?php\n", &format!("<?php\n// {comment}\n"), 1)
        } else if ["python", "ruby"].contains(&ctx.req.language.as_str()) {
            format!("# {comment}\n{}", template.source)
        } else {
            format!("// {comment}\n{}", template.source)
        };
    }
    Ok(template)
}
fn python(ctx: &Context) -> Result<Template, String> {
    let mongo = ctx.req.engine == "mongodb";
    let deps = match ctx.req.engine.as_str() {
        "sqlite" => "",
        "postgresql" => "psycopg[binary]>=3.2,<4\n",
        "mysql" | "mariadb" => "PyMySQL[rsa]>=1.1,<2\n",
        _ => "pymongo>=4.10,<5\n",
    };
    let connection=match ctx.req.engine.as_str(){
        "sqlite"=>"import sqlite3\ndef connect():\n    connection = sqlite3.connect(os.environ.get('DATABASE_URL', './database.sqlite'))\n    connection.row_factory = sqlite3.Row\n    return connection\n",
        "postgresql"=>"import psycopg\nfrom psycopg.rows import dict_row\ndef connect():\n    return psycopg.connect(os.environ['DATABASE_URL'], row_factory=dict_row)\n",
        "mysql"|"mariadb"=>"import pymysql\nfrom urllib.parse import urlsplit, unquote\ndef connect():\n    url = urlsplit(os.environ['DATABASE_URL'])\n    return pymysql.connect(host=url.hostname, port=url.port or 3306, user=unquote(url.username or ''), password=unquote(url.password or ''), database=unquote(url.path.lstrip('/')), charset='utf8mb4', cursorclass=pymysql.cursors.DictCursor)\n",
        _=>"from pymongo import MongoClient\nfrom bson import json_util\ndef connect():\n    return MongoClient(os.environ['DATABASE_URL'], serverSelectionTimeoutMS=10000)\n"};
    let body = if mongo {
        r#"
def execute(operation='list', payload=None):
    payload = payload or {}
    with connect() as client:
        collection = client[os.environ.get('DATABASE_NAME', 'database')][TABLE]
        payload = json_util.loads(json.dumps(payload))
        if operation == 'list':
            return json.loads(json_util.dumps(list(collection.find(json_util.loads(FILTER)).limit(100)), json_options=json_util.CANONICAL_JSON_OPTIONS))
        if operation == 'insert':
            result = collection.insert_one(payload)
            return json.loads(json_util.dumps({'insertedId': result.inserted_id}, json_options=json_util.CANONICAL_JSON_OPTIONS))
        if '_id' not in payload:
            raise ValueError('Il payload richiede _id in Extended JSON')
        if operation == 'update':
            values = {key: value for key, value in payload.items() if key != '_id'}
            if not values: raise ValueError('Nessun campo da aggiornare')
            result = collection.update_one({'_id': payload['_id']}, {'$set': values})
            return {'matched': result.matched_count, 'modified': result.modified_count}
        if operation == 'delete':
            return {'deleted': collection.delete_one({'_id': payload['_id']}).deleted_count}
        raise ValueError('Operazione sconosciuta')
"#
    } else {
        r#"
def adapt_value(name, value):
    if value is None: return None
    data_kind = KINDS[name]
    if data_kind == 'binary': return bytes(value)
    if data_kind == 'json': return json.dumps(value, ensure_ascii=False)
    if data_kind == 'decimal': return str(value)
    return value

def execute(operation='list', payload=None):
    payload = payload or {}
    if operation == 'list': sql, fields = QUERY, []
    elif operation == 'insert': sql, fields = INSERT, COLUMNS
    elif operation == 'update': sql, fields = UPDATE, NONKEYS + KEYS
    elif operation == 'delete': sql, fields = DELETE, KEYS
    else: raise ValueError('Operazione sconosciuta')
    if not sql: raise ValueError('Operazione non disponibile: manca una chiave primaria o un campo aggiornabile')
    missing = [name for name in fields if name not in payload]
    if missing: raise ValueError('Campi mancanti: ' + ', '.join(missing))
    connection = connect()
    try:
        cursor = connection.cursor()
        cursor.execute(sql, [adapt_value(name, payload[name]) for name in fields])
        if cursor.description:
            result = [dict(row) for row in cursor.fetchmany(100)]
        else: result = {'affected': cursor.rowcount}
        if operation != 'list': connection.commit()
        return result
    except Exception:
        connection.rollback()
        raise
    finally: connection.close()
"#
    };
    let kinds: serde_json::Map<String, Value> = ctx
        .req
        .columns
        .iter()
        .map(|c| Ok((c.name.clone(), json!(kind(&c.data_type)?))))
        .collect::<Result<_, String>>()?;
    let constants=ctx.placeholders(if ctx.req.engine=="sqlite"{"?"}else{"%s"}).render("TABLE = @@TABLE@@\nQUERY = @@QUERY@@\nINSERT = @@INSERT@@\nUPDATE = @@UPDATE@@\nDELETE = @@DELETE@@\nCOLUMNS = json.loads(@@COLS_TEXT@@)\nKEYS = json.loads(@@KEYS_TEXT@@)\nNONKEYS = json.loads(@@NONKEYS_TEXT@@)\nFILTER = @@FILTER@@\n");
    let constants = substitute(
        &constants,
        &[
            ("@@COLS_TEXT@@", literal(&json!(ctx.columns).to_string())),
            ("@@KEYS_TEXT@@", literal(&json!(ctx.keys).to_string())),
            ("@@NONKEYS_TEXT@@", literal(&json!(ctx.nonkeys).to_string())),
        ],
    );
    let source=format!("import os\nimport sys\nimport json\nimport datetime\nimport decimal\n\n{connection}\n{constants}KINDS = json.loads({})\n{body}\ndef encode(value):\n    if isinstance(value, (datetime.date, datetime.time, decimal.Decimal)): return str(value)\n    if isinstance(value, (bytes, bytearray, memoryview)): return list(value)\n    raise TypeError('Tipo non serializzabile: ' + type(value).__name__)\n\nif __name__ == '__main__':\n    operation = sys.argv[1] if len(sys.argv) > 1 else 'list'\n    payload = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {{}}\n    if not isinstance(payload, dict): raise ValueError('Payload deve essere oggetto JSON')\n    print(json.dumps(execute(operation, payload), ensure_ascii=False, default=encode))\n",literal(&Value::Object(kinds).to_string()));
    Ok(Template {
        source,
        path: "database.py".into(),
        files: vec![file("requirements.txt", deps)],
        command: "python database.py".into(),
        dependencies: if deps.is_empty() {
            "Python sqlite3 standard".into()
        } else {
            format!(
                "python -m pip install -r requirements.txt ({})",
                deps.trim()
            )
        },
    })
}

fn javascript(ctx: &Context) -> Result<Template, String> {
    let ts = ctx.req.language == "typescript";
    let mongo = ctx.req.engine == "mongodb";
    let driver = match ctx.req.engine.as_str() {
        "sqlite" => "better-sqlite3",
        "postgresql" => "pg",
        "mongodb" => "mongodb",
        _ => "mariadb",
    };
    let version = match driver {
        "better-sqlite3" => "^12.0.0",
        "pg" => "^8.13.0",
        "mongodb" => "^6.12.0",
        _ => "^3.4.0",
    };
    let import = match ctx.req.engine.as_str() {
        "sqlite" => "import Database from 'better-sqlite3';",
        "postgresql" => "import pg from 'pg';",
        "mongodb" => "import { MongoClient, BSON } from 'mongodb';",
        _ => "import mariadb from 'mariadb';",
    };
    let connection=match ctx.req.engine.as_str(){"sqlite"=>"const connection = new Database(process.env.DATABASE_URL || './database.sqlite'); connection.defaultSafeIntegers(true);", "postgresql"=>"const connection = new pg.Client({ connectionString: requiredUrl() }); await connection.connect();", "mongodb"=>"const connection = new MongoClient(requiredUrl(), { serverSelectionTimeoutMS: 10000 }); await connection.connect();",_=>"const connection = await mariadb.createConnection(requiredUrl().replace(/^mysql:/, 'mariadb:'));"};
    let body = if mongo {
        r#"
    const collection = connection.db(process.env.DATABASE_NAME || 'database').collection(TABLE);
    const document = BSON.EJSON.deserialize(payload);
    if (operation === 'list') return BSON.EJSON.serialize(await collection.find(BSON.EJSON.parse(FILTER)).limit(100).toArray(), { relaxed: false });
    if (operation === 'insert') return BSON.EJSON.serialize({ insertedId: (await collection.insertOne(document)).insertedId }, { relaxed: false });
    if (!Object.hasOwn(document, '_id')) throw new Error('Manca _id in Extended JSON');
    if (operation === 'update') { const { _id, ...values } = document; if (!Object.keys(values).length) throw new Error('Nessun campo da aggiornare'); const result = await collection.updateOne({ _id }, { $set: values }); return { matched: result.matchedCount, modified: result.modifiedCount }; }
    if (operation === 'delete') return { deleted: (await collection.deleteOne({ _id: document._id })).deletedCount };
    throw new Error('Operazione sconosciuta');
"#
    } else {
        r#"
    const plan = operation === 'list' ? [QUERY, []] : operation === 'insert' ? [INSERT, COLUMNS] : operation === 'update' ? [UPDATE, [...NONKEYS, ...KEYS]] : operation === 'delete' ? [DELETE, KEYS] : null;
    if (!plan || !plan[0]) throw new Error('Operazione non disponibile');
    const [sql, fields] = plan;
    const values = fields.map(name => { if (!Object.hasOwn(payload, name)) throw new Error('Campo mancante: ' + name); const value = payload[name]; if (value === null) return null; if (KINDS[name] === 'binary') return Buffer.from(value); if (KINDS[name] === 'json') return JSON.stringify(value); @@SQLITE_BOOL@@ return value; });
@@EXECUTION@@
"#
    };
    let execution=match ctx.req.engine.as_str(){
        "sqlite"=>"    const statement = connection.prepare(sql); if (statement.reader) return statement.all(...values).slice(0, 100); return { affected: statement.run(...values).changes };",
        "postgresql"=>"    const result = await connection.query(sql, values); return result.fields.length ? result.rows.slice(0, 100) : { affected: result.rowCount };",
        _=>"    const result = await connection.execute(sql, values); return Array.isArray(result) ? result.slice(0, 100) : { affected: result.affectedRows };"};
    let close = match ctx.req.engine.as_str() {
        "sqlite" => "connection.close();",
        "mongodb" => "await connection.close();",
        _ => "await connection.end();",
    };
    let mut pairs = ctx.pairs();
    pairs.push(("@@EXECUTION@@", execution.into()));
    pairs.push((
        "@@SQLITE_BOOL@@",
        if ctx.req.engine == "sqlite" {
            "if (KINDS[name] === 'boolean') return value ? 1 : 0;".into()
        } else {
            String::new()
        },
    ));
    let kinds: serde_json::Map<String, Value> = ctx
        .req
        .columns
        .iter()
        .map(|c| Ok((c.name.clone(), json!(kind(&c.data_type)?))))
        .collect::<Result<_, String>>()?;
    let constants=ctx.render("const TABLE = @@TABLE@@, ENGINE = @@ENGINE@@;\nconst QUERY = @@QUERY@@, INSERT = @@INSERT@@, UPDATE = @@UPDATE@@, DELETE = @@DELETE@@;\nconst COLUMNS = @@COLUMNS@@, KEYS = @@KEYS@@, NONKEYS = @@NONKEYS@@, FILTER = @@FILTER@@;\n");
    // TypeScript uses explicit any only at the JSON/driver boundary, with strict compilation.
    let suffix = if ts { ": any" } else { "" };
    let planbody = substitute(body, &pairs);
    let source=format!("{import}\nimport {{ pathToFileURL }} from 'node:url';\n{constants}const KINDS{} = {};\nfunction requiredUrl() {{ if (!process.env.DATABASE_URL) throw new Error('Impostare DATABASE_URL'); return process.env.DATABASE_URL; }}\nexport async function execute(operation = 'list', payload{} = {{}}) {{\n  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Payload deve essere oggetto JSON');\n  {connection}\n  try {{\n{planbody}\n  }} finally {{ {close} }}\n}}\nexport function encode(value{}) {{ return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? item.toString() : item); }}\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {{\n  execute(process.argv[2] || 'list', JSON.parse(process.argv[3] || '{{}}')).then(value => console.log(encode(value))).catch(error => {{ console.error(error.message); process.exitCode = 1; }});\n}}\n",if ts{": Record<string, string>"}else{""},Value::Object(kinds),suffix,suffix);
    let source = if ts {
        source
            .replace(
                "const plan = operation",
                "const plan: [string, string[]] | null = operation",
            )
            .replace("fields.map(name =>", "fields.map((name: string) =>")
    } else {
        source
    };
    let path = if ts { "database.ts" } else { "database.js" };
    let mut dependencies = json!({driver:version});
    let mut dev = json!({});
    if ts {
        dev = json!({"typescript":"^5.7.0","@types/node":"^22.10.0"});
        if driver == "better-sqlite3" {
            dev["@types/better-sqlite3"] = json!("^7.6.12");
        }
        if driver == "pg" {
            dev["@types/pg"] = json!("^8.11.10");
        }
    }
    // json! identifier object keys are evaluated as expressions by serde_json.
    if dependencies.get(driver).is_none() {
        dependencies = json!({});
        dependencies[driver] = json!(version);
    }
    let manifest = json!({"name":"database-example","private":true,"version":"1.0.0","type":"module","engines":{"node":">=22"},"scripts":{"start":if ts{"node dist/database.js"}else{"node database.js"},"build":if ts{"tsc"}else{"node --check database.js"}},"dependencies":dependencies,"devDependencies":dev});
    let mut files = vec![file(
        "package.json",
        serde_json::to_string_pretty(&manifest).unwrap(),
    )];
    if ts {
        files.push(file("tsconfig.json",json!({"compilerOptions":{"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","strict":true,"esModuleInterop":true,"skipLibCheck":true,"types":["node"],"outDir":"dist"},"include":["*.ts"]}).to_string()));
    }
    Ok(Template {
        source,
        path: path.into(),
        files,
        command: if ts {
            "npm install; npm run build; npm start"
        } else {
            "npm install; npm start"
        }
        .into(),
        dependencies: driver.into(),
    })
}

fn php(ctx: &Context) -> Result<Template, String> {
    let mongo = ctx.req.engine == "mongodb";
    let connection=match ctx.req.engine.as_str(){
        "sqlite"=>"$pdo = new PDO('sqlite:' . (getenv('DATABASE_URL') ?: './database.sqlite'));",
        "postgresql"=>"$url = parse_url(getenv('DATABASE_URL') ?: throw new RuntimeException('Impostare DATABASE_URL')); $pdo = new PDO('pgsql:host=' . $url['host'] . ';port=' . ($url['port'] ?? 5432) . ';dbname=' . rawurldecode(ltrim($url['path'], '/')), rawurldecode($url['user'] ?? ''), rawurldecode($url['pass'] ?? ''));",
        _=>"$url = parse_url(getenv('DATABASE_URL') ?: throw new RuntimeException('Impostare DATABASE_URL')); $pdo = new PDO('mysql:host=' . $url['host'] . ';port=' . ($url['port'] ?? 3306) . ';dbname=' . rawurldecode(ltrim($url['path'], '/')) . ';charset=utf8mb4', rawurldecode($url['user'] ?? ''), rawurldecode($url['pass'] ?? ''));"};
    let constants=ctx.placeholders("?").render("$table = json_decode(@@PHP_TABLE@@, true, 512, JSON_THROW_ON_ERROR);\n$query = json_decode(@@PHP_QUERY@@, true, 512, JSON_THROW_ON_ERROR);\n$insert = json_decode(@@PHP_INSERT@@, true, 512, JSON_THROW_ON_ERROR);\n$update = json_decode(@@PHP_UPDATE@@, true, 512, JSON_THROW_ON_ERROR);\n$delete = json_decode(@@PHP_DELETE@@, true, 512, JSON_THROW_ON_ERROR);\n$columns = @@COLUMNS@@; $keys = @@KEYS@@; $nonkeys = @@NONKEYS@@;\n");
    let ctxq = ctx.placeholders("?");
    let phpquote = |s: &str| format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"));
    let constants = constants
        .replace(
            &format!("$columns = {}", json!(ctx.columns)),
            &format!(
                "$columns = json_decode({}, true)",
                phpquote(&json!(ctx.columns).to_string())
            ),
        )
        .replace(
            &format!("$keys = {}", json!(ctx.keys)),
            &format!(
                "$keys = json_decode({}, true)",
                phpquote(&json!(ctx.keys).to_string())
            ),
        )
        .replace(
            &format!("$nonkeys = {}", json!(ctx.nonkeys)),
            &format!(
                "$nonkeys = json_decode({}, true)",
                phpquote(&json!(ctx.nonkeys).to_string())
            ),
        );
    let constants = substitute(
        &constants,
        &[
            ("@@PHP_TABLE@@", phpquote(&literal(&ctx.req.table))),
            ("@@PHP_QUERY@@", phpquote(&literal(&ctx.select))),
            ("@@PHP_INSERT@@", phpquote(&literal(&ctxq.insert))),
            ("@@PHP_UPDATE@@", phpquote(&literal(&ctxq.update))),
            ("@@PHP_DELETE@@", phpquote(&literal(&ctxq.delete))),
        ],
    );
    let body = if mongo {
        format!(
            r#"
require __DIR__ . '/vendor/autoload.php';
$client = new MongoDB\Client(getenv('DATABASE_URL') ?: throw new RuntimeException('Impostare DATABASE_URL'));
$collection = $client->selectCollection(getenv('DATABASE_NAME') ?: 'database', $table);
$payload = MongoDB\BSON\Document::fromJSON($argv[2] ?? '{{}}')->toPHP();
if ($operation === 'list') {{ $result = iterator_to_array($collection->find(MongoDB\BSON\Document::fromJSON({})->toPHP(), ['limit' => 100])); }}
elseif ($operation === 'insert') {{ $result = ['insertedId' => $collection->insertOne($payload)->getInsertedId()]; }}
elseif ($operation === 'update') {{ if (!isset($payload->_id)) throw new RuntimeException('Manca _id'); $key = $payload->_id; unset($payload->_id); $r = $collection->updateOne(['_id' => $key], ['$set' => $payload]); $result = ['matched' => $r->getMatchedCount(), 'modified' => $r->getModifiedCount()]; }}
elseif ($operation === 'delete') {{ if (!isset($payload->_id)) throw new RuntimeException('Manca _id'); $result = ['deleted' => $collection->deleteOne(['_id' => $payload->_id])->getDeletedCount()]; }}
else throw new RuntimeException('Operazione sconosciuta');
$canonical = MongoDB\BSON\Document::fromPHP(['result' => $result])->toCanonicalExtendedJSON();
$normalized = json_decode($canonical, true, 512, JSON_THROW_ON_ERROR);
echo json_encode($normalized['result'], JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), PHP_EOL;
"#,
            phpquote(&ctx.filter.to_string())
        )
    } else {
        format!(
            r#"
{connection}
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
if ($pdo->getAttribute(PDO::ATTR_DRIVER_NAME) === 'mysql') $pdo->setAttribute(PDO::ATTR_EMULATE_PREPARES, false);
$plan = match ($operation) {{ 'list' => [$query, []], 'insert' => [$insert, $columns], 'update' => [$update, array_merge($nonkeys, $keys)], 'delete' => [$delete, $keys], default => throw new RuntimeException('Operazione sconosciuta') }};
if (!$plan[0]) throw new RuntimeException('Operazione non disponibile');
$statement = $pdo->prepare($plan[0]);
foreach ($plan[1] as $index => $name) {{
  if (!array_key_exists($name, $payload)) throw new RuntimeException('Campo mancante: ' . $name);
  $value = $payload[$name];
  if (is_array($value) || is_object($value)) $value = json_encode($value, JSON_THROW_ON_ERROR);
  $type = is_null($value) ? PDO::PARAM_NULL : (is_bool($value) ? PDO::PARAM_BOOL : (is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR));
  $statement->bindValue($index + 1, $value, $type);
}}
$statement->execute();
$result = $statement->columnCount() ? $statement->fetchAll() : ['affected' => $statement->rowCount()];
echo json_encode($result, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE), PHP_EOL;
"#
        )
    };
    let source=format!("<?php\ndeclare(strict_types=1);\n{constants}\n$operation = $argv[1] ?? 'list';\n$payload = json_decode($argv[2] ?? '{{}}', true, 512, JSON_THROW_ON_ERROR);\nif (!is_array($payload)) throw new RuntimeException('Payload deve essere oggetto JSON');\n{body}");
    let manifest = if mongo {
        json!({"require":{"php":">=8.2","ext-mongodb":"^2.0","mongodb/mongodb":"^2.0"}})
    } else {
        json!({"require":{"php":">=8.2","ext-pdo":"*"}})
    };
    Ok(Template {
        source,
        path: "database.php".into(),
        files: vec![file("composer.json", manifest.to_string())],
        command: if mongo {
            "composer install; php database.php"
        } else {
            "php database.php"
        }
        .into(),
        dependencies: if mongo {
            "ext-mongodb + mongodb/mongodb".into()
        } else {
            format!(
                "PDO + pdo_{}",
                if ctx.req.engine == "postgresql" {
                    "pgsql"
                } else if ctx.req.engine == "sqlite" {
                    "sqlite"
                } else {
                    "mysql"
                }
            )
        },
    })
}

fn ruby(ctx: &Context) -> Result<Template, String> {
    let driver = match ctx.req.engine.as_str() {
        "sqlite" => "sqlite3",
        "postgresql" => "pg",
        "mongodb" => "mongo",
        _ => "mysql2",
    };
    let body = if ctx.req.engine == "mongodb" {
        r#"
client = Mongo::Client.new(ENV.fetch('DATABASE_URL'), database: ENV.fetch('DATABASE_NAME', 'database'))
begin
  collection = client[TABLE]
  document = BSON::ExtJSON.parse(JSON.generate(payload))
  result = case operation
  when 'list' then collection.find(BSON::ExtJSON.parse(FILTER)).limit(100).to_a
  when 'insert' then {insertedId: collection.insert_one(document).inserted_id}
  when 'update'
    raise 'Manca _id' unless document.key?('_id')
    key = document.delete('_id')
    raise 'Nessun campo da aggiornare' if document.empty?
    r = collection.update_one({'_id' => key}, {'$set' => document})
    {matched: r.matched_count, modified: r.modified_count}
  when 'delete'
    raise 'Manca _id' unless document.key?('_id')
    {deleted: collection.delete_one({'_id' => document['_id']}).deleted_count}
  else raise 'Operazione sconosciuta'
  end
  puts JSON.generate(result.as_extended_json)
ensure
  client.close
end
"#.into()
    } else {
        let (connect,execution,close)=match ctx.req.engine.as_str(){
            "sqlite"=>("connection = SQLite3::Database.new(ENV.fetch('DATABASE_URL', './database.sqlite')); connection.results_as_hash = true", "statement = connection.prepare(sql); rows = statement.execute(*values); result = rows.columns.empty? ? {affected: connection.changes} : rows.take(100).map { |row| row.reject { |key, _| key.is_a?(Integer) } }; rows.close; statement.close unless statement.closed?", "connection.close"),
            "postgresql"=>("connection = PG.connect(ENV.fetch('DATABASE_URL')); connection.type_map_for_results = PG::BasicTypeMapForResults.new(connection)","r = connection.exec_params(sql, values); result = r.nfields.zero? ? {affected: r.cmd_tuples} : r.take(100); r.clear", "connection.close"),
            _=>("url = URI.parse(ENV.fetch('DATABASE_URL')); connection = Mysql2::Client.new(host: url.host, port: url.port || 3306, username: URI.decode_www_form_component(url.user || ''), password: URI.decode_www_form_component(url.password || ''), database: URI.decode_www_form_component(url.path.sub(%r{^/}, '')), encoding: 'utf8mb4')", "statement = connection.prepare(sql); r = statement.execute(*values); result = r ? r.take(100) : {affected: statement.affected_rows}; statement.close", "connection.close")};
        format!(
            r#"
{connect}
begin
  sql, fields = case operation
  when 'list' then [QUERY, []]
  when 'insert' then [INSERT, COLUMNS]
  when 'update' then [UPDATE, NONKEYS + KEYS]
  when 'delete' then [DELETE, KEYS]
  else raise 'Operazione sconosciuta'
  end
  raise 'Operazione non disponibile' if sql.empty?
  values = fields.map do |name|
    raise 'Campo mancante: ' + name unless payload.key?(name)
    value = payload[name]
    value.is_a?(Hash) || value.is_a?(Array) ? JSON.generate(value) : value
  end
  {execution}
  puts JSON.generate(result)
ensure
  {close}
end
"#
        )
    };
    let constants=ctx.placeholders(if ctx.req.engine=="postgresql"{"numbered"}else{"?"}).render("TABLE = @@TABLE@@\nQUERY = @@QUERY@@\nINSERT = @@INSERT@@\nUPDATE = @@UPDATE@@\nDELETE = @@DELETE@@\nCOLUMNS = @@COLUMNS@@\nKEYS = @@KEYS@@\nNONKEYS = @@NONKEYS@@\nFILTER = @@FILTER@@\n");
    // Ruby double-quoted strings interpolate #{...}; escape it in generated literals.
    let constants = constants.replace("#{", "\\#{");
    let source=format!("require 'json'\nrequire 'uri'\nrequire '{driver}'\n{constants}\noperation = ARGV[0] || 'list'\npayload = JSON.parse(ARGV[1] || '{{}}')\nraise 'Payload deve essere oggetto JSON' unless payload.is_a?(Hash)\n{body}");
    let version = match driver {
        "sqlite3" => "2.10.2",
        "pg" => "1.7.0",
        "mysql2" => "0.5.7",
        _ => "2.26.1",
    };
    Ok(Template {
        source,
        path: "database.rb".into(),
        files: vec![file(
            "Gemfile",
            format!(
                "source 'https://rubygems.org'\ngem '{driver}', '{version}'\n{}",
                if driver == "mongo" {
                    "gem 'logger'\n"
                } else {
                    ""
                }
            ),
        )],
        command: "bundle install; bundle exec ruby database.rb".into(),
        dependencies: driver.into(),
    })
}

fn go(ctx: &Context) -> Result<Template, String> {
    super::native::go(ctx)
}
