//! Previews and installs generated files in a project-owned subdirectory only.
use crate::{codegen::GeneratedFile, workspace_files};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const STATE_FILE: &str = ".dbm-state/owned.json";
const PENDING_FILE: &str = ".dbm-state/pending.json";
const LOCK_FILE: &str = ".dbm-state/transaction.lock";
static TRANSACTION: Mutex<()> = Mutex::new(());
type Result<T> = std::result::Result<T, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    root: String,
    project_id: String,
    #[serde(default)]
    files: Vec<GeneratedFile>,
    #[serde(default)]
    selected: Vec<Selection>,
    state_hash: Option<String>,
    transaction_id: Option<String>,
}

#[derive(Deserialize)]
struct Selection {
    path: String,
    before: Option<String>,
    after: String,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedState {
    files: BTreeMap<String, String>,
    last_transaction: Option<String>,
}

#[derive(Serialize)]
struct Difference {
    path: String,
    before: Option<String>,
    after: String,
    status: &'static str,
}

#[derive(Serialize, Deserialize)]
struct Change {
    path: String,
    before: Option<String>,
    after: String,
}

#[derive(Serialize, Deserialize)]
struct Journal {
    state: OwnedState,
    changes: Vec<Change>,
}

#[derive(Serialize, Deserialize)]
struct Pending {
    before_state: Option<String>,
    after_state: String,
    changes: Vec<RecoveryChange>,
    discard_if_undone: Option<String>,
    discard_if_committed: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct RecoveryChange {
    path: String,
    before: Option<String>,
    after: Option<String>,
}

fn index_key(path: &str) -> String {
    if cfg!(windows) {
        path.to_ascii_lowercase()
    } else {
        path.to_owned()
    }
}

fn owned<'a>(state: &'a OwnedState, file: &str) -> Option<&'a String> {
    let key = index_key(file);
    state.files.get(&key).or_else(|| {
        state
            .files
            .iter()
            .find(|(path, _)| index_key(path) == key)
            .map(|(_, hash)| hash)
    })
}

fn error(cause: impl std::fmt::Display) -> String {
    cause.to_string()
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn portable(parts: &str) -> Result<Vec<&str>> {
    let folders: Vec<_> = parts.split('/').collect();
    if parts.len() > 480
        || folders.len() > 20
        || folders.iter().any(|part| {
            let stem = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.ends_with('.')
                || part.len() > 120
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || (stem.len() == 4
                    && (stem.starts_with("COM") || stem.starts_with("LPT"))
                    && stem.as_bytes()[3].is_ascii_digit())
        })
    {
        return Err(format!("Percorso di integrazione non valido: {parts}."));
    }
    Ok(folders)
}

fn symlink(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn path(base: &Path, relative: &str, create_parents: bool) -> Result<PathBuf> {
    let parts = portable(relative)?;
    let mut found = base.to_path_buf();
    for (index, part) in parts.iter().enumerate() {
        found.push(part);
        let is_file = index + 1 == parts.len();
        match fs::symlink_metadata(&found) {
            Ok(metadata) if symlink(&metadata) => return Err(
                "Collegamenti e junction non sono ammessi nella destinazione dell’integrazione."
                    .into(),
            ),
            Ok(metadata)
                if (is_file && !metadata.is_file()) || (!is_file && !metadata.is_dir()) =>
            {
                return Err(format!(
                    "Il percorso {relative} è occupato da un oggetto incompatibile."
                ));
            }
            Ok(_) => {}
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
                if create_parents && !is_file {
                    fs::create_dir(&found).map_err(error)?;
                }
            }
            Err(cause) => return Err(error(cause)),
        }
    }
    Ok(found)
}

fn bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(meta) if symlink(&meta) || !meta.is_file() => {
            Err("File di destinazione non regolare.".into())
        }
        Ok(meta) if meta.len() > (2 * MAX_BYTES) as u64 => {
            Err("File di destinazione oltre il limite.".into())
        }
        Ok(_) => fs::read(path).map(Some).map_err(error),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(cause) => Err(error(cause)),
    }
}

fn hash(path: &Path) -> Result<Option<String>> {
    Ok(bytes(path)?.map(|value| digest(&value)))
}

