//! Optional, explicit Windows service integration. No SCM mutation happens in `plan`.
//! The elevated entry point accepts only enumerated operations and canonical UUIDs.
//! Vendor runtimes are re-extracted from the immutable, SHA-256-pinned catalog.
//! See windows_service/README.md for sources and the unperformed live SCM checks.
use crate::environment::{
    bundled_distributions, Engine, Environment, EnvironmentManager, NativeDistribution, Provider,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

type Result<T> = std::result::Result<T, String>;
const PREFIX: &str = "DBM-";
const FORMAT: u32 = 1;
const MAX_FILES: usize = 150_000;
const MAX_BYTES: u64 = 512 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServicePlan {
    pub environment_id: String,
    pub environment_name: String,
    pub engine: Engine,
    pub service_name: String,
    pub account: String,
    pub source_data: PathBuf,
    pub service_root: PathBuf,
    pub runtime_root: PathBuf,
    pub data_path: PathBuf,
    pub distribution_id: String,
    pub version: String,
    pub archive_path: PathBuf,
    pub archive_sha256: String,
    pub port: u16,
    pub installed: bool,
    pub status: String,
    pub actions: Vec<String>,
    pub steps: Vec<String>,
    pub live_scm_certified: bool,
    pub fingerprint: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOutcome {
    pub action: String,
    pub service_name: String,
    pub message: String,
    pub status: String,
    pub data_path: PathBuf,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Install,
    Start,
    Stop,
    Remove,
}
impl Action {
    fn parse(value: &str) -> Result<Self> {
        match value {
            "install" => Ok(Self::Install),
            "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            "remove" => Ok(Self::Remove),
            _ => Err("Azione servizio non ammessa.".into()),
        }
    }
    fn text(self) -> &'static str {
        match self {
            Self::Install => "install",
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Remove => "remove",
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    format: u32,
    environment_id: String,
    engine: Engine,
    service_name: String,
    account: String,
    distribution_id: String,
    archive_sha256: String,
    port: u16,
    binary_relative: PathBuf,
    arguments: Vec<String>,
    image_path: String,
    source_root: PathBuf,
}
#[derive(Clone, Debug)]
struct Snapshot {
    image_path: String,
    account: String,
    description: String,
    state: String,
    service_type: u32,
}
#[derive(Deserialize)]
struct Registry {
    environments: Vec<Environment>,
}

fn fail(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn valid_id(id: &str) -> Result<()> {
    let parsed = Uuid::parse_str(id).map_err(|_| "UUID ambiente non valido.")?;
    if parsed.to_string() != id {
        return Err("Usare l’UUID canonico dell’ambiente.".into());
    }
    Ok(())
}
fn service_name(id: &str) -> Result<String> {
    valid_id(id)?;
    Ok(format!("{PREFIX}{id}"))
}
fn validate_relative(path: &Path) -> Result<()> {
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || path.to_string_lossy().contains(':')
    {
        return Err("Percorso relativo non ammesso.".into());
    }
    Ok(())
}
fn reject_link(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path).map_err(fail)?;
    if meta.file_type().is_symlink() {
        return Err("Collegamenti simbolici non ammessi nelle risorse del servizio.".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err("Junction e reparse point non ammessi nelle risorse del servizio.".into());
        }
    }
    Ok(())
}
fn canonical_child(root: &Path, path: &Path) -> Result<PathBuf> {
    reject_link(root)?;
    let base = root.canonicalize().map_err(fail)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Percorso esterno alla directory gestita.")?;
    let mut current = root.to_owned();
    for component in relative.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err("Percorso non canonico.".into());
        }
        current.push(component);
        reject_link(&current)?;
    }
    let full = current.canonicalize().map_err(fail)?;
    if !full.starts_with(&base) || full == base {
        return Err("Percorso esterno alla directory gestita.".into());
    }
    Ok(full)
}

fn source(
    app_root: &Path,
    id: &str,
) -> Result<(Environment, NativeDistribution, PathBuf, PathBuf)> {
    valid_id(id)?;
    reject_link(app_root)?;
    let registry_path = canonical_child(app_root, &app_root.join("environment-registry.json"))?;
    let bytes = fs::read(registry_path).map_err(fail)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("Registro ambienti troppo grande.".into());
    }
    let registry: Registry = serde_json::from_slice(&bytes).map_err(fail)?;
    let environment = registry
        .environments
        .into_iter()
        .find(|item| item.id == id)
        .ok_or("Ambiente non registrato.")?;
    if environment.provider != Provider::Native
        || environment.laboratory
        || environment.engine == Engine::Sqlite
    {
        return Err(
            "I servizi Windows sono riservati agli ambienti nativi gestiti, esclusi i laboratori."
                .into(),
        );
    }
    if !environment.initialized {
        return Err("Completare prima l’inizializzazione dell’ambiente nativo.".into());
    }
    let distribution = bundled_distributions()
        .into_iter()
        .find(|d| {
            Some(&d.id) == environment.distribution_id.as_ref() && d.engine == environment.engine
        })
        .ok_or(
            "Il servizio richiede una distribuzione presente nel catalogo statico verificato.",
        )?;
    let directory = canonical_child(app_root, &app_root.join("environments").join(id))?;
    let marker = canonical_child(&directory, &directory.join(".dbm-owner"))?;
    if fs::read_to_string(marker).map_err(fail)? != id {
        return Err("Il marker di proprietà dell’ambiente non corrisponde all’UUID.".into());
    }
    let data = canonical_child(&directory, &directory.join("data"))?;
    let filename = url::Url::parse(&distribution.url)
        .map_err(fail)?
        .path_segments()
        .and_then(|mut p| p.next_back())
        .ok_or("Archivio catalogo non valido.")?
        .to_owned();
    validate_relative(Path::new(&filename))?;
    let production = app_root.join("native-downloads").join(&filename);
    let archive = if production.is_file() {
        canonical_child(app_root, &production)?
    } else if cfg!(debug_assertions) {
        let cache = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("Workspace non valido.")?
            .join("artifacts/cache");
        canonical_child(&cache, &cache.join(filename))?
    } else {
        return Err("Archivio originale assente. Acquisire nuovamente il pacchetto verificato prima di creare il servizio.".into());
    };
    Ok((environment, distribution, data, archive))
}
fn plan_with_base(
    app_root: &Path,
    id: &str,
    base: &Path,
    inspect: impl Fn(&str) -> Result<Option<Snapshot>>,
) -> Result<ServicePlan> {
    let (environment, distribution, data, archive) = source(app_root, id)?;
    let name = service_name(id)?;
    let root = base.join(&name);
    let account = format!("NT SERVICE\\{name}");
    let port = environment
        .port
        .filter(|port| *port > 0)
        .ok_or("Porta ambiente mancante.")?;
    let snapshot = inspect(&name)?;
    let installed = snapshot.is_some();
    let retained = !installed && root.exists();
    if let Some(live) = &snapshot {
        let manifest = read_manifest(&root, id)?;
        validate_snapshot(&manifest, live)?;
    }
    if retained {
        read_manifest(&root, id)?;
    }
    let mut plan=ServicePlan{environment_id:id.into(),environment_name:environment.name,engine:environment.engine,service_name:name,account,source_data:data,service_root:root.clone(),runtime_root:root.join("runtime"),data_path:root.join("data"),distribution_id:distribution.id,version:distribution.version,archive_path:archive,archive_sha256:distribution.sha256,port,installed,status:snapshot.as_ref().map(|s|s.state.clone()).unwrap_or_else(||"notInstalled".into()),actions:if installed{vec!["start".into(),"stop".into(),"remove".into()]}else{vec!["install".into()]},steps:vec!["Arresto pulito dell’istanza nativa prima della copia dei dati.".into(),"Ricostruzione del runtime in ProgramData dal solo archivio SHA-256 del catalogo statico.".into(),"Copia fredda dei dati; gli originali in AppData vengono conservati.".into(),"Servizio a richiesta con account virtuale dedicato e ACL separate per runtime e dati.".into(),"Verifica di marker, percorso SCM e account prima di start, stop o rimozione.".into()],live_scm_certified:false,fingerprint:String::new()};
    if retained {
        plan.status = "retainedData".into();
        plan.actions.clear();
        plan.steps.insert(0,"Registrazione SCM rimossa, dati ProgramData conservati: nessun ritorno automatico alla vecchia copia AppData né sovrascrittura dei dati più recenti.".into());
    }
    plan.fingerprint=format!("{:x}",Sha256::digest(serde_json::to_vec(&serde_json::json!({"id":id,"source":plan.source_data,"root":plan.service_root,"distribution":plan.distribution_id,"sha256":plan.archive_sha256,"port":port,"account":plan.account})).map_err(fail)?));
    Ok(plan)
}

