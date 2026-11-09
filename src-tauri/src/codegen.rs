//! Deterministic, offline source generation. Generated files are never executed here.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[path = "codegen/native.rs"]
mod native;
#[path = "codegen/rest.rs"]
mod rest;
#[path = "codegen/templates.rs"]
mod templates;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeColumn {
    pub name: String,
    pub data_type: String,
    #[serde(default)]
    pub primary_key: bool,
    #[serde(default)]
    pub nullable: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub engine: String,
    pub language: String,
    pub output: String,
    pub table: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub columns: Vec<CodeColumn>,
    #[serde(default)]
    pub educational: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFile {
    pub path: String,
    pub content: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedProject {
    pub files: Vec<GeneratedFile>,
    pub command: String,
    pub notes: Vec<String>,
}
#[derive(Clone)]
pub(super) struct Context {
    pub req: GenerateRequest,
    pub table: String,
    pub columns: Vec<String>,
    pub keys: Vec<String>,
    pub nonkeys: Vec<String>,
    pub select: String,
    pub insert: String,
    pub update: String,
    pub delete: String,
    pub filter: Value,
}
pub(super) fn literal(s: &str) -> String {
    serde_json::to_string(s).expect("string serialization")
}
pub(super) fn file(path: &str, content: impl Into<String>) -> GeneratedFile {
    GeneratedFile {
        path: path.into(),
        content: content.into(),
    }
}
pub(super) fn substitute(source: &str, pairs: &[(&str, String)]) -> String {
    // Single pass: user text cannot introduce a second template expansion.
    let mut out = String::new();
    let mut rest = source;
    while let Some(start) = rest.find("@@") {
        out.push_str(&rest[..start]);
        rest = &rest[start..];
        if let Some(end) = rest[2..].find("@@") {
            let marker = &rest[..end + 4];
            if let Some((_, value)) = pairs.iter().find(|(key, _)| *key == marker) {
                out.push_str(value);
            } else {
                out.push_str(marker);
            }
            rest = &rest[end + 4..];
        } else {
            out.push_str(rest);
            return out;
        }
    }
    out.push_str(rest);
    out
}
fn identifier(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.chars().count() > 128 || value.chars().any(char::is_control)
    {
        return Err(
            "Identificatore vuoto, troppo lungo o contenente caratteri di controllo".into(),
        );
    }
    Ok(())
}
pub(super) fn quote_identifier(engine: &str, value: &str) -> String {
    if matches!(engine, "mysql" | "mariadb") {
        format!("`{}`", value.replace('`', "``"))
    } else {
        format!("\"{}\"", value.replace('"', "\"\""))
    }
}
pub(super) fn kind(data_type: &str) -> Result<&'static str, String> {
    let normalized = data_type.trim().to_lowercase();
    let base = normalized.split(['(', ' ']).next().unwrap_or("");
    Ok(match base {
        "int" | "integer" | "bigint" | "smallint" | "tinyint" | "mediumint" | "int2" | "int4" | "int8" | "int32" | "int64" | "serial" | "bigserial" | "i32" | "i64" | "long" | "numberlong" => "integer",
        "float" | "real" | "double" | "float4" | "float8" | "f32" | "f64" => "float",
        "decimal" | "numeric" | "money" | "decimal128" => "decimal",
        "boolean" | "bool" => "boolean",
        "json" | "jsonb" | "object" | "array" | "embeddeddocument" | "null" => "json",
        "date" | "datetime" | "timestamp" | "timestamptz" | "time" => "date",
        "blob" | "binary" | "varbinary" | "bytea" | "bytes" => "binary",
        "text" | "string" | "varchar" | "nvarchar" | "char" | "nchar" | "uuid" | "objectid" | "clob" | "citext" | "enum" => "text",
        _ => return Err(format!("Tipo non supportato dal generatore: {data_type}. Scegli un tipo scalare esplicito; nessuna conversione implicita viene applicata.")),
    })
}
impl Context {
    pub fn placeholders(&self, style: &str) -> Self {
        let mut result = self.clone();
        let p = |n: usize| {
            if style == "numbered" {
                format!("${n}")
            } else if style == "named" {
                format!("@p{n}")
            } else {
                style.into()
            }
        };
        let q = |s: &str| quote_identifier(&self.req.engine, s);
        let predicate = |start: usize| {
            self.keys
                .iter()
                .enumerate()
                .map(|(i, k)| format!("{} = {}", q(k), p(i + start)))
                .collect::<Vec<_>>()
                .join(" AND ")
        };
        result.insert = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            self.table,
            self.columns
                .iter()
                .map(|c| q(c))
                .collect::<Vec<_>>()
                .join(", "),
            (1..=self.columns.len())
                .map(p)
                .collect::<Vec<_>>()
                .join(", ")
        );
        if !self.update.is_empty() {
            result.update = format!(
                "UPDATE {} SET {} WHERE {}",
                self.table,
                self.nonkeys
                    .iter()
                    .enumerate()
                    .map(|(i, c)| format!("{} = {}", q(c), p(i + 1)))
                    .collect::<Vec<_>>()
                    .join(", "),
                predicate(self.nonkeys.len() + 1)
            );
        }
        if !self.delete.is_empty() {
            result.delete = format!("DELETE FROM {} WHERE {}", self.table, predicate(1));
        }
        result
    }
    pub fn pairs(&self) -> Vec<(&'static str, String)> {
        vec![
            ("@@TABLE@@", literal(&self.req.table)),
            ("@@QUERY@@", literal(&self.select)),
            ("@@INSERT@@", literal(&self.insert)),
            ("@@UPDATE@@", literal(&self.update)),
            ("@@DELETE@@", literal(&self.delete)),
            ("@@COLUMNS@@", serde_json::to_string(&self.columns).unwrap()),
            ("@@KEYS@@", serde_json::to_string(&self.keys).unwrap()),
            ("@@NONKEYS@@", serde_json::to_string(&self.nonkeys).unwrap()),
            ("@@FILTER@@", literal(&self.filter.to_string())),
            ("@@ENGINE@@", literal(&self.req.engine)),
        ]
    }
    pub fn render(&self, source: &str) -> String {
        substitute(source, &self.pairs())
    }
    pub fn url(&self) -> &'static str {
        match self.req.engine.as_str() {
            "sqlite" => "sqlite:./database.sqlite",
            "postgresql" => "postgresql://USER:PASSWORD@localhost:5432/DATABASE",
            "mongodb" => "mongodb://localhost:27017",
            _ => "mysql://USER:PASSWORD@localhost:3306/DATABASE",
        }
    }
}