fn write(base: &Path, relative: &str, content: &[u8], expected: Option<&str>) -> Result<()> {
    let destination = path(base, relative, true)?;
    let mut staged = tempfile::NamedTempFile::new_in(
        destination
            .parent()
            .ok_or("Cartella di destinazione non valida.")?,
    )
    .map_err(error)?;
    staged
        .write_all(content)
        .and_then(|()| staged.as_file().sync_all())
        .map_err(error)?;
    if hash(&path(base, relative, false)?)?.as_deref() != expected {
        return Err(format!("File cambiato dopo l’anteprima: {relative}."));
    }
    if expected.is_some() {
        staged.persist(&destination).map_err(error)?;
    } else {
        staged.persist_noclobber(&destination).map_err(error)?;
    }
    Ok(())
}

fn directory(request: &Request) -> Result<(PathBuf, String)> {
    if request.project_id.is_empty() || request.project_id.len() > 128 {
        return Err("Identità del progetto non valida.".into());
    }
    let root = workspace_files::canonical_existing_directory(&request.root)?;
    let project = digest(request.project_id.as_bytes());
    Ok((root, format!("database-manager/{}", &project[..24])))
}

fn state(base: &Path, prefix: &str) -> Result<(OwnedState, Option<String>)> {
    let loaded = bytes(&path(base, &format!("{prefix}/{STATE_FILE}"), false)?)?;
    match loaded {
        Some(body) => Ok((
            serde_json::from_slice(&body).map_err(error)?,
            Some(digest(&body)),
        )),
        None => Ok((OwnedState::default(), None)),
    }
}

fn inspect(
    base: &Path,
    prefix: &str,
    state: &OwnedState,
    files: &[GeneratedFile],
) -> Result<Vec<Difference>> {
    if files.is_empty()
        || files.len() > 1024
        || files.iter().map(|file| file.content.len()).sum::<usize>() > MAX_BYTES
    {
        return Err("Il pacchetto supera il limite di integrazione o non contiene file.".into());
    }
    let mut seen = BTreeSet::new();
    files
        .iter()
        .map(|file| {
            portable(&file.path)?;
            let key = file.path.to_ascii_lowercase();
            if key.starts_with(".dbm-state")
                || seen.iter().any(|existing: &String| {
                    key.starts_with(&format!("{existing}/"))
                        || existing.starts_with(&format!("{key}/"))
                })
                || !seen.insert(key)
            {
                return Err("Percorso interno riservato o duplicato nel pacchetto.".into());
            }
            let before = hash(&path(base, &format!("{prefix}/{}", file.path), false)?)?;
            let after = digest(file.content.as_bytes());
            let status = match &before {
                None => "create",
                Some(current) if current == &after => "unchanged",
                Some(current) if owned(state, &file.path) == Some(current) => "update",
                Some(_) => "conflict",
            };
            Ok(Difference {
                path: file.path.clone(),
                before,
                after,
                status,
            })
        })
        .collect()
}