/// Read-only plan. Does not request elevation, download archives, start servers or modify SCM.
pub fn plan(app_root: &Path, id: &str) -> Result<ServicePlan> {
    plan_with_base(app_root, id, &platform::services_base()?, platform::query)
}

/// A reserved DBM name never falls back to the old AppData instance, including
/// after SCM removal while the newer ProgramData data is intentionally retained.
pub fn registration_exists(id: &str) -> Result<bool> {
    Ok(platform::query(&service_name(id)?)?.is_some())
}
pub fn reservation_exists(id: &str) -> Result<bool> {
    let name = service_name(id)?;
    if platform::query(&name)?.is_some() {
        return Ok(true);
    }
    let root = platform::services_base()?.join(name);
    if root.exists() {
        platform::validate_service_root(&root)?;
        return Ok(true);
    }
    Ok(false)
}

/// Called only after the UI presents `plan` and the user chooses a concrete action.
pub async fn request_action(app_root: &Path, id: &str, action: &str) -> Result<ServiceOutcome> {
    if !cfg!(feature = "desktop") {
        return Err(
            "L’elevazione servizi è disponibile esclusivamente nell’app desktop Tauri.".into(),
        );
    }
    let current = std::env::current_exe().map_err(fail)?;
    if !current
        .file_stem()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.eq_ignore_ascii_case("database-manager")
                || name.eq_ignore_ascii_case("Database Manager")
        })
        .unwrap_or(false)
    {
        return Err(
            "Il bridge e i processi di test non avviano helper elevati. Usare l’app desktop."
                .into(),
        );
    }
    let action = Action::parse(action)?;
    let initial = plan(app_root, id)?;
    if !initial
        .actions
        .iter()
        .any(|allowed| allowed == action.text())
    {
        return Err("L’azione non è disponibile nello stato attuale del servizio.".into());
    }
    if action == Action::Install {
        let manager = EnvironmentManager::new(app_root.to_owned())?;
        manager.stop(id).await?;
    }
    let plan = plan(app_root, id)?;
    if !plan.actions.iter().any(|allowed| allowed == action.text()) {
        return Err("L’azione non è disponibile nello stato attuale del servizio.".into());
    }
    let app_root = app_root.canonicalize().map_err(fail)?;
    let nonce = Uuid::new_v4().to_string();
    let helper = std::env::current_exe()
        .map_err(fail)?
        .canonicalize()
        .map_err(fail)?;
    let args = vec![
        "--dbm-service-helper".into(),
        action.text().into(),
        app_root.to_string_lossy().into_owned(),
        id.into(),
        plan.fingerprint.clone(),
        nonce.clone(),
    ];
    tokio::task::spawn_blocking(move || platform::elevate(&helper, &args))
        .await
        .map_err(fail)??;
    let reply = platform::operations_base()?.join(format!("{nonce}.json"));
    let value: std::result::Result<ServiceOutcome, String> =
        serde_json::from_slice(&fs::read(reply).map_err(fail)?).map_err(fail)?;
    value
}

