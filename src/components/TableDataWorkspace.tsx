import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Braces,
  ClipboardPaste,
  Copy,
  FileText,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Table2,
  Trash2,
} from "lucide-react";
import type {
  CellValue,
  ColumnInfo,
  DataChange,
  DataRow,
  Engine,
} from "../types";
import { cellText, errorMessage, parseCell, updateChange } from "../utils";
import { DataGrid } from "./DataGrid";
import type { DataGridHandle, DataGridProps } from "./DataGrid";
import {
  buildPastePlan,
  buildAppendPlan,
  headersMatch,
  materializeRows,
  canEditRow,
  parseDelimited,
  serializeDelimited,
  stageCells,
  stagePastePlan,
  stageDeleteRows,
} from "./tableDataModel";
import type { GridCellPosition, PastePlan } from "./tableDataModel";
import { Button, Field, Modal, Notice } from "./UI";
import { RecordDialog } from "./RecordDialog";
import "../table-editor.css";

export interface TableDataWorkspaceProps extends Omit<
  DataGridProps,
  | "onEditValue"
  | "activeCell"
  | "onActiveCellChange"
  | "selectedRows"
  | "onSelectedRowsChange"
  | "showCellToolbar"
  | "hideHint"
> {
  tableName: string;
  canInsert?: boolean;
  engine?: Engine;
  onChangesChange: (next: Map<number, DataChange>) => void;
  onApply: () => void | Promise<void>;
  onDiscard: () => void;
  onRefresh?: () => void;
  onPreview?: () => void;
  onAddRecord?: () => void;
  applying?: boolean;
  loading?: boolean;
  readOnlyReason?: string;
}
type View = "table" | "record" | "json";
function textValue(value: CellValue | undefined) {
  if (!value || value.type === "null")
    return <span className="dbm-null-value">NULL</span>;
  if (value.value === "")
    return <span className="dbm-empty-value">Stringa vuota</span>;
  return <pre>{cellText(value)}</pre>;
}
function plainRecord(row: Record<string, CellValue>) {
  return Object.fromEntries(
    Object.entries(row).map(([name, cell]) => {
      if (cell.type === "null") return [name, null];
      if (cell.type === "json") {
        try {
          return [name, JSON.parse(String(cell.value))];
        } catch {
          return [name, cell.value];
        }
      }
      if (cell.type === "integer") {
        const number = Number(cell.value);
        return [name, Number.isSafeInteger(number) ? number : cell.value];
      }
      if (cell.type === "float") {
        const number = Number(cell.value);
        return [name, Number.isFinite(number) ? number : cell.value];
      }
      return [name, cell.value ?? null];
    }),
  );
}