pub(crate) fn command(name: &str, args: Value) -> Result<Value> {
    let request: Request = serde_json::from_value(args).map_err(error)?;
    let _serial = TRANSACTION.lock().map_err(error)?;
    let (base, prefix) = directory(&request)?;
    let _process_lock = if matches!(
        name,
        "apply_app_integration" | "rollback_app_integration" | "recover_app_integration"
    ) {
        Some(lock_transaction(&base, &prefix)?)
    } else {
        None
    };
    let (current, state_hash) = state(&base, &prefix)?;
    if name == "recover_app_integration" {
        return recover(&base, &prefix);
    }
    let interrupted = bytes(&path(&base, &format!("{prefix}/{PENDING_FILE}"), false)?)?.is_some();
    if interrupted && name != "preview_app_integration" && name != "diff_app_integration" {
        return Err(
            "Completa il recupero dell’integrazione interrotta prima di proseguire.".into(),
        );
    }
    if name == "rollback_app_integration" {
        return undo(
            &base,
            &prefix,
            current,
            state_hash,
            request.transaction_id.as_deref(),
        );
    }
    let differences = inspect(&base, &prefix, &current, &request.files)?;
    if name == "preview_app_integration" {
        return Ok(json!({
            "destination":workspace_files::path_string(&base.join(&prefix))?,
            "stateHash":state_hash, "lastTransaction":current.last_transaction, "files":differences,
            "interrupted":interrupted,
        }));
    }
    if name == "diff_app_integration" {
        let difference = differences
            .first()
            .filter(|_| differences.len() == 1)
            .ok_or("Scegli un solo file da confrontare.")?;
        let input = bytes(&path(
            &base,
            &format!("{prefix}/{}", difference.path),
            false,
        )?)?;
        if input.as_ref().map(|body| digest(body)) != difference.before {
            return Err("Il file è cambiato durante il confronto.".into());
        }
        let text = input
            .as_ref()
            .and_then(|body| std::str::from_utf8(body).ok());
        let limit: String = text.unwrap_or_default().chars().take(32_000).collect();
        return Ok(json!({
            "before": if input.is_some() && text.is_none() { None } else { Some(&limit) },
            "beforeHash": difference.before,
            "afterHash": difference.after,
            "truncated":text.is_some_and(|text| text.len() > limit.len()),
        }));
    }
    if request.state_hash != state_hash {
        return Err("Lo stato dell’integrazione è cambiato. Aggiorna l’anteprima.".into());
    }
    let selected: BTreeMap<_, _> = request
        .selected
        .iter()
        .map(|item| (index_key(&item.path), item))
        .collect();
    if selected.len() != request.selected.len()
        || selected.keys().any(|requested| {
            !differences
                .iter()
                .any(|item| &index_key(&item.path) == requested)
        })
    {
        return Err("La selezione contiene percorsi duplicati o assenti dal pacchetto.".into());
    }
    let mut pending = Vec::new();
    let mut proposed = current.clone();
    for (difference, file) in differences.iter().zip(&request.files) {
        let Some(expected) = selected.get(&index_key(&difference.path)) else {
            continue;
        };
        if expected.before != difference.before || expected.after != difference.after {
            return Err(format!(
                "File cambiato dopo l’anteprima: {}.",
                difference.path
            ));
        }
        if difference.status == "conflict" {
            return Err(format!(
                "Modifica manuale conservata in {}.",
                difference.path
            ));
        }
        if difference.status == "unchanged" {
            continue;
        }
        let relative = format!("{prefix}/{}", file.path);
        let before = bytes(&path(&base, &relative, false)?)?
            .map(String::from_utf8)
            .transpose()
            .map_err(error)?;
        if before.as_ref().map(|text| digest(text.as_bytes())) != difference.before {
            return Err(format!(
                "File cambiato dopo l’anteprima: {}.",
                difference.path
            ));
        }
        let indexed = index_key(&file.path);
        proposed.files.retain(|path, _| index_key(path) != indexed);
        proposed.files.insert(indexed, difference.after.clone());
        pending.push((
            Change {
                path: file.path.clone(),
                before,
                after: difference.after.clone(),
            },
            file.content.as_bytes(),
        ));
    }
    if pending.is_empty() {
        return Ok(json!({"changed":0,"transactionId":current.last_transaction}));
    }
    let transaction = uuid::Uuid::new_v4().to_string();
    let journal = Journal {
        state: current,
        changes: pending
            .iter()
            .map(|(change, _)| Change {
                path: change.path.clone(),
                before: change.before.clone(),
                after: change.after.clone(),
            })
            .collect(),
    };
    let journal_path = format!("{prefix}/.dbm-state/{transaction}.json");
    write(
        &base,
        &journal_path,
        &serde_json::to_vec(&journal).map_err(error)?,
        None,
    )?;
    proposed.last_transaction = Some(transaction.clone());
    transact(
        &base,
        &prefix,
        state_hash,
        proposed,
        pending
            .iter()
            .map(|(change, content)| {
                (
                    RecoveryChange {
                        path: change.path.clone(),
                        before: change.before.clone(),
                        after: Some(change.after.clone()),
                    },
                    Some(*content),
                )
            })
            .collect(),
        Some(transaction.clone()),
        journal.state.last_transaction,
    )?;
    Ok(json!({"changed":pending.len(),"transactionId":transaction}))
}

fn lock_transaction(base: &Path, prefix: &str) -> Result<File> {
    let lock = path(base, &format!("{prefix}/{LOCK_FILE}"), true)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock)
        .map_err(error)?;
    file.try_lock()
        .map_err(|error| format!("È già in corso un’integrazione in questa cartella: {error}"))?;
    Ok(file)
}

