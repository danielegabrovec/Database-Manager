//! Win32 adapter. Every mutating entry point is reached only by run_helper after UAC.
use super::*;
use std::{
    mem::{size_of, zeroed},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    ptr::{null, null_mut},
    time::{Duration, Instant},
};
use windows_sys::Win32::{
    Foundation::{
        CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_SERVICE_ALREADY_RUNNING,
        ERROR_SERVICE_DOES_NOT_EXIST, ERROR_SERVICE_NOT_ACTIVE,
    },
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetNamedSecurityInfoW, SetNamedSecurityInfoW, SE_FILE_OBJECT,
        },
        GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl,
        GetSecurityDescriptorOwner, LookupAccountNameW, ACCESS_ALLOWED_ACE, ACL,
        DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED,
    },
    Storage::FileSystem::{
        CreateDirectoryW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ,
    },
    System::{
        Com::{CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED},
        Services::*,
        Threading::{GetExitCodeProcess, WaitForSingleObject},
    },
    UI::Shell::{
        FOLDERID_ProgramData, IsUserAnAdmin, SHGetKnownFolderPath, ShellExecuteExW,
        SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    },
};
fn wide(text: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    text.as_ref().encode_wide().chain(Some(0)).collect()
}
unsafe fn string(pointer: *const u16) -> String {
    if pointer.is_null() {
        return String::new();
    }
    let mut count = 0;
    while count < 32768 && *pointer.add(count) != 0 {
        count += 1
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, count))
}
fn win_error(context: &str) -> String {
    format!("{context}: {}", std::io::Error::last_os_error())
}
struct Local(PSECURITY_DESCRIPTOR);
impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}
struct Handle(SC_HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseServiceHandle(self.0);
            }
        }
    }
}
fn scm(access: u32) -> Result<Handle> {
    let handle = unsafe { OpenSCManagerW(null(), null(), access) };
    if handle.is_null() {
        Err(win_error("Accesso al gestore servizi"))
    } else {
        Ok(Handle(handle))
    }
}
fn service(manager: &Handle, name: &str, access: u32) -> Result<Option<Handle>> {
    let handle = unsafe { OpenServiceW(manager.0, wide(name).as_ptr(), access) };
    if handle.is_null() {
        let code = unsafe { GetLastError() };
        if code == ERROR_SERVICE_DOES_NOT_EXIST {
            Ok(None)
        } else {
            Err(win_error("Apertura del servizio gestito"))
        }
    } else {
        Ok(Some(Handle(handle)))
    }
}
pub(super) fn services_base() -> Result<PathBuf> {
    let mut path = null_mut();
    let result = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramData, 0, null_mut(), &mut path) };
    if result < 0 {
        return Err(format!(
            "Directory ProgramData non disponibile: HRESULT {result}"
        ));
    }
    let folder = unsafe { string(path) };
    unsafe { CoTaskMemFree(path.cast()) };
    let base = PathBuf::from(folder);
    reject_link(&base)?;
    Ok(base.join("DatabaseManager").join("Services"))
}
pub(super) fn operations_base() -> Result<PathBuf> {
    Ok(services_base()?
        .parent()
        .ok_or("Directory servizio non valida.")?
        .join("ServiceOperations"))
}

