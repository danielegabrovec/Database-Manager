import { describe, expect, it } from "vitest";
import type { CellValue, DataChange, ResultSet } from "../types";
import {
  buildPastePlan,
  buildAppendPlan,
  canEditRow,
  headersMatch,
  materializeRows,
  navigateGrid,
  parseClipboardCell,
  parseDelimited,
  serializeDelimited,
  stageCells,
  stageDeleteRows,
  stagePastePlan,
  visibleSourceIndices,
} from "./tableDataModel";

function fixture(): ResultSet {
  return {
    table: "customers",
    columns: [
      { name: "id", dataType: "BIGINT", nullable: false, primaryKey: true },
      { name: "name", dataType: "TEXT", nullable: true, primaryKey: false },
      {
        name: "amount",
        dataType: "DECIMAL(30,8)",
        nullable: false,
        primaryKey: false,
      },
      {
        name: "active",
        dataType: "BOOLEAN",
        nullable: false,
        primaryKey: false,
      },
    ],
    rows: [
      {
        id: { type: "integer", value: "1" },
        name: { type: "text", value: "Anna" },
        amount: { type: "decimal", value: "12.50000000" },
        active: { type: "boolean", value: true },
      },
      {
        id: { type: "integer", value: "2" },
        name: { type: "text", value: "Marco" },
        amount: { type: "decimal", value: "3.00000000" },
        active: { type: "boolean", value: false },
      },
    ],
  };
}
describe("clipboard tabella: formati e NULL", () => {
  it("legge TSV con celle multilinea, virgolette raddoppiate e CRLF", () => {
    const rows = parseDelimited(
      'nome\tnota\r\nAnna\t"prima riga\nseconda\tcolonna con ""virgolette"""\r\n',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1][1]).toEqual({
      text: 'prima riga\nseconda\tcolonna con "virgolette"',
      quoted: true,
    });
  });
  it("distingue valore nullo, testo NULL, testo \\N e stringa vuota nel round trip", () => {
    const column = fixture().columns[1];
    const values: CellValue[] = [
      { type: "null" },
      { type: "text", value: "NULL" },
      { type: "text", value: "\\N" },
      { type: "text", value: "" },
      { type: "text", value: 'a\tb\n"c"' },
    ];
    for (const delimiter of ["\t", ","] as const) {
      const text = serializeDelimited(
        [column],
        values.map((value) => ({ name: value })),
        delimiter,
        false,
      );
      const parsed = parseDelimited(text, delimiter);
      expect(parsed.map((row) => parseClipboardCell(row[0], column))).toEqual(
        values,
      );
    }
  });
  it("convalida intestazioni soltanto quando corrispondono alle colonne di destinazione", () => {
    const result = fixture();
    expect(
      headersMatch(parseDelimited("name\tamount")[0], result.columns, 1),
    ).toBe(true);
    expect(
      headersMatch(parseDelimited("name\taltro")[0], result.columns, 1),
    ).toBe(false);
  });
  it("rifiuta citazioni incomplete e paste eccessivamente ampi", () => {
    expect(() => parseDelimited('"aperto')).toThrow("virgolette");
    expect(() => parseDelimited('"chiuso"altro')).toThrow("Dopo una cella");
    expect(() => parseDelimited(Array(1002).fill("x").join("\t"))).toThrow(
      "1.000 colonne",
    );
  });
});
describe("incolla con anteprima e staging atomico", () => {
  it("preserva decimali lunghi e interpreta booleane senza modificare il risultato prima della conferma", () => {
    const result = fixture(),
      before = JSON.stringify(result),
      changes = new Map<number, DataChange>();
    const fields = parseDelimited(
      "NULL\t9007199254740993.12345678\tfalse\n\\N\t0.00000001\ttrue",
    );
    const plan = buildPastePlan(result, changes, { row: 0, column: 1 }, fields);
    expect(plan.errors).toEqual([]);
    expect(
      plan.cells.find(
        (cell) => cell.sourceIndex === 0 && cell.column.name === "name",
      )?.after,
    ).toEqual({ type: "text", value: "NULL" });
    expect(
      plan.cells.find((cell) => cell.column.name === "amount")?.after.value,
    ).toBe("9007199254740993.12345678");
    expect(JSON.stringify(result)).toBe(before);
    expect(changes.size).toBe(0);
    const staged = stagePastePlan(result, changes, plan);
    expect(staged.size).toBe(2);
    expect(staged.get(1)?.values.name).toEqual({ type: "null" });
    expect(changes.size).toBe(0);
    expect(JSON.stringify(result)).toBe(before);
  });
  it("un solo errore impedisce di preparare anche i valori validi", () => {
    const result = fixture(),
      changes = new Map<number, DataChange>();
    const plan = buildPastePlan(
      result,
      changes,
      { row: 0, column: 1 },
      parseDelimited("Nome valido\tnon è un decimale\ttrue"),
    );
    expect(plan.cells.length).toBeGreaterThan(0);
    expect(plan.errors).toHaveLength(1);
    expect(() => stagePastePlan(result, changes, plan)).toThrow(
      "nessun valore",
    );
    expect(changes.size).toBe(0);
    expect(result.rows[0].name.value).toBe("Anna");
  });
  it("mantiene la chiave originale anche quando si incolla una nuova chiave primaria", () => {
    const result = fixture();
    const plan = buildPastePlan(
      result,
      new Map(),
      { row: 0, column: 0 },
      parseDelimited("9223372036854775807"),
    );
    const staged = stagePastePlan(result, new Map(), plan);
    expect(staged.get(0)?.key.id).toEqual({ type: "integer", value: "1" });
    expect(staged.get(0)?.values.id.value).toBe("9223372036854775807");
  });
  it("rifiuta record fuori pagina, colonne eccedenti, righe eliminate e NULL non ammessi", () => {
    const result = fixture();
    expect(
      buildPastePlan(
        result,
        new Map(),
        { row: 2, column: 0 },
        parseDelimited("1"),
      ).errors,
    ).toHaveLength(1);
    expect(
      buildPastePlan(
        result,
        new Map(),
        { row: 0, column: 4 },
        parseDelimited("1"),
      ).errors,
    ).toHaveLength(1);
    const deleted = stageDeleteRows(result, new Map(), [0]);
    expect(
      buildPastePlan(
        result,
        deleted,
        { row: 0, column: 1 },
        parseDelimited("Nome"),
      ).errors[0].message,
    ).toContain("eliminazione");
    expect(
      buildPastePlan(
        result,
        new Map(),
        { row: 0, column: 0 },
        parseDelimited("\\N"),
      ).errors[0].message,
    ).toContain("non ammette NULL");
  });
  it("non perde modifiche precedenti e rimuove un update tornato al valore originale", () => {
    const result = fixture();
    const first = stageCells(result, new Map(), [
      {
        sourceIndex: 0,
        column: result.columns[1],
        after: { type: "text", value: "Nuovo nome" },
      },
    ]);
    const second = stageCells(result, first, [
      {
        sourceIndex: 0,
        column: result.columns[2],
        after: { type: "decimal", value: "100.00000000" },
      },
    ]);
    expect(second.get(0)?.values.name.value).toBe("Nuovo nome");
    const reverted = stageCells(result, first, [
      { sourceIndex: 0, column: result.columns[1], after: result.rows[0].name },
    ]);
    expect(reverted.size).toBe(0);
    expect(first.size).toBe(1);
  });
});
describe("selezione e navigazione della griglia", () => {
  it("Tab e Shift+Tab attraversano righe e permettono di uscire ai bordi", () => {
    expect(navigateGrid({ row: 0, column: 3 }, "Tab", 2, 4)).toEqual({
      row: 1,
      column: 0,
    });
    expect(navigateGrid({ row: 1, column: 0 }, "Tab", 2, 4, true)).toEqual({
      row: 0,
      column: 3,
    });
    expect(navigateGrid({ row: 1, column: 3 }, "Tab", 2, 4)).toBeNull();
    expect(navigateGrid({ row: 0, column: 0 }, "Tab", 2, 4, true)).toBeNull();
  });
  it("frecce, Home/End e Invio restano nel risultato, Escape non sposta la selezione", () => {
    expect(navigateGrid({ row: 0, column: 0 }, "ArrowUp", 2, 4)).toEqual({
      row: 0,
      column: 0,
    });
    expect(
      navigateGrid({ row: 0, column: 1 }, "End", 2, 4, false, true),
    ).toEqual({ row: 1, column: 3 });
    expect(
      navigateGrid({ row: 1, column: 3 }, "Home", 2, 4, false, true),
    ).toEqual({ row: 0, column: 0 });
    expect(navigateGrid({ row: 0, column: 2 }, "Enter", 2, 4)).toEqual({
      row: 1,
      column: 2,
    });
    expect(navigateGrid({ row: 0, column: 2 }, "Escape", 2, 4)).toBeNull();
    expect(navigateGrid({ row: 0, column: 0 }, "ArrowDown", 0, 4)).toBeNull();
  });
  it("conserva gli indici originali dopo l’eliminazione di un inserimento preparato", () => {
    const result = fixture();
    const changes = new Map<number, DataChange>([
      [
        4,
        {
          kind: "insert",
          key: {},
          original: {},
          values: {
            id: { type: "integer", value: "9" },
            name: { type: "text", value: "Nuovo" },
          },
        },
      ],
    ]);
    const rows = materializeRows(result, changes);
    expect(rows.map((row) => row.sourceIndex)).toEqual([0, 1, 4]);
    expect(rows).toHaveLength(3);
    const staged = stageCells(result, changes, [
      {
        sourceIndex: 4,
        column: result.columns[1],
        after: { type: "text", value: "Cambiato" },
      },
    ]);
    expect(staged.get(4)?.kind).toBe("insert");
    expect(staged.get(4)?.values.name.value).toBe("Cambiato");
  });
  it("copia soltanto le righe della viewport, escludendo l’overscan virtuale", () => {
    const rows = materializeRows(fixture(), new Map());
    const items = [
      { index: 0, start: 0, end: 37 },
      { index: 1, start: 37, end: 74 },
      { index: 2, start: 74, end: 111 },
    ];
    expect(visibleSourceIndices(items, rows, 37, 80)).toEqual([1]);
  });
  it("preparare una cancellazione conserva le modifiche locali per l’eventuale ripristino", () => {
    const result = fixture();
    const edited = stageCells(result, new Map(), [
      {
        sourceIndex: 0,
        column: result.columns[1],
        after: { type: "text", value: "Preparato" },
      },
    ]);
    const deleted = stageDeleteRows(result, edited, [0]);
    expect(deleted.get(0)?.kind).toBe("delete");
    expect(deleted.get(0)?.values.name.value).toBe("Preparato");
    expect(edited.get(0)?.kind).toBe("update");
  });
});

