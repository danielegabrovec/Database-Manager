use super::templates::Template;
use super::*;
pub(super) fn build(ctx: &Context) -> Result<Template, String> {
    match ctx.req.language.as_str() {
        "rust" => rust(ctx),
        "java" | "kotlin" => jvm(ctx),
        "csharp" => csharp(ctx),
        "c" | "cpp" => c(ctx),
        _ => Err("Template non disponibile".into()),
    }
}

fn rust(ctx: &Context) -> Result<Template, String> {
    let mongo = ctx.req.engine == "mongodb";
    let body = if mongo {
        r#"
    use mongodb::{bson::{self, Document}, Client};
    use futures_util::TryStreamExt;
    let client = Client::with_uri_str(std::env::var("DATABASE_URL")?).await?;
    let collection = client.database(&std::env::var("DATABASE_NAME").unwrap_or_else(|_| "database".into())).collection::<Document>(TABLE);
    let mut document: Document = serde_json::from_value(payload)?;
    match operation {
        "list" => {
            let filter: Document = serde_json::from_str(FILTER)?;
            let docs: Vec<Document> = collection.find(filter).limit(100).await?.try_collect().await?;
            Ok(Value::Array(docs.into_iter().map(|doc| bson::Bson::Document(doc).into_canonical_extjson()).collect()))
        }
        "insert" => { let result = collection.insert_one(document).await?; Ok(json!({"insertedId": result.inserted_id.into_canonical_extjson()})) }
        "update" | "delete" => {
            let id = document.remove("_id").ok_or("Manca _id in Extended JSON")?;
            let filter = bson::doc! { "_id": id };
            if operation == "delete" { return Ok(json!({"deleted": collection.delete_one(filter).await?.deleted_count})); }
            if document.is_empty() { return Err("Nessun campo da aggiornare".into()); }
            let result = collection.update_one(filter, bson::doc! { "$set": document }).await?;
            Ok(json!({"matched": result.matched_count, "modified": result.modified_count}))
        }
        _ => Err("Operazione sconosciuta".into()),
    }
"#.to_string()
    } else {
        let pool=match ctx.req.engine.as_str(){"sqlite"=>"sqlx::SqlitePool::connect(&format!(\"sqlite:{}?mode=rwc\", std::env::var(\"DATABASE_URL\").unwrap_or_else(|_| \"./database.sqlite\".into()))).await?","postgresql"=>"sqlx::PgPool::connect(&std::env::var(\"DATABASE_URL\")?).await?",_=>"sqlx::MySqlPool::connect(&std::env::var(\"DATABASE_URL\")?).await?"};
        let mut bindings = String::new();
        for col in &ctx.req.columns {
            let k = kind(&col.data_type)?;
            let base = col.data_type.to_lowercase();
            let (ty,value)=match k{
                "integer"=>("i64".to_string(),"value.as_i64().ok_or(\"Intero a 64 bit richiesto\")?".to_string()),
                "float"=>("f64".into(),"value.as_f64().ok_or(\"Numero richiesto\")?".into()),
                "boolean"=>("bool".into(),"value.as_bool().ok_or(\"Booleano richiesto\")?".into()),
                "binary"=>("Vec<u8>".into(),"value.as_array().ok_or(\"Array byte richiesto\")?.iter().map(|v| v.as_u64().filter(|v| *v <= 255).map(|v| v as u8).ok_or(\"Byte fuori intervallo\")).collect::<Result<Vec<_>, _>>()?".into()),
                "decimal" if ctx.req.engine!="sqlite"=>("sqlx::types::BigDecimal".into(),"value.as_str().ok_or(\"Decimal richiede stringa esatta\")?.parse::<sqlx::types::BigDecimal>()?".into()),
                "json" if ctx.req.engine!="sqlite"=>("sqlx::types::Json<Value>".into(),"sqlx::types::Json(value.clone())".into()),
                "json"=>("String".into(),"value.to_string()".into()),
                "date" if ctx.req.engine!="sqlite" && base=="date"=>("chrono::NaiveDate".into(),"value.as_str().ok_or(\"Data ISO richiesta\")?.parse::<chrono::NaiveDate>()?".into()),
                "date" if ctx.req.engine!="sqlite" && base=="time"=>("chrono::NaiveTime".into(),"value.as_str().ok_or(\"Ora ISO richiesta\")?.parse::<chrono::NaiveTime>()?".into()),
                "date" if ctx.req.engine=="postgresql" && (base.contains("timestamptz")||base.contains("with time zone"))=>("chrono::DateTime<chrono::Utc>".into(),"value.as_str().ok_or(\"Data RFC3339 richiesta\")?.parse::<chrono::DateTime<chrono::Utc>>()?".into()),
                "date" if ctx.req.engine!="sqlite"=>("chrono::NaiveDateTime".into(),"chrono::NaiveDateTime::parse_from_str(value.as_str().ok_or(\"Timestamp ISO richiesto\")?, \"%Y-%m-%dT%H:%M:%S%.f\")?".into()),
                _ if ctx.req.engine=="postgresql"&&base=="uuid"=>("uuid::Uuid".into(),"value.as_str().ok_or(\"UUID richiesto\")?.parse::<uuid::Uuid>()?".into()),
                _=>("String".into(),"value.as_str().ok_or(\"Stringa richiesta\")?.to_owned()".into())};
            bindings.push_str(&format!("            {} => {{ query = if value.is_null() {{ query.bind(Option::<{ty}>::None) }} else {{ query.bind({value}) }}; }},\n",literal(&col.name)));
        }
        let rowtype = match ctx.req.engine.as_str() {
            "sqlite" => "sqlx::sqlite::SqliteRow",
            "postgresql" => "sqlx::postgres::PgRow",
            _ => "sqlx::mysql::MySqlRow",
        };
        let decode = match ctx.req.engine.as_str() {
            "sqlite" => {
                r#"match name { "INTEGER" | "INT" | "INT8" => json!(row.try_get::<i64, _>(index)?), "REAL" | "FLOAT" => json!(row.try_get::<f64, _>(index)?), "BLOB" => json!(row.try_get::<Vec<u8>, _>(index)?), "TEXT" => json!(row.try_get::<String, _>(index)?), _ => return Err(format!("Tipo SQLite non supportato: {name}").into()) }"#
            }
            "postgresql" => {
                r#"match name { "INT2" => json!(row.try_get::<i16, _>(index)?), "INT4" => json!(row.try_get::<i32, _>(index)?), "INT8" => json!(row.try_get::<i64, _>(index)?), "FLOAT4" => json!(row.try_get::<f32, _>(index)?), "FLOAT8" => json!(row.try_get::<f64, _>(index)?), "BOOL" => json!(row.try_get::<bool, _>(index)?), "BYTEA" => json!(row.try_get::<Vec<u8>, _>(index)?), "JSON" | "JSONB" => row.try_get::<sqlx::types::Json<Value>, _>(index)?.0, "NUMERIC" => json!(row.try_get::<sqlx::types::BigDecimal, _>(index)?.to_string()), "DATE" => json!(row.try_get::<chrono::NaiveDate, _>(index)?.to_string()), "TIME" => json!(row.try_get::<chrono::NaiveTime, _>(index)?.to_string()), "TIMESTAMP" => json!(row.try_get::<chrono::NaiveDateTime, _>(index)?.to_string()), "TIMESTAMPTZ" => json!(row.try_get::<chrono::DateTime<chrono::Utc>, _>(index)?.to_rfc3339()), "UUID" => json!(row.try_get::<uuid::Uuid, _>(index)?.to_string()), "TEXT" | "VARCHAR" | "CHAR" | "BPCHAR" | "NAME" => json!(row.try_get::<String, _>(index)?), _ => return Err(format!("Tipo PostgreSQL non supportato: {name}").into()) }"#
            }
            _ => {
                r#"match name { "TINYINT" | "SMALLINT" | "INT" | "MEDIUMINT" | "BIGINT" => json!(row.try_get::<i64, _>(index)?), "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "INT UNSIGNED" | "MEDIUMINT UNSIGNED" | "BIGINT UNSIGNED" => json!(row.try_get::<u64, _>(index)?), "FLOAT" => json!(row.try_get::<f32, _>(index)?), "DOUBLE" => json!(row.try_get::<f64, _>(index)?), "DECIMAL" => json!(row.try_get::<sqlx::types::BigDecimal, _>(index)?.to_string()), "DATE" => json!(row.try_get::<chrono::NaiveDate, _>(index)?.to_string()), "TIME" => json!(row.try_get::<chrono::NaiveTime, _>(index)?.to_string()), "DATETIME" | "TIMESTAMP" => json!(row.try_get::<chrono::NaiveDateTime, _>(index)?.to_string()), "JSON" => row.try_get::<sqlx::types::Json<Value>, _>(index)?.0, "BLOB" | "LONGBLOB" | "MEDIUMBLOB" | "TINYBLOB" | "BINARY" | "VARBINARY" => json!(row.try_get::<Vec<u8>, _>(index)?), "VARCHAR" | "CHAR" | "TEXT" | "LONGTEXT" | "MEDIUMTEXT" | "TINYTEXT" | "ENUM" => json!(row.try_get::<String, _>(index)?), _ => return Err(format!("Tipo MySQL/MariaDB non supportato: {name}").into()) }"#
            }
        };
        format!(
            r#"
    use sqlx::{{Column, Row, TypeInfo, ValueRef}};
    let pool = {pool};
    let columns: Vec<String> = serde_json::from_str(COLUMNS)?;
    let keys: Vec<String> = serde_json::from_str(KEYS)?;
    let nonkeys: Vec<String> = serde_json::from_str(NONKEYS)?;
    let (sql, fields) = match operation {{
        "list" => (QUERY, vec![]), "insert" => (INSERT, columns),
        "update" => (UPDATE, nonkeys.into_iter().chain(keys).collect()), "delete" => (DELETE, keys),
        _ => return Err("Operazione sconosciuta".into()),
    }};
    if sql.is_empty() {{ return Err("Operazione non disponibile".into()); }}
    let mut query = sqlx::query(sql);
    for field in fields {{
        let value = payload.get(&field).ok_or_else(|| format!("Campo mancante: {{field}}"))?;
        match field.as_str() {{
{bindings}            _ => return Err("Colonna sconosciuta".into()),
        }}
    }}
    if operation != "list" {{ return Ok(json!({{"affected": query.execute(&pool).await?.rows_affected()}})); }}
    use futures_util::TryStreamExt;
    let mut stream = query.fetch(&pool);
    let mut records = Vec::new();
    while let Some(row) = stream.try_next().await? {{
        let row: {rowtype} = row;
        let mut record = serde_json::Map::new();
        for (index, column) in row.columns().iter().enumerate() {{
            let value = if row.try_get_raw(index)?.is_null() {{ Value::Null }} else {{
                let type_info = column.type_info(); let name = type_info.name();
                {decode}
            }};
            record.insert(column.name().to_owned(), value);
        }}
        records.push(Value::Object(record)); if records.len() >= 100 {{ break; }}
    }}
    Ok(Value::Array(records))
"#
        )
    };
    let constants=ctx.render("const TABLE: &str = @@TABLE@@;\nconst QUERY: &str = @@QUERY@@;\nconst INSERT: &str = @@INSERT@@;\nconst UPDATE: &str = @@UPDATE@@;\nconst DELETE: &str = @@DELETE@@;\nconst FILTER: &str = @@FILTER@@;\n");
    let constants = format!(
        "{constants}const COLUMNS: &str = {};\nconst KEYS: &str = {};\nconst NONKEYS: &str = {};\n",
        literal(&json!(ctx.columns).to_string()),
        literal(&json!(ctx.keys).to_string()),
        literal(&json!(ctx.nonkeys).to_string())
    );
    let source = format!(
        r#"use serde_json::{{json, Value}};
{constants}
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub async fn execute(operation: &str, payload: Value) -> Result<Value, Error> {{
    if !payload.is_object() {{ return Err("Payload deve essere oggetto JSON".into()); }}
{body}
}}
#[tokio::main]
async fn main() -> Result<(), Error> {{
    let args: Vec<String> = std::env::args().collect();
    let payload: Value = serde_json::from_str(args.get(2).map(String::as_str).unwrap_or("{{}}"))?;
    println!("{{}}", execute(args.get(1).map(String::as_str).unwrap_or("list"), payload).await?);
    Ok(())
}}
"#
    );
    let feature = match ctx.req.engine.as_str() {
        "sqlite" => "sqlite",
        "postgresql" => "postgres",
        _ => "mysql",
    };
    let driver = if mongo {
        "mongodb = \"3.10\"\n".into()
    } else {
        format!("sqlx = {{ version = \"0.9\", default-features = false, features = [\"runtime-tokio\", \"tls-rustls-ring\", \"{feature}\", \"chrono\", \"uuid\", \"bigdecimal\", \"json\"] }}\nchrono = \"0.4\"\nuuid = \"1\"\n")
    };
    let manifest=format!("[package]\nname = \"database-example\"\nversion = \"1.0.0\"\nedition = \"2021\"\n\n[dependencies]\ntokio = {{ version = \"1\", features = [\"macros\", \"rt-multi-thread\"] }}\nserde_json = \"1\"\nfutures-util = \"0.3\"\n{driver}");
    Ok(Template {
        source,
        path: "src/main.rs".into(),
        files: vec![file("Cargo.toml", manifest)],
        command: "cargo run -- list".into(),
        dependencies: if mongo {
            "mongodb + Tokio"
        } else {
            "SQLx + Tokio"
        }
        .into(),
    })
}