pub fn generate_project(mut req: GenerateRequest) -> Result<GeneratedProject, String> {
    req.engine = req.engine.trim().to_lowercase();
    req.language = req.language.trim().to_lowercase();
    req.output = req.output.trim().to_lowercase();
    if !["sqlite", "postgresql", "mysql", "mariadb", "mongodb"].contains(&req.engine.as_str()) {
        return Err("Motore non supportato".into());
    }
    if ![
        "rust",
        "python",
        "javascript",
        "typescript",
        "php",
        "java",
        "csharp",
        "c",
        "cpp",
        "go",
        "kotlin",
        "ruby",
    ]
    .contains(&req.language.as_str())
    {
        return Err("Linguaggio non supportato".into());
    }
    if !["script", "snippet", "project", "rest"].contains(&req.output.as_str()) {
        return Err("Output non supportato".into());
    }
    identifier(&req.table)?;
    if req.columns.len() > 256 {
        return Err("Il generatore accetta al massimo 256 colonne".into());
    }
    if req.columns.is_empty() && req.engine != "mongodb" {
        req.columns = vec![
            CodeColumn {
                name: "id".into(),
                data_type: "integer".into(),
                primary_key: true,
                nullable: false,
            },
            CodeColumn {
                name: "name".into(),
                data_type: "text".into(),
                primary_key: false,
                nullable: false,
            },
        ];
    }
    let mut names = std::collections::HashSet::new();
    for column in &req.columns {
        identifier(&column.name)?;
        kind(&column.data_type)?;
        if req.output != "script"
            && req.engine != "mongodb"
            && kind(&column.data_type)? == "binary"
            && !["rust", "python", "javascript", "typescript"].contains(&req.language.as_str())
        {
            return Err(format!("Il template {} richiede un mapping binario specifico del driver per la colonna {}. Scegli Rust, Python, JavaScript/TypeScript oppure genera lo script SQL; nessun dato binario viene convertito in testo implicitamente.",req.language,column.name));
        }
        if !names.insert(column.name.clone()) {
            return Err(format!("Colonna duplicata: {}", column.name));
        }
        if column.primary_key && column.nullable {
            return Err(format!("La chiave {} non può essere nullable", column.name));
        }
    }
    let table = quote_identifier(&req.engine, &req.table);
    let columns: Vec<String> = req.columns.iter().map(|c| c.name.clone()).collect();
    let keys: Vec<String> = if req.engine == "mongodb" {
        vec!["_id".into()]
    } else {
        req.columns
            .iter()
            .filter(|c| c.primary_key)
            .map(|c| c.name.clone())
            .collect()
    };
    let nonkeys: Vec<String> = columns
        .iter()
        .filter(|c| !keys.contains(c))
        .cloned()
        .collect();
    let placeholder = |n: usize| {
        if req.engine == "postgresql" {
            format!("${n}")
        } else {
            "?".into()
        }
    };
    let where_clause = |start: usize| {
        keys.iter()
            .enumerate()
            .map(|(i, c)| {
                format!(
                    "{} = {}",
                    quote_identifier(&req.engine, c),
                    placeholder(start + i)
                )
            })
            .collect::<Vec<_>>()
            .join(" AND ")
    };
    let select = if req.query.trim().is_empty() {
        format!("SELECT * FROM {table} LIMIT 100")
    } else {
        req.query.trim().into()
    };
    let insert = format!(
        "INSERT INTO {table} ({}) VALUES ({})",
        columns
            .iter()
            .map(|c| quote_identifier(&req.engine, c))
            .collect::<Vec<_>>()
            .join(", "),
        (1..=columns.len())
            .map(placeholder)
            .collect::<Vec<_>>()
            .join(", ")
    );
    let update = if keys.is_empty() || nonkeys.is_empty() {
        String::new()
    } else {
        format!(
            "UPDATE {table} SET {} WHERE {}",
            nonkeys
                .iter()
                .enumerate()
                .map(|(i, c)| format!(
                    "{} = {}",
                    quote_identifier(&req.engine, c),
                    placeholder(i + 1)
                ))
                .collect::<Vec<_>>()
                .join(", "),
            where_clause(nonkeys.len() + 1)
        )
    };
    let delete = if keys.is_empty() {
        String::new()
    } else {
        format!("DELETE FROM {table} WHERE {}", where_clause(1))
    };
    let filter = if req.engine == "mongodb" && !req.query.trim().is_empty() {
        let value: Value = serde_json::from_str(req.query.trim())
            .map_err(|e| format!("Filtro MongoDB: usare JSON/Extended JSON valido: {e}"))?;
        if !value.is_object() {
            return Err("Il filtro MongoDB deve essere un oggetto JSON".into());
        }
        value
    } else {
        json!({})
    };
    let context = Context {
        req,
        table,
        columns,
        keys,
        nonkeys,
        select,
        insert,
        update,
        delete,
        filter,
    };
    let mut result = if context.req.output == "script" {
        script(&context)?
    } else if context.req.output == "rest" {
        rest::generate(&context)?
    } else {
        templates::generate(&context)?
    };
    if context.keys.is_empty() {
        result.notes.push("Tabella senza chiave primaria: modifica e cancellazione per record sono disabilitate; aggiungere una chiave stabile.".into());
    }
    result.notes.push("Il generatore non esegue file, non installa dipendenze e non incorpora credenziali della connessione. Gli esempi richiedono variabili d'ambiente.".into());
    if context
        .req
        .columns
        .iter()
        .any(|column| column.data_type.eq_ignore_ascii_case("null"))
    {
        result.notes.push("Un campo rilevato solo come Null non ha un tipo deducibile: il template conserva null/JSON e non inventa un tipo testo.".into());
    }
    if context.req.educational {
        result.notes.push("Valori separati dalla query con parametri; identificatori quotati per il dialetto. Una chiave primaria stabile identifica il record da aggiornare o cancellare.".into());
    }
    Ok(result)
}

