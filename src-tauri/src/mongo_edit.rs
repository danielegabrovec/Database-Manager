use crate::models::*;
use mongodb::{
    bson::{self, doc, Bson, Document},
    ClientSession, Database,
};
use std::time::Instant;

fn value(cell: &CellValue, original: Option<&CellValue>) -> Result<Bson, String> {
    Ok(match cell.kind.as_str() {
        "null" => Bson::Null,
        "integer" => {
            if cell
                .native_type
                .as_deref()
                .or(original.and_then(|v| v.native_type.as_deref()))
                == Some("int32")
            {
                Bson::Int32(
                    cell.text()
                        .parse()
                        .map_err(|_| "Il valore supera l'intervallo Int32")?,
                )
            } else {
                Bson::Int64(cell.text().parse().map_err(|_| "Intero Int64 non valido")?)
            }
        }
        "boolean" => Bson::Boolean(cell.text() == "true"),
        "float" => Bson::Double(cell.text().parse().map_err(|_| "Numero non valido")?),
        "decimal" => Bson::Decimal128(cell.text().parse().map_err(|_| "Decimal128 non valido")?),
        "datetime" => Bson::DateTime(
            bson::DateTime::parse_rfc3339_str(cell.text()).map_err(|e| e.to_string())?,
        ),
        "json" => Bson::try_from(
            serde_json::from_str::<serde_json::Value>(&cell.text()).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?,
        "binary" => {
            use base64::Engine;
            Bson::Binary(bson::Binary {
                subtype: bson::spec::BinarySubtype::Generic,
                bytes: base64::engine::general_purpose::STANDARD
                    .decode(cell.text())
                    .map_err(|e| e.to_string())?,
            })
        }
        _ => Bson::String(cell.text()),
    })
}
fn document(row: &DataRow, original: &DataRow) -> Result<Document, String> {
    row.iter()
        .map(|(k, v)| Ok((k.clone(), value(v, original.get(k))?)))
        .collect()
}
fn type_name(v: &Bson) -> &'static str {
    match v {
        Bson::Null => "null",
        Bson::Int32(_) => "int",
        Bson::Int64(_) => "long",
        Bson::Double(_) => "double",
        Bson::Decimal128(_) => "decimal",
        Bson::Boolean(_) => "bool",
        Bson::String(_) => "string",
        Bson::Array(_) => "array",
        Bson::Document(_) => "object",
        Bson::ObjectId(_) => "objectId",
        Bson::DateTime(_) => "date",
        Bson::Binary(_) => "binData",
        Bson::Timestamp(_) => "timestamp",
        Bson::RegularExpression(_) => "regex",
        Bson::JavaScriptCode(_) => "javascript",
        Bson::JavaScriptCodeWithScope(_) => "javascriptWithScope",
        Bson::Symbol(_) => "symbol",
        Bson::Undefined => "undefined",
        Bson::MinKey => "minKey",
        Bson::MaxKey => "maxKey",
        _ => "object",
    }
}
fn field(name: &str) -> Bson {
    Bson::Document(doc! {"$getField":{"field":{"$literal":name},"input":"$$ROOT"}})
}
fn filter(change: &DataChange) -> Result<Document, String> {
    if !change.key.contains_key("_id") {
        return Err("Documento senza identità _id stabile".into());
    }
    let mut snapshot = change.original.clone();
    snapshot.extend(change.key.clone());
    let mut conditions = Vec::new();
    for (k, v) in &snapshot {
        let v = value(v, None)?;
        conditions.push(Bson::Document(
            doc! {"$eq":[doc!{"$type":field(k)},type_name(&v)]},
        ));
        conditions.push(Bson::Document(doc! {"$eq":[field(k),doc!{"$literal":v}]}));
    }
    for k in change.values.keys().filter(|k| !snapshot.contains_key(*k)) {
        conditions.push(Bson::Document(
            doc! {"$eq":[doc!{"$type":field(k)},"missing"]},
        ));
    }
    Ok(doc! {"$expr":{"$and":conditions}})
}
async fn apply_one(
    db: &Database,
    table: &str,
    change: &DataChange,
    session: Option<&mut ClientSession>,
) -> Result<u64, String> {
    let collection = db.collection::<Document>(table);
    match change.kind.as_str() {
        "insert" => {
            let doc = document(&change.values, &DataRow::new())?;
            let action = collection.insert_one(doc);
            if let Some(session) = session {
                action.session(session).await
            } else {
                action.await
            }
            .map_err(|e| e.to_string())?;
            Ok(1)
        }
        "update" => {
            if change.values.is_empty() {
                return Ok(0);
            }
            let predicate = filter(change)?;
            let action = collection.update_one(
                predicate,
                doc! {"$set":document(&change.values,&change.original)?},
            );
            let result = if let Some(session) = session {
                action.session(session).await
            } else {
                action.await
            }
            .map_err(|e| e.to_string())?;
            if result.matched_count != 1 {
                return Err(
                    "Conflitto: il documento è stato modificato o eliminato; ricarica i dati."
                        .into(),
                );
            }
            Ok(result.modified_count)
        }
        "delete" => {
            let predicate = filter(change)?;
            let action = collection.delete_one(predicate);
            let result = if let Some(session) = session {
                action.session(session).await
            } else {
                action.await
            }
            .map_err(|e| e.to_string())?;
            if result.deleted_count != 1 {
                return Err(
                    "Conflitto: il documento è stato modificato o eliminato; ricarica i dati."
                        .into(),
                );
            }
            Ok(result.deleted_count)
        }
        _ => Err("Operazione MongoDB non riconosciuta".into()),
    }
}
pub async fn apply(
    db: &Database,
    table: &str,
    changes: Vec<DataChange>,
) -> Result<QueryResult, String> {
    let started = Instant::now();
    let hello = db
        .run_command(doc! {"hello":1})
        .await
        .map_err(|e| e.to_string())?;
    let transactional = hello.contains_key("setName") || hello.get_str("msg") == Ok("isdbgrid");
    let mut session = if transactional {
        let mut session = db
            .client()
            .start_session()
            .await
            .map_err(|e| e.to_string())?;
        session
            .start_transaction()
            .await
            .map_err(|e| e.to_string())?;
        Some(session)
    } else {
        None
    };
    let mut affected = 0;
    for change in changes {
        match apply_one(db, table, &change, session.as_mut()).await {
            Ok(n) => affected += n,
            Err(error) => {
                if let Some(session) = session.as_mut() {
                    let _ = session.abort_transaction().await;
                    return Err(error);
                }
                return Err(format!("{error} · Server standalone: {affected} modifiche precedenti potrebbero essere già applicate."));
            }
        }
    }
    if let Some(session) = session.as_mut() {
        session
            .commit_transaction()
            .await
            .map_err(|e| format!("Esito transazione MongoDB da verificare: {e}"))?;
    }
    Ok(QueryResult {
        affected_rows: affected,
        elapsed_ms: started.elapsed().as_millis() as u64,
        message: format!(
            "{affected} modifiche applicate{}",
            if transactional {
                " in transazione"
            } else {
                " (atomicità per documento)"
            }
        ),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn edits_preserve_int32_width() {
        let old = CellValue::string("integer", 12).with_native("int32");
        let changed = CellValue::string("integer", 20);
        assert!(matches!(
            value(&changed, Some(&old)).unwrap(),
            Bson::Int32(20)
        ));
    }
    #[test]
    fn snapshot_filter_distinguishes_missing_null_and_arrays() {
        let change = DataChange {
            kind: "update".into(),
            key: DataRow::from([(
                "_id".into(),
                CellValue::string("integer", 1).with_native("int32"),
            )]),
            original: DataRow::from([("value".into(), CellValue::null())]),
            values: DataRow::from([("new".into(), CellValue::string("text", "x"))]),
        };
        let json = Bson::Document(filter(&change).unwrap())
            .into_canonical_extjson()
            .to_string();
        assert!(json.contains("missing"));
        assert!(json.contains("$type"));
        assert!(json.contains("$getField"));
    }
}
