use crate::assistant::{self, AiConfig};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub online: bool,
    pub installed: bool,
    pub ownership: Option<&'static str>,
    pub pid: Option<u32>,
    pub stop_fingerprint: Option<String>,
    pub diagnostic: String,
}

#[derive(Default)]
pub struct OllamaLifecycle {
    state: Mutex<LifecycleState>,
}

#[derive(Default)]
struct LifecycleState {
    owned: Option<OwnedDaemon>,
    generation: u64,
    cancelled: VecDeque<String>,
    last_shared_stop: Option<(String, u32, Instant)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartOutcome {
    pub accepted: bool,
    pub state: Option<OllamaStatus>,
}

struct OwnedDaemon {
    child: Child,
    endpoint: String,
    request_id: String,
    started: Instant,
    #[cfg(windows)]
    _job: OllamaJob,
}

impl OwnedDaemon {
    fn fingerprint(&self) -> String {
        fingerprint(&self.endpoint, self.child.id(), 0, &self.request_id)
    }

    fn starting_status(&self) -> OllamaStatus {
        OllamaStatus {
            online: false,
            installed: true,
            ownership: Some("owned"),
            pid: Some(self.child.id()),
            stop_fingerprint: Some(self.fingerprint()),
            diagnostic: if self.started.elapsed() < Duration::from_secs(12) {
                "Ollama si sta avviando. Puoi interrompere l’avvio.".into()
            } else {
                "Ollama è ancora in avvio. Puoi aggiornare lo stato o interromperlo.".into()
            },
        }
    }
}

impl Drop for OwnedDaemon {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

impl OllamaLifecycle {
    pub async fn status(&self, config: &AiConfig) -> OllamaStatus {
        let probe = probe_short(config).await;
        let installed = ollama_executable().is_some();
        if let Err(diagnostic) = probe {
            let mut state = self.state.lock().await;
            remove_exited(&mut state.owned);
            if let Some(owned) = state
                .owned
                .as_ref()
                .filter(|owned| owned.endpoint == config.endpoint)
            {
                return owned.starting_status();
            }
            return OllamaStatus {
                online: false,
                installed,
                ownership: None,
                pid: None,
                stop_fingerprint: None,
                diagnostic,
            };
        }
        let shared = match management_address(config) {
            Ok(address) => listening_ollama(address).await.ok().flatten(),
            Err(_) => None,
        };
        let shared_pid = shared.as_ref().map(|owner| owner.pid);
        let mut state = self.state.lock().await;
        remove_exited(&mut state.owned);
        let own = state.owned.as_ref().filter(|daemon| {
            daemon.endpoint == config.endpoint
                && shared_pid.is_none_or(|pid| pid == daemon.child.id())
        });
        let restarted =
            state
                .last_shared_stop
                .as_ref()
                .is_some_and(|(endpoint, previous, stopped)| {
                    endpoint == &config.endpoint
                        && stopped.elapsed() < Duration::from_secs(60)
                        && shared_pid.is_none_or(|pid| pid != *previous)
                });
        OllamaStatus {
            online: true,
            installed,
            ownership: Some(if own.is_some() { "owned" } else { "shared" }),
            pid: own.map(|daemon| daemon.child.id()).or(shared_pid),
            stop_fingerprint: own
                .map(OwnedDaemon::fingerprint)
                .or_else(|| shared.map(|owner| owner.fingerprint(&config.endpoint))),
            diagnostic: if own.is_some() {
                "Ollama avviato da Database Manager.".into()
            } else if restarted {
                "Ollama condiviso è tornato attivo dopo lo spegnimento. Per lasciarlo spento, esci anche dall’app Ollama nell’area di notifica.".into()
            } else {
                "Ollama è raggiungibile come servizio condiviso.".into()
            },
        }
    }

