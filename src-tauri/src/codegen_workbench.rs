//! Schema-to-code workbench. Source is generated offline and is never executed.
use crate::codegen::{CodeColumn, GenerateRequest, GeneratedFile, GeneratedProject};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
#[path = "codegen_workbench/models.rs"]
mod models;
#[path = "codegen_workbench/reads.rs"]
mod reads;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchParameter {
    pub name: String,
    #[serde(default = "text_type")]
    pub data_type: String,
    #[serde(default)]
    pub nullable: bool,
    pub value: Option<Value>,
}
fn text_type() -> String {
    "text".into()
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchRequest {
    pub engine: String,
    pub language: String,
    pub artifact: String,
    pub table: String,
    pub table_schema: Option<String>,
    #[serde(default)]
    pub columns: Vec<CodeColumn>,
    #[serde(default = "select_operation")]
    pub operation: String,
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub educational: bool,
    #[serde(default)]
    pub parameters: Vec<WorkbenchParameter>,
}
fn select_operation() -> String {
    "select".into()
}
pub(super) const LANGUAGES: [&str; 12] = [
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
];
pub(super) fn file(path: impl Into<String>, content: impl Into<String>) -> GeneratedFile {
    GeneratedFile {
        path: path.into(),
        content: content.into(),
    }
}
pub(super) fn literal(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}
pub(super) fn single_literal(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}
pub(super) fn kind(value: &str) -> Result<&'static str, String> {
    crate::codegen::kind(&canonical_scalar_type(value))
}
fn canonical_scalar_type(value: &str) -> String {
    let normalized = value.trim().to_ascii_lowercase();
    let base = normalized.split('(').next().unwrap_or("").trim();
    if matches!(
        base,
        "character varying"
            | "character"
            | "national character varying"
            | "national character"
            | "bpchar"
    ) {
        "text".into()
    } else {
        value.to_owned()
    }
}
fn sql_array_type(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("array") || value.trim().ends_with("[]")
}
pub(super) fn identifier(value: &str) -> Result<(), String> {
    if value.trim().is_empty()
        || value.len() > 512
        || value
            .chars()
            .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        Err("Identificatore vuoto, troppo lungo o contenente caratteri di controllo.".into())
    } else {
        Ok(())
    }
}
pub(super) fn member_name(value: &str, pascal: bool) -> String {
    let mut out = String::new();
    let mut upper = pascal;
    for c in value.chars() {
        if c.is_ascii_alphanumeric() {
            if out.is_empty() && c.is_ascii_digit() {
                out.push_str(if pascal { "Field" } else { "field_" });
            }
            out.push(if upper {
                c.to_ascii_uppercase()
            } else {
                c.to_ascii_lowercase()
            });
            upper = false;
        } else {
            if !pascal && !out.ends_with('_') && !out.is_empty() {
                out.push('_');
            }
            upper = pascal;
        }
    }
    if out.is_empty() {
        out = if pascal { "Field" } else { "field" }.into();
    }
    if [
        "class",
        "type",
        "match",
        "self",
        "super",
        "default",
        "new",
        "return",
        "package",
        "func",
        "fn",
        "struct",
        "enum",
        "var",
        "const",
        "public",
        "private",
        "int",
        "string",
        "namespace",
        "module",
        "end",
        "def",
        "nil",
        "null",
        "true",
        "false",
        "for",
        "while",
        "if",
        "else",
        "break",
        "continue",
        "do",
        "goto",
        "case",
        "union",
        "void",
        "float",
        "double",
        "short",
        "long",
        "signed",
        "unsigned",
        "extern",
        "static",
        "volatile",
        "restrict",
        "register",
        "sizeof",
        "auto",
        "switch",
        "in",
        "is",
        "not",
        "and",
        "or",
        "as",
        "from",
        "import",
        "try",
        "except",
        "finally",
        "raise",
        "assert",
        "lambda",
        "pass",
        "del",
        "with",
        "yield",
        "async",
        "await",
        "global",
        "nonlocal",
        "interface",
        "extends",
        "implements",
        "event",
        "params",
        "base",
        "object",
        "decimal",
        "internal",
        "protected",
        "abstract",
        "final",
        "throw",
        "throws",
        "catch",
        "this",
    ]
    .contains(&out.as_str())
    {
        out.push_str("_value");
    }
    out
}
fn normalize(mut request: WorkbenchRequest) -> Result<WorkbenchRequest, String> {
    request.engine = request.engine.to_ascii_lowercase();
    request.language = request.language.to_ascii_lowercase();
    request.artifact = request.artifact.to_ascii_lowercase();
    if !["sqlite", "postgresql", "mysql", "mariadb", "mongodb"].contains(&request.engine.as_str())
        || !LANGUAGES.contains(&request.language.as_str())
    {
        return Err("Motore o linguaggio non supportato dal workbench.".into());
    }
    if ![
        "read",
        "function",
        "model",
        "repository",
        "project",
        "rest",
        "script",
    ]
    .contains(&request.artifact.as_str())
    {
        return Err("Tipo di codice non supportato dal workbench.".into());
    }
    if ![
        "select",
        "findByKey",
        "insert",
        "update",
        "delete",
        "custom",
    ]
    .contains(&request.operation.as_str())
    {
        return Err("Operazione del workbench sconosciuta.".into());
    }
    identifier(&request.table)?;
    if let Some(schema) = &request.table_schema {
        identifier(schema)?;
    }
    if request.columns.len() > 256
        || request.parameters.len() > 256
        || request.query.len() > 512 * 1024
    {
        return Err("Schema o query troppo grandi per il generatore interattivo.".into());
    }
    let mut names = HashSet::new();
    let dynamic_read = matches!(request.artifact.as_str(), "read" | "function")
        && matches!(
            request.operation.as_str(),
            "select" | "findByKey" | "custom"
        );
    for column in &request.columns {
        identifier(&column.name)?;
        if !dynamic_read {
            if request.engine != "mongodb" && sql_array_type(&column.data_type) {
                return Err("Il modello di un array SQL richiede il tipo degli elementi; nessun mapping JSON viene inventato.".into());
            }
            kind(&column.data_type)?;
        }
        if !names.insert(column.name.clone()) {
            return Err(format!("Colonna duplicata: {}", column.name));
        }
        if column.primary_key && column.nullable {
            return Err("Una chiave primaria non può essere nullable.".into());
        }
    }
    let mut parameters = HashSet::new();
    for parameter in &request.parameters {
        if parameter.name.is_empty()
            || !parameter
                .name
                .bytes()
                .enumerate()
                .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
        {
            return Err("I nomi parametro devono essere identificatori semplici, ad esempio p1 o minimo_eta.".into());
        }
        if request.engine != "mongodb" && sql_array_type(&parameter.data_type) {
            return Err("Il binding di array SQL richiede un mapping esplicito degli elementi non previsto dal template.".into());
        }
        kind(&parameter.data_type)?;
        if !parameters.insert(parameter.name.clone()) {
            return Err("Parametro duplicato.".into());
        }
    }
    if request
        .query
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("La query contiene caratteri di controllo.".into());
    }
    Ok(request)
}
pub fn generate_workbench(request: WorkbenchRequest) -> Result<GeneratedProject, String> {
    let mut request = normalize(request)?;
    if request.artifact == "model" {
        return models::generate(&request);
    }
    if matches!(request.artifact.as_str(), "project" | "rest") {
        if request.engine == "postgresql"
            && request
                .table_schema
                .as_deref()
                .is_some_and(|s| s != "public")
        {
            return Err("Il progetto CRUD completo non può essere generato per uno schema PostgreSQL diverso da public. Generare funzione di lettura, modello o repository con query qualificata.".into());
        }
        if !request.parameters.is_empty() {
            return Err("Per una query con parametri scegliere Lettura, Funzione o Repository: i progetti CRUD completi usano il loro contratto di payload e non ignorano i parametri del workbench.".into());
        }
        return crate::codegen::generate_project(GenerateRequest {
            engine: request.engine,
            language: request.language,
            output: request.artifact,
            table: request.table,
            query: request.query,
            columns: request
                .columns
                .into_iter()
                .map(|mut column| {
                    column.data_type = canonical_scalar_type(&column.data_type);
                    column
                })
                .collect(),
            educational: request.educational,
        });
    }
    if matches!(request.operation.as_str(), "insert" | "update" | "delete") {
        if request.engine != "mongodb"
            && request.operation != "insert"
            && !request.columns.iter().any(|c| c.primary_key)
        {
            return Err("Modifica e cancellazione richiedono una chiave primaria stabile.".into());
        }
        if request.engine == "postgresql"
            && request
                .table_schema
                .as_deref()
                .is_some_and(|s| s != "public")
        {
            return Err("Per i CRUD completi PostgreSQL selezionare public; le letture del workbench supportano gli schemi qualificati.".into());
        }
        let mut project = crate::codegen::generate_project(GenerateRequest {
            engine: request.engine,
            language: request.language,
            output: if request.artifact == "script" {
                "script"
            } else {
                "snippet"
            }
            .into(),
            table: request.table,
            query: String::new(),
            columns: request
                .columns
                .into_iter()
                .map(|mut column| {
                    column.data_type = canonical_scalar_type(&column.data_type);
                    column
                })
                .collect(),
            educational: request.educational,
        })?;
        project.notes.push(format!("La funzione execute fornita accetta l’operazione '{}' e un payload; nessuna operazione è eseguita dal generatore.",request.operation));
        return Ok(project);
    }
    if request.engine == "mongodb" {
        return reads::generate_mongo(&request);
    }
    if request.query.trim().is_empty() {
        let quoted = qualified_table(&request);
        if request.operation == "findByKey" {
            let keys = request
                .columns
                .iter()
                .filter(|c| c.primary_key)
                .cloned()
                .collect::<Vec<_>>();
            if keys.is_empty() {
                return Err(
                    "La lettura per chiave richiede almeno una colonna chiave primaria.".into(),
                );
            }
            if !request.parameters.is_empty() {
                return Err("Fornire la query se si impostano parametri personalizzati per la lettura per chiave.".into());
            }
            request.parameters = keys
                .iter()
                .enumerate()
                .map(|(i, c)| WorkbenchParameter {
                    name: format!("p{}", i + 1),
                    data_type: c.data_type.clone(),
                    nullable: false,
                    value: None,
                })
                .collect();
            let conditions = keys
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    format!(
                        "{} = :p{}",
                        crate::codegen::quote_identifier(&request.engine, &c.name),
                        i + 1
                    )
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            request.query = format!("SELECT * FROM {quoted} WHERE {conditions} LIMIT 1");
        } else {
            request.query = format!("SELECT * FROM {quoted} LIMIT 100");
        }
    }
    let style = placeholder_style(&request);
    let plan = compile_query(&request.query, &request.parameters, style, &request.engine)?;
    if request.artifact == "script" {
        return Ok(GeneratedProject{files:vec![file("query.sql",format!("{};\n",request.query.trim_end_matches(';'))),file("parameters.json",serde_json::to_string_pretty(&parameter_examples(&request.parameters)).unwrap())],command:String::new(),notes:vec!["Script SQL e valori parametro separati. Il generatore non sostituisce valori nel testo né esegue la query.".into()]});
    }
    reads::generate_sql(&request, &plan)
}
pub(super) fn qualified_table(request: &WorkbenchRequest) -> String {
    let table = crate::codegen::quote_identifier(&request.engine, &request.table);
    if let Some(schema) = &request.table_schema {
        format!(
            "{}.{}",
            crate::codegen::quote_identifier(&request.engine, schema),
            table
        )
    } else {
        table
    }
}
pub(super) fn parameter_examples(parameters: &[WorkbenchParameter]) -> Value {
    Value::Object(
        parameters
            .iter()
            .map(|p| {
                (
                    p.name.clone(),
                    p.value
                        .clone()
                        .unwrap_or_else(|| match kind(&p.data_type).unwrap_or("text") {
                            "integer" => json!(1),
                            "float" => json!(1.0),
                            "boolean" => json!(true),
                            "json" => json!({}),
                            "binary" => json!([]),
                            "decimal" => json!("0.00"),
                            "date" => json!("2026-01-01"),
                            _ => json!("esempio"),
                        }),
                )
            })
            .collect(),
    )
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Placeholder {
    Question,
    Numbered,
    Named,
    Percent,
}
pub(super) struct QueryPlan {
    pub sql: String,
    pub bindings: Vec<WorkbenchParameter>,
}
fn placeholder_style(request: &WorkbenchRequest) -> Placeholder {
    match request.language.as_str() {
        "python" if request.engine != "sqlite" => Placeholder::Percent,
        "csharp" => Placeholder::Named,
        "rust" | "javascript" | "typescript" | "go" | "ruby" | "c" | "cpp"
            if request.engine == "postgresql" =>
        {
            Placeholder::Numbered
        }
        _ => Placeholder::Question,
    }
}
/// Rewrite only bind tokens outside SQL strings, quoted identifiers, dollar
/// strings and comments. Each occurrence has its own ordered driver binding.
pub(super) fn compile_query(
    sql: &str,
    parameters: &[WorkbenchParameter],
    style: Placeholder,
    engine: &str,
) -> Result<QueryPlan, String> {
    let names: HashMap<&str, usize> = parameters
        .iter()
        .enumerate()
        .map(|(i, p)| (p.name.as_str(), i))
        .collect();
    let chars = sql.chars().collect::<Vec<_>>();
    let mut i = 0;
    let mut output = String::new();
    let mut bindings = Vec::new();
    let mut used = HashSet::new();
    let mut question_index = 0;
    while i < chars.len() {
        let c = chars[i];
        if (c == '-' && chars.get(i + 1) == Some(&'-'))
            || (c == '#' && matches!(engine, "mysql" | "mariadb"))
        {
            while i < chars.len() {
                let ch = chars[i];
                append_literal(&mut output, ch, style);
                i += 1;
                if ch == '\n' {
                    break;
                }
            }
            continue;
        }
        if c == '/' && chars.get(i + 1) == Some(&'*') {
            let start = i;
            let mut depth = 1;
            i += 2;
            while i < chars.len() && depth > 0 {
                if chars[i] == '/' && chars.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if depth != 0 {
                return Err("Commento SQL non chiuso.".into());
            }
            for ch in &chars[start..i] {
                append_literal(&mut output, *ch, style);
            }
            continue;
        }
        if matches!(c, '\'' | '"' | '`' | '[') {
            let end = if c == '[' { ']' } else { c };
            let start = i;
            let escaped = matches!(engine, "mysql" | "mariadb")
                || (c == '\'' && i > 0 && matches!(chars[i - 1], 'E' | 'e'));
            i += 1;
            let mut closed = false;
            while i < chars.len() {
                if escaped && chars[i] == '\\' {
                    i = (i + 2).min(chars.len());
                    continue;
                }
                if chars[i] == end {
                    if chars.get(i + 1) == Some(&end) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                return Err("Stringa o identificatore SQL non chiuso.".into());
            }
            for ch in &chars[start..i] {
                append_literal(&mut output, *ch, style);
            }
            continue;
        }
        if c == '$' {
            let mut end = i + 1;
            if chars.get(end) == Some(&'$')
                || chars
                    .get(end)
                    .is_some_and(|c| c.is_ascii_alphabetic() || *c == '_')
            {
                while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '_')
                {
                    end += 1;
                }
                if chars.get(end) == Some(&'$') {
                    let tag = chars[i..=end].iter().collect::<String>();
                    let rest = chars[end + 1..].iter().collect::<String>();
                    let offset = rest
                        .find(&tag)
                        .ok_or("Stringa dollar-quoted SQL non chiusa.")?;
                    let span = rest[..offset].chars().count() + tag.chars().count();
                    for ch in &chars[i..end + 1 + span] {
                        append_literal(&mut output, *ch, style);
                    }
                    i = end + 1 + span;
                    continue;
                }
            }
        }
        let token = if c == '$' && chars.get(i + 1).is_some_and(char::is_ascii_digit) {
            let mut end = i + 1;
            while chars.get(end).is_some_and(char::is_ascii_digit) {
                end += 1;
            }
            let n = chars[i + 1..end]
                .iter()
                .collect::<String>()
                .parse::<usize>()
                .map_err(|_| "Indice parametro SQL non valido")?;
            Some((
                n.checked_sub(1)
                    .filter(|n| *n < parameters.len())
                    .ok_or("Parametro numerato SQL privo di dichiarazione.")?,
                end,
            ))
        } else if c == ':'
            && chars.get(i.wrapping_sub(1)) != Some(&':')
            && chars.get(i + 1) != Some(&':')
            && chars
                .get(i + 1)
                .is_some_and(|c| c.is_ascii_alphabetic() || *c == '_')
        {
            let mut end = i + 1;
            while chars
                .get(end)
                .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
            {
                end += 1;
            }
            let name = chars[i + 1..end].iter().collect::<String>();
            Some((
                *names
                    .get(name.as_str())
                    .ok_or_else(|| format!("Parametro SQL :{name} non dichiarato."))?,
                end,
            ))
        } else if c == '?' && engine != "postgresql" && !parameters.is_empty() {
            let index = question_index;
            question_index += 1;
            if index >= parameters.len() {
                return Err("Troppi placeholder posizionali nella query.".into());
            }
            Some((index, i + 1))
        } else {
            None
        };
        if let Some((index, end)) = token {
            used.insert(index);
            bindings.push(parameters[index].clone());
            let n = bindings.len();
            output.push_str(&match style {
                Placeholder::Question => "?".into(),
                Placeholder::Numbered => format!("${n}"),
                Placeholder::Named => format!("@p{n}"),
                Placeholder::Percent => "%s".into(),
            });
            i = end;
        } else {
            if c == '?' && engine == "postgresql" && style == Placeholder::Question {
                output.push_str("??");
            } else {
                append_literal(&mut output, c, style);
            }
            i += 1;
        }
    }
    if used.len() != parameters.len() {
        return Err(
            "Un parametro dichiarato non è presente nella query; nessun valore viene ignorato."
                .into(),
        );
    }
    Ok(QueryPlan {
        sql: output,
        bindings,
    })
}
fn append_literal(output: &mut String, c: char, style: Placeholder) {
    if c == '%' && style == Placeholder::Percent {
        output.push('%');
    }
    output.push(c);
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(engine: &str, language: &str, artifact: &str) -> WorkbenchRequest {
        serde_json::from_value(json!({"engine":engine,"language":language,"artifact":artifact,"table":"people","columns":[{"name":"id","dataType":"bigint","primaryKey":true},{"name":"name","dataType":"text","nullable":true}],"operation":"select","educational":true})).unwrap()
    }
    #[test]
    fn read_generation_covers_all_sixty_engine_language_pairs() {
        for engine in ["sqlite", "postgresql", "mysql", "mariadb", "mongodb"] {
            for language in LANGUAGES {
                let result = generate_workbench(request(engine, language, "read"))
                    .unwrap_or_else(|e| panic!("{engine}/{language}: {e}"));
                assert!(
                    result
                        .files
                        .iter()
                        .any(|f| f.path.contains("read_records") || f.path.contains("ReadRecords")),
                    "{engine}/{language}"
                );
                assert!(!result
                    .files
                    .iter()
                    .any(|f| f.content.contains("@@SQL@@") || f.content.contains("@@TEMPLATE@@")));
            }
        }
    }
    #[test]
    fn models_preserve_original_names_nullability_and_keys_in_twelve_languages() {
        for language in LANGUAGES {
            let mut req = request("postgresql", language, "model");
            req.columns.push(CodeColumn {
                name: "first-name".into(),
                data_type: "numeric(38,10)".into(),
                primary_key: false,
                nullable: true,
            });
            let generated = generate_workbench(req).unwrap();
            let mapping: Value = serde_json::from_str(
                &generated
                    .files
                    .iter()
                    .find(|f| f.path.ends_with("schema-mapping.json"))
                    .unwrap()
                    .content,
            )
            .unwrap();
            assert_eq!(mapping["primaryKeys"], json!(["id"]));
            assert_eq!(mapping["columns"][2]["column"], "first-name");
            assert_eq!(mapping["columns"][2]["nullable"], true);
        }
    }
    #[test]
    fn lexer_preserves_literals_casts_dollar_strings_and_comments() {
        let parameters = vec![
            WorkbenchParameter {
                name: "p1".into(),
                data_type: "integer".into(),
                nullable: false,
                value: None,
            },
            WorkbenchParameter {
                name: "p2".into(),
                data_type: "text".into(),
                nullable: true,
                value: None,
            },
        ];
        let plan=compile_query("SELECT ':p1', \"$2\", $$:p2 $1$$, value::text FROM items WHERE id=:p1 OR owner=$1 AND note=:p2 -- :absent\n",&parameters,Placeholder::Question,"postgresql").unwrap();
        assert_eq!(
            plan.bindings
                .iter()
                .map(|p| p.name.as_str())
                .collect::<Vec<_>>(),
            vec!["p1", "p1", "p2"]
        );
        assert!(plan.sql.contains("':p1'"));
        assert!(plan.sql.contains("$$:p2 $1$$"));
        assert!(plan.sql.contains("value::text"));
        assert!(plan.sql.contains("-- :absent"));
    }
    #[test]
    fn psycopg_literal_percent_is_escaped_without_touching_parameter_tokens() {
        let parameters = vec![WorkbenchParameter {
            name: "p1".into(),
            data_type: "integer".into(),
            nullable: false,
            value: None,
        }];
        let plan = compile_query(
            "SELECT '100%' AS label WHERE id=:p1",
            &parameters,
            Placeholder::Percent,
            "postgresql",
        )
        .unwrap();
        assert_eq!(plan.sql, "SELECT '100%%' AS label WHERE id=%s");
    }
    #[test]
    fn composite_key_reads_qualify_schema_and_bind_every_key() {
        let mut req = request("postgresql", "python", "read");
        req.table_schema = Some("analytics".into());
        req.columns[1].primary_key = true;
        req.columns[1].nullable = false;
        req.operation = "findByKey".into();
        let generated = generate_workbench(req).unwrap();
        let sql = &generated
            .files
            .iter()
            .find(|f| f.path.ends_with("query.sql"))
            .unwrap()
            .content;
        assert!(sql.contains("\"analytics\".\"people\""));
        assert!(sql.contains("\"id\" = %s AND \"name\" = %s"));
    }
    #[test]
    fn parameters_cannot_become_source_code_or_sql_text() {
        let mut req = request("sqlite", "javascript", "function");
        req.query = "SELECT * FROM people WHERE name=:p1".into();
        req.parameters.push(WorkbenchParameter {
            name: "p1".into(),
            data_type: "text".into(),
            nullable: false,
            value: Some(json!("x' OR 1=1 --")),
        });
        let generated = generate_workbench(req).unwrap();
        let source = &generated
            .files
            .iter()
            .find(|f| f.path.ends_with("read_records.mjs"))
            .unwrap()
            .content;
        assert!(!source.contains("OR 1=1"));
        assert!(source.contains("connection.prepare(SQL)"));
    }
    #[test]
    fn legacy_projects_do_not_silently_ignore_schema_or_parameters() {
        let mut req = request("postgresql", "rust", "project");
        req.table_schema = Some("analytics".into());
        assert!(generate_workbench(req.clone()).is_err());
        req.table_schema = Some("public".into());
        req.query = "SELECT * FROM people WHERE id=$1".into();
        req.parameters.push(WorkbenchParameter {
            name: "p1".into(),
            data_type: "integer".into(),
            nullable: false,
            value: None,
        });
        assert!(generate_workbench(req).is_err());
    }
    #[test]
    fn mongo_markers_and_aggregation_generate_typed_bindings() {
        let mut req = request("mongodb", "javascript", "read");
        req.query =
            r#"{"aggregate":"people","pipeline":[{"$match":{"age":{"$gte":{"$param":"p1"}}}}]}"#
                .into();
        req.parameters.push(WorkbenchParameter {
            name: "p1".into(),
            data_type: "integer".into(),
            nullable: false,
            value: None,
        });
        let generated = generate_workbench(req).unwrap();
        let source = &generated
            .files
            .iter()
            .find(|f| f.path.ends_with("read_records.mjs"))
            .unwrap()
            .content;
        assert!(source.contains("BSON.EJSON.deserialize"));
        assert!(source.contains("collection.aggregate"));
        assert!(generated
            .files
            .iter()
            .any(|f| f.path.ends_with("mongodb-query.json")));
    }
    #[test]
    fn native_postgres_character_varying_generates_models_and_read_bindings() {
        let mut req = request("postgresql", "rust", "model");
        req.columns[1].data_type = "character varying".into();
        let model = generate_workbench(req.clone()).unwrap();
        assert!(model.files[0].content.contains("Option<String>"));
        req.artifact = "read".into();
        req.query = "SELECT id,name FROM people WHERE name=:p1".into();
        req.parameters.push(WorkbenchParameter {
            name: "p1".into(),
            data_type: "character varying".into(),
            nullable: true,
            value: None,
        });
        let result = generate_workbench(req).unwrap();
        assert!(result.files[0].content.contains("Option::<String>::None"));
    }
    #[test]
    fn dynamic_reads_keep_unknown_result_types_but_do_not_invent_model_or_array_codecs() {
        let mut req = request("postgresql", "rust", "read");
        req.columns[1].data_type = "USER-DEFINED".into();
        assert!(generate_workbench(req.clone()).is_ok());
        req.artifact = "model".into();
        assert!(generate_workbench(req.clone()).is_err());
        req.columns[1].data_type = "ARRAY".into();
        assert!(generate_workbench(req).is_err());
    }
}