fn undo(
    base: &Path,
    prefix: &str,
    current: OwnedState,
    current_hash: Option<String>,
    transaction: Option<&str>,
) -> Result<Value> {
    let id = transaction
        .filter(|id| uuid::Uuid::parse_str(id).is_ok())
        .filter(|id| Some(*id) == current.last_transaction.as_deref())
        .ok_or("Seleziona l’ultima integrazione disponibile.")?;
    let journal_path = format!("{prefix}/.dbm-state/{id}.json");
    let journal: Journal = serde_json::from_slice(
        &bytes(&path(base, &journal_path, false)?)?.ok_or("Copia di integrazione mancante.")?,
    )
    .map_err(error)?;
    let changes = journal
        .changes
        .iter()
        .map(|change| {
            let relative = format!("{prefix}/{}", change.path);
            let content =
                bytes(&path(base, &relative, false)?)?.ok_or("File dell’integrazione mancante.")?;
            if digest(&content) != change.after {
                return Err(format!("Modifica manuale conservata in {}.", change.path));
            }
            Ok((
                RecoveryChange {
                    path: change.path.clone(),
                    before: Some(String::from_utf8(content).map_err(error)?),
                    after: change.before.as_ref().map(|value| digest(value.as_bytes())),
                },
                change.before.as_ref().map(|value| value.as_bytes()),
            ))
        })
        .collect::<Result<Vec<_>>>()?;
    let previous = OwnedState {
        last_transaction: None,
        ..journal.state
    };
    transact(
        base,
        prefix,
        current_hash,
        previous,
        changes,
        None,
        Some(id.into()),
    )?;
    Ok(json!({"changed":journal.changes.len()}))
}

fn replace(
    base: &Path,
    relative: &str,
    content: Option<&[u8]>,
    expected: Option<&str>,
) -> Result<()> {
    if let Some(content) = content {
        return write(base, relative, content, expected);
    }
    let file = path(base, relative, false)?;
    if hash(&file)?.as_deref() != expected {
        return Err(format!("Il file {relative} è cambiato."));
    }
    if expected.is_some() {
        fs::remove_file(file).map_err(error)?;
    }
    Ok(())
}

fn file_path(prefix: &str, relative: &str) -> Result<String> {
    portable(relative)?;
    if relative.to_ascii_lowercase().starts_with(".dbm-state") {
        return Err("La transazione include un file interno riservato.".into());
    }
    Ok(format!("{prefix}/{relative}"))
}

fn transact(
    base: &Path,
    prefix: &str,
    previous: Option<String>,
    next: OwnedState,
    changes: Vec<(RecoveryChange, Option<&[u8]>)>,
    discard_if_undone: Option<String>,
    discard_if_committed: Option<String>,
) -> Result<()> {
    let next = serde_json::to_vec(&next).map_err(error)?;
    let (recoveries, contents): (Vec<_>, Vec<_>) = changes.into_iter().unzip();
    let pending = Pending {
        before_state: previous,
        after_state: digest(&next),
        changes: recoveries,
        discard_if_undone,
        discard_if_committed,
    };
    let marker = format!("{prefix}/{PENDING_FILE}");
    let journal = serde_json::to_vec(&pending).map_err(error)?;
    if journal.len() > 2 * MAX_BYTES {
        return Err("I file precedenti superano il limite della copia di recupero.".into());
    }
    write(base, &marker, &journal, None)?;
    let result = (|| {
        for (change, content) in pending.changes.iter().zip(contents) {
            let before = change.before.as_ref().map(|body| digest(body.as_bytes()));
            replace(
                base,
                &file_path(prefix, &change.path)?,
                content,
                before.as_deref(),
            )?;
        }
        write(
            base,
            &format!("{prefix}/{STATE_FILE}"),
            &next,
            pending.before_state.as_deref(),
        )
    })();
    if let Err(message) = result {
        return match recover(base, prefix) {
            Ok(_) => Err(format!("Operazione annullata. {message}")),
            Err(cleanup) => Err(format!("{message} Recupero in attesa: {cleanup}")),
        };
    }
    finish_recovery(
        base,
        prefix,
        &marker,
        pending.discard_if_committed.as_deref(),
    )?;
    Ok(())
}

fn finish_recovery(base: &Path, prefix: &str, marker: &str, discard: Option<&str>) -> Result<()> {
    if let Some(id) = discard.filter(|id| uuid::Uuid::parse_str(id).is_ok()) {
        let file = path(base, &format!("{prefix}/.dbm-state/{id}.json"), false)?;
        if hash(&file)?.is_some() {
            fs::remove_file(file).map_err(error)?;
        }
    }
    fs::remove_file(path(base, marker, false)?).map_err(error)
}