    pub async fn start(
        &self,
        config: &AiConfig,
        request_id: &str,
        allowed: impl Fn() -> bool,
        accepted: impl FnOnce(),
    ) -> Result<StartOutcome> {
        let generation = {
            let state = self.state.lock().await;
            if !allowed() || state.cancelled.iter().any(|id| id == request_id) {
                return Ok(StartOutcome {
                    accepted: false,
                    state: None,
                });
            }
            state.generation
        };
        let online = probe_short(config).await.is_ok();
        let mut state = self.state.lock().await;
        if state.generation != generation
            || !allowed()
            || state.cancelled.iter().any(|id| id == request_id)
        {
            return Ok(StartOutcome {
                accepted: false,
                state: None,
            });
        }
        remove_exited(&mut state.owned);
        if let Some(daemon) = state.owned.as_ref() {
            if daemon.endpoint != config.endpoint {
                return Err(
                    "Spegni prima l’istanza Ollama aperta sull’indirizzo precedente.".into(),
                );
            }
            accepted();
            return Ok(StartOutcome {
                accepted: true,
                state: Some(daemon.starting_status()),
            });
        }
        if online {
            accepted();
            return Ok(StartOutcome {
                accepted: true,
                state: None,
            });
        }
        let address = management_address(config)?;
        {
            let executable =
                ollama_executable().ok_or("Ollama non è installato o non è nel PATH.")?;
            let reservation = std::net::TcpListener::bind(address).map_err(|_| {
                "La porta Ollama è occupata. Verifica il servizio o cambia indirizzo."
            })?;
            drop(reservation);
            let mut command = Command::new(executable);
            command
                .arg("serve")
                .env("OLLAMA_HOST", address.to_string())
                .env("OLLAMA_NO_CLOUD", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            hide(&mut command);
            let mut child = command
                .spawn()
                .map_err(|e| format!("Avvio Ollama non riuscito: {e}"))?;
            #[cfg(windows)]
            let job = match OllamaJob::attach(&child) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(error);
                }
            };
            let owned = OwnedDaemon {
                child,
                endpoint: config.endpoint.clone(),
                request_id: request_id.into(),
                started: Instant::now(),
                #[cfg(windows)]
                _job: job,
            };
            let status = owned.starting_status();
            state.owned = Some(owned);
            accepted();
            Ok(StartOutcome {
                accepted: true,
                state: Some(status),
            })
        }
    }