/// Intercept this before opening Tauri or acquiring the single-instance lock.
pub fn run_helper(args: &[String]) -> Option<Result<ServiceOutcome>> {
    if args.first().map(String::as_str) != Some("--dbm-service-helper") {
        return None;
    }
    let run = || -> Result<ServiceOutcome> {
        if args.len() != 6 {
            return Err("Argomenti helper non validi.".into());
        }
        let action = Action::parse(&args[1])?;
        valid_id(&args[3])?;
        valid_id(&args[5])?;
        if args[4].len() != 64 || !args[4].bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Fingerprint piano non valido.".into());
        }
        platform::require_elevated()?;
        let root = PathBuf::from(&args[2]);
        let planned = plan(&root, &args[3])?;
        if planned.fingerprint != args[4] {
            return Err(
                "Il piano è cambiato dopo la richiesta di elevazione. Riaprire l’anteprima.".into(),
            );
        }
        let source_pin = PinnedTree::open(&root.join("environments").join(&args[3]))?;
        if action == Action::Install
            && std::net::TcpListener::bind(("127.0.0.1", planned.port)).is_err()
        {
            return Err("L’istanza deve essere arrestata e la porta libera prima della migrazione a servizio.".into());
        }
        let mut scm = platform::NativeScm;
        execute(&planned, action, &source_pin, &mut scm)
    };
    let result = run();
    // Never write elevated replies into user-controlled AppData paths.
    if args.len() == 6 && valid_id(&args[5]).is_ok() && platform::require_elevated().is_ok() {
        if let Ok(base) = platform::prepare_operations() {
            let path = base.join(format!("{}.json", args[5]));
            if let Ok(mut file) = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                let _ = file.write_all(&serde_json::to_vec(&result).unwrap_or_default());
            }
        }
    }
    Some(result)
}

