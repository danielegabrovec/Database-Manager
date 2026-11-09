import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  Check,
  KeyRound,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import type {
  CellValue,
  ColumnInfo,
  DataChange,
  DataRow,
  ResultSet,
} from "../types";
import { cellText, parseCell } from "../utils";
import {
  materializeRows,
  canEditRow,
  navigateGrid,
  serializeDelimited,
  visibleSourceIndices,
} from "./tableDataModel";
import type { GridCellPosition, MaterializedRow } from "./tableDataModel";
import "../table-editor.css";

export interface DataGridProps {
  result: ResultSet;
  changes: Map<number, DataChange>;
  editable: boolean;
  editableInserts?: boolean;
  onEdit: (index: number, column: ColumnInfo, value: string) => void;
  onDelete: (index: number) => void;
  onSelect: (row: DataRow, index: number) => void;
  onSort?: (name: string) => void;
  sortColumn?: string;
  sortDesc?: boolean;
  /** Typed commits preserve the difference between actual NULL and the text NULL. */
  onEditValue?: (index: number, column: ColumnInfo, value: CellValue) => void;
  activeCell?: GridCellPosition | null;
  onActiveCellChange?: (position: GridCellPosition) => void;
  selectedRows?: Set<number>;
  onSelectedRowsChange?: (rows: Set<number>) => void;
  onPasteText?: (text: string) => void;
  allowPaste?: boolean;
  onError?: (message: string) => void;
  ariaLabel?: string;
  rowOffset?: number;
  hideHint?: boolean;
  showCellToolbar?: boolean;
}
export interface DataGridHandle {
  beginEdit: () => void;
  focusCell: (position: GridCellPosition) => void;
  visibleSourceRows: () => number[];
  setSelectedNull: () => void;
}
interface CellEdit {
  position: GridCellPosition;
  draft: string;
  isNull: boolean;
  error: string;
  selectAll: boolean;
}
function sameCell(
  left: GridCellPosition | null | undefined,
  right: GridCellPosition | null | undefined,
) {
  return left?.row === right?.row && left?.column === right?.column;
}

function InlineEditor({
  edit,
  column,
  onChange,
  onCommit,
  onCancel,
}: {
  edit: CellEdit;
  column: ColumnInfo;
  onChange: (patch: Partial<CellEdit>) => void;
  onCommit: (key?: string, shift?: boolean) => void;
  onCancel: () => void;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const nullControl = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (edit.isNull) nullControl.current?.focus();
    else {
      field.current?.focus();
      if (edit.selectAll) field.current?.select();
    }
  }, [edit.position.row, edit.position.column, edit.isNull]);
  return (
    <div
      className="dbm-cell-editor"
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node))
          onCommit();
      }}
    >
      <textarea
        ref={field}
        aria-label={`Modifica ${column.name}`}
        rows={2}
        value={edit.draft}
        disabled={edit.isNull}
        onChange={(event) => onChange({ draft: event.target.value, error: "" })}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (
            event.key === "Tab" ||
            (event.key === "Enter" && !event.shiftKey)
          ) {
            event.preventDefault();
            event.stopPropagation();
            onCommit(event.key, event.shiftKey);
          }
        }}
      />
      <div className="dbm-cell-editor-actions">
        <label>
          <input
            ref={nullControl}
            type="checkbox"
            checked={edit.isNull}
            disabled={!column.nullable}
            onChange={(event) =>
              onChange({ isNull: event.target.checked, error: "" })
            }
          />
          NULL
        </label>
        <span />
        <button
          type="button"
          title="Prepara valore (Invio)"
          aria-label="Prepara valore"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onCommit()}
        >
          <Check size={14} />
        </button>
        <button
          type="button"
          title="Annulla modifica (Esc)"
          aria-label="Annulla modifica cella"
          onMouseDown={(event) => event.preventDefault()}
          onClick={onCancel}
        >
          <X size={14} />
        </button>
      </div>
      {edit.error && (
        <p className="dbm-cell-editor-error" role="alert">
          {edit.error}
        </p>
      )}
    </div>
  );
}