    pub async fn wait_ready(&self, config: &AiConfig) -> Result<()> {
        for _ in 0..30 {
            if probe_short(config).await.is_ok() {
                return Ok(());
            }
            if !self.is_managed().await {
                return Err("Il processo Ollama avviato è terminato o è stato interrotto.".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Err(
            "Ollama è stato avviato, ma non risponde ancora. Aggiorna lo stato prima di riprovare."
                .into(),
        )
    }

    pub async fn cancel_start(&self, request_id: &str, before_stop: impl FnOnce()) -> Result<()> {
        let mut state = self.state.lock().await;
        before_stop();
        state.generation = state.generation.wrapping_add(1);
        if state.cancelled.len() == 32 {
            state.cancelled.pop_front();
        }
        state.cancelled.push_back(request_id.into());
        remove_exited(&mut state.owned);
        if state
            .owned
            .as_ref()
            .is_some_and(|owner| owner.request_id == request_id)
        {
            drop(state.owned.take());
        }
        Ok(())
    }

    pub async fn stop(
        &self,
        config: &AiConfig,
        expected: &str,
        confirmed: bool,
        before_stop: impl FnOnce(),
    ) -> Result<()> {
        if expected.is_empty() {
            return Err("Aggiorna e verifica prima il processo Ollama.".into());
        }
        let mut state = self.state.lock().await;
        remove_exited(&mut state.owned);
        if let Some(owned) = state
            .owned
            .as_mut()
            .filter(|daemon| daemon.endpoint == config.endpoint)
        {
            if expected == owned.fingerprint() {
                before_stop();
                owned
                    .child
                    .kill()
                    .map_err(|e| format!("Arresto Ollama non riuscito: {e}"))?;
                owned.child.wait().map_err(|e| e.to_string())?;
                state.owned.take();
                state.generation = state.generation.wrapping_add(1);
                return Ok(());
            }
        }
        if !confirmed {
            return Err("Conferma lo spegnimento del processo Ollama condiviso.".into());
        }
        drop(state);
        if probe(config).await.is_err() {
            return Err("Ollama non risponde più. Aggiorna lo stato.".into());
        }
        let owner = listening_ollama(management_address(config)?)
            .await?
            .ok_or("Il processo Ollama condiviso non è identificabile con certezza.")?;
        if expected != owner.fingerprint(&config.endpoint) {
            return Err(
                "Il processo Ollama è cambiato. Aggiorna lo stato prima di spegnerlo.".into(),
            );
        }
        let mut state = self.state.lock().await;
        terminate_verified(&owner, before_stop)?;
        state.generation = state.generation.wrapping_add(1);
        state.last_shared_stop = Some((config.endpoint.clone(), owner.pid, Instant::now()));
        Ok(())
    }

    pub async fn is_managed(&self) -> bool {
        let mut state = self.state.lock().await;
        remove_exited(&mut state.owned);
        state.owned.is_some()
    }
}

async fn probe(config: &AiConfig) -> Result<()> {
    let mut health_config = config.clone();
    health_config.timeout_seconds = 5;
    assistant::list_ollama_models(&health_config)
        .await
        .map(|_| ())
}

async fn probe_short(config: &AiConfig) -> Result<()> {
    tokio::time::timeout(Duration::from_millis(400), probe(config))
        .await
        .map_err(|_| "Ollama non è ancora raggiungibile.".to_owned())?
}

fn management_address(config: &AiConfig) -> Result<SocketAddr> {
    let original =
        reqwest::Url::parse(&config.endpoint).map_err(|_| "Indirizzo Ollama non valido.")?;
    assistant::endpoint(config, "api/tags")?;
    if original.scheme() != "http" || !matches!(original.path(), "/" | "/api" | "/api/") {
        return Err("Avvio e spegnimento sono disponibili per un indirizzo HTTP locale diretto, senza percorso personalizzato.".into());
    }
    let ip = match original.host_str() {
        Some("localhost" | "127.0.0.1") => IpAddr::V4(Ipv4Addr::LOCALHOST),
        Some("[::1]" | "::1") => IpAddr::V6(Ipv6Addr::LOCALHOST),
        _ => return Err("Ollama deve essere raggiungibile tramite loopback.".into()),
    };
    Ok(SocketAddr::new(
        ip,
        original.port_or_known_default().unwrap_or(11434),
    ))
}

fn remove_exited(daemon: &mut Option<OwnedDaemon>) {
    if daemon
        .as_mut()
        .is_some_and(|owned| owned.child.try_wait().ok().flatten().is_some())
    {
        daemon.take();
    }
}

fn ollama_executable() -> Option<PathBuf> {
    let binary = if cfg!(windows) {
        "ollama.exe"
    } else {
        "ollama"
    };
    if let Some(installed) = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("Programs").join("Ollama").join(binary))
        .filter(|path| path.is_file())
    {
        return Some(installed);
    }
    std::env::var_os("PATH").and_then(|search| {
        std::env::split_paths(&search)
            .filter(|path| path.is_absolute())
            .map(|path| path.join(binary))
            .find(|path| path.is_file())
    })
}

fn hide(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn fingerprint(endpoint: &str, pid: u32, birth: u64, path: &str) -> String {
    hex::encode(Sha256::digest(format!(
        "{endpoint}\n{pid}\n{birth}\n{path}"
    )))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedOwner {
    pid: u32,
    birth: u64,
    path: String,
}

impl SharedOwner {
    fn fingerprint(&self, endpoint: &str) -> String {
        fingerprint(endpoint, self.pid, self.birth, &self.path)
    }
}

#[cfg(windows)]
async fn listening_ollama(address: SocketAddr) -> Result<Option<SharedOwner>> {
    let executable = ollama_executable().and_then(|path| path.canonicalize().ok());
    let Some(executable) = executable else {
        return Ok(None);
    };
    let script = r#"
    $addresses = if ($env:DBM_OLLAMA_IP -eq '::1') { @('::1', '::') } else { @('127.0.0.1', '0.0.0.0', '::') }
    $owners = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:DBM_OLLAMA_PORT) -ErrorAction SilentlyContinue |
      Where-Object LocalAddress -In $addresses | Select-Object -ExpandProperty OwningProcess -Unique)
    if ($owners.Count -ne 1) { exit 1 }
    $process = Get-Process -Id $owners[0] -ErrorAction Stop
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    @{pid=$process.Id; birth=$process.StartTime.ToFileTimeUtc(); path=$process.Path} | ConvertTo-Json -Compress
    "#;
    let mut command = tokio::process::Command::new("powershell.exe");
    command.creation_flags(0x08000000);
    command
        .kill_on_drop(true)
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("DBM_OLLAMA_IP", address.ip().to_string())
        .env("DBM_OLLAMA_PORT", address.port().to_string());
    let output = tokio::time::timeout(Duration::from_secs(4), command.output())
        .await
        .map_err(|_| "Identificazione del processo Ollama scaduta.")?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }
    let owner: SharedOwner = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let path = PathBuf::from(&owner.path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    Ok(path
        .to_string_lossy()
        .eq_ignore_ascii_case(&executable.to_string_lossy())
        .then_some(owner))
}

#[cfg(not(windows))]
async fn listening_ollama(_address: SocketAddr) -> Result<Option<SharedOwner>> {
    Ok(None)
}

#[cfg(windows)]
fn terminate_verified(owner: &SharedOwner, before_stop: impl FnOnce()) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
            WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE,
        },
    };
    // Retain the Windows process handle through identity checks and termination.
    // A reused PID cannot switch the process referenced by this handle.
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
            0,
            owner.pid,
        );
        if handle.is_null() {
            return Err("Accesso al processo Ollama condiviso non riuscito.".into());
        }
        let result = (|| {
            let mut started: FILETIME = std::mem::zeroed();
            let mut exited: FILETIME = std::mem::zeroed();
            let mut kernel: FILETIME = std::mem::zeroed();
            let mut user: FILETIME = std::mem::zeroed();
            let mut path = vec![0u16; 32768];
            let mut len = path.len() as u32;
            if GetProcessTimes(handle, &mut started, &mut exited, &mut kernel, &mut user) == 0
                || QueryFullProcessImageNameW(handle, 0, path.as_mut_ptr(), &mut len) == 0
            {
                return Err("Impossibile verificare l’identità del processo Ollama.".into());
            }
            let birth = (started.dwHighDateTime as u64) << 32 | started.dwLowDateTime as u64;
            let process_path = String::from_utf16_lossy(&path[..len as usize]);
            if birth != owner.birth || !process_path.eq_ignore_ascii_case(&owner.path) {
                return Err("Il processo Ollama è cambiato. Aggiorna lo stato.".into());
            }
            before_stop();
            if TerminateProcess(handle, 1) == 0 || WaitForSingleObject(handle, 6000) != 0 {
                return Err("Non è stato possibile confermare l’arresto di Ollama.".into());
            }
            Ok(())
        })();
        CloseHandle(handle);
        result
    }
}