/// Windows APIs store image paths as a command line. This encodes an argv vector;
/// it never invokes cmd.exe, PowerShell, a shell, environment expansion or PATH lookup.
fn quote_arg(arg: &str) -> String {
    let mut out = String::from("\"");
    let mut slash = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            slash += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat(slash * 2 + 1));
            out.push('"');
        } else {
            out.push_str(&"\\".repeat(slash));
            out.push(ch);
        }
        slash = 0;
    }
    out.push_str(&"\\".repeat(slash * 2));
    out.push('"');
    out
}
fn command_line(binary: &Path, args: &[String]) -> String {
    std::iter::once(binary.to_string_lossy().into_owned())
        .chain(args.iter().cloned())
        .map(|arg| quote_arg(&arg))
        .collect::<Vec<_>>()
        .join(" ")
}
fn marker(manifest: &Manifest) -> String {
    format!(
        "DatabaseManager:{}:{}",
        manifest.environment_id, manifest.archive_sha256
    )
}
fn validate_snapshot(manifest: &Manifest, live: &Snapshot) -> Result<()> {
    if !live.image_path.eq_ignore_ascii_case(&manifest.image_path)
        || !live.account.eq_ignore_ascii_case(&manifest.account)
        || live.description != marker(manifest)
        || live.service_type != 0x10
    {
        return Err("Il servizio SCM non corrisponde a percorso, account e marker del manifest protetto; operazione rifiutata.".into());
    }
    Ok(())
}
fn read_manifest(root: &Path, id: &str) -> Result<Manifest> {
    valid_id(id)?;
    platform::validate_service_root(root)?;
    let path = canonical_child(root, &root.join("service-manifest.json"))?;
    let manifest: Manifest =
        serde_json::from_slice(&fs::read(path).map_err(fail)?).map_err(fail)?;
    if manifest.format != FORMAT
        || manifest.environment_id != id
        || manifest.service_name != service_name(id)?
        || manifest.account != format!("NT SERVICE\\{}", manifest.service_name)
    {
        return Err("Manifest di proprietà del servizio non valido.".into());
    }
    let distribution = bundled_distributions()
        .into_iter()
        .find(|d| {
            d.id == manifest.distribution_id
                && d.engine == manifest.engine
                && d.sha256 == manifest.archive_sha256
        })
        .ok_or("Il manifest non corrisponde al catalogo statico.")?;
    let _ = distribution;
    validate_relative(&manifest.binary_relative)?;
    let binary = root.join("runtime").join(&manifest.binary_relative);
    canonical_child(root, &binary)?;
    if command_line(&binary, &manifest.arguments) != manifest.image_path {
        return Err("Il percorso eseguibile non corrisponde al manifest del servizio.".into());
    }
    Ok(manifest)
}

