use super::*;

/// Functions accept an application-owned connection. They never open a production
/// connection, execute during generation, or commit the caller's transaction.
pub(super) fn generate(request: &WorkbenchRequest) -> Result<GeneratedProject, String> {
    if request.engine == "mongodb" {
        return generate_mongo(request);
    }
    if request.query.trim().is_empty() {
        return Err("Definisci lo schema nel designer o seleziona una tabella con una definizione SQL disponibile.".into());
    }
    let statements = crate::remote::split_sql(&request.query)?;
    if statements.is_empty()
        || statements.iter().any(|sql| {
            !["CREATE", "ALTER", "SET"].contains(&crate::remote::first_keyword(sql).as_str())
        })
    {
        return Err("La funzione schema accetta solo CREATE, ALTER e SET dello schema revisionato, senza operazioni sui dati o DROP.".into());
    }
    let literals = statements
        .iter()
        .map(|sql| literal(sql))
        .collect::<Vec<_>>()
        .join(",\n  ");
    let count = statements.len();
    let (path,source) = match request.language.as_str() {
        "python" => ("schema.py",format!("STATEMENTS = [\n  {literals}\n]\n\ndef apply_schema(connection):\n    \"\"\"Apply reviewed DDL using the caller's DB-API connection; caller owns commit/rollback.\"\"\"\n    cursor = connection.cursor()\n    try:\n        for statement in STATEMENTS:\n            cursor.execute(statement)\n        return len(STATEMENTS)\n    finally:\n        cursor.close()\n")),
        "javascript" | "typescript" => {
            let typed = request.language == "typescript";
            let connection_type = if typed { if request.engine=="sqlite" { ": { exec(sql: string): unknown }" } else { ": { query(sql: string): Promise<unknown> }" } } else { "" };
            let execute = if request.engine=="sqlite" { "connection.exec(statement);" } else { "await connection.query(statement);" };
            (if typed {"schema.ts"} else {"schema.mjs"},format!("const STATEMENTS = [\n  {literals}\n];\n\nexport async function applySchema(connection{connection_type}) {{\n  for (const statement of STATEMENTS) {{ {execute} }}\n  return STATEMENTS.length;\n}}\n"))
        }
        "rust" => {
            let pool=match request.engine.as_str(){"sqlite"=>"SqlitePool","postgresql"=>"PgPool",_=>"MySqlPool"};
            ("schema.rs",format!("const STATEMENTS: &[&str] = &[\n  {}\n];\n\npub async fn apply_schema(pool: &sqlx::{pool}) -> Result<usize, sqlx::Error> {{\n    let mut connection = pool.acquire().await?;\n    for statement in STATEMENTS {{ sqlx::query(*statement).execute(&mut *connection).await?; }}\n    Ok(STATEMENTS.len())\n}}\n",literals.replace("\\u2028","\\u{2028}").replace("\\u2029","\\u{2029}")))
        }
        "php" => ("schema.php",format!("<?php\nfunction applySchema(\\PDO $connection): int {{\n    $statements = [\n        {}\n    ];\n    foreach ($statements as $statement) {{\n        if ($connection->exec($statement) === false) {{ throw new \\RuntimeException(implode(' | ', $connection->errorInfo())); }}\n    }}\n    return count($statements);\n}}\n",statements.iter().map(|sql|single_literal(sql)).collect::<Vec<_>>().join(",\n        "))),
        "go" => ("schema.go",format!("package dbschema\n\nimport (\"context\"; \"database/sql\")\n\nfunc ApplySchema(ctx context.Context, pool *sql.DB) error {{\n    connection, err := pool.Conn(ctx)\n    if err != nil {{ return err }}\n    defer connection.Close()\n    statements := []string{{\n        {},\n    }}\n    for _, statement := range statements {{ if _, err := connection.ExecContext(ctx, statement); err != nil {{ return err }} }}\n    return nil\n}}\n",statements.iter().map(|sql|literal(sql)).collect::<Vec<_>>().join(",\n        "))),
        "java" => ("DatabaseSchema.java",format!("import java.sql.Connection;\nimport java.sql.SQLException;\nimport java.sql.Statement;\n\npublic final class DatabaseSchema {{\n    private DatabaseSchema() {{}}\n    public static void applySchema(Connection connection) throws SQLException {{\n        String[] statements = {{\n            {literals}\n        }};\n        try (Statement command = connection.createStatement()) {{\n            for (String sql : statements) command.executeUpdate(sql);\n        }}\n    }}\n}}\n")),
        "kotlin" => ("DatabaseSchema.kt",format!("import java.sql.Connection\n\nfun applySchema(connection: Connection): Int {{\n    val statements = listOf(\n        {}\n    )\n    connection.createStatement().use {{ command -> statements.forEach {{ command.executeUpdate(it) }} }}\n    return statements.size\n}}\n",literals.replace('$',"\\$"))),
        "csharp" => ("DatabaseSchema.cs",format!("using System.Data.Common;\nusing System.Threading;\nusing System.Threading.Tasks;\n\npublic static class DatabaseSchema {{\n    public static async Task<int> ApplySchemaAsync(DbConnection connection, CancellationToken cancellationToken = default) {{\n        string[] statements = {{\n            {literals}\n        }};\n        foreach (string sql in statements) {{\n            await using var command = connection.CreateCommand();\n            command.CommandText = sql;\n            await command.ExecuteNonQueryAsync(cancellationToken);\n        }}\n        return statements.Length;\n    }}\n}}\n")),
        "ruby" => {
            let execute=if request.engine=="sqlite"{"execute"}else if request.engine=="postgresql"{"exec"}else{"query"};
            ("schema.rb",format!("def apply_schema(connection)\n  statements = [\n    {}\n  ]\n  statements.each {{ |sql| connection.{execute}(sql) }}\n  statements.length\nend\n",statements.iter().map(|sql|single_literal(sql)).collect::<Vec<_>>().join(",\n    ")))
        }
        "c" | "cpp" => {
            let (header,ty,execute) = match request.engine.as_str(){
                "sqlite" => ("sqlite3.h","sqlite3 *", "if (sqlite3_exec(connection, statements[i], NULL, NULL, NULL) != SQLITE_OK) return -1;"),
                "postgresql" => ("libpq-fe.h","PGconn *", "PGresult *result = PQexec(connection, statements[i]); if (!result) return -1; int ok = PQresultStatus(result) == PGRES_COMMAND_OK; PQclear(result); if (!ok) return -1;"),
                _ => ("mysql.h","MYSQL *", "if (mysql_query(connection, statements[i]) != 0) return -1;"),
            };
            (if request.language=="c"{"schema.c"}else{"schema.cpp"},format!("#include <stddef.h>\n#include <{header}>\n\n/* Returns the number of applied statements, or -1 on error. Caller owns the connection. */\nint apply_schema({ty}connection) {{\n    if (!connection) return -1;\n    static const char *statements[] = {{\n        {literals}\n    }};\n    for (size_t i = 0; i < sizeof(statements) / sizeof(statements[0]); ++i) {{\n        {execute}\n    }}\n    return {count};\n}}\n"))
        }
        _ => return Err("Linguaggio schema non supportato.".into()),
    };
    let readme = format!("# Funzione schema / {} / {}\n\nIntegra `{path}` nel progetto e passa una connessione già aperta del driver appropriato. La generazione non esegue lo schema.\n\nIl file contiene {count} istruzioni dello schema revisionato. Usa un database di sviluppo e applicale una sola volta: nessun IF NOT EXISTS nasconde differenze di struttura. La funzione interrompe al primo errore.\n\nDipendenze: Python DB-API (sqlite3/psycopg/PyMySQL), JavaScript/TypeScript better-sqlite3/pg/mariadb, Rust sqlx col feature del motore e runtime Tokio, PHP PDO, Go database/sql col driver del motore, Java/Kotlin JDBC, C# provider DbConnection, Ruby sqlite3/pg/mysql2, C/C++ sqlite3/libpq/MariaDB Connector-C.\n\nCommit e rollback restano responsabilità dell’applicazione. MySQL/MariaDB possono confermare DDL implicitamente; Rust/Go qui usano un pool e non promettono una transazione tra istruzioni. Per modificare schemi esistenti usa il piano di migrazione del designer e un backup verificato. Non usare questa funzione a ogni avvio o richiesta HTTP.\n",request.language,request.engine);
    Ok(GeneratedProject { files:vec![file(path,source),file("schema.sql",request.query.clone()),file("README.md",readme)], command:String::new(), notes:vec!["Funzione di creazione schema da integrare con una connessione della propria applicazione. Nessuna connessione o credenziale viene incorporata.".into()] })
}

