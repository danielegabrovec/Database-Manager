use crate::models::{quote_ident, CellValue, DataRow, SchemaSnapshot, TableRef};
use mongodb::bson::{doc, Bson, Document};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub struct Operation {
    table: TableRef,
    kind: Kind,
    #[serde(default)]
    filters: Vec<Filter>,
    #[serde(default)]
    values: DataRow,
}

#[derive(Clone, Copy, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Insert,
    Update,
    Delete,
}

#[derive(Deserialize)]
struct Filter {
    column: String,
    operator: String,
    value: Option<CellValue>,
}

pub struct Compiled {
    pub query: String,
    pub parameters: BTreeMap<String, Value>,
    pub digest: String,
}

impl Operation {
    pub fn compile(&self, snapshot: &SchemaSnapshot) -> Result<Compiled, String> {
        let table = self.table.resolve(snapshot)?;
        let mongo = snapshot.engine == "mongodb";
        if table.kind != if mongo { "collection" } else { "table" } {
            return Err(
                "La destinazione deve essere una tabella o collezione modificabile.".into(),
            );
        }
        if self.filters.len() > 100 || self.values.len() > 250 {
            return Err("Il grafo contiene troppi filtri o valori da scrivere.".into());
        }
        match self.kind {
            Kind::Insert if !self.filters.is_empty() => {
                return Err("Rimuovi i filtri dall’inserimento.".into())
            }
            Kind::Update | Kind::Delete if self.filters.is_empty() => {
                return Err(
                    "Aggiornamento ed eliminazione richiedono almeno un filtro esplicito.".into(),
                )
            }
            Kind::Delete if !self.values.is_empty() => {
                return Err("Un’eliminazione usa solo i filtri.".into())
            }
            Kind::Update if self.values.is_empty() => {
                return Err("Specificare i campi da aggiornare.".into())
            }
            _ => {}
        }
        let column = |name: &str| table.columns.iter().find(|column| column.name == name);
        for name in self
            .values
            .keys()
            .chain(self.filters.iter().map(|filter| &filter.column))
        {
            if mongo {
                if name.is_empty()
                    || name.chars().any(char::is_control)
                    || name
                        .split('.')
                        .any(|part| part.is_empty() || part.starts_with('$'))
                {
                    return Err(format!("Percorso MongoDB non valido: {name}"));
                }
            } else if column(name).is_none() {
                return Err(format!("Campo non presente nella destinazione: {name}"));
            }
        }
        if self.values.keys().any(|name| {
            column(name).is_some_and(|column| column.generated)
                || (mongo
                    && self.kind == Kind::Update
                    && (name == "_id" || name.starts_with("_id.")))
        }) {
            return Err(
                "Il grafo tenta di scrivere un campo generato o una chiave MongoDB immutabile."
                    .into(),
            );
        }
        for filter in &self.filters {
            match filter.operator.as_str() {
                "IS NULL" | "IS NOT NULL" if filter.value.is_none() => {}
                "=" | "!=" | ">" | ">=" | "<" | "<="
                    if filter
                        .value
                        .as_ref()
                        .is_some_and(|cell| cell.kind != "null") => {}
                _ => return Err(
                    "Operatore o valore del filtro non valido. Per NULL usa il filtro dedicato."
                        .into(),
                ),
            }
        }
        for cell in self.values.values().chain(
            self.filters
                .iter()
                .filter_map(|filter| filter.value.as_ref()),
        ) {
            if !matches!(
                cell.kind.as_str(),
                "null"
                    | "text"
                    | "integer"
                    | "decimal"
                    | "boolean"
                    | "json"
                    | "binary"
                    | "datetime"
                    | "float"
            ) || (cell.kind != "null" && cell.value.as_ref().is_none_or(|value| value.is_null()))
            {
                return Err(
                    "Valore non valido. Specifica un valore tipizzato per ogni campo.".into(),
                );
            }
        }

        let mut parameters = BTreeMap::new();
        let query = if mongo {
            mongo_command(self, &table.name)?
        } else {
            let quote = |name| quote_ident(&snapshot.engine, name);
            let target = match &table.schema {
                Some(schema) => format!("{}.{}", quote(schema), quote(&table.name)),
                None => quote(&table.name),
            };
            let mut bind = |cell: &CellValue| -> Result<String, String> {
                let number = parameters.len() + 1;
                let marker = if snapshot.engine == "postgresql" {
                    parameters.insert(
                        number.to_string(),
                        serde_json::to_value(cell).map_err(|e| e.to_string())?,
                    );
                    format!("${number}")
                } else {
                    parameters.insert(
                        format!("p{number}"),
                        serde_json::to_value(cell).map_err(|e| e.to_string())?,
                    );
                    format!(":p{number}")
                };
                Ok(marker)
            };
            if self.kind == Kind::Insert {
                if self.values.is_empty() {
                    if matches!(snapshot.engine.as_str(), "mysql" | "mariadb") {
                        format!("INSERT INTO {target} () VALUES ()")
                    } else {
                        format!("INSERT INTO {target} DEFAULT VALUES")
                    }
                } else {
                    let fields = self
                        .values
                        .keys()
                        .map(|name| quote(name))
                        .collect::<Vec<_>>()
                        .join(", ");
                    let values = self
                        .values
                        .values()
                        .map(&mut bind)
                        .collect::<Result<Vec<_>, _>>()?
                        .join(", ");
                    format!("INSERT INTO {target} ({fields}) VALUES ({values})")
                }
            } else {
                let head = if self.kind == Kind::Delete {
                    format!("DELETE FROM {target}")
                } else {
                    let fields = self
                        .values
                        .iter()
                        .map(|(name, value)| Ok(format!("{} = {}", quote(name), bind(value)?)))
                        .collect::<Result<Vec<_>, String>>()?
                        .join(", ");
                    format!("UPDATE {target} SET {fields}")
                };
                let predicates = self
                    .filters
                    .iter()
                    .map(|filter| {
                        let condition = format!("{} {}", quote(&filter.column), filter.operator);
                        match &filter.value {
                            Some(value) => Ok(format!("{condition} {}", bind(value)?)),
                            None => Ok(condition),
                        }
                    })
                    .collect::<Result<Vec<_>, String>>()?
                    .join(" AND ");
                format!("{head} WHERE {predicates}")
            }
        };
        let definition = serde_json::to_vec(&(
            &snapshot.engine,
            &snapshot.database,
            &query,
            &parameters,
            &table.definition,
            &table.mongo,
            if mongo { None } else { Some(&table.columns) },
        ))
        .map_err(|e| e.to_string())?;
        let digest = hex::encode(Sha256::digest(&definition));
        Ok(Compiled {
            query,
            parameters,
            digest,
        })
    }
}