fn script(ctx: &Context) -> Result<GeneratedProject, String> {
    let (path, content) = if ctx.req.engine == "mongodb" {
        ("database.mongodb.js",format!("// Eseguire con mongosh. DATABASE_NAME e DATABASE_URL sono variabili d'ambiente.\nconst target = db.getSiblingDB(process.env.DATABASE_NAME || 'database');\nconst collectionName = {};\nif (!target.getCollectionNames().includes(collectionName)) target.createCollection(collectionName);\nconst collection = target.getCollection(collectionName);\ncollection.find(EJSON.parse({})).limit(100).forEach(document => print(EJSON.stringify(document)));\n",literal(&ctx.req.table),literal(&ctx.filter.to_string())))
    } else {
        let mut defs = Vec::new();
        for col in &ctx.req.columns {
            let k = kind(&col.data_type)?;
            let ty = match (ctx.req.engine.as_str(), k) {
                ("postgresql", "integer") => "BIGINT",
                (_, "integer") => "INTEGER",
                (_, "float") => "DOUBLE PRECISION",
                (_, "decimal") => "DECIMAL(38, 10)",
                ("sqlite", "boolean") => "INTEGER",
                (_, "boolean") => "BOOLEAN",
                ("sqlite", "date") => "TEXT",
                (_, "date") => "TIMESTAMP",
                ("postgresql", "json") => "JSONB",
                ("sqlite", "json") => "TEXT",
                (_, "json") => "JSON",
                ("postgresql", "binary") => "BYTEA",
                (_, "binary") => "BLOB",
                ("mysql" | "mariadb", "text") if col.primary_key => "VARCHAR(255)",
                _ => "TEXT",
            };
            defs.push(format!(
                "  {} {ty}{}",
                quote_identifier(&ctx.req.engine, &col.name),
                if col.nullable { "" } else { " NOT NULL" }
            ));
        }
        if !ctx.keys.is_empty() {
            defs.push(format!(
                "  PRIMARY KEY ({})",
                ctx.keys
                    .iter()
                    .map(|k| quote_identifier(&ctx.req.engine, k))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        ("database.sql",format!("-- Dialetto: {}. Rivedere il DDL prima dell'esecuzione.\nCREATE TABLE {} (\n{}\n);\n\n{};\n",ctx.req.engine,ctx.table,defs.join(",\n"),ctx.select.trim_end_matches(';')))
    };
    Ok(GeneratedProject {
        files: vec![file(path, content)],
        command: if ctx.req.engine == "mongodb" {
            "mongosh \"$env:DATABASE_URL\" --file database.mongodb.js".into()
        } else {
            "Aprire database.sql nell'editor della connessione corretta".into()
        },
        notes: vec![
            "Lo script descrive lo schema richiesto; non contiene dati copiati dal database."
                .into(),
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(engine: &str, language: &str, output: &str) -> GenerateRequest {
        GenerateRequest {
            engine: engine.into(),
            language: language.into(),
            output: output.into(),
            table: "people".into(),
            query: String::new(),
            columns: vec![
                CodeColumn {
                    name: "id".into(),
                    data_type: "integer".into(),
                    primary_key: true,
                    nullable: false,
                },
                CodeColumn {
                    name: "name".into(),
                    data_type: "text".into(),
                    primary_key: false,
                    nullable: false,
                },
            ],
            educational: true,
        }
    }
    #[test]
    fn entire_catalog_generates() {
        for engine in ["sqlite", "postgresql", "mysql", "mariadb", "mongodb"] {
            for lang in [
                "rust",
                "python",
                "javascript",
                "typescript",
                "php",
                "java",
                "csharp",
                "c",
                "cpp",
                "go",
                "kotlin",
                "ruby",
            ] {
                let p = generate_project(request(engine, lang, "project"))
                    .unwrap_or_else(|e| panic!("{engine}/{lang}: {e}"));
                assert!(p.files.len() >= 3, "{engine}/{lang}");
                assert!(!p.command.is_empty());
                assert!(
                    !p.files.iter().any(|f| f.content.contains("@@")),
                    "unexpanded {engine}/{lang}"
                );
            }
            for lang in ["rust", "python", "javascript", "typescript"] {
                let p = generate_project(request(engine, lang, "rest"))
                    .unwrap_or_else(|e| panic!("REST {engine}/{lang}: {e}"));
                assert!(p
                    .files
                    .iter()
                    .any(|f| f.path.contains("server") || f.path.contains("main.rs")));
            }
        }
    }
    #[test]
    fn quotes_identifiers_and_does_not_expand_user_markers() {
        let mut r = request("postgresql", "python", "project");
        r.table = "odd\" table@@QUERY@@".into();
        let p = generate_project(r).unwrap();
        assert!(p.files.iter().any(|f| f.content.contains("odd")));
        assert!(quote_identifier("postgresql", "a\"b") == "\"a\"\"b\"");
        assert_eq!(quote_identifier("mysql", "a`b"), "`a``b`");
    }
    #[test]
    fn validates_types_duplicates_and_mongo_filter() {
        let mut r = request("sqlite", "rust", "project");
        r.columns[0].data_type = "integer); DROP TABLE x;--".into();
        assert!(generate_project(r).is_err());
        let mut r = request("mysql", "go", "project");
        r.columns[1].name = "id".into();
        assert!(generate_project(r).is_err());
        let mut r = request("mongodb", "python", "project");
        r.query = "db.x.find({})".into();
        assert!(generate_project(r).is_err());
    }
    #[test]
    fn no_embedded_connection_credentials() {
        for engine in ["sqlite", "postgresql", "mysql", "mariadb", "mongodb"] {
            let p = generate_project(request(engine, "python", "project")).unwrap();
            assert!(p.files.iter().any(|f| f.path == ".env.example"));
            assert!(p.files.iter().any(|f| f.content.contains("DATABASE_URL")));
            assert!(!p.files.iter().any(
                |f| f.content.contains("postgres:postgres") || f.content.contains("root:root")
            ));
        }
    }
    #[test]
    fn sampled_bson_types_keep_document_semantics() {
        let mut r = request("mongodb", "rust", "project");
        r.columns = vec![
            CodeColumn {
                name: "_id".into(),
                data_type: "ObjectId".into(),
                primary_key: true,
                nullable: false,
            },
            CodeColumn {
                name: "count".into(),
                data_type: "Int32".into(),
                primary_key: false,
                nullable: false,
            },
            CodeColumn {
                name: "sequence".into(),
                data_type: "Int64".into(),
                primary_key: false,
                nullable: false,
            },
            CodeColumn {
                name: "nested".into(),
                data_type: "EmbeddedDocument".into(),
                primary_key: false,
                nullable: false,
            },
            CodeColumn {
                name: "unset".into(),
                data_type: "Null".into(),
                primary_key: false,
                nullable: true,
            },
        ];
        let p = generate_project(r).unwrap();
        assert!(p
            .notes
            .iter()
            .any(|n| n.contains("non ha un tipo deducibile")));
        assert!(p
            .files
            .iter()
            .any(|f| f.content.contains("canonical_extjson")));
    }
}
