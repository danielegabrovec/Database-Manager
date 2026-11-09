//! Inspectable exports, schema comparison, documentation and explicit native backups.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::process::Command;
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolArtifact {
    pub path: String,
    pub bytes: u64,
    pub note: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaDifference {
    pub path: String,
    pub kind: String,
    pub before: Option<Value>,
    pub after: Option<Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaComparison {
    pub differences: Vec<SchemaDifference>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupRequest {
    pub engine: String,
    /// Explicitly chosen native client executable; only known backup tool names are accepted.
    pub executable_path: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    #[serde(default)]
    pub auth_database: Option<String>,
    #[serde(default)]
    pub tls: bool,
    #[serde(default)]
    pub ca_path: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupReceipt {
    engine: String,
    database: String,
    sha256: String,
    bytes: u64,
    created_at: String,
}

pub struct ArtifactStore {
    root: PathBuf,
}
impl ArtifactStore {
    pub fn new(app_data: &Path) -> Result<Self> {
        let root = app_data.join("artifacts");
        std::fs::create_dir_all(&root).map_err(error)?;
        if std::fs::symlink_metadata(&root)
            .map_err(error)?
            .file_type()
            .is_symlink()
        {
            return Err("La directory degli artefatti non può essere un collegamento.".into());
        }
        Ok(Self { root })
    }

    pub fn export_json(&self, rows: &Value) -> Result<ToolArtifact> {
        self.write(
            "export",
            "json",
            &serde_json::to_vec_pretty(rows).map_err(error)?,
            "JSON con i valori ricevuti, senza conversioni numeriche aggiuntive.",
        )
    }

    pub fn export_csv(
        &self,
        headers: &[String],
        rows: &[Vec<Value>],
        spreadsheet_safe: bool,
    ) -> Result<ToolArtifact> {
        if rows.iter().any(|r| r.len() != headers.len()) {
            return Err(
                "Ogni riga CSV deve avere lo stesso numero di valori delle intestazioni.".into(),
            );
        }
        let mut writer = csv::WriterBuilder::new().from_writer(Vec::new());
        let header_cells: Vec<String> = headers
            .iter()
            .map(|s| csv_cell(Value::String(s.clone()), spreadsheet_safe))
            .collect();
        writer.write_record(header_cells).map_err(error)?;
        for row in rows {
            let cells: Vec<String> = row
                .iter()
                .cloned()
                .map(|v| csv_cell(v, spreadsheet_safe))
                .collect();
            writer.write_record(cells).map_err(error)?;
        }
        let bytes = writer.into_inner().map_err(error)?;
        self.write("export", "csv", &bytes, if spreadsheet_safe { "CSV con apostrofo anteposto alle celle che potrebbero essere interpretate come formule. NULL viene esportato come campo vuoto." } else { "CSV fedele ai valori testuali; NULL viene esportato come campo vuoto. Per preservare tipi e NULL usare JSON." })
    }

    pub fn schema_documentation(&self, title: &str, snapshot: &Value) -> Result<ToolArtifact> {
        let title = title.replace(['\r', '\n'], " ");
        let json = serde_json::to_string_pretty(snapshot).map_err(error)?;
        let fence = "`".repeat(longest_backtick_run(&json).max(2) + 1);
        let markdown = format!("# {}\n\nSnapshot dello schema esportato da Database Manager. Le differenze tra motori sono conservate nel contenuto originale.\n\n{fence}json\n{json}\n{fence}\n", title.chars().take(160).collect::<String>());
        self.write(
            "schema",
            "md",
            markdown.as_bytes(),
            "Documentazione con snapshot completo dello schema.",
        )
    }

    /// Online SQLite backup, including committed data held in WAL.
    pub fn backup_sqlite(&self, source: &Path) -> Result<ToolArtifact> {
        if !source.is_file() {
            return Err("File SQLite sorgente non trovato.".into());
        }
        let destination = self.next("backup", "sqlite3");
        let result = (|| {
            let source = rusqlite::Connection::open_with_flags(
                source,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(error)?;
            let mut target = rusqlite::Connection::open(&destination).map_err(error)?;
            let backup = rusqlite::backup::Backup::new(&source, &mut target).map_err(error)?;
            backup
                .run_to_completion(128, Duration::from_millis(10), None)
                .map_err(error)?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = std::fs::remove_file(&destination);
            return Err(e);
        }
        self.artifact(
            &destination,
            "Backup coerente creato con SQLite Online Backup API.",
        )
    }

    /// Runs only the explicit backup operation; never starts or installs a database server.
    pub async fn backup_native(
        &self,
        request: BackupRequest,
        password: Option<String>,
    ) -> Result<ToolArtifact> {
        validate_backup_request(&request)?;
        let binary = resolve_backup_executable(&request.executable_path)?;
        let basename = binary
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let (allowed, extension) = match request.engine.as_str() {
            "postgresql" => (&["pg_dump", "pg_dump.exe"][..], "dump"),
            "mysql" => (&["mysqldump", "mysqldump.exe"][..], "sql"),
            "mariadb" => (
                &[
                    "mariadb-dump",
                    "mariadb-dump.exe",
                    "mysqldump",
                    "mysqldump.exe",
                ][..],
                "sql",
            ),
            "mongodb" => (&["mongodump", "mongodump.exe"][..], "archive"),
            _ => {
                return Err(
                    "Per questo motore non è disponibile il backup con strumenti nativi.".into(),
                )
            }
        };
        if !allowed.contains(&basename.as_str()) || !binary.is_file() {
            return Err("Selezionare l’eseguibile di backup previsto per il motore.".into());
        }
        let destination = self.next("backup", extension);
        let mut command = Command::new(&binary);
        let mut credential_file = None;
        match request.engine.as_str() {
            "postgresql" => {
                command
                    .args([
                        "--host",
                        &request.host,
                        "--port",
                        &request.port.to_string(),
                        "--username",
                        &request.username,
                        "--dbname",
                        &request.database,
                        "--format=custom",
                        "--no-password",
                        "--file",
                    ])
                    .arg(&destination);
                if let Some(secret) = &password {
                    command.env("PGPASSWORD", secret);
                }
            }
            "mysql" | "mariadb" => {
                command.args([
                    "--no-defaults",
                    "--protocol=TCP",
                    "--host",
                    &request.host,
                    "--port",
                    &request.port.to_string(),
                    "--user",
                    &request.username,
                    "--single-transaction",
                    "--no-tablespaces",
                    "--routines",
                    "--events",
                    "--triggers",
                ]);
                command
                    .arg(format!("--result-file={}", destination.display()))
                    .arg(&request.database);
                if request.engine == "mysql" {
                    command.arg("--set-gtid-purged=OFF");
                }
                if let Some(secret) = &password {
                    command.env("MYSQL_PWD", secret);
                }
            }
            "mongodb" => {
                command.args([
                    "--host",
                    &request.host,
                    "--port",
                    &request.port.to_string(),
                    "--username",
                    &request.username,
                    "--db",
                    &request.database,
                    "--authenticationDatabase",
                    request.auth_database.as_deref().unwrap_or("admin"),
                ]);
                command.arg(format!("--archive={}", destination.display()));
                if let Some(secret) = &password {
                    let path = self.next("credential", "tmp");
                    // JSON is a valid YAML mapping for mongodump's --config input.
                    std::fs::write(
                        &path,
                        serde_json::to_vec(&serde_json::json!({"password":secret}))
                            .map_err(error)?,
                    )
                    .map_err(error)?;
                    command.arg("--config").arg(&path);
                    credential_file = Some(path);
                }
            }
            _ => unreachable!(),
        }
        if let Err(error) = apply_transport(&mut command, &request) {
            if let Some(path) = credential_file.take() {
                let _ = std::fs::remove_file(path);
            }
            return Err(error);
        }
        command
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let outcome = tokio::time::timeout(Duration::from_secs(600), command.output()).await;
        if let Some(path) = credential_file {
            let _ = std::fs::remove_file(path);
        }
        let output = match outcome {
            Ok(Ok(output)) => output,
            Ok(Err(e)) => {
                let _ = std::fs::remove_file(&destination);
                return Err(error(e));
            }
            Err(_) => {
                let _ = std::fs::remove_file(&destination);
                return Err(
                    "Backup scaduto dopo 10 minuti; il file incompleto è stato rimosso.".into(),
                );
            }
        };
        if !output.status.success() {
            let _ = std::fs::remove_file(&destination);
            let mut message = String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4000)
                .collect::<String>();
            if let Some(secret) = password.filter(|s| !s.is_empty()) {
                message = message.replace(&secret, "[credenziale]");
            }
            return Err(format!("Backup non completato: {message}"));
        }
        let receipt = BackupReceipt {
            engine: request.engine,
            database: request.database,
            sha256: file_sha256(&destination)?,
            bytes: std::fs::metadata(&destination).map_err(error)?.len(),
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        std::fs::write(
            receipt_path(&destination),
            serde_json::to_vec_pretty(&receipt).map_err(error)?,
        )
        .map_err(error)?;
        self.artifact(&destination, "Backup generato dallo strumento nativo, con ricevuta SHA-256. Il ripristino deve essere verificato su un ambiente separato.")
    }

    /// Restore only this application's integrity-checked backups to the explicit
    /// matching database. This is destructive and requires an explicit UI action.
    pub async fn restore_native(
        &self,
        request: BackupRequest,
        source: &Path,
        password: Option<String>,
        confirmed: bool,
    ) -> Result<Value> {
        if !confirmed {
            return Err(
                "Confermare esplicitamente il ripristino dei dati nella destinazione selezionata."
                    .into(),
            );
        }
        validate_backup_request(&request)?;
        let source = source.canonicalize().map_err(error)?;
        let root = self.root.canonicalize().map_err(error)?;
        if !source.starts_with(&root) || !source.is_file() {
            return Err("Il ripristino server v1 richiede un backup creato dall’app nella sua directory artefatti.".into());
        }
        let receipt:BackupReceipt=serde_json::from_slice(&std::fs::read(receipt_path(&source)).map_err(|_|"Ricevuta del backup mancante. I dump esterni si importano con il client nativo dopo revisione.".to_string())?).map_err(error)?;
        if receipt.engine != request.engine || receipt.database != request.database {
            return Err("Motore o database di destinazione diversi dalla ricevuta del backup. Il ripristino non rimappa database.".into());
        }
        if file_sha256(&source)? != receipt.sha256
            || std::fs::metadata(&source).map_err(error)?.len() != receipt.bytes
        {
            return Err(
                "Il backup è cambiato dopo la creazione; SHA-256 non corrispondente.".into(),
            );
        }
        let binary = resolve_backup_executable(&request.executable_path)?;
        let basename = binary
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let allowed = match request.engine.as_str() {
            "postgresql" => &["pg_restore", "pg_restore.exe"][..],
            "mysql" => &["mysql", "mysql.exe"][..],
            "mariadb" => &["mariadb", "mariadb.exe", "mysql", "mysql.exe"][..],
            "mongodb" => &["mongorestore", "mongorestore.exe"][..],
            _ => return Err("Motore di ripristino non supportato.".into()),
        };
        if !allowed.contains(&basename.as_str()) {
            return Err(
                "Selezionare lo strumento nativo di ripristino previsto per il motore.".into(),
            );
        }
        let mut command = Command::new(binary);
        let port = request.port.to_string();
        let mut credential_file = None;
        match request.engine.as_str() {
            "postgresql" => {
                command
                    .args([
                        "--host",
                        &request.host,
                        "--port",
                        &port,
                        "--username",
                        &request.username,
                        "--dbname",
                        &request.database,
                        "--no-password",
                        "--clean",
                        "--if-exists",
                        "--no-owner",
                        "--exit-on-error",
                        "--single-transaction",
                    ])
                    .arg(&source);
                if let Some(secret) = &password {
                    command.env("PGPASSWORD", secret);
                }
                command.stdin(std::process::Stdio::null());
            }
            "mysql" | "mariadb" => {
                command.args([
                    "--no-defaults",
                    "--protocol=TCP",
                    "--host",
                    &request.host,
                    "--port",
                    &port,
                    "--user",
                    &request.username,
                    "--database",
                    &request.database,
                    "--binary-mode",
                    "--local-infile=0",
                ]);
                if let Some(secret) = &password {
                    command.env("MYSQL_PWD", secret);
                }
                command.stdin(std::fs::File::open(&source).map_err(error)?);
            }
            "mongodb" => {
                if request
                    .database
                    .chars()
                    .any(|c| matches!(c, '*' | '?' | '[' | ']' | '\\' | '.'))
                {
                    return Err("Il ripristino MongoDB richiede un nome database senza caratteri di pattern.".into());
                }
                command.args([
                    "--host",
                    &request.host,
                    "--port",
                    &port,
                    "--username",
                    &request.username,
                    "--authenticationDatabase",
                    request.auth_database.as_deref().unwrap_or("admin"),
                    "--drop",
                    "--stopOnError",
                ]);
                command
                    .arg(format!("--archive={}", source.display()))
                    .arg(format!("--nsInclude={}.*", request.database));
                command.stdin(std::process::Stdio::null());
                if let Some(secret) = &password {
                    let path = self.next("credential", "tmp");
                    std::fs::write(
                        &path,
                        serde_json::to_vec(&serde_json::json!({"password":secret}))
                            .map_err(error)?,
                    )
                    .map_err(error)?;
                    command.arg("--config").arg(&path);
                    credential_file = Some(path);
                }
            }
            _ => unreachable!(),
        }
        if let Err(error) = apply_transport(&mut command, &request) {
            if let Some(path) = credential_file.take() {
                let _ = std::fs::remove_file(path);
            }
            return Err(error);
        }
        command.kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let outcome = tokio::time::timeout(Duration::from_secs(600), command.output()).await;
        if let Some(path) = credential_file {
            let _ = std::fs::remove_file(path);
        }
        let output=outcome.map_err(|_|"Ripristino scaduto. Per motori con DDL non transazionale la destinazione può essere parzialmente modificata.".to_string())?.map_err(error)?;
        if !output.status.success() {
            let mut message = String::from_utf8_lossy(&output.stderr)
                .chars()
                .take(4000)
                .collect::<String>();
            if let Some(secret) = password.filter(|s| !s.is_empty()) {
                message = message.replace(&secret, "[credenziale]");
            }
            return Err(format!("Ripristino non completato: {message}. Verificare lo stato della destinazione prima di riprovare."));
        }
        Ok(
            serde_json::json!({"message":"Ripristino completato dallo strumento nativo","database":request.database,"transactional":request.engine=="postgresql","note":if request.engine=="postgresql"{"Operazione eseguita in singola transazione."}else{"DDL e scritture non sono ripristinabili con un rollback globale; verificare i dati e le relazioni."}}),
        )
    }

    /// A plain SQL dump produced by the native client. An empty table is the
    /// explicitly selected whole-database scope; callers must validate that UI scope.
    pub async fn export_sql_table(
        &self,
        request: BackupRequest,
        table: &str,
        password: Option<String>,
    ) -> Result<ToolArtifact> {
        validate_backup_request(&request)?;
        validate_sql_table(table)?;
        let binary = sql_executable(&request, true)?;
        let destination = self.next("export", "sql");
        let mut command = sql_export_command(&request, &binary, table, &destination)?;
        set_sql_password(&mut command, &request, password.as_deref());
        apply_transport(&mut command, &request)?;
        if let Err(error) = run_sql_tool(&mut command, password.as_deref()).await {
            let _ = std::fs::remove_file(&destination);
            return Err(error);
        }
        self.artifact(&destination,if table.is_empty(){"Script SQL nativo dell’intero database, con struttura e dati. Le istruzioni del dump vanno revisionate prima dell’importazione."}else{"Script SQL nativo della tabella selezionata, con struttura e INSERT. Dipendenze esterne alla tabella possono richiedere una precedente creazione."})
    }

    /// Explicitly confirmed SQL import. No global transaction is added: scripts
    /// may contain DDL that the engine does not permit inside such a transaction.
    pub async fn import_sql_script(
        &self,
        request: BackupRequest,
        source: &Path,
        password: Option<String>,
        confirmed: bool,
    ) -> Result<Value> {
        if !confirmed {
            return Err(
                "Confermare esplicitamente l’esecuzione dello script SQL nel database selezionato."
                    .into(),
            );
        }
        validate_backup_request(&request)?;
        let binary = sql_executable(&request, false)?;
        let source = source.canonicalize().map_err(error)?;
        if !source.is_file() || std::fs::metadata(&source).map_err(error)?.len() == 0 {
            return Err("Selezionare uno script SQL non vuoto.".into());
        }
        // psql accepts local shell/file meta-commands. Run a private copy in
        // restricted mode, retaining SQL and COPY data but blocking those commands.
        let temporary = if request.engine == "postgresql" {
            Some(restricted_psql_script(&source, &self.root)?)
        } else {
            None
        };
        let input = temporary.as_deref().unwrap_or(&source);
        let result = async {
            let mut command = sql_import_command(&request, &binary, input)?;
            set_sql_password(&mut command, &request, password.as_deref());
            apply_transport(&mut command, &request)?;
            run_sql_tool(&mut command, password.as_deref()).await
        }
        .await;
        if let Some(path) = temporary {
            let _ = std::fs::remove_file(path);
        }
        result?;
        Ok(
            serde_json::json!({"message":"Script SQL importato dal client nativo","database":request.database,"format":"sql","transactional":false,"note":"L’app non aggiunge una transazione globale: vengono rispettate le istruzioni dello script. In caso di errore possono essere già state applicate modifiche. Le meta-istruzioni locali di psql sono bloccate."}),
        )
    }

    fn next(&self, prefix: &str, extension: &str) -> PathBuf {
        self.root
            .join(format!("{prefix}-{}.{}", Uuid::new_v4(), extension))
    }
    fn write(
        &self,
        prefix: &str,
        extension: &str,
        bytes: &[u8],
        note: &str,
    ) -> Result<ToolArtifact> {
        let path = self.next(prefix, extension);
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(error)?;
        file.write_all(bytes).map_err(error)?;
        self.artifact(&path, note)
    }
    fn artifact(&self, path: &Path, note: &str) -> Result<ToolArtifact> {
        Ok(ToolArtifact {
            path: path.to_string_lossy().into(),
            bytes: std::fs::metadata(path).map_err(error)?.len(),
            note: note.into(),
        })
    }
}

pub fn compare_snapshots(before: &Value, after: &Value) -> SchemaComparison {
    let mut result = SchemaComparison {
        differences: Vec::new(),
        truncated: false,
    };
    let before = structural_schema(before);
    let after = structural_schema(after);
    compare_value("$", &before, &after, &mut result);
    result
}
fn compare_value(path: &str, before: &Value, after: &Value, result: &mut SchemaComparison) {
    if before == after {
        return;
    }
    if result.differences.len() >= 1000 {
        result.truncated = true;
        return;
    }
    match (before, after) {
        (Value::Object(a), Value::Object(b)) => {
            let keys: std::collections::BTreeSet<_> = a.keys().chain(b.keys()).collect();
            for key in keys {
                let escaped = key.replace('~', "~0").replace('/', "~1");
                let child = format!("{path}/{escaped}");
                match (a.get(key), b.get(key)) {
                    (Some(a), Some(b)) => compare_value(&child, a, b, result),
                    (a, b) => push_difference(&child, a.cloned(), b.cloned(), result),
                }
            }
        }
        (Value::Array(a), Value::Array(b))
            if named_array(a).is_some() && named_array(b).is_some() =>
        {
            let a = Value::Object(named_array(a).unwrap());
            let b = Value::Object(named_array(b).unwrap());
            compare_value(path, &a, &b, result);
        }
        (Value::Array(a), Value::Array(b)) => {
            for index in 0..a.len().max(b.len()) {
                let child = format!("{path}/{index}");
                match (a.get(index), b.get(index)) {
                    (Some(a), Some(b)) => compare_value(&child, a, b, result),
                    (a, b) => push_difference(&child, a.cloned(), b.cloned(), result),
                }
            }
        }
        _ => push_difference(path, Some(before.clone()), Some(after.clone()), result),
    }
}
fn named_array(values: &[Value]) -> Option<serde_json::Map<String, Value>> {
    let mut result = serde_json::Map::new();
    for value in values {
        let name = value.get("name")?.as_str()?;
        let key = if let Some(schema) = value.get("schema").and_then(Value::as_str) {
            serde_json::to_string(&(schema, name)).ok()?
        } else {
            name.to_owned()
        };
        if result.insert(key, value.clone()).is_some() {
            return None;
        }
    }
    Some(result)
}

fn structural_schema(snapshot: &Value) -> Value {
    let mut snapshot = snapshot.clone();
    if let Some(object) = snapshot.as_object_mut() {
        // Database name and live counts identify the source, not its schema.
        if object.get("tables").and_then(Value::as_array).is_some() {
            object.remove("database");
            if let Some(tables) = object.get_mut("tables").and_then(Value::as_array_mut) {
                for table in tables {
                    if let Some(table) = table.as_object_mut() {
                        table.remove("rowCount");
                    }
                }
            }
        }
    }
    snapshot
}

fn resolve_backup_executable(value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value);
    if path.components().count() > 1 {
        return path.canonicalize().map_err(error);
    }
    let names = if cfg!(windows) && path.extension().is_none() {
        vec![format!("{value}.exe"), value.to_owned()]
    } else {
        vec![value.to_owned()]
    };
    for directory in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if directory.as_os_str().is_empty() {
            continue;
        }
        for name in &names {
            let candidate = directory.join(name);
            if candidate.is_file() {
                return candidate.canonicalize().map_err(error);
            }
        }
    }
    Err(format!("Strumento {value} non trovato nel PATH. Selezionare esplicitamente l’eseguibile del client nativo di backup."))
}

fn validate_sql_table(table: &str) -> Result<()> {
    if table.len() > 1024 || table.chars().any(|c| matches!(c, '\0' | '\r' | '\n')) {
        return Err("Nome tabella SQL non valido.".into());
    }
    Ok(())
}
fn sql_executable(request: &BackupRequest, export: bool) -> Result<PathBuf> {
    let allowed=match(request.engine.as_str(),export){
        ("postgresql",true)=>&["pg_dump","pg_dump.exe"][..],("postgresql",false)=>&["psql","psql.exe"][..],
        ("mysql",true)=>&["mysqldump","mysqldump.exe"][..],("mysql",false)=>&["mysql","mysql.exe"][..],
        ("mariadb",true)=>&["mariadb-dump","mariadb-dump.exe","mysqldump","mysqldump.exe"][..],("mariadb",false)=>&["mariadb","mariadb.exe","mysql","mysql.exe"][..],
        _=>return Err("Il formato SQL nativo è disponibile per PostgreSQL, MySQL e MariaDB; MongoDB usa JSON canonico.".into()),
    };
    let binary = resolve_backup_executable(&request.executable_path)?;
    let name = binary
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !allowed.contains(&name.as_str()) {
        return Err("Selezionare lo strumento SQL nativo previsto per questa operazione.".into());
    }
    Ok(binary)
}
fn set_sql_password(command: &mut Command, request: &BackupRequest, password: Option<&str>) {
    if let Some(password) = password {
        command.env(
            if request.engine == "postgresql" {
                "PGPASSWORD"
            } else {
                "MYSQL_PWD"
            },
            password,
        );
    }
}
fn sql_export_command(
    request: &BackupRequest,
    binary: &Path,
    table: &str,
    destination: &Path,
) -> Result<Command> {
    let mut command = Command::new(binary);
    let port = request.port.to_string();
    if request.engine == "postgresql" {
        command.args([
            "--host",
            &request.host,
            "--port",
            &port,
            "--username",
            &request.username,
            "--dbname",
            &request.database,
            "--no-password",
            "--format=plain",
            "--column-inserts",
            "--no-owner",
            "--no-privileges",
            "--quote-all-identifiers",
        ]);
        if !table.is_empty() {
            command
                .arg("--strict-names")
                .arg("--table")
                .arg(postgres_literal_table_pattern(table)?);
        }
        command.arg("--file").arg(destination);
    } else {
        command.args([
            "--no-defaults",
            "--protocol=TCP",
            "--host",
            &request.host,
            "--port",
            &port,
            "--user",
            &request.username,
            "--single-transaction",
            "--no-tablespaces",
            "--hex-blob",
            "--default-character-set=utf8mb4",
        ]);
        if request.engine == "mysql" {
            command.arg("--set-gtid-purged=OFF");
        }
        if table.is_empty() {
            command.args(["--routines", "--events", "--triggers"]);
        }
        command
            .arg(format!("--result-file={}", destination.display()))
            .arg("--")
            .arg(&request.database);
        if !table.is_empty() {
            command.arg(table);
        }
    }
    command.stdin(std::process::Stdio::null());
    Ok(command)
}
fn sql_import_command(request: &BackupRequest, binary: &Path, source: &Path) -> Result<Command> {
    let mut command = Command::new(binary);
    let port = request.port.to_string();
    if request.engine == "postgresql" {
        command
            .args([
                "--host",
                &request.host,
                "--port",
                &port,
                "--username",
                &request.username,
                "--dbname",
                &request.database,
                "--no-password",
                "--no-psqlrc",
                "--set=ON_ERROR_STOP=1",
                "--quiet",
                "--file",
            ])
            .arg(source)
            .stdin(std::process::Stdio::null());
    } else {
        command
            .args([
                "--no-defaults",
                "--protocol=TCP",
                "--host",
                &request.host,
                "--port",
                &port,
                "--user",
                &request.username,
                "--database",
                &request.database,
                "--binary-mode",
                "--local-infile=0",
                "--default-character-set=utf8mb4",
            ])
            .stdin(std::fs::File::open(source).map_err(error)?);
    }
    Ok(command)
}
async fn run_sql_tool(command: &mut Command, password: Option<&str>) -> Result<()> {
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(600), command.output())
        .await
        .map_err(|_| {
            "Operazione SQL scaduta dopo 10 minuti. Verificare eventuali modifiche già applicate."
                .to_string()
        })?
        .map_err(error)?;
    if !output.status.success() {
        let mut message = String::from_utf8_lossy(&output.stderr)
            .chars()
            .take(4000)
            .collect::<String>();
        if let Some(secret) = password.filter(|p| !p.is_empty()) {
            message = message.replace(secret, "[credenziale]");
        }
        return Err(format!("Client SQL terminato con errore: {message}. Lo script può essere stato applicato solo in parte."));
    }
    Ok(())
}
/// Quote each identifier before passing it as a pg_dump pattern. Wildcards are
/// literals here, and an unqualified name deliberately means the public schema.
fn postgres_literal_table_pattern(table: &str) -> Result<String> {
    validate_sql_table(table)?;
    let mut parts = Vec::new();
    let mut chars = table.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let mut part = String::new();
        if chars.peek() == Some(&'"') {
            chars.next();
            let mut closed = false;
            while let Some(c) = chars.next() {
                if c == '"' {
                    if chars.peek() == Some(&'"') {
                        chars.next();
                        part.push('"');
                    } else {
                        closed = true;
                        break;
                    }
                } else {
                    part.push(c);
                }
            }
            if !closed {
                return Err("Identificatore PostgreSQL non chiuso.".into());
            }
            while chars.peek().is_some_and(|c| c.is_whitespace()) {
                chars.next();
            }
        } else {
            while let Some(&c) = chars.peek() {
                if c == '.' {
                    break;
                }
                part.push(c);
                chars.next();
            }
            part = part.trim().to_owned();
        }
        if part.is_empty() {
            return Err("Nome tabella PostgreSQL vuoto.".into());
        }
        parts.push(part);
        match chars.next(){Some('.')if parts.len()<2=>{},None=>break,_=>return Err("Usare nome tabella o schema.tabella; quotare gli identificatori che contengono punti.".into())}
    }
    if parts.len() == 1 {
        parts.insert(0, "public".into());
    }
    Ok(parts
        .iter()
        .map(|p| format!("\"{}\"", p.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join("."))
}

/// Preserve dump contents, remove only the outer pg_dump restrict/unrestrict
/// pair, and prepend an unpredictable app-owned restricted-mode key. This blocks
/// psql's shell/include/output commands even in externally supplied SQL files.
fn restricted_psql_script(source: &Path, root: &Path) -> Result<PathBuf> {
    use std::io::{BufRead, Read, Write};
    let destination = root.join(format!("sql-import-{}.tmp.sql", Uuid::new_v4()));
    let result = (|| {
        let mut input = std::io::BufReader::new(std::fs::File::open(source).map_err(error)?);
        let mut output = std::io::BufWriter::new(
            std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&destination)
                .map_err(error)?,
        );
        writeln!(output, "\\restrict {}", Uuid::new_v4().simple()).map_err(error)?;
        let mut header = true;
        let mut old_key: Option<String> = None;
        let mut pending = String::new();
        let mut line = String::new();
        let mut first_line = true;
        loop {
            line.clear();
            let count = input
                .by_ref()
                .take(16 * 1024 * 1024 + 1)
                .read_line(&mut line)
                .map_err(|e| format!("Lo script PostgreSQL deve essere UTF-8: {e}"))?;
            if count == 0 {
                break;
            }
            if count > 16 * 1024 * 1024 {
                return Err("Singola riga SQL oltre 16 MiB; suddividere il contenuto o usare il ripristino nativo.".into());
            }
            if first_line {
                first_line = false;
                if line.starts_with('\u{feff}') {
                    line.remove(0);
                }
            }
            let trimmed = line.trim();
            if header && !trimmed.is_empty() && !trimmed.starts_with("--") {
                header = false;
                let words: Vec<_> = trimmed.split_whitespace().collect();
                if words.len() == 2
                    && words[0] == "\\restrict"
                    && words[1].bytes().all(|b| b.is_ascii_alphanumeric())
                {
                    old_key = Some(words[1].into());
                    continue;
                }
            }
            if !pending.is_empty() {
                if trimmed.is_empty() {
                    pending.push_str(&line);
                    if pending.len() > 16 * 1024 * 1024 {
                        return Err("Coda dello script SQL troppo grande.".into());
                    }
                    continue;
                }
                output.write_all(pending.as_bytes()).map_err(error)?;
                pending.clear();
            }
            if old_key
                .as_ref()
                .is_some_and(|key| trimmed == format!("\\unrestrict {key}"))
            {
                pending = line.clone();
                continue;
            }
            output.write_all(line.as_bytes()).map_err(error)?;
        }
        output.flush().map_err(error)?;
        Ok::<(), String>(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&destination);
        return Err(error);
    }
    Ok(destination)
}
fn push_difference(
    path: &str,
    before: Option<Value>,
    after: Option<Value>,
    result: &mut SchemaComparison,
) {
    if result.differences.len() >= 1000 {
        result.truncated = true;
        return;
    }
    let kind = if before.is_none() {
        "added"
    } else if after.is_none() {
        "removed"
    } else {
        "changed"
    };
    result.differences.push(SchemaDifference {
        path: path.into(),
        kind: kind.into(),
        before,
        after,
    });
}
fn csv_cell(value: Value, spreadsheet_safe: bool) -> String {
    let cell = match value {
        Value::Null => String::new(),
        Value::String(s) => s,
        other => other.to_string(),
    };
    if spreadsheet_safe && cell.trim_start().starts_with(['=', '+', '-', '@']) {
        format!("'{cell}")
    } else {
        cell
    }
}
fn longest_backtick_run(text: &str) -> usize {
    let mut longest = 0;
    let mut current = 0;
    for c in text.chars() {
        if c == '`' {
            current += 1;
            longest = longest.max(current)
        } else {
            current = 0
        }
    }
    longest
}
fn validate_backup_request(r: &BackupRequest) -> Result<()> {
    for (label, value) in [
        ("host", &r.host),
        ("database", &r.database),
        ("utente", &r.username),
    ] {
        if value.is_empty()
            || value.len() > 250
            || value.chars().any(|c| c == '\0' || c == '\r' || c == '\n')
            || value.starts_with('-')
        {
            return Err(format!(
                "Valore {label} non valido per lo strumento di backup."
            ));
        }
    }
    // pg_dump interprets connection strings passed to --dbname; use discrete fields only.
    if r.database.contains('=') || r.database.contains("://") {
        return Err("Usare il nome del database, senza URL o stringhe di connessione.".into());
    }
    Ok(())
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Strict native-tool transport: an enabled TLS profile never downgrades to
/// plaintext or disables certificate/hostname verification.
fn apply_transport(command: &mut Command, request: &BackupRequest) -> Result<()> {
    if !request.tls {
        return Ok(());
    }
    let certificate = match request.ca_path.as_deref().filter(|p| !p.trim().is_empty()) {
        Some(path) => {
            let path = PathBuf::from(path)
                .canonicalize()
                .map_err(|_| "Certificato CA non trovato.".to_string())?;
            if !path.is_file() {
                return Err("Il percorso CA deve indicare un file.".into());
            }
            Some(path)
        }
        None => None,
    };
    match request.engine.as_str() {
        "postgresql" => {
            command.env("PGSSLMODE", "verify-full");
            command.env(
                "PGSSLROOTCERT",
                certificate
                    .as_deref()
                    .unwrap_or_else(|| Path::new("system")),
            );
        }
        "mysql" => {
            command.arg("--ssl-mode=VERIFY_IDENTITY");
            if let Some(path) = certificate {
                command.arg(format!("--ssl-ca={}", path.display()));
            }
        }
        "mariadb" => {
            command.args(["--ssl", "--ssl-verify-server-cert"]);
            if let Some(path) = certificate {
                command.arg(format!("--ssl-ca={}", path.display()));
            }
        }
        "mongodb" => {
            command.arg("--ssl");
            if let Some(path) = certificate {
                command.arg("--sslCAFile").arg(path);
            }
        }
        _ => return Err("TLS non supportato per questo strumento.".into()),
    }
    Ok(())
}

fn receipt_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}.dbm-backup.json",
        path.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("backup")
    ))
}
fn file_sha256(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path).map_err(error)?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let n = file.read(&mut buffer).map_err(error)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sql_request(engine: &str) -> BackupRequest {
        BackupRequest {
            engine: engine.into(),
            executable_path: String::new(),
            host: "127.0.0.1".into(),
            port: 5432,
            database: "laboratory".into(),
            username: "dbm_lab".into(),
            auth_database: None,
            tls: false,
            ca_path: None,
        }
    }
    #[test]
    fn sql_export_table_names_cannot_become_options_or_wildcards() {
        assert_eq!(
            postgres_literal_table_pattern("\"odd.schema\".\"table*?\"").unwrap(),
            "\"odd.schema\".\"table*?\""
        );
        assert_eq!(
            postgres_literal_table_pattern("users").unwrap(),
            "\"public\".\"users\""
        );
        let request = sql_request("mysql");
        let command = sql_export_command(
            &request,
            Path::new("mysqldump.exe"),
            "--all-databases",
            Path::new("out.sql"),
        )
        .unwrap();
        let args = command
            .as_std()
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert!(args.ends_with(&["--".into(), "laboratory".into(), "--all-databases".into()]));
        let whole = sql_export_command(
            &request,
            Path::new("mysqldump.exe"),
            "",
            Path::new("out.sql"),
        )
        .unwrap();
        assert!(!whole.as_std().get_args().any(|s| s == "--databases"));
    }
    #[test]
    fn sql_transfer_enforces_strict_tls_in_native_clients() {
        for engine in ["postgresql", "mysql", "mariadb"] {
            let mut request = sql_request(engine);
            request.tls = true;
            let mut command =
                sql_export_command(&request, Path::new("tool.exe"), "", Path::new("out.sql"))
                    .unwrap();
            apply_transport(&mut command, &request).unwrap();
            let args = command
                .as_std()
                .get_args()
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>();
            if engine == "postgresql" {
                assert!(command
                    .as_std()
                    .get_envs()
                    .any(|(key, value)| key == "PGSSLMODE"
                        && value == Some(std::ffi::OsStr::new("verify-full"))));
            } else if engine == "mysql" {
                assert!(args.contains(&"--ssl-mode=VERIFY_IDENTITY".into()));
            } else {
                assert!(args.contains(&"--ssl-verify-server-cert".into()));
            }
        }
    }
    #[test]
    fn psql_wrapper_preserves_multiline_data_and_blocks_local_meta_commands() {
        let root = std::env::temp_dir().join(format!("dbm-sql-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("input.sql");
        std::fs::write(&source,"-- native dump\n\\restrict oldkey\nINSERT INTO t VALUES ('line one\n\\unrestrict oldkey\nline three');\n\\! forbidden-local-command\n\\unrestrict oldkey\n").unwrap();
        let wrapped = restricted_psql_script(&source, &root).unwrap();
        let text = std::fs::read_to_string(&wrapped).unwrap();
        assert!(text.starts_with("\\restrict "));
        assert!(!text.starts_with("\\restrict oldkey"));
        assert!(text.contains("line one\n\\unrestrict oldkey\nline three"));
        assert!(text.contains("\\! forbidden-local-command"));
        assert_eq!(text.matches("\\unrestrict oldkey").count(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn schema_name_order_is_irrelevant() {
        let a = serde_json::json!({"tables":[{"name":"a","columns":[]},{"name":"b","columns":[]}]});
        let b = serde_json::json!({"tables":[{"name":"b","columns":[]},{"name":"a","columns":[]}]});
        assert!(compare_snapshots(&a, &b).differences.is_empty());
    }
    #[test]
    fn schema_changes_are_inspectable() {
        let a =
            serde_json::json!({"tables":[{"name":"users","columns":[{"name":"id","type":"int"}]}]});
        let b = serde_json::json!({"tables":[{"name":"users","columns":[{"name":"id","type":"bigint"}]}]});
        let result = compare_snapshots(&a, &b);
        assert_eq!(result.differences.len(), 1);
        assert_eq!(result.differences[0].path, "$/tables/users/columns/id/type");
    }

    #[test]
    fn schema_comparison_ignores_source_name_counts_and_namespace_order() {
        let a = serde_json::json!({"database":"development","tables":[{"schema":"public","name":"users","rowCount":10,"columns":[]},{"schema":"other","name":"users","columns":[]}]});
        let b = serde_json::json!({"database":"test","tables":[{"schema":"other","name":"users","columns":[]},{"schema":"public","name":"users","rowCount":200,"columns":[]}]});
        assert!(compare_snapshots(&a, &b).differences.is_empty());
    }
    #[test]
    fn csv_formula_protection_is_explicit() {
        assert_eq!(csv_cell(Value::String("=1+1".into()), true), "'=1+1");
        assert_eq!(csv_cell(Value::String("=1+1".into()), false), "=1+1");
    }
    #[test]
    fn sqlite_backup_includes_wal_commits() {
        let dir = std::env::temp_dir().join(format!("dbm-tools-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.sqlite3");
        let conn = rusqlite::Connection::open(&source).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(42);").unwrap();
        let store = ArtifactStore::new(&dir).unwrap();
        let backup = store.backup_sqlite(&source).unwrap();
        let copied = rusqlite::Connection::open(backup.path).unwrap();
        assert_eq!(
            copied
                .query_row("SELECT id FROM items", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            42
        );
        drop(copied);
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
