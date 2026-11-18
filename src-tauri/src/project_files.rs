//! Deterministic application packages. Generation and export never execute their contents.
use crate::{
    codegen::{GeneratedFile, GeneratedProject},
    codegen_workbench::{generate_workbench, WorkbenchRequest, LANGUAGES},
    graph_write,
    models::{quote_ident, DataRow, SchemaSnapshot, TableInfo, TableRef},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    path::{Component, Path, PathBuf},
};

const MANIFEST: &str = "database-manager-project.json";

#[derive(Deserialize)]
pub(crate) struct PackageRequest {
    language: String,
    project: Value,
    databases: Vec<DatabasePlan>,
}

#[derive(Deserialize)]
struct DatabasePlan {
    id: String,
    name: String,
    engine: String,
    schema: SchemaSnapshot,
    ddl: String,
    #[serde(default)]
    seed: Vec<SeedRow>,
    #[serde(default)]
    operations: Vec<OperationPlan>,
    migration: Option<MigrationPlan>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationPlan {
    baseline: SchemaSnapshot,
    sql: String,
    blockers: Vec<String>,
    warnings: Vec<String>,
    rebuild_sqlite: bool,
    changes: Vec<MigrationChange>,
}

#[derive(Deserialize)]
struct MigrationChange {
    label: String,
    destructive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationFile {
    database_id: String,
    database_name: String,
    status: &'static str,
    script_path: Option<String>,
    guide_path: String,
    baseline_path: String,
    baseline_sha256: String,
    destructive: bool,
}

#[derive(Clone, Deserialize, Serialize)]
struct ObjectRef {
    name: String,
    schema: Option<String>,
}
impl ObjectRef {
    fn resolve<'a>(&self, schema: &'a SchemaSnapshot) -> Result<&'a TableInfo, String> {
        TableRef::Qualified {
            name: self.name.clone(),
            schema: self.schema.clone(),
        }
        .resolve(schema)
    }
}

#[derive(Deserialize)]
struct SeedRow {
    table: ObjectRef,
    values: DataRow,
}

