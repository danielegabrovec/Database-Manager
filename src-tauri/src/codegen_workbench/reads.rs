use super::*;
#[path = "c_reads.rs"]
mod c_reads;
#[path = "mongo_reads.rs"]
mod mongo_reads;
fn render(source: &str, pairs: &[(&str, String)]) -> String {
    crate::codegen::substitute(source, pairs)
}
pub(super) fn generate_sql(
    request: &WorkbenchRequest,
    plan: &QueryPlan,
) -> Result<GeneratedProject, String> {
    let names = plan
        .bindings
        .iter()
        .map(|p| p.name.clone())
        .collect::<Vec<_>>();
    let name_json = serde_json::to_string(&names).unwrap();
    let source = match request.language.as_str() {
        "python" => render(
            r#"SQL = @@SQL@@
PARAMETER_NAMES = @@NAMES@@

def read_records(connection, parameters=None):
    parameters = {} if parameters is None else parameters
    missing = [name for name in PARAMETER_NAMES if name not in parameters]
    if missing: raise ValueError('Parametri mancanti: ' + ', '.join(missing))
    cursor = connection.cursor()
    try:
        cursor.execute(SQL, tuple(parameters[name] for name in PARAMETER_NAMES))
        names = [column[0] for column in cursor.description]
        return [dict(row) if hasattr(row, 'keys') else dict(zip(names, row)) for row in cursor.fetchall()]
    finally:
        cursor.close()
"#,
            &[
                ("@@SQL@@", literal(&plan.sql)),
                ("@@NAMES@@", name_json.clone()),
            ],
        ),
        "javascript" | "typescript" => {
            let ts = request.language == "typescript";
            let import = if ts {
                match request.engine.as_str(){"sqlite"=>"import type Database from 'better-sqlite3';\ntype ReadConnection = Database.Database;\n","postgresql"=>"import type { Client } from 'pg';\ntype ReadConnection = Client;\n",_=>"import type { Connection } from 'mariadb';\ntype ReadConnection = Connection;\n"}
            } else {
                ""
            };
            let execute = match request.engine.as_str() {
                "sqlite" => "  return connection.prepare(SQL).safeIntegers(true).all(...values);",
                "postgresql" => "  return (await connection.query(SQL, values)).rows;",
                _ => "  return await connection.execute(SQL, values);",
            };
            let adapted = if request.engine == "sqlite" {
                "const value = parameters[name];\n    return typeof value === 'boolean' ? Number(value) : value;"
            } else {
                "return parameters[name];"
            };
            format!("{import}const SQL = {};\nconst PARAMETER_NAMES = {name_json};\n\nexport async function readRecords(connection{}, parameters{} = {{}}){} {{\n  const values = PARAMETER_NAMES.map(name => {{\n    if (!Object.prototype.hasOwnProperty.call(parameters, name)) throw new Error('Parametro mancante: ' + name);\n    {adapted}\n  }});\n{execute}\n}}\n",literal(&plan.sql),if ts{": ReadConnection"}else{""},if ts{": Record<string, any>"}else{""},if ts{": Promise<any[]>"}else{""})
        }
        "java" => render(
            r#"import java.sql.*;
import java.util.*;

public final class ReadRecords {
    private static final String SQL = @@SQL@@;
    private static final String[] PARAMETER_NAMES = { @@NAMES@@ };
    public static List<Map<String, Object>> readRecords(Connection connection, Map<String, Object> parameters) throws SQLException {
        try (PreparedStatement command = connection.prepareStatement(SQL)) {
            for (int i = 0; i < PARAMETER_NAMES.length; i++) {
                String name = PARAMETER_NAMES[i];
                if (!parameters.containsKey(name)) throw new IllegalArgumentException("Parametro mancante: " + name);
                command.setObject(i + 1, parameters.get(name));
            }
            try (ResultSet rows = command.executeQuery()) {
                List<Map<String, Object>> result = new ArrayList<>();
                ResultSetMetaData metadata = rows.getMetaData();
                while (rows.next()) {
                    Map<String, Object> row = new LinkedHashMap<>();
                    for (int i = 1; i <= metadata.getColumnCount(); i++) row.put(metadata.getColumnLabel(i), rows.getObject(i));
                    result.add(row);
                }
                return result;
            }
        }
    }
}
"#,
            &[
                ("@@SQL@@", literal(&plan.sql)),
                (
                    "@@NAMES@@",
                    names
                        .iter()
                        .map(|n| literal(n))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            ],
        ),
        "kotlin" => render(
            r#"import java.sql.Connection

private const val SQL = @@SQL@@
private val PARAMETER_NAMES = listOf<String>(@@NAMES@@)

fun readRecords(connection: Connection, parameters: Map<String, Any?> = emptyMap()): List<Map<String, Any?>> {
    connection.prepareStatement(SQL).use { command ->
        PARAMETER_NAMES.forEachIndexed { index, name ->
            require(parameters.containsKey(name)) { "Parametro mancante: $name" }
            command.setObject(index + 1, parameters[name])
        }
        command.executeQuery().use { rows ->
            val result = mutableListOf<Map<String, Any?>>()
            val metadata = rows.metaData
            while (rows.next()) {
                val row = linkedMapOf<String, Any?>()
                for (index in 1..metadata.columnCount) row[metadata.getColumnLabel(index)] = rows.getObject(index)
                result.add(row)
            }
            return result
        }
    }
}
"#,
            &[
                ("@@SQL@@", literal(&plan.sql).replace('$', "\\$")),
                (
                    "@@NAMES@@",
                    names
                        .iter()
                        .map(|n| literal(n).replace('$', "\\$"))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            ],
        ),
        "csharp" => render(
            r#"using System;
using System.Data;
using System.Data.Common;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

public static class DatabaseReadQueries {
    private const string Sql = @@SQL@@;
    private static readonly string[] ParameterNames = { @@NAMES@@ };
    public static async Task<List<Dictionary<string, object?>>> ReadRecordsAsync(DbConnection connection, IReadOnlyDictionary<string, object?> parameters, CancellationToken cancellationToken = default) {
        await using var command = connection.CreateCommand();
        command.CommandText = Sql;
        for (int i = 0; i < ParameterNames.Length; i++) {
            if (!parameters.TryGetValue(ParameterNames[i], out var value)) throw new ArgumentException("Parametro mancante: " + ParameterNames[i]);
            var parameter = command.CreateParameter();
            parameter.ParameterName = "@p" + (i + 1);
            parameter.Value = value ?? DBNull.Value;
            command.Parameters.Add(parameter);
        }
        var result = new List<Dictionary<string, object?>>();
        await using var rows = await command.ExecuteReaderAsync(cancellationToken);
        while (await rows.ReadAsync(cancellationToken)) {
            var row = new Dictionary<string, object?>();
            for (int i = 0; i < rows.FieldCount; i++) row[rows.GetName(i)] = rows.IsDBNull(i) ? null : rows.GetValue(i);
            result.Add(row);
        }
        return result;
    }
}
"#,
            &[
                ("@@SQL@@", literal(&plan.sql)),
                (
                    "@@NAMES@@",
                    names
                        .iter()
                        .map(|n| literal(n))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            ],
        ),
        "php" => render(
            r#"<?php
declare(strict_types=1);
namespace DatabaseWorkbench;

function read_records(\PDO $connection, array $parameters = []): array {
    $sql = @@SQL@@;
    $names = [@@NAMES@@];
    $statement = $connection->prepare($sql);
    foreach ($names as $index => $name) {
        if (!array_key_exists($name, $parameters)) throw new \InvalidArgumentException('Parametro mancante: ' . $name);
        $value = $parameters[$name];
        $type = match (true) { $value === null => \PDO::PARAM_NULL, is_bool($value) => \PDO::PARAM_BOOL, is_int($value) => \PDO::PARAM_INT, default => \PDO::PARAM_STR };
        $statement->bindValue($index + 1, $value, $type);
    }
    $statement->execute();
    return $statement->fetchAll(\PDO::FETCH_ASSOC);
}
"#,
            &[
                ("@@SQL@@", single_literal(&plan.sql)),
                (
                    "@@NAMES@@",
                    names
                        .iter()
                        .map(|n| single_literal(n))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            ],
        ),
        "ruby" => {
            let execution=match request.engine.as_str(){"postgresql"=>"    connection.exec_params(SQL, values).to_a\n",_=>"    statement = connection.prepare(SQL)\n    begin\n      result = statement.execute(*values)\n      columns = result.respond_to?(:columns) ? result.columns : nil\n      rows = result.to_a\n      columns ? rows.map { |row| row.is_a?(Hash) ? row.reject { |key, _| key.is_a?(Integer) } : columns.zip(row).to_h } : rows\n    ensure\n      result.close if defined?(result) && result.respond_to?(:close)\n      statement.close unless statement.respond_to?(:closed?) && statement.closed?\n    end\n"};
            format!("module DatabaseWorkbench\n  SQL = {}.freeze\n  PARAMETER_NAMES = [{}].freeze\n  def self.read_records(connection, parameters = {{}})\n    values = PARAMETER_NAMES.map {{ |name| parameters.fetch(name) }}\n{execution}  end\nend\n",single_literal(&plan.sql),names.iter().map(|n|single_literal(n)).collect::<Vec<_>>().join(", "))
        }
        "go" => render(
            r#"package workbench

import (
    "context"
    "database/sql"
    "fmt"
)

func ReadRecords(ctx context.Context, connection *sql.DB, parameters map[string]any) ([]map[string]any, error) {
    names := []string{@@NAMES@@}
    values := make([]any, len(names))
    for index, name := range names { value, ok := parameters[name]; if !ok { return nil, fmt.Errorf("parametro mancante: %s", name) }; values[index] = value }
    rows, err := connection.QueryContext(ctx, @@SQL@@, values...)
    if err != nil { return nil, err }; defer rows.Close()
    columns, err := rows.Columns(); if err != nil { return nil, err }
    result := make([]map[string]any, 0)
    for rows.Next() {
        cells := make([]any, len(columns)); pointers := make([]any, len(columns))
        for index := range cells { pointers[index] = &cells[index] }
        if err := rows.Scan(pointers...); err != nil { return nil, err }
        row := make(map[string]any, len(columns))
        for index, name := range columns { if bytes, ok := cells[index].([]byte); ok { row[name] = append([]byte(nil), bytes...) } else { row[name] = cells[index] } }
        result = append(result, row)
    }
    return result, rows.Err()
}
"#,
            &[
                ("@@SQL@@", literal(&plan.sql)),
                (
                    "@@NAMES@@",
                    names
                        .iter()
                        .map(|n| literal(n))
                        .collect::<Vec<_>>()
                        .join(", "),
                ),
            ],
        ),
        "rust" => rust_read(request, plan)?,
        "c" | "cpp" => c_reads::generate_sql(request, plan)?,
        _ => unreachable!(),
    };
    package(request, source, plan)
}
fn rust_read(request: &WorkbenchRequest, plan: &QueryPlan) -> Result<String, String> {
    let (pool, row) = match request.engine.as_str() {
        "postgresql" => ("sqlx::PgPool", "sqlx::postgres::PgRow"),
        "sqlite" => ("sqlx::SqlitePool", "sqlx::sqlite::SqliteRow"),
        _ => ("sqlx::MySqlPool", "sqlx::mysql::MySqlRow"),
    };
    let mut binding = String::new();
    for p in &plan.bindings {
        let k = kind(&p.data_type)?;
        let normalized = p.data_type.to_ascii_lowercase();
        let(ty,parse)=match k{
            "integer"=>("i64"," if let Some(number) = value.as_i64() { number } else { value.as_str().ok_or(\"Intero o stringa intera richiesto\")?.parse::<i64>()? }".to_owned()),
            "float"=>("f64","value.as_f64().ok_or(\"Numero richiesto\")?".into()),"boolean"=>("bool","value.as_bool().ok_or(\"Booleano richiesto\")?".into()),
            "binary"=>("Vec<u8>","value.as_array().ok_or(\"Array byte richiesto\")?.iter().map(|v|v.as_u64().filter(|v|*v<=255).map(|v|v as u8).ok_or(\"Byte non valido\")).collect::<Result<Vec<_>,_>>()?".into()),
            "decimal" if request.engine!="sqlite"=>("sqlx::types::BigDecimal","value.as_str().ok_or(\"Decimal esatto come stringa richiesto\")?.parse::<sqlx::types::BigDecimal>()?".into()),
            "json" if request.engine!="sqlite"=>("sqlx::types::Json<Value>","sqlx::types::Json(value.clone())".into()),
            "json"=>("String","value.to_string()".into()),
            "date" if request.engine!="sqlite"&&normalized=="date"=>("chrono::NaiveDate","value.as_str().ok_or(\"Data ISO richiesta\")?.parse::<chrono::NaiveDate>()?".into()),
            "date" if request.engine!="sqlite"&&normalized=="time"=>("chrono::NaiveTime","value.as_str().ok_or(\"Ora ISO richiesta\")?.parse::<chrono::NaiveTime>()?".into()),
            "date" if request.engine=="postgresql"&&(normalized.contains("timestamptz")||normalized.contains("with time zone"))=>("chrono::DateTime<chrono::Utc>","value.as_str().ok_or(\"Data RFC3339 richiesta\")?.parse::<chrono::DateTime<chrono::Utc>>()?".into()),
            "date" if request.engine!="sqlite"=>("chrono::NaiveDateTime","chrono::NaiveDateTime::parse_from_str(value.as_str().ok_or(\"Timestamp ISO richiesto\")?, \"%Y-%m-%dT%H:%M:%S%.f\")?".into()),
            _ if request.engine=="postgresql"&&normalized=="uuid"=>("uuid::Uuid","value.as_str().ok_or(\"UUID richiesto\")?.parse::<uuid::Uuid>()?".into()),
            _=>("String","value.as_str().ok_or(\"Stringa richiesta\")?.to_owned()".into()),
        };
        binding+=&format!("    let value = parameters.get({}).ok_or(\"Parametro mancante: {}\")?;\n    query = if value.is_null() {{ query.bind(Option::<{ty}>::None) }} else {{ query.bind({parse}) }};\n",literal(&p.name),p.name);
    }
    Ok(format!("use serde_json::{{Map, Value}};\npub type ReadError = Box<dyn std::error::Error + Send + Sync>;\n\npub async fn read_records(connection: &{pool}, parameters: &Map<String, Value>) -> Result<Vec<{row}>, ReadError> {{\n    let mut query = sqlx::query({:?});\n{binding}    Ok(query.fetch_all(connection).await?)\n}}\n",plan.sql))
}
pub(super) fn package(
    request: &WorkbenchRequest,
    mut source: String,
    plan: &QueryPlan,
) -> Result<GeneratedProject, String> {
    if request.artifact == "repository" {
        source.push_str(&if request.engine == "mongodb" {
            mongo_reads::repository(request)
        } else {
            repository(request)?
        });
    }
    let name = match request.language.as_str() {
        "rust" => "read_records.rs",
        "python" => "read_records.py",
        "javascript" => "read_records.mjs",
        "typescript" => "read_records.ts",
        "php" => "read_records.php",
        "java" => "ReadRecords.java",
        "kotlin" => "ReadRecords.kt",
        "csharp" => "ReadRecords.cs",
        "go" => "read_records.go",
        "ruby" => "read_records.rb",
        "cpp" => "read_records.hpp",
        _ => "read_records.h",
    };
    let dependencies = driver_dependency(request);
    let metadata=plan.bindings.iter().enumerate().map(|(i,p)|json!({"position":i+1,"name":p.name,"dataType":p.data_type,"nullable":p.nullable})).collect::<Vec<_>>();
    let mut files = vec![
        file(format!("workbench/{name}"), source),
        file(
            "workbench/query.sql",
            format!("{};\n", plan.sql.trim_end_matches(';')),
        ),
        file(
            "workbench/parameters.json",
            serde_json::to_string_pretty(&parameter_examples(&request.parameters)).unwrap(),
        ),
        file(
            "workbench/bindings.json",
            serde_json::to_string_pretty(&metadata).unwrap(),
        ),
    ];
    if request.artifact == "repository" && !request.columns.is_empty() {
        files.extend(models::generate(request)?.files);
    }
    let readme=format!("# Lettura {} / {}\n\nDipendenze: {dependencies}.\n\nIl file `{name}` definisce una funzione richiamabile e non apre connessioni né esegue codice all’importazione. Passare una connessione già configurata e parametri con i nomi di `parameters.json`. I valori sono sempre bind del driver: non concatenarli alla query. `bindings.json` descrive l’ordine effettivo, incluse le ripetizioni dello stesso parametro.\n\nLa query include schema, JOIN, filtri e aggregazioni richiesti; il suo testo non viene ricostruito per interpolazione di valori. I risultati mantengono i tipi nativi del driver (decimal, interi grandi, null e byte); usare conversioni esplicite per JSON e per i modelli di dominio. Python/PDO/JDBC/Go/Ruby richiedono valori nativi accettati dal driver (per esempio Decimal/BigDecimal, data/ora e JSON serializzato quando necessario). Rust valida e converte i parametri JSON secondo i tipi dichiarati.\n\nLa connessione rimane di proprietà del chiamante; solo cursori e statement creati dalla funzione vengono chiusi. In C/C++ i puntatori dei risultati sono validi soltanto durante la callback. Le query automatiche leggono al massimo 100 righe; nelle query personalizzate limiti e paginazione sono quelli del testo SQL fornito. Nessun file viene eseguito o installato dal generatore.\n",request.language,request.engine);
    files.push(file("workbench/README.md", readme));
    Ok(GeneratedProject{files,command:String::new(),notes:vec![format!("Funzione di lettura richiamabile per {}: {dependencies}.",request.language),"Parametri dichiarati e query rimangono separati. Il modulo richiede una connessione esistente e non viene eseguito automaticamente.".into()]})
}
fn repository(request: &WorkbenchRequest) -> Result<String, String> {
    Ok(match request.language.as_str(){
        "python"=>"\nclass RecordRepository:\n    def __init__(self, connection): self.connection = connection\n    def read(self, parameters=None): return read_records(self.connection, parameters)\n".into(),
        "javascript"=>"\nexport class RecordRepository {\n  constructor(connection) { this.connection = connection; }\n  read(parameters = {}) { return readRecords(this.connection, parameters); }\n}\n".into(),
        "typescript"=>"\nexport class RecordRepository {\n  constructor(private readonly connection: ReadConnection) {}\n  read(parameters: Record<string, any> = {}) { return readRecords(this.connection, parameters); }\n}\n".into(),
        "php"=>"\nfinal class RecordRepository {\n    public function __construct(private \\PDO $connection) {}\n    public function read(array $parameters = []): array { return read_records($this->connection, $parameters); }\n}\n".into(),
        "ruby"=>"\nmodule DatabaseWorkbench\n  class RecordRepository\n    def initialize(connection); @connection = connection; end\n    def read(parameters = {}); DatabaseWorkbench.read_records(@connection, parameters); end\n  end\nend\n".into(),
        "go"=>"\ntype RecordRepository struct { Connection *sql.DB }\nfunc (repository *RecordRepository) Read(ctx context.Context, parameters map[string]any) ([]map[string]any, error) { return ReadRecords(ctx, repository.Connection, parameters) }\n".into(),
        "kotlin"=>"\nclass RecordRepository(private val connection: Connection) {\n    fun read(parameters: Map<String, Any?> = emptyMap()): List<Map<String, Any?>> = readRecords(connection, parameters)\n}\n".into(),
        "csharp"=>"\npublic sealed class RecordRepository {\n    private readonly DbConnection connection;\n    public RecordRepository(DbConnection connection) { this.connection = connection; }\n    public Task<List<Dictionary<string, object?>>> ReadAsync(IReadOnlyDictionary<string, object?> parameters, CancellationToken cancellationToken = default) => DatabaseReadQueries.ReadRecordsAsync(connection, parameters, cancellationToken);\n}\n".into(),
        "java"=>"\nfinal class RecordRepository {\n    private final Connection connection;\n    public RecordRepository(Connection connection) { this.connection = connection; }\n    public List<Map<String, Object>> read(Map<String, Object> parameters) throws SQLException { return ReadRecords.readRecords(connection, parameters); }\n}\n".into(),
        "rust"=>{let(pool,row)=match request.engine.as_str(){"postgresql"=>("sqlx::PgPool","sqlx::postgres::PgRow"),"sqlite"=>("sqlx::SqlitePool","sqlx::sqlite::SqliteRow"),_=>("sqlx::MySqlPool","sqlx::mysql::MySqlRow")};format!("\npub struct RecordRepository<'a> {{ pub connection: &'a {pool} }}\nimpl RecordRepository<'_> {{ pub async fn read(&self, parameters: &Map<String, Value>) -> Result<Vec<{row}>, ReadError> {{ read_records(self.connection, parameters).await }} }}\n")},
        "c"|"cpp"=>c_reads::repository(request),
        _=>String::new(),
    })
}
fn driver_dependency(request: &WorkbenchRequest) -> &'static str {
    if request.engine == "mongodb" {
        return match request.language.as_str() {
            "rust" => "mongodb, bson tramite mongodb::bson, futures-util, serde_json",
            "python" => "pymongo/bson",
            "javascript" | "typescript" => "mongodb driver Node",
            "java" | "kotlin" => "MongoDB Java Sync Driver",
            "csharp" => "MongoDB.Driver",
            "go" => "go.mongodb.org/mongo-driver/v2",
            "php" => "mongodb/mongodb e PHP ext-mongodb",
            "ruby" => "mongo/bson gems",
            _ => "libmongoc e libbson",
        };
    }
    match(request.language.as_str(),request.engine.as_str()){
    ("rust",_)=>"sqlx (driver del motore, runtime-tokio), serde_json; chrono/uuid/bigdecimal per i rispettivi parametri",
    ("python","sqlite")=>"Python sqlite3 standard",("python","postgresql")=>"psycopg3",("python",_)=>"PyMySQL",
    ("javascript"|"typescript","sqlite")=>"better-sqlite3",("javascript"|"typescript","postgresql")=>"pg",("javascript"|"typescript",_)=>"mariadb",
    ("java"|"kotlin","sqlite")=>"SQLite JDBC",("java"|"kotlin","postgresql")=>"PostgreSQL JDBC",("java"|"kotlin",_)=>"MariaDB Connector/J",
    ("csharp","sqlite")=>"Microsoft.Data.Sqlite",("csharp","postgresql")=>"Npgsql",("csharp",_)=>"MySqlConnector",
    ("php",_)=>"PDO con driver del motore",("go",_)=>"database/sql con driver sqlite, pgx/v5/stdlib o go-sql-driver/mysql",
    ("ruby","sqlite")=>"sqlite3 gem",("ruby","postgresql")=>"pg gem",("ruby",_)=>"mysql2 gem",
    (_,"sqlite")=>"SQLite3 C API",(_,"postgresql")=>"libpq",_=>"MariaDB Connector/C o MySQL C API",
}
}
pub(super) fn generate_mongo(request: &WorkbenchRequest) -> Result<GeneratedProject, String> {
    mongo_reads::generate(request)
}