fn descriptor(sddl: &str) -> Result<Local> {
    let mut security = null_mut();
    if unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            wide(sddl).as_ptr(),
            1,
            &mut security,
            null_mut(),
        )
    } == 0
    {
        return Err(win_error("Creazione ACL del servizio"));
    }
    Ok(Local(security))
}
fn sddl(service_sid: Option<&str>, data: bool) -> String {
    let extra = service_sid
        .map(|sid| {
            format!(
                "(A;OICI;{};;;{sid})",
                if data { "0x1301bf" } else { "FRFX" }
            )
        })
        .unwrap_or_default();
    format!(
        "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA){}{extra}",
        if data { "" } else { "(A;OICI;FRFX;;;BU)" }
    )
}
fn apply_acl(path: &Path, security: &Local) -> Result<()> {
    let mut owner = null_mut();
    let mut defaulted = 0;
    let mut present = 0;
    let mut dacl = null_mut();
    if unsafe { GetSecurityDescriptorOwner(security.0, &mut owner, &mut defaulted) } == 0
        || unsafe { GetSecurityDescriptorDacl(security.0, &mut present, &mut dacl, &mut defaulted) }
            == 0
        || present == 0
        || dacl.is_null()
    {
        return Err("ACL costruita non valida.".into());
    }
    let result = unsafe {
        SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            owner,
            null_mut(),
            dacl,
            null(),
        )
    };
    if result != 0 {
        return Err(format!(
            "Impostazione ACL protetta: errore Windows {result}"
        ));
    }
    Ok(())
}
fn sid_string(sid: PSID) -> Result<String> {
    let mut output = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut output) } == 0 {
        return Err(win_error("Conversione SID"));
    }
    let text = unsafe { string(output) };
    unsafe { LocalFree(output.cast()) };
    Ok(text)
}
fn validate_acl(path: &Path) -> Result<()> {
    reject_link(path)?;
    let mut owner = null_mut();
    let mut dacl: *mut ACL = null_mut();
    let mut security = null_mut();
    let code = unsafe {
        GetNamedSecurityInfoW(
            wide(path).as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut security,
        )
    };
    if code != 0 {
        return Err(format!("Lettura ACL servizio: errore Windows {code}"));
    }
    let owned = Local(security);
    let owner = sid_string(owner)?;
    if !["S-1-5-18", "S-1-5-32-544"].contains(&owner.as_str()) {
        return Err("La directory servizio non appartiene ad Administrators o SYSTEM; operazione rifiutata.".into());
    }
    let mut control = 0;
    let mut revision = 0;
    if unsafe { GetSecurityDescriptorControl(owned.0, &mut control, &mut revision) } == 0
        || control & SE_DACL_PROTECTED == 0
        || dacl.is_null()
    {
        return Err("La directory servizio non ha una DACL protetta.".into());
    }
    let count = unsafe { (*dacl).AceCount };
    if count == 0 || count > 64 {
        return Err("DACL servizio non valida.".into());
    }
    for i in 0..count {
        let mut raw = null_mut();
        if unsafe { GetAce(dacl, i as u32, &mut raw) } == 0 {
            return Err(win_error("Lettura ACE"));
        }
        let ace = unsafe { &*(raw as *const ACCESS_ALLOWED_ACE) };
        if ace.Header.AceType != 0 {
            return Err("Tipo ACE non ammesso per il runtime del servizio.".into());
        }
        let sid = sid_string((&ace.SidStart as *const u32).cast_mut().cast())?;
        if !["S-1-5-18", "S-1-5-32-544"].contains(&sid.as_str()) && ace.Mask & !0x1200a9 != 0 {
            return Err(
                "Il runtime del servizio è modificabile da un account non amministrativo.".into(),
            );
        }
    }
    Ok(())
}
fn secure_directory(path: &Path) -> Result<()> {
    let security = descriptor(&sddl(None, false))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } == 0 {
        if unsafe { GetLastError() } != ERROR_ALREADY_EXISTS {
            return Err(win_error("Creazione directory ProgramData"));
        }
        validate_acl(path)?;
    } else {
        apply_acl(path, &security)?;
    }
    Ok(())
}
fn prepare_parent() -> Result<PathBuf> {
    let base = services_base()?;
    let parent = base.parent().ok_or("Directory ProgramData non valida.")?;
    secure_directory(parent)?;
    secure_directory(&base)?;
    Ok(base)
}
pub(super) fn prepare_root(root: &Path) -> Result<()> {
    let base = prepare_parent()?;
    if root.parent() != Some(base.as_path())
        || !root
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with(PREFIX) && valid_id(&name[PREFIX.len()..]).is_ok())
            .unwrap_or(false)
    {
        return Err("Percorso servizio esterno a ProgramData gestito.".into());
    }
    if root.exists() {
        return Err("Directory servizio già esistente; non viene modificata.".into());
    }
    secure_directory(root)
}
pub(super) fn prepare_private_data(path: &Path) -> Result<()> {
    let security = descriptor(&sddl(None, true))?;
    let attributes = SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: security.0,
        bInheritHandle: 0,
    };
    if unsafe { CreateDirectoryW(wide(path).as_ptr(), &attributes) } == 0 {
        return Err(win_error("Creazione directory dati privata"));
    }
    apply_acl(path, &security)
}
pub(super) fn prepare_operations() -> Result<PathBuf> {
    prepare_parent()?;
    let root = operations_base()?;
    secure_directory(&root)?;
    Ok(root)
}
pub(super) fn validate_service_root(root: &Path) -> Result<()> {
    let base = services_base()?;
    if root.parent() != Some(base.as_path()) {
        return Err("Manifest servizio esterno a ProgramData.".into());
    }
    validate_acl(base.parent().unwrap())?;
    validate_acl(&base)?;
    validate_acl(root)?;
    validate_acl(&root.join("runtime"))?;
    Ok(())
}
pub(super) fn secure_tree(root: &Path, sid: &str, data: bool) -> Result<()> {
    let security = descriptor(&sddl(Some(sid), data))?;
    fn walk(path: &Path, security: &Local, skip: Option<&Path>) -> Result<()> {
        if skip == Some(path) {
            return Ok(());
        }
        reject_link(path)?;
        apply_acl(path, security)?;
        if path.is_dir() {
            for entry in fs::read_dir(path).map_err(fail)? {
                walk(&entry.map_err(fail)?.path(), security, skip)?;
            }
        }
        Ok(())
    }
    let skip = if data { None } else { Some(root.join("data")) };
    walk(root, &security, skip.as_deref())
}
pub(super) fn service_sid(account: &str) -> Result<String> {
    let name = wide(account);
    let mut length = 0;
    let mut domain_length = 0;
    let mut usage = 0;
    unsafe {
        LookupAccountNameW(
            null(),
            name.as_ptr(),
            null_mut(),
            &mut length,
            null_mut(),
            &mut domain_length,
            &mut usage,
        )
    };
    if length == 0 {
        return Err(win_error("Risoluzione account virtuale del servizio"));
    }
    let mut sid = vec![0u8; length as usize];
    let mut domain = vec![0u16; domain_length as usize];
    if unsafe {
        LookupAccountNameW(
            null(),
            name.as_ptr(),
            sid.as_mut_ptr().cast(),
            &mut length,
            domain.as_mut_ptr(),
            &mut domain_length,
            &mut usage,
        )
    } == 0
    {
        return Err(win_error("Risoluzione SID del servizio"));
    }
    sid_string(sid.as_mut_ptr().cast())
}
pub(super) fn open_locked(path: &Path, directory: bool) -> Result<File> {
    reject_link(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true).share_mode(FILE_SHARE_READ).custom_flags(
        FILE_FLAG_OPEN_REPARSE_POINT
            | if directory {
                FILE_FLAG_BACKUP_SEMANTICS
            } else {
                0
            },
    );
    let file = options
        .open(path)
        .map_err(|e| format!("Bloccare {} per una copia coerente: {e}", path.display()))?;
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(win_error("Verifica handle sorgente"));
    }
    if info.dwFileAttributes & 0x400 != 0 {
        return Err("Reparse point rilevato sull’handle sorgente.".into());
    }
    Ok(file)
}
pub(super) fn reject_hardlink(file: &File) -> Result<()> {
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(win_error("Verifica collegamenti file"));
    }
    if info.nNumberOfLinks != 1 {
        return Err("Hard link non ammesso nei dati copiati da un helper elevato.".into());
    }
    Ok(())
}
pub(super) fn require_elevated() -> Result<()> {
    if unsafe { IsUserAnAdmin() } == 0 {
        Err("L’helper servizi richiede un consenso UAC esplicito.".into())
    } else {
        Ok(())
    }
}
pub(super) fn elevate(executable: &Path, args: &[String]) -> Result<()> {
    let display = executable.to_string_lossy();
    let display = display.strip_prefix("\\\\?\\").unwrap_or(&display);
    if display.starts_with("\\\\") {
        return Err(
            "L’helper elevato deve essere un eseguibile locale, non un percorso di rete.".into(),
        );
    }
    let app = wide(display);
    let verb = wide("runas");
    let parameters = wide(
        args.iter()
            .map(|arg| quote_arg(arg))
            .collect::<Vec<_>>()
            .join(" "),
    );
    let com = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
    let mut info: SHELLEXECUTEINFOW = unsafe { zeroed() };
    info.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = verb.as_ptr();
    info.lpFile = app.as_ptr();
    info.lpParameters = parameters.as_ptr();
    info.nShow = 0;
    let launched = unsafe { ShellExecuteExW(&mut info) };
    let result = if launched == 0 {
        Err(win_error("Elevazione annullata o non riuscita"))
    } else if info.hProcess.is_null() {
        Err("Windows non ha restituito l’handle dell’helper.".into())
    } else {
        let wait = unsafe { WaitForSingleObject(info.hProcess, 600_000) };
        let mut exit = 0;
        let ok = unsafe { GetExitCodeProcess(info.hProcess, &mut exit) };
        unsafe { CloseHandle(info.hProcess) };
        if wait == 0 && ok != 0 && (exit == 0 || exit == 1) {
            Ok(())
        } else {
            Err(format!("Helper non concluso regolarmente (stato {wait}, codice {exit}); verificare lo stato prima di ripetere."))
        }
    };
    if com >= 0 {
        unsafe { CoUninitialize() }
    }
    result
}

