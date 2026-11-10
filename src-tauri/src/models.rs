use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SshConfig {
    pub enabled: bool,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub key_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub file_path: String,
    pub environment: String,
    pub read_only: bool,
    pub tls: bool,
    pub ca_path: String,
    pub ssh: Option<SshConfig>,
    pub laboratory: bool,
    #[serde(default)]
    pub create_if_missing: bool,
}
impl Default for ConnectionProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            engine: "sqlite".into(),
            host: "127.0.0.1".into(),
            port: 0,
            database: String::new(),
            username: String::new(),
            file_path: String::new(),
            environment: "Locale".into(),
            read_only: false,
            tls: false,
            ca_path: String::new(),
            ssh: None,
            laboratory: false,
            create_if_missing: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub data_type: String,
    pub nullable: bool,
    pub primary_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    #[serde(default)]
    pub partial: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyInfo {
    pub column: String,
    pub referenced_table: String,
    pub referenced_column: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub schema: Option<String>,
    pub kind: String,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
    pub row_count: Option<u64>,
    #[serde(default)]
    pub definition: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SchemaSnapshot {
    pub database: String,
    pub engine: String,
    pub tables: Vec<TableInfo>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CellValue {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(
        rename = "nativeType",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub native_type: Option<String>,
}
impl CellValue {
    pub fn null() -> Self {
        Self {
            kind: "null".into(),
            value: None,
            native_type: None,
        }
    }
    pub fn string(kind: &str, value: impl ToString) -> Self {
        Self {
            kind: kind.into(),
            value: Some(Value::String(value.to_string())),
            native_type: None,
        }
    }
    pub fn boolean(value: bool) -> Self {
        Self {
            kind: "boolean".into(),
            value: Some(Value::Bool(value)),
            native_type: None,
        }
    }
    pub fn text(&self) -> String {
        match &self.value {
            None => String::new(),
            Some(Value::String(s)) => s.clone(),
            Some(v) => v.to_string(),
        }
    }
    pub fn with_native(mut self, name: &str) -> Self {
        self.native_type = Some(name.into());
        self
    }
}
pub type DataRow = BTreeMap<String, CellValue>;
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResultSet {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<DataRow>,
    pub table: Option<String>,
    pub truncated: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub sets: Vec<ResultSet>,
    pub elapsed_ms: u64,
    pub affected_rows: u64,
    pub message: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataChange {
    pub kind: String,
    #[serde(default)]
    pub key: DataRow,
    #[serde(default)]
    pub original: DataRow,
    #[serde(default)]
    pub values: DataRow,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub query: String,
    pub engine: String,
    pub favorite: bool,
    pub parameters: BTreeMap<String, Value>,
    pub execution_mode: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub query: String,
    pub engine: String,
    pub profile_name: String,
    pub timestamp: String,
    pub elapsed_ms: u64,
    pub success: bool,
    pub error: Option<String>,
}

pub fn quote_ident(engine: &str, name: &str) -> String {
    if engine == "mysql" || engine == "mariadb" {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}
pub fn column(name: impl Into<String>, data_type: impl Into<String>) -> ColumnInfo {
    ColumnInfo {
        name: name.into(),
        data_type: data_type.into(),
        nullable: true,
        primary_key: false,
        default_value: None,
    }
}
pub fn unique_column_names(columns: &mut [ColumnInfo]) {
    let mut names = std::collections::HashSet::new();
    for col in columns {
        let original = col.name.clone();
        let mut suffix = 2;
        while !names.insert(col.name.clone()) {
            col.name = format!("{original} ({suffix})");
            suffix += 1;
        }
    }
}
