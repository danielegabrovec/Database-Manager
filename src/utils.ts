import type {
  CellValue,
  ColumnInfo,
  DataChange,
  DataRow,
  TableInfo,
} from "./types";

export function canBrowseData(
  table: Pick<TableInfo, "kind" | "columns">,
): boolean {
  return (
    ["table", "view", "collection"].includes(table.kind.toLowerCase()) ||
    table.columns.length > 0
  );
}

export const newId = () => crypto.randomUUID();
export function cellText(cell?: CellValue): string {
  return !cell || cell.type === "null" ? "NULL" : String(cell.value ?? "");
}
export function parseCell(
  text: string,
  column: ColumnInfo,
  previous?: CellValue,
  nullToken = true,
): CellValue {
  if (text === "NULL" && nullToken) {
    if (!column.nullable && !column.primaryKey)
      throw new Error(`${column.name} non ammette NULL.`);
    return { type: "null" };
  }
  const type = previous?.type !== "null" ? previous?.type : undefined;
  const dbType = column.dataType.toLowerCase();
  if (type === "integer" || /int|serial/.test(dbType)) {
    if (!/^[+-]?\d+$/.test(text))
      throw new Error(`${column.name}: inserisci un numero intero.`);
    return { type: "integer", value: text };
  }
  if (type === "decimal" || /decimal|numeric/.test(dbType)) {
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(text))
      throw new Error(`${column.name}: inserisci un decimale con il punto.`);
    return { type: "decimal", value: text };
  }
  if (type === "float" || /real|float|double/.test(dbType)) {
    if (!Number.isFinite(Number(text)) || !text.trim())
      throw new Error(`${column.name}: numero non valido.`);
    return { type: "float", value: text };
  }
  if (type === "boolean" || /bool/.test(dbType)) {
    if (!["true", "false", "1", "0"].includes(text.toLowerCase()))
      throw new Error(`${column.name}: usa true o false.`);
    return {
      type: "boolean",
      value: ["true", "1"].includes(text.toLowerCase()),
    };
  }
  if (type === "json" || /json|bson/.test(dbType)) {
    JSON.parse(text);
    return { type: "json", value: text };
  }
  return {
    type: type || (/date|time/.test(dbType) ? "datetime" : "text"),
    value: text,
  };
}
export function rowKey(row: DataRow, columns: ColumnInfo[]): DataRow {
  return Object.fromEntries(
    columns.filter((c) => c.primaryKey).map((c) => [c.name, row[c.name]]),
  );
}
export function updateChange(
  original: DataRow,
  values: DataRow,
  columns: ColumnInfo[],
): DataChange | null {
  const changed = Object.fromEntries(
    Object.entries(values).filter(
      ([name, value]) =>
        JSON.stringify(original[name]) !== JSON.stringify(value),
    ),
  );
  if (!Object.keys(changed).length) return null;
  return {
    kind: "update",
    key: rowKey(original, columns),
    original,
    values: changed,
  };
}
/** SQL boundaries ignore quoted strings/identifiers, comments and PostgreSQL dollar strings. */
export function statementAt(sql: string, position: number): string {
  let start = 0;
  let quote = "";
  let dollar = "";
  let lineComment = false;
  let blockDepth = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i],
      next = sql[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockDepth) {
      if (ch === "/" && next === "*") {
        blockDepth++;
        i++;
      } else if (ch === "*" && next === "/") {
        blockDepth--;
        i++;
      }
      continue;
    }
    if (dollar) {
      if (sql.startsWith(dollar, i)) {
        i += dollar.length - 1;
        dollar = "";
      }
      continue;
    }
    if (quote) {
      const end = quote === "[" ? "]" : quote;
      if (ch === end) {
        if (next === end && quote !== "[") i++;
        else quote = "";
      } else if (ch === "\\" && quote === "'") i++;
      continue;
    }
    if (ch === "-" && next === "-") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockDepth = 1;
      i++;
      continue;
    }
    if (["'", '"', "`", "["].includes(ch)) {
      quote = ch;
      continue;
    }
    if (ch === "$") {
      const match = sql.slice(i).match(/^\$(?:[a-zA-Z_][\w]*)?\$/);
      if (match) {
        dollar = match[0];
        i += dollar.length - 1;
        continue;
      }
    }
    if (ch === ";") {
      if (position <= i + 1) return sql.slice(start, i + 1).trim();
      start = i + 1;
    }
  }
  return sql.slice(start).trim();
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function pretty(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