fn mongo_command(operation: &Operation, name: &str) -> Result<String, String> {
    let data = operation
        .values
        .iter()
        .map(|(name, value)| Ok((name.clone(), crate::mongo_edit::value(value, None)?)))
        .collect::<Result<Document, String>>()?;
    let command = if operation.kind == Kind::Insert {
        if data.keys().any(|name| name.contains('.')) {
            return Err(
                "Per gli oggetti annidati in inserimento, usa un valore JSON nel campo padre."
                    .into(),
            );
        }
        doc! {"insert":name, "documents":[data]}
    } else {
        let conditions = operation
            .filters
            .iter()
            .map(|filter| {
                let mut predicate = Document::new();
                let comparison = match filter.operator.as_str() {
                    "=" => "$eq",
                    "!=" => "$ne",
                    ">" => "$gt",
                    ">=" => "$gte",
                    "<" => "$lt",
                    "<=" => "$lte",
                    "IS NULL" => "$type",
                    "IS NOT NULL" => "$ne",
                    _ => return Err("Operatore MongoDB non valido.".into()),
                };
                predicate.insert(
                    comparison,
                    match &filter.value {
                        Some(value) => crate::mongo_edit::value(value, None)?,
                        None if filter.operator == "IS NULL" => Bson::String("null".into()),
                        None => Bson::Null,
                    },
                );
                Ok(Bson::Document(Document::from_iter([(
                    filter.column.clone(),
                    Bson::Document(predicate),
                )])))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let condition = doc! {"$and":conditions};
        if operation.kind == Kind::Update {
            doc! {"update":name, "updates":[{"q":condition,"u":{"$set":data},"multi":true}]}
        } else {
            doc! {"delete":name, "deletes":[{"q":condition,"limit":0}]}
        }
    };
    Ok(Bson::Document(command).into_canonical_extjson().to_string())
}
