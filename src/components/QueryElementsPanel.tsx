import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  BookOpen,
  Check,
  ChevronDown,
  Code2,
  Columns3,
  Database,
  Lightbulb,
  Search,
} from "lucide-react";
import type { Engine, SchemaSnapshot, TableInfo } from "../types";
import { Button, Field } from "./UI";
import {
  CLAUSE_HELP,
  MONGO_HELP,
  dataTables,
  explainQuery,
  functionsFor,
  parseSqlAliases,
  quoteIdentifier,
  tableReference,
} from "../editor/sqlLanguage";
import {
  buildQueryCatalog,
  numericColumn,
  schemaRelations,
} from "../editor/queryCatalog";
import "../query-tools.css";

export interface QueryElementsPanelProps {
  engine: Engine;
  schema: SchemaSnapshot | null;
  query: string;
  selection?: string;
  selectedTable?: string;
  onInsert: (text: string, parameters?: Record<string, unknown>) => void;
  onExplain?: (lesson: string) => void;
}
interface Preview {
  text: string;
  lesson: string;
  parameters?: Record<string, unknown>;
  error?: string;
}
const QUALIFIED = (table: TableInfo) =>
  (table.schema ? table.schema + "." : "") + table.name;
const OPERATORS = [
  "=",
  "<>",
  ">",
  ">=",
  "<",
  "<=",
  "LIKE",
  "IN",
  "BETWEEN",
  "IS NULL",
  "IS NOT NULL",
];