#[derive(Deserialize)]
struct OperationPlan {
    id: String,
    name: String,
    table: ObjectRef,
    plan: GraphPlan,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum GraphPlan {
    Read {
        query: String,
        params: BTreeMap<String, Value>,
    },
    Write {
        operation: graph_write::Operation,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationFile {
    id: String,
    name: String,
    database_id: String,
    database_name: String,
    table: ObjectRef,
    source_path: Option<String>,
    query_path: String,
    parameters_path: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct ApplicationPackage {
    #[serde(flatten)]
    project: GeneratedProject,
    operations: Vec<OperationFile>,
    migrations: Vec<MigrationFile>,
}

fn file(path: impl Into<String>, content: impl Into<String>) -> GeneratedFile {
    GeneratedFile {
        path: path.into(),
        content: content.into(),
    }
}

fn safe_name(name: &str) -> String {
    let name: String = name
        .chars()
        .take(48)
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let name = name.trim_matches('-');
    if name.is_empty() {
        "progetto".into()
    } else {
        name.into()
    }
}

fn database_group(index: usize, name: &str) -> String {
    format!("{:02}-{}", index + 1, safe_name(name))
}

fn encode_json(value: impl Serialize) -> Result<String, String> {
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

fn tracked(
    files: &[GeneratedFile],
    path: &str,
    database_id: &str,
    operation_id: Option<&str>,
    kind: &str,
) -> Value {
    let content = files
        .iter()
        .find(|file| file.path == path)
        .expect("tracked file generated");
    let sha256 = hex::encode(Sha256::digest(content.content.as_bytes()));
    let mut entry = json!({"path":path,"sha256":sha256,"databaseId":database_id,"kind":kind});
    if let Some(id) = operation_id {
        entry["operationId"] = json!(id);
    }
    entry
}

fn generate_driver(
    db: &DatabasePlan,
    table: &TableInfo,
    language: &str,
    artifact: &str,
    query: &str,
) -> Result<GeneratedProject, String> {
    let request: WorkbenchRequest = serde_json::from_value(json!({
        "engine":db.engine,"language":language,"artifact":artifact,"table":table.name,
        "tableSchema":table.schema,"schemaDefinition":"","query":query,
        "columns":if artifact == "schema" { Vec::new() } else { table.columns.clone() },
        "writeColumnMetadata":table.columns,"educational":true
    }))
    .map_err(|e| e.to_string())?;
    generate_workbench(request)
}

fn qualified(engine: &str, object: &ObjectRef) -> String {
    let name = quote_ident(engine, &object.name);
    object.schema.as_ref().map_or(name.clone(), |schema| {
        format!("{}.{}", quote_ident(engine, schema), name)
    })
}

fn add_migration(
    files: &mut Vec<GeneratedFile>,
    db: &DatabasePlan,
    folder: &str,
    plan: &MigrationPlan,
) -> Result<MigrationFile, String> {
    if plan.baseline.engine != db.engine || plan.baseline.tables.is_empty() {
        return Err(format!(
            "Baseline della migrazione non valida per {}.",
            db.name
        ));
    }
    let mut baseline = plan.baseline.clone();
    baseline
        .tables
        .sort_by(|a, b| (&a.schema, &a.name).cmp(&(&b.schema, &b.name)));
    for table in &mut baseline.tables {
        table.row_count = None;
    }
    let baseline_path = format!("{folder}/migrazione/baseline.json");
    let content = encode_json(&baseline)?;
    let baseline_sha256 = hex::encode(Sha256::digest(content.as_bytes()));
    files.push(file(&baseline_path, content));
    let status = if !plan.blockers.is_empty() {
        "blocked"
    } else if plan.changes.is_empty() {
        "unchanged"
    } else if plan.rebuild_sqlite {
        "designer"
    } else {
        "ready"
    };
    let destructive = plan.changes.iter().any(|change| change.destructive);
    let mut guide = format!("# Migrazione · {}\n\nBaseline SHA-256 `{baseline_sha256}`. È la fotografia delle strutture di origine conservate nel progetto. Confronta lo schema completo di destinazione prima dell’applicazione. La generazione è offline e non certifica la compatibilità con un database attivo.\n\n", db.name);
    match status {
        "designer" => guide.push_str("La ricostruzione SQLite si applica nel Designer. Usa una copia e un backup verificato. Il Designer controlla lo schema, le chiavi esterne e le sequenze. Lo schema del pacchetto serve per un database nuovo.\n"),
        "blocked" => guide.push_str("Il piano contiene interventi che richiedono revisione. Risolvi i blocchi prima di pianificare l’applicazione.\n"),
        "unchanged" => guide.push_str("Il confronto con la baseline non ha prodotto modifiche.\n"),
        _ => guide.push_str("Rivedi il piano, confronta la destinazione e provalo su una copia prima di applicarlo con gli strumenti del motore. Usa un backup verificato prima di intervenire sui dati reali.\n"),
    }
    if destructive {
        guide.push_str("\n**Il piano contiene interventi distruttivi scelti nel progetto.**\n");
    }
    for change in &plan.changes {
        guide.push_str(&format!(
            "\n- {}{}",
            change.label,
            if change.destructive {
                " (distruttiva)"
            } else {
                ""
            }
        ));
    }
    for warning in plan.blockers.iter().chain(&plan.warnings) {
        guide.push_str(&format!("\n- {warning}"));
    }
    let guide_path = format!("{folder}/migrazione/README.md");
    files.push(file(&guide_path, guide));
    let script_path = if status == "ready" {
        if plan.sql.trim().is_empty() {
            return Err("Manca lo script del piano di migrazione.".into());
        }
        let path = format!(
            "{folder}/migrazione/migrazione.{}",
            if db.engine == "mongodb" {
                "json"
            } else {
                "sql"
            }
        );
        let script = match db.engine.as_str() {
            "sqlite" => format!("PRAGMA foreign_keys=ON;\nBEGIN;\n{}\nCOMMIT;\n", plan.sql),
            "postgresql" => format!("BEGIN;\n{}\nCOMMIT;\n", plan.sql),
            _ => plan.sql.clone(),
        };
        files.push(file(&path, script));
        Some(path)
    } else {
        None
    };
    Ok(MigrationFile {
        database_id: db.id.clone(),
        database_name: db.name.clone(),
        status,
        script_path,
        guide_path,
        baseline_path,
        baseline_sha256,
        destructive,
    })
}

pub(crate) fn generate(request: PackageRequest) -> Result<ApplicationPackage, String> {
    let PackageRequest {
        language,
        project,
        databases,
    } = request;
    if !LANGUAGES.contains(&language.as_str())
        || project["version"] != 1
        || databases.is_empty()
        || databases.len() > 16
    {
        return Err("Progetto o linguaggio non valido per l’esportazione.".into());
    }
    let manifest_databases = project["databases"]
        .as_array()
        .ok_or("Il manifesto non contiene i database del progetto.")?;
    let mut ids = HashSet::new();
    if manifest_databases.len() != databases.len()
        || databases
            .iter()
            .zip(manifest_databases)
            .any(|(db, manifest)| {
                db.id.is_empty()
                    || !ids.insert(db.id.as_str())
                    || manifest["id"].as_str() != Some(db.id.as_str())
                    || manifest["name"].as_str() != Some(db.name.as_str())
                    || manifest["engine"].as_str() != Some(db.engine.as_str())
            })
    {
        return Err("Database duplicati o diversi dal manifesto del progetto.".into());
    }
    let mut files = Vec::new();
    let mut targets = Vec::new();
    let mut operations = Vec::new();
    let mut migrations = Vec::new();
    let mut tracked_files = Vec::new();
    let mut readme = String::from("# Progetto Database Manager\n\nIl manifesto consente di riaprire il progetto visuale. I driver sono organizzati per destinazione e poi per tabella; configura ogni destinazione prima di usarli. I sorgenti esportati non contengono credenziali.\n");
    for (index, db) in databases.into_iter().enumerate() {
        if db.engine != db.schema.engine
            || db.schema.tables.is_empty()
            || db.schema.tables.len() > 100
            || db.seed.len() > 5000
            || db.operations.len() > 100
        {
            return Err(format!(
                "Struttura o dimensione del database {} non valida.",
                db.name
            ));
        }
        let group = database_group(index, &db.name);
        let folder = format!("databases/{group}");
        let ddl_path = format!(
            "{folder}/schema.{}",
            if db.engine == "mongodb" {
                "json"
            } else {
                "sql"
            }
        );
        if db.ddl.trim().is_empty() {
            return Err(format!("Manca lo schema di {}.", db.name));
        }
        files.push(file(&ddl_path, &db.ddl));
        tracked_files.push(tracked(&files, &ddl_path, &db.id, None, "schema"));
        if let Some(plan) = &db.migration {
            migrations.push(add_migration(&mut files, &db, &folder, plan)?);
        }
        let mut seed = Vec::new();
        for row in &db.seed {
            let table = row.table.resolve(&db.schema)?;
            if db.engine != "mongodb"
                && row.values.keys().any(|name| {
                    !table
                        .columns
                        .iter()
                        .any(|column| &column.name == name && !column.generated)
                })
            {
                return Err(format!(
                    "{}: il seed contiene un campo assente o generato in {}.",
                    db.name, table.name
                ));
            }
            let dependencies = table.foreign_keys.iter().map(|key| json!({"name":key.referenced_table,"schema":key.referenced_schema.as_ref().or(table.schema.as_ref())})).collect::<Vec<_>>();
            let override_identity = table
                .columns
                .iter()
                .any(|column| column.identity && row.values.contains_key(&column.name));
            seed.push(json!({"table":row.table,"values":row.values,"dependsOn":dependencies,"overrideIdentity":override_identity}));
        }
        let seed_path = if seed.is_empty() {
            None
        } else {
            let path = format!("{folder}/seed.json");
            files.push(file(&path, encode_json(seed)?));
            Some(path)
        };

        let mut modules = Vec::new();
        for (table_index, table) in db.schema.tables.iter().enumerate() {
            let object = ObjectRef {
                name: table.name.clone(),
                schema: table.schema.clone(),
            };
            let table_id = database_group(table_index, &table.name);
            let driver_root = format!("{folder}/driver/{table_id}");
            let driver = generate_driver(&db, table, &language, "project", "")
                .map_err(|error| format!("{} · {}. {error}", db.name, table.name))?;
            let launch = driver.command;
            files.extend(
                driver
                    .files
                    .into_iter()
                    .map(|entry| file(format!("{driver_root}/{}", entry.path), entry.content)),
            );
            modules.push(
                json!({"id":table_id,"table":object,"directory":driver_root,"command":launch}),
            );
            for (name, sql, parameters, write) in default_operations(&db.engine, table, &object) {
                let id = format!("{table_id}-{name}");
                add_operation(
                    &mut files,
                    &mut operations,
                    &db,
                    &folder,
                    &language,
                    &id,
                    name,
                    &object,
                    &sql,
                    parameters,
                    write,
                )?;
            }
        }
        if db.engine != "mongodb"
            || ["rust", "python", "javascript", "typescript"].contains(&language.as_str())
        {
            let schema_files =
                generate_driver(&db, &db.schema.tables[0], &language, "schema", &db.ddl)?;
            for entry in schema_files.files {
                let has_inline_schema = !matches!(
                    entry.path.as_str(),
                    "schema.sql" | "schema.json" | "README.md"
                ) && (db.engine != "mongodb" || language != "rust");
                let path = format!("{folder}/setup/{}", entry.path);
                files.push(file(&path, entry.content));
                if has_inline_schema {
                    tracked_files.push(tracked(&files, &path, &db.id, None, "schemaSource"));
                }
            }
        }
        let mut operation_ids = HashSet::new();
        for (operation_index, operation) in db.operations.iter().enumerate() {
            if operation.id.is_empty() || !operation_ids.insert(operation.id.as_str()) {
                return Err(format!("Operazione duplicata in {}.", db.name));
            }
            operation.table.resolve(&db.schema)?;
            let (sql, parameters, write) = match &operation.plan {
                GraphPlan::Read { query, params } => (query.clone(), params.clone(), false),
                GraphPlan::Write { operation } => {
                    let result = operation.compile(&db.schema)?;
                    (result.query, result.parameters, true)
                }
            };
            add_operation(
                &mut files,
                &mut operations,
                &db,
                &folder,
                &language,
                &format!(
                    "grafico-{}",
                    database_group(operation_index, &operation.name)
                ),
                &operation.name,
                &operation.table,
                &sql,
                parameters,
                write,
            )?;
            let generated = operations.last().expect("operation just generated");
            for (kind, path) in [
                ("query", Some(generated.query_path.as_str())),
                ("parameters", generated.parameters_path.as_deref()),
                (
                    "source",
                    generated
                        .source_path
                        .as_deref()
                        .filter(|_| db.engine != "mongodb"),
                ),
            ] {
                if let Some(path) = path {
                    tracked_files.push(tracked(&files, path, &db.id, Some(&operation.id), kind));
                }
            }
        }
        readme.push_str(&format!(
            "\n## {}\n\nMotore **{}**. Apri `{folder}` per schema, operazioni e driver.\n",
            db.name, db.engine
        ));
        if db.migration.is_some() {
            readme.push_str("La cartella `migrazione/` contiene la baseline e la guida del piano. Leggi la guida per verificare se lo script è applicabile, richiede il Designer o contiene blocchi.\n");
        }
        if seed_path.is_some() {
            readme.push_str(&format!("Dopo avere creato lo schema di prova, configura `DBM_DATABASE_{}_URL` e usa `python carica_seed.py {group} --conferma`. I valori in `seed.json` sono passati al driver come parametri.\n", index + 1));
        }
        targets.push(json!({"id":db.id,"name":db.name,"alias":group,"engine":db.engine,
            "schema":ddl_path,"seed":seed_path,"modules":modules,"environment":format!("DBM_DATABASE_{}_URL", index + 1)}));
    }
    files.push(file("destinazioni.json", encode_json(&targets)?));
    if targets.iter().any(|target| target["seed"].is_string()) {
        files.push(file(
            "carica_seed.py",
            include_str!("project_files/carica_seed.py"),
        ));
        files.push(file(
            "seed-requirements.txt",
            "psycopg[binary]>=3.2,<4\nPyMySQL[rsa]>=1.1,<2\npymongo>=4.10,<5\n",
        ));
        readme.push_str("\n## Dati seed\n\nSQLite usa Python standard. Per le destinazioni server usa l’ambiente Python del progetto e installa il driver corrispondente in `seed-requirements.txt`. PostgreSQL e MongoDB accettano URI; MySQL e MariaDB usano URI standard senza opzioni di query. Per TLS personalizzato usa una connessione del tuo driver con `insert_sql`. MongoDB richiede il database nel percorso dell’URI e può confermare righe precedenti in caso di errore; verifica una copia di prova prima del caricamento. Le chiavi identità fornite restano esplicite. Dopo un seed PostgreSQL con identità assegnate, controlla la sequenza prima di nuovi inserimenti automatici.\n");
    }
    let command = if language == "python"
        && targets.iter().any(|target| target["engine"] == "sqlite")
    {
        files.push(file(
            "progetto.py",
            include_str!("project_files/progetto.py"),
        ));
        readme.push_str("\n## Destinazioni SQLite in Python\n\n`python progetto.py elenco` mostra gli alias. `python progetto.py inizializza ALIAS` crea un nuovo file SQLite e applica schema e seed. `python progetto.py esegui ALIAS MODULO list` usa il driver generato per quella destinazione. Per `insert`, `update` e `delete` passa anche il payload JSON. Il file può essere impostato con la variabile indicata in `destinazioni.json`.\n");
        "python progetto.py elenco".into()
    } else {
        String::new()
    };
    files.push(file("README.md", readme));
    files.insert(0, file(MANIFEST, encode_json(json!({"format":"database-manager-project","version":1,"language":language,"project":project,"files":tracked_files,"migrations":migrations}))?));
    validate_paths(&files)?;
    Ok(ApplicationPackage { project: GeneratedProject {files, command, notes: vec!["Esporta il pacchetto e apri README.md. Le funzioni fornite usano una connessione scelta dall’applicazione.".into()]}, operations, migrations })
}

type Parameters = BTreeMap<String, Value>;

fn default_operations(
    engine: &str,
    table: &TableInfo,
    object: &ObjectRef,
) -> Vec<(&'static str, String, Parameters, bool)> {
    if engine == "mongodb" {
        return vec![
            ("Leggi", json!({"find":table.name,"filter":{},"limit":100}).to_string(), Parameters::new(), false),
            ("Inserisci", json!({"insert":table.name,"documents":[{"$param":"documento"}]}).to_string(), Parameters::from([("documento".into(),Value::Null)]), true),
            ("Modifica", json!({"update":table.name,"updates":[{"q":{"_id":{"$param":"id"}},"u":{"$set":{"$param":"campi"}},"multi":false}]}).to_string(), Parameters::from([("id".into(),Value::Null),("campi".into(),Value::Null)]), true),
            ("Elimina", json!({"delete":table.name,"deletes":[{"q":{"_id":{"$param":"id"}},"limit":1}]}).to_string(), Parameters::from([("id".into(),Value::Null)]), true),
        ];
    }
    let target = qualified(engine, object);
    let mut result = vec![(
        "Leggi",
        format!("SELECT * FROM {target} LIMIT 100"),
        Parameters::new(),
        false,
    )];
    let columns: Vec<_> = table
        .columns
        .iter()
        .filter(|column| !column.identity && !column.generated && column.default_value.is_none())
        .collect();
    let keys: Vec<_> = table
        .columns
        .iter()
        .filter(|column| column.primary_key)
        .collect();
    let edits: Vec<_> = table
        .columns
        .iter()
        .filter(|column| !column.primary_key && !column.identity && !column.generated)
        .collect();
    let quote = |column: &&crate::models::ColumnInfo| quote_ident(engine, &column.name);
    let binds = |columns: &[&crate::models::ColumnInfo]| {
        columns
            .iter()
            .enumerate()
            .map(|(i, column)| {
                (
                    format!("p{}", i + 1),
                    json!({"column":column.name,"type":column.data_type}),
                )
            })
            .collect::<Parameters>()
    };
    let insert = if columns.is_empty() {
        if engine == "mysql" || engine == "mariadb" {
            format!("INSERT INTO {target} () VALUES ()")
        } else {
            format!("INSERT INTO {target} DEFAULT VALUES")
        }
    } else {
        let names = columns.iter().map(quote).collect::<Vec<_>>().join(", ");
        let values = (1..=columns.len())
            .map(|i| format!(":p{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("INSERT INTO {target} ({names}) VALUES ({values})")
    };
    result.push(("Inserisci", insert, binds(&columns), true));
    if !keys.is_empty() {
        let where_clause = |start: usize| {
            keys.iter()
                .enumerate()
                .map(|(i, column)| format!("{} = :p{}", quote(column), i + start))
                .collect::<Vec<_>>()
                .join(" AND ")
        };
        if !edits.is_empty() {
            let sets = edits
                .iter()
                .enumerate()
                .map(|(i, column)| format!("{} = :p{}", quote(column), i + 1))
                .collect::<Vec<_>>()
                .join(", ");
            let fields = edits.iter().chain(keys.iter()).copied().collect::<Vec<_>>();
            result.push((
                "Modifica",
                format!(
                    "UPDATE {target} SET {sets} WHERE {}",
                    where_clause(edits.len() + 1)
                ),
                binds(&fields),
                true,
            ));
        }
        result.push((
            "Elimina",
            format!("DELETE FROM {target} WHERE {}", where_clause(1)),
            binds(&keys),
            true,
        ));
    }
    result
}

#[allow(clippy::too_many_arguments)]
fn add_operation(
    files: &mut Vec<GeneratedFile>,
    operations: &mut Vec<OperationFile>,
    db: &DatabasePlan,
    folder: &str,
    language: &str,
    id: &str,
    label: &str,
    table: &ObjectRef,
    sql: &str,
    parameters: Parameters,
    write: bool,
) -> Result<(), String> {
    let directory = format!("{folder}/operazioni/{}", id.to_ascii_lowercase());
    let path = format!(
        "{directory}/operazione.{}",
        if db.engine == "mongodb" {
            "json"
        } else {
            "sql"
        }
    );
    let content = if db.engine == "mongodb" {
        let command: serde_json::Map<String, Value> =
            serde_json::from_str(sql).map_err(|e| e.to_string())?;
        let verb = ["find", "aggregate", "insert", "update", "delete"]
            .into_iter()
            .find(|verb| command.contains_key(*verb))
            .ok_or("Comando MongoDB non disponibile nel pacchetto.")?;
        let fields = std::iter::once((verb, &command[verb])).chain(
            command
                .iter()
                .filter(|(key, _)| key.as_str() != verb)
                .map(|(key, value)| (key.as_str(), value)),
        );
        let json_lines = fields
            .map(|(key, value)| {
                format!(
                    "  {}: {value}",
                    serde_json::to_string(key).expect("JSON string")
                )
            })
            .collect::<Vec<_>>()
            .join(",\n");
        format!("{{\n{json_lines}\n}}\n")
    } else {
        format!("{};\n", sql.trim_end().trim_end_matches(';'))
    };
    files.push(file(&path, &content));
    let parameters_path = if parameters.is_empty() {
        None
    } else {
        let path = format!("{directory}/parametri.json");
        files.push(file(&path, encode_json(&parameters)?));
        Some(path)
    };
    let source_input = if db.engine == "mongodb" {
        content.as_str()
    } else {
        sql
    };
    let source_path =
        project_sources::generate(language, &db.engine, source_input, &parameters, write)?.map(
            |source| {
                let path = format!("{directory}/{}", source.path);
                files.push(file(&path, source.content));
                path
            },
        );
    operations.push(OperationFile {
        id: id.into(),
        name: label.into(),
        database_id: db.id.clone(),
        database_name: db.name.clone(),
        table: table.clone(),
        source_path,
        query_path: path,
        parameters_path,
    });
    Ok(())
}

#[path = "project_files/sources.rs"]
mod project_sources;

#[cfg(test)]
#[path = "project_files/tests.rs"]
mod tests;

fn validate_paths(files: &[GeneratedFile]) -> Result<(), String> {
    let mut paths = HashSet::new();
    for entry in files {
        let relative = Path::new(&entry.path);
        if entry.path.is_empty()
            || entry
                .path
                .contains([':', '\\', '<', '>', '"', '|', '?', '*'])
            || relative.is_absolute()
            || relative
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
            || entry.path.split('/').any(|part| {
                part.is_empty() || part.ends_with(['.', ' ']) || part.chars().any(char::is_control)
            })
            || !paths.insert(entry.path.to_lowercase())
        {
            return Err(format!(
                "Percorso non valido o duplicato nel pacchetto: {}",
                entry.path
            ));
        }
    }
    for path in &paths {
        if Path::new(path)
            .ancestors()
            .skip(1)
            .any(|parent| paths.contains(&parent.to_string_lossy().replace('\\', "/")))
        {
            return Err(format!(
                "Un file del pacchetto coincide con una cartella: {path}"
            ));
        }
    }
    Ok(())
}

pub(crate) fn export(project: GeneratedProject, parent: &Path) -> Result<PathBuf, String> {
    validate_paths(&project.files)?;
    let parent = parent.canonicalize().map_err(|e| e.to_string())?;
    if !parent.is_dir() || !project.files.iter().any(|f| f.path == MANIFEST) {
        return Err("Seleziona una cartella esistente e genera il pacchetto applicativo.".into());
    }
    let folder = tempfile::Builder::new()
        .prefix("database-manager-progetto-")
        .tempdir_in(parent)
        .map_err(|e| e.to_string())?;
    crate::service::write_project(&project, folder.path())?;
    Ok(folder.keep())
}