fn csharp(ctx: &Context) -> Result<Template, String> {
    let mongo = ctx.req.engine == "mongodb";
    let (driver,version,using,constructor)=match ctx.req.engine.as_str(){
        "sqlite"=>("Microsoft.Data.Sqlite","10.0.13","using Microsoft.Data.Sqlite;","new SqliteConnection(\"Data Source=\" + (Environment.GetEnvironmentVariable(\"DATABASE_URL\") ?? \"./database.sqlite\"))"),
        "postgresql"=>("Npgsql","10.0.3","using Npgsql;","new NpgsqlConnection(ConnectionString())"),
        "mongodb"=>("MongoDB.Driver","3.13.0","using MongoDB.Driver;\nusing MongoDB.Bson;\nusing MongoDB.Bson.IO;",""),
        _=>("MySqlConnector","2.6.2","using MySqlConnector;","new MySqlConnection(ConnectionString())")};
    let ctxp = ctx.placeholders("named");
    let constants=format!("const string Table = {};\nconst string Query = {};\nconst string Insert = {};\nconst string Update = {};\nconst string Delete = {};\nstring[] Columns = {};\nstring[] Keys = {};\nstring[] Nonkeys = {};\n",literal(&ctx.req.table),literal(&ctx.select),literal(&ctxp.insert),literal(&ctxp.update),literal(&ctxp.delete),cs_array(&ctx.columns),cs_array(&ctx.keys),cs_array(&ctx.nonkeys));
    let kind_cases = ctx
        .req
        .columns
        .iter()
        .map(|column| {
            Ok(format!(
                "{} => {}",
                literal(&column.name),
                literal(kind(&column.data_type)?)
            ))
        })
        .collect::<Result<Vec<_>, String>>()?
        .join(", ");
    let type_cases = ctx
        .req
        .columns
        .iter()
        .map(|column| {
            format!(
                "{} => {}",
                literal(&column.name),
                literal(&column.data_type.to_lowercase())
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    let constants=format!("{constants}string ColumnKind(string name) => name switch {{ {kind_cases}{} _ => \"\" }};\nstring ColumnType(string name) => name switch {{ {type_cases}{} _ => \"\" }};\n",if kind_cases.is_empty(){""}else{","},if type_cases.is_empty(){""}else{","});
    let adaptation = format!(
        r#"
  if (value.ValueKind != JsonValueKind.Null) {{
    var kind = ColumnKind(fields[i]); var declared = ColumnType(fields[i]);
    if (declared == "uuid") parameter.Value = Guid.Parse(value.GetString()!);
    else if (kind == "decimal") parameter.Value = decimal.Parse(value.ValueKind == JsonValueKind.String ? value.GetString()! : value.GetRawText(), System.Globalization.CultureInfo.InvariantCulture);
    else if (kind == "date") parameter.Value = declared == "date" ? (object)DateOnly.Parse(value.GetString()!, System.Globalization.CultureInfo.InvariantCulture) : declared == "time" ? TimeOnly.Parse(value.GetString()!, System.Globalization.CultureInfo.InvariantCulture) : DateTime.Parse(value.GetString()!, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind);
    else if (kind == "json") {{ parameter.Value = value.GetRawText(); {} }}
  }}
"#,
        if ctx.req.engine == "postgresql" {
            "((NpgsqlParameter)parameter).NpgsqlDbType = NpgsqlTypes.NpgsqlDbType.Jsonb;"
        } else {
            ""
        }
    );
    let body = if mongo {
        format!(
            r#"
var client = new MongoClient(Environment.GetEnvironmentVariable("DATABASE_URL") ?? throw new Exception("Impostare DATABASE_URL"));
var collection = client.GetDatabase(Environment.GetEnvironmentVariable("DATABASE_NAME") ?? "database").GetCollection<BsonDocument>(Table);
var document = BsonDocument.Parse(payload.GetRawText());
object result;
switch (operation) {{
  case "list": result = (await collection.Find(BsonDocument.Parse({})).Limit(100).ToListAsync()).Select(d => d.ToJson(new JsonWriterSettings {{ OutputMode = JsonOutputMode.CanonicalExtendedJson }})).Select(s => JsonSerializer.Deserialize<JsonElement>(s)); break;
  case "insert": await collection.InsertOneAsync(document); result = JsonSerializer.Deserialize<JsonElement>(document.ToJson(new JsonWriterSettings {{ OutputMode = JsonOutputMode.CanonicalExtendedJson }})); break;
  case "update": case "delete":
    if (!document.TryGetValue("_id", out var id)) throw new Exception("Manca _id");
    var filter = new BsonDocument("_id", id); document.Remove("_id");
    if (operation == "delete") result = new {{ deleted = (await collection.DeleteOneAsync(filter)).DeletedCount }};
    else {{ if (document.ElementCount == 0) throw new Exception("Nessun campo da aggiornare"); var r = await collection.UpdateOneAsync(filter, new BsonDocument("$set", document)); result = new {{ matched = r.MatchedCount, modified = r.ModifiedCount }}; }}
    break;
  default: throw new Exception("Operazione sconosciuta");
}}
Console.WriteLine(JsonSerializer.Serialize(result));
"#,
            literal(&ctx.filter.to_string())
        )
    } else {
        format!(
            r#"
string ConnectionString() {{
  var raw = Environment.GetEnvironmentVariable("DATABASE_URL") ?? throw new Exception("Impostare DATABASE_URL");
  if (!raw.Contains("://")) return raw;
  var url = new Uri(raw); var credentials = url.UserInfo.Split(':', 2);
  var builder = new DbConnectionStringBuilder();
  builder["Host"] = url.Host; builder["Port"] = url.IsDefaultPort ? {} : url.Port;
  builder["Database"] = Uri.UnescapeDataString(url.AbsolutePath.TrimStart('/'));
  builder["Username"] = Uri.UnescapeDataString(credentials[0]);
  builder["Password"] = credentials.Length > 1 ? Uri.UnescapeDataString(credentials[1]) : "";
  return builder.ConnectionString;
}}
await using DbConnection connection = {constructor};
await connection.OpenAsync();
var (sql, fields) = operation switch {{ "list" => (Query, Array.Empty<string>()), "insert" => (Insert, Columns), "update" => (Update, Nonkeys.Concat(Keys).ToArray()), "delete" => (Delete, Keys), _ => throw new Exception("Operazione sconosciuta") }};
if (sql.Length == 0) throw new Exception("Operazione non disponibile");
await using var command = connection.CreateCommand(); command.CommandText = sql;
for (int i = 0; i < fields.Length; i++) {{
  if (!payload.TryGetProperty(fields[i], out var value)) throw new Exception("Campo mancante: " + fields[i]);
  var parameter = command.CreateParameter(); parameter.ParameterName = "p" + (i + 1);
  parameter.Value = value.ValueKind switch {{ JsonValueKind.Null => DBNull.Value, JsonValueKind.True => true, JsonValueKind.False => false, JsonValueKind.Number => value.TryGetInt64(out var integer) ? (object)integer : value.GetDouble(), JsonValueKind.String => value.GetString()!, _ => value.GetRawText() }};
{adaptation}
  command.Parameters.Add(parameter);
}}
if (operation == "list") {{
  await using var reader = await command.ExecuteReaderAsync(); var records = new List<Dictionary<string, object?>>();
  while (records.Count < 100 && await reader.ReadAsync()) {{ var record = new Dictionary<string, object?>(); for (int i=0; i<reader.FieldCount; i++) record[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i); records.Add(record); }}
  Console.WriteLine(JsonSerializer.Serialize(records));
}} else Console.WriteLine(JsonSerializer.Serialize(new {{ affected = await command.ExecuteNonQueryAsync() }}));
"#,
            if ctx.req.engine == "postgresql" {
                5432
            } else {
                3306
            }
        )
    };
    let source=format!("using System;\nusing System.Linq;\nusing System.Collections.Generic;\nusing System.Data.Common;\nusing System.Text.Json;\n{using}\n{constants}\nstring operation = args.Length > 0 ? args[0] : \"list\";\nusing var parsed = JsonDocument.Parse(args.Length > 1 ? args[1] : \"{{}}\");\nvar payload = parsed.RootElement;\nif (payload.ValueKind != JsonValueKind.Object) throw new Exception(\"Payload deve essere oggetto JSON\");\n{body}");
    Ok(Template{source,path:"Program.cs".into(),files:vec![file("DatabaseExample.csproj",format!("<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><PackageReference Include=\"{driver}\" Version=\"{version}\" /></ItemGroup></Project>"))],command:"dotnet run -- list".into(),dependencies:driver.into()})
}
fn cs_array(values: &[String]) -> String {
    format!(
        "new string[] {{ {} }}",
        values
            .iter()
            .map(|v| literal(v))
            .collect::<Vec<_>>()
            .join(", ")
    )
}

fn jvm(ctx: &Context) -> Result<Template, String> {
    let kotlin = ctx.req.language == "kotlin";
    let mongo = ctx.req.engine == "mongodb";
    let dependency = match ctx.req.engine.as_str() {
        "sqlite" => "org.xerial:sqlite-jdbc:3.47.2.0",
        "postgresql" => "org.postgresql:postgresql:42.7.5",
        "mongodb" => "org.mongodb:mongodb-driver-sync:5.3.0",
        _ => "org.mariadb.jdbc:mariadb-java-client:3.5.1",
    };
    let constants = ctx.placeholders("?");
    let mut pairs = constants.pairs();
    for marker in ["@@COLUMNS@@", "@@KEYS@@", "@@NONKEYS@@"] {
        let list = match marker {
            "@@COLUMNS@@" => &ctx.columns,
            "@@KEYS@@" => &ctx.keys,
            _ => &ctx.nonkeys,
        };
        if let Some(pair) = pairs.iter_mut().find(|p| p.0 == marker) {
            pair.1 = format!(
                "new String[] {{ {} }}",
                list.iter()
                    .map(|v| literal(v))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
    }
    let connection = if ctx.req.engine == "sqlite" {
        "String url = \"jdbc:sqlite:\" + System.getenv().getOrDefault(\"DATABASE_URL\", \"./database.sqlite\"); String user = \"\", password = \"\";"
    } else {
        "String raw = Objects.requireNonNull(System.getenv(\"DATABASE_URL\"), \"Impostare DATABASE_URL\"); java.net.URI uri = java.net.URI.create(raw); String[] auth = Objects.requireNonNullElse(uri.getRawUserInfo(), \"\").split(\":\", 2); String user = java.net.URLDecoder.decode(auth[0], java.nio.charset.StandardCharsets.UTF_8); String password = auth.length > 1 ? java.net.URLDecoder.decode(auth[1], java.nio.charset.StandardCharsets.UTF_8) : \"\"; String scheme = ENGINE.equals(\"postgresql\") ? \"postgresql\" : \"mariadb\"; String url = \"jdbc:\" + scheme + \"://\" + uri.getHost() + (uri.getPort() > 0 ? \":\" + uri.getPort() : \"\") + uri.getRawPath();"
    };
    let sqlbody = format!(
        r#"
    {connection}
    String sql; String[] fields;
    switch (operation) {{
      case "list": sql = QUERY; fields = new String[0]; break;
      case "insert": sql = INSERT; fields = COLUMNS; break;
      case "update": sql = UPDATE; fields = java.util.stream.Stream.concat(Arrays.stream(NONKEYS), Arrays.stream(KEYS)).toArray(String[]::new); break;
      case "delete": sql = DELETE; fields = KEYS; break;
      default: throw new IllegalArgumentException("Operazione sconosciuta");
    }}
    if (sql.isEmpty()) throw new IllegalArgumentException("Operazione non disponibile");
    try (Connection connection = DriverManager.getConnection(url, user, password); PreparedStatement statement = connection.prepareStatement(sql)) {{
      for (int i = 0; i < fields.length; i++) {{
        JsonNode value = payload.get(fields[i]); if (value == null) throw new IllegalArgumentException("Campo mancante: " + fields[i]);
        if (value.isNull()) statement.setObject(i + 1, null);
        else if (value.isBoolean()) statement.setBoolean(i + 1, value.booleanValue());
        else if (value.isIntegralNumber()) statement.setLong(i + 1, value.longValue());
        else if (value.isFloatingPointNumber()) statement.setBigDecimal(i + 1, value.decimalValue());
        else if (ENGINE.equals("postgresql")) statement.setObject(i + 1, value.isTextual() ? value.textValue() : value.toString(), Types.OTHER);
        else statement.setString(i + 1, value.isTextual() ? value.textValue() : value.toString());
      }}
      if (!statement.execute()) return Map.of("affected", statement.getUpdateCount());
      List<Map<String, Object>> records = new ArrayList<>();
      try (ResultSet rows = statement.getResultSet()) {{ ResultSetMetaData meta = rows.getMetaData(); while (records.size() < 100 && rows.next()) {{ Map<String, Object> record = new LinkedHashMap<>(); for (int i = 1; i <= meta.getColumnCount(); i++) {{ Object value = rows.getObject(i); if (value instanceof java.math.BigDecimal || value instanceof java.sql.Date || value instanceof java.sql.Time || value instanceof java.sql.Timestamp || value instanceof java.util.UUID) value = value.toString(); if (value != null && value.getClass().getName().equals("org.postgresql.util.PGobject")) value = value.toString(); record.put(meta.getColumnLabel(i), value); }} records.add(record); }} }}
      return records;
    }}
"#
    );
    let mongobody = r#"
    try (com.mongodb.client.MongoClient client = com.mongodb.client.MongoClients.create(Objects.requireNonNull(System.getenv("DATABASE_URL"), "Impostare DATABASE_URL"))) {
      com.mongodb.client.MongoCollection<org.bson.Document> collection = client.getDatabase(System.getenv().getOrDefault("DATABASE_NAME", "database")).getCollection(TABLE);
      org.bson.Document document = org.bson.Document.parse(payload.toString());
      if (operation.equals("list")) {
        List<JsonNode> docs = new ArrayList<>(); for (org.bson.Document row : collection.find(org.bson.Document.parse(FILTER)).limit(100)) docs.add(JSON.readTree(row.toJson(org.bson.json.JsonWriterSettings.builder().outputMode(org.bson.json.JsonMode.EXTENDED).build()))); return docs;
      }
      if (operation.equals("insert")) { collection.insertOne(document); return JSON.readTree(document.toJson(org.bson.json.JsonWriterSettings.builder().outputMode(org.bson.json.JsonMode.EXTENDED).build())); }
      if (!document.containsKey("_id")) throw new IllegalArgumentException("Manca _id");
      org.bson.Document filter = new org.bson.Document("_id", document.remove("_id"));
      if (operation.equals("delete")) return Map.of("deleted", collection.deleteOne(filter).getDeletedCount());
      if (operation.equals("update")) { if (document.isEmpty()) throw new IllegalArgumentException("Nessun campo da aggiornare"); com.mongodb.client.result.UpdateResult result = collection.updateOne(filter, new org.bson.Document("$set", document)); return Map.of("matched", result.getMatchedCount(), "modified", result.getModifiedCount()); }
      throw new IllegalArgumentException("Operazione sconosciuta");
    }
"#;
    let source = substitute(
        &format!(
            r#"import java.util.*;
import java.sql.*;
import com.fasterxml.jackson.databind.*;
public class Database {{
  static final ObjectMapper JSON = new ObjectMapper();
  static final String TABLE = @@TABLE@@, ENGINE = @@ENGINE@@, QUERY = @@QUERY@@, INSERT = @@INSERT@@, UPDATE = @@UPDATE@@, DELETE = @@DELETE@@, FILTER = @@FILTER@@;
  static final String[] COLUMNS = @@COLUMNS@@, KEYS = @@KEYS@@, NONKEYS = @@NONKEYS@@;
  public static Object execute(String operation, JsonNode payload) throws Exception {{
    if (!payload.isObject()) throw new IllegalArgumentException("Payload deve essere oggetto JSON");
{}
  }}
  public static void main(String[] args) throws Exception {{ System.setOut(new java.io.PrintStream(System.out, true, java.nio.charset.StandardCharsets.UTF_8)); System.out.println(JSON.writeValueAsString(execute(args.length > 0 ? args[0] : "list", JSON.readTree(args.length > 1 ? args[1] : "{{}}")))); }}
}}
"#,
            if mongo { mongobody } else { &sqlbody }
        ),
        &pairs,
    );
    let gradle=format!("plugins {{ application{} }}\nrepositories {{ mavenCentral() }}\ndependencies {{ implementation(\"{dependency}\"); implementation(\"com.fasterxml.jackson.core:jackson-databind:2.18.2\") }}\napplication {{ mainClass.set(\"{}\") }}\njava {{ toolchain {{ languageVersion.set(JavaLanguageVersion.of(21)) }} }}\n",if kotlin{"; kotlin(\"jvm\") version \"2.1.10\""}else{""},if kotlin{"MainKt"}else{"Database"});
    let files = vec![
        file("build.gradle.kts", gradle),
        file(
            "settings.gradle.kts",
            "rootProject.name = \"database-example\"\n",
        ),
    ];
    if kotlin {
        let _ = source;
        let kliteral = |s: &str| literal(s).replace('$', "\\$");
        let list = |values: &[String]| {
            format!(
                "listOf<String>({})",
                values
                    .iter()
                    .map(|s| kliteral(s))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let constants=format!("private val table = {}\nprivate val engine = {}\nprivate val query = {}\nprivate val insertSql = {}\nprivate val updateSql = {}\nprivate val deleteSql = {}\nprivate val filterJson = {}\nprivate val columns = {}\nprivate val keys = {}\nprivate val nonkeys = {}\n",kliteral(&ctx.req.table),kliteral(&ctx.req.engine),kliteral(&ctx.select),kliteral(&constants.insert),kliteral(&constants.update),kliteral(&constants.delete),kliteral(&ctx.filter.to_string()),list(&ctx.columns),list(&ctx.keys),list(&ctx.nonkeys));
        let body = if mongo {
            r#"
    com.mongodb.client.MongoClients.create(requireNotNull(System.getenv("DATABASE_URL")) { "Impostare DATABASE_URL" }).use { client ->
        val collection = client.getDatabase(System.getenv("DATABASE_NAME") ?: "database").getCollection(table)
        val document = org.bson.Document.parse(payload.toString())
        val settings = org.bson.json.JsonWriterSettings.builder().outputMode(org.bson.json.JsonMode.EXTENDED).build()
        return when(operation) {
            "list" -> collection.find(org.bson.Document.parse(filterJson)).limit(100).map { mapper.readTree(it.toJson(settings)) }.toList()
            "insert" -> { collection.insertOne(document); mapper.readTree(document.toJson(settings)) }
            "delete", "update" -> {
                require(document.containsKey("_id")) { "Manca _id" }
                val filter = org.bson.Document("_id", document.remove("_id"))
                if (operation == "delete") mapOf("deleted" to collection.deleteOne(filter).deletedCount)
                else { require(document.isNotEmpty()) { "Nessun campo da aggiornare" }; val result = collection.updateOne(filter, org.bson.Document("\$set", document)); mapOf("matched" to result.matchedCount, "modified" to result.modifiedCount) }
            }
            else -> error("Operazione sconosciuta")
        }
    }
"#.into()
        } else {
            format!(
                r#"
    val raw = System.getenv("DATABASE_URL") ?: if (engine == "sqlite") "./database.sqlite" else error("Impostare DATABASE_URL")
    val uri = if (engine == "sqlite") null else java.net.URI.create(raw)
    val auth = (uri?.rawUserInfo ?: "").split(":", limit = 2)
    val user = java.net.URLDecoder.decode(auth[0], java.nio.charset.StandardCharsets.UTF_8)
    val password = java.net.URLDecoder.decode(auth.getOrElse(1) {{ "" }}, java.nio.charset.StandardCharsets.UTF_8)
    val url = if (engine == "sqlite") "jdbc:sqlite:$raw" else "jdbc:${{if (engine == "postgresql") "postgresql" else "mariadb"}}://${{uri!!.host}}${{if (uri.port > 0) ":${{uri.port}}" else ""}}${{uri.rawPath}}"
    val (sql, fields) = when(operation) {{ "list" -> query to emptyList(); "insert" -> insertSql to columns; "update" -> updateSql to (nonkeys + keys); "delete" -> deleteSql to keys; else -> error("Operazione sconosciuta") }}
    require(sql.isNotEmpty()) {{ "Operazione non disponibile" }}
    java.sql.DriverManager.getConnection(url,user,password).use {{ connection ->
        connection.prepareStatement(sql).use {{ statement ->
            fields.forEachIndexed {{ index, name ->
                val value = requireNotNull(payload.get(name)) {{ "Campo mancante: $name" }}
                when {{ value.isNull -> statement.setObject(index+1,null); value.isBoolean -> statement.setBoolean(index+1,value.booleanValue()); value.isIntegralNumber -> statement.setLong(index+1,value.longValue()); value.isFloatingPointNumber -> statement.setBigDecimal(index+1,value.decimalValue()); engine == "postgresql" -> statement.setObject(index+1,if(value.isTextual) value.textValue() else value.toString(),java.sql.Types.OTHER); else -> statement.setString(index+1,if(value.isTextual) value.textValue() else value.toString()) }}
            }}
            if (!statement.execute()) return mapOf("affected" to statement.updateCount)
            statement.resultSet.use {{ rows ->
                val records = mutableListOf<Map<String,Any?>>()
                while (records.size < 100 && rows.next()) {{
                    val record = linkedMapOf<String,Any?>()
                    for (index in 1..rows.metaData.columnCount) {{
                        val value = rows.getObject(index)
                        record[rows.metaData.getColumnLabel(index)] = when(value) {{ is java.math.BigDecimal, is java.sql.Date, is java.sql.Time, is java.sql.Timestamp, is java.util.UUID -> value.toString(); else -> if(value?.javaClass?.name == "org.postgresql.util.PGobject") value.toString() else value }}
                    }}
                    records.add(record)
                }}
                return records
            }}
        }}
    }}
"#
            )
        };
        let source=format!("import com.fasterxml.jackson.databind.JsonNode\nimport com.fasterxml.jackson.databind.ObjectMapper\nprivate val mapper = ObjectMapper()\n{constants}\nfun execute(operation: String, payload: JsonNode): Any? {{\n    require(payload.isObject) {{ \"Payload deve essere oggetto JSON\" }}\n{body}\n}}\nfun main(args: Array<String>) {{ System.setOut(java.io.PrintStream(System.out, true, java.nio.charset.StandardCharsets.UTF_8)); println(mapper.writeValueAsString(execute(args.getOrElse(0) {{ \"list\" }}, mapper.readTree(args.getOrElse(1) {{ \"{{}}\" }})))) }}\n");
        Ok(Template{source,path:"src/main/kotlin/Main.kt".into(),files,command:"gradle run --args=list".into(),dependencies:format!("Kotlin JVM + JDBC ({dependency}) + Jackson; MongoDB riusa il driver JVM sincrono ufficiale.")})
    } else {
        Ok(Template {
            source,
            path: "src/main/java/Database.java".into(),
            files,
            command: "gradle run --args=list".into(),
            dependencies: format!("JDBC ({dependency}) + Jackson"),
        })
    }
}

pub(super) fn go(ctx: &Context) -> Result<Template, String> {
    let mongo = ctx.req.engine == "mongodb";
    let driver = match ctx.req.engine.as_str() {
        "sqlite" => "modernc.org/sqlite v1.34.5",
        "postgresql" => "github.com/jackc/pgx/v5 v5.7.2",
        "mongodb" => "go.mongodb.org/mongo-driver/v2 v2.0.0",
        _ => "github.com/go-sql-driver/mysql v1.8.1",
    };
    let import=match ctx.req.engine.as_str(){"sqlite"=>"_ \"modernc.org/sqlite\"","postgresql"=>"_ \"github.com/jackc/pgx/v5/stdlib\"","mongodb"=>"\"go.mongodb.org/mongo-driver/v2/bson\"; \"go.mongodb.org/mongo-driver/v2/mongo\"; \"go.mongodb.org/mongo-driver/v2/mongo/options\"",_=>"\"github.com/go-sql-driver/mysql\"; \"net/url\""};
    let connect=match ctx.req.engine.as_str(){"sqlite"=>"dsn := os.Getenv(\"DATABASE_URL\"); if dsn == \"\" { dsn = \"./database.sqlite\" }; connection, err := sql.Open(\"sqlite\", dsn)","postgresql"=>"connection, err := sql.Open(\"pgx\", os.Getenv(\"DATABASE_URL\"))",_=>r#"uri, err := url.Parse(os.Getenv("DATABASE_URL")); if err != nil { return nil, err }; config := mysql.NewConfig(); config.User = uri.User.Username(); config.Passwd, _ = uri.User.Password(); config.Net = "tcp"; config.Addr = uri.Host; if uri.Port() == "" { config.Addr += ":3306" }; config.DBName = strings.TrimPrefix(uri.Path, "/"); config.ParseTime = true; connection, err := sql.Open("mysql", config.FormatDSN())"#};
    let ctxp = ctx.placeholders(if ctx.req.engine == "postgresql" {
        "numbered"
    } else {
        "?"
    });
    let mut pairs = ctxp.pairs();
    for marker in ["@@COLUMNS@@", "@@KEYS@@", "@@NONKEYS@@"] {
        let values = match marker {
            "@@COLUMNS@@" => &ctx.columns,
            "@@KEYS@@" => &ctx.keys,
            _ => &ctx.nonkeys,
        };
        if let Some(p) = pairs.iter_mut().find(|p| p.0 == marker) {
            p.1 = format!(
                "[]string{{{}}}",
                values
                    .iter()
                    .map(|s| literal(s))
                    .collect::<Vec<_>>()
                    .join(",")
            );
        }
    }
    let body = if mongo {
        r#"
    client, err := mongo.Connect(options.Client().ApplyURI(os.Getenv("DATABASE_URL"))); if err != nil { return nil, err }; defer client.Disconnect(ctx)
    database := os.Getenv("DATABASE_NAME"); if database == "" { database = "database" }; collection := client.Database(database).Collection(table)
    raw, err := json.Marshal(payload); if err != nil { return nil, err }; var document bson.M; if err = bson.UnmarshalExtJSON(raw, false, &document); err != nil { return nil, err }
    switch operation {
    case "list":
        var filter bson.M; if err = bson.UnmarshalExtJSON([]byte(filterJSON), false, &filter); err != nil { return nil, err }
        cursor, err := collection.Find(ctx, filter, options.Find().SetLimit(100)); if err != nil { return nil, err }; defer cursor.Close(ctx)
        result := []json.RawMessage{}; for cursor.Next(ctx) { canonical, err := bson.MarshalExtJSON(cursor.Current, true, false); if err != nil { return nil, err }; result = append(result, json.RawMessage(canonical)) }; return result, cursor.Err()
    case "insert": result, err := collection.InsertOne(ctx, document); if err != nil { return nil, err }; canonical, err := bson.MarshalExtJSON(bson.M{"insertedId": result.InsertedID}, true, false); return json.RawMessage(canonical), err
    case "update", "delete":
        id, exists := document["_id"]; if !exists { return nil, fmt.Errorf("manca _id") }; filter := bson.M{"_id": id}; delete(document, "_id")
        if operation == "delete" { result, err := collection.DeleteOne(ctx, filter); if err != nil { return nil, err }; return map[string]any{"deleted": result.DeletedCount}, nil }
        if len(document) == 0 { return nil, fmt.Errorf("nessun campo da aggiornare") }; result, err := collection.UpdateOne(ctx, filter, bson.M{"$set": document}); if err != nil { return nil, err }; return map[string]any{"matched": result.MatchedCount,"modified":result.ModifiedCount}, nil
    default: return nil, fmt.Errorf("operazione sconosciuta")
    }
"#.into()
    } else {
        format!(
            r#"
    {connect}; if err != nil {{ return nil, err }}; defer connection.Close()
    if err = connection.PingContext(ctx); err != nil {{ return nil, err }}
    statement := query; fields := []string{{}}
    switch operation {{ case "list": case "insert": statement, fields = insertSQL, columns; case "update": statement, fields = updateSQL, append(append([]string{{}}, nonkeys...), keys...); case "delete": statement, fields = deleteSQL, keys; default: return nil, fmt.Errorf("operazione sconosciuta") }}
    if statement == "" {{ return nil, fmt.Errorf("operazione non disponibile") }}
    values := make([]any, len(fields)); for index, name := range fields {{ value, found := payload[name]; if !found {{ return nil, fmt.Errorf("campo mancante: %s", name) }}; switch v := value.(type) {{ case json.Number: if integer, err := v.Int64(); err == nil {{ value = integer }} else {{ value = v.String() }}; case map[string]any, []any: raw, err := json.Marshal(v); if err != nil {{ return nil, err }}; value = string(raw) }}; values[index] = value }}
    if operation != "list" {{ result, err := connection.ExecContext(ctx, statement, values...); if err != nil {{ return nil, err }}; count, err := result.RowsAffected(); return map[string]any{{"affected": count}}, err }}
    rows, err := connection.QueryContext(ctx, statement); if err != nil {{ return nil, err }}; defer rows.Close(); names, err := rows.Columns(); if err != nil {{ return nil, err }}
    records := []map[string]any{{}}; for len(records) < 100 && rows.Next() {{ values := make([]any, len(names)); refs := make([]any, len(names)); for index := range values {{ refs[index] = &values[index] }}; if err = rows.Scan(refs...); err != nil {{ return nil, err }}; record := map[string]any{{}}; for index, name := range names {{ if data, ok := values[index].([]byte); ok {{ record[name] = string(data) }} else {{ record[name] = values[index] }} }}; records = append(records, record) }}; return records, rows.Err()
"#
        )
    };
    let sqlimport = if mongo { "" } else { "\"database/sql\";" };
    let stringsimport = if matches!(ctx.req.engine.as_str(), "mysql" | "mariadb") {
        "\"strings\";"
    } else {
        ""
    };
    let source=substitute(&format!(r#"package main
import ({sqlimport} {stringsimport} "context"; "encoding/json"; "fmt"; "os"; "time"; {import})
const table = @@TABLE@@
const query = @@QUERY@@
const insertSQL = @@INSERT@@
const updateSQL = @@UPDATE@@
const deleteSQL = @@DELETE@@
const filterJSON = @@FILTER@@
var columns = @@COLUMNS@@
var keys = @@KEYS@@
var nonkeys = @@NONKEYS@@
func execute(operation string, payload map[string]any) (any, error) {{
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second); defer cancel()
{body}
}}
func main() {{ operation := "list"; if len(os.Args)>1 {{ operation = os.Args[1] }}; payload := map[string]any{{}}; if len(os.Args)>2 {{ decoder := json.NewDecoder(stringsReader(os.Args[2])); decoder.UseNumber(); if err := decoder.Decode(&payload); err != nil {{ panic(err) }} }}; result, err := execute(operation,payload); if err != nil {{ fmt.Fprintln(os.Stderr,err); os.Exit(1) }}; if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {{ panic(err) }} }}
type textReader struct {{ value string; offset int }}
func (reader *textReader) Read(buffer []byte) (int,error) {{ if reader.offset>=len(reader.value) {{ return 0,io.EOF }}; n:=copy(buffer,reader.value[reader.offset:]);reader.offset+=n;return n,nil }}
func stringsReader(value string) *textReader {{ return &textReader{{value:value}} }}
"#),&pairs).replace("\"context\";","\"context\"; \"io\";");
    Ok(Template {
        source,
        path: "main.go".into(),
        files: vec![file(
            "go.mod",
            format!("module database-example\n\ngo 1.23\n\nrequire {driver}\n"),
        )],
        command: "go mod tidy; go run . list".into(),
        dependencies: driver.into(),
    })
}

fn c(ctx: &Context) -> Result<Template, String> {
    super::rest::native_c(ctx)
}
