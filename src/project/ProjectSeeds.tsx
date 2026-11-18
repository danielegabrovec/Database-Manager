import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button, Field, Modal, Notice } from "../components/UI";
import {
  designObject,
  designObjectKey,
  type DesignTable,
} from "../designer/schemaProject";
import type { DataRow } from "../types";
import { cellText, errorMessage, objectLabel, parseCell } from "../utils";
import type { ProjectDatabase, ProjectSeedRow } from "./applicationProject";

export function ProjectSeeds({
  database,
  disabled,
  onChange,
}: {
  database: ProjectDatabase;
  disabled: boolean;
  onChange: (seed: ProjectSeedRow[]) => void;
}) {
  const [tableKey, setTableKey] = useState("");
  const [editing, setEditing] = useState<ProjectSeedRow | null>(null);
  const target =
    database.tables.find(
      (table) => designObjectKey(database.engine, table) === tableKey,
    ) || database.tables[0];
  const editingTable =
    editing &&
    database.tables.find(
      (table) =>
        designObjectKey(database.engine, table) ===
        designObjectKey(database.engine, editing.table),
    );

  function save(values: DataRow) {
    if (!editing) return;
    const next = { ...editing, values };
    onChange(
      database.seed.some((row) => row.id === next.id)
        ? database.seed.map((row) => (row.id === next.id ? next : row))
        : [...database.seed, next],
    );
    setEditing(null);
  }

  return (
    <section className="panel stack project-seeds">
      <h2>Dati di prova</h2>
      <p className="muted">
        Le righe selezionate vengono inserite nell’ordine dell’elenco prima
        delle operazioni.
      </p>
      <div className="row">
        <Field label={database.engine === "mongodb" ? "Collezione" : "Tabella"}>
          <select
            value={designObjectKey(database.engine, target)}
            onChange={(event) => setTableKey(event.target.value)}
          >
            {database.tables.map((table) => (
              <option
                key={table.id}
                value={designObjectKey(database.engine, table)}
              >
                {objectLabel(designObject(database.engine, table))}
              </option>
            ))}
          </select>
        </Field>
        <Button
          disabled={disabled || database.seed.length >= 500}
          onClick={() =>
            setEditing({
              id: crypto.randomUUID(),
              table: designObject(database.engine, target),
              values: {},
            })
          }
        >
          <Plus size={15} /> Aggiungi dato di prova
        </Button>
      </div>
      {database.seed.length === 0 ? (
        <Notice>
          Nessun dato di prova. Aggiungi righe o prova lo schema vuoto.
        </Notice>
      ) : (
        <ol className="project-seed-list">
          {database.seed.map((row) => (
            <li key={row.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={row.enabled !== false}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      database.seed.map((item) =>
                        item.id === row.id
                          ? { ...item, enabled: event.target.checked }
                          : item,
                      ),
                    )
                  }
                />
                <strong>{objectLabel(row.table)}</strong>
              </label>
              <span className="mono muted" title={JSON.stringify(row.values)}>
                {Object.entries(row.values)
                  .map(([key, value]) => `${key}=${cellText(value)}`)
                  .join(", ") || "Valori predefiniti"}
              </span>
              <Button
                variant="ghost"
                disabled={
                  disabled ||
                  !database.tables.some(
                    (table) =>
                      designObjectKey(database.engine, table) ===
                      designObjectKey(database.engine, row.table),
                  )
                }
                onClick={() => setEditing(row)}
              >
                Modifica
              </Button>
              <Button
                variant="ghost"
                disabled={disabled}
                aria-label={`Rimuovi dato da ${objectLabel(row.table)}`}
                onClick={() =>
                  onChange(database.seed.filter((item) => item.id !== row.id))
                }
              >
                <Trash2 size={15} />
              </Button>
            </li>
          ))}
        </ol>
      )}
      {editing && editingTable && (
        <SeedDialog
          database={database}
          table={editingTable}
          row={editing.values}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </section>
  );
}

function SeedDialog({
  database,
  table,
  row,
  onClose,
  onSave,
}: {
  database: ProjectDatabase;
  table: DesignTable;
  row: DataRow;
  onClose: () => void;
  onSave: (row: DataRow) => void;
}) {
  const mongo = database.engine === "mongodb";
  const [values, setValues] = useState(
    Object.fromEntries(
      table.columns.map((column) => [
        column.name,
        row[column.name]?.value?.toString() || "",
      ]),
    ),
  );
  const [modes, setModes] = useState<Record<string, string>>(
    Object.fromEntries(
      table.columns.map((column) => [
        column.name,
        row[column.name]?.type === "null"
          ? "null"
          : Object.hasOwn(row, column.name)
            ? "value"
            : column.primaryKey || column.nullable || column.defaultValue
              ? "omit"
              : "value",
      ]),
    ),
  );
  const [json, setJson] = useState(() =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(row).map(([field, value]) => [
          field,
          value.type === "json"
            ? JSON.parse(String(value.value))
            : value.type === "null"
              ? null
              : value.value,
        ]),
      ),
      null,
      2,
    ),
  );
  const [error, setError] = useState("");
  function save() {
    try {
      if (mongo) {
        const parsed: unknown = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Inserisci un oggetto Extended JSON.");
        onSave(
          Object.fromEntries(
            Object.entries(parsed).map(([field, value]) => [
              field,
              { type: "json", value: JSON.stringify(value) },
            ]),
          ),
        );
      } else {
        onSave(
          Object.fromEntries(
            table.columns
              .filter(
                (column) => !column.generated && modes[column.name] !== "omit",
              )
              .map((column) => [
                column.name,
                modes[column.name] === "null"
                  ? { type: "null" }
                  : parseCell(
                      values[column.name],
                      column,
                      row[column.name],
                      false,
                    ),
              ]),
          ),
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <Modal title={`Dato di prova · ${table.name}`} wide onClose={onClose}>
      <div className="modal-body stack">
        {error && <Notice tone="error">{error}</Notice>}
        {mongo ? (
          <Field label="Documento Extended JSON">
            <textarea
              rows={10}
              className="mono"
              value={json}
              onChange={(event) => setJson(event.target.value)}
            />
          </Field>
        ) : (
          table.columns
            .filter((column) => !column.generated)
            .map((column) => (
              <div className="form-grid" key={column.name}>
                <Field label={`${column.name} · ${column.dataType}`}>
                  <select
                    value={modes[column.name]}
                    onChange={(event) =>
                      setModes({ ...modes, [column.name]: event.target.value })
                    }
                  >
                    <option value="value">Inserisci valore</option>
                    <option value="omit">Usa il valore predefinito</option>
                    {column.nullable && (
                      <option value="null">Valore NULL</option>
                    )}
                  </select>
                </Field>
                {modes[column.name] === "value" && (
                  <Field label={`Valore di ${column.name}`}>
                    <input
                      value={values[column.name]}
                      onChange={(event) =>
                        setValues({
                          ...values,
                          [column.name]: event.target.value,
                        })
                      }
                    />
                  </Field>
                )}
              </div>
            ))
        )}
      </div>
      <footer>
        <Button onClick={onClose}>Annulla</Button>
        <span className="spacer" />
        <Button variant="primary" onClick={save}>
          Salva dato di prova
        </Button>
      </footer>
    </Modal>
  );
}
