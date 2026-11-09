import { useState } from "react";
import type { ColumnInfo, DataRow } from "../types";
import { cellText } from "../utils";
import { Button, Field, Modal, Notice } from "./UI";
export function RecordDialog({
  row,
  columns,
  editable,
  inserting = false,
  onClose,
  onSave,
}: {
  row: DataRow;
  columns: ColumnInfo[];
  editable: boolean;
  inserting?: boolean;
  onClose: () => void;
  onSave: (values: Record<string, string>, nullFields: string[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      columns.map((column) => [
        column.name,
        inserting || row[column.name]?.type === "null"
          ? ""
          : cellText(row[column.name]),
      ]),
    ),
  );
  const [nulls, setNulls] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      columns.map((column) => [
        column.name,
        inserting
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
                label={`${column.name}${column.primaryKey ? " · chiave primaria" : ""}`}
                hint={`${column.dataType}${column.defaultValue ? ` · predefinito: ${column.defaultValue}` : ""}`}
              >
                <textarea
                  readOnly={!editable}
                  disabled={!!nulls[column.name]}
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
