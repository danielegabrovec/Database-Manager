import type * as Monaco from "monaco-editor";
import type { ColumnInfo, Engine, SchemaSnapshot, TableInfo } from "../types";

export interface SqlLanguageContext {
  engine: Engine;
  schema: SchemaSnapshot | null;
}
export interface CompletionRequest extends SqlLanguageContext {
  text: string;
  offset: number;
}
export interface SqlCompletion {
  label: string;
  insertText: string;
  detail: string;
  documentation: string;
  kind: "table" | "column" | "alias" | "keyword" | "function" | "operator";
  replacementStart: number;
  replacementEnd: number;
  filterText?: string;
}
export interface QueryExplanation {
  summary: string;
  steps: {
    clause: string;
    title: string;
    explanation: string;
    start: number;
    end: number;
  }[];
  warnings: string[];
  parameters: string[];
  tables: string[];
  logicalOrder: string[];
}
export interface SqlFunction {
  name: string;
  signature: string;
  parameters: string[];
  description: string;
  engines?: Engine[];
}
interface Token {
  text: string;
  value: string;
  start: number;
  end: number;
  kind: "word" | "identifier" | "string" | "comment" | "symbol";
}
export interface AliasBinding {
  alias: string;
  aliasQuoted?: boolean;
  table: TableInfo;
  scopeStart: number;
  scopeEnd: number;
  source: "table" | "cte" | "subquery";
}

export const CLAUSE_HELP: Record<
  string,
  { title: string; description: string }
> = {
  SELECT: {
    title: "Colonne del risultato",
    description:
      "Sceglie le colonne e le espressioni da mostrare. AS assegna un nome leggibile al risultato.",
  },
  FROM: {
    title: "Origine dei dati",
    description:
      "Indica la tabella, vista o sottoquery da leggere. Un alias breve consente riferimenti come c.name.",
  },
  JOIN: {
    title: "Collegare tabelle",
    description:
      "Combina righe tramite una condizione ON. INNER JOIN conserva le corrispondenze; LEFT JOIN conserva anche le righe della tabella a sinistra prive di corrispondenza.",
  },
  ON: {
    title: "Condizione del collegamento",
    description:
      "Definisce quali righe delle due origini corrispondono. Controlla la chiave esterna: una condizione mancante può moltiplicare i risultati.",
  },
  WHERE: {
    title: "Filtrare le righe",
    description:
      "Filtra ogni riga prima del raggruppamento. Per NULL usa IS NULL o IS NOT NULL; i valori variabili vanno passati come parametri.",
  },
  "GROUP BY": {
    title: "Creare gruppi",
    description:
      "Raggruppa righe con gli stessi valori. Le altre colonne in SELECT devono essere aggregate oppure appartenere al gruppo.",
  },
  HAVING: {
    title: "Filtrare i gruppi",
    description:
      "Filtra dopo GROUP BY e può usare COUNT, SUM e AVG. WHERE filtra le righe di partenza, HAVING i gruppi risultanti.",
  },
  "ORDER BY": {
    title: "Ordinare il risultato",
    description:
      "Ordina per una o più espressioni. ASC è crescente, DESC decrescente. Una chiave univoca aggiuntiva rende stabile l'ordine fra valori uguali.",
  },
  LIMIT: {
    title: "Limitare il risultato",
    description:
      "Limita le righe restituite. Abbinalo a ORDER BY per ottenere una scelta ripetibile; non sostituisce un filtro efficiente.",
  },
  OFFSET: {
    title: "Saltare righe",
    description:
      "Salta un numero di righe dopo l'ordinamento. Per pagine molto profonde può essere più efficiente filtrare a partire dall'ultima chiave letta.",
  },
  WITH: {
    title: "Dare un nome a una sottoquery",
    description:
      "Definisce una CTE riutilizzabile nello statement corrente. Migliora la leggibilità delle query articolate.",
  },
  OVER: {
    title: "Calcoli finestra",
    description:
      "Calcola su righe collegate senza ridurle a una sola riga per gruppo. PARTITION BY divide le finestre, ORDER BY definisce l'ordine del calcolo.",
  },
  INSERT: {
    title: "Inserire dati",
    description:
      "Aggiunge righe. Elenca esplicitamente le colonne e passa i valori come parametri; rispetta chiavi, vincoli e campi obbligatori.",
  },
  UPDATE: {
    title: "Aggiornare dati",
    description:
      "Modifica le righe individuate da WHERE. Prova prima una SELECT con lo stesso filtro e identifica il record con una chiave stabile.",
  },
  DELETE: {
    title: "Cancellare righe",
    description:
      "Elimina le righe individuate dal filtro. Una DELETE senza WHERE coinvolge l'intera tabella; il rollback dipende dalla transazione e dal motore.",
  },
  CREATE: {
    title: "Creare un oggetto",
    description:
      "Crea tabelle, viste o indici. Scegli tipi e vincoli adatti al motore; alcuni DDL MySQL/MariaDB eseguono commit impliciti.",
  },
  ALTER: {
    title: "Modificare la struttura",
    description:
      "Cambia la definizione di un oggetto. Disponibilità e possibilità di rollback dipendono dal motore e dall'operazione.",
  },
  DROP: {
    title: "Rimuovere un oggetto",
    description:
      "Elimina un oggetto e può eliminarne i dati. Controlla dipendenze, destinazione e disponibilità di un ripristino prima di eseguire.",
  },
  TRUNCATE: {
    title: "Svuotare una tabella",
    description:
      "Elimina tutte le righe con una semantica diversa da DELETE. Disponibilità, trigger e rollback dipendono dal motore; SQLite non dispone di TRUNCATE.",
  },
  BEGIN: {
    title: "Iniziare una transazione",
    description:
      "Raggruppa modifiche che potranno essere confermate con COMMIT o annullate con ROLLBACK, dove supportato.",
  },
  COMMIT: {
    title: "Confermare una transazione",
    description:
      "Rende definitive le modifiche della transazione corrente. Dopo il commit non è disponibile un annullamento generico.",
  },
  ROLLBACK: {
    title: "Annullare una transazione",
    description:
      "Annulla le modifiche non confermate. Non annulla un commit già eseguito e non garantisce il rollback dei DDL di tutti i motori.",
  },
};

