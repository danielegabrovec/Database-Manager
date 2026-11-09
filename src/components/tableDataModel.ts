import type {
  CellValue,
  ColumnInfo,
  DataChange,
  DataRow,
  ResultSet,
} from "../types";
import { cellText, parseCell, rowKey, updateChange } from "../utils";

export interface GridCellPosition {
  row: number;
  column: number;
}
export interface MaterializedRow {
  sourceIndex: number;
  values: DataRow;
  change?: DataChange;
}
export function canEditRow(
  editable: boolean,
  editableInserts: boolean,
  change?: DataChange,
): boolean {
  return (
    change?.kind !== "delete" &&
    (editable || (editableInserts && change?.kind === "insert"))
  );
}
export interface ClipboardField {
  text: string;
  quoted: boolean;
}
export interface PasteCell {
  sourceIndex: number;
  column: ColumnInfo;
  before: CellValue;
  after: CellValue;
}
export interface PasteIssue {
  row: number;
  column: number;
  message: string;
}
export interface PastePlan {
  cells: PasteCell[];
  errors: PasteIssue[];
  rowCount: number;
  columnCount: number;
  skippedHeader: boolean;
  newRows?: { sourceIndex: number; values: DataRow }[];
}

/** Original indices stay stable even after a staged insertion is discarded. */
export function materializeRows(
  result: ResultSet,
  changes: Map<number, DataChange>,
): MaterializedRow[] {
  const rows = result.rows.map((original, sourceIndex) => ({
    sourceIndex,
    values: { ...original, ...changes.get(sourceIndex)?.values },
    change: changes.get(sourceIndex),
  }));
  for (const [sourceIndex, change] of [...changes.entries()].sort(
    ([a], [b]) => a - b,
  ))
    if (change.kind === "insert" && sourceIndex >= result.rows.length)
      rows.push({ sourceIndex, values: change.values, change });
  return rows;
}

/** Returns null at a Tab boundary so focus can leave the grid. */
export function navigateGrid(
  position: GridCellPosition,
  key: string,
  rows: number,
  columns: number,
  shift = false,
  control = false,
): GridCellPosition | null {
  if (!rows || !columns) return null;
  let row = Math.max(0, Math.min(rows - 1, position.row)),
    column = Math.max(0, Math.min(columns - 1, position.column));
  switch (key) {
    case "ArrowLeft":
      column--;
      break;
    case "ArrowRight":
      column++;
      break;
    case "ArrowUp":
      row--;
      break;
    case "ArrowDown":
      row++;
      break;
    case "PageUp":
      row -= 10;
      break;
    case "PageDown":
      row += 10;
      break;
    case "Home":
      column = 0;
      if (control) row = 0;
      break;
    case "End":
      column = columns - 1;
      if (control) row = rows - 1;
      break;
    case "Enter":
      row += shift ? -1 : 1;
      break;
    case "Tab": {
      const index = row * columns + column + (shift ? -1 : 1);
      if (index < 0 || index >= rows * columns) return null;
      return { row: Math.floor(index / columns), column: index % columns };
    }
    default:
      return null;
  }
  return {
    row: Math.max(0, Math.min(rows - 1, row)),
    column: Math.max(0, Math.min(columns - 1, column)),
  };
}

/** RFC-style quoting also works for tabs and multiline spreadsheet cells. */
export function parseDelimited(
  text: string,
  delimiter: "\t" | "," = "\t",
): ClipboardField[][] {
  if (text.length > 4 * 1024 * 1024)
    throw new Error("Il contenuto supera 4 MiB. Usa l’importazione da file.");
  const result: ClipboardField[][] = [];
  let row: ClipboardField[] = [];
  let value = "";
  let quoted = false;
  let inQuote = false;
  let afterQuote = false;
  let fieldCount = 0;
  const field = () => {
    fieldCount++;
    if (fieldCount > 50000)
      throw new Error("Incolla al massimo 50.000 celle alla volta.");
    if (row.length >= 1000)
      throw new Error("Incolla al massimo 1.000 colonne alla volta.");
    row.push({ text: value, quoted });
    value = "";
    quoted = false;
    afterQuote = false;
  };
  const line = () => {
    field();
    result.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          inQuote = false;
          afterQuote = true;
        }
      } else value += c;
      continue;
    }
    if (c === '"' && !value && !afterQuote) {
      quoted = true;
      inQuote = true;
      continue;
    }
    if (c === delimiter) {
      field();
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      line();
      continue;
    }
    if (afterQuote)
      throw new Error(
        "Dopo una cella tra virgolette sono ammessi soltanto separatore o nuova riga.",
      );
    value += c;
  }
  if (inQuote)
    throw new Error("Il contenuto termina dentro una cella tra virgolette.");
  if (value || quoted || row.length || (!result.length && text.length)) line();
  if (result.length > 10000)
    throw new Error("Incolla al massimo 10.000 righe alla volta.");
  return result;
}