struct PinnedTree {
    files: Vec<(PathBuf, File)>,
    directories: Vec<(PathBuf, File)>,
}
impl PinnedTree {
    fn open(root: &Path) -> Result<Self> {
        reject_link(root)?;
        let mut tree = Self {
            files: vec![],
            directories: vec![],
        };
        let mut total = 0;
        tree.walk(root, Path::new(""), &mut total)?;
        Ok(tree)
    }
    fn walk(&mut self, root: &Path, relative: &Path, total: &mut u64) -> Result<()> {
        let directory = root.join(relative);
        self.directories.push((
            relative.to_owned(),
            platform::open_locked(&directory, true)?,
        ));
        for entry in fs::read_dir(&directory).map_err(fail)? {
            let entry = entry.map_err(fail)?;
            let name = entry.file_name();
            let next = relative.join(name);
            validate_relative(&next)?;
            let path = root.join(&next);
            reject_link(&path)?;
            let metadata = entry.metadata().map_err(fail)?;
            if metadata.is_dir() {
                self.walk(root, &next, total)?
            } else if metadata.is_file() {
                if self.files.len() >= MAX_FILES {
                    return Err("Troppi file nella directory dati.".into());
                }
                *total = total
                    .checked_add(metadata.len())
                    .ok_or("Dimensione dati non valida.")?;
                if *total > MAX_BYTES {
                    return Err("La migrazione servizio supera il limite di 512 GiB.".into());
                }
                let file = platform::open_locked(&path, false)?;
                platform::reject_hardlink(&file)?;
                self.files.push((next, file));
            } else {
                return Err("Tipo di file non ammesso nella directory dati.".into());
            }
        }
        Ok(())
    }
    fn copy_data(&self, destination: &Path) -> Result<()> {
        for (relative, _) in &self.directories {
            if let Ok(child) = relative.strip_prefix("data") {
                if !child.as_os_str().is_empty() {
                    fs::create_dir_all(destination.join(child)).map_err(fail)?
                }
            }
        }
        for (relative, file) in &self.files {
            let Ok(data_relative) = relative.strip_prefix("data") else {
                continue;
            };
            if data_relative.as_os_str().is_empty() {
                continue;
            }
            let name = data_relative
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            if matches!(
                name,
                "postmaster.pid"
                    | "postmaster.opts"
                    | "postgresql.conf"
                    | "postgresql.auto.conf"
                    | "pg_hba.conf"
                    | "pg_ident.conf"
                    | "mysqld-auto.cnf"
            ) {
                continue;
            }
            let target = destination.join(data_relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(fail)?
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(fail)?;
            let mut input = file.try_clone().map_err(fail)?;
            input.seek(SeekFrom::Start(0)).map_err(fail)?;
            std::io::copy(&mut input, &mut output).map_err(fail)?;
        }
        Ok(())
    }
}

trait Scm {
    fn query(&mut self, name: &str) -> Result<Option<Snapshot>>;
    fn install(&mut self, manifest: &Manifest) -> Result<()>;
    fn start(&mut self, name: &str) -> Result<()>;
    fn stop(&mut self, name: &str) -> Result<()>;
    fn remove(&mut self, name: &str) -> Result<()>;
}
fn execute(
    plan: &ServicePlan,
    action: Action,
    source: &PinnedTree,
    scm: &mut impl Scm,
) -> Result<ServiceOutcome> {
    if action == Action::Install {
        if scm.query(&plan.service_name)?.is_some() {
            return Err("Un servizio con lo stesso nome esiste già: non viene modificato.".into());
        }
        if plan.service_root.exists() {
            return Err("La directory ProgramData esiste già. Una precedente migrazione richiede revisione esplicita; i dati non vengono sovrascritti.".into());
        }
        platform::prepare_root(&plan.service_root)?;
        let result = prepare_install(plan, source).and_then(|manifest| {
            scm.install(&manifest)?;
            let sid = platform::service_sid(&plan.account)?;
            platform::secure_tree(&plan.service_root, &sid, false)?;
            platform::secure_tree(&plan.data_path, &sid, true)?;
            write_manifest(&plan.service_root, &manifest)?;
            let live = scm
                .query(&plan.service_name)?
                .ok_or("Servizio non presente dopo la creazione.")?;
            validate_snapshot(&manifest, &live)?;
            Ok(manifest)
        });
        if let Err(error) = result {
            return Err(format!("Installazione interrotta; dati originali conservati. Le risorse parziali restano per diagnosi e non vengono adottate automaticamente: {error}"));
        }
        return Ok(ServiceOutcome{action:action.text().into(),service_name:plan.service_name.clone(),message:"Servizio creato a richiesta con account virtuale dedicato. Avvio separato; dati originali conservati.".into(),status:"stopped".into(),data_path:plan.data_path.clone()});
    }
    let manifest = read_manifest(&plan.service_root, &plan.environment_id)?;
    let status = control(&manifest, action, scm)?;
    Ok(ServiceOutcome {
        action: action.text().into(),
        service_name: plan.service_name.clone(),
        message: if action == Action::Remove {
            "Registrazione SCM rimossa; runtime e dati ProgramData conservati."
        } else {
            "Operazione servizio completata."
        }
        .into(),
        status,
        data_path: plan.data_path.clone(),
    })
}
fn write_manifest(root: &Path, manifest: &Manifest) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(root.join("service-manifest.json"))
        .map_err(fail)?;
    file.write_all(&serde_json::to_vec_pretty(manifest).map_err(fail)?)
        .map_err(fail)
}
fn prepare_install(plan: &ServicePlan, source: &PinnedTree) -> Result<Manifest> {
    let archive_destination = plan.service_root.join("runtime-source.zip");
    let mut archive_source = platform::open_locked(&plan.archive_path, false)?;
    platform::reject_hardlink(&archive_source)?;
    if archive_source.metadata().map_err(fail)?.len() > 2 * 1024 * 1024 * 1024 {
        return Err("Archivio originale oltre il limite di 2 GiB.".into());
    }
    let mut protected_archive = fs::OpenOptions::new()
        .write(true)
        .read(true)
        .create_new(true)
        .open(&archive_destination)
        .map_err(fail)?;
    std::io::copy(&mut archive_source, &mut protected_archive).map_err(fail)?;
    protected_archive.flush().map_err(fail)?;
    protected_archive.seek(SeekFrom::Start(0)).map_err(fail)?;
    verify_archive(&mut protected_archive, &plan.archive_sha256)?;
    protected_archive.seek(SeekFrom::Start(0)).map_err(fail)?;
    extract_archive(protected_archive, &plan.runtime_root)?;
    platform::prepare_private_data(&plan.data_path)?;
    source.copy_data(&plan.data_path)?;
    fs::create_dir_all(plan.data_path.join("tmp")).map_err(fail)?;
    fs::create_dir_all(plan.data_path.join("import")).map_err(fail)?;
    let executable = match plan.engine {
        Engine::Postgresql => "pg_ctl.exe",
        Engine::Mysql => "mysqld.exe",
        Engine::Mariadb => "mariadbd.exe",
        Engine::Mongodb => "mongod.exe",
        Engine::Sqlite => return Err("SQLite non usa servizi.".into()),
    };
    let binary = find_binary(&plan.runtime_root, executable, 0)?
        .ok_or("Eseguibile server assente nell’archivio verificato.")?;
    canonical_child(&plan.runtime_root, &binary)?;
    let config_dir = plan.service_root.join("config");
    fs::create_dir(&config_dir).map_err(fail)?;
    let path = |p: &Path| p.to_string_lossy().replace('\\', "/");
    let arguments = match plan.engine {
        Engine::Postgresql => {
            let conf=format!("data_directory = '{}'\nlisten_addresses = '127.0.0.1'\nport = {}\nhba_file = '{}'\nident_file = '{}'\nlogging_collector = on\nlog_directory = 'log'\n",path(&plan.data_path).replace('\'',"''"),plan.port,path(&config_dir.join("pg_hba.conf")).replace('\'',"''"),path(&config_dir.join("pg_ident.conf")).replace('\'',"''"));
            fs::write(config_dir.join("postgresql.conf"), conf).map_err(fail)?;
            fs::write(
                config_dir.join("pg_hba.conf"),
                "host all all 127.0.0.1/32 scram-sha-256\nhost all all ::1/128 scram-sha-256\n",
            )
            .map_err(fail)?;
            fs::write(config_dir.join("pg_ident.conf"), "").map_err(fail)?;
            fs::write(plan.data_path.join("postgresql.auto.conf"), "").map_err(fail)?;
            vec![
                "runservice".into(),
                "-N".into(),
                plan.service_name.clone(),
                "-D".into(),
                config_dir.to_string_lossy().into_owned(),
                "-w".into(),
                "-t".into(),
                "60".into(),
            ]
        }
        Engine::Mysql | Engine::Mariadb => {
            let base = binary
                .parent()
                .and_then(Path::parent)
                .ok_or("Runtime SQL non valido.")?;
            let config = config_dir.join("server.ini");
            let content=format!("[mysqld]\nbasedir=\"{}\"\ndatadir=\"{}\"\nport={}\nbind-address=127.0.0.1\nlocal-infile=0\ntmpdir=\"{}\"\nsecure-file-priv=\"{}\"\n{}",path(base),path(&plan.data_path),plan.port,path(&plan.data_path.join("tmp")),path(&plan.data_path.join("import")),if plan.engine==Engine::Mysql{"mysqlx=OFF\n"}else{""});
            fs::write(&config, content).map_err(fail)?;
            vec![
                format!("--defaults-file={}", config.display()),
                plan.service_name.clone(),
            ]
        }
        Engine::Mongodb => {
            let key = source
                .files
                .iter()
                .find(|(relative, _)| relative == Path::new("mongo-keyfile"))
                .ok_or("Keyfile MongoDB di proprietà dell’ambiente non presente.")?;
            let mut input = key.1.try_clone().map_err(fail)?;
            input.seek(SeekFrom::Start(0)).map_err(fail)?;
            let keypath = plan.data_path.join(".dbm-mongo-keyfile");
            let mut output = File::create(&keypath).map_err(fail)?;
            std::io::copy(&mut input, &mut output).map_err(fail)?;
            let config = config_dir.join("mongod.json");
            let content = serde_json::json!({"storage":{"dbPath":path(&plan.data_path)},"systemLog":{"destination":"file","path":path(&plan.data_path.join("server.log")),"logAppend":true},"net":{"bindIp":"127.0.0.1","port":plan.port},"replication":{"replSetName":"dbm"},"security":{"authorization":"enabled","keyFile":path(&keypath)}});
            fs::write(&config, serde_json::to_vec_pretty(&content).map_err(fail)?).map_err(fail)?;
            vec![
                "--config".into(),
                config.to_string_lossy().into_owned(),
                "--service".into(),
            ]
        }
        Engine::Sqlite => unreachable!(),
    };
    let relative = binary
        .strip_prefix(&plan.runtime_root)
        .map_err(fail)?
        .to_owned();
    validate_relative(&relative)?;
    Ok(Manifest {
        format: FORMAT,
        environment_id: plan.environment_id.clone(),
        engine: plan.engine,
        service_name: plan.service_name.clone(),
        account: plan.account.clone(),
        distribution_id: plan.distribution_id.clone(),
        archive_sha256: plan.archive_sha256.clone(),
        port: plan.port,
        binary_relative: relative,
        arguments: arguments.clone(),
        image_path: command_line(&binary, &arguments),
        source_root: plan.source_data.parent().unwrap().to_owned(),
    })
}
fn verify_archive(file: &mut impl Read, expected: &str) -> Result<()> {
    let mut hash = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let read = file.read(&mut buffer).map_err(fail)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if format!("{:x}", hash.finalize()) != expected.to_ascii_lowercase() {
        return Err(
            "SHA-256 dell’archivio non corrispondente al catalogo statico: nessun servizio creato."
                .into(),
        );
    }
    Ok(())
}
fn extract_archive(reader: impl Read + Seek, destination: &Path) -> Result<()> {
    fs::create_dir(destination).map_err(fail)?;
    let mut archive = zip::ZipArchive::new(reader).map_err(fail)?;
    if archive.len() > MAX_FILES {
        return Err("Archivio con troppi file.".into());
    }
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(fail)?;
        if entry
            .unix_mode()
            .map(|mode| mode & 0o170000 == 0o120000)
            .unwrap_or(false)
        {
            return Err("Link ZIP non ammesso.".into());
        }
        let relative = entry
            .enclosed_name()
            .ok_or("Percorso ZIP esterno alla directory runtime.")?;
        validate_relative(&relative)?;
        total = total
            .checked_add(entry.size())
            .ok_or("Archivio troppo grande.")?;
        if total > 8 * 1024 * 1024 * 1024 {
            return Err("Runtime estratto oltre 8 GiB.".into());
        }
        let target = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(target).map_err(fail)?
        } else {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(fail)?
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(target)
                .map_err(fail)?;
            std::io::copy(&mut entry, &mut output).map_err(fail)?;
        }
    }
    Ok(())
}
fn find_binary(root: &Path, name: &str, depth: usize) -> Result<Option<PathBuf>> {
    if depth > 7 {
        return Ok(None);
    }
    for entry in fs::read_dir(root).map_err(fail)? {
        let entry = entry.map_err(fail)?;
        reject_link(&entry.path())?;
        if entry.file_type().map_err(fail)?.is_file()
            && entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(name)
        {
            return Ok(Some(entry.path()));
        }
        if entry.file_type().map_err(fail)?.is_dir() {
            if let Some(binary) = find_binary(&entry.path(), name, depth + 1)? {
                return Ok(Some(binary));
            }
        }
    }
    Ok(None)
}

#[cfg(windows)]
#[path = "windows_service/platform.rs"]
mod platform;

#[cfg(not(windows))]
#[path = "windows_service/unsupported.rs"]
mod platform;
#[cfg(test)]
#[path = "windows_service/tests.rs"]
mod tests;

fn control(manifest: &Manifest, action: Action, scm: &mut impl Scm) -> Result<String> {
    let name = &manifest.service_name;
    let live = scm.query(name)?.ok_or("Servizio non installato.")?;
    validate_snapshot(manifest, &live)?;
    match action {
        Action::Start => scm.start(name)?,
        Action::Stop => scm.stop(name)?,
        Action::Remove => {
            scm.stop(name)?;
            let fresh = scm
                .query(name)?
                .ok_or("Servizio scomparso durante la verifica.")?;
            validate_snapshot(manifest, &fresh)?;
            scm.remove(name)?
        }
        Action::Install => return Err("Usare il percorso di installazione verificato.".into()),
    }
    Ok(scm
        .query(name)?
        .map(|s| s.state)
        .unwrap_or_else(|| "removed".into()))
}
