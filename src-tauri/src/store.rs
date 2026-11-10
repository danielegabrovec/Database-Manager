use crate::models::*;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{path::Path, sync::Mutex};

pub struct Store {
    db: Mutex<Connection>,
}
impl Store {
    pub fn new(path: &Path) -> Result<Self, String> {
        let c = Connection::open(path).map_err(|e| e.to_string())?;
        // Flush committed workspace changes to the WAL before acknowledging a save.
        c.pragma_update(None, "synchronous", "FULL").map_err(|e| e.to_string())?;
        c.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS queries(id TEXT PRIMARY KEY,json TEXT NOT NULL);CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,json TEXT NOT NULL,at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,json TEXT NOT NULL);INSERT OR IGNORE INTO settings VALUES(1,'{}');CREATE TABLE IF NOT EXISTS recent_workspace_files(path TEXT PRIMARY KEY,json TEXT NOT NULL,opened_at TEXT NOT NULL);").map_err(|e|e.to_string())?;
        Ok(Self { db: Mutex::new(c) })
    }
    fn read_list<T: serde::de::DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>, String> {
        let c = self.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = c.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }
    pub fn profiles(&self) -> Result<Vec<ConnectionProfile>, String> {
        self.read_list("SELECT json FROM profiles ORDER BY json_extract(json,'$.name')")
    }
    pub fn profile(&self, id: &str) -> Result<ConnectionProfile, String> {
        self.profiles()?
            .into_iter()
            .find(|p| p.id == id)
            .ok_or("Connessione non trovata".into())
    }
    pub fn recent_workspace_files(
        &self,
    ) -> Result<Vec<crate::workspace_files::RecentFile>, String> {
        self.read_list(
            "SELECT json FROM recent_workspace_files ORDER BY opened_at DESC,path LIMIT 50",
        )
    }
    pub fn remember_workspace_file(
        &self,
        file: &crate::workspace_files::WorkspaceFile,
    ) -> Result<(), String> {
        let recent = crate::workspace_files::RecentFile {
            path: file.path.clone(),
            name: file.name.clone(),
            kind: file.kind,
            encoding: file.encoding,
            opened_at: chrono::Utc::now().to_rfc3339(),
        };
        let connection = self.db.lock().map_err(|e| e.to_string())?;
        connection.execute("INSERT INTO recent_workspace_files(path,json,opened_at) VALUES(?1,?2,?3) ON CONFLICT(path) DO UPDATE SET json=excluded.json,opened_at=excluded.opened_at",params![recent.path,serde_json::to_string(&recent).map_err(|e|e.to_string())?,recent.opened_at]).map_err(|e|e.to_string())?;
        connection.execute("DELETE FROM recent_workspace_files WHERE path NOT IN (SELECT path FROM recent_workspace_files ORDER BY opened_at DESC,path LIMIT 50)",[]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn remove_workspace_recent(&self, path: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM recent_workspace_files WHERE path=?1", [path])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn clear_workspace_recents(&self) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM recent_workspace_files", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn save_profile(&self, p: &ConnectionProfile) -> Result<(), String> {
        self.db.lock().map_err(|e|e.to_string())?.execute("INSERT INTO profiles VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![p.id,serde_json::to_string(p).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        self.db
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM profiles WHERE id=?1", [id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn saved(&self) -> Result<Vec<SavedQuery>, String> {
        self.read_list("SELECT json FROM queries ORDER BY json_extract(json,'$.name')")
    }
    pub fn save_query(&self, q: &SavedQuery) -> Result<(), String> {
        self.db.lock().map_err(|e|e.to_string())?.execute("INSERT INTO queries VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET json=excluded.json",params![q.id,serde_json::to_string(q).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn history(&self) -> Result<Vec<HistoryEntry>, String> {
        self.read_list("SELECT json FROM history ORDER BY at DESC LIMIT 500")
    }
    pub fn record(&self, h: &HistoryEntry) -> Result<(), String> {
        let c = self.db.lock().map_err(|e| e.to_string())?;
        c.execute(
            "INSERT INTO history VALUES(?1,?2,?3)",
            params![
                h.id,
                serde_json::to_string(h).map_err(|e| e.to_string())?,
                h.timestamp
            ],
        )
        .map_err(|e| e.to_string())?;
        c.execute("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY at DESC LIMIT 1000)",[]).map_err(|e|e.to_string())?;
        Ok(())
    }
    pub fn settings(&self) -> Result<Value, String> {
        let s: String = self
            .db
            .lock()
            .map_err(|e| e.to_string())?
            .query_row("SELECT json FROM settings WHERE id=1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| e.to_string())
    }
    pub fn update_settings(&self, patch: Value) -> Result<Value, String> {
        let c = self.db.lock().map_err(|e| e.to_string())?;
        let s: String = c
            .query_row("SELECT json FROM settings WHERE id=1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let mut v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
        let object = v.as_object_mut().ok_or("Impostazioni corrotte")?;
        for (k, value) in patch
            .as_object()
            .ok_or("Impostazioni devono essere un oggetto")?
        {
            object.insert(k.clone(), value.clone());
        }
        c.execute("UPDATE settings SET json=?1 WHERE id=1", [v.to_string()])
            .map_err(|e| e.to_string())?;
        Ok(v)
    }
}
pub fn engines() -> Value {
    json!([
 {"id":"sqlite","name":"SQLite","port":0,"description":"File locale · SQL","capabilities":["sql","transactions","explain","backup","laboratory"]},
 {"id":"postgresql","name":"PostgreSQL","port":5432,"description":"Server relazionale","capabilities":["sql","schemas","transactions","explain","backup"]},
 {"id":"mysql","name":"MySQL","port":3306,"description":"Server relazionale","capabilities":["sql","transactions","explain","backup"]},
 {"id":"mariadb","name":"MariaDB","port":3306,"description":"Server relazionale","capabilities":["sql","transactions","explain","backup"]},
 {"id":"mongodb","name":"MongoDB","port":27017,"description":"Documenti · Extended JSON","capabilities":["documents","pipelines","explain","backup"]}])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_survives_reopening_and_unrelated_settings_updates() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("workspace.sqlite");
        let recovery = json!({"version":1,"draft":"SELECT 'città';","document":{"fingerprint":"original","encoding":"utf-16le-bom"}});
        {
            let store = Store::new(&path).unwrap();
            let db = store.db.lock().unwrap();
            assert_eq!(db.pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0)).unwrap(), 2);
            drop(db);
            store.update_settings(json!({"fileRecovery":recovery,"queryWorkspace":{"version":1}})).unwrap();
            store.update_settings(json!({"theme":"light"})).unwrap();
        }
        let restored = Store::new(&path).unwrap().settings().unwrap();
        assert_eq!(restored["fileRecovery"], recovery);
        assert_eq!(restored["theme"], "light");
    }
    #[test]
    fn merges_settings_and_profiles_roundtrip() {
        let t = tempfile::tempdir().unwrap();
        let s = Store::new(&t.path().join("meta.db")).unwrap();
        s.update_settings(json!({"theme":"dark"})).unwrap();
        s.update_settings(json!({"mode":"learn"})).unwrap();
        assert_eq!(s.settings().unwrap()["theme"], "dark");
        let p = ConnectionProfile {
            id: "x".into(),
            name: "Udine".into(),
            ..Default::default()
        };
        s.save_profile(&p).unwrap();
        assert_eq!(s.profile("x").unwrap().name, "Udine");
    }
}
