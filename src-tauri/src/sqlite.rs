use crate::models::*;
use base64::Engine;
use rusqlite::fallible_iterator::FallibleIterator;
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    types::{Value as SqlValue, ValueRef},
    Connection, OpenFlags,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, Instant},
};

pub const MAX_ROWS: usize = 10_000;
pub fn open(profile: &ConnectionProfile) -> Result<Connection, String> {
    if profile.file_path.trim().is_empty() {
        return Err("Seleziona un file SQLite.".into());
    }
    let flags = if profile.read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE
    };
    let conn = Connection::open_with_flags(&profile.file_path, flags).map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| e.to_string())?;
    if profile.laboratory {
        protect_lab(&conn)
    }
    Ok(conn)
}
pub fn protect_lab(conn: &Connection) {
    conn.authorizer(Some(|ctx: AuthContext<'_>| match ctx.action {
        AuthAction::Attach { .. } | AuthAction::Detach { .. } => Authorization::Deny,
        AuthAction::Function { function_name }
            if [
                "load_extension",
                "readfile",
                "writefile",
                "eval",
                "fts3_tokenizer",
            ]
            .contains(&function_name.to_ascii_lowercase().as_str()) =>
        {
            Authorization::Deny
        }
        AuthAction::Pragma { pragma_name, .. }
            if [
                "writable_schema",
                "temp_store_directory",
                "data_store_directory",
                "journal_mode",
            ]
            .contains(&pragma_name.to_ascii_lowercase().as_str()) =>
        {
            Authorization::Deny
        }
        _ => Authorization::Allow,
    }));
    let _ = conn.set_limit(
        rusqlite::limits::Limit::SQLITE_LIMIT_LENGTH,
        16 * 1024 * 1024,
    );
    let _ = conn.set_limit(rusqlite::limits::Limit::SQLITE_LIMIT_ATTACHED, 0);
}
pub fn from_ref(v: ValueRef<'_>) -> CellValue {
    match v {
        ValueRef::Null => CellValue::null(),
        ValueRef::Integer(n) => CellValue::string("integer", n),
        ValueRef::Real(n) => CellValue::string("float", n),
        ValueRef::Text(t) => CellValue::string("text", String::from_utf8_lossy(t)),
        ValueRef::Blob(b) => CellValue::string(
            "binary",
            base64::engine::general_purpose::STANDARD.encode(b),
        ),
    }
}
pub fn to_value(v: &CellValue) -> Result<SqlValue, String> {
    Ok(match v.kind.as_str() {
        "null" => SqlValue::Null,
        "integer" => SqlValue::Integer(v.text().parse().map_err(|_| "Intero non valido")?),
        "float" => SqlValue::Real(v.text().parse().map_err(|_| "Numero non valido")?),
        "boolean" => SqlValue::Integer(
            if v.value == Some(Value::Bool(true)) || v.text() == "true" {
                1
            } else {
                0
            },
        ),
        "binary" => SqlValue::Blob(
            base64::engine::general_purpose::STANDARD
                .decode(v.text())
                .map_err(|e| e.to_string())?,
        ),
        _ => SqlValue::Text(v.text()),
    })
}
fn json_sql(v: &Value) -> Result<SqlValue, String> {
    if v.get("type").is_some() {
        return to_value(&serde_json::from_value(v.clone()).map_err(|e| e.to_string())?);
    }
    Ok(match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(*b as i64),
        Value::Number(n) if n.is_i64() => SqlValue::Integer(n.as_i64().unwrap()),
        Value::Number(n) => SqlValue::Real(n.as_f64().ok_or("Numero non valido")?),
        Value::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Text(v.to_string()),
    })
}

