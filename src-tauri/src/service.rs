use crate::{
    assistant, codegen,
    database::{Handle, Session},
    environment, lab,
    models::*,
    sqlite,
    store::{engines, Store},
    tools,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    sync::Arc,
    time::Instant,
};
use tokio::sync::RwLock;

pub struct AppState {
    pub root: PathBuf,
    pub store: Store,
    pub sessions: RwLock<HashMap<String, Arc<Session>>>,
    pub environments: environment::EnvironmentManager,
}
fn arg<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}
fn decode<T: serde::de::DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| e.to_string())
}
fn encode(v: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}
fn secret_entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("DatabaseManager", id).map_err(|e| e.to_string())
}
fn password(id: &str) -> String {
    secret_entry(id)
        .and_then(|e| e.get_password().map_err(|e| e.to_string()))
        .unwrap_or_default()
}
fn set_password(id: &str, value: &str) -> Result<(), String> {
    secret_entry(id)?
        .set_password(value)
        .map_err(|e| format!("Archivio credenziali Windows: {e}"))
}
pub fn default_data_dir() -> PathBuf {
    std::env::var_os("DBM_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join("DatabaseManager")
        })
}
impl AppState {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let store = Store::new(&root.join("workspace.sqlite"))?;
        let environments = environment::EnvironmentManager::new(root.clone())?;
        Ok(Self {
            root,
            store,
            sessions: RwLock::new(HashMap::new()),
            environments,
        })
    }
    pub async fn session(&self, id: &str) -> Result<Arc<Session>, String> {
        self.sessions
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or("Apri una connessione o un laboratorio per iniziare.".into())
    }
    async fn add_session(
        &self,
        id: String,
        profile: ConnectionProfile,
        secret: String,
    ) -> Result<SchemaSnapshot, String> {
        let s = Arc::new(Session::open(profile, secret).await?);
        let schema = s.introspect().await?;
        self.sessions.write().await.insert(id, s);
        Ok(schema)
    }
    pub async fn call(&self, command: &str, args: Value) -> Result<Value, String> {
        match command {
            "bootstrap" => Ok(
                json!({"profiles":self.store.profiles()?,"savedQueries":self.store.saved()?,"history":self.store.history()?,"settings":self.store.settings()?,"engines":engines()}),
            ),
            "save_profile" => {
                let mut p: ConnectionProfile =
                    decode(args.get("profile").cloned().ok_or("Profilo mancante")?)?;
                if p.id.is_empty() {
                    p.id = uuid::Uuid::new_v4().to_string()
                }
                if p.name.trim().is_empty() {
                    return Err("Assegna un nome alla connessione".into());
                }
                if !["sqlite", "postgresql", "mysql", "mariadb", "mongodb"]
                    .contains(&p.engine.as_str())
                {
                    return Err("Motore non supportato".into());
                }
                if p.laboratory {
                    return Err(
                        "I profili laboratorio vengono creati esclusivamente dal gestore ambienti."
                            .into(),
                    );
                }
                if let Some(secret) = args
                    .get("password")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                {
                    set_password(&p.id, secret)?;
                }
                self.store.save_profile(&p)?;
                encode(p)
            }
            "delete_profile" => {
                let id = arg(&args, "id");
                self.store.delete_profile(id)?;
                let _ =
                    secret_entry(id).and_then(|e| e.delete_credential().map_err(|e| e.to_string()));
                Ok(json!(true))
            }
            "test_connection" => {
                let p: ConnectionProfile =
                    decode(args.get("profile").cloned().ok_or("Profilo mancante")?)?;
                let secret = args
                    .get("password")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .unwrap_or_else(|| password(&p.id));
                tokio::time::timeout(std::time::Duration::from_secs(20), Session::open(p, secret))
                    .await
                    .map_err(|_| "Timeout connessione")??;
                Ok(json!("Connessione riuscita"))
            }
            "open_session" => {
                let p = self.store.profile(arg(&args, "profileId"))?;
                let secret = password(&p.id);
                let id = arg(&args, "sessionId");
                if id.is_empty() {
                    return Err("Identificatore sessione mancante".into());
                }
                encode(self.add_session(id.into(), p, secret).await?)
            }
            "close_session" => {
                self.sessions.write().await.remove(arg(&args, "sessionId"));
                Ok(json!(true))
            }
            "introspect" => encode(
                self.session(arg(&args, "sessionId"))
                    .await?
                    .introspect()
                    .await?,
            ),
            "execute_query" => {
                let s = self.session(arg(&args, "sessionId")).await?;
                let query = arg(&args, "query");
                if query.trim().is_empty() {
                    return Err("Scrivi una query prima di eseguire.".into());
                }
                if query.len() > 4 * 1024 * 1024 {
                    return Err("Lo script supera 4 MiB; usa l'importazione da file.".into());
                }
                let params = decode(args.get("parameters").cloned().unwrap_or(json!({})))?;
                let start = Instant::now();
                let result = s.execute(query, params).await;
                let h = HistoryEntry {
                    id: uuid::Uuid::new_v4().to_string(),
                    query: query.into(),
                    engine: s.profile.engine.clone(),
                    profile_name: s.profile.name.clone(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    success: result.is_ok(),
                    error: result.as_ref().err().cloned(),
                };
                self.store.record(&h)?;
                encode(result?)
            }
            "cancel_query" => encode(
                self.session(arg(&args, "sessionId"))
                    .await?
                    .cancel()
                    .await?,
            ),
            "read_table" => {
                let s = self.session(arg(&args, "sessionId")).await?;
                let table = arg(&args, "table");
                let schema = s.introspect().await?;
                let metadata = schema
                    .tables
                    .iter()
                    .find(|t| {
                        t.name == table
                            || format!("{}.{}", t.schema.as_deref().unwrap_or(""), t.name) == table
                    })
                    .ok_or("Oggetto non trovato")?;
                let limit = args["limit"].as_u64().unwrap_or(200).clamp(1, 1000);
                let offset = args["offset"].as_u64().unwrap_or(0);
                let mut out = if s.profile.engine == "mongodb" {
                    let filter = if arg(&args, "filter").trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str::<Value>(arg(&args, "filter"))
                            .map_err(|e| e.to_string())?
                    };
                    s.execute(&json!({"find":metadata.name,"filter":filter,"limit":limit as i64,"skip":offset as i64,"batchSize":limit as i64,"maxTimeMS":30000}).to_string(),BTreeMap::new()).await?
                } else {
                    let q = |n: &str| quote_ident(&s.profile.engine, n);
                    let qualified = metadata
                        .schema
                        .as_ref()
                        .map(|n| format!("{}.{}", q(n), q(&metadata.name)))
                        .unwrap_or_else(|| q(&metadata.name));
                    let mut query = format!("SELECT * FROM {qualified}");
                    let filter = arg(&args, "filter");
                    let mut parameters = BTreeMap::new();
                    if !filter.trim().is_empty() {
                        let pieces = metadata
                            .columns
                            .iter()
                            .enumerate()
                            .map(|(i, c)| {
                                let key = if s.profile.engine == "postgresql" {
                                    (i + 1).to_string()
                                } else {
                                    format!("f{i}")
                                };
                                parameters.insert(key.clone(), json!(format!("%{filter}%")));
                                let marker = if s.profile.engine == "postgresql" {
                                    format!("${key}")
                                } else {
                                    format!(":{key}")
                                };
                                format!(
                                    "CAST({} AS {}) LIKE {marker}",
                                    q(&c.name),
                                    if s.profile.engine == "postgresql" {
                                        "TEXT"
                                    } else if s.profile.engine == "sqlite" {
                                        "TEXT"
                                    } else {
                                        "CHAR"
                                    }
                                )
                            })
                            .collect::<Vec<_>>();
                        query.push_str(&format!(" WHERE ({})", pieces.join(" OR ")));
                    }
                    let order = arg(&args, "orderBy");
                    if !order.is_empty() {
                        if !metadata.columns.iter().any(|c| c.name == order) {
                            return Err("Colonna ordinamento sconosciuta".into());
                        }
                        query.push_str(&format!(
                            " ORDER BY {} {}",
                            q(order),
                            if args["orderDesc"].as_bool().unwrap_or(false) {
                                "DESC"
                            } else {
                                "ASC"
                            }
                        ));
                    } else {
                        let keys = metadata
                            .columns
                            .iter()
                            .filter(|c| c.primary_key)
                            .map(|c| q(&c.name))
                            .collect::<Vec<_>>();
                        if !keys.is_empty() {
                            query.push_str(&format!(" ORDER BY {}", keys.join(",")))
                        }
                    }
                    query.push_str(&format!(" LIMIT {limit} OFFSET {offset}"));
                    s.execute(&query, parameters).await?
                };
                for set in &mut out.sets {
                    set.table = Some(table.into());
                    if s.profile.engine != "mongodb" {
                        set.columns = metadata.columns.clone()
                    }
                }
                encode(out)
            }
            "apply_changes" => {
                let s = self.session(arg(&args, "sessionId")).await?;
                encode(
                    s.apply(
                        arg(&args, "table"),
                        decode(args.get("changes").cloned().unwrap_or(json!([])))?,
                    )
                    .await?,
                )
            }
            "lab_open" => self.lab_open(&args).await,
            "lab_reset" => self.lab_reset(&args).await,
            "lab_exercises" => {
                let s = self.session(arg(&args, "sessionId")).await?;
                encode(lab::exercises(
                    &s.profile.engine,
                    if arg(&args, "dataset").is_empty() {
                        "shop"
                    } else {
                        arg(&args, "dataset")
                    },
                ))
            }
            "lab_check" => self.lab_check(&args).await,
            "generate_workbench" => encode(crate::codegen_workbench::generate_workbench(decode(
                args.get("request").cloned().ok_or("Richiesta mancante")?,
            )?)?),
            "generate_code" => encode(codegen::generate_project(decode(
                args.get("request").cloned().ok_or("Richiesta mancante")?,
            )?)?),
            "export_project" => {
                let project: codegen::GeneratedProject =
                    decode(args.get("project").cloned().ok_or("Progetto mancante")?)?;
                let destination = arg(&args, "destination");
                let destination = if destination.trim().is_empty() {
                    self.root.join("exports").join(format!(
                        "project-{}",
                        chrono::Utc::now().format("%Y%m%d-%H%M%S")
                    ))
                } else {
                    PathBuf::from(destination)
                };
                write_project(&project, &destination)?;
                encode(destination.to_string_lossy().to_string())
            }
            "save_query" => {
                let mut q: SavedQuery =
                    decode(args.get("query").cloned().ok_or("Query mancante")?)?;
                if q.id.is_empty() {
                    q.id = uuid::Uuid::new_v4().to_string()
                }
                self.store.save_query(&q)?;
                encode(q)
            }
            "get_history" => encode(self.store.history()?),
            "update_settings" => {
                let mut settings = args.get("settings").cloned().unwrap_or(json!({}));
                if let Some(ai) = settings.get_mut("ai").and_then(Value::as_object_mut) {
                    if let Some(Value::String(key)) = ai.remove("apiKey") {
                        if !key.is_empty() {
                            set_password("ai-cloud-api-key", &key)?
                        }
                    }
                }
                encode(self.store.update_settings(settings)?)
            }
            "environment_list" => encode(self.environments.list().await?),
            "environment_action" => {
                self.environment_action(args.get("request").unwrap_or(&args))
                    .await
            }
            "service_plan" => encode(crate::windows_service::plan(&self.root, arg(&args, "id"))?),
            "service_action" => {
                if !args["confirmed"].as_bool().unwrap_or(false) {
                    return Err(
                        "Rivedi il piano e conferma l'operazione sul servizio selezionato.".into(),
                    );
                }
                let id = arg(&args, "id");
                let outcome =
                    crate::windows_service::request_action(&self.root, id, arg(&args, "action"))
                        .await?;
                self.sessions
                    .write()
                    .await
                    .retain(|_, s| s.profile.id != id);
                encode(outcome)
            }
            "assistant_chat" => {
                self.assistant_chat(args.get("request").unwrap_or(&args))
                    .await
            }
            "assistant_models" => {
                let config: assistant::AiConfig = decode(
                    args.get("config")
                        .cloned()
                        .ok_or("Configurazione mancante")?,
                )?;
                encode(assistant::list_ollama_models(&config).await?)
            }
            "transfer_data" => {
                self.transfer_data(args.get("request").unwrap_or(&args))
                    .await
            }
            "schema_tools" => {
                self.schema_tools(args.get("request").unwrap_or(&args))
                    .await
            }
            "open_vscode" => {
                let path = PathBuf::from(arg(&args, "path"));
                if !path.is_dir() {
                    return Err("La cartella del progetto non esiste".into());
                }
                let exe = std::env::var_os("LOCALAPPDATA")
                    .map(PathBuf::from)
                    .unwrap_or_default()
                    .join("Programs/Microsoft VS Code/Code.exe");
                let mut cmd = tokio::process::Command::new(exe);
                cmd.arg("--new-window").arg(path);
                #[cfg(windows)]
                cmd.creation_flags(0x08000000);
                cmd.spawn()
                    .map_err(|e| format!("VS Code non trovato: {e}"))?;
                Ok(json!("Progetto aperto in VS Code"))
            }
            _ => Err(format!("Comando non riconosciuto: {command}")),
        }
    }
    async fn lab_open(&self, args: &Value) -> Result<Value, String> {
        let engine = if arg(args, "engine").is_empty() {
            "sqlite"
        } else {
            arg(args, "engine")
        };
        let dataset = if arg(args, "dataset").is_empty() {
            "shop"
        } else {
            arg(args, "dataset")
        };
        lab::seed_sql(dataset)?;
        let id = format!("lab-{}", uuid::Uuid::new_v4());
        let (p, secret) = if engine == "sqlite" {
            let dir = self.root.join("labs");
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join(format!("{id}.sqlite"));
            let conn = rusqlite::Connection::open(&path).map_err(|e| e.to_string())?;
            conn.pragma_update(None, "foreign_keys", true)
                .map_err(|e| e.to_string())?;
            lab::seed(&conn, dataset)?;
            drop(conn);
            (
                ConnectionProfile {
                    id: id.clone(),
                    name: format!("Laboratorio · {dataset}"),
                    file_path: path.to_string_lossy().to_string(),
                    database: dataset.into(),
                    laboratory: true,
                    environment: "Laboratorio".into(),
                    ..Default::default()
                },
                String::new(),
            )
        } else {
            let provider = arg(args, "provider");
            let provider = if provider == "docker" {
                environment::Provider::Docker
            } else {
                environment::Provider::Native
            };
            let eng: environment::Engine = decode(json!(engine))?;
            let catalog = self.environments.catalog().await?;
            let dist = catalog.iter().find(|d| d.engine == eng);
            let env = self
                .environments
                .create(environment::CreateEnvironmentRequest {
                    name: format!("Laboratorio {engine} · {dataset}"),
                    engine: eng,
                    provider,
                    laboratory: true,
                    version: Some(
                        match engine {
                            "postgresql" => "18",
                            "mysql" => "8.4",
                            "mariadb" => "11.8",
                            "mongodb" => "8.0",
                            _ => return Err("Motore sconosciuto".into()),
                        }
                        .into(),
                    ),
                    image_digest: None,
                    distribution_id: dist.map(|d| d.id.clone()),
                    endpoint: None,
                    port: None,
                })
                .await?;
            if env.status == "error" {
                return Err(env
                    .last_error
                    .clone()
                    .unwrap_or("Preparazione ambiente non riuscita".into()));
            }
            let secret = self.environments.password(&env.id)?;
            let p = ConnectionProfile {
                id: env.id.clone(),
                name: env.name,
                engine: engine.into(),
                host: "127.0.0.1".into(),
                port: env.port.unwrap_or(0),
                username: env.username.unwrap_or_default(),
                database: "laboratory".into(),
                laboratory: true,
                environment: "Laboratorio".into(),
                ..Default::default()
            };
            (p, secret)
        };
        if !secret.is_empty() {
            set_password(&p.id, &secret)?
        }
        self.store.save_profile(&p)?;
        let schema = self.add_session(id.clone(), p.clone(), secret).await?;
        if engine != "sqlite" {
            self.seed_remote(&id, dataset).await?
        }
        Ok(
            json!({"profile":p,"sessionId":id,"schema":if engine=="sqlite"{schema}else{self.session(&id).await?.introspect().await?}}),
        )
    }
    async fn seed_remote(&self, id: &str, dataset: &str) -> Result<(), String> {
        let s = self.session(id).await?;
        if s.profile.engine == "mongodb" {
            let docs = match dataset {
                "library" => vec![
                    json!({"title":"Le città invisibili","author":"Italo Calvino","year":1972}),
                    json!({"title":"Il sistema periodico","author":"Primo Levi","year":1975}),
                ],
                _ => vec![
                    json!({"name":"Anna Rossi","city":"Udine","orders":[{"product":"Taccuino","quantity":2,"price":8.5}]}),
                    json!({"name":"Marco Bianchi","city":"Trieste","orders":[{"product":"Zaino","quantity":1,"price":49.9}]}),
                    json!({"name":"Sara Verdi","city":"Udine","orders":[]}),
                ],
            };
            let collection = if dataset == "library" {
                "books"
            } else {
                "customers"
            };
            s.execute(
                &json!({"insert":collection,"documents":docs}).to_string(),
                BTreeMap::new(),
            )
            .await?;
        } else {
            s.execute(lab::seed_sql(dataset)?, BTreeMap::new()).await?;
        }
        Ok(())
    }
    async fn lab_reset(&self, args: &Value) -> Result<Value, String> {
        let id = arg(args, "sessionId");
        let dataset = if arg(args, "dataset").is_empty() {
            "shop"
        } else {
            arg(args, "dataset")
        };
        let s = self.session(id).await?;
        if !s.profile.laboratory {
            return Err("Il ripristino è riservato ai laboratori creati dall'app.".into());
        }
        if let Handle::Sqlite { conn, .. } = &s.handle {
            let path = PathBuf::from(&s.profile.file_path);
            if path.parent() != Some(self.root.join("labs").as_path()) {
                return Err("Il file non appartiene al laboratorio".into());
            }
            let _guard = s.serial.lock().await;
            let mut c = conn.lock().map_err(|e| e.to_string())?;
            let clean = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
            lab::seed(&clean, dataset)?;
            let backup =
                rusqlite::backup::Backup::new(&clean, &mut c).map_err(|e| e.to_string())?;
            backup
                .run_to_completion(256, std::time::Duration::from_millis(5), None)
                .map_err(|e| e.to_string())?;
            drop(backup);
            sqlite::protect_lab(&c);
            return encode(sqlite::introspect(&c, &s.profile.database)?);
        }
        let profile = s.profile.clone();
        drop(s);
        self.sessions.write().await.remove(id);
        let env = self.environments.reset(&profile.id).await?;
        let secret = self.environments.password(&env.id)?;
        self.add_session(id.into(), profile, secret).await?;
        self.seed_remote(id, dataset).await?;
        encode(self.session(id).await?.introspect().await?)
    }
    async fn lab_check(&self, r: &Value) -> Result<Value, String> {
        let s = self.session(arg(r, "sessionId")).await?;
        if !s.profile.laboratory {
            return Err("Apri un laboratorio per verificare gli esercizi".into());
        }
        let dataset = if arg(r, "dataset").is_empty() {
            if s.profile.database == "laboratory" {
                "shop"
            } else {
                &s.profile.database
            }
        } else {
            arg(r, "dataset")
        };
        let exercise = lab::exercises(&s.profile.engine, dataset)
            .into_iter()
            .find(|e| e.id == arg(r, "exerciseId"))
            .ok_or("Esercizio non trovato")?;
        let submitted = arg(r, "query");
        if submitted.trim().is_empty() {
            return Err("Scrivi una query per verificarla".into());
        }
        let (actual, expected) = if s.profile.engine == "sqlite" {
            let user = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
            lab::seed(&user, dataset)?;
            sqlite::protect_lab(&user);
            let reference = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
            lab::seed(&reference, dataset)?;
            sqlite::protect_lab(&reference);
            let a = sqlite::execute(&user, submitted, &BTreeMap::new(), false)?;
            let b = sqlite::execute(&reference, &exercise.query, &BTreeMap::new(), false)?;
            if let Some(check) = exercise.check {
                (
                    sqlite::execute(&user, &check, &BTreeMap::new(), true)?,
                    sqlite::execute(&reference, &check, &BTreeMap::new(), true)?,
                )
            } else {
                (a, b)
            }
        } else {
            if exercise.check.is_some() {
                return Err("Verifica modifiche disponibile per gli esercizi SQLite.".into());
            }
            (
                s.execute(submitted, BTreeMap::new()).await?,
                s.execute(&exercise.query, BTreeMap::new()).await?,
            )
        };
        let normalize = |r: &QueryResult| -> Vec<Vec<Vec<String>>> {
            r.sets
                .iter()
                .map(|set| {
                    let mut rows = set
                        .rows
                        .iter()
                        .map(|row| {
                            set.columns
                                .iter()
                                .map(|c| {
                                    row.get(&c.name)
                                        .map(|v| format!("{}:{}", v.kind, v.text()))
                                        .unwrap_or_else(|| "missing".into())
                                })
                                .collect::<Vec<_>>()
                        })
                        .collect::<Vec<_>>();
                    rows.sort();
                    rows
                })
                .collect()
        };
        let passed = normalize(&actual) == normalize(&expected);
        Ok(
            json!({"passed":passed,"message":if passed{"Risultato corretto: la query soddisfa l'esercizio."}else{"Il risultato differisce da quello atteso. Controlla colonne, filtri e valori nulli."},"details":{"actual":actual,"expected":expected},"notes":if s.profile.engine=="sqlite"{"Verifica eseguita su copie separate dei dati iniziali."}else{"Verifica eseguita sul laboratorio corrente."}}),
        )
    }
    async fn environment_action(&self, r: &Value) -> Result<Value, String> {
        match arg(r, "action") {
            "detect" => Ok(
                json!({"docker":self.environments.docker_available().await.map_err(|e|e.to_string()),"nativeCatalog":self.environments.catalog().await?,"platform":std::env::consts::OS}),
            ),
            "catalog" => encode(self.environments.catalog().await?),
            "create" | "install" => {
                let engine: environment::Engine = decode(json!(arg(r, "engine")))?;
                let provider: environment::Provider = decode(json!(arg(r, "provider")))?;
                let catalog = self.environments.catalog().await?;
                let dist = catalog.iter().find(|d| d.engine == engine);
                let req = environment::CreateEnvironmentRequest {
                    name: arg(r, "name").into(),
                    engine,
                    provider,
                    laboratory: r["laboratory"].as_bool().unwrap_or(false),
                    version: if provider == environment::Provider::Docker {
                        Some(
                            match engine {
                                environment::Engine::Postgresql => "18",
                                environment::Engine::Mysql => "8.4",
                                environment::Engine::Mariadb => "11.8",
                                environment::Engine::Mongodb => "8.0",
                                _ => "3",
                            }
                            .into(),
                        )
                    } else {
                        dist.map(|d| d.version.clone())
                    },
                    image_digest: r
                        .get("imageDigest")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    distribution_id: dist.map(|d| d.id.clone()),
                    endpoint: r.get("endpoint").and_then(Value::as_str).map(str::to_owned),
                    port: r
                        .get("port")
                        .and_then(Value::as_u64)
                        .map(|p| u16::try_from(p).map_err(|_| "Porta non valida"))
                        .transpose()?,
                };
                let env = self.environments.create(req).await?;
                let engine = serde_json::to_value(engine)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned();
                if env.status == "error" {
                    return Err(env
                        .last_error
                        .clone()
                        .unwrap_or("Preparazione ambiente non riuscita".into()));
                }
                let secret = self.environments.password(&env.id)?;
                let p = ConnectionProfile {
                    id: env.id.clone(),
                    name: env.name.clone(),
                    engine: engine.clone(),
                    host: "127.0.0.1".into(),
                    port: env.port.unwrap_or(0),
                    username: env.username.clone().unwrap_or_default(),
                    database: if env.laboratory {
                        "laboratory"
                    } else if engine == "postgresql" {
                        "postgres"
                    } else if engine == "mongodb" {
                        "admin"
                    } else {
                        "mysql"
                    }
                    .into(),
                    environment: if env.laboratory {
                        "Laboratorio"
                    } else {
                        "Locale"
                    }
                    .into(),
                    laboratory: env.laboratory,
                    ..Default::default()
                };
                set_password(&p.id, &secret)?;
                self.store.save_profile(&p)?;
                encode(env)
            }
            "start" | "stop" => {
                let id = arg(r, "id");
                if crate::windows_service::reservation_exists(id)? {
                    encode(
                        crate::windows_service::request_action(&self.root, id, arg(r, "action"))
                            .await?,
                    )
                } else if arg(r, "action") == "start" {
                    encode(self.environments.start(id).await?)
                } else {
                    encode(self.environments.stop(id).await?)
                }
            }
            "reset" => {
                if crate::windows_service::reservation_exists(arg(r, "id"))? {
                    return Err("Questo ambiente ha dati di servizio in ProgramData: il reset nativo è disabilitato.".into());
                }
                encode(self.environments.reset(arg(r, "id")).await?)
            }
            "delete" => {
                if crate::windows_service::reservation_exists(arg(r, "id"))? {
                    return Err("Il servizio o i suoi dati conservati richiedono revisione prima di rimuovere l'ambiente.".into());
                }
                self.environments
                    .delete(arg(r, "id"), r["deleteData"].as_bool().unwrap_or(false))
                    .await?;
                self.store.delete_profile(arg(r, "id"))?;
                Ok(
                    json!({"message":"Ambiente rimosso dal registro; i dati vengono eliminati solo se richiesto esplicitamente."}),
                )
            }
            _ => Err("Azione ambiente sconosciuta".into()),
        }
    }
    async fn assistant_chat(&self, r: &Value) -> Result<Value, String> {
        let settings = self.store.settings()?;
        let ai = &settings["ai"];
        let provider = if arg(r, "provider") == "ollama" {
            assistant::AiProvider::Ollama
        } else {
            assistant::AiProvider::OpenAiCompatible
        };
        let s = if arg(r, "sessionId").is_empty() {
            None
        } else {
            Some(self.session(arg(r, "sessionId")).await?)
        };
        let include_schema = r["includeSchema"].as_bool().unwrap_or(false);
        let include_rows = r["includeRows"].as_bool().unwrap_or(false);
        let schema = if include_schema {
            if let Some(s) = &s {
                Some(encode(s.introspect().await?)?)
            } else {
                None
            }
        } else {
            None
        };
        let config = assistant::AiConfig {
            provider,
            endpoint: ai["baseUrl"]
                .as_str()
                .unwrap_or("http://127.0.0.1:11434")
                .into(),
            model: if arg(r, "model").is_empty() {
                ai["model"].as_str().unwrap_or("").into()
            } else {
                arg(r, "model").into()
            },
            timeout_seconds: 120,
        };
        let request = assistant::AiRequest {
            config,
            prompt: arg(r, "message").into(),
            engine: s.as_ref().map(|s| s.profile.engine.clone()),
            consent: assistant::ContextConsent {
                include_query: r
                    .get("includeQuery")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                include_schema,
                include_rows,
            },
            query: Some(arg(r, "query").into()),
            schema,
            rows: if include_rows {
                r.get("rows").cloned()
            } else {
                None
            },
        };
        let key = password("ai-cloud-api-key");
        encode(
            assistant::complete(request, if key.is_empty() { None } else { Some(key) })
                .await?
                .content,
        )
    }
    async fn transfer_data(&self, r: &Value) -> Result<Value, String> {
        let s = self.session(arg(r, "sessionId")).await?;
        let table = arg(r, "table");
        let format = arg(r, "format");
        if format == "sql" {
            return self.transfer_sql(r, s).await;
        }
        if table.is_empty() {
            return Err("Seleziona la tabella o collezione.".into());
        }
        let action = arg(r, "action");
        let artifacts = self.root.join("artifacts");
        std::fs::create_dir_all(&artifacts).map_err(|e| e.to_string())?;
        if action == "export" {
            let export_limit = r.get("limit").and_then(Value::as_u64);
            if export_limit == Some(0) {
                return Err("Il limite deve essere almeno 1.".into());
            }
            if format == "csv" && s.profile.engine == "mongodb" {
                return Err(
                    "Per conservare i tipi dei documenti MongoDB scegli JSON canonico.".into(),
                );
            }
            let destination = if arg(r, "path").is_empty() {
                artifacts.join(format!(
                    "export-{}.{}",
                    uuid::Uuid::new_v4(),
                    if format == "csv" { "csv" } else { "json" }
                ))
            } else {
                PathBuf::from(arg(r, "path"))
            };
            if let Handle::Sqlite { conn, .. } = &s.handle {
                let c = conn.clone();
                let t = table.to_owned();
                let p = destination.clone();
                let f = format.to_owned();
                let count = tokio::task::spawn_blocking(move || {
                    sqlite::export_file(
                        &*c.lock().map_err(|e| e.to_string())?,
                        &t,
                        &p,
                        &f,
                        export_limit,
                    )
                })
                .await
                .map_err(|e| e.to_string())??;
                return Ok(
                    json!({"path":destination,"rows":count,"format":format,"notes":"JSON conserva i valori tipizzati; CSV usa \\N per NULL e Base64 per i binari."}),
                );
            }
            // Page directly to disk; large exports never accumulate in the webview.
            use std::io::Write;
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&destination)
                .map_err(|e| e.to_string())?;
            let mut writer = std::io::BufWriter::new(file);
            let mut csv = csv::Writer::from_writer(Vec::new());
            let mut count = 0;
            let schema = s.introspect().await?;
            let meta = schema
                .tables
                .iter()
                .find(|t| t.name == table)
                .ok_or("Tabella sconosciuta")?;
            let mut first = true;
            if format != "csv" {
                writer.write_all(b"[\n").map_err(|e| e.to_string())?;
            }
            if let Handle::Mongo { db } = &s.handle {
                use futures_util::TryStreamExt;
                let mut cursor = db
                    .collection::<mongodb::bson::Document>(table)
                    .find(mongodb::bson::doc! {})
                    .limit(export_limit.unwrap_or(i64::MAX as u64).min(i64::MAX as u64) as i64)
                    .batch_size(1000)
                    .await
                    .map_err(|e| e.to_string())?;
                while let Some(doc) = cursor.try_next().await.map_err(|e| e.to_string())? {
                    let value = mongodb::bson::Bson::Document(doc).into_canonical_extjson();
                    if format == "csv" {
                        return Err(
                            "Per conservare i tipi dei documenti MongoDB scegli JSON canonico."
                                .into(),
                        );
                    }
                    if !first {
                        writer.write_all(b",\n").map_err(|e| e.to_string())?
                    }
                    serde_json::to_writer(&mut writer, &value).map_err(|e| e.to_string())?;
                    first = false;
                    count += 1;
                }
            } else {
                loop {
                    if export_limit.is_some_and(|n| count >= n) {
                        break;
                    }
                    let batch_size = export_limit.map(|n| (n - count).min(1000)).unwrap_or(1000);
                    let q = |n: &str| quote_ident(&s.profile.engine, n);
                    let name = meta
                        .schema
                        .as_ref()
                        .map(|n| format!("{}.{}", q(n), q(table)))
                        .unwrap_or_else(|| q(table));
                    let keys = meta
                        .columns
                        .iter()
                        .filter(|c| c.primary_key)
                        .map(|c| q(&c.name))
                        .collect::<Vec<_>>();
                    let order = if keys.is_empty() {
                        String::new()
                    } else {
                        format!(" ORDER BY {}", keys.join(","))
                    };
                    let result = s
                        .execute(
                            &format!(
                                "SELECT * FROM {name}{order} LIMIT {batch_size} OFFSET {count}"
                            ),
                            BTreeMap::new(),
                        )
                        .await?;
                    let Some(set) = result.sets.first() else {
                        break;
                    };
                    if set.rows.is_empty() {
                        break;
                    }
                    if first && format == "csv" {
                        csv.write_record(set.columns.iter().map(|c| &c.name))
                            .map_err(|e| e.to_string())?
                    }
                    for row in &set.rows {
                        if format == "csv" {
                            csv.write_record(set.columns.iter().map(|c| {
                                row.get(&c.name)
                                    .map(|v| {
                                        if v.kind == "null" {
                                            "\\N".into()
                                        } else {
                                            v.text()
                                        }
                                    })
                                    .unwrap_or_default()
                            }))
                            .map_err(|e| e.to_string())?;
                        } else {
                            if !first {
                                writer.write_all(b",\n").map_err(|e| e.to_string())?
                            }
                            serde_json::to_writer(&mut writer, row).map_err(|e| e.to_string())?;
                        }
                        first = false;
                        count += 1;
                    }
                    if format == "csv" {
                        csv.flush().map_err(|e| e.to_string())?;
                        writer.write_all(csv.get_ref()).map_err(|e| e.to_string())?;
                        csv = csv::Writer::from_writer(Vec::new());
                    }
                    if set.rows.len() < 1000 {
                        break;
                    }
                }
            }
            if format != "csv" {
                writer.write_all(b"\n]\n").map_err(|e| e.to_string())?
            }
            writer.flush().map_err(|e| e.to_string())?;
            return Ok(
                json!({"path":destination,"rows":count,"format":format,"notes":"Esportazione a pagine: durante il trasferimento mantenere stabile il dataset."}),
            );
        }
        if action != "import" && action != "previewImport" {
            return Err("Azione trasferimento sconosciuta".into());
        }
        if s.profile.read_only {
            return Err("Connessione in sola lettura".into());
        }
        let content = if !arg(r, "content").is_empty() {
            arg(r, "content").to_owned()
        } else {
            let path = PathBuf::from(arg(r, "path"));
            let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
            if size > 32 * 1024 * 1024 {
                return Err("Importazioni interattive limitate a 32 MiB.".into());
            }
            std::fs::read_to_string(path).map_err(|e| e.to_string())?
        };
        let schema = s.introspect().await?;
        let meta = schema
            .tables
            .iter()
            .find(|t| t.name == table)
            .ok_or("Tabella non trovata")?;
        let mut records: Vec<DataRow> = Vec::new();
        if format == "csv" {
            let mut reader = csv::Reader::from_reader(content.as_bytes());
            let headers = reader.headers().map_err(|e| e.to_string())?.clone();
            for (i, row) in reader.records().enumerate() {
                let row = row.map_err(|e| format!("Riga {}: {e}", i + 2))?;
                let mut data = BTreeMap::new();
                for (name, value) in headers.iter().zip(row.iter()) {
                    let col = meta
                        .columns
                        .iter()
                        .find(|c| c.name == name)
                        .ok_or_else(|| format!("Colonna sconosciuta: {name}"))?;
                    let kind = if value == "\\N" {
                        "null"
                    } else {
                        let typ = col.data_type.to_uppercase();
                        if typ.contains("INT") {
                            "integer"
                        } else if typ.contains("REAL")
                            || typ.contains("FLOAT")
                            || typ.contains("DOUBLE")
                        {
                            "float"
                        } else if typ.contains("NUMERIC") || typ.contains("DECIMAL") {
                            "decimal"
                        } else {
                            "text"
                        }
                    };
                    data.insert(
                        name.into(),
                        if kind == "null" {
                            CellValue::null()
                        } else {
                            CellValue::string(kind, value)
                        },
                    );
                }
                records.push(data)
            }
        } else {
            let array: Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
            for row in array
                .as_array()
                .ok_or("Il JSON deve essere un array di record")?
            {
                let mut data = BTreeMap::new();
                for (k, v) in row.as_object().ok_or("Record JSON non valido")? {
                    data.insert(
                        k.clone(),
                        if v.get("type").is_some() {
                            decode(v.clone())?
                        } else {
                            match v {
                                Value::Null => CellValue::null(),
                                Value::Bool(b) => CellValue::boolean(*b),
                                Value::Number(n) => CellValue::string(
                                    if n.is_i64() || n.is_u64() {
                                        "integer"
                                    } else {
                                        "decimal"
                                    },
                                    n,
                                ),
                                Value::String(s) => CellValue::string("text", s),
                                _ => CellValue::string("json", v),
                            }
                        },
                    );
                }
                records.push(data)
            }
        }
        if action == "previewImport" {
            return Ok(
                json!({"rows":records.len(),"preview":records.iter().take(20).collect::<Vec<_>>(),"columns":meta.columns,"notes":"Verifica tipi e mapping prima di applicare."}),
            );
        }
        let changes = records
            .into_iter()
            .map(|values| DataChange {
                kind: "insert".into(),
                key: BTreeMap::new(),
                original: BTreeMap::new(),
                values,
            })
            .collect();
        let result = s.apply(table, changes).await?;
        Ok(json!({"rows":result.affected_rows,"message":result.message}))
    }
    async fn transfer_sql(&self, r: &Value, s: Arc<Session>) -> Result<Value, String> {
        use std::io::Read;
        if s.profile.engine == "mongodb" {
            return Err("Per MongoDB usa Extended JSON; gli script mongosh si generano nel Generatore codice.".into());
        }
        let artifacts = self.root.join("artifacts");
        std::fs::create_dir_all(&artifacts).map_err(|e| e.to_string())?;
        let table = arg(r, "table");
        let all = arg(r, "scope") == "database";
        if arg(r, "action") == "export" {
            if !all && table.is_empty() {
                return Err("Scegli una tabella oppure l'intero database.".into());
            }
            let destination = if arg(r, "path").is_empty() {
                artifacts.join(format!("export-{}.sql", uuid::Uuid::new_v4()))
            } else {
                PathBuf::from(arg(r, "path"))
            };
            if let Handle::Sqlite { conn, .. } = &s.handle {
                let c = conn.clone();
                let target = destination.clone();
                let table = if all { None } else { Some(table.to_owned()) };
                let rows = tokio::task::spawn_blocking(move || {
                    sqlite::export_sql(
                        &*c.lock().map_err(|e| e.to_string())?,
                        table.as_deref(),
                        &target,
                    )
                })
                .await
                .map_err(|e| e.to_string())??;
                return Ok(
                    json!({"path":destination,"rows":rows,"format":"sql","scope":if all{"database"}else{"table"}}),
                );
            }
            let name = if s.profile.engine == "postgresql" {
                "pg_dump"
            } else if s.profile.engine == "mariadb" {
                "mariadb-dump"
            } else {
                "mysqldump"
            };
            let exe = if !arg(r, "executablePath").is_empty() {
                arg(r, "executablePath").to_owned()
            } else {
                self.environments
                    .ensure_client_tool(&s.profile.id, name)
                    .await
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| name.into())
            };
            let qualified = if all {
                String::new()
            } else {
                let schema = s.introspect().await?;
                let meta = schema
                    .tables
                    .iter()
                    .find(|t| t.name == table)
                    .ok_or("Tabella non trovata")?;
                if s.profile.engine == "postgresql" {
                    format!(
                        "{}.{}",
                        quote_ident("postgresql", meta.schema.as_deref().unwrap_or("public")),
                        quote_ident("postgresql", table)
                    )
                } else {
                    table.into()
                }
            };
            let artifact = tools::ArtifactStore::new(&self.root)?
                .export_sql_table(
                    tools::BackupRequest {
                        engine: s.profile.engine.clone(),
                        executable_path: exe,
                        host: s.transport.host.clone(),
                        port: s.transport.port,
                        database: s.profile.database.clone(),
                        username: s.profile.username.clone(),
                        tls: s.profile.tls,
                        ca_path: if s.profile.ca_path.is_empty() {
                            None
                        } else {
                            Some(s.profile.ca_path.clone())
                        },
                        auth_database: None,
                    },
                    &qualified,
                    Some(password(&s.profile.id)),
                )
                .await?;
            if !arg(r, "path").is_empty() {
                let mut input = std::fs::File::open(&artifact.path).map_err(|e| e.to_string())?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&destination)
                    .map_err(|e| e.to_string())?;
                std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
                return Ok(json!({"path":destination,"bytes":artifact.bytes,"format":"sql"}));
            }
            return encode(artifact);
        }
        if !["import", "previewImport"].contains(&arg(r, "action")) {
            return Err("Azione SQL sconosciuta".into());
        }
        if s.profile.read_only {
            return Err("Connessione in sola lettura".into());
        }
        let source = if !arg(r, "content").is_empty() {
            let p = artifacts.join(format!("import-{}.sql", uuid::Uuid::new_v4()));
            std::fs::write(&p, arg(r, "content")).map_err(|e| e.to_string())?;
            p
        } else {
            PathBuf::from(arg(r, "path"))
        };
        if !source.is_file() {
            return Err("Seleziona un file SQL o incolla lo script.".into());
        }
        if arg(r, "action") == "previewImport" {
            let mut file = std::fs::File::open(&source).map_err(|e| e.to_string())?;
            let size = file.metadata().map_err(|e| e.to_string())?.len();
            let mut preview = vec![0; size.min(65536) as usize];
            file.read_exact(&mut preview).map_err(|e| e.to_string())?;
            return Ok(
                json!({"path":source,"bytes":size,"scriptPreview":String::from_utf8_lossy(&preview),"truncated":size>65536,"notes":"Lo script viene eseguito sul database selezionato. Rivedere DDL, DROP, USE e transazioni; l'atomicità dipende dal motore e dallo script."}),
            );
        }
        if !r["confirmed"].as_bool().unwrap_or(false) {
            return Err("Conferma l'esecuzione dello script dopo l'anteprima.".into());
        }
        if let Handle::Sqlite { conn, .. } = &s.handle {
            let c = conn.clone();
            return encode(
                tokio::task::spawn_blocking(move || {
                    sqlite::import_sql_file(&*c.lock().map_err(|e| e.to_string())?, &source)
                })
                .await
                .map_err(|e| e.to_string())??,
            );
        }
        let name = if s.profile.engine == "postgresql" {
            "psql"
        } else if s.profile.engine == "mariadb" {
            "mariadb"
        } else {
            "mysql"
        };
        let exe = if !arg(r, "executablePath").is_empty() {
            arg(r, "executablePath").into()
        } else {
            self.environments
                .ensure_client_tool(&s.profile.id, name)
                .await
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| name.into())
        };
        tools::ArtifactStore::new(&self.root)?
            .import_sql_script(
                tools::BackupRequest {
                    engine: s.profile.engine.clone(),
                    executable_path: exe,
                    host: s.transport.host.clone(),
                    port: s.transport.port,
                    database: s.profile.database.clone(),
                    username: s.profile.username.clone(),
                    tls: s.profile.tls,
                    ca_path: if s.profile.ca_path.is_empty() {
                        None
                    } else {
                        Some(s.profile.ca_path.clone())
                    },
                    auth_database: None,
                },
                &source,
                Some(password(&s.profile.id)),
                true,
            )
            .await
    }
    async fn schema_tools(&self, r: &Value) -> Result<Value, String> {
        let s = self.session(arg(r, "sessionId")).await?;
        match arg(r, "action") {
            "ddl" => {
                let name = arg(r, "table");
                if name.trim().is_empty() {
                    return Err("Specifica il nome della tabella".into());
                }
                if s.profile.engine == "mongodb" {
                    return Ok(
                        json!({"sql":json!({"create":name,"validator":{"$jsonSchema":{"bsonType":"object"}}}).to_string()}),
                    );
                }
                let columns: Vec<ColumnInfo> =
                    decode(r.get("columns").cloned().unwrap_or(json!([])))?;
                if columns.is_empty() {
                    return Err("Aggiungi almeno una colonna".into());
                }
                let sql = create_table_sql(&s.profile.engine, name, &columns)?;
                if r["execute"].as_bool().unwrap_or(false) {
                    s.execute(&sql, BTreeMap::new()).await?;
                }
                Ok(json!({"sql":sql}))
            }
            "explain" => {
                let query = arg(r, "query");
                if query.trim().is_empty() {
                    return Err("Scrivi una query".into());
                }
                let query = if s.profile.engine == "mongodb" {
                    let v: Value = serde_json::from_str(query).map_err(|e| e.to_string())?;
                    json!({"explain":v,"verbosity":"queryPlanner"}).to_string()
                } else {
                    format!(
                        "{} {query}",
                        if s.profile.engine == "sqlite" {
                            "EXPLAIN QUERY PLAN"
                        } else {
                            "EXPLAIN"
                        }
                    )
                };
                encode(s.execute(&query, BTreeMap::new()).await?)
            }
            "document" | "documentation" => {
                let schema = encode(s.introspect().await?)?;
                encode(
                    tools::ArtifactStore::new(&self.root)?
                        .schema_documentation(&s.profile.name, &schema)?,
                )
            }
            "diff" => {
                let p = self.store.profile(arg(r, "targetProfileId"))?;
                if p.engine != s.profile.engine {
                    return Err("Il confronto richiede lo stesso motore.".into());
                }
                let target = Session::open(p.clone(), password(&p.id)).await?;
                let source = s.introspect().await?;
                let desired = target.introspect().await?;
                let differences = tools::compare_snapshots(&encode(&source)?, &encode(&desired)?);
                let mut sql = String::new();
                let mut notes = Vec::new();
                for table in &desired.tables {
                    if !source
                        .tables
                        .iter()
                        .any(|t| t.name == table.name && t.schema == table.schema)
                        && table.kind == "table"
                    {
                        sql.push_str(&create_table_sql(
                            &s.profile.engine,
                            &table.name,
                            &table.columns,
                        )?);
                        sql.push('\n')
                    }
                }
                for table in &source.tables {
                    if !desired
                        .tables
                        .iter()
                        .any(|t| t.name == table.name && t.schema == table.schema)
                    {
                        notes.push(format!(
                            "Oggetto da rimuovere, richiede revisione: {}",
                            table.name
                        ));
                    } else {
                        let dest = desired
                            .tables
                            .iter()
                            .find(|t| t.name == table.name && t.schema == table.schema)
                            .unwrap();
                        for col in &dest.columns {
                            if !table.columns.iter().any(|c| c.name == col.name) {
                                let q = quote_ident(&s.profile.engine, &col.name);
                                sql.push_str(&format!(
                                    "ALTER TABLE {} ADD COLUMN {q} {}{};\n",
                                    quote_ident(&s.profile.engine, &table.name),
                                    safe_type(&col.data_type)?,
                                    if col.nullable { "" } else { " NOT NULL" }
                                ));
                            }
                        }
                        for col in &table.columns {
                            if let Some(other) = dest.columns.iter().find(|c| c.name == col.name) {
                                if col != other {
                                    notes.push(format!(
                                        "Modifica da revisionare per {}.{}: {:?} → {:?}",
                                        table.name, col.name, col, other
                                    ));
                                }
                            } else {
                                notes.push(format!(
                                    "Colonna da rimuovere con possibile perdita dati: {}.{}",
                                    table.name, col.name
                                ));
                            }
                        }
                    }
                }
                Ok(
                    json!({"differences":differences,"sql":sql,"notes":notes,"direction":"Lo script proposto aggiunge al database attivo gli oggetti mancanti rispetto alla destinazione; rimozioni e trasformazioni richiedono revisione."}),
                )
            }
            "backup" => {
                let p = PathBuf::from(arg(r, "path"));
                if let Handle::Sqlite { conn, .. } = &s.handle {
                    let destination = if p.as_os_str().is_empty() {
                        self.root
                            .join("artifacts")
                            .join(format!("backup-{}.sqlite", uuid::Uuid::new_v4()))
                    } else {
                        p
                    };
                    if let Some(parent) = destination.parent() {
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?
                    }
                    let c = conn.clone();
                    let out = destination.clone();
                    tokio::task::spawn_blocking(move || {
                        c.lock()
                            .map_err(|e| e.to_string())?
                            .backup("main", &out, None)
                            .map_err(|e| e.to_string())
                    })
                    .await
                    .map_err(|e| e.to_string())??;
                    return Ok(
                        json!({"path":destination,"message":"Backup SQLite completato con Online Backup API"}),
                    );
                }
                let exe = if arg(r, "executablePath").is_empty() {
                    match s.profile.engine.as_str() {
                        "postgresql" => "pg_dump",
                        "mysql" => "mysqldump",
                        "mariadb" => "mariadb-dump",
                        "mongodb" => "mongodump",
                        _ => return Err("Motore sconosciuto".into()),
                    }
                } else {
                    arg(r, "executablePath")
                };
                let exe = if arg(r, "executablePath").is_empty() {
                    self.environments
                        .ensure_client_tool(&s.profile.id, exe)
                        .await
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|_| exe.into())
                } else {
                    exe.into()
                };
                encode(
                    tools::ArtifactStore::new(&self.root)?
                        .backup_native(
                            tools::BackupRequest {
                                engine: s.profile.engine.clone(),
                                executable_path: exe,
                                host: s.transport.host.clone(),
                                port: s.transport.port,
                                database: s.profile.database.clone(),
                                username: s.profile.username.clone(),
                                tls: s.profile.tls,
                                ca_path: if s.profile.ca_path.is_empty() {
                                    None
                                } else {
                                    Some(s.profile.ca_path.clone())
                                },
                                auth_database: Some(if s.profile.laboratory {
                                    s.profile.database.clone()
                                } else {
                                    "admin".into()
                                }),
                            },
                            Some(password(&s.profile.id)),
                        )
                        .await?,
                )
            }
            "restore" => {
                if s.profile.read_only {
                    return Err("Connessione in sola lettura".into());
                }
                let path = PathBuf::from(arg(r, "path"));
                if !path.is_file() {
                    return Err("Seleziona un backup esistente".into());
                }
                if let Handle::Sqlite { conn, .. } = &s.handle {
                    let c = conn.clone();
                    tokio::task::spawn_blocking(move || {
                        let source = rusqlite::Connection::open_with_flags(
                            path,
                            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                        )
                        .map_err(|e| e.to_string())?;
                        let check: String = source
                            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
                            .map_err(|e| e.to_string())?;
                        if check != "ok" {
                            return Err("Backup non integro".into());
                        }
                        let mut target = c.lock().map_err(|e| e.to_string())?;
                        rusqlite::backup::Backup::new(&source, &mut target)
                            .map_err(|e| e.to_string())?
                            .run_to_completion(256, std::time::Duration::from_millis(5), None)
                            .map_err(|e| e.to_string())?;
                        Ok::<_, String>(())
                    })
                    .await
                    .map_err(|e| e.to_string())??;
                    Ok(json!({"message":"Backup SQLite ripristinato"}))
                } else {
                    let name = match s.profile.engine.as_str() {
                        "postgresql" => "pg_restore",
                        "mysql" => "mysql",
                        "mariadb" => "mariadb",
                        "mongodb" => "mongorestore",
                        _ => return Err("Motore non riconosciuto".into()),
                    };
                    let exe = if !arg(r, "executablePath").is_empty() {
                        arg(r, "executablePath").to_owned()
                    } else {
                        self.environments
                            .ensure_client_tool(&s.profile.id, name)
                            .await
                            .map(|p| p.to_string_lossy().to_string())
                            .unwrap_or_else(|_| name.into())
                    };
                    tools::ArtifactStore::new(&self.root)?
                        .restore_native(
                            tools::BackupRequest {
                                engine: s.profile.engine.clone(),
                                executable_path: exe,
                                host: s.transport.host.clone(),
                                port: s.transport.port,
                                database: s.profile.database.clone(),
                                username: s.profile.username.clone(),
                                tls: s.profile.tls,
                                ca_path: if s.profile.ca_path.is_empty() {
                                    None
                                } else {
                                    Some(s.profile.ca_path.clone())
                                },
                                auth_database: Some(if s.profile.laboratory {
                                    s.profile.database.clone()
                                } else {
                                    "admin".into()
                                }),
                            },
                            &path,
                            Some(password(&s.profile.id)),
                            r["confirmed"].as_bool().unwrap_or(false),
                        )
                        .await
                }
            }
            _ => Err("Strumento schema sconosciuto".into()),
        }
    }
}
fn safe_type(data_type: &str) -> Result<&str, String> {
    if data_type.trim().is_empty()
        || data_type.len() > 100
        || !data_type
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_ (),[]".contains(c))
    {
        return Err("Tipo colonna non valido".into());
    }
    let upper = data_type.to_uppercase();
    if [
        "DROP",
        "ALTER",
        "CREATE",
        "SELECT",
        "INSERT",
        "CONSTRAINT",
        "REFERENCES",
    ]
    .iter()
    .any(|s| upper.split_whitespace().any(|x| x == *s))
    {
        return Err("Specifica soltanto il tipo della colonna".into());
    }
    Ok(data_type)
}
fn create_table_sql(engine: &str, name: &str, columns: &[ColumnInfo]) -> Result<String, String> {
    let mut defs = Vec::new();
    for c in columns {
        let mut def = format!(
            "{} {}{}",
            quote_ident(engine, &c.name),
            safe_type(&c.data_type)?,
            if c.nullable { "" } else { " NOT NULL" }
        );
        if let Some(value) = &c.default_value {
            if value.contains(';') || value.contains("--") || value.contains("/*") {
                return Err("Valore predefinito non valido".into());
            }
            if !value.trim().is_empty() {
                def.push_str(&format!(" DEFAULT {value}"))
            }
        }
        defs.push(def)
    }
    let pk = columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| quote_ident(engine, &c.name))
        .collect::<Vec<_>>();
    if !pk.is_empty() {
        defs.push(format!("PRIMARY KEY ({})", pk.join(", ")))
    }
    Ok(format!(
        "CREATE TABLE {} (\n  {}\n);",
        quote_ident(engine, name),
        defs.join(",\n  ")
    ))
}
pub fn write_project(
    project: &codegen::GeneratedProject,
    destination: &Path,
) -> Result<(), String> {
    for file in &project.files {
        let path = Path::new(&file.path);
        if path.is_absolute()
            || file.path.contains(':')
            || path
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Percorso file non sicuro nel progetto".into());
        }
    }
    std::fs::create_dir_all(destination).map_err(|e| e.to_string())?;
    let base = destination.canonicalize().map_err(|e| e.to_string())?;
    // Preflight every path before writing any file.
    for file in &project.files {
        let path = base.join(&file.path);
        if path.exists() {
            return Err(format!(
                "Il file esiste già: {}. Scegli una cartella nuova.",
                path.display()
            ));
        }
        let mut cur = base.clone();
        for component in Path::new(&file.path).components() {
            cur.push(component);
            if std::fs::symlink_metadata(&cur)
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Err("Collegamenti simbolici non consentiti nella destinazione".into());
            }
        }
    }
    for file in &project.files {
        let path = base.join(&file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        use std::io::Write;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        output
            .write_all(file.content.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn lab_roundtrip_reset_and_export() {
        let tmp = tempfile::tempdir().unwrap();
        let state = AppState::new(tmp.path().into()).unwrap();
        let lab = state
            .call("lab_open", json!({"engine":"sqlite","dataset":"shop"}))
            .await
            .unwrap();
        let id = lab["sessionId"].as_str().unwrap();
        let result = state
            .call(
                "execute_query",
                json!({"sessionId":id,"query":"SELECT COUNT(*) AS n FROM customers"}),
            )
            .await
            .unwrap();
        assert_eq!(result["sets"][0]["rows"][0]["n"]["value"], "5");
        state
            .call(
                "execute_query",
                json!({"sessionId":id,"query":"DELETE FROM customers WHERE id=5"}),
            )
            .await
            .unwrap();
        state
            .call("lab_reset", json!({"sessionId":id,"dataset":"shop"}))
            .await
            .unwrap();
        let result = state
            .call(
                "read_table",
                json!({"sessionId":id,"table":"customers","limit":20}),
            )
            .await
            .unwrap();
        assert_eq!(result["sets"][0]["rows"].as_array().unwrap().len(), 5);
        let export=state.call("transfer_data",json!({"request":{"action":"export","sessionId":id,"table":"customers","format":"json"}})).await.unwrap();
        assert!(Path::new(export["path"].as_str().unwrap()).is_file());
    }
    #[test]
    fn project_rejects_traversal_before_writes() {
        let t = tempfile::tempdir().unwrap();
        let project = codegen::GeneratedProject {
            files: vec![codegen::GeneratedFile {
                path: "../escape.txt".into(),
                content: "bad".into(),
            }],
            command: "".into(),
            notes: vec![],
        };
        assert!(write_project(&project, &t.path().join("out")).is_err());
        assert!(!t.path().join("escape.txt").exists());
    }
    #[test]
    fn ddl_quotes_names_and_rejects_code_in_type() {
        assert!(safe_type("TEXT);DROP TABLE x;--").is_err());
        let sql = create_table_sql(
            "sqlite",
            "select",
            &[ColumnInfo {
                name: "id".into(),
                data_type: "INTEGER".into(),
                primary_key: true,
                ..Default::default()
            }],
        )
        .unwrap();
        assert!(sql.contains("\"select\""));
    }
    #[tokio::test]
    #[ignore = "Requires app-owned servers from native_qa_supervisor; never connects to user profiles."]
    async fn remote_adapters_live_contract() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/qa-active.json");
        let v: Value = serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        for c in v["connections"].as_array().unwrap() {
            let engine = c["engine"].as_str().unwrap();
            eprintln!("Core adapter live: {engine}");
            let secret = keyring::Entry::new(
                c["credentialService"].as_str().unwrap(),
                c["credentialAccount"].as_str().unwrap(),
            )
            .unwrap()
            .get_password()
            .unwrap();
            let p = ConnectionProfile {
                id: c["id"].as_str().unwrap().into(),
                name: "QA core".into(),
                engine: engine.into(),
                host: "127.0.0.1".into(),
                port: c["port"].as_u64().unwrap() as u16,
                database: "laboratory".into(),
                username: "dbm_lab".into(),
                laboratory: true,
                ..Default::default()
            };
            let s = Session::open(p, secret).await.unwrap();
            if engine == "mongodb" {
                let _ = s
                    .execute(r#"{"drop":"dbm_core_contract"}"#, BTreeMap::new())
                    .await;
                let inserted=s.execute(r#"{"insert":"dbm_core_contract","documents":[{"_id":{"$oid":"507f1f77bcf86cd799439011"},"id":{"$numberLong":"9007199254740993"},"label":"Udine; città","amount":{"$numberDecimal":"12345678901234567890.1234567890"}}]}"#,BTreeMap::new()).await.unwrap();
                assert_eq!(inserted.affected_rows, 1);
                let r = s
                    .execute(
                        r#"{"find":"dbm_core_contract","filter":{}}"#,
                        BTreeMap::new(),
                    )
                    .await
                    .unwrap();
                let row = &r.sets[0].rows[0];
                assert_eq!(row["id"].text(), "9007199254740993");
                assert_eq!(row["amount"].text(), "12345678901234567890.1234567890");
                let mut key = BTreeMap::new();
                key.insert("_id".into(), row["_id"].clone());
                let mut values = BTreeMap::new();
                values.insert("label".into(), CellValue::string("text", "Aggiornato"));
                s.apply(
                    "dbm_core_contract",
                    vec![DataChange {
                        kind: "update".into(),
                        key,
                        original: row.clone(),
                        values,
                    }],
                )
                .await
                .unwrap();
                s.execute(r#"{"drop":"dbm_core_contract"}"#, BTreeMap::new())
                    .await
                    .unwrap();
            } else {
                let q = quote_ident(engine, "dbm_core_contract");
                s.execute(&format!("DROP TABLE IF EXISTS {q}; CREATE TABLE {q}(id BIGINT PRIMARY KEY,label TEXT,amount DECIMAL(30,10));"),BTreeMap::new()).await.unwrap();
                let mut params = BTreeMap::new();
                let mut bind = Vec::new();
                for (i, val) in [
                    json!("9007199254740993"),
                    json!("Udine; città"),
                    json!("12345678901234567890.1234567890"),
                ]
                .into_iter()
                .enumerate()
                {
                    let k = if engine == "postgresql" {
                        (i + 1).to_string()
                    } else {
                        format!("p{}", i + 1)
                    };
                    bind.push(if engine == "postgresql" {
                        format!("${k}")
                    } else {
                        format!(":{k}")
                    });
                    params.insert(k, val);
                }
                s.execute(
                    &format!("INSERT INTO {q} VALUES ({})", bind.join(",")),
                    params,
                )
                .await
                .unwrap();
                let r = s
                    .execute(&format!("SELECT * FROM {q}"), BTreeMap::new())
                    .await
                    .unwrap();
                let row = &r.sets[0].rows[0];
                assert_eq!(row["id"].text(), "9007199254740993");
                assert_eq!(row["amount"].text(), "12345678901234567890.1234567890");
                let schema = s.introspect().await.unwrap();
                assert!(schema
                    .tables
                    .iter()
                    .find(|t| t.name == "dbm_core_contract")
                    .unwrap()
                    .columns
                    .iter()
                    .any(|c| c.name == "id" && c.primary_key));
                let mut key = BTreeMap::new();
                key.insert("id".into(), row["id"].clone());
                let mut values = BTreeMap::new();
                values.insert("label".into(), CellValue::string("text", "Aggiornato"));
                let change = DataChange {
                    kind: "update".into(),
                    key,
                    original: row.clone(),
                    values,
                };
                s.apply("dbm_core_contract", vec![change.clone()])
                    .await
                    .unwrap();
                assert!(s.apply("dbm_core_contract", vec![change]).await.is_err());
                s.execute(&format!("DROP TABLE {q}"), BTreeMap::new())
                    .await
                    .unwrap();
            }
        }
    }
    #[test]
    fn million_row_query_is_bounded() {
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE million(id INTEGER PRIMARY KEY,v TEXT);WITH RECURSIVE n(x)AS(VALUES(1)UNION ALL SELECT x+1 FROM n WHERE x<1000000)INSERT INTO million SELECT x,'record '||x FROM n;").unwrap();
        let r = sqlite::execute(&c, "SELECT * FROM million", &BTreeMap::new(), true).unwrap();
        assert_eq!(r.sets[0].rows.len(), sqlite::MAX_ROWS);
        assert!(r.sets[0].truncated);
    }
}
