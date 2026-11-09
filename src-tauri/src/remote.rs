use crate::models::*;
use base64::Engine;
use futures_util::TryStreamExt;
use mysql_async::{prelude::Queryable, Params, Value as MyValue};
use serde_json::Value;
use std::{collections::BTreeMap, error::Error};
use tokio_postgres::types::{Format, FromSql, IsNull, ToSql, Type};

#[derive(Debug)]
struct Raw(Vec<u8>);
impl<'a> FromSql<'a> for Raw {
    fn from_sql(_: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn Error + Sync + Send>> {
        Ok(Self(raw.to_vec()))
    }
    fn accepts(_: &Type) -> bool {
        true
    }
}
#[derive(Debug)]
pub struct PgParam(pub Option<String>);
impl ToSql for PgParam {
    fn to_sql(
        &self,
        _: &Type,
        out: &mut bytes::BytesMut,
    ) -> Result<IsNull, Box<dyn Error + Sync + Send>> {
        match &self.0 {
            Some(v) => {
                out.extend_from_slice(v.as_bytes());
                Ok(IsNull::No)
            }
            None => Ok(IsNull::Yes),
        }
    }
    fn accepts(_: &Type) -> bool {
        true
    }
    fn encode_format(&self, _: &Type) -> Format {
        Format::Text
    }
    tokio_postgres::types::to_sql_checked!();
}
pub fn split_sql(sql: &str) -> Result<Vec<String>, String> {
    let chars: Vec<char> = sql.chars().collect();
    let mut i = 0;
    let mut start = 0;
    let mut quote = None;
    let mut dollar: Option<String> = None;
    let mut line = false;
    let mut block = 0;
    let mut out = Vec::new();
    while i < chars.len() {
        let c = chars[i];
        let n = chars.get(i + 1).copied().unwrap_or('\0');
        if line {
            if c == '\n' {
                line = false
            }
            i += 1;
            continue;
        }
        if block > 0 {
            if c == '/' && n == '*' {
                block += 1;
                i += 2
            } else if c == '*' && n == '/' {
                block -= 1;
                i += 2
            } else {
                i += 1
            }
            continue;
        }
        if let Some(ref tag) = dollar {
            let t: Vec<char> = tag.chars().collect();
            if chars[i..].starts_with(&t) {
                i += t.len();
                dollar = None
            } else {
                i += 1
            }
            continue;
        }
        if let Some(q) = quote {
            if c == q {
                if n == q {
                    i += 2;
                    continue;
                } else {
                    quote = None
                }
            } else if c == '\\' && q == '\'' {
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if c == '-' && n == '-' {
            line = true;
            i += 2;
            continue;
        }
        if c == '/' && n == '*' {
            block = 1;
            i += 2;
            continue;
        }
        if ['\'', '"', '`'].contains(&c) {
            quote = Some(c);
            i += 1;
            continue;
        }
        if c == '$' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1
            }
            if j < chars.len() && chars[j] == '$' {
                dollar = Some(chars[i..=j].iter().collect());
                i = j + 1;
                continue;
            }
        }
        if c == ';' {
            let s: String = chars[start..i].iter().collect();
            if !s.trim().is_empty() {
                out.push(s)
            }
            start = i + 1
        }
        i += 1;
    }
    if quote.is_some() || dollar.is_some() || block > 0 {
        return Err("Stringa o commento SQL non terminato.".into());
    }
    let s: String = chars[start..].iter().collect();
    if !s.trim().is_empty() {
        out.push(s)
    }
    Ok(out)
}
pub fn first_keyword(mut sql: &str) -> String {
    loop {
        sql = sql.trim_start();
        if let Some(rest) = sql.strip_prefix("--") {
            sql = rest.split_once('\n').map(|(_, r)| r).unwrap_or("");
            continue;
        }
        if let Some(rest) = sql.strip_prefix("/*") {
            let mut depth = 1;
            let b = rest.as_bytes();
            let mut i = 0;
            while i + 1 < b.len() {
                if &b[i..i + 2] == b"/*" {
                    depth += 1;
                    i += 2
                } else if &b[i..i + 2] == b"*/" {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1
                }
            }
            if depth != 0 {
                return String::new();
            }
            sql = &rest[i..];
            continue;
        }
        break;
    }
    sql.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_uppercase()
}
fn numeric(raw: &[u8]) -> Option<String> {
    if raw.len() < 8 {
        return None;
    }
    let short = |i| i16::from_be_bytes([raw[i], raw[i + 1]]);
    let n = short(0) as usize;
    let weight = short(2) as i32;
    let sign = short(4) as u16;
    let scale = short(6) as usize;
    if sign == 0xc000 {
        return Some("NaN".into());
    }
    if sign == 0xd000 {
        return Some("Infinity".into());
    }
    if sign == 0xf000 {
        return Some("-Infinity".into());
    }
    if raw.len() != 8 + n * 2 {
        return None;
    }
    let digit = |pos: i32| {
        let idx = weight - pos;
        if idx >= 0 && (idx as usize) < n {
            short(8 + idx as usize * 2) as u16
        } else {
            0
        }
    };
    let mut s = String::new();
    if sign == 0x4000 {
        s.push('-')
    }
    if weight < 0 {
        s.push('0')
    } else {
        for p in (0..=weight).rev() {
            if p == weight {
                s.push_str(&digit(p).to_string())
            } else {
                s.push_str(&format!("{:04}", digit(p)))
            }
        }
    }
    if scale > 0 {
        s.push('.');
        let mut fraction = String::new();
        for p in 1..=((scale + 3) / 4) {
            fraction.push_str(&format!("{:04}", digit(-(p as i32))))
        }
        s.push_str(&fraction[..scale]);
    }
    Some(s)
}
fn pg_cell(row: &tokio_postgres::Row, index: usize) -> Result<CellValue, String> {
    let typ = row.columns()[index].type_();
    let value = row
        .try_get::<_, Option<Raw>>(index)
        .map_err(|e| e.to_string())?;
    let Some(Raw(b)) = value else {
        return Ok(CellValue::null());
    };
    Ok(match *typ {
        Type::BOOL => CellValue::boolean(b[0] != 0),
        Type::INT2 => CellValue::string("integer", i16::from_be_bytes(b[..2].try_into().unwrap())),
        Type::INT4 => CellValue::string("integer", i32::from_be_bytes(b[..4].try_into().unwrap())),
        Type::INT8 => CellValue::string("integer", i64::from_be_bytes(b[..8].try_into().unwrap())),
        Type::FLOAT4 => CellValue::string("float", f32::from_be_bytes(b[..4].try_into().unwrap())),
        Type::FLOAT8 => CellValue::string("float", f64::from_be_bytes(b[..8].try_into().unwrap())),
        Type::NUMERIC => CellValue::string(
            "decimal",
            numeric(&b).ok_or("NUMERIC PostgreSQL non valido")?,
        ),
        Type::BYTEA => CellValue::string(
            "binary",
            base64::engine::general_purpose::STANDARD.encode(b),
        ),
        Type::JSON => CellValue::string("json", String::from_utf8_lossy(&b)),
        Type::JSONB => CellValue::string("json", String::from_utf8_lossy(&b[1..])),
        Type::UUID => CellValue::string(
            "text",
            uuid::Uuid::from_slice(&b).map_err(|e| e.to_string())?,
        ),
        Type::TIMESTAMP | Type::TIMESTAMPTZ => {
            let micros = i64::from_be_bytes(b[..8].try_into().unwrap());
            let epoch = chrono::NaiveDate::from_ymd_opt(2000, 1, 1)
                .unwrap()
                .and_hms_opt(0, 0, 0)
                .unwrap();
            match epoch.checked_add_signed(chrono::Duration::microseconds(micros)) {
                Some(d) => CellValue::string(
                    "datetime",
                    if *typ == Type::TIMESTAMPTZ {
                        format!("{}Z", d.format("%Y-%m-%dT%H:%M:%S%.f"))
                    } else {
                        d.to_string()
                    },
                ),
                None => CellValue::string(
                    "datetime",
                    if micros > 0 { "infinity" } else { "-infinity" },
                ),
            }
        }
        Type::DATE => {
            let days = i32::from_be_bytes(b[..4].try_into().unwrap());
            let d = chrono::NaiveDate::from_ymd_opt(2000, 1, 1)
                .unwrap()
                .checked_add_signed(chrono::Duration::days(days as i64));
            CellValue::string(
                "datetime",
                d.map(|x| x.to_string()).unwrap_or_else(|| {
                    if days > 0 {
                        "infinity".into()
                    } else {
                        "-infinity".into()
                    }
                }),
            )
        }
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::UNKNOWN => {
            CellValue::string("text", String::from_utf8_lossy(&b))
        }
        _ => match String::from_utf8(b.clone()) {
            Ok(s) if !s.contains('\0') => CellValue::string("text", s),
            _ => CellValue::string(
                "binary",
                base64::engine::general_purpose::STANDARD.encode(b),
            ),
        },
    })
}
pub async fn postgres_query(
    client: &tokio_postgres::Client,
    sql: &str,
    params: &BTreeMap<String, Value>,
) -> Result<QueryResult, String> {
    let mut result = QueryResult::default();
    let mut total_rows = 0;
    for statement in split_sql(sql)? {
        let prepared = client
            .prepare(&statement)
            .await
            .map_err(|e| e.to_string())?;
        let values = prepared
            .params()
            .iter()
            .enumerate()
            .map(|(i, _)| {
                let v = params
                    .get(&(i + 1).to_string())
                    .ok_or_else(|| format!("Parametro ${} mancante", i + 1))?;
                Ok(PgParam(if v.is_null() {
                    None
                } else if v.get("type").is_some() {
                    let c: CellValue =
                        serde_json::from_value(v.clone()).map_err(|e| e.to_string())?;
                    if c.kind == "null" {
                        None
                    } else {
                        Some(c.text())
                    }
                } else {
                    Some(
                        v.as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| v.to_string()),
                    )
                }))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let refs = values
            .iter()
            .map(|v| v as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let stream = client
            .query_raw(&prepared, refs)
            .await
            .map_err(|e| e.to_string())?;
        futures_util::pin_mut!(stream);
        let mut set = ResultSet {
            columns: prepared
                .columns()
                .iter()
                .map(|c| column(c.name(), c.type_().name()))
                .collect(),
            ..Default::default()
        };
        unique_column_names(&mut set.columns);
        while let Some(row) = stream.try_next().await.map_err(|e| e.to_string())? {
            if total_rows >= crate::sqlite::MAX_ROWS {
                set.truncated = true;
                continue;
            }
            total_rows += 1;
            let mut record = BTreeMap::new();
            for (i, col) in set.columns.iter().enumerate() {
                record.insert(col.name.clone(), pg_cell(&row, i)?);
            }
            set.rows.push(record)
        }
        if set.columns.is_empty() {
            result.affected_rows += stream.rows_affected().unwrap_or(0)
        } else {
            result.sets.push(set)
        }
    }
    Ok(result)
}
pub fn mysql_cell(v: &MyValue, typ: mysql_async::consts::ColumnType) -> CellValue {
    use mysql_async::consts::ColumnType::*;
    match v {
        MyValue::NULL => CellValue::null(),
        MyValue::Int(v) => CellValue::string("integer", v),
        MyValue::UInt(v) => CellValue::string("integer", v),
        MyValue::Float(v) => CellValue::string("float", v),
        MyValue::Double(v) => CellValue::string("float", v),
        MyValue::Bytes(b) => {
            if matches!(typ, MYSQL_TYPE_DECIMAL | MYSQL_TYPE_NEWDECIMAL) {
                CellValue::string("decimal", String::from_utf8_lossy(b))
            } else if matches!(typ, MYSQL_TYPE_JSON) {
                CellValue::string("json", String::from_utf8_lossy(b))
            } else {
                match String::from_utf8(b.clone()) {
                    Ok(s) => CellValue::string("text", s),
                    Err(_) => CellValue::string(
                        "binary",
                        base64::engine::general_purpose::STANDARD.encode(b),
                    ),
                }
            }
        }
        MyValue::Date(y, m, d, h, min, s, micro) => CellValue::string(
            "datetime",
            format!("{y:04}-{m:02}-{d:02} {h:02}:{min:02}:{s:02}.{micro:06}"),
        ),
        MyValue::Time(neg, days, h, m, s, micro) => CellValue::string(
            "datetime",
            format!(
                "{}{days}d {h:02}:{m:02}:{s:02}.{micro:06}",
                if *neg { "-" } else { "" }
            ),
        ),
    }
}
pub fn mysql_typed_cell(v: &MyValue, c: &mysql_async::Column) -> CellValue {
    use mysql_async::consts::ColumnType::*;
    if c.character_set() == 63
        && matches!(
            c.column_type(),
            MYSQL_TYPE_BLOB
                | MYSQL_TYPE_TINY_BLOB
                | MYSQL_TYPE_MEDIUM_BLOB
                | MYSQL_TYPE_LONG_BLOB
                | MYSQL_TYPE_STRING
                | MYSQL_TYPE_VAR_STRING
                | MYSQL_TYPE_VARCHAR
                | MYSQL_TYPE_BIT
        )
    {
        if let MyValue::Bytes(b) = v {
            return CellValue::string(
                "binary",
                base64::engine::general_purpose::STANDARD.encode(b),
            );
        }
    }
    mysql_cell(v, c.column_type())
}
pub fn mysql_param(v: &Value) -> Result<MyValue, String> {
    let c: CellValue = if v.get("type").is_some() {
        serde_json::from_value(v.clone()).map_err(|e| e.to_string())?
    } else {
        match v {
            Value::Null => CellValue::null(),
            Value::Bool(b) => CellValue::boolean(*b),
            Value::Number(n) => CellValue::string(
                if n.is_i64() || n.is_u64() {
                    "integer"
                } else {
                    "float"
                },
                n,
            ),
            Value::String(s) => CellValue::string("text", s),
            _ => CellValue::string("json", v),
        }
    };
    Ok(match c.kind.as_str() {
        "null" => MyValue::NULL,
        "integer" => {
            if let Ok(n) = c.text().parse::<i64>() {
                MyValue::Int(n)
            } else {
                MyValue::UInt(c.text().parse().map_err(|_| "Intero non valido")?)
            }
        }
        "boolean" => MyValue::Int((c.text() == "true") as i64),
        "binary" => MyValue::Bytes(
            base64::engine::general_purpose::STANDARD
                .decode(c.text())
                .map_err(|e| e.to_string())?,
        ),
        _ => MyValue::Bytes(c.text().into_bytes()),
    })
}
pub async fn mysql_query(
    conn: &mut mysql_async::Conn,
    sql: &str,
    params: &BTreeMap<String, Value>,
) -> Result<QueryResult, String> {
    let mut out = QueryResult::default();
    let mut total_rows = 0;
    // Named parameters are interpreted by the driver, never interpolated into SQL.
    if !params.is_empty() {
        let named = params
            .iter()
            .map(|(k, v)| Ok((k.as_bytes().to_vec(), mysql_param(v)?)))
            .collect::<Result<std::collections::HashMap<_, _>, String>>()?;
        let mut res = conn
            .exec_iter(sql, Params::Named(named))
            .await
            .map_err(|e| e.to_string())?;
        loop {
            let cols = res.columns().map(|v| v.to_vec()).unwrap_or_default();
            if cols.is_empty() {
                out.affected_rows += res.affected_rows();
            }
            let mut set = ResultSet {
                columns: cols
                    .iter()
                    .map(|c| column(c.name_str(), format!("{:?}", c.column_type())))
                    .collect(),
                ..Default::default()
            };
            unique_column_names(&mut set.columns);
            while let Some(row) = res.next().await.map_err(|e| e.to_string())? {
                if total_rows >= crate::sqlite::MAX_ROWS {
                    set.truncated = true;
                    continue;
                }
                total_rows += 1;
                let mut data = BTreeMap::new();
                for (i, c) in cols.iter().enumerate() {
                    data.insert(
                        set.columns[i].name.clone(),
                        mysql_typed_cell(row.as_ref(i).unwrap_or(&MyValue::NULL), c),
                    );
                }
                set.rows.push(data)
            }
            if !set.columns.is_empty() {
                out.sets.push(set)
            }
            if res.is_empty() {
                break;
            }
        }
        return Ok(out);
    }
    let mut res = conn.query_iter(sql).await.map_err(|e| e.to_string())?;
    loop {
        let cols = res.columns().map(|v| v.to_vec()).unwrap_or_default();
        if cols.is_empty() {
            out.affected_rows += res.affected_rows()
        }
        let mut set = ResultSet {
            columns: cols
                .iter()
                .map(|c| column(c.name_str(), format!("{:?}", c.column_type())))
                .collect(),
            ..Default::default()
        };
        unique_column_names(&mut set.columns);
        while let Some(row) = res.next().await.map_err(|e| e.to_string())? {
            if total_rows >= crate::sqlite::MAX_ROWS {
                set.truncated = true;
                continue;
            }
            total_rows += 1;
            let mut data = BTreeMap::new();
            for (i, c) in cols.iter().enumerate() {
                data.insert(
                    set.columns[i].name.clone(),
                    mysql_typed_cell(row.as_ref(i).unwrap_or(&MyValue::NULL), c),
                );
            }
            set.rows.push(data)
        }
        if !set.columns.is_empty() {
            out.sets.push(set)
        }
        if res.is_empty() {
            break;
        }
    }
    Ok(out)
}
pub fn bson_document(v: Value) -> Result<mongodb::bson::Document, String> {
    let b = mongodb::bson::Bson::try_from(v).map_err(|e| e.to_string())?;
    b.as_document()
        .cloned()
        .ok_or("Occorre un documento JSON.".into())
}
pub fn bson_cell(v: &mongodb::bson::Bson) -> CellValue {
    use mongodb::bson::Bson::*;
    match v {
        Null => CellValue::null(),
        String(s) => CellValue::string("text", s),
        Int32(n) => CellValue::string("integer", n).with_native("int32"),
        Int64(n) => CellValue::string("integer", n).with_native("int64"),
        Double(n) => CellValue::string("float", n),
        Boolean(b) => CellValue::boolean(*b),
        Decimal128(n) => CellValue::string("decimal", n),
        DateTime(d) => CellValue::string("json", DateTime(*d).into_canonical_extjson()),
        ObjectId(_) | Binary(_) | Document(_) | Array(_) | Timestamp(_) | RegularExpression(_) => {
            CellValue::string("json", v.clone().into_canonical_extjson())
        }
        _ => CellValue::string("json", v.clone().into_canonical_extjson()),
    }
}
pub fn documents_result(docs: Vec<mongodb::bson::Document>, truncated: bool) -> QueryResult {
    let mut cols = BTreeMap::new();
    let rows = docs
        .into_iter()
        .map(|doc| {
            doc.into_iter()
                .map(|(k, v)| {
                    let c = bson_cell(&v);
                    cols.entry(k.clone()).or_insert_with(|| {
                        let mut col = column(&k, &c.kind);
                        col.primary_key = k == "_id";
                        col
                    });
                    (k, c)
                })
                .collect()
        })
        .collect();
    QueryResult {
        sets: vec![ResultSet {
            columns: cols.into_values().collect(),
            rows,
            truncated,
            ..Default::default()
        }],
        ..Default::default()
    }
}
pub async fn mongo_query(
    db: &mongodb::Database,
    query: &str,
    read_only: bool,
    job: Option<&str>,
) -> Result<QueryResult, String> {
    let value: Value = serde_json::from_str(query).map_err(|e| {
        format!(
            "Usa comandi Extended JSON, ad esempio {{\"find\":\"clienti\",\"filter\":{{}}}}. {e}"
        )
    })?;
    let mut command = bson_document(value)?;
    if let Some(job) = job {
        if crate::mongo_cancel::can_tag(&command) {
            crate::mongo_cancel::tag(&mut command, job)?;
        }
    }
    if ["find", "aggregate", "count", "distinct"]
        .iter()
        .any(|name| command.contains_key(*name))
        && !command.contains_key("maxTimeMS")
    {
        command.insert("maxTimeMS", 60000_i64);
    }
    if read_only
        && !command
            .keys()
            .next()
            .map(|k| {
                [
                    "find",
                    "aggregate",
                    "count",
                    "distinct",
                    "explain",
                    "listCollections",
                    "listIndexes",
                    "dbStats",
                    "collStats",
                    "ping",
                ]
                .contains(&k.as_str())
            })
            .unwrap_or(false)
    {
        return Err("Comando non consentito in sola lettura.".into());
    }
    if read_only {
        if let Ok(pipeline) = command.get_array("pipeline") {
            if pipeline.iter().any(|s| {
                s.as_document()
                    .map(|d| d.contains_key("$out") || d.contains_key("$merge"))
                    .unwrap_or(false)
            }) {
                return Err("Pipeline con scrittura non consentita in sola lettura.".into());
            }
        }
    }
    let mut response = db.run_command(command).await.map_err(|e| e.to_string())?;
    if let Ok(cursor) = response.get_document("cursor").cloned() {
        let mut docs = cursor
            .get_array("firstBatch")
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_document().cloned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut id = cursor.get_i64("id").unwrap_or(0);
        let namespace = cursor.get_str("ns").unwrap_or("");
        let collection = namespace.split_once('.').map(|x| x.1).unwrap_or("");
        while id != 0 && docs.len() < crate::sqlite::MAX_ROWS {
            response = db
                .run_command({
                    let mut command =
                        mongodb::bson::doc! {"getMore":id,"collection":collection,"batchSize":1000};
                    if let Some(job) = job {
                        crate::mongo_cancel::tag(&mut command, job)?;
                    }
                    command
                })
                .await
                .map_err(|e| e.to_string())?;
            let c = response.get_document("cursor").map_err(|e| e.to_string())?;
            if let Ok(a) = c.get_array("nextBatch") {
                docs.extend(a.iter().filter_map(|v| v.as_document().cloned()))
            }
            id = c.get_i64("id").unwrap_or(0)
        }
        let truncated = docs.len() > crate::sqlite::MAX_ROWS || id != 0;
        docs.truncate(crate::sqlite::MAX_ROWS);
        if id != 0 {
            let _ = db
                .run_command(mongodb::bson::doc! {"killCursors":collection,"cursors":[id]})
                .await;
        }
        return Ok(documents_result(docs, truncated));
    }
    if let Ok(errors) = response.get_array("writeErrors") {
        if !errors.is_empty() {
            return Err(format!(
                "Scrittura MongoDB non riuscita: {}",
                mongodb::bson::Bson::Array(errors.clone()).into_canonical_extjson()
            ));
        }
    }
    if let Ok(error) = response.get_document("writeConcernError") {
        return Err(format!("Esito scrittura da verificare: {error}"));
    }
    let number = |name: &str| match response.get(name) {
        Some(mongodb::bson::Bson::Int32(n)) => Some(*n as u64),
        Some(mongodb::bson::Bson::Int64(n)) => Some(*n as u64),
        _ => None,
    };
    let affected = number("nModified").or_else(|| number("n")).unwrap_or(0);
    let mut out = documents_result(vec![response], false);
    out.affected_rows = affected;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn splits_quoted_dollar_and_comments() {
        let q = "SELECT ';'; -- ;\n SELECT $$a;b$$; /* ; */ SELECT 3";
        assert_eq!(split_sql(q).unwrap().len(), 3);
        assert!(split_sql("SELECT 'open").is_err());
    }
    #[test]
    fn decimal_preserves_scale() {
        assert_eq!(
            numeric(&[0, 2, 0, 0, 0, 0, 0, 4, 0, 1, 0, 2]).unwrap(),
            "1.0002"
        );
    }
    #[test]
    fn mongo_extended_json_preserves_int64() {
        let d = bson_document(serde_json::json!({"x":{"$numberLong":"9007199254740993"}})).unwrap();
        assert_eq!(d.get_i64("x").unwrap(), 9007199254740993);
    }
}