pub fn execute(
    conn: &Connection,
    query: &str,
    parameters: &BTreeMap<String, Value>,
    read_only: bool,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let deadline = Instant::now() + Duration::from_secs(60);
    conn.progress_handler(10_000, Some(move || Instant::now() > deadline));
    let result = (|| {
        let mut out = QueryResult::default();
        let mut total_rows = 0;
        let mut batch = rusqlite::Batch::new(conn, query);
        while let Some(mut stmt) = batch.next().map_err(|e| e.to_string())? {
            if read_only && !stmt.readonly() {
                return Err("La connessione è in sola lettura.".into());
            }
            for index in 1..=stmt.parameter_count() {
                let key = stmt
                    .parameter_name(index)
                    .map(|s| s.trim_start_matches([':', '@', '$', '?']))
                    .unwrap_or("");
                let value = parameters
                    .get(key)
                    .or_else(|| parameters.get(&index.to_string()))
                    .ok_or_else(|| {
                        format!(
                            "Parametro mancante: {}",
                            if key.is_empty() {
                                index.to_string()
                            } else {
                                key.to_owned()
                            }
                        )
                    })?;
                stmt.raw_bind_parameter(index, json_sql(value)?)
                    .map_err(|e| e.to_string())?;
            }
            if stmt.column_count() == 0 {
                out.affected_rows += stmt.raw_execute().map_err(|e| e.to_string())? as u64;
                continue;
            }
            let mut set = ResultSet::default();
            set.columns = stmt
                .columns()
                .iter()
                .map(|c| column(c.name(), c.decl_type().unwrap_or("")))
                .collect();
            unique_column_names(&mut set.columns);
            let read_query = stmt.readonly();
            let mut rows = stmt.raw_query();
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                if total_rows >= MAX_ROWS {
                    set.truncated = true;
                    if read_query {
                        break;
                    } else {
                        continue;
                    }
                }
                total_rows += 1;
                let mut record = BTreeMap::new();
                for (i, col) in set.columns.iter_mut().enumerate() {
                    let cell = from_ref(row.get_ref(i).map_err(|e| e.to_string())?);
                    if col.data_type.is_empty() {
                        col.data_type = cell.kind.to_uppercase()
                    }
                    record.insert(col.name.clone(), cell);
                }
                set.rows.push(record);
            }
            out.sets.push(set);
        }
        out.elapsed_ms = start.elapsed().as_millis() as u64;
        out.message = format!(
            "{} righe restituite · {} modifiche",
            out.sets.iter().map(|s| s.rows.len()).sum::<usize>(),
            out.affected_rows
        );
        Ok(out)
    })();
    conn.progress_handler(0, None::<fn() -> bool>);
    result
}
pub fn introspect(conn: &Connection, database: &str) -> Result<SchemaSnapshot, String> {
    let mut tables = Vec::new();
    let mut q=conn.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') ORDER BY type,name").map_err(|e|e.to_string())?;
    let objects = q
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (name, kind, definition) in objects {
        let quoted = quote_ident("sqlite", &name);
        let mut cols = conn
            .prepare(&format!("PRAGMA table_info({quoted})"))
            .map_err(|e| e.to_string())?;
        let mut columns: Vec<ColumnInfo> = cols
            .query_map([], |r| {
                Ok(ColumnInfo {
                    name: r.get(1)?,
                    data_type: r.get(2)?,
                    nullable: r.get::<_, i64>(3)? == 0,
                    default_value: r.get(4)?,
                    primary_key: r.get::<_, i64>(5)? > 0,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if columns.iter().filter(|c| c.primary_key).count() == 1 {
            for c in &mut columns {
                if c.primary_key && c.data_type.eq_ignore_ascii_case("INTEGER") {
                    c.nullable = false;
                }
            }
        }
        let mut indexes = Vec::new();
        if kind == "table" {
            let mut iq = conn
                .prepare(&format!("PRAGMA index_list({quoted})"))
                .map_err(|e| e.to_string())?;
            let idx = iq
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)? != 0,
                        r.get::<_, i64>(4)? != 0,
                    ))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            for (n, unique, partial) in idx {
                let mut c = conn
                    .prepare(&format!("PRAGMA index_info({})", quote_ident("sqlite", &n)))
                    .map_err(|e| e.to_string())?;
                let names = c
                    .query_map([], |r| r.get::<_, Option<String>>(2))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .flatten()
                    .collect();
                indexes.push(IndexInfo {
                    name: n,
                    unique,
                    partial,
                    columns: names,
                });
            }
        }
        let mut fq = conn
            .prepare(&format!("PRAGMA foreign_key_list({quoted})"))
            .map_err(|e| e.to_string())?;
        let foreign_keys = fq
            .query_map([], |r| {
                Ok(ForeignKeyInfo {
                    referenced_table: r.get(2)?,
                    column: r.get(3)?,
                    referenced_column: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        tables.push(TableInfo {
            name,
            schema: None,
            kind,
            columns,
            indexes,
            foreign_keys,
            row_count: None,
            definition,
        });
    }
    Ok(SchemaSnapshot {
        database: database.into(),
        engine: "sqlite".into(),
        tables,
    })
}
pub fn apply(
    conn: &mut Connection,
    table: &str,
    changes: &[DataChange],
) -> Result<QueryResult, String> {
    let schema = introspect(conn, "")?;
    let metadata = schema
        .tables
        .iter()
        .find(|t| t.name == table && t.kind == "table")
        .ok_or("Tabella non trovata")?;
    let keys = metadata
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
    if keys.is_empty() && changes.iter().any(|c| c.kind != "insert") {
        return Err("La tabella non ha una chiave primaria stabile.".into());
    }
    let allowed = metadata
        .columns
        .iter()
        .map(|c| c.name.as_str())
        .collect::<Vec<_>>();
    let started = Instant::now();
    let tx = conn.savepoint().map_err(|e| e.to_string())?;
    let mut affected = 0;
    for change in changes {
        if change
            .values
            .keys()
            .chain(change.original.keys())
            .chain(change.key.keys())
            .any(|k| !allowed.contains(&k.as_str()))
        {
            return Err("Colonna non presente nello schema.".into());
        }
        let mut values = Vec::new();
        let sql;
        if change.kind == "insert" {
            if change.values.is_empty() {
                sql = format!(
                    "INSERT INTO {} DEFAULT VALUES",
                    quote_ident("sqlite", table)
                );
            } else {
                let names = change
                    .values
                    .keys()
                    .map(|n| quote_ident("sqlite", n))
                    .collect::<Vec<_>>()
                    .join(",");
                for v in change.values.values() {
                    values.push(to_value(v)?)
                }
                sql = format!(
                    "INSERT INTO {} ({names}) VALUES ({})",
                    quote_ident("sqlite", table),
                    vec!["?"; values.len()].join(",")
                );
            }
        } else {
            if keys.iter().any(|k| !change.key.contains_key(k)) {
                return Err("Chiave primaria incompleta.".into());
            }
            let prefix = if change.kind == "delete" {
                format!("DELETE FROM {}", quote_ident("sqlite", table))
            } else if change.kind == "update" {
                if change.values.is_empty() {
                    continue;
                }
                for v in change.values.values() {
                    values.push(to_value(v)?)
                }
                format!(
                    "UPDATE {} SET {}",
                    quote_ident("sqlite", table),
                    change
                        .values
                        .keys()
                        .map(|n| format!("{} = ?", quote_ident("sqlite", n)))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            } else {
                return Err("Operazione sconosciuta".into());
            };
            let mut predicates = Vec::new();
            for (name, v) in change.key.iter().chain(change.original.iter()) {
                predicates.push(format!("{} IS ?", quote_ident("sqlite", name)));
                values.push(to_value(v)?)
            }
            sql = format!("{prefix} WHERE {}", predicates.join(" AND "));
        }
        let count = tx
            .execute(&sql, rusqlite::params_from_iter(values))
            .map_err(|e| e.to_string())?;
        if change.kind != "insert" && count != 1 {
            return Err("Conflitto: il record è stato modificato o eliminato. Ricarica i dati prima di applicare.".into());
        }
        affected += count as u64;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(QueryResult {
        affected_rows: affected,
        elapsed_ms: started.elapsed().as_millis() as u64,
        message: format!("{affected} modifiche applicate"),
        ..Default::default()
    })
}
pub fn export_file(
    conn: &Connection,
    table: &str,
    path: &Path,
    format: &str,
    limit: Option<u64>,
) -> Result<u64, String> {
    let mut stmt = conn
        .prepare(&format!("SELECT * FROM {}", quote_ident("sqlite", table)))
        .map_err(|e| e.to_string())?;
    let names = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect::<Vec<_>>();
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut count = 0;
    if format == "csv" {
        let mut writer = csv::Writer::from_writer(file);
        writer.write_record(&names).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if limit.is_some_and(|n| count >= n) {
                break;
            }
            let values = (0..names.len())
                .map(|i| {
                    row.get_ref(i).map(from_ref).map(|c| {
                        if c.kind == "null" {
                            "\\N".into()
                        } else {
                            c.text()
                        }
                    })
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            writer.write_record(values).map_err(|e| e.to_string())?;
            count += 1
        }
        writer.flush().map_err(|e| e.to_string())?;
    } else {
        use std::io::Write;
        let mut writer = std::io::BufWriter::new(file);
        writer.write_all(b"[\n").map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            if limit.is_some_and(|n| count >= n) {
                break;
            }
            let mut obj = BTreeMap::new();
            for (i, n) in names.iter().enumerate() {
                obj.insert(
                    n.clone(),
                    from_ref(row.get_ref(i).map_err(|e| e.to_string())?),
                );
            }
            if count > 0 {
                writer.write_all(b",\n").map_err(|e| e.to_string())?
            }
            serde_json::to_writer(&mut writer, &obj).map_err(|e| e.to_string())?;
            count += 1
        }
        writer.write_all(b"\n]\n").map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(count)
}

/// Same-engine SQL dump. Values are rendered from SQLite storage classes, never
/// through JSON numbers, and schema SQL comes from sqlite_schema.
pub fn export_sql(conn: &Connection, table: Option<&str>, path: &Path) -> Result<u64, String> {
    use std::io::Write;
    let mut query=conn.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END,name").map_err(|e|e.to_string())?;
    let schema = query
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    if let Some(name) = table {
        if !schema
            .iter()
            .any(|(kind, n, _, _)| n == name && (kind == "table" || kind == "view"))
        {
            return Err("Tabella o vista non trovata".into());
        }
    }
    if schema.iter().any(|(kind, name, _, ddl)| {
        kind == "table"
            && table.is_none_or(|t| t == name)
            && ddl.to_uppercase().starts_with("CREATE VIRTUAL TABLE")
    }) {
        return Err("Per database con tabelle virtuali usa il backup SQLite, che conserva anche lo stato delle estensioni.".into());
    }
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut writer = std::io::BufWriter::new(file);
    writeln!(writer,"-- Database Manager · SQLite · schema e valori originali\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;").map_err(|e|e.to_string())?;
    let mut count = 0;
    for (kind, name, _, ddl) in &schema {
        if kind != "table" || table.is_some_and(|n| n != name) {
            continue;
        }
        writeln!(writer, "{};", ddl.trim_end_matches(';')).map_err(|e| e.to_string())?;
        let quoted = quote_ident("sqlite", name);
        let mut info = conn
            .prepare(&format!("PRAGMA table_xinfo({quoted})"))
            .map_err(|e| e.to_string())?;
        let columns = info
            .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, i64>(6)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|(_, hidden)| *hidden == 0)
            .map(|(n, _)| n)
            .collect::<Vec<_>>();
        if columns.is_empty() {
            continue;
        }
        let column_list = columns
            .iter()
            .map(|n| quote_ident("sqlite", n))
            .collect::<Vec<_>>()
            .join(",");
        let mut select = conn
            .prepare(&format!("SELECT {column_list} FROM {quoted}"))
            .map_err(|e| e.to_string())?;
        let mut rows = select.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let values = (0..columns.len())
                .map(|i| row.get_ref(i).map(sql_literal))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            writeln!(
                writer,
                "INSERT INTO {quoted} ({column_list}) VALUES ({});",
                values.join(",")
            )
            .map_err(|e| e.to_string())?;
            count += 1;
        }
    }
    for (kind, name, parent, ddl) in &schema {
        if kind == "table" {
            continue;
        }
        if table.is_some_and(|n| n != name && n != parent) {
            continue;
        }
        writeln!(writer, "{};", ddl.trim_end_matches(';')).map_err(|e| e.to_string())?;
    }
    if conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE name='sqlite_sequence'",
            [],
            |r| r.get::<_, u64>(0),
        )
        .map_err(|e| e.to_string())?
        > 0
    {
        let mut seq = conn
            .prepare("SELECT name,seq FROM sqlite_sequence")
            .map_err(|e| e.to_string())?;
        let mut rows = seq.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let name: String = row.get(0).map_err(|e| e.to_string())?;
            if table.is_some_and(|t| t != name) {
                continue;
            }
            let id = sql_literal(row.get_ref(1).map_err(|e| e.to_string())?);
            let literal = format!("'{}'", name.replace('\'', "''"));
            writeln!(writer,"DELETE FROM sqlite_sequence WHERE name={literal};\nINSERT INTO sqlite_sequence(name,seq)VALUES({literal},{id});").map_err(|e|e.to_string())?;
        }
    }
    writeln!(writer, "COMMIT;\nPRAGMA foreign_keys=ON;").map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(count)
}
fn sql_literal(v: ValueRef<'_>) -> String {
    match v {
        ValueRef::Null => "NULL".into(),
        ValueRef::Integer(n) => n.to_string(),
        ValueRef::Real(n) if n.is_infinite() => if n.is_sign_negative() {
            "-9e999"
        } else {
            "9e999"
        }
        .into(),
        ValueRef::Real(n) => n.to_string(),
        ValueRef::Blob(b) => format!("X'{}'", hex::encode(b)),
        ValueRef::Text(b) if b.contains(&0) || std::str::from_utf8(b).is_err() => {
            format!("CAST(X'{}' AS TEXT)", hex::encode(b))
        }
        ValueRef::Text(b) => format!("'{}'", String::from_utf8_lossy(b).replace('\'', "''")),
    }
}

pub fn import_sql_file(conn: &Connection, path: &Path) -> Result<QueryResult, String> {
    use std::io::BufRead;
    if !conn.is_autocommit() {
        return Err(
            "Chiudi la transazione dell'editor con COMMIT o ROLLBACK prima dell'importazione."
                .into(),
        );
    }
    let started = Instant::now();
    let before = conn.total_changes();
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut buffer = String::new();
    let mut statements = 0;
    let outcome = (|| {
        for (line_no, line) in std::io::BufReader::new(file).lines().enumerate() {
            let line = line.map_err(|e| e.to_string())?;
            buffer.push_str(if line_no == 0 {
                line.trim_start_matches('\u{feff}')
            } else {
                &line
            });
            buffer.push('\n');
            if buffer.len() > 64 * 1024 * 1024 {
                return Err(
                    "Un'istruzione SQL supera 64 MiB. Usa il ripristino nativo SQLite.".into(),
                );
            }
            let sql = std::ffi::CString::new(buffer.as_bytes())
                .map_err(|_| "Lo script contiene un byte NUL non valido")?;
            // SAFETY: CString supplies an owned, NUL-terminated UTF-8 SQL buffer.
            if unsafe { rusqlite::ffi::sqlite3_complete(sql.as_ptr()) } != 0 {
                conn.execute_batch(&buffer)
                    .map_err(|e| format!("Riga {}: {e}", line_no + 1))?;
                buffer.clear();
                statements += 1;
            }
        }
        if !buffer.trim().is_empty() {
            conn.execute_batch(&buffer).map_err(|e| e.to_string())?;
            statements += 1;
        }
        Ok::<_, String>(())
    })();
    if let Err(error) = outcome {
        if !conn.is_autocommit() {
            let _ = conn.execute_batch("ROLLBACK");
        }
        return Err(error);
    }
    Ok(QueryResult {
        affected_rows: conn.total_changes().saturating_sub(before),
        elapsed_ms: started.elapsed().as_millis() as u64,
        message: format!(
            "Script SQL importato: {statements} blocchi{}",
            if conn.is_autocommit() {
                ""
            } else {
                " · Transazione aperta: concludi con COMMIT o ROLLBACK nell'editor"
            }
        ),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scripts_keep_semicolons_and_precision() {
        let c = Connection::open_in_memory().unwrap();
        let r=execute(&c,"CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT); INSERT INTO t VALUES(9007199254740993,'Udine; città'); SELECT * FROM t;",&BTreeMap::new(),false).unwrap();
        assert_eq!(r.sets[0].rows[0]["id"].text(), "9007199254740993");
        assert_eq!(r.sets[0].rows[0]["v"].text(), "Udine; città");
    }
    #[test]
    fn conflicts_rollback_entire_changeset() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(
            "CREATE TABLE t(id INTEGER PRIMARY KEY,v TEXT);INSERT INTO t VALUES(1,'new');",
        )
        .unwrap();
        let mut key = BTreeMap::new();
        key.insert("id".into(), CellValue::string("integer", 1));
        let mut orig = BTreeMap::new();
        orig.insert("v".into(), CellValue::string("text", "old"));
        let mut values = BTreeMap::new();
        values.insert("v".into(), CellValue::string("text", "lost"));
        assert!(apply(
            &mut c,
            "t",
            &[DataChange {
                kind: "update".into(),
                key,
                original: orig,
                values
            }]
        )
        .unwrap_err()
        .contains("Conflitto"));
        assert_eq!(
            c.query_row("SELECT v FROM t", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "new"
        );
    }
    #[test]
    fn lab_denies_external_files() {
        let c = Connection::open_in_memory().unwrap();
        protect_lab(&c);
        assert!(c
            .execute_batch("ATTACH DATABASE ':memory:' AS outsider")
            .is_err());
        assert!(c.execute_batch("VACUUM INTO 'outside.sqlite'").is_err());
        assert!(c.execute_batch("PRAGMA writable_schema=ON").is_err());
        c.execute_batch("CREATE TABLE safe(id INTEGER);INSERT INTO safe VALUES(1);")
            .unwrap();
    }
    #[test]
    fn readonly_prevents_writable_cte_and_pragma() {
        let c = Connection::open_in_memory().unwrap();
        assert!(execute(&c, "CREATE TABLE no(id)", &BTreeMap::new(), true).is_err());
    }
    #[test]
    fn missing_parameters_do_not_execute() {
        let c = Connection::open_in_memory().unwrap();
        assert!(execute(&c, "SELECT :missing", &BTreeMap::new(), false).is_err());
    }
    #[test]
    fn integer_rowid_primary_key_is_not_nullable() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY,label TEXT);")
            .unwrap();
        let schema = introspect(&c, "").unwrap();
        assert!(schema.tables[0].columns[0].primary_key);
        assert!(!schema.tables[0].columns[0].nullable);
    }
    #[test]
    fn introspection_distinguishes_partial_unique_indexes_from_parent_keys() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY, code TEXT, active INTEGER); CREATE UNIQUE INDEX partial_code ON parent(code) WHERE active=1; CREATE UNIQUE INDEX complete_id_code ON parent(id,code); CREATE INDEX regular_active ON parent(active);").unwrap();
        let schema = introspect(&connection, "metadata-test").unwrap();
        let parent = schema.tables.iter().find(|t| t.name == "parent").unwrap();
        let partial = parent
            .indexes
            .iter()
            .find(|i| i.name == "partial_code")
            .unwrap();
        assert!(partial.unique);
        assert!(partial.partial);
        assert_eq!(partial.columns, vec!["code"]);
        let full = parent
            .indexes
            .iter()
            .find(|i| i.name == "complete_id_code")
            .unwrap();
        assert!(full.unique);
        assert!(!full.partial);
        let ordinary = parent
            .indexes
            .iter()
            .find(|i| i.name == "regular_active")
            .unwrap();
        assert!(!ordinary.unique);
        assert!(!ordinary.partial);
        // SQLite accepts the DDL but rejects use of an FK whose only parent-key
        // uniqueness comes from a partial index. The metadata must expose this.
        connection
            .execute_batch("CREATE TABLE child(code TEXT REFERENCES parent(code));")
            .unwrap();
        assert!(connection
            .execute("INSERT INTO child(code) VALUES('outside-filter')", [])
            .unwrap_err()
            .to_string()
            .contains("foreign key mismatch"));
    }
    #[test]
    fn duplicate_query_columns_keep_both_values() {
        let c = Connection::open_in_memory().unwrap();
        let r = execute(&c, "SELECT 1 AS id, 2 AS id", &BTreeMap::new(), true).unwrap();
        let row = &r.sets[0].rows[0];
        assert_eq!(row["id"].text(), "1");
        assert_eq!(row["id (2)"].text(), "2");
    }
    #[test]
    fn sql_dump_restores_schema_types_data_and_generated_columns() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT,payload BLOB,derived TEXT GENERATED ALWAYS AS(label||'!') VIRTUAL);CREATE INDEX ix_t ON t(label);INSERT INTO t(id,label,payload)VALUES(9007199254740993,'Udine; città',X'0001FF');CREATE VIEW labels AS SELECT label FROM t;").unwrap();
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("dump.sql");
        assert_eq!(export_sql(&c, None, &path).unwrap(), 1);
        let target = Connection::open_in_memory().unwrap();
        import_sql_file(&target, &path).unwrap();
        assert_eq!(
            target
                .query_row("SELECT id FROM t", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            9007199254740993
        );
        assert_eq!(
            target
                .query_row("SELECT payload FROM t", [], |r| r.get::<_, Vec<u8>>(0))
                .unwrap(),
            vec![0, 1, 255]
        );
        assert_eq!(
            target
                .query_row("SELECT derived FROM t", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "Udine; città!"
        );
        assert_eq!(
            target
                .query_row("SELECT COUNT(*) FROM labels", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            target
                .query_row("SELECT seq FROM sqlite_sequence WHERE name='t'", [], |r| {
                    r.get::<_, i64>(0)
                })
                .unwrap(),
            9007199254740993
        );
    }
}
