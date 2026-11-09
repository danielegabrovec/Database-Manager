//! Cancel only an authenticated user's operation carrying this application's job UUID.
//!
//! Sources: MongoDB manual `$currentOp` (allUsers=false) and `killOp` access control.
//! A kill acknowledgement is followed by observation; it is not called termination by itself.
use futures_util::TryStreamExt;
use mongodb::{
    bson::{doc, Bson, Document, Regex},
    Database,
};
use serde::Serialize;
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReport {
    pub matched: usize,
    pub marked: usize,
    pub terminated: bool,
    pub not_running: bool,
    pub message: String,
}

fn validate_job(job: &str) -> Result<(), String> {
    let uuid = job
        .strip_prefix("dbm-")
        .ok_or("Identificatore job MongoDB non valido")?;
    uuid::Uuid::parse_str(uuid).map_err(|_| "Identificatore job MongoDB non valido".to_string())?;
    if uuid.len() != 36 {
        return Err("Identificatore job MongoDB non valido".into());
    }
    Ok(())
}

/// Only command families supporting the server's top-level comment option.
/// Administrative/index maintenance operations deliberately cannot be tagged here.
pub fn can_tag(command: &Document) -> bool {
    command
        .keys()
        .next()
        .map(|name| {
            matches!(
                name.as_str(),
                "find"
                    | "aggregate"
                    | "count"
                    | "distinct"
                    | "insert"
                    | "update"
                    | "delete"
                    | "getMore"
            )
        })
        .unwrap_or(false)
}

/// Apply the exact correlation string used by `cancel`. Existing user comments are
/// replaced by the application job identifier; query contents are unaffected.
pub fn tag(command: &mut Document, job: &str) -> Result<(), String> {
    validate_job(job)?;
    if !can_tag(command) {
        return Err(
            "Questo comando MongoDB non supporta la correlazione per l'interruzione".into(),
        );
    }
    command.insert("comment", job);
    Ok(())
}

fn namespace_pattern(database: &str) -> String {
    let mut pattern = String::from("^");
    for character in database.chars() {
        if ".^$*+?()[]{}|\\".contains(character) {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push_str("\\.");
    pattern
}

async fn matching_operations(db: &Database, job: &str) -> Result<Vec<Bson>, String> {
    let admin = db.client().database("admin");
    // allUsers=false is essential: no inprog privilege and no visibility into
    // another authenticated user's operations on mongod.
    let pipeline = vec![
        doc! {"$currentOp":{"allUsers":false,"idleConnections":false,"idleCursors":false,"idleSessions":false}},
        doc! {"$match":{
            "active":true,"type":"op","client":{"$type":"string"},
            "ns":{"$regex":Regex{pattern:namespace_pattern(db.name()),options:String::new()}},
            "$or":[{"command.comment":job},{"cursor.originatingCommand.comment":job},{"originatingCommand.comment":job}]
        }},
        doc! {"$project":{"opid":1,"_id":0}},
    ];
    let mut cursor=admin.aggregate(pipeline).max_time(Duration::from_millis(750)).await
        .map_err(|error|format!("Impossibile osservare esclusivamente le proprie operazioni MongoDB: {error}. Nessun privilegio viene ampliato."))?;
    let mut ids = Vec::new();
    while let Some(operation) = cursor.try_next().await.map_err(|error| error.to_string())? {
        let id = operation
            .get("opid")
            .ok_or("MongoDB non ha restituito l'identificatore dell'operazione")?;
        if !matches!(id,Bson::Int32(value) if *value>0)
            && !matches!(id,Bson::Int64(value) if *value>0)
        {
            return Err("Identificatore operazione MongoDB non numerico: cancellazione non supportata per questa topologia".into());
        }
        if !ids.contains(id) {
            ids.push(id.clone());
        }
    }
    Ok(ids)
}

async fn cancel_inner(db: &Database, job: &str) -> Result<CancelReport, String> {
    let admin = db.client().database("admin");
    let hello = admin
        .run_command(doc! {"hello":1})
        .await
        .map_err(|error| error.to_string())?;
    if hello.get_str("msg").ok() == Some("isdbgrid") {
        return Err("Su mongos l'osservazione delle operazioni richiede inprog anche con allUsers:false; l'app non amplia i privilegi. Usare il timeout del comando.".into());
    }
    // Cover the small interval between publishing the job UUID and dispatching
    // the command. A missing operation is not reported as a successful kill.
    let discovery_deadline = tokio::time::Instant::now() + Duration::from_millis(700);
    let ids = loop {
        let ids = matching_operations(db, job).await?;
        if !ids.is_empty() || tokio::time::Instant::now() >= discovery_deadline {
            break ids;
        }
        tokio::time::sleep(Duration::from_millis(35)).await;
    };
    if ids.is_empty() {
        return Ok(CancelReport {
            matched: 0,
            marked: 0,
            terminated: false,
            not_running: true,
            message:
                "Nessuna operazione attiva osservata per questo job; nessun kill è stato eseguito."
                    .into(),
        });
    }
    for id in &ids {
        admin
            .run_command(doc! {"killOp":1,"op":id.clone()})
            .await
            .map_err(|error| {
                format!("MongoDB non ha accettato l'interruzione della propria operazione: {error}")
            })?;
    }
    loop {
        if matching_operations(db, job).await?.is_empty() {
            return Ok(CancelReport{matched:ids.len(),marked:ids.len(),terminated:true,not_running:false,message:"Interruzione MongoDB confermata: l'operazione del job non è più attiva sul server.".into()});
        }
        tokio::time::sleep(Duration::from_millis(35)).await;
    }
}

/// Only the app's UUID-tagged operations on this database and authenticated user
/// are eligible. No role changes, allUsers=true, administrative kill privileges,
/// or broad connection/session termination are used.
pub async fn cancel(db: &Database, job: &str) -> Result<CancelReport, String> {
    validate_job(job)?;
    tokio::time::timeout(Duration::from_secs(3),cancel_inner(db,job)).await
        .map_err(|_|"L'interruzione MongoDB non è stata confermata entro tre secondi; non viene dichiarato un arresto riuscito. Attendere l'esito della query o il suo timeout.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_expected_command_families_are_tagged() {
        let job = format!("dbm-{}", uuid::Uuid::new_v4());
        for family in [
            "find",
            "aggregate",
            "count",
            "distinct",
            "insert",
            "update",
            "delete",
            "getMore",
        ] {
            let mut command = Document::new();
            command.insert(family, "example");
            assert!(can_tag(&command));
            tag(&mut command, &job).unwrap();
            assert_eq!(command.get_str("comment").unwrap(), job);
        }
        for family in [
            "killOp",
            "currentOp",
            "createIndexes",
            "dropDatabase",
            "hello",
        ] {
            let mut command = Document::new();
            command.insert(family, 1);
            assert!(!can_tag(&command));
            assert!(tag(&mut command, &job).is_err());
        }
        assert!(tag(&mut doc! {"find":"x"}, "dbm-not-a-uuid").is_err());
    }
    #[test]
    fn namespace_filter_is_literal() {
        assert_eq!(namespace_pattern("a.b[1]"), "^a\\.b\\[1\\]\\.");
    }
}