export const MONGO_HELP: Record<string, string> = {
  find: "Legge documenti da una collezione; filter seleziona i documenti e projection sceglie i campi.",
  aggregate:
    "Esegue una pipeline: ogni stadio riceve i documenti prodotti da quello precedente.",
  filter:
    "Condizioni di selezione. I campi vengono confrontati con i valori o con operatori come $gt e $in.",
  projection:
    "Sceglie i campi del risultato: 1 include, 0 esclude; evita di mescolare inclusioni ed esclusioni, salvo _id.",
  sort: "Ordina per campo: 1 crescente, -1 decrescente.",
  limit: "Limita il numero di documenti restituiti.",
  $match:
    "Filtra i documenti. Se possibile mettilo presto nella pipeline per ridurre il lavoro successivo.",
  $project:
    "Sceglie o calcola i campi in uscita. I riferimenti a un campo sono stringhe come $price.",
  $group:
    "Raggruppa per _id e calcola aggregazioni. Per contare documenti usa { $sum: 1 }.",
  $sort: "Ordina i documenti: 1 crescente, -1 decrescente.",
  $limit: "Mantiene solo i primi documenti prodotti dalla pipeline.",
  $lookup:
    "Collega un'altra collezione e aggiunge un array di corrispondenze. Specifica from, localField, foreignField e as.",
  $unwind:
    "Produce una riga per elemento di un array; può aumentare molto il numero di documenti.",
  $set: "Aggiunge o modifica campi. In un aggiornamento mantiene gli altri campi del documento.",
  $unset: "Rimuove i campi indicati.",
  $count: "Conta i documenti che hanno superato gli stadi precedenti.",
  $sum: "Somma un'espressione numerica; in $group con valore 1 conta i documenti.",
  $avg: "Media dei valori numerici dell'espressione.",
  $min: "Restituisce il valore minimo dell'espressione nel gruppo.",
  $max: "Restituisce il valore massimo dell'espressione nel gruppo.",
  $gt: "Maggiore di.",
  $gte: "Maggiore o uguale.",
  $lt: "Minore di.",
  $lte: "Minore o uguale.",
  $eq: "Uguale a.",
  $ne: "Diverso da; controlla come vuoi gestire i campi assenti.",
  $in: "Corrisponde ad almeno un valore nell'array.",
  $and: "Tutte le condizioni devono essere vere.",
  $or: "È sufficiente una condizione vera.",
  $exists:
    "Distingue un campo presente da un campo assente: null e campo assente sono concetti distinti.",
  $setWindowFields:
    "Calcola funzioni finestra mantenendo i singoli documenti; richiede MongoDB 5.0 o successivo.",
};

export const SQL_FUNCTIONS: SqlFunction[] = [
  {
    name: "COUNT",
    signature: "COUNT(espressione | *)",
    parameters: ["espressione"],
    description:
      "COUNT(*) conta le righe; COUNT(colonna) conta soltanto i valori non NULL.",
  },
  {
    name: "SUM",
    signature: "SUM(espressione_numerica)",
    parameters: ["espressione_numerica"],
    description:
      "Somma i valori non NULL. Se non ci sono valori può restituire NULL: COALESCE consente un valore alternativo.",
  },
  {
    name: "AVG",
    signature: "AVG(espressione_numerica)",
    parameters: ["espressione_numerica"],
    description:
      "Calcola la media dei valori non NULL; non tratta NULL come zero.",
  },
  {
    name: "MIN",
    signature: "MIN(espressione)",
    parameters: ["espressione"],
    description: "Restituisce il valore minimo fra quelli non NULL.",
  },
  {
    name: "MAX",
    signature: "MAX(espressione)",
    parameters: ["espressione"],
    description: "Restituisce il valore massimo fra quelli non NULL.",
  },
  {
    name: "COALESCE",
    signature: "COALESCE(valore, alternativa, …)",
    parameters: ["valore", "alternativa"],
    description: "Restituisce il primo argomento che non è NULL.",
  },
  {
    name: "ROUND",
    signature: "ROUND(numero, cifre)",
    parameters: ["numero", "cifre"],
    description:
      "Arrotonda il numero alle cifre decimali indicate. Non modifica i dati memorizzati quando usato in SELECT.",
  },
  {
    name: "LOWER",
    signature: "LOWER(testo)",
    parameters: ["testo"],
    description:
      "Converte il testo in minuscolo secondo le regole del motore e della collation.",
  },
  {
    name: "UPPER",
    signature: "UPPER(testo)",
    parameters: ["testo"],
    description:
      "Converte il testo in maiuscolo secondo le regole del motore e della collation.",
  },
  {
    name: "LENGTH",
    signature: "LENGTH(valore)",
    parameters: ["valore"],
    description:
      "In SQLite conta i caratteri del testo, in PostgreSQL la lunghezza del valore. I valori binari hanno regole diverse.",
    engines: ["sqlite", "postgresql"],
  },
  {
    name: "CHAR_LENGTH",
    signature: "CHAR_LENGTH(testo)",
    parameters: ["testo"],
    description:
      "Conta i caratteri del testo; LENGTH in MySQL/MariaDB conta invece i byte.",
    engines: ["mysql", "mariadb", "postgresql"],
  },
  {
    name: "DATE",
    signature: "DATE(valore, modificatore, …)",
    parameters: ["valore", "modificatore"],
    description:
      "SQLite: ricava una data in formato YYYY-MM-DD; i modificatori permettono calcoli sulle date.",
    engines: ["sqlite"],
  },
  {
    name: "DATE_TRUNC",
    signature: "DATE_TRUNC(unità, timestamp)",
    parameters: ["unità", "timestamp"],
    description:
      "PostgreSQL: tronca un timestamp all'unità richiesta, per esempio giorno o mese.",
    engines: ["postgresql"],
  },
  {
    name: "DATE_FORMAT",
    signature: "DATE_FORMAT(data, formato)",
    parameters: ["data", "formato"],
    description:
      "MySQL/MariaDB: formatta una data con specificatori come %Y-%m-%d.",
    engines: ["mysql", "mariadb"],
  },
  {
    name: "ROW_NUMBER",
    signature: "ROW_NUMBER() OVER (PARTITION BY … ORDER BY …)",
    parameters: [],
    description:
      "Numera le righe dentro ogni partizione. Specifica ORDER BY per definire la numerazione.",
  },
  {
    name: "RANK",
    signature: "RANK() OVER (ORDER BY …)",
    parameters: [],
    description:
      "Assegna la stessa posizione ai pari merito e lascia salti nelle posizioni successive.",
  },
  {
    name: "LAG",
    signature: "LAG(espressione, distanza, alternativa) OVER (ORDER BY …)",
    parameters: ["espressione", "distanza", "alternativa"],
    description:
      "Legge il valore di una riga precedente nella finestra ordinata.",
  },
];

