//! Explicit schema changes with stale-schema checks and engine-specific atomicity.
use crate::{
    database::{Handle, Session},
    models::SchemaSnapshot,
    remote, sqlite,
};
use mysql_async::prelude::Queryable;
use serde_json::Value;
use std::sync::Arc;

fn shape(schema: &SchemaSnapshot) -> Value {
    let mut schema = schema.clone();
    schema
        .tables
        .sort_by(|a, b| (&a.schema, &a.name).cmp(&(&b.schema, &b.name)));
    for table in &mut schema.tables {
        table.row_count = None;
        table.indexes.sort_by(|a, b| a.name.cmp(&b.name));
        table.foreign_keys.sort_by(|a, b| {
            (&a.column, &a.referenced_table, &a.referenced_column).cmp(&(
                &b.column,
                &b.referenced_table,
                &b.referenced_column,
            ))
        });
    }
    serde_json::to_value(schema).expect("serializable schema")
}
fn check_schema(expected: &SchemaSnapshot, actual: &SchemaSnapshot) -> Result<(), String> {
    if shape(expected) != shape(actual) {
        return Err("Lo schema del database è cambiato dopo l’anteprima. Aggiorna la struttura, rivedi il piano e conferma nuovamente.".into());
    }
    Ok(())
}
fn is_search_path(statement: &str) -> bool {
    statement
        .lines()
        .filter(|line| !line.trim_start().starts_with("--"))
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_end_matches(';')
        .eq_ignore_ascii_case("SET search_path TO public")
}
fn statements(script: &str, rebuild: bool) -> Result<Vec<String>, String> {
    if script.len() > 2 * 1024 * 1024 {
        return Err("Piano schema oltre il limite di 2 MiB.".into());
    }
    let statements = remote::split_sql(script)?;
    if statements.is_empty() || statements.len() > 2000 {
        return Err("Piano schema vuoto o con troppe istruzioni.".into());
    }
    for statement in &statements {
        let keyword = remote::first_keyword(statement);
        if !["CREATE", "ALTER", "DROP"].contains(&keyword.as_str())
            && !(rebuild && keyword == "INSERT")
            && !(keyword == "SET" && is_search_path(statement))
        {
            return Err(format!("Istruzione {keyword} non ammessa nel piano strutturale. Usa l’editor per SQL generico."));
        }
    }
    Ok(statements)
}