export function serializeDelimited(
  columns: ColumnInfo[],
  rows: DataRow[],
  delimiter: "\t" | "," = "\t",
  headers = true,
): string {
  function encode(text: string, force = false) {
    return force ||
      text === "" ||
      text === "\\N" ||
      text.includes(delimiter) ||
      /["\r\n]/.test(text)
      ? `"${text.replaceAll('"', '""')}"`
      : text;
  }
  const lines: string[] = [];
  if (headers)
    lines.push(columns.map((column) => encode(column.name)).join(delimiter));
  for (const row of rows)
    lines.push(
      columns
        .map((column) => {
          const value = row[column.name];
          return !value || value.type === "null"
            ? "\\N"
            : encode(cellText(value));
        })
        .join(delimiter),
    );
  return lines.join("\r\n");
}

export function headersMatch(
  fields: ClipboardField[] | undefined,
  columns: ColumnInfo[],
  startColumn: number,
): boolean {
  return (
    !!fields?.length &&
    fields.every(
      (field, index) => field.text === columns[startColumn + index]?.name,
    )
  );
}

export function parseClipboardCell(
  field: ClipboardField,
  column: ColumnInfo,
  previous?: CellValue,
): CellValue {
  if (!field.quoted && field.text === "\\N") {
    if (!column.nullable) throw new Error(`${column.name} non ammette NULL.`);
    return { type: "null" };
  }
  // The ordinary text NULL always remains text; only the explicit unquoted \N is null.
  return parseCell(field.text, column, previous, false);
}

export function buildPastePlan(
  result: ResultSet,
  changes: Map<number, DataChange>,
  start: GridCellPosition,
  fields: ClipboardField[][],
  skipHeader = false,
): PastePlan {
  const rows = materializeRows(result, changes);
  const input = skipHeader ? fields.slice(1) : fields;
  const plan: PastePlan = {
    cells: [],
    errors: [],
    rowCount: input.length,
    columnCount: Math.max(0, ...input.map((row) => row.length)),
    skippedHeader: skipHeader,
  };
  input.forEach((line, rowOffset) =>
    line.forEach((field, columnOffset) => {
      const rowIndex = start.row + rowOffset,
        columnIndex = start.column + columnOffset;
      const entry = rows[rowIndex],
        column = result.columns[columnIndex];
      if (!entry || !column) {
        plan.errors.push({
          row: rowOffset + 1,
          column: columnOffset + 1,
          message: !entry
            ? "La riga è oltre i record caricati. Aggiungi un record o carica la pagina necessaria."
            : "La colonna è oltre la struttura della tabella.",
        });
        return;
      }
      if (entry.change?.kind === "delete") {
        plan.errors.push({
          row: rowOffset + 1,
          column: columnOffset + 1,
          message: "La riga è preparata per l’eliminazione.",
        });
        return;
      }
      const before = entry.values[column.name] || { type: "null" as const };
      try {
        const after = parseClipboardCell(field, column, before);
        if (JSON.stringify(before) !== JSON.stringify(after))
          plan.cells.push({
            sourceIndex: entry.sourceIndex,
            column,
            before,
            after,
          });
      } catch (error) {
        plan.errors.push({
          row: rowOffset + 1,
          column: columnOffset + 1,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );
  return plan;
}

export function stageCells(
  result: ResultSet,
  changes: Map<number, DataChange>,
  cells: Pick<PasteCell, "sourceIndex" | "column" | "after">[],
): Map<number, DataChange> {
  const next = new Map(changes);
  const grouped = new Map<number, DataRow>();
  for (const cell of cells) {
    const values = grouped.get(cell.sourceIndex) || {};
    values[cell.column.name] = cell.after;
    grouped.set(cell.sourceIndex, values);
  }
  for (const [index, values] of grouped) {
    const existing = next.get(index);
    if (existing?.kind === "delete")
      throw new Error("Ripristina la riga prima di modificarla.");
    if (existing?.kind === "insert") {
      next.set(index, {
        ...existing,
        values: { ...existing.values, ...values },
      });
      continue;
    }
    const original = result.rows[index];
    if (!original) throw new Error("Riga non trovata nel risultato corrente.");
    const merged = { ...original, ...existing?.values, ...values };
    const change = updateChange(original, merged, result.columns);
    if (change) next.set(index, change);
    else next.delete(index);
  }
  return next;
}

export function stagePastePlan(
  result: ResultSet,
  changes: Map<number, DataChange>,
  plan: PastePlan,
): Map<number, DataChange> {
  if (plan.errors.length)
    throw new Error(
      "L’incolla contiene errori: nessun valore è stato preparato.",
    );
  const next = new Map(changes);
  for (const row of plan.newRows || []) {
    if (row.sourceIndex < result.rows.length || next.has(row.sourceIndex))
      throw new Error(
        "I record di destinazione sono cambiati. Riapri l’anteprima dell’incolla.",
      );
    next.set(row.sourceIndex, {
      kind: "insert",
      key: {},
      original: {},
      values: row.values,
    });
  }
  return stageCells(result, next, plan.cells);
}

/** Append is a distinct operation: it never converts a read-only row into an update. */
export function buildAppendPlan(
  result: ResultSet,
  changes: Map<number, DataChange>,
  fields: ClipboardField[][],
  skipHeader = false,
): PastePlan {
  const input = skipHeader ? fields.slice(1) : fields;
  const plan: PastePlan = {
    cells: [],
    errors: [],
    rowCount: input.length,
    columnCount: Math.max(0, ...input.map((row) => row.length)),
    skippedHeader: skipHeader,
    newRows: [],
  };
  const mapping = skipHeader
    ? (fields[0] || []).map((field, index) => {
        const column = result.columns.find(
          (column) => column.name === field.text,
        );
        if (!column)
          plan.errors.push({
            row: 1,
            column: index + 1,
            message: `Colonna di intestazione sconosciuta: ${field.text || "(vuota)"}`,
          });
        return column;
      })
    : result.columns;
  if (skipHeader) {
    const seen = new Set<string>();
    for (const [columnIndex, column] of mapping.entries()) {
      if (column && seen.has(column.name))
        plan.errors.push({
          row: 1,
          column: columnIndex + 1,
          message: `Intestazione duplicata: ${column.name}`,
        });
      if (column) seen.add(column.name);
    }
  }
  const first = Math.max(
    result.rows.length,
    ...[...changes.keys()].map((index) => index + 1),
  );
  input.forEach((row, rowOffset) => {
    const values: DataRow = {};
    const sourceIndex = first + rowOffset;
    row.forEach((field, index) => {
      const column = mapping[index];
      if (!column) {
        plan.errors.push({
          row: rowOffset + 1,
          column: index + 1,
          message: "La colonna non è presente nella struttura di destinazione.",
        });
        return;
      }
      try {
        const after = parseClipboardCell(field, column);
        values[column.name] = after;
        plan.cells.push({
          sourceIndex,
          column,
          before: { type: "null" },
          after,
        });
      } catch (cause) {
        plan.errors.push({
          row: rowOffset + 1,
          column: index + 1,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
    for (const [columnIndex, column] of result.columns.entries())
      if (
        !Object.hasOwn(values, column.name) &&
        !column.nullable &&
        !column.defaultValue &&
        !column.primaryKey
      )
        plan.errors.push({
          row: rowOffset + 1,
          column: columnIndex + 1,
          message: `Il campo obbligatorio ${column.name} non è stato fornito.`,
        });
    plan.newRows!.push({ sourceIndex, values });
  });
  return plan;
}

export function stageDeleteRows(
  result: ResultSet,
  changes: Map<number, DataChange>,
  indices: Iterable<number>,
): Map<number, DataChange> {
  const next = new Map(changes);
  for (const index of indices) {
    const existing = next.get(index);
    if (existing?.kind === "insert") {
      next.delete(index);
      continue;
    }
    const original = result.rows[index];
    if (!original) continue;
    next.set(index, {
      kind: "delete",
      key: rowKey(original, result.columns),
      original,
      values: existing?.values || {},
    });
  }
  return next;
}

export function visibleSourceIndices(
  items: { index: number; start: number; end: number }[],
  rows: MaterializedRow[],
  scrollTop: number,
  height: number,
  headerHeight = 43,
): number[] {
  const bottom = scrollTop + Math.max(0, height - headerHeight);
  return items
    .filter((item) => item.end > scrollTop && item.start < bottom)
    .map((item) => rows[item.index]?.sourceIndex)
    .filter((index): index is number => index !== undefined);
}