const RESERVED = new Set(
  "SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON USING GROUP BY HAVING ORDER LIMIT OFFSET AS UNION ALL DISTINCT WITH RECURSIVE INSERT INTO VALUES UPDATE SET DELETE CREATE ALTER DROP TABLE VIEW INDEX BEGIN START TRANSACTION COMMIT ROLLBACK SAVEPOINT RELEASE AND OR NOT NULL IS IN LIKE BETWEEN EXISTS ASC DESC OVER PARTITION WINDOW RETURNING EXCEPT INTERSECT FETCH FOR WHEN THEN ELSE END CASE".split(
    " ",
  ),
);
export function quoteIdentifier(engine: Engine, name: string): string {
  return engine === "mysql" || engine === "mariadb"
    ? "`" + name.replace(/`/g, "``") + "`"
    : '"' + name.replace(/"/g, '""') + '"';
}
export function tableReference(engine: Engine, table: TableInfo): string {
  return (
    (table.schema ? quoteIdentifier(engine, table.schema) + "." : "") +
    quoteIdentifier(engine, table.name)
  );
}
export function dataTables(schema: SchemaSnapshot | null): TableInfo[] {
  return (
    schema?.tables.filter(
      (table) =>
        (table.columns.length > 0 || table.kind === "collection") &&
        !["trigger", "routine", "function", "procedure", "index"].includes(
          table.kind,
        ),
    ) ?? []
  );
}
export function functionsFor(engine: Engine): SqlFunction[] {
  return engine === "mongodb"
    ? []
    : SQL_FUNCTIONS.filter((fn) => !fn.engines || fn.engines.includes(engine));
}

function tokens(text: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  const push = (start: number, kind: Token["kind"], value?: string) =>
    result.push({
      text: text.slice(start, i),
      value: value ?? text.slice(start, i),
      start,
      end: i,
      kind,
    });
  while (i < text.length) {
    if (/\s/.test(text[i])) {
      i++;
      continue;
    }
    const start = i;
    if (text.startsWith("--", i)) {
      while (i < text.length && text[i] !== "\n") i++;
      push(start, "comment");
      continue;
    }
    if (text.startsWith("/*", i)) {
      i += 2;
      let depth = 1;
      while (i < text.length && depth) {
        if (text.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (text.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      push(start, "comment");
      continue;
    }
    const dollar = text.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0];
    if (dollar) {
      i += dollar.length;
      const end = text.indexOf(dollar, i);
      i = end < 0 ? text.length : end + dollar.length;
      push(start, "string");
      continue;
    }
    if ("'\"`[".includes(text[i])) {
      const opener = text[i++],
        closer = opener === "[" ? "]" : opener;
      let value = "";
      while (i < text.length) {
        if (text[i] === closer) {
          if (text[i + 1] === closer) {
            value += closer;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (opener === "'" && text[i] === "\\" && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
        } else value += text[i++];
      }
      push(start, opener === "'" ? "string" : "identifier", value);
      continue;
    }
    if (/[\w$\u0080-\uFFFF]/.test(text[i])) {
      while (i < text.length && /[\w$\u0080-\uFFFF]/.test(text[i])) i++;
      push(start, "word");
      continue;
    }
    i++;
    push(start, "symbol");
  }
  return result;
}
function significant(text: string): Token[] {
  return tokens(text).filter(
    (token) => token.kind !== "comment" && token.kind !== "string",
  );
}
/** Keep offsets/newlines while excluding quoted text and comments from script checks. */
export function maskSqlNonCode(text: string): string {
  const parts: string[] = [];
  let offset = 0;
  for (const token of tokens(text)) {
    if (!["string", "comment", "identifier"].includes(token.kind)) continue;
    parts.push(text.slice(offset, token.start), token.text.replace(/[^\r\n]/g, " "));
    offset = token.end;
  }
  parts.push(text.slice(offset));
  return parts.join("");
}
function isSymbol(token: Token | undefined, value: string): boolean {
  return token?.kind === "symbol" && token.value === value;
}
function isKeyword(token: Token | undefined, value: string): boolean {
  return token?.kind === "word" && token.value.toUpperCase() === value;
}
function identifier(token: Token | undefined): token is Token {
  return (
    !!token &&
    (token.kind === "identifier" ||
      (token.kind === "word" &&
        !RESERVED.has(token.value.toUpperCase()) &&
        !/^\d/.test(token.value)))
  );
}
function closingIndex(list: Token[], index: number): number {
  let depth = 0;
  for (let i = index; i < list.length; i++) {
    if (isSymbol(list[i], "(")) depth++;
    if (isSymbol(list[i], ")") && --depth === 0) return i;
  }
  return list.length - 1;
}
function scopeAt(
  list: Token[],
  index: number,
  length: number,
): [number, number] {
  const stack: number[] = [];
  for (let i = 0; i < index; i++) {
    if (isSymbol(list[i], "(")) stack.push(i);
    else if (isSymbol(list[i], ")")) stack.pop();
  }
  return stack.length
    ? [
        list[stack[stack.length - 1]].start,
        list[closingIndex(list, stack[stack.length - 1])].end,
      ]
    : [0, length];
}
function projectionColumns(
  text: string,
  schema: SchemaSnapshot | null,
): ColumnInfo[] {
  const list = significant(text),
    select = list.findIndex((token) => isKeyword(token, "SELECT"));
  if (select < 0) return [];
  let depth = 0,
    end = list.length;
  for (let i = select + 1; i < list.length; i++) {
    if (isSymbol(list[i], "(")) depth++;
    if (isSymbol(list[i], ")")) depth--;
    if (depth === 0 && isKeyword(list[i], "FROM")) {
      end = i;
      break;
    }
  }
  const groups: Token[][] = [[]];
  depth = 0;
  for (const token of list.slice(select + 1, end)) {
    if (isSymbol(token, ",") && depth === 0) {
      groups.push([]);
      continue;
    }
    groups[groups.length - 1].push(token);
    if (isSymbol(token, "(")) depth++;
    if (isSymbol(token, ")")) depth--;
  }
  const columns: ColumnInfo[] = [];
  for (const group of groups) {
    const as = group.findIndex((token) => isKeyword(token, "AS"));
    const last = group[group.length - 1];
    if (as >= 0 && identifier(group[as + 1])) {
      columns.push({
        name: group[as + 1].value,
        dataType: "espressione",
        primaryKey: false,
        nullable: true,
      });
      continue;
    }
    if (isSymbol(last, "*")) {
      const from = list[end + 1];
      const table = dataTables(schema).find(
        (table) => table.name.toLowerCase() === from?.value.toLowerCase(),
      );
      if (table) columns.push(...table.columns);
      continue;
    }
    if (
      identifier(last) &&
      (group.length === 1 || isSymbol(group[group.length - 2], "."))
    )
      columns.push(
        dataTables(schema)
          .flatMap((table) => table.columns)
          .find((column) => column.name === last.value) ?? {
          name: last.value,
          dataType: "espressione",
          nullable: true,
          primaryKey: false,
        },
      );
  }
  return columns.filter(
    (column, index) =>
      columns.findIndex((other) => other.name === column.name) === index,
  );
}

/** Token based: strings/comments cannot declare aliases; quoted names and CTE projections are supported. */
export function parseSqlAliases(
  text: string,
  schema: SchemaSnapshot | null,
): AliasBinding[] {
  const list = significant(text);
  const virtual: TableInfo[] = [];
  const bindings: AliasBinding[] = [];
  const actual = dataTables(schema);
  if (list.some((token) => isKeyword(token, "WITH")))
    for (let i = 1; i < list.length - 2; i++) {
      if (!isKeyword(list[i], "AS") || !isSymbol(list[i + 1], "(")) continue;
      let name = list[i - 1],
        explicit: ColumnInfo[] | undefined;
      if (isSymbol(name, ")")) {
        let depth = 1,
          open = i - 2;
        for (; open >= 0; open--) {
          if (isSymbol(list[open], ")")) depth++;
          if (isSymbol(list[open], "(") && --depth === 0) break;
        }
        if (open < 1) continue;
        name = list[open - 1];
        explicit = list
          .slice(open + 1, i - 1)
          .filter(identifier)
          .map((token) => ({
            name: token.value,
            dataType: "espressione",
            nullable: true,
            primaryKey: false,
          }));
      }
      if (!identifier(name)) continue;
      const end = closingIndex(list, i + 1),
        available: SchemaSnapshot = {
          engine: schema?.engine ?? "sqlite",
          database: schema?.database ?? "",
          tables: [...actual, ...virtual],
        };
      virtual.push({
        name: name.value,
        kind: "cte",
        columns:
          explicit ??
          projectionColumns(
            text.slice(list[i + 1].end, list[end].start),
            available,
          ),
        indexes: [],
        foreignKeys: [],
      });
    }
  for (let i = 0; i < list.length; i++) {
    if (
      list[i].kind !== "word" ||
      !["FROM", "JOIN", "UPDATE", "INTO"].includes(list[i].value.toUpperCase())
    )
      continue;
    let next = i + 1;
    const [scopeStart, scopeEnd] = scopeAt(list, i, text.length);
    do {
      let table: TableInfo | undefined;
      let source: AliasBinding["source"] = "table";
      if (isSymbol(list[next], "(")) {
        const end = closingIndex(list, next);
        table = {
          name: "sottoquery",
          kind: "derived",
          columns: projectionColumns(
            text.slice(list[next].end, list[end].start),
            schema,
          ),
          indexes: [],
          foreignKeys: [],
        };
        source = "subquery";
        next = end + 1;
      } else {
        const parts: string[] = [];
        if (!identifier(list[next])) break;
        parts.push(list[next++].value);
        while (isSymbol(list[next], ".") && identifier(list[next + 1])) {
          parts.push(list[next + 1].value);
          next += 2;
        }
        table = [...actual, ...virtual].find(
          (candidate) =>
            candidate.name.toLowerCase() ===
              parts[parts.length - 1].toLowerCase() &&
            (parts.length < 2 ||
              !candidate.schema ||
              candidate.schema.toLowerCase() ===
                parts[parts.length - 2].toLowerCase()),
        );
        if (table?.kind === "cte") source = "cte";
      }
      if (isKeyword(list[next], "AS")) next++;
      const aliasToken = identifier(list[next]) ? list[next++] : undefined,
        alias =
          aliasToken?.value ??
          (source === "subquery" ? undefined : table?.name);
      if (table && alias)
        bindings.push({
          alias,
          aliasQuoted: aliasToken ? aliasToken.kind === "identifier" : true,
          table,
          scopeStart,
          scopeEnd,
          source,
        });
      if (!isSymbol(list[next], ",")) break;
      next++;
    } while (next < list.length);
  }
  return bindings;
}

function statementBounds(text: string, offset: number): [number, number] {
  const semicolons = significant(text).filter((token) => isSymbol(token, ";"));
  return [
    semicolons.filter((token) => token.end <= offset).at(-1)?.end ?? 0,
    semicolons.find((token) => token.start >= offset)?.end ?? text.length,
  ];
}
function completionPosition(text: string, offset: number) {
  const list = tokens(text);
  const current = list.find(
    (token) =>
      token.start < offset &&
      token.end >= offset &&
      (token.kind === "word" || token.kind === "identifier"),
  );
  const replacementStart = current?.start ?? offset;
  const prefix = current
    ? text.slice(current.start, offset).replace(/^["`\[]/, "")
    : "";
  const before = list.filter(
    (token) =>
      token.end <= replacementStart &&
      token.kind !== "comment" &&
      token.kind !== "string",
  );
  const dot = isSymbol(before.at(-1), ".");
  const qualifier = dot ? before.at(-2)?.value : undefined;
  const inside = list.find(
    (token) =>
      token.start < offset &&
      token.end >= offset &&
      (token.kind === "comment" || token.kind === "string") &&
      (token.end > offset ||
        token.text.startsWith("--") ||
        (token.text.startsWith("/*") && !token.text.endsWith("*/")) ||
        (token.kind === "string" &&
          token.text.startsWith("'") &&
          !token.text.endsWith("'"))),
  );
  return {
    replacementStart,
    replacementEnd: current?.end ?? offset,
    prefix,
    before,
    qualifier,
    inside,
  };
}

export function getSqlCompletions(request: CompletionRequest): SqlCompletion[] {
  const { engine, schema, text } = request,
    offset = Math.max(0, Math.min(text.length, request.offset));
  if (engine === "mongodb") return mongoCompletions(request);
  const position = completionPosition(text, offset);
  if (position.inside) return [];
  const [start, end] = statementBounds(text, offset);
  const bindings = parseSqlAliases(text.slice(start, end), schema).filter(
    (binding) =>
      binding.scopeStart <= offset - start &&
      binding.scopeEnd >= offset - start,
  );
  const tables = dataTables(schema);
  const items: SqlCompletion[] = [];
  const add = (
    label: string,
    insertText: string,
    kind: SqlCompletion["kind"],
    detail: string,
    documentation: string,
    filterText?: string,
  ) =>
    items.push({
      label,
      insertText,
      kind,
      detail,
      documentation,
      filterText,
      replacementStart: position.replacementStart,
      replacementEnd: position.replacementEnd,
    });
  const addColumn = (
    column: ColumnInfo,
    table: TableInfo,
    qualifier?: string,
  ) => {
    const prefix = qualifier ? quoteIdentifier(engine, qualifier) + "." : "";
    add(
      qualifier ? qualifier + "." + column.name : column.name,
      prefix + quoteIdentifier(engine, column.name),
      "column",
      column.dataType + (column.primaryKey ? " · PK" : "") + " · " + table.name,
      "Colonna " +
        column.name +
        " di " +
        table.name +
        ". " +
        (column.nullable ? "Ammette NULL." : "Non ammette NULL.") +
        (column.primaryKey ? " Partecipa alla chiave primaria." : ""),
      column.name,
    );
  };
  if (position.qualifier) {
    const binding = [...bindings]
      .reverse()
      .find(
        (item) =>
          item.alias.toLowerCase() === position.qualifier!.toLowerCase(),
      );
    const table =
      binding?.table ??
      tables.find(
        (table) =>
          table.name.toLowerCase() === position.qualifier!.toLowerCase() &&
          !bindings.some(
            (item) => item.table === table && item.alias !== table.name,
          ),
      );
    if (table) for (const column of table.columns) addColumn(column, table);
    else
      for (const table of tables.filter(
        (table) =>
          table.schema?.toLowerCase() === position.qualifier!.toLowerCase(),
      ))
        add(
          table.name,
          quoteIdentifier(engine, table.name),
          "table",
          "Tabella · " + table.schema,
          "Tabella dello schema " + table.schema,
        );
  } else {
    const tableContext = ["FROM", "JOIN", "UPDATE", "INTO", "TABLE"].includes(
      position.before.at(-1)?.value.toUpperCase() ?? "",
    );
    if (!tableContext) {
      const visible = bindings.length
        ? bindings
        : tables.map((table) => ({ table, alias: table.name }));
      for (const binding of visible)
        for (const column of binding.table.columns)
          addColumn(
            column,
            binding.table,
            visible.length > 1
              ? engine === "postgresql" &&
                "aliasQuoted" in binding &&
                !binding.aliasQuoted
                ? binding.alias.toLowerCase()
                : binding.alias
              : undefined,
          );
      for (const binding of bindings)
        add(
          binding.alias,
          quoteIdentifier(
            engine,
            engine === "postgresql" && !binding.aliasQuoted
              ? binding.alias.toLowerCase()
              : binding.alias,
          ) + ".",
          "alias",
          "Alias di " + binding.table.name,
          "Dopo il punto vedrai soltanto le colonne di questa origine.",
        );
      for (const fn of functionsFor(engine))
        add(
          fn.name,
          ["ROW_NUMBER", "RANK"].includes(fn.name)
            ? fn.name + "() OVER (ORDER BY $0)"
            : fn.name + "($0)",
          "function",
          fn.signature,
          fn.description,
        );
      for (const [keyword, help] of Object.entries(CLAUSE_HELP))
        if (engine !== "sqlite" || keyword !== "TRUNCATE")
          add(keyword, keyword + " ", "keyword", help.title, help.description);
      for (const keyword of [
        "DISTINCT",
        "AS",
        "INNER JOIN",
        "LEFT JOIN",
        "IS NULL",
        "IS NOT NULL",
        "AND",
        "OR",
        "NOT",
        "IN",
        "BETWEEN",
        "EXISTS",
        "ASC",
        "DESC",
        "PARTITION BY",
        "UNION ALL",
        "CASE WHEN",
        "ELSE",
        "END",
      ])
        add(
          keyword,
          keyword + " ",
          "keyword",
          "SQL · " + engine,
          CLAUSE_HELP[keyword]?.description ??
            "Elemento del linguaggio SQL; la posizione dipende dalla clausola corrente.",
        );
    }
    for (const table of tables)
      add(
        table.name,
        tableReference(engine, table),
        "table",
        [table.schema, table.name].filter(Boolean).join(".") +
          " · " +
          table.columns.length +
          " colonne",
        "Origine reale dello schema collegato.",
      );
  }
  const prefix = position.prefix.toLowerCase();
  return items
    .filter(
      (item) =>
        !prefix ||
        item.label.toLowerCase().startsWith(prefix) ||
        (item.filterText ?? "").toLowerCase().startsWith(prefix),
    )
    .filter(
      (item, index, all) =>
        all.findIndex(
          (other) =>
            other.label === item.label && other.insertText === item.insertText,
        ) === index,
    );
}

function mongoCompletions({
  schema,
  text,
  offset,
}: CompletionRequest): SqlCompletion[] {
  const match = text.slice(0, offset).match(/[\w$\u0080-\uFFFF]*$/);
  const prefix = match?.[0] ?? "";
  const start = offset - prefix.length;
  const keys = [
    "find",
    "filter",
    "projection",
    "sort",
    "limit",
    "aggregate",
    "pipeline",
    "cursor",
    "insert",
    "documents",
    "update",
    "updates",
    "q",
    "u",
    "delete",
    "deletes",
    ...Object.keys(MONGO_HELP).filter((key) => key.startsWith("$")),
  ];
  const items: SqlCompletion[] = keys.map((key) => ({
    label: key,
    insertText: key,
    kind: key.startsWith("$") ? "operator" : "keyword",
    detail: "MongoDB Extended JSON",
    documentation: MONGO_HELP[key] ?? "Campo di un comando MongoDB.",
    replacementStart: start,
    replacementEnd: offset,
  }));
  for (const table of dataTables(schema)) {
    items.push({
      label: table.name,
      insertText: table.name,
      kind: "table",
      detail: "Collezione reale",
      documentation: "Collezione " + table.name,
      replacementStart: start,
      replacementEnd: offset,
    });
    for (const column of table.columns)
      items.push({
        label: column.name,
        insertText: column.name,
        kind: "column",
        detail: column.dataType + " · " + table.name,
        documentation:
          "Campo campionato della collezione; i documenti possono avere strutture diverse.",
        replacementStart: start,
        replacementEnd: offset,
      });
  }
  return items
    .filter((item) => item.label.toLowerCase().startsWith(prefix.toLowerCase()))
    .filter(
      (item, index, all) =>
        all.findIndex(
          (other) => other.label === item.label && other.kind === item.kind,
        ) === index,
    );
}

export function getFunctionSignature(
  text: string,
  offset: number,
  engine: Engine,
): { fn: SqlFunction; activeParameter: number } | null {
  const list = significant(text.slice(0, offset));
  const stack: { name: string; commas: number }[] = [];
  for (let i = 0; i < list.length; i++) {
    if (isSymbol(list[i], "("))
      stack.push({ name: list[i - 1]?.value.toUpperCase() ?? "", commas: 0 });
    else if (isSymbol(list[i], ")")) stack.pop();
    else if (isSymbol(list[i], ",") && stack.length)
      stack[stack.length - 1].commas++;
  }
  for (const frame of stack.reverse()) {
    const fn = functionsFor(engine).find((fn) => fn.name === frame.name);
    if (fn)
      return {
        fn,
        activeParameter: Math.min(
          frame.commas,
          Math.max(0, fn.parameters.length - 1),
        ),
      };
  }
  return null;
}

export function explainQuery(
  query: string,
  engine: Engine,
  schema: SchemaSnapshot | null = null,
): QueryExplanation {
  const explanation: QueryExplanation = {
    summary: "Scrivi o seleziona una query per leggerne la spiegazione.",
    steps: [],
    warnings: [],
    parameters: [],
    tables: [],
    logicalOrder: [],
  };
  if (!query.trim()) return explanation;
  if (engine === "mongodb") {
    try {
      const command = JSON.parse(query);
      if (!command || Array.isArray(command) || typeof command !== "object")
        throw new Error("Usa un oggetto comando Extended JSON.");
      const name = Object.keys(command)[0] ?? "comando";
      explanation.summary = MONGO_HELP[name] ?? "Comando MongoDB: " + name;
      explanation.tables =
        typeof command[name] === "string" ? [command[name]] : [];
      explanation.steps.push({
        clause: name,
        title: "Comando " + name,
        explanation: explanation.summary,
        start: 0,
        end: query.length,
      });
      if (Array.isArray(command.pipeline))
        command.pipeline.forEach((stage: unknown, index: number) => {
          if (!stage || typeof stage !== "object") return;
          const key = Object.keys(stage)[0];
          explanation.steps.push({
            clause: key,
            title: "Stadio " + (index + 1) + " · " + key,
            explanation: MONGO_HELP[key] ?? "Stadio della pipeline MongoDB.",
            start: 0,
            end: query.length,
          });
        });
      if (
        ["insert", "update", "delete", "drop", "createIndexes"].includes(
          name,
        ) ||
        command.pipeline?.some(
          (stage: Record<string, unknown>) => stage.$out || stage.$merge,
        )
      )
        explanation.warnings.push(
          "Questo comando può modificare dati o struttura: rivedi l'anteprima e il database di destinazione prima di eseguirlo.",
        );
      if (
        command.filter &&
        JSON.stringify(command.filter).includes('"$eq":null')
      )
        explanation.warnings.push(
          "Un confronto con null può includere campi assenti: usa $exists se vuoi distinguerli.",
        );
      explanation.logicalOrder = explanation.steps.map((step) => step.clause);
    } catch {
      explanation.summary = "Il comando MongoDB non è JSON valido.";
      explanation.warnings.push(
        "Usa doppi apici per nomi e stringhe, niente commenti o virgole finali. L'editor accetta un comando Extended JSON, non db.collection.find().",
      );
    }
    return explanation;
  }
  const list = significant(query);
  let depth = 0;
  for (let i = 0; i < list.length; i++) {
    const token = list[i];
    if (isSymbol(token, "(")) depth++;
    if (isSymbol(token, ")")) depth--;
    if (depth !== 0 || token.kind !== "word") continue;
    const pair =
      token.value.toUpperCase() +
      " " +
      (list[i + 1]?.kind === "word" ? list[i + 1].value.toUpperCase() : "");
    const clause = CLAUSE_HELP[pair] ? pair : token.value.toUpperCase();
    const help = CLAUSE_HELP[clause];
    if (help)
      explanation.steps.push({
        clause,
        title: help.title,
        explanation: help.description,
        start: token.start,
        end: query.length,
      });
  }
  explanation.steps.forEach(
    (step, index) =>
      (step.end = explanation.steps[index + 1]?.start ?? query.length),
  );
  const first = explanation.steps[0]?.clause ?? list[0]?.value.toUpperCase(),
    modifies = list.some(
      (token) =>
        token.kind === "word" &&
        [
          "INSERT",
          "UPDATE",
          "DELETE",
          "CREATE",
          "ALTER",
          "DROP",
          "TRUNCATE",
        ].includes(token.value.toUpperCase()),
    );
  explanation.summary =
    (first === "SELECT" || first === "WITH") && !modifies
      ? "Legge dati e costruisce un risultato; le clausole seguenti spiegano come viene ottenuto."
      : modifies
        ? "La query contiene operazioni che modificano dati o struttura. La spiegazione non esegue il comando."
        : (CLAUSE_HELP[first]?.description ??
          "Analisi locale delle clausole riconosciute, senza eseguire la query.");
  explanation.tables = [
    ...new Set(
      parseSqlAliases(query, schema).map((binding) => binding.table.name),
    ),
  ];
  const characters = query.split("");
  for (const token of tokens(query))
    if (
      token.kind === "string" ||
      token.kind === "comment" ||
      token.kind === "identifier"
    )
      characters.fill(" ", token.start, token.end);
  const masked = characters.join("");
  explanation.parameters = [
    ...new Set(
      masked.match(
        /\$\d+|(?<!:):[A-Za-z_]\w*|@[A-Za-z_]\w*|\$(?!\d)[A-Za-z_]\w*|\?\d*/g,
      ) ?? [],
    ),
  ];
  for (const step of explanation.steps.filter((step) =>
    ["UPDATE", "DELETE"].includes(step.clause),
  )) {
    const end =
      list.find((token) => isSymbol(token, ";") && token.start > step.start)
        ?.start ?? query.length;
    if (
      !explanation.steps.some(
        (where) =>
          where.clause === "WHERE" &&
          where.start > step.start &&
          where.start < end,
      )
    )
      explanation.warnings.push(
        step.clause + " senza WHERE coinvolge tutte le righe della tabella.",
      );
  }
  if (/(?:=|<>|!=)\s*NULL\b/i.test(masked))
    explanation.warnings.push(
      "Per verificare NULL usa IS NULL o IS NOT NULL: = NULL non produce il confronto desiderato.",
    );
  if (
    explanation.steps.some((step) => step.clause === "LIMIT") &&
    !explanation.steps.some((step) => step.clause === "ORDER BY")
  )
    explanation.warnings.push(
      "LIMIT senza ORDER BY non garantisce quali righe verranno scelte.",
    );
  if (first === "CREATE" || first === "ALTER")
    if (engine === "mysql" || engine === "mariadb")
      explanation.warnings.push(
        "Alcuni DDL di questo motore eseguono commit impliciti: non contare su ROLLBACK per annullarli.",
      );
  explanation.logicalOrder = [
    "FROM / JOIN",
    "WHERE",
    "GROUP BY",
    "HAVING",
    "SELECT",
    "ORDER BY",
    "LIMIT / OFFSET",
  ];
  return explanation;
}

export function explainQueryError(error: string, engine: Engine): string[] {
  const text = error.toLowerCase();
  if (/foreign key|23503/.test(text))
    return [
      "Il valore deve riferirsi a una riga esistente nella tabella collegata.",
      "Controlla la chiave esterna nello schema e l'ordine con cui inserisci o cancelli i dati.",
    ];
  if (
    /no such table|(?:relation|table)[^\n]*does not exist|42p01|1146/.test(text)
  )
    return [
      "Verifica connessione, database e nome della tabella; aggiorna lo schema.",
      "Dopo FROM o JOIN usa Ctrl+Spazio per scegliere un'origine reale.",
    ];
  if (
    /no such column|unknown column|column[^\n]*does not exist|42703|1054/.test(
      text,
    )
  )
    return [
      "Controlla il nome della colonna e l'alias dell'origine.",
      "Digita alias. per vedere soltanto le colonne disponibili; verifica anche maiuscole e identificatori quotati.",
    ];
  if (/ambiguous|42702|1052/.test(text))
    return [
      "La colonna esiste in più origini: aggiungi l'alias, per esempio c.id oppure o.id.",
    ];
  if (/(?:function|operator)[^\n]*does not exist|42883/.test(text))
    return [
      "Controlla il nome della funzione o dell'operatore e i tipi dei suoi argomenti.",
      "Apri la firma della funzione nell'editor: alcune varianti richiedono un cast esplicito o appartengono a un altro dialetto.",
    ];
  if (/group by|42803|only_full_group_by|1055/.test(text))
    return [
      "Ogni espressione SELECT non aggregata deve appartenere a GROUP BY.",
      "Usa WHERE per filtrare righe e HAVING per filtrare COUNT, SUM o AVG.",
    ];
  if (/syntax|42601|1064|near.*error/.test(text))
    return [
      "Controlla virgole, parentesi e apici, poi l'ordine SELECT → FROM → WHERE → GROUP BY → HAVING → ORDER BY → LIMIT.",
      "La sintassi deve corrispondere al motore " +
        engine +
        " della connessione attiva.",
    ];
  if (/bind|paramet|argument.*missing/.test(text))
    return [
      engine === "postgresql"
        ? 'Per $1, $2, … usa chiavi JSON "1", "2", … nel pannello Parametri.'
        : "Controlla che ogni parametro abbia un valore nel pannello Parametri; le chiavi non includono : o $.",
      "Usa numeri, stringhe, booleani e null JSON con il tipo previsto dalla colonna.",
    ];
  if (/unique|duplicate|23505/.test(text))
    return [
      "Una chiave primaria o un vincolo UNIQUE impedisce un duplicato.",
      "Controlla la riga già presente e il valore della chiave; non cancellare dati per aggirare il vincolo.",
    ];
  if (/readonly|read.only|permission|not authorized|access denied/.test(text))
    return [
      "Controlla la modalità di sola lettura della connessione e i permessi dell'account.",
      "Il programma non amplia automaticamente i privilegi del database.",
    ];
  if (/interrupt|cancel|11601/.test(text))
    return [
      "L'operazione è stata interrotta. Verifica il risultato effettivo prima di ripetere una scrittura.",
      "Un'interruzione non equivale automaticamente al rollback di una transazione.",
    ];
  if (/timeout|time limit|exceeded time/.test(text))
    return [
      "Riduci i dati con un filtro e controlla gli indici e il piano di esecuzione.",
      "L'aumento del timeout non risolve un collegamento o un filtro inefficiente.",
    ];
  if (
    engine === "mongodb" &&
    /pipeline|unrecognized|unknown operator/.test(text)
  )
    return [
      "Usa un comando Extended JSON e uno stadio valido per ogni oggetto della pipeline.",
      "$match filtra, $group aggrega e $project sceglie i campi; l'ordine degli stadi cambia il risultato.",
    ];
  return [
    "Rileggi il messaggio del motore e verifica nomi, tipi e connessione.",
    "Apri la spiegazione locale della query per controllare le clausole prima di riprovarla.",
  ];
}

function markdown(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+.!|]/g, "\\$&");
}
/** Installed SDK 0.57 public APIs only; all providers are scoped to this editor's model. */
export function installSqlLanguage(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  getContext: () => SqlLanguageContext,
): Monaco.IDisposable {
  const disposables: Monaco.IDisposable[] = [];
  const belongs = (model: Monaco.editor.ITextModel) =>
    editor.getModel() === model;
  for (const language of ["sql", "json"]) {
    disposables.push(
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: [".", "$", '"', "`"],
        provideCompletionItems(model, position) {
          if (!belongs(model)) return { suggestions: [] };
          const context = getContext();
          if ((context.engine === "mongodb") !== (language === "json"))
            return { suggestions: [] };
          const kinds = {
            table: monaco.languages.CompletionItemKind.Struct,
            column: monaco.languages.CompletionItemKind.Field,
            alias: monaco.languages.CompletionItemKind.Variable,
            keyword: monaco.languages.CompletionItemKind.Keyword,
            function: monaco.languages.CompletionItemKind.Function,
            operator: monaco.languages.CompletionItemKind.Operator,
          };
          return {
            suggestions: getSqlCompletions({
              ...context,
              text: model.getValue(),
              offset: model.getOffsetAt(position),
            }).map((item) => ({
              label: item.label,
              insertText: item.insertText,
              kind: kinds[item.kind],
              detail: item.detail,
              insertTextRules:
                item.kind === "function"
                  ? monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet
                  : undefined,
              command:
                item.kind === "function"
                  ? {
                      id: "editor.action.triggerParameterHints",
                      title: "Mostra argomenti",
                    }
                  : item.kind === "alias"
                    ? {
                        id: "editor.action.triggerSuggest",
                        title: "Colonne dell'alias",
                      }
                    : undefined,
              documentation: {
                value: markdown(item.documentation),
                isTrusted: false,
              },
              filterText: item.filterText ?? item.label,
              sortText:
                (item.kind === "column"
                  ? "0"
                  : item.kind === "table"
                    ? "1"
                    : "2") + item.label,
              range: monaco.Range.fromPositions(
                model.getPositionAt(item.replacementStart),
                model.getPositionAt(item.replacementEnd),
              ),
            })),
          };
        },
      }),
    );
    disposables.push(
      monaco.languages.registerHoverProvider(language, {
        provideHover(model, position) {
          if (!belongs(model)) return null;
          const context = getContext(),
            wordInfo = model.getWordAtPosition(position),
            word = wordInfo?.word ?? "",
            line = model.getLineContent(position.lineNumber);
          if (!wordInfo) return null;
          const before = line.slice(0, wordInfo.startColumn - 1),
            after = line.slice(wordInfo.endColumn - 1);
          const mongoWord = word.startsWith("$")
            ? word
            : before.endsWith("$")
              ? "$" + word
              : word;
          if (context.engine === "mongodb") {
            const help = MONGO_HELP[mongoWord];
            return help
              ? {
                  contents: [
                    {
                      value: markdown(mongoWord) + " — " + markdown(help),
                      isTrusted: false,
                    },
                  ],
                }
              : null;
          }
          const offset = model.getOffsetAt({
            lineNumber: position.lineNumber,
            column: wordInfo.startColumn,
          });
          const token = tokens(model.getValue()).find(
              (token) => token.start <= offset && token.end > offset,
            ),
            quoted = token?.kind === "identifier";
          const prior = before.trimEnd().match(/[A-Za-z]+$/)?.[0] ?? "",
            next = after.trimStart().match(/^[A-Za-z]+/)?.[0] ?? "";
          const keyword = quoted
            ? undefined
            : (CLAUSE_HELP[(prior + " " + word).toUpperCase()] ??
              CLAUSE_HELP[(word + " " + next).toUpperCase()] ??
              CLAUSE_HELP[word.toUpperCase()]);
          const fn =
            !quoted && after.trimStart().startsWith("(")
              ? functionsFor(context.engine).find(
                  (fn) => fn.name === word.toUpperCase(),
                )
              : undefined;
          if (keyword || fn)
            return {
              contents: [
                {
                  value:
                    markdown(keyword?.title ?? fn!.signature) +
                    "\n\n" +
                    markdown(keyword?.description ?? fn!.description),
                  isTrusted: false,
                },
              ],
            };
          const candidates = getSqlCompletions({
            ...context,
            text: model.getValue(),
            offset,
          }).filter(
            (item) =>
              item.kind === "column" &&
              (item.filterText ?? item.label) === word,
          );
          if (candidates.length)
            return {
              contents: candidates.slice(0, 4).map((item) => ({
                value:
                  markdown(item.label) +
                  " — " +
                  markdown(item.detail) +
                  "\n\n" +
                  markdown(item.documentation),
                isTrusted: false,
              })),
            };
          const alias = parseSqlAliases(model.getValue(), context.schema).find(
            (binding) => binding.alias === word,
          );
          return alias
            ? {
                contents: [
                  {
                    value:
                      markdown(
                        "Alias " + alias.alias + " → " + alias.table.name,
                      ) +
                      "\n\n" +
                      markdown(
                        alias.table.columns.length +
                          " colonne. Digita il punto per completarle.",
                      ),
                    isTrusted: false,
                  },
                ],
              }
            : null;
        },
      }),
    );
  }
  disposables.push(
    monaco.languages.registerSignatureHelpProvider("sql", {
      signatureHelpTriggerCharacters: ["(", ","],
      signatureHelpRetriggerCharacters: [","],
      provideSignatureHelp(model, position) {
        if (!belongs(model)) return null;
        const help = getFunctionSignature(
          model.getValue(),
          model.getOffsetAt(position),
          getContext().engine,
        );
        if (!help) return null;
        return {
          value: {
            signatures: [
              {
                label: help.fn.signature,
                documentation: { value: help.fn.description, isTrusted: false },
                parameters: help.fn.parameters.map((label) => ({ label })),
              },
            ],
            activeSignature: 0,
            activeParameter: help.activeParameter,
          },
          dispose() {},
        };
      },
    }),
  );
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposable of disposables) disposable.dispose();
    },
  };
}