fn generate_mongo(request: &WorkbenchRequest) -> Result<GeneratedProject, String> {
    let commands: Vec<Value> = serde_json::from_str(&request.query)
        .map_err(|error| format!("Schema MongoDB JSON: {error}"))?;
    let ordered: Vec<_> = commands
        .iter()
        .map(|value| {
            let command = value
                .as_object()
                .ok_or("Ogni comando dello schema MongoDB deve essere un oggetto.")?;
            let mut verbs = ["create", "createIndexes"]
                .into_iter()
                .filter(|key| command.contains_key(*key));
            let verb = verbs
                .next()
                .ok_or("Lo schema MongoDB ammette create e createIndexes.")?;
            if verbs.next().is_some()
                || !command
                    .get(verb)
                    .and_then(Value::as_str)
                    .is_some_and(|name| !name.is_empty())
            {
                return Err("Il comando MongoDB deve avere un solo nome di collezione valido.");
            }
            Ok(verb)
        })
        .collect::<Result<_, _>>()?;
    if ordered.is_empty() || ordered.len() > 1000 {
        return Err("Lo schema MongoDB deve contenere da 1 a 1000 comandi.".into());
    }
    let manifest = &request.query;
    let (path, source) = match request.language.as_str() {
        "python" => ("schema.py", format!(r#"from bson import json_util

SCHEMA = {schema}
VERBS = {verbs}

def apply_schema(database):
    commands = json_util.loads(SCHEMA)
    for verb, command in zip(VERBS, commands):
        target = command.pop(verb)
        database.command({{verb: target, **command}})
    return len(commands)
"#, schema = literal(manifest), verbs = json!(ordered))),
        "javascript" | "typescript" => {
            let typed = request.language == "typescript";
            (if typed { "schema.ts" } else { "schema.mjs" }, format!(r#"import {{ BSON{type_import} }} from 'mongodb';

const SCHEMA = {schema};
const VERBS = {verbs};

export async function applySchema(database{db_type}) {{
  const commands = BSON.EJSON.parse(SCHEMA);
  for (const [index, command] of commands.entries()) {{
    const verb = VERBS[index];
    const {{ [verb]: target, ...options }} = command;
    await database.command({{ [verb]: target, ...options }});
  }}
  return commands.length;
}}
"#, type_import = if typed { ", type Db" } else { "" }, db_type = if typed { ": Db" } else { "" }, schema = literal(manifest), verbs = json!(ordered)))
        }
        "rust" => ("schema.rs", format!(r#"use mongodb::{{bson::Document, Database}};

const VERBS: &[&str] = &{verbs};

pub async fn apply_schema(database: &Database) -> Result<usize, Box<dyn std::error::Error + Send + Sync>> {{
    let commands: Vec<Document> = serde_json::from_str(include_str!("schema.json"))?;
    if commands.len() != VERBS.len() {{ return Err("Manifesto schema incompleto".into()); }}
    for (verb, mut options) in VERBS.iter().zip(commands) {{
        let target = options.remove(*verb).ok_or("Comando di struttura mancante")?;
        let mut document = Document::new();
        document.insert(*verb, target);
        document.extend(options);
        database.run_command(document).await?;
    }}
    Ok(VERBS.len())
}}
"#, verbs = json!(ordered))),
        _ => return Err("Le funzioni schema MongoDB sono disponibili in Rust, Python, JavaScript e TypeScript. Esporta il manifesto JSON per altri linguaggi.".into()),
    };
    Ok(GeneratedProject {
        files: vec![file(path, source), file("schema.json", manifest), file("README.md", "# Creazione schema MongoDB\n\nIntegra la funzione nel tuo progetto e passa un database del driver già configurato. Dipendenze: pymongo per Python, mongodb per Node.js, mongodb e serde_json per Rust. Il manifesto contiene solo i comandi di creazione per collezioni e indici. Prova in un database di sviluppo: la funzione si ferma al primo errore e i comandi precedenti possono essere già applicati.\n")],
        command: String::new(),
        notes: vec!["Funzione MongoDB per applicare il manifesto revisionato su una connessione della tua applicazione.".into()],
    })
}
