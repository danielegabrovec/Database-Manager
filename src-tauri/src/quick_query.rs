use crate::{
    database::{Handle, Session},
    lab,
    models::{ConnectionProfile, QueryResult, SchemaSnapshot},
    sqlite,
};
use rusqlite::{
    backup::{Backup, StepResult},
    config::DbConfig,
    Connection, InterruptHandle,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const MAX_DATABASE_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Synthetic,
    SqliteCopy,
}

pub(crate) struct QuickQuery {
    pub(crate) profile: ConnectionProfile,
    dataset: String,
    mode: Mode,
    baseline: Mutex<Connection>,
    connection: Mutex<Connection>,
    interrupt: Mutex<InterruptHandle>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Opened<'a> {
    session_id: &'a str,
    profile: &'a ConnectionProfile,
    schema: SchemaSnapshot,
    dataset: &'a str,
    mode: Mode,
}

impl QuickQuery {
    pub(crate) async fn open(
        dataset: String,
        source: Option<Arc<Session>>,
    ) -> Result<Arc<Self>, String> {
        let source_handle = match source.as_ref().map(|source| &source.handle) {
            Some(Handle::Sqlite { conn, .. }) => Some(conn.clone()),
            Some(_) => {
                return Err(
                    "Per la simulazione puoi copiare soltanto una connessione SQLite.".into(),
                )
            }
            None => None,
        };
        let _source_guard = match source.as_ref() {
            Some(source) => Some(source.serial.lock().await),
            None => None,
        };
        let source_name = source.as_ref().map(|source| source.profile.name.clone());
        tokio::task::spawn_blocking(move || {
            let mode = if source_handle.is_some() {
                Mode::SqliteCopy
            } else {
                Mode::Synthetic
            };
            let mut baseline = Connection::open_in_memory().map_err(|e| e.to_string())?;
            if let Some(source_handle) = source_handle {
                let source = source_handle.lock().map_err(|e| e.to_string())?;
                if !source.is_autocommit() {
                    return Err("Concludi la transazione dell’editor prima di copiare il database nella simulazione.".into());
                }
                copy_main(&source, &mut baseline)?;
            } else {
                lab::seed(&baseline, &dataset)?;
            }
            let mut connection = Connection::open_in_memory().map_err(|e| e.to_string())?;
            copy_main(&baseline, &mut connection)?;
            configure(&connection)?;
            let interrupt = connection.get_interrupt_handle();
            let profile = ConnectionProfile {
                id: format!("quick-{}", uuid::Uuid::new_v4()),
                name: match mode {
                    Mode::Synthetic => format!("Simulazione · {dataset}"),
                    Mode::SqliteCopy => source_name.map_or_else(
                        || "Copia SQLite".to_owned(),
                        |name| format!("Copia · {name}"),
                    ),
                },
                database: if matches!(mode, Mode::Synthetic) {
                    dataset.clone()
                } else {
                    "Copia SQLite".into()
                },
                file_path: ":memory:".into(),
                environment: "Simulazione".into(),
                laboratory: true,
                ..Default::default()
            };
            Ok(Arc::new(Self {
                profile,
                dataset,
                mode,
                baseline: Mutex::new(baseline),
                connection: Mutex::new(connection),
                interrupt: Mutex::new(interrupt),
            }))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub(crate) fn opened(&self, schema: SchemaSnapshot) -> Opened<'_> {
        Opened {
            session_id: &self.profile.id,
            profile: &self.profile,
            schema,
            dataset: &self.dataset,
            mode: self.mode,
        }
    }

    pub(crate) async fn execute(
        self: Arc<Self>,
        query: String,
        parameters: BTreeMap<String, Value>,
    ) -> Result<QueryResult, String> {
        if query.trim().is_empty() {
            return Err("Scrivi una query da simulare.".into());
        }
        if query.len() > 1024 * 1024 {
            return Err("La query di simulazione supera 1 MiB.".into());
        }
        tokio::task::spawn_blocking(move || {
            let connection = self
                .connection
                .try_lock()
                .map_err(|_| "Attendi la conclusione della simulazione in corso.")?;
            sqlite::execute(&connection, &query, &parameters, false)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub(crate) async fn schema(self: Arc<Self>) -> Result<SchemaSnapshot, String> {
        tokio::task::spawn_blocking(move || {
            let connection = self
                .connection
                .try_lock()
                .map_err(|_| "Attendi la conclusione della simulazione in corso.")?;
            sqlite::introspect(&connection, &self.profile.database)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub(crate) async fn reset(self: Arc<Self>) -> Result<SchemaSnapshot, String> {
        tokio::task::spawn_blocking(move || {
            let mut connection = self
                .connection
                .try_lock()
                .map_err(|_| "Attendi la conclusione della simulazione in corso.")?;
            let baseline = self.baseline.lock().map_err(|e| e.to_string())?;
            // Replacing the connection also clears user-created TEMP objects and PRAGMA changes.
            let mut clean = Connection::open_in_memory().map_err(|e| e.to_string())?;
            copy_main(&baseline, &mut clean)?;
            configure(&clean)?;
            let schema = sqlite::introspect(&clean, &self.profile.database)?;
            let mut interrupt = self.interrupt.lock().map_err(|e| e.to_string())?;
            *interrupt = clean.get_interrupt_handle();
            *connection = clean;
            Ok(schema)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub(crate) fn cancel(&self) -> Result<(), String> {
        self.interrupt
            .lock()
            .map_err(|e| e.to_string())?
            .interrupt();
        Ok(())
    }
}

fn configure(conn: &Connection) -> Result<(), String> {
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(|e| e.to_string())?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)
        .map_err(|e| e.to_string())?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)
        .map_err(|e| e.to_string())?;
    let size: u64 = conn
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    conn.pragma_update(None, "max_page_count", MAX_DATABASE_BYTES / size)
        .map_err(|e| e.to_string())?;
    sqlite::protect_quick_query(conn);
    Ok(())
}

fn copy_main(source: &Connection, target: &mut Connection) -> Result<(), String> {
    let page_count: u64 = source
        .pragma_query_value(None, "page_count", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let page_size: u64 = source
        .pragma_query_value(None, "page_size", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if page_count.saturating_mul(page_size) > MAX_DATABASE_BYTES {
        return Err("La copia in memoria è disponibile per database SQLite fino a 128 MiB.".into());
    }
    target.pragma_update(None, "page_size", page_size).map_err(|e| e.to_string())?;
    let backup = Backup::new(source, target).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = backup.step(128).map_err(|e| e.to_string())?;
        if backup.progress().pagecount.max(0) as u64 * page_size > MAX_DATABASE_BYTES {
            return Err("Il database è cresciuto oltre il limite della copia in memoria.".into());
        }
        if status == StepResult::Done {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Copia SQLite non completata entro il tempo previsto. Riprova quando il database è disponibile.".into());
        }
        if matches!(status, StepResult::Busy | StepResult::Locked) {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