pub async fn apply(
    session: Arc<Session>,
    expected: SchemaSnapshot,
    script: String,
    rebuild_sqlite: bool,
) -> Result<SchemaSnapshot, String> {
    if session.profile.read_only {
        return Err("La connessione è in sola lettura.".into());
    }
    let _serial = session.serial.lock().await;
    if let Handle::Sqlite { conn, .. } = &session.handle {
        let conn = conn.clone();
        let database = session.profile.file_path.clone();
        let statements = statements(&script, rebuild_sqlite)?;
        return tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().map_err(|e| e.to_string())?;
            if !conn.is_autocommit() { return Err("Termina la transazione dell’editor prima di applicare il piano schema.".into()); }
            let foreign_keys: bool = conn.pragma_query_value(None,"foreign_keys", |row| row.get(0)).map_err(|e|e.to_string())?;
            let sequences: Vec<(String,i64)> = if rebuild_sqlite && conn.query_row("SELECT COUNT(*) FROM sqlite_schema WHERE name='sqlite_sequence'", [], |row| row.get::<_,i64>(0)).map_err(|e|e.to_string())? > 0 {
                conn.prepare("SELECT name,seq FROM sqlite_sequence").map_err(|e|e.to_string())?.query_map([], |row| Ok((row.get(0)?,row.get(1)?))).map_err(|e|e.to_string())?.collect::<Result<_,_>>().map_err(|e|e.to_string())?
            } else { Vec::new() };
            if rebuild_sqlite { conn.pragma_update(None,"foreign_keys",false).map_err(|e|e.to_string())?; }
            let result = (|| {
                let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
                check_schema(&expected,&sqlite::introspect(&tx,&database)?)?;
                for statement in statements { tx.execute_batch(&statement).map_err(|e| format!("Piano annullato: {e}"))?; }
                for (name, seq) in sequences { tx.execute("UPDATE sqlite_sequence SET seq=MAX(seq,?1) WHERE name=?2", rusqlite::params![seq,name]).map_err(|e|e.to_string())?; }
                let violations: i64 = tx.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check",[], |row|row.get(0)).map_err(|e|e.to_string())?;
                if violations > 0 { return Err(format!("Piano annullato: {violations} violazioni di chiave esterna. I dati originali sono conservati.")); }
                tx.commit().map_err(|e|e.to_string())?;
                sqlite::introspect(&conn,&database)
            })();
            let restored = conn.pragma_update(None,"foreign_keys",foreign_keys).map_err(|e|format!("Impossibile ripristinare foreign_keys: {e}"));
            restored?;
            result
        }).await.map_err(|e|e.to_string())?;
    }
    check_schema(&expected, &session.introspect_unlocked().await?)?;
    match &session.handle {
        Handle::Postgres { client, .. } => {
            let statements = statements(&script, false)?;
            // Probe with SAVEPOINT to avoid committing or rolling back an editor transaction.
            match client.batch_execute("SAVEPOINT dbm_schema_probe").await {
                Ok(()) => {
                    client
                        .batch_execute("RELEASE SAVEPOINT dbm_schema_probe")
                        .await
                        .map_err(|e| e.to_string())?;
                    return Err(
                        "Termina la transazione dell’editor prima di applicare il piano schema."
                            .into(),
                    );
                }
                Err(error) if error.code().is_some_and(|code| code.code() == "25P01") => {}
                Err(error) => {
                    return Err(format!(
                        "Verifica lo stato della transazione PostgreSQL prima del piano: {error}"
                    ))
                }
            }
            client
                .batch_execute("BEGIN")
                .await
                .map_err(|e| e.to_string())?;
            let outcome = async {
                client
                    .batch_execute("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
                    .await
                    .map_err(|e| e.to_string())?;
                let locks = expected
                    .tables
                    .iter()
                    .filter(|table| matches!(table.kind.as_str(), "table" | "partitioned table"))
                    .map(|table| {
                        format!(
                            "{}.{}",
                            crate::models::quote_ident(
                                "postgresql",
                                table.schema.as_deref().unwrap_or("public")
                            ),
                            crate::models::quote_ident("postgresql", &table.name)
                        )
                    })
                    .collect::<Vec<_>>();
                if !locks.is_empty() {
                    client
                        .batch_execute(&format!(
                            "LOCK TABLE {} IN ACCESS EXCLUSIVE MODE",
                            locks.join(",")
                        ))
                        .await
                        .map_err(|e| e.to_string())?;
                }
                check_schema(&expected, &session.introspect_unlocked().await?)?;
                for statement in statements {
                    let statement = if is_search_path(&statement) {
                        "SET LOCAL search_path TO public"
                    } else {
                        &statement
                    };
                    client
                        .batch_execute(statement)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                Ok::<_, String>(())
            }
            .await;
            if let Err(error) = outcome {
                let _ = client.batch_execute("ROLLBACK").await;
                return Err(format!("Piano annullato in transazione: {error}"));
            }
            client
                .batch_execute("COMMIT")
                .await
                .map_err(|e| e.to_string())?;
        }
        Handle::Mysql { conn, .. } => {
            let statements = statements(&script, false)?;
            let mut conn = conn.lock().await;
            conn.query_drop("DO 0").await.map_err(|e| e.to_string())?;
            let in_transaction = conn
                .last_ok_packet()
                .map(|packet| {
                    packet
                        .status_flags()
                        .contains(mysql_async::consts::StatusFlags::SERVER_STATUS_IN_TRANS)
                })
                .unwrap_or(false);
            if in_transaction {
                return Err("Termina la transazione dell’editor: il DDL MySQL/MariaDB può eseguire commit impliciti.".into());
            }
            for (index, statement) in statements.into_iter().enumerate() {
                conn.query_drop(statement).await.map_err(|e|format!("Piano interrotto dopo {index} istruzioni applicate; il DDL può essere già confermato. Aggiorna e verifica lo schema: {e}"))?;
            }
        }
        Handle::Mongo { db } => {
            let value: Value = serde_json::from_str(&script).map_err(|e| e.to_string())?;
            let commands = value.as_array().cloned().unwrap_or_else(|| vec![value]);
            if commands.is_empty() || commands.len() > 1000 {
                return Err("Numero di comandi strutturali non valido.".into());
            }
            for command in &commands {
                if !["create", "collMod", "createIndexes", "dropIndexes"]
                    .iter()
                    .any(|name| command.get(name).is_some())
                {
                    return Err("Comando MongoDB non ammesso nel piano strutturale.".into());
                }
            }
            for (index, command) in commands.into_iter().enumerate() {
                let document: mongodb::bson::Document =
                    serde_json::from_value(command).map_err(|e| e.to_string())?;
                let result = db.run_command(document).await.map_err(|e|format!("Piano interrotto dopo {index} comandi; aggiorna lo schema prima di riprovare: {e}"))?;
                if let Some(error) = result.get("writeErrors") {
                    return Err(format!("Errore nel piano dopo {index} comandi: {error}"));
                }
            }
        }
        Handle::Sqlite { .. } => unreachable!(),
    }
    session.introspect_unlocked().await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plan_rejects_transaction_control_and_unreviewed_data_writes() {
        for sql in [
            "BEGIN; CREATE TABLE x(id INT)",
            "COMMIT",
            "DELETE FROM x",
            "PRAGMA foreign_keys=OFF",
            "ATTACH 'external' AS x",
        ] {
            assert!(statements(sql, false).is_err());
        }
        assert!(statements(
            "CREATE TABLE x(id INT); ALTER TABLE x ADD COLUMN name TEXT;",
            false
        )
        .is_ok());
        assert!(statements("INSERT INTO temp SELECT * FROM old", true).is_ok());
        assert!(statements("-- Project header\n-- Review schema\nSET search_path TO public; CREATE TABLE x(id INT)",false).is_ok());
    }
}
