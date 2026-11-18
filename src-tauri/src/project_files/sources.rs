use super::{file, Parameters};
use crate::{
    codegen::GeneratedFile,
    codegen_workbench::{compile_query, literal, single_literal, Placeholder, WorkbenchParameter},
};

pub(super) fn generate(
    language: &str,
    engine: &str,
    query: &str,
    parameters: &Parameters,
    write: bool,
) -> Result<Option<GeneratedFile>, String> {
    if engine == "mongodb" {
        return Ok(Some(mongo(language, query)?));
    }
    let mut arguments = parameters
        .iter()
        .map(|(name, value)| WorkbenchParameter {
            name: if name.bytes().all(|b| b.is_ascii_digit()) {
                format!("p{name}")
            } else {
                name.clone()
            },
            data_type: "text".into(),
            nullable: true,
            value: Some(value.clone()),
        })
        .collect::<Vec<_>>();
    arguments.sort_by_key(|p| {
        p.name
            .strip_prefix('p')
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(usize::MAX)
    });
    let style = match (language, engine) {
        ("python", "postgresql" | "mysql" | "mariadb") => Placeholder::Percent,
        ("csharp", _) => Placeholder::Named,
        ("javascript" | "typescript" | "rust" | "ruby" | "go" | "c" | "cpp", "postgresql") => {
            Placeholder::Numbered
        }
        _ => Placeholder::Question,
    };
    let plan = compile_query(query, &arguments, style, engine)?;
    let count = plan.bindings.len();
    let names = plan
        .bindings
        .iter()
        .map(|binding| binding.name.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let sql = plan.sql;
    let text = literal(&sql);
    let (name, source) = match language {
        "python" => ("operazione.py", format!(r#"def esegui_operazione(connection, values=()):
    """Bind nell'ordine: {names}. La transazione appartiene a chi chiama."""
    cursor = connection.cursor()
    try:
        cursor.execute({text}, values)
        return cursor.rowcount if cursor.description is None else cursor.fetchall()
    finally:
        cursor.close()
"#)),
        "javascript" | "typescript" => {
            let typed = language == "typescript";
            let signature = if typed { "(connection: Connection, values: unknown[] = [])" } else { "(connection, values = [])" };
            let (alias, invoke) = match engine {
                "sqlite" => ("type Connection = { prepare(sql: string): { all(...values: unknown[]): unknown; run(...values: unknown[]): unknown } };\n", format!("return connection.prepare({text}).{}(...values);", if write {"run"} else {"all"})),
                "postgresql" => ("type Connection = { query(sql: string, values: unknown[]): Promise<unknown> };\n", format!("return connection.query({text}, values);")),
                _ => ("type Connection = { execute(sql: string, values: unknown[]): Promise<unknown> };\n", format!("return connection.execute({text}, values);")),
            };
            (if typed {"operazione.ts"} else {"operazione.mjs"}, format!("{}// Bind nell'ordine: {names}\nexport async function eseguiOperazione{signature} {{\n  {invoke}\n}}\n", if typed {alias} else {""}))
        }
        "rust" => {
            let (kind, prefix, suffix) = match engine {
                "sqlite" => ("Sqlite", "sqlite", "Sqlite"),
                "postgresql" => ("Postgres", "postgres", "Pg"),
                _ => ("MySql", "mysql", "MySql"),
            };
            let (method, result) = if write {("execute", format!("sqlx::{prefix}::{suffix}QueryResult"))} else {("fetch_all", format!("Vec<sqlx::{prefix}::{suffix}Row>"))};
            let text = text.replace("\\u2028", "\\u{2028}").replace("\\u2029", "\\u{2029}");
            ("operazione.rs", format!("// Bind nell'ordine: {names}\npub async fn esegui_operazione(connection: &sqlx::Pool<sqlx::{kind}>, values: sqlx::{prefix}::{suffix}Arguments) -> Result<{result}, sqlx::Error> {{\n    sqlx::query_with::<sqlx::{kind}, _>({text}, values).{method}(connection).await\n}}\n"))
        }
        "go" => {
            let (method, result) = if write { ("ExecContext", "sql.Result") } else { ("QueryContext", "*sql.Rows") };
            ("operazione.go", format!("package operazione\n\nimport (\"context\"; \"database/sql\")\n\n// Bind nell'ordine: {names}. Per le letture chiudi le righe restituite.\nfunc Esegui(ctx context.Context, connection *sql.DB, values ...any) ({result}, error) {{\n  return connection.{method}(ctx, {text}, values...)\n}}\n"))
        }
        "java" => ("Operazione.java", format!("import java.sql.*;\nimport java.util.*;\n\npublic final class Operazione {{\n  public static Object esegui(Connection connection, Object... values) throws SQLException {{\n    try (var command = connection.prepareStatement({text})) {{\n      for (int i = 0; i < values.length; i++) command.setObject(i + 1, values[i]);\n      if (!command.execute()) return command.getUpdateCount();\n      try (var result = command.getResultSet()) {{\n        var rows = new ArrayList<Map<String, Object>>();\n        while (result.next()) {{\n          var row = new LinkedHashMap<String, Object>();\n          for (int i = 1; i <= result.getMetaData().getColumnCount(); i++) row.put(result.getMetaData().getColumnLabel(i), result.getObject(i));\n          rows.add(row);\n        }}\n        return rows;\n      }}\n    }}\n  }}\n}}\n")),
        "kotlin" => {
            let text = text.replace('$', "\\$");
            ("Operazione.kt", format!("import java.sql.Connection\n\nfun eseguiOperazione(connection: Connection, vararg values: Any?): Any =\n    connection.prepareStatement({text}).use {{ command ->\n        values.forEachIndexed {{ index, value -> command.setObject(index + 1, value) }}\n        if (!command.execute()) command.updateCount else command.resultSet.use {{ result ->\n            buildList {{\n                while (result.next()) add((1..result.metaData.columnCount).associate {{ index ->\n                    result.metaData.getColumnLabel(index) to result.getObject(index)\n                }})\n            }}\n        }}\n    }}\n"))
        }
        "csharp" => {
            let result = if write { "return await command.ExecuteNonQueryAsync();" } else { "using var reader = await command.ExecuteReaderAsync();\n        var rows = new List<Dictionary<string, object?>>();\n        while (await reader.ReadAsync()) {\n            var row = new Dictionary<string, object?>();\n            for (var i = 0; i < reader.FieldCount; i++) row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);\n            rows.Add(row);\n        }\n        return rows;" };
            ("Operazione.cs", format!("using System;\nusing System.Collections.Generic;\nusing System.Data.Common;\nusing System.Threading.Tasks;\n\npublic static class Operazione {{\n    public static async Task<object> EseguiAsync(DbConnection connection, params object?[] values) {{\n        using var command = connection.CreateCommand();\n        command.CommandText = {text};\n        for (int i = 0; i < values.Length; i++) {{\n            var parameter = command.CreateParameter();\n            parameter.ParameterName = $\"p{{i + 1}}\";\n            parameter.Value = values[i] ?? DBNull.Value;\n            command.Parameters.Add(parameter);\n        }}\n        {result}\n    }}\n}}\n"))
        }
        "php" => ("operazione.php", format!("<?php\n\nfunction esegui_operazione(PDO $connection, array $values = []): array|int {{\n    $command = $connection->prepare({});\n    if (!$command || !$command->execute($values)) throw new RuntimeException('Operazione non completata.');\n    return $command->columnCount() ? $command->fetchAll(PDO::FETCH_ASSOC) : $command->rowCount();\n}}\n", single_literal(&sql))),
        "ruby" => {
            let literal = single_literal(&sql);
            let body = match engine {
                "sqlite" => if write {format!("connection.execute({literal}, values)\n  connection.changes")} else {format!("connection.execute({literal}, values)")},
                "postgresql" => format!("connection.exec_params({literal}, values) {{ |result| {} }}", if write {"result.cmd_tuples"} else {"result.to_a"}),
                _ => format!("statement = connection.prepare({literal})\n  begin\n    result = statement.execute(*values)\n    {}\n  ensure\n    statement.close\n  end", if write {"statement.affected_rows"} else {"result.to_a"}),
            };
            ("operazione.rb", format!("# Bind nell'ordine: {names}\ndef esegui_operazione(connection, values=[])\n  {body}\nend\n"))
        }
        "c" | "cpp" => {
            let source = match engine {
                "sqlite" => format!("#include <sqlite3.h>\n\n/* on_row riceve ogni riga. I valori rimangono validi durante la callback. */\nint esegui_operazione(sqlite3 *connection, sqlite3_value *const values[], void (*on_row)(sqlite3_stmt *, void *), void *context) {{\n    sqlite3_stmt *statement = 0;\n    int result = sqlite3_prepare_v2(connection, {text}, -1, &statement, 0);\n    if (result != SQLITE_OK) return result;\n    for (int i = 0; i < {count}; i++) {{\n        result = sqlite3_bind_value(statement, i + 1, values[i]);\n        if (result != SQLITE_OK) {{ sqlite3_finalize(statement); return result; }}\n    }}\n    while ((result = sqlite3_step(statement)) == SQLITE_ROW) {{\n        if (on_row) on_row(statement, context);\n    }}\n    int closed = sqlite3_finalize(statement);\n    return result == SQLITE_DONE ? closed : result;\n}}\n"),
                "postgresql" => format!("#include <libpq-fe.h>\n\n/* Il chiamante controlla e libera il risultato con PQclear. */\nPGresult *esegui_operazione(PGconn *connection, const char *const values[]) {{\n    return PQexecParams(connection, {text}, {count}, 0, values, 0, 0, 0);\n}}\n"),
                _ => format!("#include <mysql.h>\n#include <string.h>\n\n/* Il chiamante legge eventuali righe e chiude lo statement. */\nMYSQL_STMT *esegui_operazione(MYSQL *connection, MYSQL_BIND values[]) {{\n    const char *sql = {text};\n    MYSQL_STMT *statement = mysql_stmt_init(connection);\n    if (!statement) return 0;\n    if (mysql_stmt_prepare(statement, sql, (unsigned long)strlen(sql)) || ({count} && mysql_stmt_bind_param(statement, values)) || mysql_stmt_execute(statement)) {{\n        mysql_stmt_close(statement);\n        return 0;\n    }}\n    return statement;\n}}\n"),
            };
            (if language == "c" { "operazione.c" } else { "operazione.cpp" }, source)
        }
        _ => return Err("Linguaggio non supportato per la funzione.".into()),
    };
    Ok(Some(file(name, source)))
}

fn mongo(language: &str, query: &str) -> Result<GeneratedFile, String> {
    let template = literal(query);
    if language == "python" {
        return Ok(file(
            "operazione.py",
            format!(
                r#"from bson import json_util

def _bind(value, parameters):
    if isinstance(value, list):
        return [_bind(item, parameters) for item in value]
    if isinstance(value, dict):
        if set(value) == {{'$param'}}:
            return parameters[value['$param']]
        return {{key: _bind(item, parameters) for key, item in value.items()}}
    return value

def esegui_operazione(database, parameters=None):
    return database.command(_bind(json_util.loads({template}), parameters or {{}}))
"#
            ),
        ));
    }
    if matches!(language, "javascript" | "typescript") {
        let typed = language == "typescript";
        let import = if typed { "BSON, type Db" } else { "BSON" };
        let database = if typed { ": Db" } else { "" };
        let value = if typed { ": any" } else { "" };
        let parameters = if typed {
            ": Record<string, unknown>"
        } else {
            ""
        };
        return Ok(file(
            if typed {
                "operazione.ts"
            } else {
                "operazione.mjs"
            },
            format!(
                r#"import {{ {import} }} from 'mongodb';

function bind(value{value}, parameters{parameters}){value} {{
  if (Array.isArray(value)) return value.map((item) => bind(item, parameters));
  if (value && typeof value === 'object') {{
    if (Object.keys(value).length === 1 && Object.hasOwn(value, '$param')) {{
      if (!Object.hasOwn(parameters, value.$param)) throw new Error('Parametro mancante: ' + value.$param);
      return parameters[value.$param];
    }}
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, bind(nested, parameters)]));
  }}
  return value;
}}

export function eseguiOperazione(database{database}, parameters{parameters} = {{}}) {{
  const command = bind(JSON.parse({template}), BSON.EJSON.serialize(parameters));
  return database.command(BSON.EJSON.deserialize(command));
}}
"#
            ),
        ));
    }
    // The application makes the BSON document by supplying values into the
    // separate command template. Use an ordered document with the verb first.
    let (name, source) = match language {
        "rust" => ("operazione.rs", "use mongodb::{Database, bson::Document};\n\npub async fn esegui_operazione(database: &Database, command: Document) -> mongodb::error::Result<Document> {\n    database.run_command(command).await\n}\n"),
        "go" => ("operazione.go", "package operazione\n\nimport (\"context\"; \"go.mongodb.org/mongo-driver/v2/bson\"; \"go.mongodb.org/mongo-driver/v2/mongo\")\n\nfunc Esegui(ctx context.Context, database *mongo.Database, comando bson.D) (bson.M, error) {\n  var result bson.M\n  err := database.RunCommand(ctx, comando).Decode(&result)\n  return result, err\n}\n"),
        "java" => ("Operazione.java", "import com.mongodb.client.MongoDatabase;\nimport org.bson.Document;\npublic final class Operazione {\n    public static Document esegui(MongoDatabase database, Document comando) { return database.runCommand(comando); }\n}\n"),
        "kotlin" => ("Operazione.kt", "import com.mongodb.client.MongoDatabase\nimport org.bson.Document\n\nfun eseguiOperazione(database: MongoDatabase, comando: Document): Document = database.runCommand(comando)\n"),
        "csharp" => ("Operazione.cs", "using MongoDB.Bson;\nusing MongoDB.Driver;\nusing System.Threading.Tasks;\n\npublic static class Operazione {\n    public static Task<BsonDocument> EseguiAsync(IMongoDatabase database, BsonDocument comando) =>\n        database.RunCommandAsync(new BsonDocumentCommand<BsonDocument>(comando));\n}\n"),
        "php" => ("operazione.php", "<?php\n\nfunction esegui_operazione(\\MongoDB\\Database $database, array $comando): array {\n    return $database->command($comando)->toArray();\n}\n"),
        "ruby" => ("operazione.rb", "def esegui_operazione(database, comando)\n  database.command(comando).first\nend\n"),
        "c" | "cpp" => (if language == "c" { "operazione.c" } else { "operazione.cpp" }, "#include <mongoc/mongoc.h>\n\n/* Il chiamante libera reply con bson_destroy. */\nbool esegui_operazione(mongoc_database_t *database, const bson_t *comando, bson_t *reply, bson_error_t *error) {\n    return mongoc_database_command_simple(database, comando, NULL, reply, error);\n}\n"),
        _ => return Err("Linguaggio non supportato per il comando MongoDB.".into()),
    };
    Ok(file(name, source))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_rust_operation_uses_sqlx_09_arguments() {
        let parameters = Parameters::from([("id".into(), serde_json::json!(2))]);
        let source = generate(
            "rust",
            "sqlite",
            "SELECT id FROM people WHERE id=:id",
            &parameters,
            false,
        )
        .unwrap()
        .unwrap()
        .content;
        assert!(source.contains("values: sqlx::sqlite::SqliteArguments)"));
        assert!(!source.contains("SqliteArguments<"));
    }
}
