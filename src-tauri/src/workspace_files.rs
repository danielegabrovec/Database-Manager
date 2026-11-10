//! Explicit, bounded local file access. Opening a file never runs its SQL/source.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant, UNIX_EPOCH},
};

pub const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;
pub const DIRECTORY_PAGE_SIZE: usize = 200;
pub const MAX_OPEN_REQUESTS: usize = 32;
pub const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\0";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-8-bom")]
    Utf8Bom,
    #[serde(rename = "utf-16le")]
    Utf16Le,
    #[serde(rename = "utf-16le-bom")]
    Utf16LeBom,
    #[serde(rename = "utf-16be")]
    Utf16Be,
    #[serde(rename = "utf-16be-bom")]
    Utf16BeBom,
    #[serde(rename = "windows-1252")]
    Windows1252,
}
impl TextEncoding {
    pub fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf8Bom => "utf-8-bom",
            Self::Utf16Le => "utf-16le",
            Self::Utf16LeBom => "utf-16le-bom",
            Self::Utf16Be => "utf-16be",
            Self::Utf16BeBom => "utf-16be-bom",
            Self::Windows1252 => "windows-1252",
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Sqlite,
    Sql,
    Source,
    Text,
    Binary,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SqliteObject {
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SqliteSummary {
    pub valid: bool,
    pub table_count: u64,
    pub view_count: u64,
    pub tables: Vec<SqliteObject>,
    pub user_version: i64,
    pub schema_truncated: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    pub extension: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub fingerprint: String,
    pub encoding: Option<TextEncoding>,
    pub content: Option<String>,
    pub requires_encoding: bool,
    pub read_only: bool,
    pub syntax_language: String,
    pub sqlite: Option<SqliteSummary>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectFileRequest {
    pub path: String,
    pub encoding: Option<TextEncoding>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextRequest {
    pub path: String,
    pub content: String,
    pub encoding: TextEncoding,
    #[serde(default)]
    pub expected_fingerprint: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub kind: FileKind,
    pub encoding: Option<TextEncoding>,
    pub opened_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub extension: String,
    pub size_bytes: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPage {
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
    pub next_offset: Option<usize>,
    pub truncated: bool,
    pub unreadable_entries: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileManagerAction {
    OpenDirectory,
    RevealFile,
}

/// `opened` means the operating system accepted the launch request, not that a
/// particular Explorer window was observed or that a document was executed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManagerResult {
    pub opened: bool,
    pub path: String,
    pub action: FileManagerAction,
}

#[derive(Debug)]
struct FileManagerPlan {
    path: PathBuf,
    action: FileManagerAction,
}

pub fn path_string(path: &Path) -> Result<String> {
    let text = path
        .to_str()
        .ok_or("Il percorso non è rappresentabile come testo Unicode.")?;
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Ok(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Ok(rest.to_owned());
        }
    }
    Ok(text.to_owned())
}
fn reject_device_path(path: &str) -> Result<()> {
    if path.trim().is_empty()
        || path.contains('\0')
        || path.starts_with(r"\\.\")
        || path.to_ascii_uppercase().starts_with(r"\\?\GLOBALROOT")
        || path.to_ascii_uppercase().starts_with(r"\\?\PIPE\")
    {
        return Err("Selezionare un normale percorso di file locale o di rete.".into());
    }
    Ok(())
}
pub fn canonical_existing_file(path: &str) -> Result<PathBuf> {
    reject_device_path(path)?;
    let path = PathBuf::from(path).canonicalize().map_err(|_| {
        "File non trovato o non accessibile; non è stato creato alcun file.".to_string()
    })?;
    if !fs::metadata(&path).map_err(error)?.is_file() {
        return Err("Il percorso selezionato non è un file.".into());
    }
    Ok(path)
}

pub fn canonical_existing_directory(path: &str) -> Result<PathBuf> {
    reject_device_path(path)?;
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Cartella non trovata o non accessibile.".to_string())?;
    if !fs::metadata(&path).map_err(error)?.is_dir() {
        return Err("Il percorso selezionato non è una cartella.".into());
    }
    Ok(path)
}

fn file_manager_plan(path: &str, action: FileManagerAction) -> Result<FileManagerPlan> {
    let path = match action {
        FileManagerAction::OpenDirectory => canonical_existing_directory(path)?,
        FileManagerAction::RevealFile => canonical_existing_file(path)?,
    };
    // Convert extended Windows paths for the shell and reject any lossy Unicode
    // conversion. Paths are data; SQL/source file contents are never inspected.
    let path = PathBuf::from(path_string(&path)?);
    Ok(FileManagerPlan { path, action })
}

pub fn open_directory(path: &str) -> Result<FileManagerResult> {
    launch_file_manager(file_manager_plan(path, FileManagerAction::OpenDirectory)?)
}

pub fn reveal_file(path: &str) -> Result<FileManagerResult> {
    launch_file_manager(file_manager_plan(path, FileManagerAction::RevealFile)?)
}

fn launch_file_manager(plan: FileManagerPlan) -> Result<FileManagerResult> {
    #[cfg(feature = "desktop")]
    match plan.action {
        FileManagerAction::OpenDirectory => {
            tauri_plugin_opener::open_path(&plan.path, None::<&str>).map_err(error)?;
        }
        FileManagerAction::RevealFile => {
            tauri_plugin_opener::reveal_item_in_dir(&plan.path).map_err(error)?;
        }
    }
    #[cfg(all(windows, not(feature = "desktop")))]
    {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new(windows_explorer_path()?);
        // Explorer treats commas as its own option delimiters. Always quoting
        // this one validated path preserves commas even when it has no spaces.
        // raw_arg is a Windows argument, never a cmd.exe/PowerShell command.
        if plan.action == FileManagerAction::RevealFile {
            command.arg("/select,");
        }
        command
            .raw_arg(quoted_explorer_path(&plan.path)?)
            .creation_flags(0x08000000) // CREATE_NO_WINDOW; Explorer itself stays visible.
            .spawn()
            .map_err(|e| format!("Impossibile avviare Esplora risorse: {e}"))?;
    }
    #[cfg(all(not(windows), not(feature = "desktop")))]
    {
        return Err(
            "Il gestore file di sistema richiede l'app desktop su questa piattaforma.".into(),
        );
    }
    #[cfg(any(windows, feature = "desktop"))]
    Ok(FileManagerResult {
        opened: true,
        path: path_string(&plan.path)?,
        action: plan.action,
    })
}

#[cfg(any(all(windows, not(feature = "desktop")), test))]
fn quoted_explorer_path(path: &Path) -> Result<String> {
    let path = path_string(path)?;
    if path.contains(['"', '\r', '\n', '\0']) {
        return Err("Il percorso contiene caratteri non supportati da Esplora risorse.".into());
    }
    // A root directory ends in a backslash. Duplicate trailing backslashes
    // before the closing quote according to Windows command-line escaping.
    let trailing = path.chars().rev().take_while(|c| *c == '\\').count();
    Ok(format!("\"{path}{}\"", "\\".repeat(trailing)))
}

#[cfg(all(windows, not(feature = "desktop")))]
fn windows_explorer_path() -> Result<PathBuf> {
    // Ask Windows rather than relying on PATH or an overridable SystemRoot.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetWindowsDirectoryW(buffer: *mut u16, size: u32) -> u32;
    }
    let mut buffer = vec![0u16; 32_768];
    let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
    if length == 0 || length as usize >= buffer.len() {
        return Err("Cartella di Windows non disponibile.".into());
    }
    use std::os::windows::ffi::OsStringExt;
    let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..length as usize]))
        .join("explorer.exe");
    if !path.is_absolute() || !path.is_file() {
        return Err("Esplora risorse non è disponibile nella cartella di Windows.".into());
    }
    Ok(path)
}
fn modified_nanos(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}
fn fingerprint(path: &Path, bytes: &[u8], metadata: &fs::Metadata) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(path_string(path)?.as_bytes());
    hash.update([0]);
    hash.update(metadata.len().to_le_bytes());
    hash.update(modified_nanos(metadata).to_le_bytes());
    hash.update(bytes);
    Ok(format!("sha256:{:x}", hash.finalize()))
}
fn read_bounded(path: &Path) -> Result<(Vec<u8>, fs::Metadata)> {
    let mut file = File::open(path).map_err(error)?;
    let before = file.metadata().map_err(error)?;
    if before.len() > MAX_TEXT_BYTES {
        return Err("File di testo oltre 8 MiB: aprire una porzione o usare l’importazione da file, senza caricarlo interamente nell’editor.".into());
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    let after = file.metadata().map_err(error)?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err("Il file supera il limite di 8 MiB.".into());
    }
    if before.len() != after.len()
        || modified_nanos(&before) != modified_nanos(&after)
        || after.len() != bytes.len() as u64
    {
        return Err("Il file è cambiato durante la lettura; riaprirlo.".into());
    }
    Ok((bytes, after))
}
pub fn validate_sqlite_header(path: &Path) -> Result<()> {
    let mut file =
        File::open(path).map_err(|_| "File SQLite non trovato o non accessibile.".to_string())?;
    if !file.metadata().map_err(error)?.is_file() {
        return Err("Il percorso SQLite non è un file.".into());
    }
    let mut header = [0_u8; 16];
    if file.read_exact(&mut header).is_err() || &header != SQLITE_HEADER {
        return Err("Il file non contiene l’intestazione SQLite. Un file .sql è uno script testuale, non un database; nessun file vuoto viene creato o inizializzato automaticamente.".into());
    }
    Ok(())
}
pub fn inspect_sqlite(path: &Path) -> Result<SqliteSummary> {
    validate_sqlite_header(path)?;
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(error)?;
    connection
        .busy_timeout(Duration::from_millis(500))
        .map_err(error)?;
    connection
        .execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")
        .map_err(error)?;
    let start = Instant::now();
    connection.progress_handler(1000, Some(move || start.elapsed() > Duration::from_secs(2)));
    let table_count = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(error)?;
    let view_count = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type='view' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get::<_, u64>(0),
        )
        .map_err(error)?;
    let mut statement=connection.prepare("SELECT name,type FROM sqlite_schema WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 200").map_err(error)?;
    let tables = statement
        .query_map([], |row| {
            Ok(SqliteObject {
                name: row.get(0)?,
                kind: row.get(1)?,
            })
        })
        .map_err(error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(error)?;
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(error)?;
    Ok(SqliteSummary {
        valid: true,
        table_count,
        view_count,
        schema_truncated: table_count + view_count > tables.len() as u64,
        tables,
        user_version,
    })
}
pub fn inspect_file(request: InspectFileRequest) -> Result<WorkspaceFile> {
    let path = canonical_existing_file(&request.path)?;
    let metadata = fs::metadata(&path).map_err(error)?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("Nome file non Unicode.")?
        .to_owned();
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut prefix = [0_u8; 64];
    let read = File::open(&path)
        .map_err(error)?
        .read(&mut prefix)
        .map_err(error)?;
    let mut result = WorkspaceFile {
        path: path_string(&path)?,
        name,
        kind: text_kind(&extension),
        extension: extension.clone(),
        size_bytes: metadata.len(),
        modified_at: metadata
            .modified()
            .ok()
            .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()),
        fingerprint: fingerprint(&path, &prefix[..read], &metadata)?,
        encoding: None,
        content: None,
        requires_encoding: false,
        read_only: metadata.permissions().readonly(),
        syntax_language: syntax_language(&extension).into(),
        sqlite: None,
        warnings: Vec::new(),
    };
    if prefix[..read].starts_with(SQLITE_HEADER) {
        result.kind = FileKind::Sqlite;
        result.read_only = true;
        result.syntax_language = "sql".into();
        match inspect_sqlite(&path) {
            Ok(summary) => result.sqlite = Some(summary),
            Err(e) => {
                result.sqlite = Some(SqliteSummary::default());
                result.warnings.push(format!(
                    "Intestazione SQLite presente, ma catalogo non leggibile: {e}"
                ));
            }
        }
        return Ok(result);
    }
    if database_extension(&extension) {
        result.kind = FileKind::Binary;
        result.read_only = true;
        result.warnings.push("L’estensione suggerisce un database ma l’intestazione SQLite è assente. Il file non viene aperto come SQLite.".into());
        return Ok(result);
    }
    if known_binary(&prefix[..read]) {
        result.kind = FileKind::Binary;
        result.read_only = true;
        result
            .warnings
            .push("File binario: viene mostrata soltanto l’informazione sul file.".into());
        return Ok(result);
    }
    if metadata.len() > MAX_TEXT_BYTES {
        result.read_only = true;
        result
            .warnings
            .push("File oltre 8 MiB: anteprima testuale non caricata.".into());
        return Ok(result);
    }
    let (bytes, metadata) = read_bounded(&path)?;
    result.fingerprint = fingerprint(&path, &bytes, &metadata)?;
    result.size_bytes = metadata.len();
    result.modified_at = metadata
        .modified()
        .ok()
        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
    let encoding = request.encoding.or_else(|| detect_encoding(&bytes));
    match encoding {
        Some(encoding) => {
            let content = decode_text(&bytes, encoding)?;
            if content.contains('\0') {
                result.kind = FileKind::Binary;
                result.read_only = true;
                result.warnings.push("Il contenuto decodificato contiene byte NUL e non viene trattato come un documento di testo.".into());
            } else {
                result.encoding = Some(encoding);
                result.content = Some(content);
            }
        }
        None => {
            result.requires_encoding = true;
            result.read_only = true;
            result.warnings.push("Codifica non determinata senza perdita: scegliere esplicitamente Windows-1252 oppure UTF-16, senza sostituzione di caratteri.".into());
        }
    }
    Ok(result)
}
fn database_extension(extension: &str) -> bool {
    matches!(extension, "db" | "sqlite" | "sqlite3" | "db3")
}
fn known_binary(bytes: &[u8]) -> bool {
    if bytes.starts_with(b"MZ") && bytes.get(2..16).is_some_and(|header| header.contains(&0)) {
        return true;
    }
    [
        b"\x7fELF".as_slice(),
        b"PK\x03\x04".as_slice(),
        b"\x89PNG\r\n\x1a\n".as_slice(),
        b"\xff\xd8\xff".as_slice(),
        b"\x1f\x8b".as_slice(),
        b"%PDF-".as_slice(),
    ]
    .iter()
    .any(|magic| bytes.starts_with(magic))
}
fn text_kind(extension: &str) -> FileKind {
    if extension == "sql" {
        FileKind::Sql
    } else if syntax_language(extension) != "plaintext" {
        FileKind::Source
    } else {
        FileKind::Text
    }
}
fn syntax_language(extension: &str) -> &'static str {
    match extension {
        "sql" => "sql",
        "rs" => "rust",
        "js" | "mjs" | "cjs" | "jsx" => "javascript",
        "ts" | "tsx" => "typescript",
        "py" => "python",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "cs" => "csharp",
        "php" => "php",
        "go" => "go",
        "c" | "h" => "c",
        "cpp" | "cxx" | "cc" | "hpp" | "hxx" => "cpp",
        "rb" => "ruby",
        "json" | "jsonc" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "html" | "htm" => "html",
        "css" => "css",
        "xml" => "xml",
        "md" | "markdown" => "markdown",
        "sh" | "bash" => "shell",
        "ps1" => "powershell",
        _ => "plaintext",
    }
}
fn detect_encoding(bytes: &[u8]) -> Option<TextEncoding> {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some(TextEncoding::Utf8Bom)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        Some(TextEncoding::Utf16LeBom)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        Some(TextEncoding::Utf16BeBom)
    } else if !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok() {
        Some(TextEncoding::Utf8)
    } else {
        None
    }
}
pub fn decode_text(bytes: &[u8], encoding: TextEncoding) -> Result<String> {
    match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
            String::from_utf8(bytes.to_vec()).map_err(|_| {
                "Il file non è UTF-8 valido; scegliere un’altra codifica esplicita.".into()
            })
        }
        TextEncoding::Utf16Le
        | TextEncoding::Utf16LeBom
        | TextEncoding::Utf16Be
        | TextEncoding::Utf16BeBom => {
            let le = matches!(encoding, TextEncoding::Utf16Le | TextEncoding::Utf16LeBom);
            let bom = if le { [0xff, 0xfe] } else { [0xfe, 0xff] };
            let bytes = bytes.strip_prefix(&bom).unwrap_or(bytes);
            if bytes.len() % 2 != 0 {
                return Err("UTF-16 non valido: numero dispari di byte.".into());
            }
            let units = bytes
                .chunks_exact(2)
                .map(|b| {
                    if le {
                        u16::from_le_bytes([b[0], b[1]])
                    } else {
                        u16::from_be_bytes([b[0], b[1]])
                    }
                })
                .collect::<Vec<_>>();
            String::from_utf16(&units).map_err(|_| {
                "UTF-16 contiene surrogate non valide; nessuna sostituzione viene applicata.".into()
            })
        }
        TextEncoding::Windows1252 => Ok(bytes.iter().map(|b| cp1252_char(*b)).collect()),
    }
}
pub fn encode_text(content: &str, encoding: TextEncoding) -> Result<Vec<u8>> {
    if content.contains('\0') {
        return Err("Un documento di testo non può contenere byte NUL.".into());
    }
    if content.len() > MAX_TEXT_BYTES as usize * 3 {
        return Err("Contenuto testuale oltre il limite di 8 MiB del file codificato.".into());
    }
    let mut bytes = Vec::new();
    match encoding {
        TextEncoding::Utf8 | TextEncoding::Utf8Bom => {
            if encoding == TextEncoding::Utf8Bom {
                bytes.extend([0xef, 0xbb, 0xbf]);
            }
            bytes.extend(content.as_bytes());
        }
        TextEncoding::Utf16Le
        | TextEncoding::Utf16LeBom
        | TextEncoding::Utf16Be
        | TextEncoding::Utf16BeBom => {
            let le = matches!(encoding, TextEncoding::Utf16Le | TextEncoding::Utf16LeBom);
            if matches!(
                encoding,
                TextEncoding::Utf16LeBom | TextEncoding::Utf16BeBom
            ) {
                bytes.extend(if le { [0xff, 0xfe] } else { [0xfe, 0xff] });
            }
            for value in content.encode_utf16() {
                bytes.extend(if le {
                    value.to_le_bytes()
                } else {
                    value.to_be_bytes()
                });
            }
        }
        TextEncoding::Windows1252 => {
            for character in content.chars() {
                let code = character as u32;
                let byte = if code <= 0x7f || (0xa0..=0xff).contains(&code) {
                    Some(code as u8)
                } else {
                    (0x80_u16..=0x9f)
                        .find(|byte| cp1252_char(*byte as u8) == character)
                        .map(|byte| byte as u8)
                };
                bytes.push(byte.ok_or_else(||format!("Il carattere U+{:04X} non è rappresentabile in Windows-1252. Scegliere UTF-8/UTF-16; il file originale non è stato modificato.",character as u32))?);
            }
        }
    }
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Err("Il file codificato supera 8 MiB; nessun salvataggio eseguito.".into());
    }
    Ok(bytes)
}
fn cp1252_char(byte: u8) -> char {
    const SPECIAL: [u32; 32] = [
        0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039,
        0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
        0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
    ];
    char::from_u32(if (0x80..=0x9f).contains(&byte) {
        SPECIAL[(byte - 0x80) as usize]
    } else {
        byte as u32
    })
    .unwrap()
}