export function QueryElementsPanel({
  engine,
  schema,
  query,
  selection = "",
  selectedTable,
  onInsert,
  onExplain,
}: QueryElementsPanelProps) {
  const tables = useMemo(
    () => dataTables(schema?.engine === engine ? schema : null),
    [schema, engine],
  );
  const [tab, setTab] = useState<
      "schema" | "clauses" | "functions" | "operators"
    >("schema"),
    [tableName, setTableName] = useState(selectedTable ?? ""),
    [search, setSearch] = useState("");
  const table =
    tables.find(
      (table) => QUALIFIED(table) === tableName || table.name === tableName,
    ) ?? tables[0];
  const [columns, setColumns] = useState<string[]>([]),
    [columnName, setColumn] = useState(""),
    [clause, setClause] = useState("WHERE"),
    [operator, setOperator] = useState("="),
    [value, setValue] = useState("Esempio"),
    [descending, setDescending] = useState(false),
    [limit, setLimit] = useState("20"),
    [aggregation, setAggregation] = useState("COUNT"),
    [relationIndex, setRelation] = useState(0);
  const [preview, setPreview] = useState<Preview>({
      text: "",
      lesson: "Scegli un elemento per vedere che cosa verrà inserito e perché.",
    }),
    [inserted, setInserted] = useState(false);
  useEffect(() => {
    if (selectedTable) setTableName(selectedTable);
  }, [selectedTable]);
  useEffect(() => {
    setColumns([]);
    setColumn("");
    setRelation(0);
    setPreview({
      text: "",
      lesson:
        "Scegli un elemento dello schema corrente per prepararne l'inserimento.",
    });
    setInserted(false);
  }, [table?.name, table?.schema, engine]);
  const column =
    table?.columns.find((column) => column.name === columnName) ??
    table?.columns[0];
  useEffect(() => {
    if (column)
      setValue(
        operator === "IN" || operator === "BETWEEN"
          ? numericColumn(column)
            ? "[1, 10]"
            : '["A", "Z"]'
          : numericColumn(column)
            ? "1"
            : /bool/i.test(column.dataType)
              ? "true"
              : column.name === "city"
                ? "Udine"
                : "Esempio",
      );
  }, [table?.name, column?.name]);
  const q = (name: string) => quoteIdentifier(engine, name);
  const aliasBinding = table
    ? parseSqlAliases(query, schema).find(
        (binding) =>
          binding.table.name === table.name &&
          binding.table.schema === table.schema,
      )
    : undefined;
  const alias = aliasBinding
    ? engine === "postgresql" && !aliasBinding.aliasQuoted
      ? aliasBinding.alias.toLowerCase()
      : aliasBinding.alias
    : undefined;
  const field = (name: string) => (alias ? q(alias) + "." : "") + q(name);
  const relations = useMemo(
    () =>
      schemaRelations(schema).filter(
        (relation) =>
          !table ||
          relation.source.name === table.name ||
          relation.target.name === table.name,
      ),
    [schema, table],
  );
  const explanation = useMemo(
    () => explainQuery(query, engine, schema),
    [query, engine, schema],
  );
  const activeStep = explanation.steps.at(-1);
  function selectPreview(next: Preview) {
    setPreview(next);
    setInserted(false);
  }
  function insert(next = preview) {
    if (!next.text || next.error) return;
    onInsert(next.text, next.parameters);
    setPreview(next);
    setInserted(true);
  }
  function toggleColumn(name: string) {
    setColumns((old) =>
      old.includes(name)
        ? old.filter((value) => value !== name)
        : [...old, name],
    );
  }
  function parameterValues(values: unknown[]): {
    placeholders: string[];
    parameters: Record<string, unknown>;
  } {
    const used = explanation.parameters;
    if (engine === "postgresql") {
      const start =
        Math.max(
          0,
          ...used
            .filter((name) => /^\$\d+$/.test(name))
            .map((name) => Number(name.slice(1))),
        ) + 1;
      return {
        placeholders: values.map((_, index) => "$" + (start + index)),
        parameters: Object.fromEntries(
          values.map((value, index) => [String(start + index), value]),
        ),
      };
    }
    const occupied = new Set(used.map((name) => name.replace(/^[:@$]/, ""))),
      placeholders: string[] = [],
      parameters: Record<string, unknown> = {};
    let serial = 1;
    for (const value of values) {
      while (occupied.has("valore_" + serial)) serial++;
      const name = "valore_" + serial++;
      occupied.add(name);
      placeholders.push(":" + name);
      parameters[name] = value;
    }
    return { placeholders, parameters };
  }
  function typedValue(raw: string): unknown {
    if (column && numericColumn(column)) {
      if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw.trim()))
        throw new Error("Inserisci un numero valido per questa colonna.");
      if (/^-?\d+$/.test(raw.trim())) {
        const number = BigInt(raw.trim());
        return number >= BigInt(Number.MIN_SAFE_INTEGER) &&
          number <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(number)
          : raw.trim();
      }
      return raw.trim();
    }
    if (column && /bool/i.test(column.dataType)) {
      if (raw !== "true" && raw !== "false")
        throw new Error("Usa true oppure false per un valore booleano.");
      return raw === "true";
    }
    return raw;
  }
  function buildClause(): Preview {
    if (!table || !column)
      return {
        text: "",
        lesson: "Collega uno schema e scegli una colonna reale.",
        error: "Manca una tabella o colonna.",
      };
    try {
      if (engine === "mongodb") {
        if (clause === "ORDER BY")
          return {
            text: JSON.stringify(
              {
                find: table.name,
                filter: {},
                sort: { [column.name]: descending ? -1 : 1 },
                limit: 20,
              },
              null,
              2,
            ),
            lesson: MONGO_HELP.sort,
          };
        if (clause === "GROUP BY" || clause === "HAVING")
          return {
            text: JSON.stringify(
              {
                aggregate: table.name,
                pipeline: [
                  { $group: { _id: "$" + column.name, totale: { $sum: 1 } } },
                  ...(clause === "HAVING"
                    ? [{ $match: { totale: { $gt: 1 } } }]
                    : []),
                  { $sort: { totale: -1 } },
                ],
                cursor: {},
              },
              null,
              2,
            ),
            lesson:
              clause === "HAVING"
                ? "$match dopo $group filtra i gruppi, come HAVING in SQL."
                : MONGO_HELP.$group,
          };
        const mongoOperator: Record<string, string> = {
          "<>": "$ne",
          ">": "$gt",
          ">=": "$gte",
          "<": "$lt",
          "<=": "$lte",
        };
        const condition =
          operator === "IS NULL"
            ? { $exists: true, $eq: null }
            : operator === "IS NOT NULL"
              ? { $exists: true, $ne: null }
              : operator === "IN"
                ? { $in: parseArray(value) }
                : operator === "BETWEEN"
                  ? (() => {
                      const values = parseArray(value);
                      if (values.length !== 2)
                        throw new Error(
                          "BETWEEN richiede esattamente due valori.",
                        );
                      return { $gte: values[0], $lte: values[1] };
                    })()
                  : operator === "="
                    ? typedValue(value)
                    : mongoOperator[operator]
                      ? { [mongoOperator[operator]]: typedValue(value) }
                      : undefined;
        if (condition === undefined)
          throw new Error(
            "Per un modello MongoDB usa un filtro $regex esplicito nell'editor.",
          );
        return {
          text: JSON.stringify(
            {
              find: table.name,
              filter: { [column.name]: condition },
              limit: 20,
            },
            null,
            2,
          ),
          lesson:
            "Comando Extended JSON completo. Il valore resta un valore JSON, senza eseguire JavaScript.",
        };
      }
      if (clause === "ORDER BY")
        return {
          text:
            "\nORDER BY " +
            field(column.name) +
            (descending ? " DESC" : " ASC"),
          lesson: CLAUSE_HELP[clause].description,
        };
      if (clause === "GROUP BY") {
        const current = columns.filter((name) =>
          table.columns.some((column) => column.name === name),
        );
        return {
          text:
            "\nGROUP BY " +
            (current.length ? current : [column.name]).map(field).join(", "),
          lesson: CLAUSE_HELP[clause].description,
        };
      }
      if (clause === "LIMIT") {
        const number = Number(limit);
        if (!Number.isInteger(number) || number < 1 || number > 10000)
          throw new Error("Scegli un limite intero fra 1 e 10000.");
        return {
          text: "\nLIMIT " + number,
          lesson: CLAUSE_HELP.LIMIT.description,
        };
      }
      if (clause === "HAVING") {
        const params = parameterValues([1]);
        return {
          text: "\nHAVING COUNT(*) > " + params.placeholders[0],
          parameters: params.parameters,
          lesson: CLAUSE_HELP.HAVING.description,
        };
      }
      if (clause === "JOIN") {
        const relation = relations[relationIndex];
        if (!relation)
          throw new Error(
            "Non è stata rilevata una chiave esterna completa. Puoi scrivere una condizione ON nell'editor.",
          );
        const on = relation.sourceColumns
          .map(
            (name, index) =>
              q("s") +
              "." +
              q(name) +
              " = " +
              q("r") +
              "." +
              q(relation.targetColumns[index]),
          )
          .join(" AND ");
        return {
          text: `SELECT ${q("s")}.*, ${q("r")}.*\nFROM ${tableReference(engine, relation.source)} AS ${q("s")}\nINNER JOIN ${tableReference(engine, relation.target)} AS ${q("r")} ON ${on};`,
          lesson:
            "SELECT completa sulla chiave esterna rilevata, comprese tutte le colonne di un eventuale collegamento composto. Scegli nomi diversi per le colonne omonime del risultato.",
        };
      }
      if (operator === "IS NULL" || operator === "IS NOT NULL")
        return {
          text: "\nWHERE " + field(column.name) + " " + operator,
          lesson: CLAUSE_HELP.WHERE.description,
        };
      const values =
        operator === "IN" || operator === "BETWEEN"
          ? parseArray(value)
          : [typedValue(value)];
      if (operator === "BETWEEN" && values.length !== 2)
        throw new Error(
          "BETWEEN richiede un array JSON con esattamente due valori.",
        );
      const params = parameterValues(values),
        expression =
          operator === "IN"
            ? "(" + params.placeholders.join(", ") + ")"
            : operator === "BETWEEN"
              ? params.placeholders[0] + " AND " + params.placeholders[1]
              : params.placeholders[0];
      return {
        text:
          "\nWHERE " + field(column.name) + " " + operator + " " + expression,
        parameters: params.parameters,
        lesson:
          CLAUSE_HELP.WHERE.description +
          " I valori preparati sono mostrati qui e vengono passati separatamente al pannello Parametri.",
      };
    } catch (error) {
      return {
        text: "",
        lesson: "Controlla i valori prima di inserire la clausola.",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  function aggregationQuery(): Preview {
    if (!table || !column)
      return {
        text: "",
        lesson: "Scegli una colonna reale.",
        error: "Schema non disponibile.",
      };
    const measure = table.columns.find(
      (column) => numericColumn(column) && !column.primaryKey,
    );
    if (aggregation !== "COUNT" && !measure)
      return {
        text: "",
        lesson: "Questa funzione richiede una colonna numerica.",
        error: "Nessuna misura numerica rilevata.",
      };
    if (engine === "mongodb")
      return {
        text: JSON.stringify(
          {
            aggregate: table.name,
            pipeline: [
              {
                $group: {
                  _id: "$" + column.name,
                  totale:
                    aggregation === "COUNT"
                      ? { $sum: 1 }
                      : {
                          ["$" + aggregation.toLowerCase()]:
                            "$" + measure!.name,
                        },
                },
              },
            ],
            cursor: {},
          },
          null,
          2,
        ),
        lesson: MONGO_HELP.$group,
      };
    const expression =
      aggregation === "COUNT"
        ? "COUNT(*)"
        : aggregation + "(" + q(measure!.name) + ")";
    return {
      text: `SELECT ${q(column.name)}, ${expression} AS totale\nFROM ${tableReference(engine, table)}\nGROUP BY ${q(column.name)}\nORDER BY totale DESC;`,
      lesson:
        CLAUSE_HELP["GROUP BY"].description +
        " La misura usata è " +
        (aggregation === "COUNT" ? "il numero delle righe" : measure!.name) +
        ".",
    };
  }
  function mongoOperatorPreview(name: string, lesson: string): Preview {
    try {
      const selected = column?.name ?? "_id";
      const editable = table?.columns.find(
        (field) => !field.primaryKey && field.name !== "_id",
      );
      let expression: unknown;
      switch (name) {
        case "$match":
          expression = column ? { [selected]: typedValue(value) } : {};
          break;
        case "$project":
          expression =
            selected === "_id" ? { _id: 1 } : { _id: 0, [selected]: 1 };
          break;
        case "$group":
          expression = {
            _id: column ? "$" + selected : null,
            totale: { $sum: 1 },
          };
          break;
        case "$sort":
          expression = { [selected]: 1 };
          break;
        case "$limit":
          expression = 20;
          break;
        case "$count":
          expression = "totale";
          break;
        case "$exists":
          expression = true;
          break;
        case "$eq":
        case "$ne":
          expression = null;
          break;
        case "$in":
          expression = column && numericColumn(column) ? [1, 10] : ["Esempio"];
          break;
        case "$and":
        case "$or":
          expression = column
            ? [
                { [selected]: typedValue(value) },
                { [selected]: { $exists: true } },
              ]
            : [{}, {}];
          break;
        case "$lookup": {
          const entry = buildQueryCatalog("mongodb", schema).find(
            (entry) => entry.id === "mongodb-lookup" && entry.available,
          );
          if (!entry)
            throw new Error(
              "Per $lookup scegli collezioni e campi corrispondenti nell'editor. La libreria propone l'esempio ordini/clienti soltanto quando i campi esistono.",
            );
          expression = JSON.parse(entry.query).pipeline[0].$lookup;
          lesson = entry.lesson;
          break;
        }
        case "$unwind": {
          const array = table?.columns.find((column) =>
            /array|\[\]/i.test(column.dataType),
          );
          if (selection.trim()) {
            let selectedPath: unknown;
            try {
              selectedPath = JSON.parse(selection);
            } catch {
              selectedPath = selection.trim();
            }
            if (
              typeof selectedPath === "string" &&
              selectedPath.startsWith("$")
            ) {
              expression = selectedPath;
              break;
            }
          }
          if (!array)
            throw new Error(
              "Seleziona nell'editor il riferimento a un array, oppure scegli una collezione con un campo Array campionato.",
            );
          expression = "$" + array.name;
          break;
        }
        case "$set":
        case "$unset":
          if (!editable)
            throw new Error(
              "Non è disponibile un campo aggiornabile diverso dalla chiave _id.",
            );
          expression =
            name === "$set" ? { [editable.name]: "Esempio" } : [editable.name];
          break;
        case "$setWindowFields":
          expression = {
            sortBy: { _id: 1 },
            output: { numero: { $documentNumber: {} } },
          };
          break;
        case "$sum":
        case "$avg":
        case "$min":
        case "$max":
          expression = column ? "$" + selected : 1;
          break;
        default:
          expression = column ? typedValue(value) : 1;
      }
      return { text: JSON.stringify({ [name]: expression }, null, 2), lesson };
    } catch (error) {
      return {
        text: "",
        lesson,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const clausePreview = buildClause();
  const chosen = columns.length
    ? (table?.columns.filter((column) => columns.includes(column.name)) ?? [])
    : [];
  return (
    <aside
      className="query-elements-panel qt-elements"
      aria-label="Elementi della query"
    >
      <header className="qt-elements-title">
        <div>
          <Code2 size={17} />
          <strong>Elementi query</strong>
        </div>
        <small>Seleziona · inserisci · comprendi</small>
      </header>
      <div
        className="qt-tabs compact"
        role="tablist"
        aria-label="Tipi di elementi"
      >
        {(
          [
            ["schema", "Schema"],
            ["clauses", "Clausole"],
            ["functions", "Funzioni"],
            ["operators", "Operatori"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="qt-elements-scroll">
        <Field
          label={
            engine === "mongodb"
              ? "Collezione dello schema"
              : "Tabella o vista dello schema"
          }
        >
          <select
            disabled={!tables.length}
            value={table ? QUALIFIED(table) : ""}
            onChange={(event) => setTableName(event.target.value)}
          >
            {!tables.length && (
              <option value="">Nessuno schema collegato</option>
            )}
            {tables.map((table) => (
              <option key={QUALIFIED(table)} value={QUALIFIED(table)}>
                {QUALIFIED(table)}
              </option>
            ))}
          </select>
        </Field>
        {!tables.length && (
          <p className="qt-inline-help">
            Collega un database o apri il laboratorio per scegliere tabelle e
            colonne reali. Parole chiave e funzioni restano consultabili
            offline.
          </p>
        )}
        {selection && (
          <div className="qt-selection">
            <Check size={13} />
            <span>
              Le funzioni avvolgono la selezione attuale:
              <code>{selection.slice(0, 100)}</code>
            </span>
          </div>
        )}
        {tab === "schema" && (
          <>
            {table && (
              <button
                className="qt-token full"
                onClick={() =>
                  selectPreview({
                    text:
                      engine === "mongodb"
                        ? JSON.stringify(table.name)
                        : tableReference(engine, table),
                    lesson:
                      "Nome reale di " +
                      QUALIFIED(table) +
                      (engine === "mongodb"
                        ? ", come stringa JSON."
                        : ", quotato per il motore della connessione."),
                  })
                }
              >
                <Database size={14} />
                <span>{table.name}</span>
                <ChevronDown size={13} />
              </button>
            )}
            <label className="qt-search small">
              <Search size={13} />
              <input
                aria-label="Cerca colonna"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Cerca una colonna…"
              />
            </label>
            <div className="qt-column-list">
              {table?.columns
                .filter((column) =>
                  column.name.toLowerCase().includes(search.toLowerCase()),
                )
                .slice(0, 150)
                .map((column) => (
                  <div
                    key={column.name}
                    className={columns.includes(column.name) ? "selected" : ""}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={columns.includes(column.name)}
                        onChange={() => toggleColumn(column.name)}
                      />
                      <span>
                        <strong>{column.name}</strong>
                        <small>
                          {column.dataType}
                          {column.primaryKey ? " · PK" : ""}
                          {column.nullable ? " · NULL" : ""}
                        </small>
                      </span>
                    </label>
                    <button
                      title="Prepara l'inserimento della colonna"
                      aria-label={"Inserisci colonna " + column.name}
                      onClick={() => {
                        setColumn(column.name);
                        selectPreview({
                          text:
                            engine === "mongodb"
                              ? JSON.stringify(column.name) + ": 1"
                              : field(column.name),
                          lesson:
                            "Colonna " +
                            column.name +
                            " · " +
                            column.dataType +
                            ". " +
                            (column.nullable
                              ? "Può contenere NULL."
                              : "Non ammette NULL.") +
                            (column.primaryKey
                              ? " Fa parte della chiave primaria."
                              : ""),
                        });
                      }}
                    >
                      <ArrowDownToLine size={13} />
                    </button>
                  </div>
                ))}
            </div>
            {table && (
              <div className="qt-elements-buttons">
                <Button
                  disabled={!chosen.length}
                  onClick={() =>
                    selectPreview({
                      text:
                        engine === "mongodb"
                          ? chosen
                              .map(
                                (column) => JSON.stringify(column.name) + ": 1",
                              )
                              .join(", ")
                          : chosen
                              .map((column) => field(column.name))
                              .join(", "),
                      lesson:
                        "Elenco delle " +
                        chosen.length +
                        " colonne selezionate, da inserire nella proiezione.",
                    })
                  }
                >
                  <Columns3 size={13} />
                  Colonne ({chosen.length})
                </Button>
                <Button
                  onClick={() =>
                    selectPreview({
                      text:
                        engine === "mongodb"
                          ? JSON.stringify(
                              {
                                find: table.name,
                                filter: {},
                                ...(chosen.length
                                  ? {
                                      projection: Object.fromEntries(
                                        chosen.map((column) => [
                                          column.name,
                                          1,
                                        ]),
                                      ),
                                    }
                                  : {}),
                                limit: 20,
                              },
                              null,
                              2,
                            )
                          : "SELECT " +
                            (chosen.length
                              ? chosen
                                  .map((column) => q(column.name))
                                  .join(", ")
                              : "*") +
                            "\nFROM " +
                            tableReference(engine, table) +
                            "\nLIMIT 20;",
                      lesson:
                        "Query completa di lettura sulla tabella corrente. LIMIT contiene il numero di righe; aggiungi ORDER BY per un ordine stabile.",
                    })
                  }
                >
                  SELECT completo
                </Button>
              </div>
            )}
          </>
        )}
        {tab === "clauses" && (
          <div className="qt-clause-builder">
            <Field label="Clausola da preparare">
              <select
                value={clause}
                onChange={(event) => setClause(event.target.value)}
              >
                {(engine === "mongodb"
                  ? ["WHERE", "GROUP BY", "HAVING", "ORDER BY"]
                  : ["WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "JOIN"]
                ).map((clause) => (
                  <option key={clause} value={clause}>
                    {engine === "mongodb"
                      ? (
                          {
                            WHERE: "Filtro · find",
                            "GROUP BY": "$group",
                            HAVING: "$match dopo $group",
                            "ORDER BY": "Ordinamento",
                          } as Record<string, string>
                        )[clause]
                      : clause}
                  </option>
                ))}
              </select>
            </Field>
            {!["LIMIT", "JOIN", "HAVING"].includes(clause) && (
              <Field label="Colonna">
                <select
                  value={column?.name ?? ""}
                  onChange={(event) => setColumn(event.target.value)}
                  disabled={!table}
                >
                  {table?.columns.map((column) => (
                    <option key={column.name}>{column.name}</option>
                  ))}
                </select>
              </Field>
            )}
            {clause === "WHERE" && (
              <>
                <Field label="Operatore">
                  <select
                    value={operator}
                    onChange={(event) => {
                      setOperator(event.target.value);
                      if (
                        event.target.value === "IN" ||
                        event.target.value === "BETWEEN"
                      )
                        setValue(
                          column && numericColumn(column)
                            ? "[1, 10]"
                            : '["A", "Z"]',
                        );
                    }}
                  >
                    {OPERATORS.filter(
                      (operator) => engine !== "mongodb" || operator !== "LIKE",
                    ).map((operator) => (
                      <option key={operator}>{operator}</option>
                    ))}
                  </select>
                </Field>
                {!operator.includes("NULL") && (
                  <Field
                    label={
                      operator === "IN" || operator === "BETWEEN"
                        ? "Valori · array JSON"
                        : "Valore del parametro"
                    }
                  >
                    <input
                      value={value}
                      onChange={(event) => setValue(event.target.value)}
                      placeholder={
                        column && numericColumn(column) ? "1" : "Esempio"
                      }
                    />
                  </Field>
                )}
              </>
            )}
            {clause === "ORDER BY" && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={descending}
                  onChange={(event) => setDescending(event.target.checked)}
                />
                Ordine decrescente
              </label>
            )}
            {clause === "LIMIT" && (
              <Field label="Numero massimo di righe">
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={limit}
                  onChange={(event) => setLimit(event.target.value)}
                />
              </Field>
            )}
            {clause === "JOIN" && (
              <Field label="Relazione rilevata">
                <select
                  value={relationIndex}
                  onChange={(event) => setRelation(Number(event.target.value))}
                  disabled={!relations.length}
                >
                  {!relations.length && <option>Nessuna chiave esterna</option>}
                  {relations.map((relation, index) => (
                    <option key={index} value={index}>
                      {relation.source.name} → {relation.target.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {clausePreview.error && (
              <p className="qt-field-error" role="status">
                {clausePreview.error}
              </p>
            )}
            <Button
              disabled={!!clausePreview.error}
              onClick={() => selectPreview(clausePreview)}
            >
              <Code2 size={14} />
              Prepara{" "}
              {engine === "mongodb"
                ? "comando"
                : clause === "JOIN"
                  ? "SELECT con JOIN"
                  : "clausola"}
            </Button>
            {(clause === "GROUP BY" || clause === "HAVING") && (
              <div className="qt-group-builder">
                <Field label="Funzione aggregata">
                  <select
                    value={aggregation}
                    onChange={(event) => setAggregation(event.target.value)}
                  >
                    {["COUNT", "SUM", "AVG", "MIN", "MAX"].map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </Field>
                <Button
                  disabled={!table}
                  onClick={() => selectPreview(aggregationQuery())}
                >
                  SELECT con raggruppamento
                </Button>
              </div>
            )}
            <p className="qt-inline-help">
              {engine === "mongodb"
                ? MONGO_HELP[
                    clause === "GROUP BY"
                      ? "$group"
                      : clause === "HAVING"
                        ? "$match"
                        : "find"
                  ]
                : CLAUSE_HELP[clause]?.description}
            </p>
          </div>
        )}
        {tab === "functions" && (
          <div className="qt-function-list">
            {engine === "mongodb"
              ? ["$sum", "$avg", "$min", "$max", "$count"].map((name) => (
                  <button
                    key={name}
                    onClick={() => {
                      let operand: unknown = column ? "$" + column.name : 1;
                      if (selection.trim()) {
                        try {
                          operand = JSON.parse(selection);
                        } catch {
                          operand = selection.trim();
                        }
                      }
                      selectPreview({
                        text:
                          name === "$count"
                            ? JSON.stringify({ $count: "totale" }, null, 2)
                            : JSON.stringify({ [name]: operand }, null, 2),
                        lesson:
                          MONGO_HELP[name] ??
                          "Espressione aggregata da usare nel contesto della pipeline, per esempio dentro $group.",
                      });
                    }}
                  >
                    <code>{name}</code>
                    <span>
                      {MONGO_HELP[name] ?? "Espressione di aggregazione."}
                    </span>
                  </button>
                ))
              : functionsFor(engine).map((fn) => (
                  <button
                    key={fn.name}
                    onClick={() => {
                      const operand =
                        selection.trim() ||
                        (column
                          ? field(column.name)
                          : fn.name === "LOWER" || fn.name === "UPPER"
                            ? "''"
                            : "0");
                      const text =
                        fn.name === "COUNT" && !selection
                          ? "COUNT(*)"
                          : fn.name === "ROW_NUMBER" || fn.name === "RANK"
                            ? fn.name +
                              "() OVER (ORDER BY " +
                              (column ? field(column.name) : "1") +
                              ")"
                            : fn.name === "COALESCE"
                              ? "COALESCE(" + operand + ", 0)"
                              : fn.name === "ROUND"
                                ? "ROUND(" + operand + ", 2)"
                                : fn.name === "LAG"
                                  ? "LAG(" +
                                    operand +
                                    ") OVER (ORDER BY " +
                                    (column ? field(column.name) : "1") +
                                    ")"
                                  : fn.name === "DATE_TRUNC"
                                    ? "DATE_TRUNC('day', " +
                                      (selection.trim() ||
                                        "CURRENT_TIMESTAMP") +
                                      ")"
                                    : fn.name === "DATE_FORMAT"
                                      ? "DATE_FORMAT(" +
                                        (selection.trim() ||
                                          "CURRENT_TIMESTAMP") +
                                        ", '%Y-%m-%d')"
                                      : fn.name === "DATE" && !selection
                                        ? "DATE('now')"
                                        : fn.name + "(" + operand + ")";
                      selectPreview({
                        text,
                        lesson:
                          fn.description +
                          (selection
                            ? " La funzione avvolge la selezione attuale."
                            : ""),
                      });
                    }}
                  >
                    <code>{fn.name}</code>
                    <small>{fn.signature}</small>
                    <span>{fn.description}</span>
                  </button>
                ))}
          </div>
        )}
        {tab === "operators" && (
          <>
            <h3 className="qt-section-caption">
              {engine === "mongodb"
                ? "Operatori e stadi"
                : "Parole chiave e operatori"}
            </h3>
            <div className="qt-token-grid">
              {engine === "mongodb"
                ? Object.entries(MONGO_HELP)
                    .filter(([name]) => name.startsWith("$"))
                    .map(([name, lesson]) => (
                      <button
                        key={name}
                        className="qt-token"
                        onClick={() =>
                          selectPreview(mongoOperatorPreview(name, lesson))
                        }
                      >
                        {name}
                      </button>
                    ))
                : [
                    ...Object.keys(CLAUSE_HELP),
                    "AND",
                    "OR",
                    "NOT",
                    "IN",
                    "BETWEEN",
                    "IS NULL",
                    "IS NOT NULL",
                    "AS",
                    "DISTINCT",
                    "ASC",
                    "DESC",
                    "PARTITION BY",
                    "UNION ALL",
                  ]
                    .filter(
                      (name) => engine !== "sqlite" || name !== "TRUNCATE",
                    )
                    .map((name) => (
                      <button
                        key={name}
                        className="qt-token"
                        onClick={() =>
                          selectPreview({
                            text: name + " ",
                            lesson:
                              CLAUSE_HELP[name]?.description ??
                              (name === "IS NULL"
                                ? "Verifica un valore NULL senza usare = NULL."
                                : name === "AND"
                                  ? "Richiede che entrambe le condizioni siano vere."
                                  : name === "OR"
                                    ? "Richiede che almeno una condizione sia vera; usa parentesi quando combini AND e OR."
                                    : "Elemento SQL da combinare con le clausole della query. Il significato dipende dalla posizione."),
                          })
                        }
                      >
                        {name}
                      </button>
                    ))}
            </div>
          </>
        )}
        <section
          className="qt-element-preview"
          aria-label="Anteprima dell'elemento"
        >
          <header>
            <Lightbulb size={15} />
            <strong>Prima di inserire</strong>
          </header>
          {preview.text && (
            <pre className="qt-code">
              <code>{preview.text}</code>
            </pre>
          )}
          {preview.error && <p className="qt-field-error">{preview.error}</p>}
          <p>{preview.lesson}</p>
          {preview.parameters && Object.keys(preview.parameters).length > 0 && (
            <div className="qt-prepared-params">
              <small>Parametri da aggiungere</small>
              <pre>{JSON.stringify(preview.parameters, null, 2)}</pre>
            </div>
          )}
          <div className="qt-elements-buttons">
            <Button
              variant="primary"
              disabled={!preview.text || !!preview.error}
              onClick={() => insert()}
            >
              {inserted ? <Check size={14} /> : <ArrowDownToLine size={14} />}
              Inserisci al cursore
            </Button>
            <Button
              variant="ghost"
              onClick={() => onExplain?.(preview.lesson)}
              disabled={!onExplain}
            >
              <BookOpen size={14} />
              Dettagli
            </Button>
          </div>
        </section>
        {activeStep && (
          <section className="qt-current-help">
            <strong>Nella query · {activeStep.clause}</strong>
            <p>{activeStep.explanation}</p>
            {explanation.warnings.slice(0, 2).map((warning, index) => (
              <p key={index} className="qt-field-error">
                {warning}
              </p>
            ))}
          </section>
        )}
        <p className="qt-footer-note">
          L'elemento sostituisce la selezione o viene inserito al cursore.
          L'esecuzione resta nell'editor.
        </p>
      </div>
    </aside>
  );
}
function parseArray(value: string): unknown[] {
  const parsed = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.some((value) => value !== null && typeof value === "object")
  )
    throw new Error(
      "Inserisci un array JSON non vuoto di numeri, stringhe, booleani o null.",
    );
  return parsed;
}