describe("nuovi record senza chiave primaria", () => {
  it("l’abilitazione agli INSERT rende modificabili solo le righe nuove, mai quelle già esistenti", () => {
    expect(canEditRow(false, true, undefined)).toBe(false);
    expect(
      canEditRow(false, true, {
        kind: "insert",
        key: {},
        original: {},
        values: {},
      }),
    ).toBe(true);
    expect(
      canEditRow(false, true, {
        kind: "update",
        key: {},
        original: {},
        values: {},
      }),
    ).toBe(false);
    expect(
      canEditRow(true, true, {
        kind: "delete",
        key: {},
        original: {},
        values: {},
      }),
    ).toBe(false);
    expect(
      canEditRow(false, false, {
        kind: "insert",
        key: {},
        original: {},
        values: {},
      }),
    ).toBe(false);
  });
  const noKey: ResultSet = {
    table: "scratch",
    columns: [
      { name: "name", dataType: "TEXT", nullable: false, primaryKey: false },
      { name: "age", dataType: "INTEGER", nullable: false, primaryKey: false },
      {
        name: "note",
        dataType: "TEXT",
        nullable: true,
        primaryKey: false,
        defaultValue: "'default'",
      },
    ],
    rows: [
      {
        name: { type: "text", value: "Esistente" },
        age: { type: "integer", value: "99" },
        note: { type: "null" },
      },
    ],
  };
  it("prepara solo INSERT e non modifica le righe esistenti, anche senza PK", () => {
    const original = JSON.stringify(noKey);
    const plan = buildAppendPlan(
      noKey,
      new Map(),
      parseDelimited("age\tname\n42\tNuovo\n43\tNULL"),
      true,
    );
    expect(plan.errors).toEqual([]);
    const staged = stagePastePlan(noKey, new Map(), plan);
    expect([...staged.keys()]).toEqual([1, 2]);
    expect(
      [...staged.values()].every((change) => change.kind === "insert"),
    ).toBe(true);
    expect(staged.get(1)).toMatchObject({
      key: {},
      original: {},
      values: {
        name: { type: "text", value: "Nuovo" },
        age: { type: "integer", value: "42" },
      },
    });
    expect(staged.get(2)?.values.name).toEqual({ type: "text", value: "NULL" });
    expect(staged.get(1)?.values.note).toBeUndefined();
    expect(JSON.stringify(noKey)).toBe(original);
  });
  it("consente l’incolla di nuovi record in una tabella vuota", () => {
    const empty = { ...noKey, rows: [] };
    const plan = buildAppendPlan(empty, new Map(), parseDelimited("Prima\t20"));
    expect(plan.errors).toEqual([]);
    const staged = stagePastePlan(empty, new Map(), plan);
    expect(staged.get(0)?.kind).toBe("insert");
    expect(empty.rows).toHaveLength(0);
  });
  it("blocca intestazioni sconosciute o duplicate e campi obbligatori omessi", () => {
    for (const content of [
      "name\tmissing\nTest\t1",
      "name\tname\nA\tB",
      "name\nManca età",
    ]) {
      const plan = buildAppendPlan(
        noKey,
        new Map(),
        parseDelimited(content),
        true,
      );
      expect(plan.errors.length).toBeGreaterThan(0);
      expect(() => stagePastePlan(noKey, new Map(), plan)).toThrow(
        "nessun valore",
      );
    }
  });
  it("rifiuta un’anteprima append quando gli indici nuovi sono già occupati da altre modifiche", () => {
    const plan = buildAppendPlan(noKey, new Map(), parseDelimited("Nuovo\t30"));
    const other = new Map<number, DataChange>([
      [
        1,
        {
          kind: "insert",
          key: {},
          original: {},
          values: {
            name: { type: "text", value: "Altro" },
            age: { type: "integer", value: "22" },
          },
        },
      ],
    ]);
    expect(() => stagePastePlan(noKey, other, plan)).toThrow("cambiati");
    expect(other.get(1)?.values.name.value).toBe("Altro");
  });
});