pub fn save_text(request: SaveTextRequest) -> Result<WorkspaceFile> {
    reject_device_path(&request.path)?;
    let bytes = encode_text(&request.content, request.encoding)?;
    let requested = PathBuf::from(&request.path);
    if database_extension(
        requested
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
    ) {
        return Err("Per creare o modificare un database SQLite usare il gestore database; salvare le istruzioni come file .sql.".into());
    }
    if let Some(expected) = request.expected_fingerprint {
        if expected.is_empty() {
            return Err(
                "Fingerprint del file mancante: riaprire il documento prima di salvare.".into(),
            );
        }
        let path = canonical_existing_file(&request.path)?;
        let (original, metadata) = read_bounded(&path)?;
        if original.starts_with(SQLITE_HEADER) || known_binary(&original) {
            return Err(
                "Un file binario o database non viene sovrascritto dall’editor di testo.".into(),
            );
        }
        if metadata.permissions().readonly() {
            return Err("Il file è in sola lettura.".into());
        }
        if fingerprint(&path, &original, &metadata)? != expected {
            return Err("CONFLITTO_FILE: il file è stato modificato all’esterno. Riaprirlo e confrontare il contenuto; nessun dato è stato sovrascritto.".into());
        }
        let parent = path.parent().ok_or("Cartella del file non disponibile.")?;
        let temporary = parent.join(format!(".dbmanager-{}.tmp", uuid::Uuid::new_v4()));
        let outcome = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(error)?;
            file.write_all(&bytes).map_err(error)?;
            file.sync_all().map_err(error)?;
            drop(file);
            let (current, latest) = read_bounded(&path)?;
            if fingerprint(&path, &current, &latest)? != expected {
                return Err("CONFLITTO_FILE: modifica esterna durante il salvataggio; il file originale è conservato.".into());
            }
            atomic_replace(&temporary, &path, &metadata)
        })();
        if temporary.exists() {
            let _ = fs::remove_file(&temporary);
        }
        outcome?;
        inspect_file(InspectFileRequest {
            path: path_string(&path)?,
            encoding: Some(request.encoding),
        })
    } else {
        let parent = requested
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let parent = parent
            .canonicalize()
            .map_err(|_| "La cartella di destinazione deve esistere.".to_string())?;
        let name = requested
            .file_name()
            .ok_or("Nome file di destinazione mancante.")?;
        let path = parent.join(name);
        let mut file=OpenOptions::new().write(true).create_new(true).open(&path).map_err(|e|if e.kind()==std::io::ErrorKind::AlreadyExists{"Il file di destinazione esiste già. Aprirlo prima di modificarlo oppure scegliere un nuovo nome; Salva con nome non sovrascrive file non aperti.".into()}else{error(e)})?;
        let outcome = file.write_all(&bytes).and_then(|_| file.sync_all());
        drop(file);
        if let Err(e) = outcome {
            let _ = fs::remove_file(&path);
            return Err(error(e));
        }
        inspect_file(InspectFileRequest {
            path: path_string(&path)?,
            encoding: Some(request.encoding),
        })
    }
}
#[cfg(windows)]
fn atomic_replace(source: &Path, target: &Path, _metadata: &fs::Metadata) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let backup = target
        .parent()
        .ok_or("Cartella di salvataggio non disponibile.")?
        .join(format!(".dbmanager-recovery-{}.tmp", uuid::Uuid::new_v4()));
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let target = target
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let backup_wide = backup
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    // ReplaceFile preserves the replaced file's ACL and creation attributes.
    let success = unsafe {
        windows_sys::Win32::Storage::FileSystem::ReplaceFileW(
            target.as_ptr(),
            source.as_ptr(),
            backup_wide.as_ptr(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if success == 0 {
        return Err(format!("Salvataggio atomico non riuscito: {}. Nessun fallback distruttivo. Se presente, il file di recupero {} conserva la versione originale.",std::io::Error::last_os_error(),path_string(&backup)?));
    }
    if backup.exists() {
        fs::remove_file(&backup).map_err(|e| {
            format!(
                "File salvato, ma copia di recupero non eliminabile ({}): {e}",
                backup.display()
            )
        })?;
    }
    Ok(())
}
#[cfg(not(windows))]
fn atomic_replace(source: &Path, target: &Path, metadata: &fs::Metadata) -> Result<()> {
    fs::set_permissions(source, metadata.permissions()).map_err(error)?;
    fs::rename(source, target).map_err(error)
}

pub fn list_directory(path: &str, offset: usize) -> Result<DirectoryPage> {
    reject_device_path(path)?;
    if offset > 100_000 {
        return Err(
            "Paginazione oltre 100.000 voci: scegliere una sottocartella più specifica.".into(),
        );
    }
    let path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "Cartella non trovata o non accessibile.".to_string())?;
    if !path.is_dir() {
        return Err("Il percorso selezionato non è una cartella.".into());
    }
    let mut iterator = fs::read_dir(&path).map_err(error)?.skip(offset);
    let mut entries = Vec::new();
    let mut scanned = 0;
    let mut unreadable = 0;
    while entries.len() < DIRECTORY_PAGE_SIZE && scanned < DIRECTORY_PAGE_SIZE * 2 {
        let Some(entry) = iterator.next() else { break };
        scanned += 1;
        let entry = match entry {
            Ok(v) => v,
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            unreadable += 1;
            continue;
        };
        let metadata = match entry.metadata() {
            Ok(v) => v,
            Err(_) => {
                unreadable += 1;
                continue;
            }
        };
        let entry_path = entry.path();
        entries.push(DirectoryEntry {
            path: path_string(&entry_path)?,
            name,
            kind: if metadata.is_dir() {
                "directory"
            } else {
                "file"
            }
            .into(),
            extension: entry_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase(),
            size_bytes: if metadata.is_file() {
                metadata.len()
            } else {
                0
            },
        });
    }
    let more = iterator.next().is_some();
    Ok(DirectoryPage {
        path: path_string(&path)?,
        entries,
        next_offset: more.then_some(offset + scanned),
        truncated: more,
        unreadable_entries: unreadable,
    })
}
/// Parse only explicitly supplied existing paths; never parse source file text.
pub fn paths_from_arguments(arguments: &[String], cwd: &Path) -> Vec<String> {
    let mut result = Vec::new();
    let mut after_separator = false;
    for argument in arguments.iter().skip(1) {
        if argument == "--" {
            after_separator = true;
            continue;
        }
        if !after_separator && argument.starts_with('-') {
            continue;
        }
        if argument.trim().is_empty() {
            continue;
        }
        let path = PathBuf::from(argument);
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        if path.is_file() {
            if let Ok(canonical) = path.canonicalize() {
                if let Ok(text) = path_string(&canonical) {
                    if !result.contains(&text) {
                        result.push(text);
                        if result.len() == MAX_OPEN_REQUESTS {
                            break;
                        }
                    }
                }
            }
        }
    }
    result
}
fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn inspected(path: &Path, encoding: Option<TextEncoding>) -> WorkspaceFile {
        inspect_file(InspectFileRequest {
            path: path_string(path).unwrap(),
            encoding,
        })
        .unwrap()
    }
    #[test]
    fn all_supported_text_encodings_roundtrip_bom_and_line_endings_without_loss() {
        let root = tempfile::tempdir().unwrap();
        for (index, encoding) in [
            TextEncoding::Utf8,
            TextEncoding::Utf8Bom,
            TextEncoding::Utf16Le,
            TextEncoding::Utf16LeBom,
            TextEncoding::Utf16Be,
            TextEncoding::Utf16BeBom,
            TextEncoding::Windows1252,
        ]
        .into_iter()
        .enumerate()
        {
            let content = "-- città €\r\nSELECT 'l’acqua';\r\n";
            let bytes = encode_text(content, encoding).unwrap();
            let path = root.path().join(format!("script-{index}.sql"));
            fs::write(&path, &bytes).unwrap();
            let file = inspected(&path, Some(encoding));
            assert_eq!(file.kind, FileKind::Sql);
            assert_eq!(file.content.as_deref(), Some(content));
            save_text(SaveTextRequest {
                path: file.path,
                content: content.into(),
                encoding,
                expected_fingerprint: Some(file.fingerprint),
            })
            .unwrap();
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }
    #[test]
    fn cp1252_is_explicit_and_unrepresentable_text_never_overwrites_original() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("legacy.sql");
        let original = b"SELECT '\x80\x81\xe8';";
        fs::write(&path, original).unwrap();
        let unknown = inspected(&path, None);
        assert!(unknown.requires_encoding);
        assert!(unknown.content.is_none());
        let file = inspected(&path, Some(TextEncoding::Windows1252));
        assert!(!file.requires_encoding);
        assert_eq!(
            encode_text(file.content.as_ref().unwrap(), TextEncoding::Windows1252).unwrap(),
            original
        );
        assert!(save_text(SaveTextRequest {
            path: file.path,
            content: "SELECT '😀';".into(),
            encoding: TextEncoding::Windows1252,
            expected_fingerprint: Some(file.fingerprint)
        })
        .is_err());
        assert_eq!(fs::read(path).unwrap(), original);
    }
    #[test]
    fn external_edit_and_cross_file_fingerprints_are_rejected_without_clobber() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("query.sql");
        fs::write(&path, b"SELECT 1;").unwrap();
        let file = inspected(&path, None);
        fs::write(&path, b"SELECT 2;").unwrap();
        assert!(save_text(SaveTextRequest {
            path: file.path.clone(),
            content: "SELECT 3;".into(),
            encoding: TextEncoding::Utf8,
            expected_fingerprint: Some(file.fingerprint)
        })
        .unwrap_err()
        .contains("CONFLITTO_FILE"));
        assert_eq!(fs::read(&path).unwrap(), b"SELECT 2;");
        let another = root.path().join("other.sql");
        fs::write(&another, b"SELECT 2;").unwrap();
        let current = inspected(&path, None);
        assert!(save_text(SaveTextRequest {
            path: path_string(&another).unwrap(),
            content: "SELECT 9;".into(),
            encoding: TextEncoding::Utf8,
            expected_fingerprint: Some(current.fingerprint)
        })
        .is_err());
    }
    #[test]
    fn save_as_uses_create_new_and_never_overwrites_existing_file() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("created.sql");
        let request = SaveTextRequest {
            path: path_string(&path).unwrap(),
            content: "SELECT 1;".into(),
            encoding: TextEncoding::Utf8Bom,
            expected_fingerprint: None,
        };
        let file = save_text(request).unwrap();
        assert_eq!(file.encoding, Some(TextEncoding::Utf8Bom));
        assert!(save_text(SaveTextRequest {
            path: file.path,
            content: "changed".into(),
            encoding: TextEncoding::Utf8,
            expected_fingerprint: None
        })
        .is_err());
        assert_eq!(
            fs::read(path).unwrap(),
            [&[0xef, 0xbb, 0xbf][..], b"SELECT 1;"].concat()
        );
    }
    #[test]
    fn oversized_binary_and_database_text_saves_are_guarded() {
        let root = tempfile::tempdir().unwrap();
        let large = root.path().join("large.sql");
        File::create(&large)
            .unwrap()
            .set_len(MAX_TEXT_BYTES + 1)
            .unwrap();
        let file = inspected(&large, None);
        assert!(file.read_only);
        assert!(file.content.is_none());
        let exe = root.path().join("program.bin");
        fs::write(&exe, b"PK\x03\x04binary").unwrap();
        let file = inspected(&exe, None);
        assert_eq!(file.kind, FileKind::Binary);
        assert!(save_text(SaveTextRequest {
            path: file.path,
            content: "changed".into(),
            encoding: TextEncoding::Utf8,
            expected_fingerprint: Some(file.fingerprint)
        })
        .is_err());
        assert!(save_text(SaveTextRequest {
            path: path_string(&root.path().join("fake.db")).unwrap(),
            content: "CREATE TABLE t(id);".into(),
            encoding: TextEncoding::Utf8,
            expected_fingerprint: None
        })
        .is_err());
    }
    #[test]
    fn directory_listing_is_read_only_bounded_and_pages_without_losing_entries() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..205 {
            fs::write(
                root.path().join(format!("source-{index}.rs")),
                "SELECT is data, not executed",
            )
            .unwrap();
        }
        let first = list_directory(root.path().to_str().unwrap(), 0).unwrap();
        assert_eq!(first.entries.len(), 200);
        assert!(first.truncated);
        let second =
            list_directory(root.path().to_str().unwrap(), first.next_offset.unwrap()).unwrap();
        assert_eq!(second.entries.len(), 5);
        assert!(!second.truncated);
        let names = first
            .entries
            .iter()
            .chain(&second.entries)
            .map(|e| e.name.clone())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(names.len(), 205);
    }
    #[test]
    fn utf16_rejects_invalid_surrogates_instead_of_replacement_characters() {
        assert!(decode_text(&[0x00, 0xd8], TextEncoding::Utf16Le).is_err());
        assert!(decode_text(&[0], TextEncoding::Utf16Be).is_err());
    }
    #[test]
    fn command_line_paths_are_existing_files_only_and_queue_input_is_bounded() {
        let root = tempfile::tempdir().unwrap();
        let mut args = vec![
            "app.exe".to_owned(),
            "--ignored".into(),
            "missing.db".into(),
        ];
        for index in 0..40 {
            let name = format!("file {index}.sql");
            fs::write(root.path().join(&name), "SELECT 1;").unwrap();
            args.push(name);
        }
        let paths = paths_from_arguments(&args, root.path());
        assert_eq!(paths.len(), 32);
        assert!(paths.iter().all(|p| Path::new(p).is_file()));
        assert!(!root.path().join("missing.db").exists());
    }
    #[test]
    fn explorer_plans_preserve_spaces_commas_and_unicode_as_one_path() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("Dati, esempi più 日本語");
        fs::create_dir(&directory).unwrap();
        let source = directory.join("query,è.sql");
        let contents = "DROP TABLE should_never_run_on_reveal;";
        fs::write(&source, contents).unwrap();
        let opened = file_manager_plan(
            directory.to_str().unwrap(),
            FileManagerAction::OpenDirectory,
        )
        .unwrap();
        assert_eq!(opened.action, FileManagerAction::OpenDirectory);
        assert_eq!(
            opened.path,
            PathBuf::from(path_string(&directory.canonicalize().unwrap()).unwrap())
        );
        let revealed =
            file_manager_plan(source.to_str().unwrap(), FileManagerAction::RevealFile).unwrap();
        assert_eq!(revealed.action, FileManagerAction::RevealFile);
        let normal = path_string(&source.canonicalize().unwrap()).unwrap();
        assert_eq!(revealed.path, PathBuf::from(&normal));
        assert_eq!(
            quoted_explorer_path(&revealed.path).unwrap(),
            format!("\"{normal}\"")
        );
        assert_eq!(fs::read_to_string(&source).unwrap(), contents);
        // Root-directory backslashes cannot escape the final Windows quote.
        assert_eq!(
            quoted_explorer_path(Path::new("C:\\")).unwrap(),
            "\"C:\\\\\""
        );
        assert!(quoted_explorer_path(Path::new("bad\"argument")).is_err());
    }
    #[test]
    fn explorer_rejects_missing_wrong_kind_and_device_paths_before_launch() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("existing.sql");
        fs::write(&file, "SELECT 1;").unwrap();
        assert!(open_directory(file.to_str().unwrap()).is_err());
        assert!(reveal_file(root.path().to_str().unwrap()).is_err());
        let missing = root.path().join("not-created");
        assert!(open_directory(missing.to_str().unwrap()).is_err());
        assert!(reveal_file(missing.to_str().unwrap()).is_err());
        assert!(!missing.exists());
        for path in [
            r"\\.\NUL",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1",
            r"\\?\PIPE\test",
            "",
            "bad\0path",
        ] {
            assert!(open_directory(path).is_err(), "{path:?}");
            assert!(reveal_file(path).is_err(), "{path:?}");
        }
    }
}