#[cfg(not(windows))]
fn terminate_verified(_owner: &SharedOwner, _before_stop: impl FnOnce()) -> Result<()> {
    Err("Lo spegnimento del processo condiviso è disponibile su Windows.".into())
}

#[cfg(windows)]
struct OllamaJob(usize);

#[cfg(windows)]
impl OllamaJob {
    fn attach(child: &Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        // The owning kernel job stops only this registered child tree when the app closes.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("Creazione supervisore Ollama non riuscita.".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle()) == 0
            {
                CloseHandle(job);
                return Err(
                    "Impossibile registrare l’istanza Ollama per lo spegnimento alla chiusura."
                        .into(),
                );
            }
            Ok(Self(job as usize))
        }
    }
}

#[cfg(windows)]
impl Drop for OllamaJob {
    fn drop(&mut self) {
        // The handle is uniquely owned by this job.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Json, Router};
    use serde_json::json;

    #[tokio::test]
    async fn revived_shared_listener_is_reported_without_an_unverified_stop_target() {
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}", socket.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let server =
                Router::new().route("/api/tags", get(|| async { Json(json!({"models":[]})) }));
            axum::serve(socket, server).await.unwrap();
        });
        let lifecycle = OllamaLifecycle::default();
        lifecycle.state.lock().await.last_shared_stop = Some((endpoint.clone(), 1, Instant::now()));
        let status = lifecycle
            .status(&AiConfig {
                provider: assistant::AiProvider::Ollama,
                endpoint,
                model: String::new(),
                timeout_seconds: 5,
            })
            .await;
        assert!(status.online);
        assert_eq!(status.ownership, Some("shared"));
        assert!(status.diagnostic.contains("tornato attivo"));
        assert!(status.stop_fingerprint.is_none());
        server.abort();
    }
}
