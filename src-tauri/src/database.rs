use crate::{models::*, remote, sqlite};
use futures_util::TryStreamExt;
use mysql_async::prelude::Queryable;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::Mutex as AsyncMutex;

pub enum Handle {
    Sqlite {
        conn: Arc<Mutex<rusqlite::Connection>>,
        interrupt: Arc<rusqlite::InterruptHandle>,
    },
    Postgres {
        client: tokio_postgres::Client,
        cancel: tokio_postgres::CancelToken,
    },
    Mysql {
        conn: AsyncMutex<mysql_async::Conn>,
        opts: mysql_async::Opts,
        id: u32,
    },
    Mongo {
        db: mongodb::Database,
    },
}
pub struct Session {
    pub profile: ConnectionProfile,
    pub transport: ConnectionProfile,
    pub handle: Handle,
    pub serial: AsyncMutex<()>,
    active_mongo_job: Mutex<Option<String>>,
    _tunnel: Option<tokio::process::Child>,
}
struct MongoJobGuard<'a>(&'a Mutex<Option<String>>);
impl Drop for MongoJobGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.0.lock() {
            *active = None;
        }
    }
}
pub fn tls_connector(
    p: &ConnectionProfile,
) -> Result<postgres_native_tls::MakeTlsConnector, String> {
    let mut builder = native_tls::TlsConnector::builder();
    if !p.ca_path.is_empty() {
        let pem = std::fs::read(&p.ca_path).map_err(|e| e.to_string())?;
        builder.add_root_certificate(
            native_tls::Certificate::from_pem(&pem).map_err(|e| e.to_string())?,
        );
    }
    Ok(postgres_native_tls::MakeTlsConnector::new(
        builder.build().map_err(|e| e.to_string())?,
    ))
}
fn pg_config(p: &ConnectionProfile, password: &str) -> tokio_postgres::Config {
    let mut cfg = tokio_postgres::Config::new();
    cfg.host(&p.host)
        .port(if p.port == 0 { 5432 } else { p.port })
        .dbname(&p.database)
        .user(&p.username)
        .password(password)
        .connect_timeout(Duration::from_secs(10));
    cfg
}
async fn ssh_tunnel(
    p: &ConnectionProfile,
) -> Result<(ConnectionProfile, Option<tokio::process::Child>), String> {
    let Some(ssh) = p.ssh.as_ref().filter(|s| s.enabled) else {
        return Ok((p.clone(), None));
    };
    if ssh.host.is_empty() || ssh.username.is_empty() {
        return Err("Specifica host e utente SSH.".into());
    }
    if [&ssh.host, &p.host].iter().any(|s| {
        s.starts_with('-')
            || !s
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || ".-:".contains(c))
    }) {
        return Err("Host SSH/database non valido.".into());
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    drop(listener);
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.args([
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-L",
        &format!("127.0.0.1:{port}:{}:{}", p.host, p.port),
        "-p",
        &if ssh.port == 0 {
            "22".into()
        } else {
            ssh.port.to_string()
        },
        "-l",
        &ssh.username,
    ]);
    if !ssh.key_path.is_empty() {
        cmd.arg("-i").arg(&ssh.key_path);
    }
    cmd.arg(&ssh.host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("OpenSSH non disponibile: {e}"))?;
    for _ in 0..50 {
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "Tunnel SSH non avviato ({exit}). Verifica chiave e host conosciuti con OpenSSH."
            ));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            let mut local = p.clone();
            local.host = "127.0.0.1".into();
            local.port = port;
            return Ok((local, Some(child)));
        }
        tokio::time::sleep(Duration::from_millis(100)).await
    }
    Err("Timeout apertura tunnel SSH.".into())
}
impl Session {
    pub async fn open(profile: ConnectionProfile, password: String) -> Result<Self, String> {
        let (p, tunnel) = ssh_tunnel(&profile).await?;
        let handle = match p.engine.as_str() {
            "sqlite" => {
                let copy = p.clone();
                let conn = tokio::task::spawn_blocking(move || sqlite::open(&copy))
                    .await
                    .map_err(|e| e.to_string())??;
                let interrupt = Arc::new(conn.get_interrupt_handle());
                Handle::Sqlite {
                    conn: Arc::new(Mutex::new(conn)),
                    interrupt,
                }
            }
            "postgresql" => {
                let cfg = pg_config(&p, &password);
                let client = if p.tls {
                    let (c, connection) = cfg
                        .connect(tls_connector(&p)?)
                        .await
                        .map_err(|e| e.to_string())?;
                    tokio::spawn(async move {
                        let _ = connection.await;
                    });
                    c
                } else {
                    let (c, connection) = cfg
                        .connect(tokio_postgres::NoTls)
                        .await
                        .map_err(|e| e.to_string())?;
                    tokio::spawn(async move {
                        let _ = connection.await;
                    });
                    c
                };
                let cancel = client.cancel_token();
                if p.read_only {
                    client
                        .batch_execute("SET default_transaction_read_only=on")
                        .await
                        .map_err(|e| e.to_string())?
                }
                Handle::Postgres { client, cancel }
            }
            "mysql" | "mariadb" => {
                let mut b = mysql_async::OptsBuilder::default()
                    .ip_or_hostname(&p.host)
                    .tcp_port(if p.port == 0 { 3306 } else { p.port })
                    .db_name(Some(&p.database))
                    .user(Some(&p.username))
                    .pass(Some(password));
                if p.tls {
                    let mut ssl = mysql_async::SslOpts::default();
                    if !p.ca_path.is_empty() {
                        ssl =
                            ssl.with_root_certs(vec![std::path::PathBuf::from(&p.ca_path).into()]);
                    }
                    b = b.ssl_opts(Some(ssl));
                }
                let opts = mysql_async::Opts::from(b);
                let mut conn = mysql_async::Conn::new(opts.clone())
                    .await
                    .map_err(|e| e.to_string())?;
                if p.read_only {
                    conn.query_drop("SET SESSION TRANSACTION READ ONLY")
                        .await
                        .map_err(|e| e.to_string())?
                }
                let id = conn.id();
                Handle::Mysql {
                    conn: AsyncMutex::new(conn),
                    opts,
                    id,
                }
            }
            "mongodb" => {
                let mut url = url::Url::parse(&format!(
                    "mongodb://{}:{}/",
                    p.host,
                    if p.port == 0 { 27017 } else { p.port }
                ))
                .map_err(|e| e.to_string())?;
                if !p.username.is_empty() {
                    url.set_username(&p.username)
                        .map_err(|_| "Utente non valido")?;
                    url.set_password(Some(&password))
                        .map_err(|_| "Password non valida")?;
                }
                url.query_pairs_mut().append_pair(
                    "authSource",
                    if p.laboratory { &p.database } else { "admin" },
                );
                if p.laboratory {
                    url.query_pairs_mut()
                        .append_pair("directConnection", "true");
                }
                let mut options = mongodb::options::ClientOptions::parse(url.as_str())
                    .await
                    .map_err(|e| e.to_string())?;
                options.server_selection_timeout = Some(Duration::from_secs(10));
                if p.tls {
                    options.tls = Some(mongodb::options::Tls::Enabled(
                        mongodb::options::TlsOptions::builder()
                            .ca_file_path(if p.ca_path.is_empty() {
                                None
                            } else {
                                Some(std::path::PathBuf::from(&p.ca_path))
                            })
                            .build(),
                    ));
                }
                let client = mongodb::Client::with_options(options).map_err(|e| e.to_string())?;
                let db = client.database(&p.database);
                db.run_command(mongodb::bson::doc! {"ping":1})
                    .await
                    .map_err(|e| e.to_string())?;
                Handle::Mongo { db }
            }
            _ => return Err("Motore non supportato.".into()),
        };
        Ok(Self {
            profile,
            transport: p,
            handle,
            serial: AsyncMutex::new(()),
            active_mongo_job: Mutex::new(None),
            _tunnel: tunnel,
        })
    }
    pub async fn execute(
        &self,
        query: &str,
        parameters: BTreeMap<String, Value>,
    ) -> Result<QueryResult, String> {
        let _lock = self.serial.lock().await;
        let start = Instant::now();
        let mongo_job = if matches!(self.handle, Handle::Mongo { .. }) {
            Some(format!("dbm-{}", uuid::Uuid::new_v4()))
        } else {
            None
        };
        if let Some(job) = &mongo_job {
            *self.active_mongo_job.lock().map_err(|e| e.to_string())? = Some(job.clone());
        }
        let _mongo_job_guard = MongoJobGuard(&self.active_mongo_job);
        if self.profile.read_only
            && !matches!(self.handle, Handle::Sqlite { .. } | Handle::Mongo { .. })
        {
            for stmt in remote::split_sql(query)? {
                let normalized = remote::first_keyword(&stmt);
                if !["SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "DESC"]
                    .contains(&normalized.as_str())
                {
                    return Err(
                        "Questa istruzione non è disponibile nella connessione in sola lettura."
                            .into(),
                    );
                }
            }
        }
        let work = async {
            match &self.handle {
                Handle::Sqlite { conn, .. } => {
                    let conn = conn.clone();
                    let query = query.to_owned();
                    let ro = self.profile.read_only;
                    tokio::task::spawn_blocking(move || {
                        sqlite::execute(
                            &*conn.lock().map_err(|e| e.to_string())?,
                            &query,
                            &parameters,
                            ro,
                        )
                    })
                    .await
                    .map_err(|e| e.to_string())?
                }
                Handle::Postgres { client, .. } => {
                    if self.profile.read_only {
                        client
                            .batch_execute("BEGIN READ ONLY")
                            .await
                            .map_err(|e| e.to_string())?;
                        let result = remote::postgres_query(client, query, &parameters).await;
                        let rollback = client
                            .batch_execute("ROLLBACK")
                            .await
                            .map_err(|e| e.to_string());
                        rollback?;
                        return result;
                    }
                    remote::postgres_query(client, query, &parameters).await
                }
                Handle::Mysql { conn, .. } => {
                    let mut c = conn.lock().await;
                    if self.profile.read_only {
                        c.query_drop("START TRANSACTION READ ONLY")
                            .await
                            .map_err(|e| e.to_string())?;
                        let result = remote::mysql_query(&mut c, query, &parameters).await;
                        let rollback = c.query_drop("ROLLBACK").await.map_err(|e| e.to_string());
                        rollback?;
                        return result;
                    }
                    remote::mysql_query(&mut c, query, &parameters).await
                }
                Handle::Mongo { db } => {
                    remote::mongo_query(db, query, self.profile.read_only, mongo_job.as_deref())
                        .await
                }
            }
        };
        let mut result = match tokio::time::timeout(Duration::from_secs(60), work).await {
            Ok(r) => r?,
            Err(_) => {
                let _ = self.cancel().await;
                return Err("Timeout dopo 60 secondi: interruzione richiesta. Verifica l'esito di eventuali scritture.".into());
            }
        };
        result.elapsed_ms = start.elapsed().as_millis() as u64;
        if result.message.is_empty() {
            result.message = format!(
                "{} righe · {} modifiche",
                result.sets.iter().map(|s| s.rows.len()).sum::<usize>(),
                result.affected_rows
            )
        }
        Ok(result)
    }
    pub async fn cancel(&self) -> Result<String, String> {
        match &self.handle {
            Handle::Sqlite { interrupt, .. } => {
                interrupt.interrupt();
                Ok("Interruzione richiesta a SQLite".into())
            }
            Handle::Postgres { cancel, .. } => {
                if self.profile.tls {
                    cancel.cancel_query(tls_connector(&self.profile)?).await
                } else {
                    cancel.cancel_query(tokio_postgres::NoTls).await
                }
                .map_err(|e| e.to_string())?;
                Ok("Interruzione richiesta a PostgreSQL".into())
            }
            Handle::Mysql { opts, id, .. } => {
                let mut control = mysql_async::Conn::new(opts.clone())
                    .await
                    .map_err(|e| e.to_string())?;
                control
                    .query_drop(format!("KILL QUERY {id}"))
                    .await
                    .map_err(|e| e.to_string())?;
                let _ = control.disconnect().await;
                Ok("Interruzione richiesta al server".into())
            }
            Handle::Mongo { db } => {
                let job = self
                    .active_mongo_job
                    .lock()
                    .map_err(|e| e.to_string())?
                    .clone()
                    .ok_or("Nessuna operazione MongoDB dell'editor è attiva.")?;
                Ok(crate::mongo_cancel::cancel(db, &job).await?.message)
            }
        }
    }
    pub async fn introspect(&self) -> Result<SchemaSnapshot, String> {
        if let Handle::Sqlite { conn, .. } = &self.handle {
            let c = conn.clone();
            let database = self.profile.file_path.clone();
            return tokio::task::spawn_blocking(move || {
                sqlite::introspect(&*c.lock().map_err(|e| e.to_string())?, &database)
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        if let Handle::Mongo { db } = &self.handle {
            let mut tables = Vec::new();
            for name in db
                .list_collection_names()
                .await
                .map_err(|e| e.to_string())?
            {
                let coll = db.collection::<mongodb::bson::Document>(&name);
                let mut columns = BTreeMap::new();
                let mut cursor = coll
                    .find(mongodb::bson::doc! {})
                    .limit(20)
                    .await
                    .map_err(|e| e.to_string())?;
                while let Some(doc) = cursor.try_next().await.map_err(|e| e.to_string())? {
                    for (k, v) in doc {
                        columns.entry(k.clone()).or_insert_with(|| {
                            let mut c = column(&k, format!("{:?}", v.element_type()));
                            c.primary_key = k == "_id";
                            c.nullable = k != "_id";
                            c
                        });
                    }
                }
                let mut indexes = Vec::new();
                let mut cursor = coll.list_indexes().await.map_err(|e| e.to_string())?;
                while let Some(i) = cursor.try_next().await.map_err(|e| e.to_string())? {
                    let options = i.options.unwrap_or_default();
                    indexes.push(IndexInfo {
                        name: options.name.unwrap_or_default(),
                        columns: i.keys.keys().cloned().collect(),
                        unique: options.unique.unwrap_or(false),
                        partial: options.partial_filter_expression.is_some(),
                    });
                }
                tables.push(TableInfo {
                    name,
                    kind: "collection (schema campionato: max 20 documenti)".into(),
                    columns: columns.into_values().collect(),
                    indexes,
                    ..Default::default()
                });
            }
            return Ok(SchemaSnapshot {
                database: self.profile.database.clone(),
                engine: self.profile.engine.clone(),
                tables,
            });
        }
        let pg = self.profile.engine == "postgresql";
        let sql = if pg {
            "SELECT table_schema AS schema,table_name AS name,table_type AS kind FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema,table_name"
        } else {
            "SELECT table_schema AS `schema`,table_name AS name,table_type AS kind FROM information_schema.tables WHERE table_schema=DATABASE() ORDER BY table_name"
        };
        let objects = self.execute(sql, BTreeMap::new()).await?;
        let mut tables = Vec::new();
        for row in objects
            .sets
            .first()
            .map(|s| s.rows.clone())
            .unwrap_or_default()
        {
            let name = row.get("name").map(|v| v.text()).unwrap_or_default();
            let schema = row.get("schema").map(|v| v.text()).unwrap_or_default();
            let escaped = name.replace('\'', "''");
            let ns = schema.replace('\'', "''");
            let colsql = if pg {
                format!("SELECT c.column_name AS name,c.data_type,c.is_nullable,c.column_default AS default_value,EXISTS(SELECT 1 FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage k ON tc.constraint_name=k.constraint_name AND tc.constraint_schema=k.constraint_schema WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema AND tc.table_name=c.table_name AND k.column_name=c.column_name) AS pk FROM information_schema.columns c WHERE c.table_schema='{ns}' AND c.table_name='{escaped}' ORDER BY c.ordinal_position")
            } else {
                format!("SELECT column_name AS name,column_type AS data_type,is_nullable AS is_nullable,column_default AS default_value,column_key AS pk FROM information_schema.columns WHERE table_schema='{ns}' AND table_name='{escaped}' ORDER BY ordinal_position")
            };
            let cr = self.execute(&colsql, BTreeMap::new()).await?;
            let columns = cr
                .sets
                .first()
                .map(|s| {
                    s.rows
                        .iter()
                        .map(|r| ColumnInfo {
                            name: r["name"].text(),
                            data_type: r["data_type"].text(),
                            nullable: r["is_nullable"].text() == "YES",
                            primary_key: if pg {
                                r["pk"].text() == "true"
                            } else {
                                r["pk"].text() == "PRI"
                            },
                            default_value: if r["default_value"].kind == "null" {
                                None
                            } else {
                                Some(r["default_value"].text())
                            },
                        })
                        .collect()
                })
                .unwrap_or_default();
            let fk_sql = if pg {
                format!("SELECT kcu.column_name AS col,ccu.table_name AS ref_table,ccu.column_name AS ref_col FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name AND tc.constraint_schema=kcu.constraint_schema JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='{ns}' AND tc.table_name='{escaped}'")
            } else {
                format!("SELECT column_name AS col,referenced_table_name AS ref_table,referenced_column_name AS ref_col FROM information_schema.key_column_usage WHERE table_schema='{ns}' AND table_name='{escaped}' AND referenced_table_name IS NOT NULL")
            };
            let fk = self.execute(&fk_sql, BTreeMap::new()).await?;
            let foreign_keys = fk
                .sets
                .first()
                .map(|s| {
                    s.rows
                        .iter()
                        .map(|r| ForeignKeyInfo {
                            column: r["col"].text(),
                            referenced_table: r["ref_table"].text(),
                            referenced_column: r["ref_col"].text(),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let index_sql = if pg {
                format!("SELECT ic.relname AS name,ix.indisunique AS unique_flag,(ix.indpred IS NOT NULL) AS partial_flag,pg_get_indexdef(ix.indexrelid,k.position,true) AS col FROM pg_class tc JOIN pg_namespace n ON n.oid=tc.relnamespace JOIN pg_index ix ON ix.indrelid=tc.oid JOIN pg_class ic ON ic.oid=ix.indexrelid CROSS JOIN LATERAL generate_series(1,ix.indnkeyatts) AS k(position) WHERE tc.relname='{escaped}' AND n.nspname='{ns}' ORDER BY ic.relname,k.position")
            } else {
                format!("SELECT index_name AS name,non_unique AS non_unique,column_name AS col FROM information_schema.statistics WHERE table_schema='{ns}' AND table_name='{escaped}' ORDER BY index_name,seq_in_index")
            };
            let ir = self.execute(&index_sql, BTreeMap::new()).await?;
            let mut indexes: BTreeMap<String, IndexInfo> = BTreeMap::new();
            if let Some(set) = ir.sets.first() {
                for r in &set.rows {
                    let name = r.get("name").map(CellValue::text).unwrap_or_default();
                    let unique = if pg {
                        r.get("unique_flag").map(CellValue::text).as_deref() == Some("true")
                    } else {
                        r.get("non_unique").map(CellValue::text).as_deref() == Some("0")
                    };
                    let item = indexes.entry(name.clone()).or_insert(IndexInfo {
                        name,
                        columns: Vec::new(),
                        unique,
                        partial: pg
                            && r.get("partial_flag").map(CellValue::text).as_deref()
                                == Some("true"),
                    });
                    item.columns
                        .push(r.get("col").map(CellValue::text).unwrap_or_default());
                }
            }
            tables.push(TableInfo {
                name,
                schema: Some(schema),
                kind: if row["kind"].text().contains("VIEW") {
                    "view"
                } else {
                    "table"
                }
                .into(),
                columns,
                foreign_keys,
                indexes: indexes.into_values().collect(),
                ..Default::default()
            });
        }
        let extras = if pg {
            "SELECT n.nspname AS schema,p.proname AS name,CASE WHEN p.prokind='p' THEN 'procedure' ELSE 'function' END AS kind,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f','p') UNION ALL SELECT n.nspname AS schema,t.tgname AS name,'trigger' AS kind,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')"
        } else {
            "SELECT routine_schema AS `schema`,routine_name AS name,LOWER(routine_type) AS kind,routine_definition AS definition FROM information_schema.routines WHERE routine_schema=DATABASE() UNION ALL SELECT trigger_schema AS `schema`,trigger_name AS name,'trigger' AS kind,action_statement AS definition FROM information_schema.triggers WHERE trigger_schema=DATABASE()"
        };
        let extras = self.execute(extras, BTreeMap::new()).await?;
        if let Some(set) = extras.sets.first() {
            for row in &set.rows {
                tables.push(TableInfo {
                    name: row.get("name").map(CellValue::text).unwrap_or_default(),
                    schema: row.get("schema").map(CellValue::text),
                    kind: row.get("kind").map(CellValue::text).unwrap_or_default(),
                    definition: row
                        .get("definition")
                        .filter(|c| c.kind != "null")
                        .map(CellValue::text),
                    ..Default::default()
                });
            }
        }
        Ok(SchemaSnapshot {
            database: self.profile.database.clone(),
            engine: self.profile.engine.clone(),
            tables,
        })
    }
    pub async fn apply(
        &self,
        table: &str,
        changes: Vec<DataChange>,
    ) -> Result<QueryResult, String> {
        if self.profile.read_only {
            return Err("Connessione in sola lettura".into());
        }
        if let Handle::Sqlite { conn, .. } = &self.handle {
            let c = conn.clone();
            let t = table.to_owned();
            return tokio::task::spawn_blocking(move || {
                sqlite::apply(&mut *c.lock().map_err(|e| e.to_string())?, &t, &changes)
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        if let Handle::Mongo { db } = &self.handle {
            let _guard = self.serial.lock().await;
            return crate::mongo_edit::apply(db, table, changes).await;
        }
        let metadata = self.introspect().await?;
        let name = table.rsplit('.').next().unwrap_or(table);
        let meta = metadata
            .tables
            .iter()
            .find(|t| t.name == name)
            .ok_or("Tabella sconosciuta")?;
        let keys = meta
            .columns
            .iter()
            .filter(|c| c.primary_key)
            .map(|c| c.name.clone())
            .collect::<Vec<_>>();
        if keys.is_empty() && changes.iter().any(|c| c.kind != "insert") {
            return Err("Tabella senza chiave primaria.".into());
        }
        let mut statements = Vec::new();
        for change in changes {
            let mut params = BTreeMap::new();
            let mut i = 0;
            let bind = |v: &CellValue, p: &mut BTreeMap<String, Value>, i: &mut usize| {
                *i += 1;
                let key = if self.profile.engine == "postgresql" {
                    i.to_string()
                } else {
                    format!("p{i}")
                };
                p.insert(key.clone(), serde_json::to_value(v).unwrap());
                if self.profile.engine == "postgresql" {
                    format!("${key}")
                } else {
                    format!(":{key}")
                }
            };
            let q = |n: &str| quote_ident(&self.profile.engine, n);
            if change
                .values
                .keys()
                .chain(change.original.keys())
                .chain(change.key.keys())
                .any(|k| !meta.columns.iter().any(|c| &c.name == k))
            {
                return Err("Colonna non riconosciuta".into());
            }
            let qualified = meta
                .schema
                .as_ref()
                .map(|s| format!("{}.{}", q(s), q(name)))
                .unwrap_or_else(|| q(name));
            let sql = if change.kind == "insert" {
                if change.values.is_empty() {
                    return Err("Inserisci almeno un valore".into());
                }
                let columns = change
                    .values
                    .keys()
                    .map(|n| q(n))
                    .collect::<Vec<_>>()
                    .join(",");
                let values = change
                    .values
                    .values()
                    .map(|v| bind(v, &mut params, &mut i))
                    .collect::<Vec<_>>()
                    .join(",");
                format!("INSERT INTO {qualified} ({columns}) VALUES ({values})")
            } else {
                if keys.iter().any(|k| !change.key.contains_key(k)) {
                    return Err("Chiave incompleta".into());
                }
                let head = if change.kind == "delete" {
                    format!("DELETE FROM {qualified}")
                } else {
                    format!(
                        "UPDATE {qualified} SET {}",
                        change
                            .values
                            .iter()
                            .map(|(k, v)| format!("{}={}", q(k), bind(v, &mut params, &mut i)))
                            .collect::<Vec<_>>()
                            .join(",")
                    )
                };
                let conditions = change
                    .key
                    .iter()
                    .chain(change.original.iter())
                    .map(|(k, v)| {
                        let op = if self.profile.engine == "postgresql" {
                            "IS NOT DISTINCT FROM"
                        } else {
                            "<=>"
                        };
                        format!("{} {op} {}", q(k), bind(v, &mut params, &mut i))
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");
                format!("{head} WHERE {conditions}")
            };
            statements.push((sql, params, change.kind));
        }
        // Hold the session serial lock across the whole transaction so queries cannot interleave.
        let _guard = self.serial.lock().await;
        let start = Instant::now();
        let mut out = QueryResult::default();
        match &self.handle {
            Handle::Postgres { client, .. } => {
                let nested = match client.batch_execute("SAVEPOINT dbm_grid_apply").await {
                    Ok(()) => true,
                    Err(e) if e.code().map(|c| c.code()) == Some("25P01") => {
                        client
                            .batch_execute("BEGIN")
                            .await
                            .map_err(|e| e.to_string())?;
                        false
                    }
                    Err(e) => return Err(e.to_string()),
                };
                for (sql, p, kind) in statements {
                    match remote::postgres_query(client, &sql, &p).await {
                        Ok(r) if kind == "insert" || r.affected_rows == 1 => {
                            out.affected_rows += r.affected_rows
                        }
                        other => {
                            let _=client.batch_execute(if nested{"ROLLBACK TO SAVEPOINT dbm_grid_apply; RELEASE SAVEPOINT dbm_grid_apply"}else{"ROLLBACK"}).await;
                            return Err(other.err().unwrap_or(
                                "Conflitto: record modificato da un altro utente".into(),
                            ));
                        }
                    }
                }
                client
                    .batch_execute(if nested {
                        "RELEASE SAVEPOINT dbm_grid_apply"
                    } else {
                        "COMMIT"
                    })
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Handle::Mysql { conn, .. } => {
                let mut conn = conn.lock().await;
                let nested = conn
                    .last_ok_packet()
                    .map(|p| {
                        p.status_flags()
                            .contains(mysql_async::consts::StatusFlags::SERVER_STATUS_IN_TRANS)
                    })
                    .unwrap_or(false);
                conn.query_drop(if nested {
                    "SAVEPOINT dbm_grid_apply"
                } else {
                    "START TRANSACTION"
                })
                .await
                .map_err(|e| e.to_string())?;
                for (sql, p, kind) in statements {
                    match remote::mysql_query(&mut conn, &sql, &p).await {
                        Ok(r) if kind == "insert" || r.affected_rows == 1 => {
                            out.affected_rows += r.affected_rows
                        }
                        other => {
                            let _ = conn
                                .query_drop(if nested {
                                    "ROLLBACK TO SAVEPOINT dbm_grid_apply"
                                } else {
                                    "ROLLBACK"
                                })
                                .await;
                            if nested {
                                let _ = conn.query_drop("RELEASE SAVEPOINT dbm_grid_apply").await;
                            }
                            return Err(other.err().unwrap_or(
                                "Conflitto: record modificato da un altro utente".into(),
                            ));
                        }
                    }
                }
                conn.query_drop(if nested {
                    "RELEASE SAVEPOINT dbm_grid_apply"
                } else {
                    "COMMIT"
                })
                .await
                .map_err(|e| e.to_string())?;
            }
            _ => unreachable!(),
        }
        out.elapsed_ms = start.elapsed().as_millis() as u64;
        out.message = format!("{} modifiche applicate", out.affected_rows);
        Ok(out)
    }
}
