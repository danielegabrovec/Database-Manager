import { describe, expect, it } from "vitest";
import { parseCell, statementAt, updateChange } from "./utils";
import type { ColumnInfo, DataRow } from "./types";

describe("selezione dello statement SQL", () => {
  it("ignora separatori in stringhe, identificatori e commenti", () => {
    const sql = `SELECT 'a;b', "c;d"; -- commento ;\nSELECT 2;`;
    expect(statementAt(sql, 8)).toBe(`SELECT 'a;b', "c;d";`);
    expect(statementAt(sql, sql.indexOf("SELECT 2") + 3)).toContain(
      "SELECT 2;",
    );
  });
  it("preserva funzioni PostgreSQL con dollar quoting", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS void AS $body$ BEGIN SELECT 1; END; $body$ LANGUAGE plpgsql;\nSELECT 2;";
    expect(statementAt(sql, 55)).toBe(sql.split("\n")[0]);
    expect(statementAt(sql, sql.length)).toBe("SELECT 2;");
  });
  it("ignora commenti a blocchi annidati", () => {
    expect(
      statementAt("/* a; /* b; */ c; */ SELECT 1; SELECT 2;", 30),
    ).toContain("SELECT 1;");
  });
});
describe("valori della griglia", () => {
  const id: ColumnInfo = {
    name: "id",
    dataType: "BIGINT",
    nullable: false,
    primaryKey: true,
  };
  it("mantiene gli interi oltre la precisione JavaScript", () => {
    expect(parseCell("9223372036854775807", id)).toEqual({
      type: "integer",
      value: "9223372036854775807",
    });
  });
  it("distingue NULL dalla stringa vuota e valida i tipi", () => {
    expect(
      parseCell("", {
        ...id,
        dataType: "TEXT",
        primaryKey: false,
        nullable: true,
      }),
    ).toEqual({ type: "text", value: "" });
    expect(parseCell("NULL", { ...id, nullable: true })).toEqual({
      type: "null",
    });
    expect(
      parseCell("NULL", { ...id, dataType: "TEXT" }, undefined, false),
    ).toEqual({ type: "text", value: "NULL" });
    expect(() => parseCell("uno", id)).toThrow();
  });
  it("usa la chiave originale anche quando viene modificata", () => {
    const original: DataRow = {
      id: { type: "integer", value: "7" },
      name: { type: "text", value: "Anna" },
    };
    const change = updateChange(
      original,
      { ...original, id: { type: "integer", value: "8" } },
      [id],
    );
    expect(change?.key.id.value).toBe("7");
    expect(change?.values.id.value).toBe("8");
    expect(updateChange(original, original, [id])).toBeNull();
  });
});
