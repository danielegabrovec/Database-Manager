import { describe, expect, it } from "vitest";
import {
  createDatabaseSnippet,
  packageSchemaFiles,
  removeStructureSnippet,
} from "./packageAdmin";

describe("comandi copiabili di schema e amministrazione", () => {
  it("crea solo il nome fisico scritto e conserva i caratteri nelle virgolette", () => {
    expect(() => createDatabaseSnippet("postgresql", "")).toThrow(
      "nome fisico",
    );
    expect(createDatabaseSnippet("postgresql", 'Dati"2026')).toBe(
      'CREATE DATABASE "Dati""2026";',
    );
    expect(createDatabaseSnippet("mysql", "dati`2026")).toBe(
      "CREATE DATABASE `dati``2026`;",
    );
    expect(() => createDatabaseSnippet("postgresql", "a\nb")).toThrow(
      "nome fisico",
    );
    expect(() => createDatabaseSnippet("sqlite", "dati")).toThrow("percorso");
  });

  it("separa la creazione MongoDB con prima collezione dalla rimozione", () => {
    expect(createDatabaseSnippet("mongodb", "prova", 'prima"collezione')).toBe(
      'db.getSiblingDB("prova").createCollection("prima\\\"collezione");',
    );
    expect(() => createDatabaseSnippet("mongodb", "mio.db", "records")).toThrow(
      "carattere",
    );
    expect(() => createDatabaseSnippet("mongodb", "prova", "")).toThrow(
      "struttura",
    );
    expect(() =>
      removeStructureSnippet("mongodb", { name: "records" }),
    ).toThrow("nome fisico");
    expect(
      removeStructureSnippet("mongodb", { name: 'records"draft' }, "prova"),
    ).toBe(
      'db.getSiblingDB("prova").getCollection("records\\\"draft").drop();',
    );
  });

  it("qualifica la struttura e disattiva la rimozione se manca la destinazione richiesta", () => {
    expect(
      removeStructureSnippet("postgresql", {
        schema: "storia.v1",
        name: 'righe"ora',
      }),
    ).toBe('DROP TABLE "storia.v1"."righe""ora";');
    expect(
      removeStructureSnippet("sqlite", { name: 'x"; DELETE FROM a;--' }),
    ).toBe('DROP TABLE "main"."x""; DELETE FROM a;--";');
    expect(() =>
      removeStructureSnippet("mariadb", {
        schema: "solo-alias",
        name: "righe",
      }),
    ).toThrow("nome fisico");
    expect(
      removeStructureSnippet("mariadb", { name: "righe`test" }, "fisico"),
    ).toBe("DROP TABLE `fisico`.`righe``test`;");
  });

  it("seleziona la funzione esistente del database con lo stesso alias", () => {
    const files = [
      {
        path: "destinazioni.json",
        content: JSON.stringify([
          { id: "one", schema: "databases/01-uguale/schema.json" },
          { id: "two", schema: "databases/02-uguale/schema.sql" },
        ]),
      },
      { path: "databases/01-uguale/schema.json", content: "[]" },
      {
        path: "databases/01-uguale/setup/schema.rs",
        content: 'include_str!("schema.json")',
      },
      {
        path: "databases/02-uguale/schema.sql",
        content: "CREATE TABLE t(id);",
      },
      {
        path: "databases/02-uguale/setup/schema.sql",
        content: "CREATE TABLE t(id);",
      },
      {
        path: "databases/02-uguale/setup/schema.py",
        content: "def apply_schema(connection): ...",
      },
    ];
    const bundle = { files, command: "", notes: [] };
    expect(packageSchemaFiles(bundle, "one")?.setup?.path).toBe(
      "databases/01-uguale/setup/schema.rs",
    );
    expect(packageSchemaFiles(bundle, "two")?.setup?.path).toBe(
      "databases/02-uguale/setup/schema.py",
    );
    expect(packageSchemaFiles(bundle, "missing")).toBeUndefined();
  });
});
