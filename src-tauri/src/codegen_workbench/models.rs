use super::*;
pub(super) fn generate(request: &WorkbenchRequest) -> Result<GeneratedProject, String> {
    if request.columns.is_empty() {
        return Err("Per generare un modello aggiungere almeno una colonna al designer.".into());
    }
    let mut seen = HashSet::new();
    for c in &request.columns {
        if !seen.insert(member_name(&c.name, false)) {
            return Err("Due colonne diventano lo stesso identificatore nel linguaggio scelto; rinominare i campi.".into());
        }
    }
    let class = format!("{}Row", member_name(&request.table, true));
    let keys = request
        .columns
        .iter()
        .filter(|c| c.primary_key)
        .map(|c| c.name.clone())
        .collect::<Vec<_>>();
    let meta=request.columns.iter().map(|c|json!({"column":c.name,"member":member_name(&c.name,false),"dataType":c.data_type,"nullable":c.nullable,"primaryKey":c.primary_key})).collect::<Vec<_>>();
    let source = match request.language.as_str() {
        "rust" => {
            let mut s=format!("use serde::{{Serialize, Deserialize}};\n\n#[derive(Debug, Clone, Serialize, Deserialize)]\npub struct {class} {{\n");
            for c in &request.columns {
                s += &format!(
                    "    #[serde(rename = {})]\n    pub {}: {},\n",
                    literal(&c.name),
                    member_name(&c.name, false),
                    ty(c, "rust")?
                );
            }
            s += &format!(
                "}}\npub const PRIMARY_KEYS: &[&str] = &[{}];\n",
                keys.iter()
                    .map(|k| literal(k))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            s
        }
        "python" => {
            let mut s=format!("from dataclasses import dataclass, field\nfrom decimal import Decimal\nfrom typing import Any, Optional\n\n@dataclass\nclass {class}:\n");
            for c in &request.columns {
                s += &format!(
                    "    {}: {} = field(metadata={{'column': {}, 'primary_key': {}}})\n",
                    member_name(&c.name, false),
                    ty(c, "python")?,
                    literal(&c.name),
                    if c.primary_key { "True" } else { "False" }
                );
            }
            s += &format!(
                "\nPRIMARY_KEYS = {}\n",
                serde_json::to_string(&keys).unwrap()
            );
            s
        }
        "typescript" => {
            let mut s = format!("export interface {class} {{\n");
            for c in &request.columns {
                s += &format!("  {}: {};\n", literal(&c.name), ty(c, "typescript")?);
            }
            s += &format!(
                "}}\nexport const PRIMARY_KEYS = {} as const;\n",
                serde_json::to_string(&keys).unwrap()
            );
            s
        }
        "javascript" => {
            let fields = request
                .columns
                .iter()
                .map(|c| {
                    Ok(format!(
                        "{}: {}",
                        member_name(&c.name, false),
                        ty(c, "javascript")?
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(", ");
            format!("/** @typedef {{{{ {fields} }}}} {class} */\nexport const PRIMARY_KEYS = Object.freeze({});\nexport const COLUMN_MAPPING = Object.freeze({});\n",serde_json::to_string(&keys).unwrap(),serde_json::to_string(&meta).unwrap())
        }
        "java" => {
            let fields = request
                .columns
                .iter()
                .map(|c| {
                    Ok(format!(
                        "{} {}",
                        ty(c, "java")?,
                        member_name(&c.name, false)
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(",\n    ");
            format!("import java.math.BigDecimal;\nimport java.util.*;\n\npublic record {class}(\n    {fields}\n) {{\n    public static final List<String> PRIMARY_KEYS = List.of({});\n}}\n",keys.iter().map(|k|literal(k)).collect::<Vec<_>>().join(", "))
        }
        "kotlin" => {
            let fields = request
                .columns
                .iter()
                .map(|c| {
                    Ok(format!(
                        "    val {}: {}",
                        member_name(&c.name, false),
                        ty(c, "kotlin")?
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(",\n");
            format!("import java.math.BigDecimal\n\ndata class {class}(\n{fields}\n) {{\n    companion object {{ val PRIMARY_KEYS = listOf<String>({}) }}\n}}\n",keys.iter().map(|k|literal(k).replace('$',"\\$")).collect::<Vec<_>>().join(", "))
        }
        "csharp" => {
            let fields = request
                .columns
                .iter()
                .map(|c| {
                    Ok(format!(
                        "    [property: JsonPropertyName({})] {} {}",
                        literal(&c.name),
                        ty(c, "csharp")?,
                        member_name(&c.name, true)
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(",\n");
            format!("using System;\nusing System.Collections.Generic;\nusing System.Text.Json;\nusing System.Text.Json.Serialization;\n\npublic sealed record {class}(\n{fields}\n) {{\n    public static IReadOnlyList<string> PrimaryKeys {{ get; }} = new string[] {{ {} }};\n}}\n",keys.iter().map(|k|literal(k)).collect::<Vec<_>>().join(", "))
        }
        "php" => {
            let fields = request
                .columns
                .iter()
                .map(|c| {
                    Ok(format!(
                        "        public {} ${}",
                        ty(c, "php")?,
                        member_name(&c.name, false)
                    ))
                })
                .collect::<Result<Vec<_>, String>>()?
                .join(",\n");
            format!("<?php\ndeclare(strict_types=1);\nnamespace DatabaseWorkbench;\n\nfinal readonly class {class} {{\n    public const PRIMARY_KEYS = [{}];\n    public function __construct(\n{fields}\n    ) {{}}\n}}\n",keys.iter().map(|k|single_literal(k)).collect::<Vec<_>>().join(", "))
        }
        "go" => {
            let uses_json = request
                .columns
                .iter()
                .any(|c| kind(&c.data_type) == Ok("json"));
            let mut s = format!(
                "package workbench\n\n{}type {class} struct {{\n",
                if uses_json {
                    "import \"encoding/json\"\n\n"
                } else {
                    ""
                }
            );
            for c in &request.columns {
                let tag = format!("json:{}", literal(&c.name));
                s += &format!(
                    "    {} {} {}\n",
                    member_name(&c.name, true),
                    ty(c, "go")?,
                    literal(&tag)
                );
            }
            s += &format!(
                "}}\nvar PrimaryKeys = []string{{{}}}\n",
                keys.iter()
                    .map(|k| literal(k))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            s
        }
        "ruby" => {
            let fields = request
                .columns
                .iter()
                .map(|c| format!(":{}", member_name(&c.name, false)))
                .collect::<Vec<_>>()
                .join(", ");
            format!("require 'bigdecimal'\n\nmodule DatabaseWorkbench\n  {class} = Struct.new({fields}, keyword_init: true)\n  PRIMARY_KEYS = [{}].freeze\n  COLUMN_MAPPING = {}.freeze\nend\n",keys.iter().map(|k|single_literal(k)).collect::<Vec<_>>().join(", "),ruby_mapping(request))
        }
        "c" | "cpp" => {
            let cpp = request.language == "cpp";
            let mut s: String = if cpp {
                "#pragma once\n#include <cstdint>\n#include <string>\n#include <vector>\n#include <optional>\n#include <cstddef>\n\n".into()
            } else {
                "#pragma once\n#include <stdint.h>\n#include <stdbool.h>\n#include <stddef.h>\n\ntypedef struct { const unsigned char *data; size_t length; } DbmBytes;\n\n".into()
            };
            s += &format!("{}struct {class} {{\n", if cpp { "" } else { "typedef " });
            for c in &request.columns {
                if !cpp && c.nullable {
                    s += &format!("    bool {}_is_null;\n", member_name(&c.name, false));
                }
                s += &format!(
                    "    {} {};\n",
                    ty(c, if cpp { "cpp" } else { "c" })?,
                    member_name(&c.name, false)
                );
            }
            s += &if cpp {
                "};\n".into()
            } else {
                format!("}} {class};\n")
            };
            s+=&format!("static const size_t DBM_PRIMARY_KEY_COUNT = {};\nstatic const char *const DBM_PRIMARY_KEYS[] = {{ {} }};\n",keys.len(),if keys.is_empty(){if cpp{"nullptr"}else{"NULL"}.into()}else{keys.iter().map(|k|literal(k)).collect::<Vec<_>>().join(", ")});
            s
        }
        _ => unreachable!(),
    };
    let filename = match request.language.as_str() {
        "rust" => "model.rs".into(),
        "python" => "model.py".into(),
        "javascript" => "model.mjs".into(),
        "typescript" => "model.ts".into(),
        "php" => "Model.php".into(),
        "java" => format!("{class}.java"),
        "kotlin" => format!("{class}.kt"),
        "csharp" => format!("{class}.cs"),
        "go" => "model.go".into(),
        "ruby" => "model.rb".into(),
        "cpp" => "model.hpp".into(),
        _ => "model.h".into(),
    };
    Ok(GeneratedProject{files:vec![file(format!("workbench/{filename}"),source),file("workbench/schema-mapping.json",serde_json::to_string_pretty(&json!({"table":request.table,"schema":request.table_schema,"primaryKeys":keys,"columns":meta})).unwrap())],command:String::new(),notes:vec!["Modello di dominio generato dalle colonne del designer, con chiavi e nullabilità. schema-mapping.json conserva i nomi SQL originali anche quando il linguaggio richiede nomi diversi.".into(),"I tipi decimal restano esatti (Decimal/BigDecimal o stringa decimale); la conversione dalle righe native del driver al modello è esplicita. Nessuna tabella o file viene eseguito automaticamente.".into()]})
}
fn ruby_mapping(request: &WorkbenchRequest) -> String {
    format!(
        "{{ {} }}",
        request
            .columns
            .iter()
            .map(|c| format!(
                "{} => {{ name: {}, type: {}, nullable: {} }}",
                single_literal(&member_name(&c.name, false)),
                single_literal(&c.name),
                single_literal(&c.data_type),
                c.nullable
            ))
            .collect::<Vec<_>>()
            .join(", ")
    )
}
fn ty(c: &CodeColumn, language: &str) -> Result<String, String> {
    let k = kind(&c.data_type)?;
    let base = match (language, k) {
        ("rust", "integer") => "i64",
        ("rust", "float") => "f64",
        ("rust", "boolean") => "bool",
        ("rust", "binary") => "Vec<u8>",
        ("rust", "json") => "serde_json::Value",
        ("rust", _) => "String",
        ("python", "integer") => "int",
        ("python", "float") => "float",
        ("python", "boolean") => "bool",
        ("python", "decimal") => "Decimal",
        ("python", "binary") => "bytes",
        ("python", "json") => "Any",
        ("python", _) => "str",
        ("javascript" | "typescript", "integer") => "bigint",
        ("javascript" | "typescript", "float") => "number",
        ("javascript" | "typescript", "boolean") => "boolean",
        ("javascript" | "typescript", "binary") => "Uint8Array",
        ("javascript" | "typescript", "json") => "unknown",
        ("javascript" | "typescript", _) => "string",
        ("java", "integer") => {
            if c.nullable {
                "Long"
            } else {
                "long"
            }
        }
        ("java", "float") => {
            if c.nullable {
                "Double"
            } else {
                "double"
            }
        }
        ("java", "boolean") => {
            if c.nullable {
                "Boolean"
            } else {
                "boolean"
            }
        }
        ("java", "decimal") => "BigDecimal",
        ("java", "binary") => "byte[]",
        ("java", "json") => "Map<String, Object>",
        ("java", _) => "String",
        ("kotlin", "integer") => "Long",
        ("kotlin", "float") => "Double",
        ("kotlin", "boolean") => "Boolean",
        ("kotlin", "decimal") => "BigDecimal",
        ("kotlin", "binary") => "ByteArray",
        ("kotlin", "json") => "Map<String, Any?>",
        ("kotlin", _) => "String",
        ("csharp", "integer") => "long",
        ("csharp", "float") => "double",
        ("csharp", "boolean") => "bool",
        ("csharp", "decimal") => "decimal",
        ("csharp", "binary") => "byte[]",
        ("csharp", "json") => "JsonElement",
        ("csharp", _) => "string",
        ("php", "integer") => "int",
        ("php", "float") => "float",
        ("php", "boolean") => "bool",
        ("php", "json") => "array",
        ("php", _) => "string",
        ("go", "integer") => "int64",
        ("go", "float") => "float64",
        ("go", "boolean") => "bool",
        ("go", "binary") => "[]byte",
        ("go", "json") => "json.RawMessage",
        ("go", _) => "string",
        ("c", "integer") => "int64_t",
        ("c", "float") => "double",
        ("c", "boolean") => "bool",
        ("c", "binary") => "DbmBytes",
        ("c", _) => "const char *",
        ("cpp", "integer") => "std::int64_t",
        ("cpp", "float") => "double",
        ("cpp", "boolean") => "bool",
        ("cpp", "binary") => "std::vector<std::uint8_t>",
        ("cpp", _) => "std::string",
        _ => "String",
    };
    Ok(if c.nullable {
        match language {
            "rust" => format!("Option<{base}>"),
            "python" => format!("Optional[{base}]"),
            "typescript" | "javascript" => format!("{base} | null"),
            "kotlin" | "csharp" => format!("{base}?"),
            "php" => format!("?{base}"),
            "go" => format!("*{base}"),
            "cpp" => format!("std::optional<{base}>"),
            _ => base.into(),
        }
    } else {
        base.into()
    })
}