export function TableDataWorkspace({
  result,
  changes,
  editable,
  canInsert,
  tableName,
  engine,
  onChangesChange,
  onApply,
  onDiscard,
  onRefresh,
  onPreview,
  onAddRecord,
  applying = false,
  loading = false,
  readOnlyReason,
  ...gridProps
}: TableDataWorkspaceProps) {
  const insertable = canInsert ?? editable;
  const [view, setView] = useState<View>("table");
  const [active, setActive] = useState<GridCellPosition | null>(
    result.rows.length && result.columns.length ? { row: 0, column: 0 } : null,
  );
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [copyScope, setCopyScope] = useState("visible");
  const [includeHeaders, setIncludeHeaders] = useState(true);
  const [typedJson, setTypedJson] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteFormat, setPasteFormat] = useState<"tsv" | "csv">("tsv");
  const [skipHeader, setSkipHeader] = useState(false);
  const [pasteMode, setPasteMode] = useState<"update" | "append">(
    editable ? "update" : "append",
  );
  const [pasteTarget, setPasteTarget] = useState<GridCellPosition>({
    row: 0,
    column: 0,
  });
  const [previewOpen, setPreviewOpen] = useState(false);
  const [localApplying, setLocalApplying] = useState(false);
  const [localRecord, setLocalRecord] = useState<{
    sourceIndex: number;
    values: DataRow;
  } | null>(null);
  const grid = useRef<DataGridHandle>(null);
  const rows = useMemo(
    () => materializeRows(result, changes),
    [result.rows, changes],
  );
  const current = active ? rows[active.row] : rows[0];
  const column = active ? result.columns[active.column] : undefined;
  const paste = useMemo<{ plan: PastePlan | null; error: string }>(() => {
    try {
      const fields = parseDelimited(
        pasteText,
        pasteFormat === "tsv" ? "\t" : ",",
      );
      return {
        plan:
          pasteMode === "append"
            ? buildAppendPlan(result, changes, fields, skipHeader)
            : buildPastePlan(result, changes, pasteTarget, fields, skipHeader),
        error: "",
      };
    } catch (cause) {
      return { plan: null, error: errorMessage(cause) };
    }
  }, [
    pasteText,
    pasteFormat,
    skipHeader,
    result,
    changes,
    pasteTarget,
    pasteMode,
  ]);
  useEffect(() => {
    setActive(
      result.rows.length && result.columns.length
        ? { row: 0, column: 0 }
        : null,
    );
    setSelectedRows(new Set());
    setPasteOpen(false);
    setLocalRecord(null);
    setError("");
    setMessage("");
  }, [result.rows, tableName]);
  useEffect(() => {
    if (selectedRows.size) setCopyScope("selected");
    else setCopyScope((old) => (old === "selected" ? "visible" : old));
  }, [selectedRows.size]);
  function typedEdit(
    sourceIndex: number,
    changedColumn: ColumnInfo,
    value: CellValue,
  ) {
    if (!canEditRow(editable, insertable, changes.get(sourceIndex)))
      throw new Error("Questo record esistente è in sola lettura.");
    setError("");
    onChangesChange(
      stageCells(result, changes, [
        { sourceIndex, column: changedColumn, after: value },
      ]),
    );
  }
  function deleteRow(sourceIndex: number) {
    const existing = changes.get(sourceIndex);
    if (existing?.kind === "delete") {
      const next = new Map(changes);
      const original = result.rows[sourceIndex];
      const restored = original
        ? updateChange(
            original,
            { ...original, ...existing.values },
            result.columns,
          )
        : null;
      if (restored) next.set(sourceIndex, restored);
      else next.delete(sourceIndex);
      onChangesChange(next);
    } else onChangesChange(stageDeleteRows(result, changes, [sourceIndex]));
  }
  function inspectRecord(values: DataRow, sourceIndex: number) {
    if (insertable && changes.get(sourceIndex)?.kind === "insert")
      setLocalRecord({
        sourceIndex,
        values: Object.fromEntries(
          result.columns.map((column) => [
            column.name,
            values[column.name] || { type: "null" },
          ]),
        ),
      });
    else gridProps.onSelect(values, sourceIndex);
  }
  function saveLocalRecord(
    values: Record<string, string>,
    nullFields: string[],
  ) {
    if (!localRecord) return;
    try {
      if (!insertable)
        throw new Error(
          "L’aggiunta di nuovi record non è più disponibile sulla connessione corrente.",
        );
      const existing = changes.get(localRecord.sourceIndex);
      if (existing?.kind !== "insert")
        throw new Error(
          "Il nuovo record non è più preparato. Riapri la scheda.",
        );
      const parsed: DataRow = {};
      for (const column of result.columns) {
        const isNull = nullFields.includes(column.name);
        if (isNull && (column.primaryKey || column.defaultValue)) continue;
        parsed[column.name] = isNull
          ? parseCell("NULL", column, undefined, true)
          : parseCell(
              values[column.name],
              column,
              existing.values[column.name],
              false,
            );
      }
      const next = new Map(changes);
      next.set(localRecord.sourceIndex, { ...existing, values: parsed });
      onChangesChange(next);
      setLocalRecord(null);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  function changeSelection(next: Set<number>) {
    setSelectedRows(next);
    setMessage("");
  }
  async function copy(format: "tsv" | "csv") {
    setError("");
    try {
      const visible =
        grid.current?.visibleSourceRows() ||
        [current?.sourceIndex].filter(
          (value): value is number => value !== undefined,
        );
      const indices =
        copyScope === "selected"
          ? selectedRows
          : copyScope === "page"
            ? new Set(rows.map((row) => row.sourceIndex))
            : new Set(visible);
      const chosen = rows.filter(
        (row) => indices.has(row.sourceIndex) && row.change?.kind !== "delete",
      );
      if (!chosen.length)
        throw new Error("Nessun record da copiare nell’area scelta.");
      await navigator.clipboard.writeText(
        serializeDelimited(
          result.columns,
          chosen.map((row) => row.values),
          format === "tsv" ? "\t" : ",",
          includeHeaders,
        ),
      );
      setMessage(`${chosen.length} record copiati in ${format.toUpperCase()}.`);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  function openPaste(text = "") {
    if (!editable && !insertable) return;
    const mode = editable ? "update" : "append";
    setPasteMode(mode);
    const target =
      mode === "append"
        ? { row: rows.length, column: 0 }
        : active || { row: 0, column: 0 };
    setPasteTarget(target);
    setPasteText(text);
    setPasteFormat("tsv");
    setPasteOpen(true);
    setError("");
    try {
      const first = parseDelimited(text)[0];
      setSkipHeader(
        mode === "append"
          ? !!first?.length &&
              first.every((field) =>
                result.columns.some((column) => column.name === field.text),
              )
          : headersMatch(first, result.columns, target.column),
      );
    } catch {
      setSkipHeader(false);
    }
  }
  function stagePaste() {
    if (
      (pasteMode === "update" && !editable) ||
      (pasteMode === "append" && !insertable)
    ) {
      setError(
        "Questa modalità di incolla non è consentita sulla connessione corrente.",
      );
      return;
    }
    const plan = paste.plan;
    if (!plan || plan.errors.length || paste.error || !plan.cells.length)
      return;
    try {
      onChangesChange(stagePastePlan(result, changes, plan));
      setPasteOpen(false);
      setMessage(
        pasteMode === "append"
          ? `${plan.newRows?.length || 0} nuovi record preparati. Verifica l’anteprima e premi Applica per salvarli.`
          : `${plan.cells.length} valori preparati. Verifica l’anteprima e premi Applica per salvarli.`,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function apply() {
    setLocalApplying(true);
    setError("");
    try {
      await onApply();
      setPreviewOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLocalApplying(false);
    }
  }
  function preview() {
    if (onPreview) onPreview();
    else setPreviewOpen(true);
  }
  function recordStep(delta: number) {
    const index = Math.max(
      0,
      Math.min(rows.length - 1, (active?.row || 0) + delta),
    );
    setActive({
      row: index,
      column: Math.max(
        0,
        Math.min(result.columns.length - 1, active?.column || 0),
      ),
    });
  }
  const busy = applying || localApplying;
  return (
    <section
      className="table-data-workspace"
      aria-label={`Dati tabella ${tableName}`}
    >
      <header className="dbm-table-heading">
        <div>
          <Table2 size={20} />
          <div>
            <h2>
              Dati tabella <span>{tableName}</span>
            </h2>
            <p>
              {result.columns.length} colonne · {rows.length} record caricati
              {engine ? ` · ${engine}` : ""}
            </p>
          </div>
        </div>
        <span
          className={`dbm-editability ${editable ? "writable" : "readonly"}`}
        >
          <Pencil size={12} />
          {editable
            ? "Modifica disponibile"
            : insertable
              ? "Solo nuovi record"
              : "Sola lettura"}
        </span>
      </header>
      <div className="dbm-table-toolbar">
        <div
          className="dbm-view-switch"
          role="group"
          aria-label="Vista dei dati"
        >
          {(
            [
              ["table", "Tabella", Table2],
              ["record", "Scheda", FileText],
              ["json", "JSON", Braces],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              className={view === id ? "active" : ""}
              aria-pressed={view === id}
              onClick={() => setView(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
        <div className="dbm-toolbar-separator" />
        {onRefresh && (
          <Button
            variant="ghost"
            disabled={loading || busy}
            onClick={onRefresh}
          >
            <RefreshCw size={13} className={loading ? "spin" : ""} />
            Aggiorna
          </Button>
        )}
        {(editable || (insertable && current?.change?.kind === "insert")) && (
          <>
            <Button
              disabled={!active || busy || current?.change?.kind === "delete"}
              onClick={() => {
                if (view === "table") grid.current?.beginEdit();
                else if (current)
                  inspectRecord(current.values, current.sourceIndex);
              }}
            >
              <Pencil size={13} />
              Modifica{view === "table" && <kbd>F2</kbd>}
            </Button>
            <Button
              variant="ghost"
              disabled={
                !column?.nullable || !active || view !== "table" || busy
              }
              onClick={() => grid.current?.setSelectedNull()}
            >
              NULL
            </Button>

            {editable && (
              <Button
                variant="ghost"
                disabled={!selectedRows.size || busy}
                onClick={() =>
                  onChangesChange(
                    stageDeleteRows(result, changes, selectedRows),
                  )
                }
              >
                <Trash2 size={13} />
                Elimina selezionati
                {selectedRows.size > 0 && ` (${selectedRows.size})`}
              </Button>
            )}
          </>
        )}
        {insertable && onAddRecord && (
          <Button onClick={onAddRecord} disabled={busy}>
            <Plus size={13} />
            Nuovo record
          </Button>
        )}
        {!editable &&
          insertable &&
          [...selectedRows].some(
            (index) => changes.get(index)?.kind === "insert",
          ) && (
            <Button
              variant="ghost"
              onClick={() =>
                onChangesChange(
                  stageDeleteRows(
                    result,
                    changes,
                    [...selectedRows].filter(
                      (index) => changes.get(index)?.kind === "insert",
                    ),
                  ),
                )
              }
            >
              <Trash2 size={13} />
              Rimuovi nuovi record preparati
            </Button>
          )}
        <div className="spacer" />
        <div className="dbm-copy-controls">
          <select
            aria-label="Area da copiare"
            value={copyScope}
            onChange={(event) => setCopyScope(event.target.value)}
          >
            <option value="visible">Area visibile</option>
            <option value="page">Pagina caricata</option>
            <option value="selected" disabled={!selectedRows.size}>
              Righe selezionate ({selectedRows.size})
            </option>
          </select>
          <Button
            variant="ghost"
            onClick={() => copy("tsv")}
            disabled={!rows.length}
          >
            <Copy size={13} />
            TSV
          </Button>
          <Button
            variant="ghost"
            onClick={() => copy("csv")}
            disabled={!rows.length}
          >
            CSV
          </Button>
          <label>
            <input
              type="checkbox"
              checked={includeHeaders}
              onChange={(event) => setIncludeHeaders(event.target.checked)}
            />
            Intestazioni
          </label>
        </div>
        {(editable || insertable) && (
          <Button
            onClick={() => openPaste()}
            disabled={(!rows.length && !insertable) || busy}
          >
            <ClipboardPaste size={13} />
            {editable ? "Incolla TSV" : "Incolla nuovi record"}
          </Button>
        )}
      </div>
      {!editable && (
        <div className="dbm-readonly-notice">
          {readOnlyReason ||
            (insertable
              ? "I record esistenti sono in sola lettura. Puoi aggiungere nuovi record, anche senza chiave primaria, senza modificare quelli già presenti."
              : "Per modificare i record servono una chiave stabile e una connessione scrivibile. Lettura, selezione e copia restano disponibili.")}
        </div>
      )}
      {message && (
        <div className="dbm-workspace-message" role="status">
          {message}
        </div>
      )}
      {error && (
        <div className="dbm-grid-error" role="alert">
          {error}
        </div>
      )}
      <div className="dbm-data-content">
        {view === "table" ? (
          <DataGrid
            {...gridProps}
            ref={grid}
            result={result}
            changes={changes}
            editable={editable}
            editableInserts={insertable}
            onEditValue={typedEdit}
            onDelete={deleteRow}
            onSelect={inspectRecord}
            activeCell={active}
            onActiveCellChange={setActive}
            selectedRows={selectedRows}
            onSelectedRowsChange={changeSelection}
            onPasteText={openPaste}
            allowPaste={editable || insertable}
            onError={setError}
            ariaLabel={`Dati tabella ${tableName}`}
            showCellToolbar={false}
          />
        ) : current ? (
          <div className="dbm-record-view">
            <div className="dbm-record-navigation">
              <Button
                variant="ghost"
                disabled={(active?.row || 0) === 0}
                onClick={() => recordStep(-1)}
              >
                <ArrowLeft size={14} />
              </Button>
              <strong>
                Record {(active?.row || 0) + 1} di {rows.length}
              </strong>
              <Button
                variant="ghost"
                disabled={(active?.row || 0) >= rows.length - 1}
                onClick={() => recordStep(1)}
              >
                <ArrowRight size={14} />
              </Button>
              <span className="spacer" />
              {current.change && (
                <span className="dbm-pending-badge">
                  {current.change.kind === "delete"
                    ? "Eliminazione preparata"
                    : current.change.kind === "insert"
                      ? "Nuovo record preparato"
                      : "Modifiche preparate"}
                </span>
              )}
              {(editable ||
                (insertable && current.change?.kind === "insert")) &&
                current.change?.kind !== "delete" && (
                  <Button
                    onClick={() =>
                      inspectRecord(current.values, current.sourceIndex)
                    }
                  >
                    <Pencil size={13} />
                    Modifica scheda
                  </Button>
                )}
            </div>
            {view === "record" ? (
              <dl className="dbm-record-details">
                {result.columns.map((item) => (
                  <div key={item.name}>
                    <dt>
                      {item.name}
                      <small>
                        {item.dataType}
                        {item.primaryKey ? " · chiave primaria" : ""}
                      </small>
                    </dt>
                    <dd>{textValue(current.values[item.name])}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <div className="dbm-json-view">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={typedJson}
                    onChange={(event) => setTypedJson(event.target.checked)}
                  />
                  Mostra tipi originali
                </label>
                <pre>
                  {JSON.stringify(
                    typedJson ? current.values : plainRecord(current.values),
                    null,
                    2,
                  )}
                </pre>
                <p>
                  Interi estesi e decimali conservano la precisione originale.
                  La vista con tipi permette di distinguere NULL, testo, date e
                  documenti.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="empty-state">
            <Table2 size={27} />
            <h2>Nessun record in questa pagina</h2>
            {insertable && onAddRecord && (
              <Button onClick={onAddRecord}>
                <Plus size={14} />
                Nuovo record
              </Button>
            )}
          </div>
        )}
        {loading && (
          <div className="dbm-table-loading" role="status">
            <LoaderCircle size={20} className="spin" />
            Lettura dei dati…
          </div>
        )}
      </div>
      <footer className="dbm-table-footer">
        <span>
          {selectedRows.size
            ? `${selectedRows.size} record selezionati`
            : column && active
              ? `Riga ${(gridProps.rowOffset || 0) + active.row + 1} · ${column.name} · ${column.dataType}`
              : "Seleziona una cella o un record"}
        </span>
        <span className="spacer" />
        {changes.size > 0 ? (
          <>
            <span className="dbm-pending-badge">
              {changes.size} record con modifiche preparate
            </span>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                onDiscard();
                setMessage("");
              }}
            >
              Scarta
            </Button>
            <Button disabled={busy} onClick={preview}>
              Anteprima
            </Button>
            <Button variant="primary" busy={busy} onClick={preview}>
              <Save size={13} />
              Applica modifiche
            </Button>
          </>
        ) : (
          <span className="muted">Nessuna modifica da salvare</span>
        )}
      </footer>
      {localRecord && (
        <RecordDialog
          row={localRecord.values}
          columns={result.columns}
          editable
          onClose={() => setLocalRecord(null)}
          onSave={saveLocalRecord}
        />
      )}
      {pasteOpen && (
        <Modal
          title="Incolla dati · anteprima prima di preparare"
          onClose={() => setPasteOpen(false)}
          wide
        >
          <div className="modal-body stack">
            <Notice>
              Destinazione: <strong>{tableName}</strong>, riga{" "}
              <strong>{pasteTarget.row + 1}</strong>, colonna{" "}
              <strong>{result.columns[pasteTarget.column]?.name || "—"}</strong>
              . I valori vengono preparati localmente; il database cambia
              soltanto dopo Applica.
            </Notice>
            <div className="form-grid">
              <Field label="Modalità incolla">
                <select
                  value={pasteMode}
                  onChange={(event) =>
                    setPasteMode(event.target.value as "update" | "append")
                  }
                >
                  <option value="update" disabled={!editable}>
                    Modifica record esistenti
                  </option>
                  <option value="append" disabled={!insertable}>
                    Aggiungi nuovi record
                  </option>
                </select>
              </Field>
              <Field label="Formato del contenuto">
                <select
                  value={pasteFormat}
                  onChange={(event) =>
                    setPasteFormat(event.target.value as "tsv" | "csv")
                  }
                >
                  <option value="tsv">
                    TSV · colonne separate da tabulazioni
                  </option>
                  <option value="csv">CSV · colonne separate da virgole</option>
                </select>
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={skipHeader}
                  onChange={(event) => setSkipHeader(event.target.checked)}
                />
                La prima riga contiene le intestazioni
              </label>
            </div>
            {pasteMode === "append" && (
              <Notice>
                Ogni riga diventa un nuovo record. Con le intestazioni puoi
                scegliere e ordinare le colonne; i campi omessi usano gli
                eventuali valori predefiniti del database.
              </Notice>
            )}
            <Field
              label="Contenuto dagli appunti"
              hint={
                'NULL rimane testo. Per un valore nullo usa \\N senza virgolette; "\\N" rimane testo. Sono ammesse celle tra virgolette e su più righe.'
              }
            >
              <textarea
                rows={6}
                className="mono"
                autoFocus
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder="Incolla qui una selezione da un foglio o da una tabella…"
              />
            </Field>
            {paste.error && <Notice tone="error">{paste.error}</Notice>}
            {paste.plan && (
              <>
                <div className="dbm-paste-summary">
                  <strong>
                    {paste.plan.rowCount} righe × {paste.plan.columnCount}{" "}
                    colonne
                  </strong>
                  <span>{paste.plan.cells.length} valori diversi</span>
                  <span>{paste.plan.errors.length} errori</span>
                </div>
                {paste.plan.errors.length > 0 && (
                  <Notice tone="error">
                    Correggi tutti gli errori prima di preparare i valori.
                    <ul>
                      {paste.plan.errors.slice(0, 30).map((issue, index) => (
                        <li key={index}>
                          Riga {issue.row}, colonna {issue.column}:{" "}
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                    {paste.plan.errors.length > 30 && (
                      <small>
                        Altri {paste.plan.errors.length - 30} errori.
                      </small>
                    )}
                  </Notice>
                )}
                <div className="dbm-paste-preview">
                  <table className="plain-table">
                    <thead>
                      <tr>
                        <th>Record</th>
                        <th>Colonna</th>
                        <th>Prima</th>
                        <th>Dopo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paste.plan.cells.slice(0, 100).map((cell, index) => (
                        <tr key={index}>
                          <td>{cell.sourceIndex + 1}</td>
                          <td>
                            {cell.column.name}
                            <small>{cell.after.type}</small>
                          </td>
                          <td>{textValue(cell.before)}</td>
                          <td>{textValue(cell.after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {paste.plan.cells.length > 100 && (
                    <p>
                      Anteprima dei primi 100 valori; verranno preparati tutti i{" "}
                      {paste.plan.cells.length} valori convalidati.
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
          <footer>
            <Button onClick={() => setPasteOpen(false)}>Annulla</Button>
            <span className="spacer" />
            <Button
              variant="primary"
              disabled={
                !!paste.error ||
                !paste.plan?.cells.length ||
                !!paste.plan.errors.length
              }
              onClick={stagePaste}
            >
              {pasteMode === "append"
                ? `Prepara ${paste.plan?.newRows?.length || 0} nuovi record`
                : `Prepara ${paste.plan?.cells.length || 0} valori`}
            </Button>
          </footer>
        </Modal>
      )}
      {previewOpen && (
        <Modal
          title={`Modifiche preparate · ${tableName}`}
          onClose={() => {
            if (!busy) setPreviewOpen(false);
          }}
          wide
        >
          <div className="modal-body stack">
            <Notice>
              <strong>{changes.size}</strong> operazioni sul database attivo.
              Controlla i valori prima di applicarle.
            </Notice>
            {[...changes.entries()].slice(0, 100).map(([index, change]) => (
              <div className={`change-preview ${change.kind}`} key={index}>
                <h3>
                  {change.kind === "insert"
                    ? "Inserimento"
                    : change.kind === "delete"
                      ? "Eliminazione"
                      : "Modifica"}{" "}
                  · record {index + 1}
                </h3>
                <table className="plain-table">
                  <thead>
                    <tr>
                      <th>Campo</th>
                      <th>Prima</th>
                      <th>Dopo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(
                      change.kind === "delete"
                        ? change.original
                        : change.values,
                    ).map((name) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{textValue(change.original[name])}</td>
                        <td>
                          {change.kind === "delete"
                            ? "—"
                            : textValue(change.values[name])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
            {changes.size > 100 && (
              <p>
                Anteprima dei primi 100 record; l’operazione riguarda tutti i{" "}
                {changes.size} record preparati.
              </p>
            )}
          </div>
          <footer>
            <Button disabled={busy} onClick={() => setPreviewOpen(false)}>
              Torna ai dati
            </Button>
            <span className="spacer" />
            <Button variant="primary" busy={busy} onClick={apply}>
              <Save size={14} />
              Conferma e applica
            </Button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
