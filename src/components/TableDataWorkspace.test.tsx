import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TableDataWorkspace } from "./TableDataWorkspace";
import type { ResultSet } from "../types";
const result: ResultSet = {
  table: "customers",
  columns: [
    { name: "id", dataType: "INTEGER", nullable: false, primaryKey: true },
    { name: "name", dataType: "TEXT", nullable: true, primaryKey: false },
  ],
  rows: [
    {
      id: { type: "integer", value: "1" },
      name: { type: "text", value: "Anna" },
    },
  ],
};
const callbacks = {
  onEdit: () => {},
  onDelete: () => {},
  onSelect: () => {},
  onChangesChange: () => {},
  onApply: () => {},
  onDiscard: () => {},
};
describe("azioni visibili dell’editor dati", () => {
  it("espone modifica, paste e viste del record in un editor dedicato", () => {
    const markup = renderToStaticMarkup(
      <TableDataWorkspace
        {...callbacks}
        result={result}
        changes={new Map()}
        editable
        tableName="customers"
      />,
    );
    for (const label of [
      "Dati tabella",
      "customers",
      "Modifica disponibile",
      "Modifica",
      "F2",
      "Incolla TSV",
      "Scheda",
      "JSON",
      "Area visibile",
    ])
      expect(markup).toContain(label);
    expect(markup).toContain('aria-label="Dati tabella customers"');
  });
  it("la modalità di sola lettura mantiene selezione e copia senza proporre scritture", () => {
    const markup = renderToStaticMarkup(
      <TableDataWorkspace
        {...callbacks}
        result={result}
        changes={new Map()}
        editable={false}
        tableName="customers"
        readOnlyReason="Connessione in sola lettura"
      />,
    );
    expect(markup).toContain("Connessione in sola lettura");
    expect(markup).toContain("TSV");
    expect(markup).not.toContain("Incolla TSV");
    expect(markup).not.toContain("Elimina selezionati");
  });
  it("una tabella senza PK può offrire inserimenti separati senza abilitare update o delete", () => {
    const noKey = {
      ...result,
      columns: result.columns.map((column) => ({
        ...column,
        primaryKey: false,
      })),
      rows: [],
    };
    const markup = renderToStaticMarkup(
      <TableDataWorkspace
        {...callbacks}
        result={noKey}
        changes={new Map()}
        editable={false}
        canInsert
        onAddRecord={() => {}}
        tableName="scratch"
      />,
    );
    expect(markup).toContain("Solo nuovi record");
    expect(markup).toContain("Nuovo record");
    expect(markup).toContain("Incolla nuovi record");
    expect(markup).toContain("I record esistenti sono in sola lettura");
    expect(markup).not.toContain("Elimina selezionati");
    expect(markup).not.toContain("Modifica scheda");
  });
  it("un record INSERT preparato NoPK espone la modifica locale senza offrire cancellazioni di record esistenti", () => {
    const noKey = {
      ...result,
      columns: result.columns.map((column) => ({
        ...column,
        primaryKey: false,
      })),
      rows: [],
    };
    const changes = new Map<number, import("../types").DataChange>([
      [
        0,
        {
          kind: "insert",
          key: {},
          original: {},
          values: {
            id: { type: "integer", value: "1" },
            name: { type: "text", value: "Preparato" },
          },
        },
      ],
    ]);
    const markup = renderToStaticMarkup(
      <TableDataWorkspace
        {...callbacks}
        result={noKey}
        changes={changes}
        editable={false}
        canInsert
        tableName="scratch"
      />,
    );
    expect(markup).toContain("Modifica");
    expect(markup).toContain("F2");
    expect(markup).not.toContain("Elimina selezionati");
  });
});
