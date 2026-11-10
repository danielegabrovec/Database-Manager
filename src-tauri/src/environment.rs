//! Local database environments. Only resources recorded in this registry are managed.
use chrono::Utc;
use futures_util::StreamExt;
use mongodb::{bson::doc, Client};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    process::{Child, Command},
    sync::Mutex,
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const MAX_DOWNLOAD: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED: u64 = 5 * 1024 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Engine {
    Sqlite,
    Postgresql,
    Mysql,
    Mariadb,
    Mongodb,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Existing,
    Sqlite,
    Docker,
    Native,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeDistribution {
    pub id: String,
    pub engine: Engine,
    pub version: String,
    pub url: String,
    /// Verified SHA-256 from the bundled catalog or an explicitly supplied manifest.
    pub sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEnvironmentRequest {
    pub name: String,
    pub engine: Engine,
    pub provider: Provider,
    #[serde(default)]
    pub laboratory: bool,
    /// Explicit image tag for Docker, e.g. 17, 8.4, 11.4, or 8.0.
    pub version: Option<String>,
    pub image_digest: Option<String>,
    pub distribution_id: Option<String>,
    /// Existing connections are registered only; credentials must be supplied separately.
    pub endpoint: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub name: String,
    pub engine: Engine,
    pub provider: Provider,
    pub laboratory: bool,
    pub version: Option<String>,
    pub image_digest: Option<String>,
    pub distribution_id: Option<String>,
    pub endpoint: String,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub status: String,
    pub created_at: String,
    pub last_error: Option<String>,
    pub resource_note: String,
    #[serde(default)]
    pub initialized: bool,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    environments: Vec<Environment>,
    distributions: Vec<NativeDistribution>,
}

#[derive(Clone)]
pub struct EnvironmentManager {
    app_data: PathBuf,
    archive_cache: PathBuf,
    operation: Arc<Mutex<()>>,
    children: Arc<Mutex<HashMap<String, Child>>>,
    #[cfg(windows)]
    jobs: Arc<Mutex<HashMap<String, NativeJob>>>,
}

impl EnvironmentManager {
    pub fn new(app_data: PathBuf) -> Result<Self> {
        #[cfg(debug_assertions)]
        let development_cache = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("artifacts")
            .join("cache");
        #[cfg(debug_assertions)]
        let archive_cache = if development_cache.is_dir() {
            development_cache
        } else {
            app_data.join("native-downloads")
        };
        #[cfg(not(debug_assertions))]
        let archive_cache = app_data.join("native-downloads");
        Self::with_archive_cache(app_data, archive_cache)
    }

    pub fn with_archive_cache(app_data: PathBuf, archive_cache: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(app_data.join("environments")).map_err(err)?;
        std::fs::create_dir_all(app_data.join("native-runtimes")).map_err(err)?;
        Ok(Self {
            app_data,
            archive_cache,
            operation: Arc::new(Mutex::new(())),
            children: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(windows)]
            jobs: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub async fn list(&self) -> Result<Vec<Environment>> {
        let mut environments = self.load()?.environments;
        for environment in &mut environments {
            // Persisted status is not evidence that a process survived an app or
            // computer restart. This lightweight check does not adopt a listener.
            if environment.status == "running"
                && matches!(environment.provider, Provider::Native | Provider::Docker)
            {
                if let Some(port) = environment.port {
                    if tokio::time::timeout(
                        Duration::from_millis(300),
                        tokio::net::TcpStream::connect(("127.0.0.1", port)),
                    )
                    .await
                    .map(|r| r.is_err())
                    .unwrap_or(true)
                    {
                        environment.status = "stopped".into();
                    }
                }
            }
        }
        Ok(environments)
    }
    pub async fn catalog(&self) -> Result<Vec<NativeDistribution>> {
        Ok(self.load()?.distributions)
    }

    pub async fn register_distribution(&self, distribution: NativeDistribution) -> Result<()> {
        let _guard = self.operation.lock().await;
        validate_distribution(&distribution)?;
        let mut registry = self.load()?;
        if registry
            .distributions
            .iter()
            .any(|d| d.id == distribution.id)
        {
            return Err("Identificatore distribuzione già presente; usare un nuovo identificatore per una versione diversa.".into());
        }
        registry.distributions.push(distribution);
        self.save(&registry)
    }

    /// Returns the connection password. Laboratory connections use a restricted role.
    pub fn password(&self, id: &str) -> Result<String> {
        let environment = self.find(id)?;
        if environment.laboratory && environment.engine != Engine::Sqlite {
            return keyring::Entry::new("DatabaseManager.Environments", &format!("{id}-lab"))
                .map_err(err)?
                .get_password()
                .map_err(err);
        }
        self.admin_password(id)
    }

    fn admin_password(&self, id: &str) -> Result<String> {
        validate_id(id)?;
        keyring::Entry::new("DatabaseManager.Environments", id)
            .map_err(err)?
            .get_password()
            .map_err(err)
    }

    pub async fn docker_available(&self) -> Result<String> {
        run(Command::new("docker").args(["info", "--format", "{{.OSType}}"]))
            .await
            .and_then(|s| {
                if s.trim() == "linux" {
                    Ok("Docker Linux disponibile".into())
                } else {
                    Err("È richiesto Docker con container Linux.".into())
                }
            })
    }

    /// Resolve only known database client tools inside an app-managed runtime.
    pub fn executable(&self, id: &str, name: &str) -> Result<PathBuf> {
        let environment = self.find(id)?;
        if environment.provider != Provider::Native {
            return Err("L’ambiente non usa un runtime nativo gestito.".into());
        }
        let allowed = [
            "pg_dump",
            "pg_restore",
            "psql",
            "mysqldump",
            "mysql",
            "mariadb-dump",
            "mariadb",
            "mongodump",
            "mongorestore",
        ];
        let base = name.strip_suffix(".exe").unwrap_or(name);
        if !allowed.contains(&base) {
            return Err("Strumento client non ammesso.".into());
        }
        self.assert_owner(id)?;
        if environment.engine == Engine::Mongodb && matches!(base, "mongodump" | "mongorestore") {
            return find_binary(
                &self.runtime_directory(&mongo_tools_distribution().id)?,
                &format!("{base}.exe"),
                0,
            )?
            .ok_or("Gli strumenti MongoDB Database Tools non sono ancora stati acquisiti.".into());
        }
        self.binary(&environment, &format!("{base}.exe"))
    }

    pub fn binary_path(&self, id: &str, name: &str) -> Result<PathBuf> {
        self.executable(id, name)
    }

    /// Explicit backup/restore actions may acquire the separate, verified MongoDB
    /// client tools. Calling this method never starts a server or changes PATH.
    pub async fn ensure_client_tool(&self, id: &str, name: &str) -> Result<PathBuf> {
        let environment = self.find(id)?;
        if environment.engine == Engine::Mongodb
            && matches!(name.trim_end_matches(".exe"), "mongodump" | "mongorestore")
        {
            let _guard = self.operation.lock().await;
            self.install_distribution(&mongo_tools_distribution())
                .await?;
        }
        self.executable(id, name)
    }

    pub async fn create(&self, request: CreateEnvironmentRequest) -> Result<Environment> {
        let _guard = self.operation.lock().await;
        if request.name.trim().is_empty() || request.name.len() > 120 {
            return Err("Nome ambiente richiesto (massimo 120 caratteri).".into());
        }
        if request.provider == Provider::Sqlite && request.engine != Engine::Sqlite {
            return Err("Il provider SQLite richiede il motore SQLite.".into());
        }
        if request.engine == Engine::Sqlite
            && !matches!(request.provider, Provider::Existing | Provider::Sqlite)
        {
            return Err("SQLite è incorporato: usare il provider SQLite.".into());
        }
        if request.laboratory && request.provider == Provider::Existing {
            return Err(
                "Un laboratorio deve usare risorse create dall’app, separate dai server esistenti."
                    .into(),
            );
        }
        if request.provider == Provider::Docker {
            validate_tag(
                request
                    .version
                    .as_deref()
                    .ok_or("Selezionare esplicitamente il tag dell’immagine Docker.")?,
            )?;
            if let Some(digest) = &request.image_digest {
                validate_digest(digest)?;
            }
            self.docker_available().await?;
        }
        let pinned_digest = if request.provider == Provider::Docker {
            Some(
                self.resolve_docker_digest(
                    request.engine,
                    request.version.as_deref().unwrap(),
                    request.image_digest.as_deref(),
                )
                .await?,
            )
        } else {
            request.image_digest.clone()
        };
        let distribution = if request.provider == Provider::Native {
            let id = request
                .distribution_id
                .as_deref()
                .ok_or("Aggiungere e selezionare una distribuzione ZIP con SHA-256 verificato.")?;
            let d = self
                .load()?
                .distributions
                .into_iter()
                .find(|d| d.id == id && d.engine == request.engine)
                .ok_or("Distribuzione verificata non trovata per questo motore.")?;
            validate_distribution(&d)?;
            Some(d)
        } else {
            None
        };
        let id = Uuid::new_v4().to_string();
        let port = if matches!(request.provider, Provider::Docker | Provider::Native) {
            Some(if let Some(port) = request.port {
                if port == 0 {
                    return Err("La porta deve essere compresa tra 1 e 65535.".into());
                }
                let reservation = std::net::TcpListener::bind(("127.0.0.1", port))
                    .map_err(|_| format!("La porta {port} è già occupata."))?;
                drop(reservation);
                port
            } else {
                free_port()?
            })
        } else {
            None
        };
        let directory = self.directory(&id)?;
        let username = match request.engine {
            Engine::Sqlite => None,
            _ if request.laboratory => Some("dbm_lab".into()),
            Engine::Mysql | Engine::Mariadb => Some("root".into()),
            _ => Some("dbm_admin".into()),
        };
        let endpoint = match request.provider {
            Provider::Existing => {
                let endpoint = request
                    .endpoint
                    .clone()
                    .ok_or("Specificare la connessione esistente.")?;
                if let Ok(url) = reqwest::Url::parse(&endpoint) {
                    if url.password().is_some() {
                        return Err("Non inserire password nell’URL dell’ambiente: usare l’archivio credenziali della connessione.".into());
                    }
                }
                endpoint
            }
            Provider::Sqlite => directory.join("data.sqlite3").to_string_lossy().to_string(),
            _ => format!(
                "{}://127.0.0.1:{}{}",
                scheme(request.engine),
                port.unwrap(),
                if request.laboratory {
                    if request.engine == Engine::Mongodb {
                        "/laboratory?authSource=laboratory&directConnection=true"
                    } else {
                        "/laboratory"
                    }
                } else if request.engine == Engine::Postgresql {
                    "/postgres"
                } else if request.engine == Engine::Mongodb {
                    "/?authSource=admin&directConnection=true"
                } else {
                    ""
                }
            ),
        };
        let mut environment = Environment {
            id: id.clone(),
            name: request.name.trim().into(),
            engine: request.engine,
            provider: request.provider,
            laboratory: request.laboratory,
            version: distribution
                .as_ref()
                .map(|d| d.version.clone())
                .or(request.version),
            image_digest: pinned_digest,
            distribution_id: request.distribution_id,
            endpoint,
            port,
            username,
            status: "preparing".into(),
            created_at: Utc::now().to_rfc3339(),
            last_error: None,
            initialized: false,
            resource_note: if request.laboratory {
                "Istanza dati separata. Il laboratorio non esegue programmi di sistema e non costituisce una sandbox per codice ostile.".into()
            } else {
                "L’app gestisce solo le risorse identificate nel proprio registro.".into()
            },
        };
        if request.provider != Provider::Existing {
            std::fs::create_dir_all(&directory).map_err(err)?;
            std::fs::write(directory.join(".dbm-owner"), id.as_bytes()).map_err(err)?;
        }
        if matches!(request.provider, Provider::Docker | Provider::Native) {
            let secret = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
            keyring::Entry::new("DatabaseManager.Environments", &id)
                .map_err(err)?
                .set_password(&secret)
                .map_err(err)?;
            if request.laboratory {
                let laboratory_secret =
                    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                keyring::Entry::new("DatabaseManager.Environments", &format!("{id}-lab"))
                    .map_err(err)?
                    .set_password(&laboratory_secret)
                    .map_err(err)?;
            }
        }
        let mut registry = self.load()?;
        registry.environments.push(environment.clone());
        self.save(&registry)?;
        let outcome = self
            .prepare_and_start(&environment, distribution.as_ref())
            .await;
        match outcome {
            Ok(()) => {
                environment.status = if request.provider == Provider::Existing {
                    "external"
                } else {
                    "running"
                }
                .into();
                environment.initialized = true;
            }
            Err(e) => {
                // Failed provisioning must not leave a listener with bootstrap credentials.
                if request.provider != Provider::Existing {
                    let _ = self.stop_inner(&environment).await;
                }
                environment.status = "error".into();
                environment.last_error = Some(e);
            }
        }
        self.replace(&environment)?;
        Ok(environment)
    }

    pub async fn start(&self, id: &str) -> Result<Environment> {
        let _guard = self.operation.lock().await;
        let mut environment = self.find(id)?;
        if environment.provider == Provider::Existing {
            return Err("Un server esterno non viene avviato dall’app.".into());
        }
        self.assert_owner(id)?;
        if !environment.initialized {
            return Err(
                "Preparazione incompleta: consultare l’errore e ricreare l’ambiente.".into(),
            );
        }
        if environment.provider == Provider::Docker && environment.image_digest.is_none() {
            environment.image_digest = Some(
                self.resolve_docker_digest(
                    environment.engine,
                    environment
                        .version
                        .as_deref()
                        .ok_or("Versione immagine mancante.")?,
                    None,
                )
                .await?,
            );
            self.write_compose(&environment)?;
            self.replace(&environment)?;
        }
        let outcome = match environment.provider {
            Provider::Sqlite => Ok(()),
            Provider::Docker => self.start_docker(&environment, false).await,
            Provider::Native => self.start_native(&environment, false).await,
            Provider::Existing => unreachable!(),
        };
        match outcome {
            Ok(()) => {
                environment.status = "running".into();
                environment.last_error = None;
            }
            Err(e) => {
                environment.status = "error".into();
                environment.last_error = Some(e);
            }
        }
        self.replace(&environment)?;
        Ok(environment)
    }

    pub async fn stop(&self, id: &str) -> Result<Environment> {
        let _guard = self.operation.lock().await;
        let mut environment = self.find(id)?;
        self.stop_inner(&environment).await?;
        environment.status = "stopped".into();
        environment.last_error = None;
        self.replace(&environment)?;
        Ok(environment)
    }

    /// Reset is intentionally limited to disposable laboratory instances.
    pub async fn reset(&self, id: &str) -> Result<Environment> {
        let _guard = self.operation.lock().await;
        let mut environment = self.find(id)?;
        if !environment.laboratory || environment.provider == Provider::Existing {
            return Err("Il reset è disponibile solo per laboratori creati dall’app.".into());
        }
        self.assert_owner(id)?;
        self.stop_inner(&environment).await?;
        let directory = self.directory(id)?;
        match environment.provider {
            Provider::Sqlite => {
                for filename in ["data.sqlite3", "data.sqlite3-wal", "data.sqlite3-shm"] {
                    let path = directory.join(filename);
                    if path.exists() {
                        std::fs::remove_file(path).map_err(err)?;
                    }
                }
            }
            Provider::Docker => {
                self.compose(&environment, &["down", "--volumes", "--remove-orphans"])
                    .await?;
            }
            Provider::Native => {
                remove_owned_child(&directory, "data")?;
            }
            Provider::Existing => unreachable!(),
        }
        environment.initialized = false;
        self.replace(&environment)?;
        let distribution = environment.distribution_id.as_ref().and_then(|id| {
            self.load()
                .ok()?
                .distributions
                .into_iter()
                .find(|d| &d.id == id)
        });
        match self
            .prepare_and_start(&environment, distribution.as_ref())
            .await
        {
            Ok(()) => {
                environment.status = "running".into();
                environment.initialized = true;
                environment.last_error = None;
            }
            Err(e) => {
                environment.status = "error".into();
                environment.last_error = Some(e);
            }
        }
        self.replace(&environment)?;
        Ok(environment)
    }

    pub async fn delete(&self, id: &str, delete_data: bool) -> Result<()> {
        let _guard = self.operation.lock().await;
        let environment = self.find(id)?;
        if environment.provider != Provider::Existing {
            if !delete_data {
                return Err("Per rimuovere un ambiente gestito confermare l’eliminazione dei suoi dati; per conservarli usare Arresta.".into());
            }
            self.assert_owner(id)?;
            if environment.provider == Provider::Docker {
                self.compose(&environment, &["down", "--volumes", "--remove-orphans"])
                    .await?;
            } else {
                self.stop_inner(&environment).await?;
            }
            let directory = self.directory(id)?;
            assert_safe_tree(&directory)?;
            std::fs::remove_dir_all(directory).map_err(err)?;
            if let Ok(entry) = keyring::Entry::new("DatabaseManager.Environments", id) {
                let _ = entry.delete_credential();
            }
            if let Ok(entry) =
                keyring::Entry::new("DatabaseManager.Environments", &format!("{id}-lab"))
            {
                let _ = entry.delete_credential();
            }
        }
        let mut registry = self.load()?;
        registry.environments.retain(|e| e.id != id);
        self.save(&registry)
    }

    async fn prepare_and_start(
        &self,
        environment: &Environment,
        distribution: Option<&NativeDistribution>,
    ) -> Result<()> {
        let result = match environment.provider {
            Provider::Existing => Ok(()),
            Provider::Sqlite => {
                let new_file = !Path::new(&environment.endpoint).exists();
                let connection = rusqlite::Connection::open(&environment.endpoint).map_err(err)?;
                if new_file {
                    connection
                        .pragma_update(None, "user_version", 0)
                        .map_err(err)?;
                }
                Ok(())
            }
            Provider::Docker => {
                self.write_compose(environment)?;
                self.start_docker(environment, true).await
            }
            Provider::Native => {
                let distribution = distribution.ok_or("Distribuzione mancante.")?;
                self.install_distribution(distribution).await?;
                self.initialize_native(environment).await?;
                self.start_native(environment, true).await
            }
        };
        result?;
        if environment.laboratory
            && matches!(environment.provider, Provider::Native | Provider::Docker)
        {
            self.create_laboratory_role(environment).await?;
        }
        Ok(())
    }

    fn load(&self) -> Result<Registry> {
        let path = self.app_data.join("environment-registry.json");
        if !path.exists() {
            return Ok(Registry {
                environments: Vec::new(),
                distributions: bundled_distributions(),
            });
        }
        let bytes = std::fs::read(path).map_err(err)?;
        let mut registry: Registry = serde_json::from_slice(&bytes).map_err(err)?;
        for distribution in bundled_distributions() {
            if !registry
                .distributions
                .iter()
                .any(|d| d.id == distribution.id)
            {
                registry.distributions.push(distribution);
            }
        }
        Ok(registry)
    }
    fn save(&self, registry: &Registry) -> Result<()> {
        let temporary = self.app_data.join("environment-registry.json.tmp");
        std::fs::write(
            &temporary,
            serde_json::to_vec_pretty(registry).map_err(err)?,
        )
        .map_err(err)?;
        std::fs::rename(temporary, self.app_data.join("environment-registry.json")).map_err(err)
    }
    fn replace(&self, environment: &Environment) -> Result<()> {
        let mut registry = self.load()?;
        let entry = registry
            .environments
            .iter_mut()
            .find(|e| e.id == environment.id)
            .ok_or("Ambiente non trovato.")?;
        *entry = environment.clone();
        self.save(&registry)
    }
    fn find(&self, id: &str) -> Result<Environment> {
        validate_id(id)?;
        self.load()?
            .environments
            .into_iter()
            .find(|e| e.id == id)
            .ok_or("Ambiente non trovato.".into())
    }
    fn directory(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.app_data.join("environments").join(id))
    }
    fn assert_owner(&self, id: &str) -> Result<()> {
        let directory = self.directory(id)?;
        if std::fs::symlink_metadata(&directory)
            .map_err(err)?
            .file_type()
            .is_symlink()
        {
            return Err("Directory ambiente non valida: collegamento simbolico.".into());
        }
        if std::fs::read_to_string(directory.join(".dbm-owner")).map_err(err)? != id {
            return Err("Ownership ambiente non verificabile.".into());
        }
        Ok(())
    }

    fn write_compose(&self, environment: &Environment) -> Result<()> {
        self.assert_owner(&environment.id)?;
        let version = environment
            .version
            .as_deref()
            .ok_or("Versione immagine mancante.")?;
        validate_tag(version)?;
        let image = format!(
            "{}:{}{}",
            image_name(environment.engine)?,
            version,
            environment
                .image_digest
                .as_ref()
                .map(|d| format!("@sha256:{d}"))
                .unwrap_or_default()
        );
        let mut variables = serde_json::Map::new();
        let (container_port, mount, command) = match environment.engine {
            Engine::Postgresql => {
                variables.insert("POSTGRES_USER".into(), "dbm_admin".into());
                variables.insert(
                    "POSTGRES_PASSWORD".into(),
                    "${DBM_PASSWORD:?Credenziale mancante}".into(),
                );
                let major = version
                    .split(['.', '-'])
                    .next()
                    .and_then(|v| v.parse::<u16>().ok())
                    .ok_or("Per PostgreSQL selezionare un tag con versione numerica.")?;
                (
                    5432,
                    if major >= 18 {
                        "/var/lib/postgresql"
                    } else {
                        "/var/lib/postgresql/data"
                    },
                    serde_json::Value::Null,
                )
            }
            Engine::Mysql => {
                variables.insert(
                    "MYSQL_ROOT_PASSWORD".into(),
                    "${DBM_PASSWORD:?Credenziale mancante}".into(),
                );
                (
                    3306,
                    "/var/lib/mysql",
                    serde_json::json!(["--local-infile=0"]),
                )
            }
            Engine::Mariadb => {
                variables.insert(
                    "MARIADB_ROOT_PASSWORD".into(),
                    "${DBM_PASSWORD:?Credenziale mancante}".into(),
                );
                (
                    3306,
                    "/var/lib/mysql",
                    serde_json::json!(["--local-infile=0"]),
                )
            }
            Engine::Mongodb => {
                variables.insert("MONGO_INITDB_ROOT_USERNAME".into(), "dbm_admin".into());
                variables.insert(
                    "MONGO_INITDB_ROOT_PASSWORD".into(),
                    "${DBM_PASSWORD:?Credenziale mancante}".into(),
                );
                variables.insert(
                    "DBM_MONGO_KEY".into(),
                    "${DBM_MONGO_KEY:?Chiave mancante}".into(),
                );
                (
                    27017,
                    "/data/db",
                    serde_json::json!([
                        "mongod",
                        "--replSet",
                        "dbm",
                        "--keyFile",
                        "/data/configdb/dbm-keyfile",
                        "--bind_ip_all"
                    ]),
                )
            }
            Engine::Sqlite => return Err("SQLite non richiede un container.".into()),
        };
        let mut service = serde_json::json!({
            "image": image, "environment": variables,
            "ports": [format!("127.0.0.1:{}:{container_port}", environment.port.ok_or("Porta mancante.")?)],
            "volumes": [format!("data:{mount}")],
            "labels": {"com.databasemanager.owner": environment.id},
            "restart": "no", "mem_limit": "1g", "cpus": 1.0,
            "logging": {"driver":"json-file", "options":{"max-size":"10m", "max-file":"2"}}
        });
        if !command.is_null() {
            service["command"] = command;
        }
        let mut volumes =
            serde_json::json!({"data":{"labels":{"com.databasemanager.owner":environment.id}}});
        if environment.engine == Engine::Mongodb {
            service["volumes"]
                .as_array_mut()
                .unwrap()
                .push("config:/data/configdb".into());
            volumes["config"] =
                serde_json::json!({"labels":{"com.databasemanager.owner":environment.id}});
        }
        let config = serde_json::json!({"name":project_name(&environment.id),"services":{"database":service},"volumes":volumes});
        std::fs::write(
            self.directory(&environment.id)?.join("compose.yaml"),
            serde_json::to_vec_pretty(&config).map_err(err)?,
        )
        .map_err(err)
    }

    async fn compose(&self, environment: &Environment, args: &[&str]) -> Result<String> {
        self.assert_owner(&environment.id)?;
        let secret = self.admin_password(&environment.id)?;
        let mut command = Command::new("docker");
        command
            .arg("compose")
            .arg("--project-name")
            .arg(project_name(&environment.id))
            .arg("--file")
            .arg(self.directory(&environment.id)?.join("compose.yaml"));
        command
            .args(args)
            .env("DBM_PASSWORD", &secret)
            .env("DBM_MONGO_KEY", mongo_key(&secret));
        run(&mut command).await.map_err(|e| redact(e, &secret))
    }

    async fn start_docker(&self, environment: &Environment, initialize: bool) -> Result<()> {
        if initialize && environment.engine == Engine::Mongodb {
            self.compose(environment, &["run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "database", "-c", "umask 077; printf '%s' \"$DBM_MONGO_KEY\" > /data/configdb/dbm-keyfile && chown mongodb:mongodb /data/configdb/dbm-keyfile && chmod 400 /data/configdb/dbm-keyfile"]).await?;
        }
        self.compose(environment, &["up", "-d"]).await?;
        wait_tcp(environment.port.unwrap(), 90).await?;
        if environment.engine == Engine::Mongodb {
            self.bootstrap_mongo(environment, initialize, false).await?;
        } else {
            self.wait_sql_ready(environment, false).await?;
        }
        Ok(())
    }

    async fn resolve_docker_digest(
        &self,
        engine: Engine,
        version: &str,
        requested: Option<&str>,
    ) -> Result<String> {
        validate_tag(version)?;
        let image = if let Some(digest) = requested {
            validate_digest(digest)?;
            format!(
                "{}:{version}@sha256:{}",
                image_name(engine)?,
                digest.to_lowercase()
            )
        } else {
            format!("{}:{version}", image_name(engine)?)
        };
        run(Command::new("docker").args(["pull", &image])).await?;
        if let Some(digest) = requested {
            return Ok(digest.to_lowercase());
        }
        let result = run(Command::new("docker").args([
            "image",
            "inspect",
            "--format",
            "{{json .RepoDigests}}",
            &image,
        ]))
        .await?;
        let digests: Vec<String> = serde_json::from_str(result.trim()).map_err(|_| {
            "Docker non ha restituito digest verificabili per l’immagine.".to_string()
        })?;
        for reference in digests {
            if let Some((_, digest)) = reference.rsplit_once("@sha256:") {
                if validate_digest(digest).is_ok() {
                    return Ok(digest.to_lowercase());
                }
            }
        }
        Err("Digest immagine mancante: creazione interrotta per evitare un ambiente legato a un tag mutabile.".into())
    }

    async fn install_distribution(&self, distribution: &NativeDistribution) -> Result<()> {
        validate_distribution(distribution)?;
        let destination = self.runtime_directory(&distribution.id)?;
        if destination.join(".dbm-sha256").exists() {
            if std::fs::read_to_string(destination.join(".dbm-sha256")).map_err(err)?
                == distribution.sha256.to_lowercase()
            {
                return Ok(());
            }
            return Err("Il runtime installato non corrisponde all’hash del catalogo.".into());
        }
        std::fs::create_dir_all(&self.archive_cache).map_err(err)?;
        let url = reqwest::Url::parse(&distribution.url).map_err(err)?;
        let filename = url
            .path_segments()
            .and_then(|mut s| s.next_back())
            .ok_or("Nome archivio mancante.")?;
        if filename.contains(['/', '\\', ':']) || filename.is_empty() {
            return Err("Nome archivio non valido.".into());
        }
        let archive_path = self.archive_cache.join(filename);
        if !archive_path.exists() {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(600))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(err)?;
            let response = client
                .get(&distribution.url)
                .send()
                .await
                .map_err(err)?
                .error_for_status()
                .map_err(err)?;
            if response.content_length().unwrap_or(0) > MAX_DOWNLOAD {
                return Err("Archivio troppo grande.".into());
            }
            let temporary = self
                .archive_cache
                .join(format!("{}.download", Uuid::new_v4()));
            let mut file = tokio::fs::File::create(&temporary).await.map_err(err)?;
            let mut stream = response.bytes_stream();
            let mut downloaded = 0_u64;
            use tokio::io::AsyncWriteExt;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(err)?;
                downloaded += chunk.len() as u64;
                if downloaded > MAX_DOWNLOAD {
                    drop(file);
                    let _ = std::fs::remove_file(&temporary);
                    return Err("Archivio troppo grande.".into());
                }
                file.write_all(&chunk).await.map_err(err)?;
            }
            file.flush().await.map_err(err)?;
            drop(file);
            std::fs::rename(&temporary, &archive_path).map_err(err)?;
        }
        let archive_for_hash = archive_path.clone();
        let actual = tokio::task::spawn_blocking(move || hash_file(&archive_for_hash))
            .await
            .map_err(err)??;
        if actual != distribution.sha256.to_lowercase() {
            return Err(
                "SHA-256 dell’archivio diverso dal valore approvato: installazione interrotta."
                    .into(),
            );
        }
        let staging = self
            .app_data
            .join("native-runtimes")
            .join(format!("stage-{}", Uuid::new_v4()));
        let staging_clone = staging.clone();
        let extracted = tokio::task::spawn_blocking(move || {
            extract_archive(
                std::fs::File::open(archive_path).map_err(err)?,
                &staging_clone,
            )
        })
        .await
        .map_err(err)?;
        if let Err(e) = extracted {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
        std::fs::write(staging.join(".dbm-sha256"), actual).map_err(err)?;
        if destination.exists() {
            return Err(
                "Directory runtime già presente senza verifica; rimozione manuale richiesta."
                    .into(),
            );
        }
        // Windows security scanners may briefly retain a handle to an extracted
        // executable, preventing a directory rename immediately after extraction.
        let runtime_root = self
            .app_data
            .join("native-runtimes")
            .canonicalize()
            .map_err(err)?;
        if staging
            .parent()
            .ok_or("Directory staging non valida.")?
            .canonicalize()
            .map_err(err)?
            != runtime_root
            || destination
                .parent()
                .ok_or("Directory runtime non valida.")?
                .canonicalize()
                .map_err(err)?
                != runtime_root
        {
            return Err("Percorso runtime esterno all’area gestita.".into());
        }
        let mut last_error = None;
        for _ in 0..50 {
            match std::fs::rename(&staging, &destination) {
                Ok(()) => return Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                    last_error = Some(e);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(e) => return Err(err(e)),
            }
        }
        Err(format!(
            "Impossibile completare il runtime (file temporaneamente in uso): {}",
            last_error.map(err).unwrap_or_default()
        ))
    }
    fn runtime_directory(&self, id: &str) -> Result<PathBuf> {
        validate_slug(id)?;
        Ok(self.app_data.join("native-runtimes").join(id))
    }
    fn binary(&self, environment: &Environment, filename: &str) -> Result<PathBuf> {
        let directory = self.runtime_directory(
            environment
                .distribution_id
                .as_deref()
                .ok_or("Distribuzione mancante.")?,
        )?;
        find_binary(&directory, filename, 0)?
            .ok_or_else(|| format!("{filename} non trovato nella distribuzione verificata."))
    }

    async fn initialize_native(&self, environment: &Environment) -> Result<()> {
        self.assert_owner(&environment.id)?;
        let directory = self.directory(&environment.id)?;
        let data = directory.join("data");
        if data.exists() && std::fs::read_dir(&data).map_err(err)?.next().is_some() {
            return Err("La directory dati è già popolata: inizializzazione rifiutata.".into());
        }
        std::fs::create_dir_all(&data).map_err(err)?;
        let secret = self.admin_password(&environment.id)?;
        match environment.engine {
            Engine::Postgresql => {
                let password_file = directory.join("bootstrap-password.tmp");
                std::fs::write(&password_file, &secret).map_err(err)?;
                let result = run(Command::new(self.binary(environment, "initdb.exe")?)
                    .arg("-D")
                    .arg(&data)
                    .args([
                        "-U",
                        "dbm_admin",
                        "--auth-host=scram-sha-256",
                        "--auth-local=scram-sha-256",
                        "--encoding=UTF8",
                        "--locale=C",
                    ])
                    .arg(format!("--pwfile={}", password_file.display())))
                .await;
                let _ = std::fs::remove_file(password_file);
                result.map_err(|e| redact(e, &secret))?;
            }
            Engine::Mysql => {
                let binary = self.binary(environment, "mysqld.exe")?;
                let base = binary
                    .parent()
                    .and_then(Path::parent)
                    .ok_or("Distribuzione MySQL non valida.")?;
                run(Command::new(&binary)
                    .arg("--no-defaults")
                    .arg(format!("--basedir={}", base.display()))
                    .arg(format!("--datadir={}", data.display()))
                    .arg("--initialize-insecure"))
                .await?;
            }
            Engine::Mariadb => {
                run(
                    Command::new(self.binary(environment, "mariadb-install-db.exe")?)
                        .arg(format!("--datadir={}", data.display()))
                        .arg(format!("--password={secret}"))
                        .arg(format!("--port={}", environment.port.unwrap())),
                )
                .await
                .map_err(|e| redact(e, &secret))?;
            }
            Engine::Mongodb => {
                std::fs::write(directory.join("mongo-keyfile"), mongo_key(&secret)).map_err(err)?;
            }
            Engine::Sqlite => return Err("SQLite non richiede installazione nativa.".into()),
        }
        Ok(())
    }

    async fn start_native(&self, environment: &Environment, initialize: bool) -> Result<()> {
        self.assert_owner(&environment.id)?;
        let mut children = self.children.lock().await;
        if let Some(child) = children.get_mut(&environment.id) {
            if child.try_wait().map_err(err)?.is_none() {
                return Ok(());
            }
        }
        let directory = self.directory(&environment.id)?;
        let data = directory.join("data");
        let port = environment.port.ok_or("Porta mancante.")?;
        // A foreign listener is never adopted as this environment.
        let reservation = std::net::TcpListener::bind(("127.0.0.1", port)).map_err(|_| {
            "Porta occupata. Arrestare l’altro processo o ricreare l’ambiente su una porta libera."
        })?;
        let filename = match environment.engine {
            Engine::Postgresql => "postgres.exe",
            Engine::Mysql => "mysqld.exe",
            Engine::Mariadb => "mariadbd.exe",
            Engine::Mongodb => "mongod.exe",
            _ => return Err("Motore nativo non valido.".into()),
        };
        let binary = self.binary(environment, filename)?;
        let mut command = Command::new(&binary);
        match environment.engine {
            Engine::Postgresql => {
                command
                    .arg("-D")
                    .arg(&data)
                    .args(["-h", "127.0.0.1", "-p", &port.to_string()]);
            }
            Engine::Mysql | Engine::Mariadb => {
                let base = binary
                    .parent()
                    .and_then(Path::parent)
                    .ok_or("Distribuzione non valida.")?;
                command
                    .arg("--no-defaults")
                    .arg(format!("--basedir={}", base.display()))
                    .arg(format!("--datadir={}", data.display()))
                    .arg(format!("--port={port}"))
                    .args(["--bind-address=127.0.0.1", "--local-infile=0", "--console"]);
                if environment.engine == Engine::Mysql {
                    command.arg("--mysqlx=OFF");
                }
            }
            Engine::Mongodb => {
                command
                    .arg("--dbpath")
                    .arg(&data)
                    .args([
                        "--bind_ip",
                        "127.0.0.1",
                        "--port",
                        &port.to_string(),
                        "--replSet",
                        "dbm",
                        "--auth",
                        "--keyFile",
                    ])
                    .arg(directory.join("mongo-keyfile"));
            }
            _ => unreachable!(),
        }
        let stdout = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(directory.join("server.log"))
            .map_err(err)?;
        command
            .stdout(stdout.try_clone().map_err(err)?)
            .stderr(stdout)
            .stdin(std::process::Stdio::null())
            .kill_on_drop(environment.laboratory);
        hide(&mut command);
        drop(reservation);
        let mut child = command.spawn().map_err(err)?;
        #[cfg(windows)]
        if environment.laboratory {
            match NativeJob::attach(&child) {
                Ok(job) => {
                    self.jobs.lock().await.insert(environment.id.clone(), job);
                }
                Err(e) => {
                    let _ = child.kill().await;
                    return Err(e);
                }
            }
        }
        children.insert(environment.id.clone(), child);
        drop(children);
        wait_tcp(port, 90).await?;
        if environment.engine == Engine::Mysql && initialize {
            let secret = self.admin_password(&environment.id)?;
            let sql = format!("ALTER USER 'root'@'localhost' IDENTIFIED BY '{secret}';");
            let mut last_error = String::new();
            for _ in 0..60 {
                let result = run(Command::new(self.binary(environment, "mysql.exe")?)
                    .args([
                        "--no-defaults",
                        "--protocol=TCP",
                        "--host=127.0.0.1",
                        "--user=root",
                    ])
                    .arg(format!("--port={port}"))
                    .args(["--execute", &sql]))
                .await;
                match result {
                    Ok(_) => {
                        last_error.clear();
                        break;
                    }
                    Err(e) => {
                        last_error = redact(e, &secret);
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
            }
            if !last_error.is_empty() {
                return Err(last_error);
            }
        }
        if environment.engine == Engine::Mongodb {
            self.bootstrap_mongo(environment, initialize, true).await?;
        } else {
            self.wait_sql_ready(environment, true).await?;
        }
        Ok(())
    }

    async fn wait_sql_ready(&self, environment: &Environment, native: bool) -> Result<()> {
        let secret = self.admin_password(&environment.id)?;
        for _ in 0..120 {
            let result = if native {
                match environment.engine {
                    Engine::Postgresql => {
                        run(Command::new(self.binary(environment, "psql.exe")?)
                            .args([
                                "-h",
                                "127.0.0.1",
                                "-U",
                                "dbm_admin",
                                "-d",
                                "postgres",
                                "-p",
                                &environment.port.unwrap().to_string(),
                                "-c",
                                "SELECT 1",
                            ])
                            .env("PGPASSWORD", &secret))
                        .await
                    }
                    Engine::Mysql | Engine::Mariadb => {
                        let binary = if environment.engine == Engine::Mysql {
                            "mysqladmin.exe"
                        } else {
                            "mariadb-admin.exe"
                        };
                        run(Command::new(self.binary(environment, binary)?)
                            .args([
                                "--no-defaults",
                                "--protocol=TCP",
                                "--host=127.0.0.1",
                                "--user=root",
                                "--port",
                                &environment.port.unwrap().to_string(),
                                "ping",
                            ])
                            .env("MYSQL_PWD", &secret))
                        .await
                    }
                    _ => return Ok(()),
                }
            } else {
                match environment.engine {
                    Engine::Postgresql => self.compose(environment, &["exec", "-T", "database", "psql", "-U", "dbm_admin", "-d", "postgres", "-c", "SELECT 1"]).await,
                    Engine::Mysql => self.compose(environment, &["exec", "-T", "database", "sh", "-c", "MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\" mysql --protocol=TCP -h127.0.0.1 -uroot -e 'SELECT 1'"]).await,
                    Engine::Mariadb => self.compose(environment, &["exec", "-T", "database", "sh", "-c", "MYSQL_PWD=\"$MARIADB_ROOT_PASSWORD\" mariadb --protocol=TCP -h127.0.0.1 -uroot -e 'SELECT 1'"]).await,
                    _ => return Ok(()),
                }
            };
            if result.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err(
            "Il server non supera il controllo di disponibilità. Consultare i log dell’ambiente."
                .into(),
        )
    }

    async fn bootstrap_mongo(
        &self,
        environment: &Environment,
        initialize: bool,
        native: bool,
    ) -> Result<()> {
        let port = environment.port.unwrap();
        let unauthenticated = Client::with_uri_str(format!("mongodb://127.0.0.1:{port}/?directConnection=true&serverSelectionTimeoutMS=1000&connectTimeoutMS=1000")).await.map_err(err)?;
        let secret = self.admin_password(&environment.id)?;
        let authenticated = Client::with_uri_str(format!("mongodb://dbm_admin:{secret}@127.0.0.1:{port}/?authSource=admin&directConnection=true&serverSelectionTimeoutMS=1000&connectTimeoutMS=1000")).await.map_err(err)?;
        if initialize {
            let bootstrap = if native {
                &unauthenticated
            } else {
                &authenticated
            };
            let mut started = false;
            for _ in 0..90 {
                let result = bootstrap.database("admin").run_command(doc! {"replSetInitiate":{"_id":"dbm","members":[{"_id":0,"host":if native { format!("localhost:{port}") } else { "localhost:27017".into() }}]}}).await;
                match result {
                    Ok(_) => {
                        started = true;
                        break;
                    }
                    Err(e) if e.to_string().contains("already initialized") => {
                        started = true;
                        break;
                    }
                    Err(_) => tokio::time::sleep(Duration::from_millis(500)).await,
                }
            }
            if !started {
                return Err(
                    "Impossibile inizializzare il replica set MongoDB. Consultare i log.".into(),
                );
            }
            for _ in 0..90 {
                if unauthenticated
                    .database("admin")
                    .run_command(doc! {"hello":1})
                    .await
                    .ok()
                    .and_then(|d| d.get_bool("isWritablePrimary").ok())
                    == Some(true)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            if native {
                unauthenticated.database("admin").run_command(doc! {"createUser":"dbm_admin","pwd":&secret,"roles":[{"role":"root","db":"admin"}]}).await.map_err(|e| redact(e.to_string(), &secret))?;
            }
        }
        for _ in 0..90 {
            if authenticated
                .database("admin")
                .run_command(doc! {"connectionStatus":1})
                .await
                .is_ok()
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Err("MongoDB non pronto con autenticazione. Consultare i log.".into())
    }

    async fn create_laboratory_role(&self, environment: &Environment) -> Result<()> {
        let secret = self.password(&environment.id)?;
        match environment.engine {
            Engine::Postgresql => {
                self.admin_sql(environment, &format!("CREATE ROLE dbm_lab LOGIN PASSWORD '{secret}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;")).await.map_err(|e|redact(e,&secret))?;
                self.admin_sql(environment, "CREATE DATABASE laboratory OWNER dbm_lab;")
                    .await?;
            }
            Engine::Mysql | Engine::Mariadb => {
                self.admin_sql(environment, &format!("CREATE DATABASE laboratory; CREATE USER 'dbm_lab'@'%' IDENTIFIED BY '{secret}'; GRANT ALL PRIVILEGES ON laboratory.* TO 'dbm_lab'@'%';")).await.map_err(|e|redact(e,&secret))?;
            }
            Engine::Mongodb => {
                let admin = self.admin_password(&environment.id)?;
                let uri = format!("mongodb://dbm_admin:{admin}@127.0.0.1:{}/?authSource=admin&directConnection=true&serverSelectionTimeoutMS=3000", environment.port.unwrap());
                let client = Client::with_uri_str(uri).await.map_err(err)?;
                client.database("laboratory").run_command(doc!{"createUser":"dbm_lab","pwd":&secret,"roles":[{"role":"readWrite","db":"laboratory"},{"role":"dbAdmin","db":"laboratory"}]}).await.map_err(|e|redact(redact(e.to_string(),&secret),&admin))?;
            }
            Engine::Sqlite => {}
        }
        Ok(())
    }

    async fn admin_sql(&self, environment: &Environment, sql: &str) -> Result<String> {
        let secret = self.admin_password(&environment.id)?;
        let port = environment.port.unwrap().to_string();
        if environment.provider == Provider::Native {
            let binary = match environment.engine {
                Engine::Postgresql => "psql.exe",
                Engine::Mysql => "mysql.exe",
                Engine::Mariadb => "mariadb.exe",
                _ => return Err("Motore SQL richiesto.".into()),
            };
            let mut command = Command::new(self.binary(environment, binary)?);
            if environment.engine == Engine::Postgresql {
                command
                    .args([
                        "-h",
                        "127.0.0.1",
                        "-p",
                        &port,
                        "-U",
                        "dbm_admin",
                        "-d",
                        "postgres",
                        "-v",
                        "ON_ERROR_STOP=1",
                        "-c",
                        sql,
                    ])
                    .env("PGPASSWORD", &secret);
            } else {
                command
                    .args([
                        "--no-defaults",
                        "--protocol=TCP",
                        "--host=127.0.0.1",
                        "--user=root",
                        "--port",
                        &port,
                        "--execute",
                        sql,
                    ])
                    .env("MYSQL_PWD", &secret);
            }
            run(&mut command).await.map_err(|e| redact(e, &secret))
        } else if environment.engine == Engine::Postgresql {
            self.compose(
                environment,
                &[
                    "exec",
                    "-T",
                    "database",
                    "psql",
                    "-U",
                    "dbm_admin",
                    "-d",
                    "postgres",
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-c",
                    sql,
                ],
            )
            .await
        } else {
            let binary = if environment.engine == Engine::Mysql {
                "mysql"
            } else {
                "mariadb"
            };
            self.compose(
                environment,
                &[
                    "exec",
                    "-T",
                    "--env",
                    &format!("MYSQL_PWD={secret}"),
                    "database",
                    binary,
                    "--protocol=TCP",
                    "--host=127.0.0.1",
                    "--user=root",
                    "--execute",
                    sql,
                ],
            )
            .await
        }
    }

    async fn stop_inner(&self, environment: &Environment) -> Result<()> {
        if environment.provider == Provider::Existing {
            return Err("L’app non arresta server esterni.".into());
        }
        self.assert_owner(&environment.id)?;
        match environment.provider {
            Provider::Sqlite => Ok(()),
            Provider::Docker => {
                self.compose(environment, &["stop", "--timeout", "30"])
                    .await?;
                Ok(())
            }
            Provider::Native => {
                let secret = self.admin_password(&environment.id)?;
                let result = match environment.engine {
                    Engine::Postgresql => {
                        run(Command::new(self.binary(environment, "pg_ctl.exe")?)
                            .arg("stop")
                            .arg("-D")
                            .arg(self.directory(&environment.id)?.join("data"))
                            .args(["-m", "fast", "-t", "30"]))
                        .await
                        .map(|_| ())
                    }
                    Engine::Mysql | Engine::Mariadb => {
                        let binary = if environment.engine == Engine::Mysql {
                            "mysqladmin.exe"
                        } else {
                            "mariadb-admin.exe"
                        };
                        run(Command::new(self.binary(environment, binary)?)
                            .args([
                                "--no-defaults",
                                "--protocol=TCP",
                                "--host=127.0.0.1",
                                "--user=root",
                                "--port",
                                &environment.port.unwrap().to_string(),
                                "shutdown",
                            ])
                            .env("MYSQL_PWD", &secret))
                        .await
                        .map(|_| ())
                    }
                    Engine::Mongodb => {
                        let uri = format!("mongodb://dbm_admin:{secret}@127.0.0.1:{}/?authSource=admin&directConnection=true&serverSelectionTimeoutMS=1000", environment.port.unwrap());
                        let client = Client::with_uri_str(uri).await.map_err(err)?;
                        let _ = client
                            .database("admin")
                            .run_command(doc! {"shutdown":1,"force":false,"timeoutSecs":20})
                            .await;
                        Ok(())
                    }
                    _ => Ok(()),
                };
                let mut children = self.children.lock().await;
                if let Some(mut child) = children.remove(&environment.id) {
                    if tokio::time::timeout(Duration::from_secs(35), child.wait())
                        .await
                        .is_err()
                    {
                        // We own this live Child handle; never kill a PID looked up by process name.
                        child.kill().await.map_err(err)?;
                    }
                    #[cfg(windows)]
                    self.jobs.lock().await.remove(&environment.id);
                    return Ok(());
                }
                if environment.port.is_some()
                    && tokio::net::TcpStream::connect(("127.0.0.1", environment.port.unwrap()))
                        .await
                        .is_err()
                {
                    return Ok(());
                }
                result.map_err(|e| redact(e, &secret))?;
                for _ in 0..60 {
                    if tokio::net::TcpStream::connect(("127.0.0.1", environment.port.unwrap()))
                        .await
                        .is_err()
                    {
                        return Ok(());
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Err("Il server risponde ancora dopo la richiesta di arresto. Non è stato terminato alcun processo esterno.".into())
            }
            Provider::Existing => unreachable!(),
        }
    }
}

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

/// Kill-on-close supervisor for known laboratory server binaries. This is process
/// lifecycle management, not a security boundary for arbitrary executable code.
#[cfg(windows)]
struct NativeJob {
    handle: isize,
}
#[cfg(windows)]
impl NativeJob {
    fn attach(child: &Child) -> Result<Self> {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        let process = child
            .raw_handle()
            .ok_or("Handle del server non disponibile.")?;
        // SAFETY: all structures are initialized, handles are kernel-owned and
        // live for this operation; the job handle is closed exactly once by Drop.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(format!(
                    "Creazione supervisore Windows: {}",
                    std::io::Error::last_os_error()
                ));
            }
            let mut information: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &information as *const _ as *const std::ffi::c_void,
                std::mem::size_of_val(&information) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, process) == 0
            {
                let error = std::io::Error::last_os_error();
                CloseHandle(handle);
                return Err(format!("Assegnazione supervisore Windows: {error}"));
            }
            Ok(Self {
                handle: handle as isize,
            })
        }
    }
}
#[cfg(windows)]
impl Drop for NativeJob {
    fn drop(&mut self) {
        // SAFETY: this is the unique owning job handle returned by CreateJobObjectW.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as *mut std::ffi::c_void);
        }
    }
}
fn redact(message: String, secret: &str) -> String {
    message.replace(secret, "[credenziale]")
}
fn validate_id(id: &str) -> Result<()> {
    if Uuid::parse_str(id).is_ok() {
        Ok(())
    } else {
        Err("Identificatore ambiente non valido.".into())
    }
}
fn validate_slug(id: &str) -> Result<()> {
    if !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        Ok(())
    } else {
        Err("Identificatore distribuzione non valido.".into())
    }
}
fn validate_tag(tag: &str) -> Result<()> {
    if !tag.is_empty()
        && tag.len() <= 100
        && tag
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
    {
        Ok(())
    } else {
        Err("Tag Docker non valido.".into())
    }
}
fn validate_digest(digest: &str) -> Result<()> {
    if digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("Specificare un SHA-256 di 64 cifre esadecimali.".into())
    }
}
fn validate_distribution(d: &NativeDistribution) -> Result<()> {
    validate_slug(&d.id)?;
    validate_digest(&d.sha256)?;
    if d.engine == Engine::Sqlite {
        return Err("SQLite è incluso nell’app e non richiede una distribuzione.".into());
    }
    let url = reqwest::Url::parse(&d.url).map_err(err)?;
    let host = url.host_str().unwrap_or_default();
    let allowed = match d.engine {
        Engine::Postgresql => &["get.enterprisedb.com", "sbp.enterprisedb.com"][..],
        Engine::Mysql => &["dev.mysql.com", "cdn.mysql.com", "downloads.mysql.com"][..],
        Engine::Mariadb => &[
            "archive.mariadb.org",
            "downloads.mariadb.com",
            "dlm.mariadb.com",
            "mirror.mariadb.org",
        ][..],
        Engine::Mongodb => &["fastdl.mongodb.org", "downloads.mongodb.com"][..],
        Engine::Sqlite => &[],
    };
    if url.scheme() != "https"
        || !allowed.contains(&host)
        || url.password().is_some()
        || !url.username().is_empty()
        || !url.path().to_lowercase().ends_with(".zip")
    {
        return Err("Usare un URL HTTPS diretto a un archivio ZIP del distributore ufficiale (senza redirect).".into());
    }
    if d.version.trim().is_empty() {
        return Err("Versione della distribuzione richiesta.".into());
    }
    Ok(())
}
fn free_port() -> Result<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(err)?
        .local_addr()
        .map(|a| a.port())
        .map_err(err)
}
fn project_name(id: &str) -> String {
    format!("dbm-{}", id.replace('-', ""))
}
fn mongo_key(secret: &str) -> String {
    format!(
        "{:x}{:x}",
        Sha256::digest(secret.as_bytes()),
        Sha256::digest(format!("key:{secret}").as_bytes())
    )
}
fn scheme(engine: Engine) -> &'static str {
    match engine {
        Engine::Sqlite => "sqlite",
        Engine::Postgresql => "postgresql",
        Engine::Mysql | Engine::Mariadb => "mysql",
        Engine::Mongodb => "mongodb",
    }
}
fn image_name(engine: Engine) -> Result<&'static str> {
    match engine {
        Engine::Postgresql => Ok("postgres"),
        Engine::Mysql => Ok("mysql"),
        Engine::Mariadb => Ok("mariadb"),
        Engine::Mongodb => Ok("mongo"),
        _ => Err("Motore non valido per Docker.".into()),
    }
}
fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    {
        let _ = command;
    }
}
async fn run(command: &mut Command) -> Result<String> {
    hide(command);
    command
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(600), command.output())
        .await
        .map_err(|_| "Operazione scaduta.".to_string())?
        .map_err(err)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout)
            .chars()
            .take(16384)
            .collect())
    } else {
        Err(format!(
            "Comando terminato con {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4000)
                .collect::<String>()
        ))
    }
}
async fn wait_tcp(port: u16, seconds: u64) -> Result<()> {
    for _ in 0..seconds * 2 {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err("Il server non ha aperto la porta entro il tempo previsto. Consultare server.log o i log Docker.".into())
}
fn assert_safe_tree(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(err)?;
    if metadata.file_type().is_symlink() {
        return Err("Rimozione rifiutata: collegamento simbolico nelle risorse gestite.".into());
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(err)? {
            assert_safe_tree(&entry.map_err(err)?.path())?;
        }
    }
    Ok(())
}
fn remove_owned_child(parent: &Path, name: &str) -> Result<()> {
    if name != "data" {
        return Err("Directory dati non valida.".into());
    }
    let path = parent.join(name);
    if path.exists() {
        assert_safe_tree(&path)?;
        std::fs::remove_dir_all(path).map_err(err)?;
    }
    Ok(())
}
fn find_binary(directory: &Path, filename: &str, depth: usize) -> Result<Option<PathBuf>> {
    if depth > 6 {
        return Ok(None);
    }
    if !directory.exists() {
        return Ok(None);
    }
    let conventional = directory.join("bin").join(filename);
    if conventional.is_file()
        && !std::fs::symlink_metadata(&conventional)
            .map_err(err)?
            .file_type()
            .is_symlink()
    {
        return Ok(Some(conventional));
    }
    for entry in std::fs::read_dir(directory).map_err(err)? {
        let entry = entry.map_err(err)?;
        let ty = entry.file_type().map_err(err)?;
        if ty.is_symlink() {
            return Err("Collegamento non ammesso nel runtime.".into());
        }
        if ty.is_file()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(filename)
        {
            return Ok(Some(entry.path()));
        }
        if ty.is_dir() {
            if let Some(path) = find_binary(&entry.path(), filename, depth + 1)? {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}
#[cfg(test)]
fn extract_zip(bytes: &[u8], destination: &Path) -> Result<()> {
    extract_archive(std::io::Cursor::new(bytes), destination)
}

fn extract_archive(reader: impl std::io::Read + std::io::Seek, destination: &Path) -> Result<()> {
    std::fs::create_dir_all(destination).map_err(err)?;
    let mut archive = zip::ZipArchive::new(reader).map_err(err)?;
    let mut total = 0_u64;
    if archive.len() > 100_000 {
        return Err("Archivio con troppi file.".into());
    }
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).map_err(err)?;
        total = total
            .checked_add(file.size())
            .ok_or("Dimensione archivio non valida.")?;
        if total > MAX_EXTRACTED {
            return Err("Archivio estratto troppo grande.".into());
        }
        if file
            .unix_mode()
            .map(|m| m & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err("Collegamenti simbolici non ammessi nell’archivio.".into());
        }
        let relative = file
            .enclosed_name()
            .ok_or("Percorso non sicuro nell’archivio ZIP.")?;
        if relative.components().any(|c| {
            !matches!(
                c,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        }) {
            return Err("Percorso ZIP non valido.".into());
        }
        let path = destination.join(relative);
        if file.is_dir() {
            std::fs::create_dir_all(path).map_err(err)?;
        } else {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(err)?;
            }
            let mut output = std::fs::File::create(path).map_err(err)?;
            std::io::copy(&mut file, &mut output).map_err(err)?;
        }
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(err)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(err)?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

/// Integrity-verified Windows x64 ZIP distributions. See NATIVE-CATALOG.md.
pub fn bundled_distributions() -> Vec<NativeDistribution> {
    [
        (
            "postgresql-18-6",
            Engine::Postgresql,
            "18.6-5",
            "https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip",
            "e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2",
        ),
        (
            "mysql-8-4-13",
            Engine::Mysql,
            "8.4.13",
            "https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.13-winx64.zip",
            "e9cd98b1d23f122987b1afca26ad942efec5891481103d48ae3cde237fa3ea54",
        ),
        (
            "mariadb-11-8-5",
            Engine::Mariadb,
            "11.8.5",
            "https://archive.mariadb.org/mariadb-11.8.5/winx64-packages/mariadb-11.8.5-winx64.zip",
            "75332dc1f437d9ecee253c2d751d02a69628b109ddd031006f8a8d9ba59dbe0d",
        ),
        (
            "mongodb-8-0-16",
            Engine::Mongodb,
            "8.0.16",
            "https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.16.zip",
            "34eb6795860e29bdf8e5cc9cb4cbba2c73295a25c60204667029d5f3614fe807",
        ),
    ]
    .into_iter()
    .map(|(id, engine, version, url, sha256)| NativeDistribution {
        id: id.into(),
        engine,
        version: version.into(),
        url: url.into(),
        sha256: sha256.into(),
    })
    .collect()
}

pub fn mongo_tools_distribution() -> NativeDistribution {
    NativeDistribution {
        id: "mongodb-tools-100-20-1".into(),
        engine: Engine::Mongodb,
        version: "100.20.1".into(),
        url:
            "https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-100.20.1.zip"
                .into(),
        sha256: "5a1a8aa2c87ca0685ffdcad403601b110d495d44afe579473b8f75ec46621c80".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_resource_identifiers() {
        assert!(validate_id("../../outside").is_err());
        assert!(validate_id(&Uuid::new_v4().to_string()).is_ok());
        assert!(validate_slug("a/b").is_err());
        assert!(validate_tag("17;echo secret").is_err());
    }
    #[test]
    fn rejects_unverified_native_archives() {
        let mut d = NativeDistribution {
            id: "postgres-17".into(),
            engine: Engine::Postgresql,
            version: "17".into(),
            url: "https://evil.example/postgres.zip".into(),
            sha256: "a".repeat(64),
        };
        assert!(validate_distribution(&d).is_err());
        d.url = "https://get.enterprisedb.com/postgresql/postgresql.zip".into();
        assert!(validate_distribution(&d).is_ok());
        d.sha256 = "unknown".into();
        assert!(validate_distribution(&d).is_err());
    }
    #[test]
    fn rejects_zip_traversal() {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("../escape.txt", zip::write::SimpleFileOptions::default())
            .unwrap();
        use std::io::Write;
        writer.write_all(b"bad").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let path = std::env::temp_dir().join(format!("dbm-zip-{}", Uuid::new_v4()));
        assert!(extract_zip(&bytes, &path).is_err());
        let _ = std::fs::remove_dir_all(path);
    }

    #[test]
    fn bundled_catalog_contains_four_integrity_verified_archives() {
        let catalog = bundled_distributions();
        assert_eq!(catalog.len(), 4);
        for distribution in catalog {
            validate_distribution(&distribution).unwrap();
        }
    }

    /// Explicit integration check: creates only app-owned data, never Windows services.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Runs four real Windows database servers in app-owned directories; requires the verified ZIP cache and OS credential store."]
    async fn native_environments_verified_archives_smoke() {
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let app_data = workspace
            .join("artifacts")
            .join("qa-native")
            .join(Uuid::new_v4().to_string());
        let manager = EnvironmentManager::with_archive_cache(
            app_data.clone(),
            workspace.join("artifacts").join("cache"),
        )
        .unwrap();
        let mut failures = Vec::new();
        for distribution in bundled_distributions() {
            let request = CreateEnvironmentRequest {
                name: format!("QA {:?}", distribution.engine),
                engine: distribution.engine,
                provider: Provider::Native,
                laboratory: true,
                version: None,
                image_digest: None,
                distribution_id: Some(distribution.id.clone()),
                endpoint: None,
                port: None,
            };
            let environment = match manager.create(request).await {
                Ok(e) => e,
                Err(e) => {
                    failures.push(format!("{:?}: {e}", distribution.engine));
                    continue;
                }
            };
            let check=async {
                if environment.status!="running" {return Err(environment.last_error.clone().unwrap_or("Stato inatteso".into()));}
                if environment.username.as_deref()!=Some("dbm_lab") {return Err("Utente laboratorio non limitato.".into());}
                let secret=manager.password(&environment.id)?;
                let port=environment.port.unwrap().to_string();
                if distribution.engine==Engine::Mongodb {
                    let client=Client::with_uri_str(format!("mongodb://dbm_lab:{secret}@127.0.0.1:{port}/laboratory?authSource=laboratory&directConnection=true&serverSelectionTimeoutMS=5000")).await.map_err(err)?;
                    client.database("laboratory").run_command(doc!{"insert":"qa_probe","documents":[{"value":42}]}).await.map_err(err)?;
                    let result=client.database("laboratory").run_command(doc!{"find":"qa_probe","filter":{"value":42}}).await.map_err(err)?;
                    if result.get_document("cursor").ok().and_then(|d|d.get_array("firstBatch").ok()).map(Vec::len)!=Some(1) {return Err("CRUD Mongo laboratorio non verificato.".into());}
                    if client.database("admin").run_command(doc!{"createUser":"forbidden_qa_user","pwd":"never-created","roles":[]}).await.is_ok() {return Err("Il ruolo laboratorio può amministrare il server.".into());}
                } else {
                    let sql="CREATE TABLE qa_probe(value INTEGER PRIMARY KEY); INSERT INTO qa_probe VALUES(42); SELECT value FROM qa_probe;";
                    let binary=match distribution.engine {Engine::Postgresql=>"psql.exe",Engine::Mysql=>"mysql.exe",_=>"mariadb.exe"};
                    let mut command=Command::new(manager.binary(&environment,binary)?);
                    if distribution.engine==Engine::Postgresql {command.args(["-h","127.0.0.1","-p",&port,"-U","dbm_lab","-d","laboratory","-v","ON_ERROR_STOP=1","-c",sql]).env("PGPASSWORD",&secret);}
                    else {command.args(["--no-defaults","--protocol=TCP","--host=127.0.0.1","--port",&port,"--user=dbm_lab","--database=laboratory","--execute",sql]).env("MYSQL_PWD",&secret);}
                    let result=run(&mut command).await.map_err(|e|redact(e,&secret))?;
                    if !result.contains("42"){return Err("CRUD SQL laboratorio non verificato.".into());}
                }
                manager.stop(&environment.id).await?;
                let restarted=manager.start(&environment.id).await?;
                if restarted.status!="running" {return Err(restarted.last_error.unwrap_or("Riavvio fallito".into()));}
                manager.stop(&environment.id).await?;
                Ok::<(),String>(())
            }.await;
            if let Err(e) = check {
                failures.push(format!("{:?}: {e}", distribution.engine));
            }
            if let Err(e) = manager.delete(&environment.id, true).await {
                failures.push(format!("Cleanup {:?}: {e}", distribution.engine));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
        // Keep runtime extraction/cache for subsequent explicit QA; only instance data is removed.
    }

    /// Explicit generator QA supervisor. Secrets stay in Windows Credential Manager.
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "Starts four app-owned native databases and holds them for explicit generator QA until qa-stop.flag (maximum 30 minutes)."]
    async fn native_qa_supervisor() {
        assert_eq!(
            std::env::var("DBM_QA_HOLD").as_deref(),
            Ok("1"),
            "Set DBM_QA_HOLD=1 for this explicit integration supervisor."
        );
        let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let root = workspace.join("artifacts");
        let app_data = std::env::var_os("DBM_NATIVE_QA_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("qa-native").join("managed"));
        let manager = EnvironmentManager::with_archive_cache(app_data, root.join("cache")).unwrap();
        let stop = root.join("qa-stop.flag");
        if stop.is_file() {
            std::fs::remove_file(&stop).unwrap();
        }
        let mut created = Vec::new();
        let mut failures = Vec::new();
        let mut connections = Vec::new();
        for distribution in bundled_distributions() {
            eprintln!("Preparing native QA {:?}", distribution.engine);
            let request = CreateEnvironmentRequest {
                name: format!("Generator QA {:?}", distribution.engine),
                engine: distribution.engine,
                provider: Provider::Native,
                laboratory: true,
                version: None,
                image_digest: None,
                distribution_id: Some(distribution.id),
                endpoint: None,
                port: None,
            };
            match manager.create(request).await {
                Ok(e) => {
                    if e.status != "running" {
                        failures.push(
                            e.last_error
                                .clone()
                                .unwrap_or("Provisioning incompleto".into()),
                        );
                    }
                    connections.push(serde_json::json!({"id":e.id,"engine":e.engine,"host":"127.0.0.1","port":e.port,"database":"laboratory","username":"dbm_lab","endpoint":e.endpoint,"credentialService":"DatabaseManager.Environments","credentialAccount":format!("{}-lab",e.id)}));
                    created.push(e);
                }
                Err(e) => failures.push(e),
            }
        }
        if failures.is_empty() {
            let manifest = serde_json::json!({"status":"active","createdAt":Utc::now().to_rfc3339(),"appData":manager.app_data,"stopFlag":stop,"connections":connections});
            std::fs::write(
                root.join("qa-active.json"),
                serde_json::to_vec_pretty(&manifest).unwrap(),
            )
            .unwrap();
            eprintln!(
                "Four native laboratory servers ready; see artifacts/qa-active.json (no secrets)."
            );
            let start = std::time::Instant::now();
            while !stop.exists() && start.elapsed() < Duration::from_secs(1800) {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
        for e in created {
            if let Err(error) = manager.delete(&e.id, true).await {
                failures.push(format!("Cleanup {:?}: {error}", e.engine));
            }
        }
        let _ = std::fs::remove_file(root.join("qa-active.json"));
        let _ = std::fs::remove_file(stop);
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }
}
