use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
};

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains(['\\', ':', '\0'])
        || path.is_absolute()
        || path
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("Percorso nel manifesto non valido.".into());
    }
    let mut nested = root.to_path_buf();
    for part in path.components() {
        nested.push(part);
        match fs::symlink_metadata(&nested) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("Collegamento simbolico nel pacchetto.".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Percorso reindirizzato nel pacchetto.".into());
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(root.join(path))
}

fn read_small(path: &Path, max: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err("File del pacchetto troppo grande per il confronto.".into());
    }
    Ok(bytes)
}

pub fn inspect(directory: &str) -> Result<Value, String> {
    let root = fs::canonicalize(directory).map_err(|e| e.to_string())?;
    let manifest: Value = serde_json::from_slice(&read_small(
        &safe_path(&root, "database-manager-project.json")?,
        8 * 1024 * 1024,
    )?)
    .map_err(|e| e.to_string())?;
    if manifest["format"] != "database-manager-project" || manifest["version"] != 1 {
        return Err("Manifesto Database Manager non riconosciuto.".into());
    }
    let entries = manifest["files"].as_array().ok_or(
        "Questo manifesto non include la mappa dei sorgenti. Esporta il progetto con la 0.6.0.",
    )?;
    if entries.len() > 10000 {
        return Err("Troppi file nel manifesto.".into());
    }
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    let mut total = 0;
    for entry in entries {
        let relative = entry["path"]
            .as_str()
            .ok_or("Manca il percorso del file.")?;
        if !relative.starts_with("databases/")
            || !matches!(
                entry["kind"].as_str(),
                Some("query" | "parameters" | "source" | "schema" | "schemaSource")
            )
        {
            return Err("Voce sconosciuta nella mappa dei sorgenti.".into());
        }
        if !seen.insert(relative.to_lowercase()) {
            return Err("Percorso duplicato nel manifesto.".into());
        }
        let path = safe_path(&root, relative)?;
        let digest = entry["sha256"]
            .as_str()
            .ok_or("Manca l’impronta del sorgente.")?;
        if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Impronta sorgente non valida.".into());
        }
        let mut item = entry.clone();
        if !path.exists() {
            item["missing"] = json!(true);
            item["changed"] = json!(true);
        } else {
            let bytes = read_small(&path, 2 * 1024 * 1024)?;
            total += bytes.len();
            if total > 32 * 1024 * 1024 {
                return Err("Il confronto supera 32 MiB.".into());
            }
            let hash = hex::encode(Sha256::digest(&bytes));
            let changed = !hash.eq_ignore_ascii_case(digest);
            item["changed"] = json!(changed);
            item["actualHash"] = json!(hash);
            if changed || matches!(entry["kind"].as_str(), Some("query" | "parameters")) {
                item["content"] =
                    json!(String::from_utf8(bytes).map_err(|_| "Sorgente non UTF-8.")?);
            }
        }
        files.push(item);
    }
    Ok(json!({"manifest":manifest,"files":files}))
}