fn recover(base: &Path, prefix: &str) -> Result<Value> {
    let marker = format!("{prefix}/{PENDING_FILE}");
    let Some(body) = bytes(&path(base, &marker, false)?)? else {
        return Ok(json!({"changed":0,"committed":false}));
    };
    let pending: Pending = serde_json::from_slice(&body).map_err(error)?;
    let (_, state_hash) = state(base, prefix)?;
    if state_hash.as_deref() == Some(&pending.after_state) {
        finish_recovery(
            base,
            prefix,
            &marker,
            pending.discard_if_committed.as_deref(),
        )?;
        return Ok(json!({"changed":0,"committed":true}));
    }
    if state_hash != pending.before_state {
        return Err(
            "Lo stato locale è cambiato. La copia per il recupero rimane disponibile.".into(),
        );
    }
    let mut unfinished = Vec::new();
    for change in pending.changes.iter().rev() {
        let relative = file_path(prefix, &change.path)?;
        let actual = hash(&path(base, &relative, false)?)?;
        let before = change.before.as_ref().map(|value| digest(value.as_bytes()));
        if actual == before {
            continue;
        }
        if actual != change.after {
            return Err(format!(
                "Modifica manuale conservata in {}. La copia per il recupero rimane disponibile.",
                change.path
            ));
        }
        unfinished.push((relative, change));
    }
    for (relative, change) in &unfinished {
        replace(
            base,
            relative,
            change.before.as_ref().map(|value| value.as_bytes()),
            change.after.as_deref(),
        )?;
    }
    finish_recovery(base, prefix, &marker, pending.discard_if_undone.as_deref())?;
    Ok(json!({"changed":unfinished.len(),"committed":false}))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(root: &Path, files: &[(&str, &str)]) -> Value {
        json!({
            "root":root,"projectId":"qa-application",
            "files":files.iter().map(|(path,content)|json!({"path":path,"content":content})).collect::<Vec<_>>(),
        })
    }

    fn apply_args(mut payload: Value, preview: &Value) -> Value {
        payload["stateHash"] = preview["stateHash"].clone();
        payload["selected"] = json!(preview["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| {
                json!({"path":file["path"],"before":file["before"],"after":file["after"]})
            })
            .collect::<Vec<_>>());
        payload
    }

    #[test]
    fn integration_previews_selection_and_reverses_both_add_and_update() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("app.js"), "user app").unwrap();
        let original = payload(root.path(), &[("driver.js", "v1")]);
        let preview = command("preview_app_integration", original.clone()).unwrap();
        assert!(!root.path().join("database-manager").exists());
        assert_eq!(preview["files"][0]["status"], "create");
        command("apply_app_integration", apply_args(original, &preview)).unwrap();

        let next = payload(
            root.path(),
            &[
                ("driver.js", "v2"),
                ("notes.txt", "ready"),
                ("ignored.txt", "skip"),
            ],
        );
        let preview = command("preview_app_integration", next.clone()).unwrap();
        let destination = PathBuf::from(preview["destination"].as_str().unwrap());
        let mut change = apply_args(next.clone(), &preview);
        change["selected"].as_array_mut().unwrap().pop();
        let applied = command("apply_app_integration", change).unwrap();
        assert_eq!(applied["changed"], 2);
        assert_eq!(
            fs::read_to_string(destination.join("driver.js")).unwrap(),
            "v2"
        );
        assert!(!destination.join("ignored.txt").exists());
        let same = payload(root.path(), &[("notes.txt", "ready"), ("driver.js", "v2")]);
        let plan = command("preview_app_integration", same.clone()).unwrap();
        let replay = command("apply_app_integration", apply_args(same, &plan)).unwrap();
        assert_eq!(replay["changed"], 0);

        let result = command("rollback_app_integration", json!({
            "root": root.path(), "projectId":"qa-application", "transactionId":applied["transactionId"],
        })).unwrap();
        assert_eq!(result["changed"], 2);
        assert_eq!(
            fs::read_to_string(destination.join("driver.js")).unwrap(),
            "v1"
        );
        assert!(!destination.join("notes.txt").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("app.js")).unwrap(),
            "user app"
        );
    }

    #[test]
    fn integration_preserves_manual_edits_and_refuses_traversal() {
        let root = tempfile::tempdir().unwrap();
        let initial = payload(root.path(), &[("driver.js", "v1")]);
        let preview = command("preview_app_integration", initial.clone()).unwrap();
        let destination = PathBuf::from(preview["destination"].as_str().unwrap());
        let applied = command("apply_app_integration", apply_args(initial, &preview)).unwrap();

        let next = payload(root.path(), &[("driver.js", "v2"), ("notes.txt", "new")]);
        let preview = command("preview_app_integration", next.clone()).unwrap();
        fs::write(destination.join("driver.js"), "manual").unwrap();
        assert!(
            command("apply_app_integration", apply_args(next.clone(), &preview))
                .unwrap_err()
                .contains("dopo l’anteprima")
        );
        assert!(!destination.join("notes.txt").exists());
        let refreshed = command("preview_app_integration", next.clone()).unwrap();
        assert_eq!(refreshed["files"][0]["status"], "conflict");
        assert!(command("apply_app_integration", apply_args(next, &refreshed)).is_err());
        assert!(command("rollback_app_integration", json!({
            "root":root.path(),"projectId":"qa-application","transactionId":applied["transactionId"]
        })).is_err());
        assert_eq!(
            fs::read_to_string(destination.join("driver.js")).unwrap(),
            "manual"
        );
        assert!(command(
            "preview_app_integration",
            payload(root.path(), &[("../app.js", "unsafe")])
        )
        .is_err());
        let compared = command(
            "diff_app_integration",
            payload(root.path(), &[("driver.js", "v2")]),
        )
        .unwrap();
        assert_eq!(compared["before"], "manual");
        assert_eq!(compared["afterHash"], digest(b"v2"));
    }

    #[test]
    fn interrupted_transactions_are_recovered_from_disk_and_preserve_external_changes() {
        let root = tempfile::tempdir().unwrap();
        let input = payload(
            root.path(),
            &[("driver.js", "v2"), ("remaining.txt", "other")],
        );
        let request: Request = serde_json::from_value(input.clone()).unwrap();
        let (base, prefix) = directory(&request).unwrap();
        write(&base, &format!("{prefix}/driver.js"), b"v2", None).unwrap();
        let pending = Pending {
            before_state: None,
            after_state: digest(b"future state"),
            changes: vec![
                RecoveryChange {
                    path: "driver.js".into(),
                    before: None,
                    after: Some(digest(b"v2")),
                },
                RecoveryChange {
                    path: "remaining.txt".into(),
                    before: None,
                    after: Some(digest(b"other")),
                },
            ],
            discard_if_undone: None,
            discard_if_committed: None,
        };
        let marker = format!("{prefix}/{PENDING_FILE}");
        write(&base, &marker, &serde_json::to_vec(&pending).unwrap(), None).unwrap();
        let preview = command("preview_app_integration", input.clone()).unwrap();
        assert_eq!(preview["interrupted"], true);
        assert!(command("apply_app_integration", apply_args(input.clone(), &preview)).is_err());

        let file = path(&base, &format!("{prefix}/driver.js"), false).unwrap();
        fs::write(&file, b"work while interrupted").unwrap();
        assert!(command("recover_app_integration", input.clone())
            .unwrap_err()
            .contains("manuale"));
        assert_eq!(fs::read(&file).unwrap(), b"work while interrupted");
        assert!(path(&base, &marker, false).unwrap().exists());

        fs::write(&file, b"v2").unwrap();
        let recovered = command("recover_app_integration", input.clone()).unwrap();
        assert_eq!(recovered["changed"], 1);
        assert!(!file.exists());
        assert_eq!(
            command("preview_app_integration", input).unwrap()["interrupted"],
            false
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_ownership_is_case_insensitive() {
        let root = tempfile::tempdir().unwrap();
        let input = payload(root.path(), &[("Driver.js", "v1")]);
        let plan = command("preview_app_integration", input.clone()).unwrap();
        command("apply_app_integration", apply_args(input, &plan)).unwrap();
        let input = payload(root.path(), &[("driver.js", "v2")]);
        let plan = command("preview_app_integration", input.clone()).unwrap();
        assert_eq!(plan["files"][0]["status"], "update");
        command("apply_app_integration", apply_args(input, &plan)).unwrap();
        assert!(command(
            "preview_app_integration",
            payload(root.path(), &[("a", "file"), ("A/child", "dir")])
        )
        .is_err());
    }
}