export const DataGrid = forwardRef<DataGridHandle, DataGridProps>(
  function DataGrid(
    {
      result,
      changes,
      editable,
      editableInserts = false,
      onEdit,
      onDelete,
      onSelect,
      onSort,
      sortColumn,
      sortDesc,
      onEditValue,
      activeCell: controlledCell,
      onActiveCellChange,
      selectedRows: controlledRows,
      onSelectedRowsChange,
      onPasteText,
      allowPaste = editable,
      onError,
      ariaLabel = "Griglia dei risultati",
      rowOffset = 0,
      hideHint = false,
      showCellToolbar = true,
    },
    ref,
  ) {
    const parent = useRef<HTMLDivElement>(null);
    const finishing = useRef(false);
    const identifier = useId().replaceAll(":", "");
    const [localCell, setLocalCell] = useState<GridCellPosition | null>(null);
    const [localRows, setLocalRows] = useState<Set<number>>(new Set());
    const [editing, setEditing] = useState<CellEdit | null>(null);
    const [error, setError] = useState("");
    const active = controlledCell === undefined ? localCell : controlledCell;
    const selectedRows = controlledRows || localRows;
    const data = useMemo(
      () => materializeRows(result, changes),
      [result.rows, changes],
    );
    const selected = active ? data[active.row] : undefined;
    const selectedColumn = active ? result.columns[active.column] : undefined;
    function report(message: string) {
      setError(message);
      onError?.(message);
    }
    function setCell(position: GridCellPosition, focus = true) {
      setLocalCell(position);
      onActiveCellChange?.(position);
      if (focus) parent.current?.focus({ preventScroll: true });
    }
    function setRows(next: Set<number>) {
      setLocalRows(next);
      onSelectedRowsChange?.(next);
    }
    function canEdit(position: GridCellPosition) {
      return (
        canEditRow(editable, editableInserts, data[position.row]?.change) &&
        !!data[position.row] &&
        !!result.columns[position.column] &&
        data[position.row].change?.kind !== "delete"
      );
    }
    function beginEdit(initial?: string) {
      finishing.current = false;
      if (!active || !canEdit(active)) return;
      const cell = data[active.row].values[result.columns[active.column].name];
      setError("");
      setEditing({
        position: { ...active },
        draft: initial ?? (cell?.type === "null" ? "" : cellText(cell)),
        isNull: initial === undefined && cell?.type === "null",
        error: "",
        selectAll: initial === undefined,
      });
    }
    function cancelEdit() {
      finishing.current = true;
      setEditing(null);
      requestAnimationFrame(() =>
        parent.current?.focus({ preventScroll: true }),
      );
    }
    function commitEdit(key?: string, shift = false): boolean {
      if (!editing || finishing.current) return true;
      const entry = data[editing.position.row],
        column = result.columns[editing.position.column];
      if (!entry || !column) return false;
      try {
        if (editing.isNull && !column.nullable)
          throw new Error(`${column.name} non ammette NULL.`);
        const before = entry.values[column.name];
        const value: CellValue = editing.isNull
          ? { type: "null" }
          : parseCell(editing.draft, column, before, false);
        finishing.current = true;
        if (JSON.stringify(before) !== JSON.stringify(value)) {
          if (onEditValue) onEditValue(entry.sourceIndex, column, value);
          else
            onEdit(
              entry.sourceIndex,
              column,
              value.type === "null" ? "NULL" : cellText(value),
            );
        }
        setEditing(null);
        setError("");
        const next = key
          ? navigateGrid(
              editing.position,
              key,
              data.length,
              result.columns.length,
              shift,
            )
          : editing.position;
        if (next) {
          setCell(next, false);
          virtual.scrollToIndex(next.row, { align: "auto" });
          requestAnimationFrame(() =>
            parent.current?.focus({ preventScroll: true }),
          );
        } else if (key === "Tab") {
          requestAnimationFrame(() => {
            const root = parent.current;
            if (!root) return;
            const focusable = Array.from(
              document.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]',
              ),
            ).filter(
              (node) => node.offsetParent !== null && !root.contains(node),
            );
            const after = focusable.filter(
              (node) =>
                !!(
                  root.compareDocumentPosition(node) &
                  Node.DOCUMENT_POSITION_FOLLOWING
                ),
            );
            const before = focusable.filter(
              (node) =>
                !!(
                  root.compareDocumentPosition(node) &
                  Node.DOCUMENT_POSITION_PRECEDING
                ),
            );
            (shift ? before[before.length - 1] : after[0])?.focus();
          });
        }
        return true;
      } catch (cause) {
        finishing.current = false;
        const message = cause instanceof Error ? cause.message : String(cause);
        setEditing((old) => (old ? { ...old, error: message } : old));
        report(message);
        return false;
      }
    }
    function chooseCell(position: GridCellPosition) {
      if (editing && !sameCell(editing.position, position) && !commitEdit())
        return;
      setCell(position);
    }
    function setNull() {
      if (!active || !selected || !selectedColumn || !canEdit(active)) return;
      if (!selectedColumn.nullable) {
        report(`${selectedColumn.name} non ammette NULL.`);
        return;
      }
      if (onEditValue)
        onEditValue(selected.sourceIndex, selectedColumn, { type: "null" });
      else onEdit(selected.sourceIndex, selectedColumn, "NULL");
      setError("");
    }
    useEffect(() => {
      setEditing(null);
      setLocalCell(null);
      setLocalRows(new Set());
    }, [result.rows]);
    useEffect(() => {
      if (!editing) finishing.current = false;
    }, [editing]);

    const columns = useMemo<ColumnDef<MaterializedRow>[]>(
      () => [
        {
          id: "_row",
          header: () => (
            <label className="dbm-row-selector">
              <input
                aria-label="Seleziona tutti i record caricati"
                type="checkbox"
                checked={
                  data.length > 0 &&
                  data.every((entry) => selectedRows.has(entry.sourceIndex))
                }
                onChange={(event) =>
                  setRows(
                    event.target.checked
                      ? new Set(data.map((entry) => entry.sourceIndex))
                      : new Set(),
                  )
                }
              />
              <span>#</span>
            </label>
          ),
          size: 84,
          minSize: 84,
          maxSize: 84,
          enableResizing: false,
          cell: (context) => {
            const entry = context.row.original;
            return (
              <div className="dbm-row-selector">
                <input
                  type="checkbox"
                  aria-label={`Seleziona record ${rowOffset + context.row.index + 1}`}
                  checked={selectedRows.has(entry.sourceIndex)}
                  onChange={(event) => {
                    const next = new Set(selectedRows);
                    if (event.target.checked) next.add(entry.sourceIndex);
                    else next.delete(entry.sourceIndex);
                    setRows(next);
                  }}
                />
                <button
                  type="button"
                  className="row-number"
                  title="Apri scheda record"
                  onClick={() => onSelect(entry.values, entry.sourceIndex)}
                >
                  {rowOffset + context.row.index + 1}
                </button>
              </div>
            );
          },
        },
        ...result.columns.map((column, columnIndex) => ({
          id: column.name,
          accessorFn: (entry: MaterializedRow) => entry.values[column.name],
          header: () => (
            <button
              type="button"
              className="column-heading"
              disabled={!onSort}
              onClick={() => onSort?.(column.name)}
              title={`${column.name} · ${column.dataType}`}
            >
              {column.primaryKey && <KeyRound size={11} />}
              <span>
                {column.name}
                <small>
                  {column.dataType}
                  {column.nullable ? " · NULL" : ""}
                </small>
              </span>
              {sortColumn === column.name &&
                (sortDesc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
            </button>
          ),
          size: Math.max(155, Math.min(300, column.name.length * 8 + 95)),
          minSize: 90,
          maxSize: 1200,
          cell: (context: {
            row: { index: number; original: MaterializedRow };
          }) => {
            const position = { row: context.row.index, column: columnIndex };
            const value = context.row.original.values[column.name];
            if (editing && sameCell(editing.position, position))
              return (
                <InlineEditor
                  edit={editing}
                  column={column}
                  onChange={(patch) =>
                    setEditing((old) => (old ? { ...old, ...patch } : old))
                  }
                  onCommit={commitEdit}
                  onCancel={cancelEdit}
                />
              );
            return (
              <span
                className={`dbm-cell-display ${value?.type === "null" || !value ? "dbm-null-value" : ""}`}
                title={`${value?.type || "null"}: ${cellText(value)}`}
              >
                <span>
                  {value?.type === "null" || !value ? "NULL" : cellText(value)}
                </span>
                {canEditRow(
                  editable,
                  editableInserts,
                  context.row.original.change,
                ) && <Pencil size={10} />}
              </span>
            );
          },
        })),
        {
          id: "_actions",
          header: "",
          size: 42,
          minSize: 42,
          maxSize: 42,
          enableResizing: false,
          cell: (context) =>
            canEditRow(
              editable,
              editableInserts,
              context.row.original.change,
            ) ||
            (editable && context.row.original.change?.kind === "delete") ? (
              <button
                type="button"
                className="icon-button subtle"
                title={
                  context.row.original.change?.kind === "delete"
                    ? "Ripristina riga preparata per l’eliminazione"
                    : "Prepara eliminazione della riga"
                }
                aria-label={
                  context.row.original.change?.kind === "delete"
                    ? "Ripristina riga"
                    : "Prepara eliminazione della riga"
                }
                onClick={() => onDelete(context.row.original.sourceIndex)}
              >
                <Trash2 size={14} />
              </button>
            ) : null,
        },
      ],
      [
        result.columns,
        data,
        selectedRows,
        editing,
        editable,
        editableInserts,
        onEdit,
        onEditValue,
        onDelete,
        onSelect,
        onSort,
        sortColumn,
        sortDesc,
        rowOffset,
      ],
    );
    const table = useReactTable({
      data,
      columns,
      getCoreRowModel: getCoreRowModel(),
      getRowId: (row) => String(row.sourceIndex),
      enableColumnResizing: true,
      columnResizeMode: "onChange",
    });
    const rows = table.getRowModel().rows;
    const virtual = useVirtualizer({
      count: rows.length,
      getScrollElement: () => parent.current,
      estimateSize: () => 37,
      overscan: 8,
      initialRect: { width: 900, height: 350 },
    });
    const width = table.getTotalSize();
    useImperativeHandle(ref, () => ({
      beginEdit: () => beginEdit(),
      setSelectedNull: setNull,
      focusCell: (position) => {
        setCell(position);
        virtual.scrollToIndex(position.row, { align: "auto" });
      },
      visibleSourceRows: () => {
        return visibleSourceIndices(
          virtual.getVirtualItems(),
          data,
          parent.current?.scrollTop || 0,
          parent.current?.clientHeight || 350,
        );
      },
    }));
    function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
      if (
        (event.target as HTMLElement).closest(
          "input,textarea,button,select,[role=separator]",
        )
      )
        return;
      if (editing) {
        if (event.key === "Escape") {
          event.preventDefault();
          cancelEdit();
        }
        return;
      }
      if (!active && data.length && result.columns.length) {
        if (
          ["ArrowDown", "ArrowRight", "Enter", "Tab", "F2"].includes(event.key)
        ) {
          event.preventDefault();
          setCell({ row: 0, column: 0 });
        }
        return;
      }
      if (!active) return;
      if (event.key === "F2" || event.key === "Enter") {
        event.preventDefault();
        if (canEdit(active)) beginEdit();
        else if (selected) onSelect(selected.values, selected.sourceIndex);
        return;
      }
      if (event.key === "Escape") {
        setError("");
        return;
      }
      if (event.key === "Delete" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        setNull();
        return;
      }
      const next = navigateGrid(
        active,
        event.key,
        data.length,
        result.columns.length,
        event.shiftKey,
        event.ctrlKey || event.metaKey,
      );
      if (next) {
        event.preventDefault();
        setCell(next);
        virtual.scrollToIndex(next.row, { align: "auto" });
        const visible = table.getVisibleLeafColumns();
        const left = visible
          .slice(0, next.column + 1)
          .reduce((total, column) => total + column.getSize(), 0);
        const size = visible[next.column + 1]?.getSize() || 150;
        if (parent.current) {
          if (left < parent.current.scrollLeft + 84)
            parent.current.scrollLeft = Math.max(0, left - 84);
          else if (
            left + size >
            parent.current.scrollLeft + parent.current.clientWidth
          )
            parent.current.scrollLeft =
              left + size - parent.current.clientWidth;
        }
        return;
      }
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        canEdit(active)
      ) {
        event.preventDefault();
        beginEdit(event.key);
      }
    }
    return (
      <div className="grid-wrap dbm-grid-wrap">
        {showCellToolbar && editable && (
          <div className="dbm-grid-cell-toolbar">
            <span>
              {selectedColumn ? (
                <>
                  <strong>{selectedColumn.name}</strong> · record{" "}
                  {rowOffset + (active?.row || 0) + 1}
                </>
              ) : (
                "Seleziona una cella per modificarla"
              )}
            </span>
            <button
              type="button"
              disabled={!active}
              onClick={() => beginEdit()}
            >
              <Pencil size={12} />
              Modifica <kbd>F2</kbd>
            </button>
            <button
              type="button"
              disabled={!selectedColumn?.nullable || !active}
              onClick={setNull}
            >
              Imposta NULL
            </button>
          </div>
        )}
        <div
          ref={parent}
          className="data-grid dbm-grid"
          role="region"
          aria-label={ariaLabel}
          aria-activedescendant={
            active ? `${identifier}-${active.row}-${active.column}` : undefined
          }
          tabIndex={0}
          onKeyDown={keyboard}
          onCopy={(event) => {
            if (editing || !active) return;
            const selectedEntries = data.filter(
              (entry) =>
                selectedRows.has(entry.sourceIndex) &&
                entry.change?.kind !== "delete",
            );
            const text = selectedEntries.length
              ? serializeDelimited(
                  result.columns,
                  selectedEntries.map((entry) => entry.values),
                  "\t",
                  true,
                )
              : serializeDelimited(
                  selectedColumn ? [selectedColumn] : [],
                  selected ? [selected.values] : [],
                  "\t",
                  false,
                );
            event.clipboardData.setData("text/plain", text);
            event.preventDefault();
          }}
          onPaste={(event) => {
            if (editing || !allowPaste) return;
            if (onPasteText) {
              event.preventDefault();
              onPasteText(event.clipboardData.getData("text/plain"));
            }
          }}
        >
          <table
            role="grid"
            aria-readonly={!editable && !editableInserts}
            aria-rowcount={data.length + 1}
            aria-colcount={result.columns.length + 2}
            style={{ width }}
          >
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} role="row">
                  {group.headers.map((header) => (
                    <th
                      key={header.id}
                      scope="col"
                      role="columnheader"
                      style={{ width: header.getSize() }}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {header.column.getCanResize() && (
                        <div
                          className={`dbm-column-resizer ${header.column.getIsResizing() ? "resizing" : ""}`}
                          role="separator"
                          tabIndex={0}
                          aria-label={`Larghezza colonna ${header.column.id}`}
                          aria-orientation="vertical"
                          aria-valuemin={90}
                          aria-valuemax={1200}
                          aria-valuenow={header.getSize()}
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          onKeyDown={(event) => {
                            if (
                              event.key === "ArrowLeft" ||
                              event.key === "ArrowRight"
                            ) {
                              event.preventDefault();
                              event.stopPropagation();
                              table.setColumnSizing((old) => ({
                                ...old,
                                [header.column.id]: Math.max(
                                  90,
                                  Math.min(
                                    1200,
                                    header.getSize() +
                                      (event.key === "ArrowRight" ? 15 : -15),
                                  ),
                                ),
                              }));
                            }
                          }}
                        />
                      )}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody
              style={{ height: virtual.getTotalSize(), position: "relative" }}
            >
              {virtual.getVirtualItems().map((item) => {
                const row = rows[item.index],
                  entry = row.original;
                return (
                  <tr
                    key={row.id}
                    role="row"
                    aria-rowindex={item.index + 2}
                    aria-selected={selectedRows.has(entry.sourceIndex)}
                    className={`${entry.change ? `changed-row ${entry.change.kind}` : ""} ${selectedRows.has(entry.sourceIndex) ? "dbm-row-selected" : ""}`}
                    style={{
                      position: "absolute",
                      transform: `translateY(${item.start}px)`,
                      width,
                      height: item.size,
                    }}
                  >
                    {row.getVisibleCells().map((cell, index) => {
                      const position = { row: item.index, column: index - 1 };
                      const dataCell =
                        index > 0 && index <= result.columns.length;
                      const activeHere = dataCell && sameCell(active, position);
                      const editingHere =
                        dataCell &&
                        !!editing &&
                        sameCell(editing.position, position);
                      return (
                        <td
                          key={cell.id}
                          id={
                            dataCell
                              ? `${identifier}-${item.index}-${index - 1}`
                              : undefined
                          }
                          role="gridcell"
                          aria-selected={activeHere}
                          className={`${dataCell ? "dbm-data-cell" : "dbm-control-cell"} ${activeHere ? "dbm-active-cell" : ""} ${editingHere ? "dbm-editing-cell" : ""} ${dataCell && canEditRow(editable, editableInserts, entry.change) ? "dbm-editable-cell" : ""}`}
                          style={{ width: cell.column.getSize() }}
                          onClick={
                            dataCell ? () => chooseCell(position) : undefined
                          }
                          onDoubleClick={
                            dataCell &&
                            canEditRow(editable, editableInserts, entry.change)
                              ? () => {
                                  setCell(position);
                                  const value =
                                    entry.values[
                                      result.columns[index - 1].name
                                    ];
                                  setEditing({
                                    position,
                                    draft:
                                      value?.type === "null"
                                        ? ""
                                        : cellText(value),
                                    isNull: value?.type === "null",
                                    error: "",
                                    selectAll: true,
                                  });
                                }
                              : undefined
                          }
                        >
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!data.length && (
            <div className="grid-empty">
              La tabella non contiene record in questa pagina.
            </div>
          )}
        </div>
        {error && (
          <div className="dbm-grid-error" role="alert">
            {error}
          </div>
        )}
        {!hideHint && (
          <div className="grid-tip">
            <Pencil size={12} />
            {editable || editableInserts
              ? "Seleziona una cella, poi Modifica o F2. Invio prepara il valore, Tab passa alla cella successiva, Esc annulla. Il controllo NULL è esplicito."
              : "Usa le frecce per spostarti, le caselle per selezionare righe e Ctrl+C per copiare."}
          </div>
        )}
      </div>
    );
  },
);
