import { Plus, Trash2 } from "lucide-react";
import type { ColumnInfo, Engine, SchemaSnapshot, TableInfo } from "../types";
import { Button, Field } from "./UI";
export interface DesignerOptions {
  keys: { column: string; table: string; targetColumn: string }[];
  indexes: { name: string; columns: string; unique: boolean }[];
  validator: string;
  customValidator?: boolean;
}
export const INITIAL_DESIGNER: DesignerOptions = {
  keys: [],
  indexes: [],
  validator:
    '{\n  "$jsonSchema": {\n    "bsonType": "object",\n    "required": ["name"],\n    "properties": {"name": {"bsonType": "string"}}\n  }\n}',
};
export function quoteIdentifier(name: string, engine: Engine) {
  const q = ["mysql", "mariadb"].includes(engine) ? "`" : '"';
  return q + name.replaceAll(q, q + q) + q;
}
export function extendDdl(
  sql: string,
  engine: Engine,
  tableName: string,
  columns: ColumnInfo[],
  options: DesignerOptions,
) {
  if (engine === "mongodb")
    return JSON.stringify(
      {
        create: tableName,
        validator: JSON.parse(options.validator),
        validationLevel: "strict",
      },
      null,
      2,
    );
  const quote = (name: string) => quoteIdentifier(name, engine);
  if (options.keys.length) {
    const keys = options.keys.map((key) => {
      if (!key.column || !key.table || !key.targetColumn)
        throw new Error("Completa tutti i campi delle chiavi esterne.");
      return `FOREIGN KEY (${quote(key.column)}) REFERENCES ${quote(key.table)} (${quote(key.targetColumn)})`;
    });
    sql = sql.replace(/\n\);\s*$/, `,\n  ${keys.join(",\n  ")}\n);`);
  }
  for (const index of options.indexes) {
    const names = index.columns
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    if (!index.name.trim() || !names.length)
      throw new Error("Specifica nome e colonne per ogni indice.");
    if (names.some((name) => !columns.some((c) => c.name === name)))
      throw new Error(
        "Un indice contiene una colonna non presente nella tabella.",
      );
    sql += `\nCREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quote(index.name)} ON ${quote(tableName)} (${names.map(quote).join(", ")});`;
  }
  return sql;
}
export function DesignerExtras({
  engine,
  tableName,
  columns,
  tables,
  options,
  onChange,
  onColumns,
  hideDefaults = false,
}: {
  engine: Engine;
  tableName: string;
  columns: ColumnInfo[];
  tables: TableInfo[];
  options: DesignerOptions;
  onChange: (next: DesignerOptions) => void;
  onColumns: (next: ColumnInfo[]) => void;
  hideDefaults?: boolean;
}) {
  if (engine === "mongodb")
    return (
      <Field label="Validatore MongoDB · Extended JSON">
        <textarea
          className="mono"
          rows={10}
          value={options.validator}
          onChange={(e) => onChange({ ...options, validator: e.target.value })}
        />
      </Field>
    );
  return (
    <div className="stack">
      <div className="separator" />
      {!hideDefaults && (
        <>
          <h3>Valori predefiniti</h3>
          <div className="form-grid">
            {columns.map((column, index) => (
              <Field key={index} label={column.name || `Colonna ${index + 1}`}>
                <input
                  value={column.defaultValue || ""}
                  placeholder="Nessun valore predefinito"
                  onChange={(e) =>
                    onColumns(
                      columns.map((c, i) =>
                        i === index
                          ? { ...c, defaultValue: e.target.value || undefined }
                          : c,
                      ),
                    )
                  }
                />
              </Field>
            ))}
          </div>
        </>
      )}
      <div className="panel-heading">
        <h3>Chiavi esterne</h3>
        <Button
          variant="ghost"
          onClick={() =>
            onChange({
              ...options,
              keys: [
                ...options.keys,
                { column: columns[0]?.name || "", table: "", targetColumn: "" },
              ],
            })
          }
        >
          <Plus size={13} />
          Relazione
        </Button>
      </div>
      {options.keys.map((key, index) => (
        <div className="designer-relation" key={index}>
          <select
            aria-label="Colonna origine relazione"
            value={key.column}
            onChange={(e) =>
              onChange({
                ...options,
                keys: options.keys.map((v, i) =>
                  i === index ? { ...v, column: e.target.value } : v,
                ),
              })
            }
          >
            {columns.map((c) => (
              <option key={c.name}>{c.name}</option>
            ))}
          </select>
          <span>→</span>
          <select
            aria-label="Tabella destinazione relazione"
            value={key.table}
            onChange={(e) =>
              onChange({
                ...options,
                keys: options.keys.map((v, i) =>
                  i === index
                    ? { ...v, table: e.target.value, targetColumn: "" }
                    : v,
                ),
              })
            }
          >
            <option value="">Tabella collegata</option>
            {tables.map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
          </select>
          <select
            aria-label="Colonna destinazione relazione"
            value={key.targetColumn}
            onChange={(e) =>
              onChange({
                ...options,
                keys: options.keys.map((v, i) =>
                  i === index ? { ...v, targetColumn: e.target.value } : v,
                ),
              })
            }
          >
            <option value="">Colonna collegata</option>
            {tables
              .find((t) => t.name === key.table)
              ?.columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
          </select>
          <button
            className="icon-button"
            aria-label="Rimuovi relazione"
            onClick={() =>
              onChange({
                ...options,
                keys: options.keys.filter((_, i) => i !== index),
              })
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="panel-heading">
        <h3>Indici</h3>
        <Button
          variant="ghost"
          onClick={() =>
            onChange({
              ...options,
              indexes: [
                ...options.indexes,
                {
                  name: `idx_${tableName || "table"}_${options.indexes.length + 1}`,
                  columns: columns[0]?.name || "",
                  unique: false,
                },
              ],
            })
          }
        >
          <Plus size={13} />
          Indice
        </Button>
      </div>
      {options.indexes.map((item, index) => (
        <div className="designer-index" key={index}>
          <input
            aria-label="Nome indice"
            value={item.name}
            onChange={(e) =>
              onChange({
                ...options,
                indexes: options.indexes.map((v, i) =>
                  i === index ? { ...v, name: e.target.value } : v,
                ),
              })
            }
          />
          <input
            aria-label="Colonne indice separate da virgola"
            value={item.columns}
            onChange={(e) =>
              onChange({
                ...options,
                indexes: options.indexes.map((v, i) =>
                  i === index ? { ...v, columns: e.target.value } : v,
                ),
              })
            }
            placeholder="colonna1, colonna2"
          />
          <label className="check">
            <input
              type="checkbox"
              checked={item.unique}
              onChange={(e) =>
                onChange({
                  ...options,
                  indexes: options.indexes.map((v, i) =>
                    i === index ? { ...v, unique: e.target.checked } : v,
                  ),
                })
              }
            />
            Univoco
          </label>
          <button
            className="icon-button"
            aria-label="Rimuovi indice"
            onClick={() =>
              onChange({
                ...options,
                indexes: options.indexes.filter((_, i) => i !== index),
              })
            }
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
export interface QueryOptions {
  joinTarget: string;
  joinLeft: string;
  joinRight: string;
  joinType: string;
  groupBy: string;
  orderBy: string;
  descending: boolean;
  pipeline: string;
  mongoOperation: string;
}
export const INITIAL_QUERY_OPTIONS: QueryOptions = {
  joinTarget: "",
  joinLeft: "",
  joinRight: "",
  joinType: "LEFT",
  groupBy: "",
  orderBy: "",
  descending: false,
  pipeline: '[\n  {"$match": {}},\n  {"$limit": 20}\n]',
  mongoOperation: "find",
};
export function buildQuery(
  schema: SchemaSnapshot,
  table: TableInfo,
  selectedColumns: string[],
  filter: string,
  limit: number,
  options: QueryOptions,
) {
  if (schema.engine === "mongodb")
    return options.mongoOperation === "aggregate"
      ? JSON.stringify(
          {
            aggregate: table.name,
            pipeline: JSON.parse(options.pipeline),
            cursor: {},
          },
          null,
          2,
        )
      : JSON.stringify(
          {
            find: table.name,
            filter: filter ? JSON.parse(filter) : {},
            limit,
            ...(selectedColumns.length
              ? {
                  projection: Object.fromEntries(
                    selectedColumns.map((name) => [name, 1]),
                  ),
                }
              : {}),
            ...(options.orderBy
              ? { sort: { [options.orderBy]: options.descending ? -1 : 1 } }
              : {}),
          },
          null,
          2,
        );
  const q = (name: string) => quoteIdentifier(name, schema.engine);
  const qualified = (item: TableInfo) =>
    item.schema ? `${q(item.schema)}.${q(item.name)}` : q(item.name);
  const joined = schema.tables.find((t) => t.name === options.joinTarget);
  const field = (name: string) => (joined ? `t.${q(name)}` : q(name));
  if (joined && (!options.joinLeft || !options.joinRight))
    throw new Error("Scegli le colonne per la condizione JOIN.");
  const fields = options.groupBy
    ? `${field(options.groupBy)}, COUNT(*) AS ${q("total")}`
    : selectedColumns.length
      ? selectedColumns.map(field).join(", ")
      : joined
        ? "t.*, j.*"
        : "*";
  return `SELECT ${fields}\nFROM ${qualified(table)}${joined ? " AS t" : ""}${joined ? `\n${options.joinType} JOIN ${qualified(joined)} AS j ON t.${q(options.joinLeft)} = j.${q(options.joinRight)}` : ""}${filter ? `\nWHERE ${filter}` : ""}${options.groupBy ? `\nGROUP BY ${field(options.groupBy)}` : ""}${options.orderBy ? `\nORDER BY ${options.orderBy === "total" && options.groupBy ? q("total") : field(options.orderBy)} ${options.descending ? "DESC" : "ASC"}` : ""}\nLIMIT ${Math.max(1, Math.min(10000, limit))};`;
}
export function QueryBuilderExtras({
  schema,
  table,
  options,
  onChange,
}: {
  schema: SchemaSnapshot;
  table: TableInfo;
  options: QueryOptions;
  onChange: (next: QueryOptions) => void;
}) {
  const joined = schema.tables.find((t) => t.name === options.joinTarget);
  const patch = (values: Partial<QueryOptions>) =>
    onChange({ ...options, ...values });
  function join(name: string) {
    const relation = table.foreignKeys.find(
      (k) => (k.referencedTable || k.targetTable) === name,
    );
    patch({
      joinTarget: name,
      joinLeft:
        relation?.columns?.[0] ||
        relation?.column ||
        table.columns[0]?.name ||
        "",
      joinRight:
        relation?.referencedColumns?.[0] ||
        relation?.referencedColumn ||
        schema.tables
          .find((t) => t.name === name)
          ?.columns.find((c) => c.primaryKey)?.name ||
        "",
    });
  }
  return (
    <div className="stack">
      <div className="separator" />
      {schema.engine === "mongodb" ? (
        <>
          <Field label="Operazione MongoDB">
            <select
              value={options.mongoOperation}
              onChange={(e) => patch({ mongoOperation: e.target.value })}
            >
              <option value="find">Ricerca documenti</option>
              <option value="aggregate">Pipeline aggregazione</option>
            </select>
          </Field>
          {options.mongoOperation === "aggregate" && (
            <Field label="Pipeline Extended JSON">
              <textarea
                className="mono"
                rows={11}
                value={options.pipeline}
                onChange={(e) => patch({ pipeline: e.target.value })}
              />
            </Field>
          )}
        </>
      ) : (
        <>
          <h3>Collega una seconda tabella</h3>
          <div className="form-grid">
            <Field label="Tabella JOIN">
              <select
                value={options.joinTarget}
                onChange={(e) => join(e.target.value)}
              >
                <option value="">Nessuna JOIN</option>
                {schema.tables
                  .filter((t) => t.name !== table.name)
                  .map((t) => (
                    <option key={t.name}>{t.name}</option>
                  ))}
              </select>
            </Field>
            <Field label="Tipo JOIN">
              <select
                value={options.joinType}
                onChange={(e) => patch({ joinType: e.target.value })}
                disabled={!joined}
              >
                <option value="LEFT">
                  LEFT JOIN · tutte le righe di origine
                </option>
                <option value="INNER">INNER JOIN · corrispondenze</option>
              </select>
            </Field>
            {joined && (
              <>
                <Field label={`${table.name} · colonna di origine (t)`}>
                  <select
                    value={options.joinLeft}
                    onChange={(e) => patch({ joinLeft: e.target.value })}
                  >
                    {table.columns.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`${joined.name} · colonna collegata (j)`}>
                  <select
                    value={options.joinRight}
                    onChange={(e) => patch({ joinRight: e.target.value })}
                  >
                    <option value="">Scegli colonna</option>
                    {joined.columns.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                </Field>
              </>
            )}
          </div>
          <Field
            label="Raggruppa e conta · GROUP BY"
            hint="Genera la colonna di raggruppamento e COUNT(*) AS total."
          >
            <select
              value={options.groupBy}
              onChange={(e) => patch({ groupBy: e.target.value, orderBy: "" })}
            >
              <option value="">Nessun raggruppamento</option>
              {table.columns.map((c) => (
                <option key={c.name}>{c.name}</option>
              ))}
            </select>
          </Field>
        </>
      )}
      <div className="form-grid">
        <Field label="Ordina per">
          <select
            value={options.orderBy}
            onChange={(e) => patch({ orderBy: e.target.value })}
          >
            <option value="">Nessun ordinamento</option>
            {(options.groupBy
              ? [options.groupBy, "total"]
              : table.columns.map((c) => c.name)
            ).map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </Field>
        <Field label="Direzione">
          <select
            value={options.descending ? "desc" : "asc"}
            onChange={(e) => patch({ descending: e.target.value === "desc" })}
          >
            <option value="asc">Crescente</option>
            <option value="desc">Decrescente</option>
          </select>
        </Field>
      </div>
    </div>
  );
}
