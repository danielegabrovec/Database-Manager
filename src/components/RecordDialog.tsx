import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { CellValue, ColumnInfo, DataRow } from "../types";
import { cellText, newId } from "../utils";
import { Button, Field, Modal, Notice } from "./UI";

interface RecordDialogProps {
  row: DataRow;
  columns: ColumnInfo[];
  editable: boolean;
  inserting?: boolean;
  mongo?: boolean;
  onClose: () => void;
  onSave: (
    values: Record<string, string>,
    nullFields: string[],
    mongoValues?: DataRow,
  ) => void;
}

export function RecordDialog(props: RecordDialogProps) {
  return props.mongo ? (
    <MongoRecordDialog {...props} />
  ) : (
    <SqlRecordDialog {...props} />
  );
}

function SqlRecordDialog({
  row,
  columns,
  editable,
  inserting = false,
  onClose,
  onSave,
}: RecordDialogProps) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      columns.map((column) => [
        column.name,
        !Object.hasOwn(row, column.name) || row[column.name]?.type === "null"
          ? ""
          : cellText(row[column.name]),
      ]),
    ),
  );
  const [nulls, setNulls] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      columns.map((column) => [
        column.name,
        inserting && !Object.hasOwn(row, column.name)
          ? column.nullable || column.primaryKey || !!column.defaultValue
          : row[column.name]?.type === "null",
      ]),
    ),
  );
  return (
    <Modal
      title={inserting ? "Nuovo record" : "Scheda record"}
      onClose={onClose}
      wide
    >
      <div className="modal-body stack">
        {inserting && (
          <Notice>
            Il record viene preparato nella griglia. I campi con un valore
            predefinito si possono lasciare non compilati. Premi Applica
            modifiche per salvarlo.
          </Notice>
        )}
        <div className="record-fields">
          {columns.map((column) => (
            <div className="stack record-field" key={column.name}>
              <Field
                label={column.name}
                hint={[
                  column.dataType,
                  column.primaryKey && "chiave primaria",
                  column.generated && "generata dal database",
                  column.defaultValue && `predefinito: ${column.defaultValue}`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <textarea
                  readOnly={!editable || column.generated}
                  disabled={!!nulls[column.name] && !column.generated}
                  value={values[column.name]}
                  rows={(values[column.name] || "").length > 90 ? 4 : 1}
                  onChange={(e) =>
                    setValues((old) => ({
                      ...old,
                      [column.name]: e.target.value,
                    }))
                  }
                />
              </Field>
              {!column.generated && (
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={!!nulls[column.name]}
                    disabled={
                      !editable ||
                      (!column.nullable &&
                        !column.primaryKey &&
                        !column.defaultValue)
                    }
                    onChange={(e) =>
                      setNulls((old) => ({
                        ...old,
                        [column.name]: e.target.checked,
                      }))
                    }
                  />
                  {inserting && (column.primaryKey || column.defaultValue)
                    ? "Usa il valore assegnato dal database"
                    : "Valore NULL"}
                </label>
              )}
            </div>
          ))}
        </div>
      </div>
      <footer>
        <div className="spacer" />
        <Button onClick={onClose}>Chiudi</Button>
        {editable && (
          <Button
            variant="primary"
            onClick={() =>
              onSave(
                values,
                Object.keys(nulls).filter((name) => nulls[name]),
              )
            }
          >
            Prepara record
          </Button>
        )}
      </footer>
    </Modal>
  );
}

interface MongoField {
  id: string;
  name: string;
  value: string;
  original?: { cell: CellValue; text: string };
}

function mongoFieldText(cell: CellValue): string {
  let value: unknown = cell.value;
  switch (cell.type) {
    case "json":
      value = JSON.parse(String(cell.value));
      break;
    case "integer":
      value = {
        [cell.nativeType === "int32" ? "$numberInt" : "$numberLong"]: String(
          cell.value,
        ),
      };
      break;
    case "float": {
      const text = String(cell.value);
      const canonical =
        text === "inf" ? "Infinity" : text === "-inf" ? "-Infinity" : text;
      value = { $numberDouble: canonical };
      break;
    }
    case "decimal":
      value = { $numberDecimal: String(cell.value) };
      break;
    case "datetime":
      value = { $date: String(cell.value) };
      break;
    case "binary":
      value = { $binary: { base64: String(cell.value), subType: "00" } };
      break;
    case "null":
      value = null;
      break;
  }
  return JSON.stringify(value ?? null, null, 2);
}

function unsupportedFieldName(name: string) {
  return name.includes(".") || name.startsWith("$");
}

function mongoDocument(fields: MongoField[], inserting: boolean): DataRow {
  const names = new Set<string>();
  const entries: [string, CellValue][] = [];
  for (const field of fields) {
    if (!field.name.trim())
      throw new Error("Assegna un nome a ogni campo del documento.");
    if (field.name.includes("\0"))
      throw new Error("Il nome del campo non può contenere il carattere NUL.");
    if (names.has(field.name))
      throw new Error(`Campo ripetuto: ${field.name}.`);
    names.add(field.name);
    if (field.original && field.original.text === field.value) {
      entries.push([field.name, field.original.cell]);
      continue;
    }
    if (
      !inserting &&
      (field.name === "_id" || unsupportedFieldName(field.name))
    ) {
      throw new Error(
        `Campo non modificabile in questa scheda: ${field.name}.`,
      );
    }
    const value = field.value.trim();
    try {
      JSON.parse(value);
    } catch {
      throw new Error(
        `${field.name}: inserisci un valore JSON valido. Racchiudi il testo tra virgolette.`,
      );
    }
    entries.push([
      field.name,
      value === "null" ? { type: "null" } : { type: "json", value },
    ]);
  }
  return Object.fromEntries(entries);
}

function MongoRecordDialog({
  row,
  editable,
  inserting = false,
  onClose,
  onSave,
}: RecordDialogProps) {
  const [fields, setFields] = useState<MongoField[]>(() =>
    Object.entries(row).map(([name, cell]) => {
      const text = mongoFieldText(cell);
      return { id: name, name, value: text, original: { cell, text } };
    }),
  );
  const [error, setError] = useState("");
  function editField(id: string, change: { name?: string; value?: string }) {
    setError("");
    setFields((old) =>
      old.map((field) => (field.id === id ? { ...field, ...change } : field)),
    );
  }
  function save() {
    try {
      const values = mongoDocument(fields, inserting);
      onSave({}, [], values);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <Modal
      title={inserting ? "Nuovo documento MongoDB" : "Documento MongoDB"}
      onClose={onClose}
      wide
    >
      <div className="modal-body stack">
        <p className="muted">
          Usa valori Extended JSON. Per esempio, "Udine", ["lettura",
          "scrittura"] o{' {"visite":{"$numberLong":"9223372036854775807"}}'}.
          {inserting && " Se ometti _id, MongoDB lo assegna al salvataggio."}
        </p>
        <div className="stack">
          {fields.map((field, index) => {
            const locked =
              !inserting &&
              (field.name === "_id" ||
                (!!field.original && unsupportedFieldName(field.name)));
            return (
              <div className="panel stack record-field" key={field.id}>
                <div className="row">
                  {field.original ? (
                    <strong>
                      {field.name}
                      {locked && " · sola lettura"}
                    </strong>
                  ) : (
                    <Field label={`Nome campo ${index + 1}`}>
                      <input
                        value={field.name}
                        onChange={(event) =>
                          editField(field.id, { name: event.target.value })
                        }
                        placeholder="Es. indirizzo"
                      />
                    </Field>
                  )}
                  <span className="spacer" />
                  {editable && (!field.original || inserting) && (
                    <Button
                      variant="ghost"
                      aria-label={`Rimuovi campo ${field.name || index + 1}`}
                      onClick={() =>
                        setFields((old) =>
                          old.filter((item) => item.id !== field.id),
                        )
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  )}
                </div>
                <Field
                  label={
                    field.name
                      ? `Valore di ${field.name}`
                      : `Valore del campo ${index + 1}`
                  }
                >
                  <textarea
                    className="mono"
                    value={field.value}
                    readOnly={!editable || locked}
                    rows={
                      field.value.includes("\n")
                        ? Math.min(12, field.value.split("\n").length)
                        : 1
                    }
                    spellCheck={false}
                    onChange={(event) =>
                      editField(field.id, { value: event.target.value })
                    }
                  />
                </Field>
              </div>
            );
          })}
        </div>
        {editable && (
          <div>
            <Button
              onClick={() =>
                setFields((old) => [
                  ...old,
                  { id: newId(), name: "", value: "null" },
                ])
              }
            >
              <Plus size={15} /> Aggiungi campo
            </Button>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      <footer>
        <div className="spacer" />
        <Button onClick={onClose}>Chiudi</Button>
        {editable && (
          <Button variant="primary" onClick={save}>
            Prepara documento
          </Button>
        )}
      </footer>
    </Modal>
  );
}
