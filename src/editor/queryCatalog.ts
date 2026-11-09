import type {
  ColumnInfo,
  Engine,
  HistoryEntry,
  SavedQuery,
  SchemaSnapshot,
  TableInfo,
} from "../types";
import { dataTables, quoteIdentifier, tableReference } from "./sqlLanguage";

export type QueryLevel = "Base" | "Intermedio" | "Avanzato";
export type QueryCategory =
  | "SELECT"
  | "FILTER"
  | "JOIN"
  | "GROUP"
  | "HAVING"
  | "SUBQUERY"
  | "CTE"
  | "WINDOW"
  | "CRUD"
  | "DDL"
  | "INDEX"
  | "TRANSACTIONS"
  | "PIPELINE";
export const QUERY_CATEGORIES: Record<QueryCategory, string> = {
  SELECT: "Lettura e proiezione",
  FILTER: "Filtri e ordinamento",
  JOIN: "Relazioni e JOIN",
  GROUP: "Raggruppamenti",
  HAVING: "Filtri sui gruppi",
  SUBQUERY: "Sottoquery",
  CTE: "CTE · WITH",
  WINDOW: "Funzioni finestra",
  CRUD: "Inserimento, modifica e cancellazione",
  DDL: "Struttura e viste",
  INDEX: "Indici e piano",
  TRANSACTIONS: "Transazioni",
  PIPELINE: "Pipeline MongoDB",
};
export interface QueryParameter {
  name: string;
  key: string;
  type: "integer" | "number" | "string" | "boolean" | "null" | "json";
  example: unknown;
  description: string;
  placeholder: string;
}
export interface QueryTemplate {
  id: string;
  title: string;
  engine: Engine;
  category: QueryCategory;
  level: QueryLevel;
  description: string;
  lesson: string;
  query: string;
  parameters: Record<string, unknown>;
  parameterDefinitions: QueryParameter[];
  available: boolean;
  unavailableReason?: string;
  usesDemoSchema: boolean;
  readOnly: boolean;
  sourceUrls: string[];
  executionMode?: "script";
  assumptions?: string[];
}
export interface QueryActionEntry {
  id: string;
  title: string;
  query: string;
  engine: Engine;
  parameters: Record<string, unknown>;
  lesson: string;
  source: "catalog" | "saved" | "history";
  sourceId?: string;
  readOnly?: boolean;
  executionMode?: "current" | "selection" | "script";
}
export type LibraryEntry = QueryActionEntry;
export interface SchemaRelation {
  source: TableInfo;
  target: TableInfo;
  sourceColumns: string[];
  targetColumns: string[];
}
const SOURCE: Record<Engine, string[]> = {
  sqlite: [
    "https://www.sqlite.org/lang_select.html",
    "https://www.sqlite.org/lang_with.html",
    "https://www.sqlite.org/windowfunctions.html",
    "https://www.sqlite.org/lang_transaction.html",
  ],
  postgresql: [
    "https://www.postgresql.org/docs/current/sql-select.html",
    "https://www.postgresql.org/docs/current/queries-with.html",
    "https://www.postgresql.org/docs/current/tutorial-window.html",
  ],
  mysql: [
    "https://dev.mysql.com/doc/refman/8.4/en/select.html",
    "https://dev.mysql.com/doc/refman/8.4/en/window-functions.html",
    "https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html",
  ],
  mariadb: [
    "https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/select",
    "https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/common-table-expressions",
  ],
  mongodb: [
    "https://www.mongodb.com/docs/manual/reference/command/find/",
    "https://www.mongodb.com/docs/manual/aggregation/",
    "https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/",
  ],
};
const column = (
  name: string,
  dataType = "TEXT",
  primaryKey = false,
  nullable = true,
): ColumnInfo => ({ name, dataType, primaryKey, nullable });
/** Mirrors the existing shop seed; this is never presented as a connected schema. */
export const QUERY_DEMO_SCHEMA: SchemaSnapshot = {
  engine: "sqlite",
  database: "shop",
  tables: [
    {
      name: "customers",
      kind: "table",
      columns: [
        column("id", "INTEGER", true, false),
        column("name", "TEXT", false, false),
        column("city"),
        column("email"),
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: "products",
      kind: "table",
      columns: [
        column("id", "INTEGER", true, false),
        column("name", "TEXT", false, false),
        column("price", "NUMERIC", false, false),
        column("stock", "INTEGER", false, false),
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      name: "orders",
      kind: "table",
      columns: [
        column("id", "INTEGER", true, false),
        column("customer_id", "INTEGER", false, false),
        column("created_at", "TEXT", false, false),
        column("status", "TEXT", false, false),
      ],
      indexes: [],
      foreignKeys: [
        {
          columns: ["customer_id"],
          referencedTable: "customers",
          referencedColumns: ["id"],
        },
      ],
    },
    {
      name: "order_items",
      kind: "table",
      columns: [
        column("order_id", "INTEGER", true, false),
        column("product_id", "INTEGER", true, false),
        column("quantity", "INTEGER", false, false),
        column("unit_price", "NUMERIC", false, false),
      ],
      indexes: [],
      foreignKeys: [
        {
          columns: ["order_id"],
          referencedTable: "orders",
          referencedColumns: ["id"],
        },
        {
          columns: ["product_id"],
          referencedTable: "products",
          referencedColumns: ["id"],
        },
      ],
    },
  ],
};
export function schemaRelations(
  schema: SchemaSnapshot | null,
): SchemaRelation[] {
  const tables = dataTables(schema),
    result: SchemaRelation[] = [];
  for (const source of tables)
    for (const fk of source.foreignKeys) {
      const name = fk.referencedTable ?? fk.targetTable;
      const target = tables.find(
        (table) =>
          table.name === name ||
          (table.schema ? table.schema + "." + table.name : table.name) ===
            name,
      );
      const sourceColumns = fk.columns ?? (fk.column ? [fk.column] : []);
      const targetColumns =
        fk.referencedColumns ??
        fk.targetColumns ??
        (fk.referencedColumn ? [fk.referencedColumn] : []);
      if (
        target &&
        sourceColumns.length &&
        sourceColumns.length === targetColumns.length &&
        sourceColumns.every((name) =>
          source.columns.some((column) => column.name === name),
        ) &&
        targetColumns.every((name) =>
          target.columns.some((column) => column.name === name),
        )
      )
        result.push({ source, target, sourceColumns, targetColumns });
    }
  return result;
}
export function numericColumn(column: ColumnInfo): boolean {
  return /int|numeric|decimal|real|float|double|number|long/i.test(
    column.dataType,
  );
}
function textColumn(column: ColumnInfo): boolean {
  return /text|char|string|uuid/i.test(column.dataType);
}
function exampleValue(column: ColumnInfo): unknown {
  if (column.primaryKey)
    return numericColumn(column) ? 900001 : "esempio-900001";
  if (/(?:^|_)id$/i.test(column.name) && numericColumn(column)) return 1;
  if (numericColumn(column)) return 1;
  if (/bool/i.test(column.dataType)) return true;
  if (
    /date|time/i.test(column.dataType) ||
    /created_at|updated_at/.test(column.name)
  )
    return "2026-11-09";
  if (/json|document|object/i.test(column.dataType)) return "{}";
  return column.name.toLowerCase() === "status" ? "pending" : "Esempio";
}
type AddTemplate = (
  id: string,
  title: string,
  category: QueryCategory,
  level: QueryLevel,
  query: string,
  description: string,
  lesson: string,
  options?: Partial<QueryTemplate>,
) => number;

export function buildQueryCatalog(
  engine: Engine,
  schema: SchemaSnapshot | null,
): QueryTemplate[] {
  const connected = !!schema && schema.engine === engine,
    real = connected ? dataTables(schema) : [],
    usesDemoSchema = !real.length;
  const tables = real.length ? real : QUERY_DEMO_SCHEMA.tables,
    activeSchema = { engine, database: schema?.database ?? "shop", tables };
  const table = tables.find((table) => table.name === "customers") ?? tables[0];
  const primary = table.columns.filter((column) => column.primaryKey),
    key = primary[0] ?? table.columns[0];
  const descriptive =
    table.columns.find((column) => column.name === "name") ??
    table.columns.find((column) => textColumn(column) && !column.primaryKey) ??
    key;
  const group =
    table.columns.find((column) =>
      /city|category|status|department/i.test(column.name),
    ) ?? descriptive;
  const nullable =
    table.columns.find((column) => column.nullable) ?? descriptive;
  const measureTable =
    tables.find((table) =>
      table.columns.some(
        (column) =>
          numericColumn(column) &&
          !column.primaryKey &&
          !/_id$/i.test(column.name),
      ),
    ) ?? table;
  const measure = measureTable.columns.find(
    (column) =>
      numericColumn(column) && !column.primaryKey && !/_id$/i.test(column.name),
  );
  const measureGroup =
    measureTable.columns.find(
      (column) => textColumn(column) && !column.primaryKey,
    ) ?? measureTable.columns[0];
  const relation =
    schemaRelations(activeSchema).find(
      (relation) =>
        relation.source.name === "orders" &&
        relation.target.name === "customers",
    ) ?? schemaRelations(activeSchema)[0];
  const q = (name: string) => quoteIdentifier(engine, name),
    t = (table: TableInfo) => tableReference(engine, table),
    ref = (alias: string, name: string) => q(alias) + "." + q(name);
  const result: QueryTemplate[] = [];
  const add: AddTemplate = (
    id,
    title,
    category,
    level,
    query,
    description,
    lesson,
    options = {},
  ) =>
    result.push({
      id: engine + "-" + id,
      title,
      engine,
      category,
      level,
      query,
      description,
      lesson,
      parameters: {},
      parameterDefinitions: [],
      available: !usesDemoSchema,
      unavailableReason: usesDemoSchema
        ? "Apri il dataset Negozio e ordini o collega un database per adattare l'esempio a uno schema reale."
        : undefined,
      usesDemoSchema,
      readOnly: true,
      sourceUrls: SOURCE[engine],
      ...options,
    });
  const parameter = (
    name: string,
    example: unknown,
    type: QueryParameter["type"],
    description: string,
    index = 1,
  ) => {
    const sql = engine === "postgresql" ? "$" + index : ":" + name,
      key = engine === "postgresql" ? String(index) : name;
    return {
      sql,
      parameters: { [key]: example },
      parameterDefinitions: [
        { name, key, type, example, description, placeholder: sql },
      ],
    };
  };
  if (engine === "mongodb")
    return mongoCatalog(connected ? activeSchema : null, add, result);
  add(
    "constant",
    "Una prima query senza tabelle",
    "SELECT",
    "Base",
    "SELECT 1 AS risultato;",
    "Esegui un'espressione semplice.",
    "SELECT può calcolare un valore anche senza FROM. AS dà un nome alla colonna del risultato.",
    { available: true, unavailableReason: undefined, usesDemoSchema: false },
  );
  const selected = [
    ...new Set([
      ...table.columns.slice(0, 4).map((column) => column.name),
      key.name,
    ]),
  ]
    .map(q)
    .join(", ");
  add(
    "select-all",
    "Leggere le prime righe",
    "SELECT",
    "Base",
    `SELECT *\nFROM ${t(table)}\nORDER BY ${q(key.name)}\nLIMIT 20;`,
    "Esplora una tabella con un limite esplicito.",
    "FROM sceglie l'origine. ORDER BY definisce l'ordine e LIMIT contiene il risultato. In produzione seleziona solo le colonne necessarie.",
  );
  add(
    "projection",
    "Scegliere le colonne",
    "SELECT",
    "Base",
    `SELECT ${selected}\nFROM ${t(table)}\nORDER BY ${q(key.name)};`,
    "Proietta colonne dello schema corrente.",
    "La proiezione è l'elenco dopo SELECT. I nomi sono presi dallo schema e quotati con la sintassi del motore.",
  );
  add(
    "distinct",
    "Eliminare valori ripetuti",
    "SELECT",
    "Base",
    `SELECT DISTINCT ${q(group.name)}\nFROM ${t(table)}\nORDER BY ${q(group.name)};`,
    "Trova i valori distinti di una colonna.",
    "DISTINCT elimina duplicati nell'intera combinazione delle colonne selezionate; non modifica la tabella.",
  );
  const filter = parameter(
    "valore",
    group.name === "city" ? "Udine" : "Esempio",
    "string",
    "Valore confrontato con " + group.name,
  );
  add(
    "equals",
    "Filtrare con un parametro",
    "FILTER",
    "Base",
    `SELECT ${selected}\nFROM ${t(table)}\nWHERE ${q(group.name)} = ${filter.sql}\nORDER BY ${q(key.name)};`,
    "Separa la query dal valore cercato.",
    "WHERE filtra le righe prima di eventuali aggregazioni. Il valore viene fornito nel pannello Parametri, senza concatenarlo al testo SQL.",
    filter,
  );
  const minimum = parameter(
    "minimo",
    0,
    "number",
    "Soglia minima per " + key.name,
  );
  add(
    "range",
    "Confronto e ordinamento",
    "FILTER",
    "Base",
    `SELECT ${selected}\nFROM ${t(table)}\nWHERE ${q(key.name)} >= ${minimum.sql}\nORDER BY ${q(key.name)} DESC\nLIMIT 20;`,
    "Usa un confronto sulla colonna chiave.",
    "I confronti dipendono dal tipo della colonna. DESC ordina in modo decrescente; modifica la soglia nel pannello Parametri.",
    {
      ...minimum,
      available: !usesDemoSchema && numericColumn(key),
      unavailableReason: !numericColumn(key)
        ? "Questo esempio richiede una chiave numerica."
        : usesDemoSchema
          ? "Collega uno schema o apri il dataset di esempio."
          : undefined,
    },
  );
  const pattern = parameter(
    "modello",
    "%a%",
    "string",
    "% corrisponde a zero o più caratteri; _ a un solo carattere",
  );
  add(
    "like",
    "Cercare nel testo con LIKE",
    "FILTER",
    "Base",
    `SELECT ${selected}\nFROM ${t(table)}\nWHERE ${q(descriptive.name)} LIKE ${pattern.sql}\nORDER BY ${q(key.name)};`,
    "Cerca un modello testuale.",
    "LIKE usa % e _. Sensibilità a maiuscole e accenti dipende da motore e collation; non presumere regole identiche fra database.",
    { ...pattern, available: !usesDemoSchema && textColumn(descriptive) },
  );
  add(
    "null",
    "Trovare valori NULL",
    "FILTER",
    "Base",
    `SELECT ${selected}\nFROM ${t(table)}\nWHERE ${q(nullable.name)} IS NULL\nORDER BY ${q(key.name)};`,
    "Distingui assenza di valore e stringa vuota.",
    "NULL non equivale a ''. Per verificarlo usa IS NULL; = NULL non restituisce il confronto booleano atteso.",
  );
  const first = parameter("primo", 1, "integer", "Prima chiave cercata", 1),
    second = parameter("secondo", 3, "integer", "Seconda chiave cercata", 2);
  add(
    "in",
    "Cercare in un insieme",
    "FILTER",
    "Intermedio",
    `SELECT ${selected}\nFROM ${t(table)}\nWHERE ${q(key.name)} IN (${first.sql}, ${second.sql})\nORDER BY ${q(key.name)};`,
    "Confronta una colonna con più valori.",
    "IN verifica se il valore appartiene all'insieme. I singoli elementi sono parametri distinti; non passare una lista come stringa separata da virgole.",
    {
      parameters: { ...first.parameters, ...second.parameters },
      parameterDefinitions: [
        ...first.parameterDefinitions,
        ...second.parameterDefinitions,
      ],
    },
  );
  add(
    "count",
    "Contare righe e valori presenti",
    "GROUP",
    "Base",
    `SELECT COUNT(*) AS totale_righe,\n       COUNT(${q(nullable.name)}) AS valori_presenti\nFROM ${t(table)};`,
    "Confronta COUNT(*) e COUNT(colonna).",
    "COUNT(*) conta tutte le righe. COUNT(colonna) esclude i NULL: la differenza misura quante righe non hanno quel valore.",
  );
  add(
    "group",
    "Contare per gruppo",
    "GROUP",
    "Intermedio",
    `SELECT ${q(group.name)}, COUNT(*) AS totale\nFROM ${t(table)}\nGROUP BY ${q(group.name)}\nORDER BY totale DESC, ${q(group.name)};`,
    "Raggruppa per una colonna reale.",
    "GROUP BY produce una riga per ogni valore del gruppo. Le altre espressioni in SELECT devono essere aggregate, per esempio COUNT(*).",
  );
  const threshold = parameter(
    "minimo_righe",
    1,
    "integer",
    "Numero minimo di righe nel gruppo",
  );
  add(
    "having",
    "Filtrare gruppi con HAVING",
    "HAVING",
    "Intermedio",
    `SELECT ${q(group.name)}, COUNT(*) AS totale\nFROM ${t(table)}\nGROUP BY ${q(group.name)}\nHAVING COUNT(*) > ${threshold.sql}\nORDER BY totale DESC, ${q(group.name)};`,
    "Filtra i risultati dell'aggregazione.",
    "WHERE lavora sulle righe prima del gruppo. HAVING valuta i gruppi e può confrontare COUNT(*). Non usare WHERE COUNT(*) > ….",
    threshold,
  );
  if (measure) {
    add(
      "summary",
      "SUM, AVG, MIN e MAX",
      "GROUP",
      "Intermedio",
      `SELECT SUM(${q(measure.name)}) AS somma,\n       AVG(${q(measure.name)}) AS media,\n       MIN(${q(measure.name)}) AS minimo,\n       MAX(${q(measure.name)}) AS massimo\nFROM ${t(measureTable)};`,
      "Riepiloga una colonna numerica di " + measureTable.name + ".",
      "Le funzioni aggregate ignorano i NULL. Somma e media hanno significato solo se tipo e unità della colonna sono adatti; i nomi vengono dallo schema corrente.",
    );
    add(
      "above-average",
      "Una sottoquery scalare",
      "SUBQUERY",
      "Intermedio",
      `SELECT *\nFROM ${t(measureTable)}\nWHERE ${q(measure.name)} > (\n  SELECT AVG(${q(measure.name)}) FROM ${t(measureTable)}\n)\nORDER BY ${q(measure.name)} DESC;`,
      "Trova valori superiori alla media.",
      "La SELECT interna restituisce un unico valore, usato dal confronto esterno. Una sottoquery scalare deve produrre al massimo una riga.",
    );
    add(
      "window-total",
      "Totale progressivo con una finestra",
      "WINDOW",
      "Avanzato",
      `SELECT ${q(measureTable.columns[0].name)}, ${q(measure.name)},\n       SUM(${q(measure.name)}) OVER (\n         ORDER BY ${q(measureTable.columns[0].name)}\n         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW\n       ) AS totale_progressivo\nFROM ${t(measureTable)}\nORDER BY ${q(measureTable.columns[0].name)};`,
      "Mantieni ogni riga e aggiungi un cumulato.",
      "OVER definisce la finestra. ROWS rende esplicito il frame: dall'inizio fino alla riga corrente. Non è un GROUP BY: le righe originali restano visibili.",
    );
    add(
      "rank",
      "Classificare con RANK",
      "WINDOW",
      "Avanzato",
      `SELECT ${q(measureGroup.name)}, ${q(measure.name)},\n       RANK() OVER (ORDER BY ${q(measure.name)} DESC) AS posizione\nFROM ${t(measureTable)}\nORDER BY posizione, ${q(measureGroup.name)};`,
      "Confronta valori con pari merito.",
      "RANK assegna la stessa posizione ai valori uguali e lascia salti; ROW_NUMBER attribuisce invece un numero diverso a ogni riga.",
    );
  }
  add(
    "cte",
    "Organizzare la query con WITH",
    "CTE",
    "Intermedio",
    `WITH righe_origine AS (\n  SELECT ${selected}\n  FROM ${t(table)}\n)\nSELECT *\nFROM righe_origine\nORDER BY ${q(key.name)}\nLIMIT 20;`,
    "Dai un nome al primo passaggio.",
    "Una CTE vive solo nello statement corrente. Il nome righe_origine è definito dalla query stessa, non è una tabella da creare nel database.",
  );
  add(
    "row-number",
    "Numerare le righe",
    "WINDOW",
    "Intermedio",
    `SELECT ${selected},\n       ROW_NUMBER() OVER (ORDER BY ${q(key.name)}) AS numero_riga\nFROM ${t(table)}\nORDER BY ${q(key.name)};`,
    "Aggiungi una numerazione al risultato.",
    "ROW_NUMBER calcola il numero nel risultato e non modifica la chiave dei dati. Usa un ordinamento univoco per una numerazione stabile.",
  );
  if (relation) {
    const on = relation.sourceColumns
      .map(
        (name, index) =>
          ref("o", name) + " = " + ref("c", relation.targetColumns[index]),
      )
      .join(" AND ");
    const from = `${t(relation.target)} AS ${q("c")}\nINNER JOIN ${t(relation.source)} AS ${q("o")} ON ${on}`;
    add(
      "inner-join",
      "Collegare righe con INNER JOIN",
      "JOIN",
      "Intermedio",
      `SELECT ${q("c")}.*, ${q("o")}.*\nFROM ${from};`,
      "Usa una chiave esterna dello schema.",
      "La relazione viene dai metadati, incluse eventuali chiavi composte. INNER JOIN mantiene solo le corrispondenze. Con colonne omonime scegli alias espliciti per il risultato.",
    );
    const parentKey =
        relation.target.columns.find((column) => column.primaryKey) ??
        relation.target.columns[0],
      parentName =
        relation.target.columns.find(
          (column) => textColumn(column) && !column.primaryKey,
        ) ?? parentKey;
    const selectedParent = [parentKey.name, parentName.name]
      .filter((name, index, all) => all.indexOf(name) === index)
      .map((name) => ref("c", name))
      .join(", ");
    add(
      "left-join",
      "Contare anche chi non ha corrispondenze",
      "JOIN",
      "Intermedio",
      `SELECT ${selectedParent}, COUNT(${ref("o", relation.sourceColumns[0])}) AS righe_collegate\nFROM ${t(relation.target)} AS ${q("c")}\nLEFT JOIN ${t(relation.source)} AS ${q("o")} ON ${on}\nGROUP BY ${selectedParent}\nORDER BY ${ref("c", parentKey.name)};`,
      "LEFT JOIN mantiene tutte le righe a sinistra.",
      "Conta una colonna del lato destro, non COUNT(*): le righe senza corrispondenza devono ottenere zero. Le colonne non aggregate compaiono anche in GROUP BY.",
    );
    add(
      "exists",
      "Verificare una corrispondenza con EXISTS",
      "SUBQUERY",
      "Avanzato",
      `SELECT ${q("c")}.*\nFROM ${t(relation.target)} AS ${q("c")}\nWHERE EXISTS (\n  SELECT 1\n  FROM ${t(relation.source)} AS ${q("o")}\n  WHERE ${on}\n)\nORDER BY ${ref("c", parentKey.name)};`,
      "Cerca almeno una riga collegata senza duplicare il genitore.",
      "La sottoquery è correlata: usa c, alias della query esterna. EXISTS verifica la presenza di una riga e non riporta tutte le corrispondenze.",
    );
  } else
    add(
      "join-unavailable",
      "JOIN fra tabelle collegate",
      "JOIN",
      "Intermedio",
      "",
      "Lo schema non espone una chiave esterna utilizzabile.",
      "Seleziona le colonne corrispondenti nel pannello Elementi. Non viene inventata una relazione fra tabelle solo perché i nomi si assomigliano.",
      {
        available: false,
        unavailableReason:
          "Nessuna chiave esterna completa rilevata nello schema corrente.",
      },
    );
  const insertColumns = table.columns.filter(
      (column) => !column.nullable && column.defaultValue == null,
    ),
    insertDefs = insertColumns.map((column, index) =>
      parameter(
        "valore_" + (index + 1),
        exampleValue(column),
        numericColumn(column)
          ? "number"
          : /bool/i.test(column.dataType)
            ? "boolean"
            : "string",
        "Valore di " + column.name,
        index + 1,
      ),
    );
  const insertAvailable =
    !usesDemoSchema &&
    !insertColumns.some((column) =>
      /blob|binary|bytea|\[\]/i.test(column.dataType),
    );
  const insertQuery = insertColumns.length
    ? `INSERT INTO ${t(table)} (${insertColumns.map((column) => q(column.name)).join(", ")})\nVALUES (${insertDefs.map((def) => def.sql).join(", ")});`
    : `INSERT INTO ${t(table)} ${engine === "mysql" || engine === "mariadb" ? "() VALUES ()" : "DEFAULT VALUES"};`;
  add(
    "insert",
    "Inserire una riga con parametri",
    "CRUD",
    "Base",
    insertQuery,
    "Prepara i campi obbligatori senza default.",
    "I valori sono esempi da controllare. Verifica chiavi, vincoli CHECK/UNIQUE e relazioni. Un ID già presente non può essere inserito nuovamente.",
    {
      readOnly: false,
      available: insertAvailable,
      unavailableReason: insertAvailable
        ? undefined
        : "Occorre uno schema reale con campi obbligatori scalari; i valori complessi vanno preparati manualmente.",
      parameters: Object.assign({}, ...insertDefs.map((def) => def.parameters)),
      parameterDefinitions: insertDefs.flatMap(
        (def) => def.parameterDefinitions,
      ),
    },
  );
  const writable =
      table.columns.find(
        (column) => !column.primaryKey && textColumn(column),
      ) ?? table.columns.find((column) => !column.primaryKey),
    pkDefs = primary.map((column, index) =>
      parameter(
        "chiave_" + (index + 1),
        exampleValue(column),
        numericColumn(column) ? "number" : "string",
        "Chiave " + column.name,
        index + 1,
      ),
    );
  const predicate = primary
    .map((column, index) => q(column.name) + " = " + pkDefs[index].sql)
    .join(" AND ");
  if (writable) {
    const value = parameter(
        "nuovo_valore",
        exampleValue(writable),
        numericColumn(writable) ? "number" : "string",
        "Nuovo valore di " + writable.name,
        1,
      ),
      updateKeys = primary.map((column, index) =>
        parameter(
          "chiave_" + (index + 1),
          exampleValue(column),
          numericColumn(column) ? "number" : "string",
          "Chiave " + column.name,
          index + 2,
        ),
      );
    add(
      "update",
      "Aggiornare una riga per chiave",
      "CRUD",
      "Intermedio",
      `UPDATE ${t(table)}\nSET ${q(writable.name)} = ${value.sql}\nWHERE ${primary.map((column, index) => q(column.name) + " = " + updateKeys[index].sql).join(" AND ")};`,
      "Limita la modifica attraverso la chiave primaria.",
      "Prova prima SELECT con lo stesso WHERE. Tutte le parti di una chiave composta sono necessarie. L'esempio non viene eseguito quando lo apri.",
      {
        readOnly: false,
        available: !usesDemoSchema && primary.length > 0,
        unavailableReason: !primary.length
          ? "La tabella non ha una chiave primaria rilevata."
          : undefined,
        parameters: Object.assign(
          {},
          value.parameters,
          ...updateKeys.map((def) => def.parameters),
        ),
        parameterDefinitions: [
          ...value.parameterDefinitions,
          ...updateKeys.flatMap((def) => def.parameterDefinitions),
        ],
      },
    );
  }
  add(
    "delete",
    "Cancellare una riga per chiave",
    "CRUD",
    "Intermedio",
    primary.length ? `DELETE FROM ${t(table)}\nWHERE ${predicate};` : "",
    "Identifica esplicitamente la riga da eliminare.",
    "Controlla la SELECT equivalente prima della cancellazione. Il filtro usa tutte le colonne della chiave primaria; la libreria non esegue il comando.",
    {
      readOnly: false,
      available: !usesDemoSchema && primary.length > 0,
      unavailableReason: !primary.length
        ? "Manca una chiave primaria rilevata."
        : undefined,
      parameters: Object.assign({}, ...pkDefs.map((def) => def.parameters)),
      parameterDefinitions: pkDefs.flatMap((def) => def.parameterDefinitions),
    },
  );
  add(
    "create-table",
    "Creare una tabella di appunti",
    "DDL",
    "Base",
    `CREATE TABLE IF NOT EXISTS ${q("query_notes")} (\n  ${q("id")} INTEGER PRIMARY KEY,\n  ${q("note")} VARCHAR(255) NOT NULL\n);`,
    "Definisci colonne e vincoli di una nuova tabella.",
    "L'esempio crea un nuovo oggetto query_notes: non rappresenta una tabella già rilevata. L'ID è fornito esplicitamente e non presume AUTO_INCREMENT o IDENTITY.",
    {
      readOnly: false,
      available: connected,
      usesDemoSchema: false,
      unavailableReason: connected
        ? undefined
        : "Collega un database prima di creare un oggetto.",
    },
  );
  add(
    "create-view",
    "Creare una vista di lettura",
    "DDL",
    "Intermedio",
    `CREATE VIEW ${q("query_preview")} AS\nSELECT ${selected}\nFROM ${t(table)};`,
    "Salva la definizione di una SELECT come vista.",
    "Una vista conserva la query, non una copia generica dei dati. Controlla il nome query_preview e i permessi di creazione prima di eseguirla.",
    { readOnly: false },
  );
  add(
    "index",
    "Creare un indice su una colonna",
    "INDEX",
    "Intermedio",
    `CREATE INDEX ${q("idx_query_" + table.name.replace(/[^a-z0-9_]/gi, "_").slice(0, 30))}\nON ${t(table)} (${q(group.name)});`,
    "Prepara un indice per filtri o ordinamenti ricorrenti.",
    "Un indice può velocizzare letture ma costa spazio e aggiornamenti. Confronta il piano prima e dopo; un indice duplicato non porta automaticamente benefici.",
    { readOnly: false },
  );
  const explain = engine === "sqlite" ? "EXPLAIN QUERY PLAN" : "EXPLAIN";
  add(
    "explain",
    "Leggere il piano di esecuzione",
    "INDEX",
    "Avanzato",
    `${explain}\nSELECT ${selected}\nFROM ${t(table)}\nWHERE ${q(key.name)} = ${first.sql};`,
    "Osserva il piano senza usare EXPLAIN ANALYZE.",
    "Il piano mostra il percorso previsto dal motore. EXPLAIN ANALYZE può eseguire davvero la query; questo esempio usa il piano semplice.",
    first,
  );
  const begin =
    engine === "mysql" || engine === "mariadb" ? "START TRANSACTION" : "BEGIN";
  add(
    "transaction",
    "Leggere dentro una transazione",
    "TRANSACTIONS",
    "Intermedio",
    `${begin};\nSELECT ${selected} FROM ${t(table)} ORDER BY ${q(key.name)} LIMIT 20;\nROLLBACK;`,
    "Osserva inizio e fine di una transazione.",
    "Scegli Intero script per eseguire la sequenza completa. L'esempio termina con ROLLBACK e non scrive dati; non lasciare una transazione aperta senza necessità.",
    { readOnly: false, executionMode: "script" },
  );
  add(
    "savepoint",
    "Usare un punto di salvataggio",
    "TRANSACTIONS",
    "Avanzato",
    `${begin};\nSAVEPOINT passo_1;\nSELECT COUNT(*) AS totale FROM ${t(table)};\nROLLBACK TO SAVEPOINT passo_1;\nRELEASE SAVEPOINT passo_1;\nROLLBACK;`,
    "Definisci un punto a cui tornare nella transazione.",
    "ROLLBACK TO annulla dal savepoint in poi, senza chiudere l'intera transazione. Il ROLLBACK finale chiude la prova. Alcuni DDL eseguono commit impliciti.",
    { readOnly: false, executionMode: "script" },
  );
  if (!primary.length) {
    const update = result.find((entry) => entry.id === engine + "-update");
    if (update) update.query = "";
  }
  return result;
}

function mongoCatalog(
  schema: SchemaSnapshot | null,
  add: AddTemplate,
  result: QueryTemplate[],
): QueryTemplate[] {
  const actual = dataTables(schema),
    table =
      actual.find((table) => table.name === "customers") ??
      actual[0] ??
      QUERY_DEMO_SCHEMA.tables[0];
  const key =
    table.columns.find((column) => column.name === "_id") ??
    table.columns.find((column) => column.primaryKey) ??
    table.columns[0] ??
    column("_id", "ObjectId", true, false);
  const field =
      table.columns.find((column) => column.name === "city") ??
      table.columns.find(
        (column) => textColumn(column) && column.name !== key.name,
      ) ??
      table.columns[0] ??
      key,
    name = table.columns.find((column) => column.name === "name") ?? field;
  const serialize = (value: unknown) => JSON.stringify(value, null, 2),
    command = (pipeline: unknown[]) =>
      serialize({ aggregate: table.name, pipeline, cursor: {} });
  add(
    "ping",
    "Verificare il collegamento",
    "SELECT",
    "Base",
    serialize({ ping: 1 }),
    "Una richiesta senza collezioni.",
    "ping controlla che il server risponda; non legge o modifica documenti.",
    { available: true, usesDemoSchema: false, unavailableReason: undefined },
  );
  add(
    "find",
    "Leggere i primi documenti",
    "SELECT",
    "Base",
    serialize({ find: table.name, filter: {}, limit: 20 }),
    "Leggi una collezione reale con un limite.",
    "La forma è un comando Extended JSON, non una chiamata JavaScript db.collection.find(). filter sceglie i documenti, limit contiene il risultato.",
  );
  add(
    "projection",
    "Scegliere i campi",
    "SELECT",
    "Base",
    serialize({
      find: table.name,
      filter: {},
      projection: { _id: 0, [name.name]: 1, [field.name]: 1 },
      limit: 20,
    }),
    "Proietta i campi di un documento.",
    "1 include, 0 esclude. L'esclusione di _id può essere combinata con le inclusioni degli altri campi; non mescolare liberamente i due stili.",
  );
  add(
    "filter",
    "Filtrare per un valore",
    "FILTER",
    "Base",
    serialize({
      find: table.name,
      filter: { [field.name]: field.name === "city" ? "Udine" : "Esempio" },
      limit: 20,
    }),
    "Usa il valore direttamente nel documento filtro.",
    "I valori MongoDB sono parte del comando JSON tipizzato. Modificali nell'editor: il pannello dei parametri SQL non sostituisce automaticamente stringhe nel documento.",
  );
  add(
    "exists",
    "Campo presente e valore NULL",
    "FILTER",
    "Intermedio",
    serialize({
      find: table.name,
      filter: { [field.name]: { $exists: true, $eq: null } },
      limit: 20,
    }),
    "Cerca un campo presente con valore null.",
    "Il solo filtro {campo:null} può includere documenti in cui il campo manca. $exists:true distingue presenza e assenza.",
  );
  add(
    "match-sort",
    "Filtrare e ordinare una pipeline",
    "PIPELINE",
    "Intermedio",
    command([
      { $match: { [field.name]: { $exists: true } } },
      { $sort: { [field.name]: 1 } },
      { $limit: 20 },
    ]),
    "Passa i documenti attraverso più stadi.",
    "Gli stadi sono ordinati. $match riduce il flusso, $sort lo ordina e $limit mantiene i primi risultati.",
  );
  add(
    "group",
    "Contare documenti per gruppo",
    "GROUP",
    "Intermedio",
    command([
      { $group: { _id: "$" + field.name, totale: { $sum: 1 } } },
      { $sort: { totale: -1, _id: 1 } },
    ]),
    "Crea un gruppo per valore del campo.",
    "In $group, _id è l'espressione di raggruppamento; {$sum:1} conta i documenti. L'_id del gruppo non modifica gli identificatori originali.",
  );
  add(
    "having",
    "Filtrare dopo $group",
    "HAVING",
    "Intermedio",
    command([
      { $group: { _id: "$" + field.name, totale: { $sum: 1 } } },
      { $match: { totale: { $gt: 1 } } },
      { $sort: { totale: -1 } },
    ]),
    "L'equivalente di un filtro sui gruppi.",
    "Un $match dopo $group vede i campi prodotti dal raggruppamento, per esempio totale. Uno stadio prima del gruppo filtra invece i documenti originali.",
  );
  add(
    "count",
    "Contare una pipeline",
    "PIPELINE",
    "Base",
    command([
      { $match: { [field.name]: { $exists: true } } },
      { $count: "totale" },
    ]),
    "Conta i documenti che superano il filtro.",
    "$count produce un documento con il conteggio; se il flusso è vuoto può non restituire documenti. Non sostituirlo con il conteggio di una pagina limitata.",
  );
  const measureTable =
      actual.find((table) =>
        table.columns.some(
          (column) =>
            numericColumn(column) &&
            !column.primaryKey &&
            !/_id$/.test(column.name),
        ),
      ) ?? (!schema ? QUERY_DEMO_SCHEMA.tables[1] : undefined),
    measure = measureTable?.columns.find(
      (column) =>
        numericColumn(column) &&
        !column.primaryKey &&
        !/_id$/.test(column.name),
    );
  if (measure && measureTable)
    add(
      "summary",
      "Somma e media nella pipeline",
      "GROUP",
      "Intermedio",
      serialize({
        aggregate: measureTable.name,
        pipeline: [
          {
            $group: {
              _id: null,
              somma: { $sum: "$" + measure.name },
              media: { $avg: "$" + measure.name },
            },
          },
        ],
        cursor: {},
      }),
      "Riepiloga una misura numerica campionata.",
      "$sum e $avg usano un riferimento al campo preceduto da $. Verifica i tipi dei documenti: il campionamento non garantisce che tutta la collezione abbia lo stesso schema.",
    );
  const orders = actual.find((table) => table.name === "orders"),
    customers = actual.find((table) => table.name === "customers");
  if (
    orders?.columns.some((column) => column.name === "customer_id") &&
    customers?.columns.some((column) => column.name === "id")
  )
    add(
      "lookup",
      "Collegare ordini e clienti con $lookup",
      "JOIN",
      "Avanzato",
      serialize({
        aggregate: orders.name,
        pipeline: [
          {
            $lookup: {
              from: customers.name,
              localField: "customer_id",
              foreignField: "id",
              as: "customer",
            },
          },
          { $unwind: { path: "$customer", preserveNullAndEmptyArrays: true } },
          { $limit: 20 },
        ],
        cursor: {},
      }),
      "Esempio sui campi customer_id e id effettivamente presenti.",
      "MongoDB non dichiara una chiave esterna: verifica che i campi descrivano davvero la stessa relazione. $lookup aggiunge un array; $unwind lo espande e conserva i documenti senza corrispondenza.",
      {
        assumptions: [
          "Relazione semantica customer_id → customers.id da verificare; entrambi i campi esistono nello schema campionato.",
        ],
      },
    );
  add(
    "window",
    "Numerare documenti con una finestra",
    "WINDOW",
    "Avanzato",
    command([
      {
        $setWindowFields: {
          sortBy: { [key.name]: 1 },
          output: { numero: { $documentNumber: {} } },
        },
      },
      { $limit: 20 },
    ]),
    "Mantieni i documenti e aggiungi una posizione.",
    "$setWindowFields richiede MongoDB 5.0 o successivo. sortBy stabilisce l'ordine del calcolo; l'esempio non modifica i documenti memorizzati.",
  );
  add(
    "insert",
    "Inserire un documento di esempio",
    "CRUD",
    "Base",
    serialize({
      insert: table.name,
      documents: [
        {
          _id: "query-example-900001",
          ...(name.name !== "_id" ? { [name.name]: "Esempio" } : {}),
        },
      ],
    }),
    "Prepara un documento da controllare.",
    "L'identificatore è fornito per rendere riconoscibile il documento. Verifica validazione della collezione e campi obbligatori; il comando non viene eseguito quando lo apri.",
    { readOnly: false },
  );
  add(
    "update",
    "Aggiornare per _id con $set",
    "CRUD",
    "Intermedio",
    serialize({
      update: table.name,
      updates: [
        {
          q: { _id: "query-example-900001" },
          u: { $set: { [name.name]: "Esempio aggiornato" } },
          multi: false,
        },
      ],
    }),
    "Modifica un documento senza sostituirlo interamente.",
    "q è il filtro, u descrive la modifica. $set mantiene gli altri campi; multi:false limita l'aggiornamento a un documento.",
    { readOnly: false },
  );
  add(
    "delete",
    "Cancellare un solo documento per _id",
    "CRUD",
    "Intermedio",
    serialize({
      delete: table.name,
      deletes: [{ q: { _id: "query-example-900001" }, limit: 1 }],
    }),
    "Identifica il documento da eliminare.",
    "limit:1 elimina al massimo un documento. Un filtro vuoto non identifica il documento di esempio: controlla sempre q.",
    { readOnly: false },
  );
  add(
    "create",
    "Creare una collezione di appunti",
    "DDL",
    "Base",
    serialize({ create: "query_notes" }),
    "Crea un nuovo oggetto, senza inventarlo nello schema collegato.",
    "La collezione query_notes viene creata solo se esegui il comando. La validazione JSON Schema può essere aggiunta dalle funzioni di progettazione della struttura.",
    { readOnly: false, available: !!schema, usesDemoSchema: false },
  );
  add(
    "index",
    "Creare un indice su un campo",
    "INDEX",
    "Intermedio",
    serialize({
      createIndexes: table.name,
      indexes: [
        {
          key: { [field.name]: 1 },
          name: "idx_query_" + field.name.replace(/[^a-z0-9_]/gi, "_"),
        },
      ],
    }),
    "Prepara un indice per ricerche ricorrenti.",
    "Un indice costa spazio e scritture. Controlla statistiche e piano di esecuzione prima di decidere se è utile.",
    { readOnly: false },
  );
  add(
    "explain",
    "Leggere il piano di una ricerca",
    "INDEX",
    "Avanzato",
    serialize({
      explain: {
        find: table.name,
        filter: { [field.name]: { $exists: true } },
      },
      verbosity: "queryPlanner",
    }),
    "Esamina la scelta del planner.",
    "queryPlanner descrive il piano scelto. executionStats può eseguire la ricerca: il livello qui proposto è il piano semplice.",
  );
  add(
    "topology",
    "Verificare la topologia per le transazioni",
    "TRANSACTIONS",
    "Avanzato",
    serialize({ hello: 1 }),
    "Controlla la configurazione del server.",
    "hello non avvia una transazione. Le transazioni MongoDB richiedono replica set o cluster e una sessione del driver; avviale dai controlli Transazione dell'app, non con BEGIN SQL.",
    { available: true, usesDemoSchema: false, unavailableReason: undefined },
  );
  for (const entry of result)
    if (entry.usesDemoSchema) {
      entry.available = false;
      entry.unavailableReason =
        "Collega una collezione o apri il dataset Negozio e ordini per usare campi reali.";
    }
  if (schema && !table.columns.length)
    for (const entry of result)
      if (
        ![
          "mongodb-find",
          "mongodb-create",
          "mongodb-ping",
          "mongodb-topology",
        ].includes(entry.id)
      ) {
        entry.available = false;
        entry.unavailableReason =
          "La collezione è vuota e non espone campi campionati. Leggi i documenti o definisci lo schema prima di adattare questo esempio.";
      }
  if (name.name === "_id") {
    const update = result.find((entry) => entry.id === "mongodb-update");
    if (update) {
      update.available = false;
      update.query = "";
      update.unavailableReason =
        "È stato rilevato soltanto _id, che è immutabile. Scegli un altro campo prima di preparare UPDATE.";
    }
  }
  return result;
}

export function catalogAction(entry: QueryTemplate): QueryActionEntry {
  return {
    id: entry.id,
    title: entry.title,
    query: entry.query,
    engine: entry.engine,
    parameters: entry.parameters,
    lesson: entry.lesson,
    source: "catalog",
    readOnly: entry.readOnly,
    executionMode: entry.executionMode,
  };
}
export function savedQueryAction(saved: SavedQuery): LibraryEntry {
  return {
    id: "saved-" + saved.id,
    sourceId: saved.id,
    title: saved.name,
    query: saved.query,
    engine: saved.engine,
    parameters: saved.parameters ?? {},
    executionMode:
      saved.executionMode === "script"
        ? "script"
        : saved.executionMode === "selection"
          ? "selection"
          : "current",
    lesson:
      "Query salvata nel tuo spazio di lavoro. Controlla connessione e parametri prima di eseguirla.",
    source: "saved",
  };
}
export function historyQueryAction(item: HistoryEntry): LibraryEntry {
  return {
    id: "history-" + item.id,
    sourceId: item.id,
    title: item.query.replace(/\s+/g, " ").slice(0, 90) || "Query senza testo",
    query: item.query,
    engine: item.engine,
    parameters: {},
    lesson: item.success
      ? "Questa query risulta riuscita nella cronologia. I dati e lo schema potrebbero essere cambiati da allora."
      : "Questa esecuzione aveva restituito un errore. Rileggi il messaggio e adatta la query prima di riprovarla.",
    source: "history",
  };
}