fn state_text(state: u32) -> String {
    match state {
        SERVICE_RUNNING => "running",
        SERVICE_STOPPED => "stopped",
        SERVICE_START_PENDING => "starting",
        SERVICE_STOP_PENDING => "stopping",
        _ => "unknown",
    }
    .into()
}
fn snapshot(handle: &Handle) -> Result<Snapshot> {
    let mut needed = 0;
    unsafe { QueryServiceConfigW(handle.0, null_mut(), 0, &mut needed) };
    if needed == 0 || needed > 64 * 1024 {
        return Err(win_error("Dimensione configurazione SCM"));
    }
    let mut buffer = vec![0u8; needed as usize];
    if unsafe { QueryServiceConfigW(handle.0, buffer.as_mut_ptr().cast(), needed, &mut needed) }
        == 0
    {
        return Err(win_error("Lettura configurazione SCM"));
    }
    let config = unsafe { &*(buffer.as_ptr() as *const QUERY_SERVICE_CONFIGW) };
    let mut status: SERVICE_STATUS = unsafe { zeroed() };
    if unsafe { QueryServiceStatus(handle.0, &mut status) } == 0 {
        return Err(win_error("Lettura stato servizio"));
    }
    let mut description_size = 0;
    unsafe {
        QueryServiceConfig2W(
            handle.0,
            SERVICE_CONFIG_DESCRIPTION,
            null_mut(),
            0,
            &mut description_size,
        )
    };
    let mut description = String::new();
    if description_size > 0 && description_size < 64 * 1024 {
        let mut bytes = vec![0u8; description_size as usize];
        if unsafe {
            QueryServiceConfig2W(
                handle.0,
                SERVICE_CONFIG_DESCRIPTION,
                bytes.as_mut_ptr(),
                description_size,
                &mut description_size,
            )
        } != 0
        {
            description =
                unsafe { string((*(bytes.as_ptr() as *const SERVICE_DESCRIPTIONW)).lpDescription) }
        }
    }
    Ok(Snapshot {
        image_path: unsafe { string(config.lpBinaryPathName) },
        account: unsafe { string(config.lpServiceStartName) },
        description,
        state: state_text(status.dwCurrentState),
        service_type: config.dwServiceType,
    })
}
pub(super) fn query(name: &str) -> Result<Option<Snapshot>> {
    if !name.starts_with(PREFIX) {
        return Err("Nome servizio non gestito.".into());
    }
    valid_id(&name[PREFIX.len()..])?;
    let manager = scm(SC_MANAGER_CONNECT)?;
    service(&manager, name, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS)?
        .map(|handle| snapshot(&handle))
        .transpose()
}
pub(super) struct NativeScm;
impl Scm for NativeScm {
    fn query(&mut self, name: &str) -> Result<Option<Snapshot>> {
        query(name)
    }
    fn install(&mut self, manifest: &Manifest) -> Result<()> {
        require_elevated()?;
        let manager = scm(SC_MANAGER_CONNECT | SC_MANAGER_CREATE_SERVICE)?;
        if service(&manager, &manifest.service_name, SERVICE_QUERY_CONFIG)?.is_some() {
            return Err("Il servizio esiste già e non viene sostituito.".into());
        }
        let name = wide(&manifest.service_name);
        let display = wide(format!("Database Manager · {}", manifest.service_name));
        let image = wide(&manifest.image_path);
        let account = wide(&manifest.account);
        let raw = unsafe {
            CreateServiceW(
                manager.0,
                name.as_ptr(),
                display.as_ptr(),
                SERVICE_ALL_ACCESS,
                SERVICE_WIN32_OWN_PROCESS,
                SERVICE_DEMAND_START,
                SERVICE_ERROR_NORMAL,
                image.as_ptr(),
                null(),
                null_mut(),
                null(),
                account.as_ptr(),
                null(),
            )
        };
        if raw.is_null() {
            return Err(win_error("Creazione servizio con account virtuale"));
        }
        let handle = Handle(raw);
        let description = wide(marker(manifest));
        let value = SERVICE_DESCRIPTIONW {
            lpDescription: description.as_ptr().cast_mut(),
        };
        if unsafe {
            ChangeServiceConfig2W(
                handle.0,
                SERVICE_CONFIG_DESCRIPTION,
                (&value as *const SERVICE_DESCRIPTIONW).cast(),
            )
        } == 0
        {
            return Err(win_error("Impostazione marker SCM"));
        }
        let sid = SERVICE_SID_INFO {
            dwServiceSidType: SERVICE_SID_TYPE_UNRESTRICTED,
        };
        if unsafe {
            ChangeServiceConfig2W(
                handle.0,
                SERVICE_CONFIG_SERVICE_SID_INFO,
                (&sid as *const SERVICE_SID_INFO).cast(),
            )
        } == 0
        {
            return Err(win_error("Impostazione SID del servizio"));
        }
        Ok(())
    }
    fn start(&mut self, name: &str) -> Result<()> {
        require_elevated()?;
        let manager = scm(SC_MANAGER_CONNECT)?;
        let handle = service(&manager, name, SERVICE_START | SERVICE_QUERY_STATUS)?
            .ok_or("Servizio non installato.")?;
        if unsafe { StartServiceW(handle.0, 0, null()) } == 0
            && unsafe { GetLastError() } != ERROR_SERVICE_ALREADY_RUNNING
        {
            return Err(win_error("Avvio servizio"));
        }
        wait_state(&handle, SERVICE_RUNNING)
    }
    fn stop(&mut self, name: &str) -> Result<()> {
        require_elevated()?;
        let manager = scm(SC_MANAGER_CONNECT)?;
        let handle = service(&manager, name, SERVICE_STOP | SERVICE_QUERY_STATUS)?
            .ok_or("Servizio non installato.")?;
        let mut status: SERVICE_STATUS = unsafe { zeroed() };
        if unsafe { ControlService(handle.0, SERVICE_CONTROL_STOP, &mut status) } == 0
            && unsafe { GetLastError() } != ERROR_SERVICE_NOT_ACTIVE
        {
            return Err(win_error("Arresto servizio"));
        }
        wait_state(&handle, SERVICE_STOPPED)
    }
    fn remove(&mut self, name: &str) -> Result<()> {
        require_elevated()?;
        let manager = scm(SC_MANAGER_CONNECT)?;
        let handle = service(&manager, name, 0x00010000 | SERVICE_QUERY_STATUS)?
            .ok_or("Servizio non installato.")?;
        let mut status: SERVICE_STATUS = unsafe { zeroed() };
        if unsafe { QueryServiceStatus(handle.0, &mut status) } == 0
            || status.dwCurrentState != SERVICE_STOPPED
        {
            return Err("Arrestare il servizio prima di rimuoverlo.".into());
        }
        if unsafe { DeleteService(handle.0) } == 0 {
            return Err(win_error("Rimozione registrazione SCM"));
        }
        Ok(())
    }
}
fn wait_state(handle: &Handle, target: u32) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let mut status: SERVICE_STATUS = unsafe { zeroed() };
        if unsafe { QueryServiceStatus(handle.0, &mut status) } == 0 {
            return Err(win_error("Verifica transizione servizio"));
        }
        if status.dwCurrentState == target {
            return Ok(());
        }
        if status.dwCurrentState == SERVICE_STOPPED && target == SERVICE_RUNNING {
            return Err(format!("Il servizio si è arrestato durante l’avvio (Win32 {}, specifico {}). Consultare i log in ProgramData.",status.dwWin32ExitCode,status.dwServiceSpecificExitCode));
        }
        if Instant::now() > deadline {
            return Err(
                "Transizione servizio oltre 90 secondi; l’esito va verificato prima di ripetere."
                    .into(),
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}
