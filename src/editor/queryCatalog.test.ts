import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildQueryCatalog,
  savedQueryAction,
  QUERY_DEMO_SCHEMA,
} from "./queryCatalog";
import type { Engine, SchemaSnapshot } from "../types";

const source = readFileSync(
  new URL("../../src-tauri/src/lab.rs", import.meta.url),
  "utf8",
);
const seed = source.match(/const SHOP: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!seed) throw new Error("Seed shop reale non trovato");
const schema = QUERY_DEMO_SCHEMA;
describe("catalogo query eseguibile", () => {
  it("esegue ogni esempio di lettura SQLite contro il seed reale, comprese JOIN, CTE, HAVING e finestre", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(seed);
    const entries = buildQueryCatalog("sqlite", schema).filter(
      (entry) => entry.available && entry.readOnly,
    );
    expect(entries.length).toBeGreaterThanOrEqual(20);
    for (const entry of entries) {
      const statement = db.prepare(entry.query);
      const parameters = entry.parameters as Record<
        string,
        string | number | bigint | Uint8Array | null
      >;
      expect(
        () =>
          Object.keys(parameters).length
            ? statement.all(parameters)
            : statement.all(),
        entry.id + "\n" + entry.query,
      ).not.toThrow();
    }
    const join = entries.find((entry) => entry.id === "sqlite-left-join")!;
    const rows = db.prepare(join.query).all();
    expect(rows).toHaveLength(5);
    expect(rows.find((row) => row.name === "Anna Rossi")?.righe_collegate).toBe(
      2,
    );
    expect(
      rows.find((row) => row.name === "Elena Müller")?.righe_collegate,
    ).toBe(0);
    const having = entries.find((entry) => entry.id === "sqlite-having")!;
    expect(
      db.prepare(having.query).all(having.parameters as Record<string, number>),
    ).toEqual([{ city: "Udine", totale: 2 }]);
    db.close();
  });
  it("esegue CRUD parametrizzato e DDL separatamente, senza modificare il seed usato dalle letture", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(seed);
    const entries = buildQueryCatalog("sqlite", schema);
    for (const suffix of ["insert", "update", "delete"]) {
      const entry = entries.find((entry) => entry.id === "sqlite-" + suffix)!;
      db.prepare(entry.query).run(
        entry.parameters as Record<string, string | number | null>,
      );
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM customers").get()?.n).toBe(5);
    for (const suffix of [
      "create-table",
      "create-view",
      "index",
      "transaction",
      "savepoint",
    ]) {
      const entry = entries.find((entry) => entry.id === "sqlite-" + suffix)!;
      expect(() => db.exec(entry.query), entry.id).not.toThrow();
    }
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'query_notes'")
        .get()?.name,
    ).toBe("query_notes");
    db.close();
  });
  it("adatta i nomi reali, compresa una chiave non fra le prime quattro colonne", () => {
    const arbitrary: SchemaSnapshot = {
      engine: "sqlite",
      database: "x",
      tables: [
        {
          name: 'strange "table',
          schema: "main",
          kind: "table",
          columns: [
            ...["first name", "group", "note", "extra"].map((name) => ({
              name,
              dataType: "TEXT",
              primaryKey: false,
              nullable: true,
            })),
            {
              name: "record key",
              dataType: "INTEGER",
              primaryKey: true,
              nullable: false,
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const db = new DatabaseSync(":memory:");
    db.exec(
      'CREATE TABLE "strange ""table" ("first name" TEXT,"group" TEXT,note TEXT,extra TEXT,"record key" INTEGER PRIMARY KEY);',
    );
    for (const entry of buildQueryCatalog("sqlite", arbitrary).filter(
      (entry) => entry.available && entry.readOnly,
    )) {
      const statement = db.prepare(entry.query);
      expect(
        () =>
          Object.keys(entry.parameters).length
            ? statement.all(entry.parameters as Record<string, string | number>)
            : statement.all(),
        entry.id,
      ).not.toThrow();
      expect(entry.query).not.toContain("customers");
    }
    db.close();
  });
  it("non spaccia il dataset didattico per uno schema già collegato", () => {
    for (const engine of [
      "sqlite",
      "postgresql",
      "mysql",
      "mariadb",
      "mongodb",
    ] as Engine[]) {
      const entries = buildQueryCatalog(engine, null);
      expect(
        entries
          .filter((entry) => entry.available)
          .every((entry) => !entry.usesDemoSchema),
      ).toBe(true);
      expect(
        entries.some((entry) => !entry.available && entry.usesDemoSchema),
      ).toBe(true);
    }
  });
  it("usa placeholder e quoting del motore, senza SQL MySQL spacciato per PostgreSQL", () => {
    const pg = buildQueryCatalog("postgresql", {
      ...schema,
      engine: "postgresql",
    }).find((entry) => entry.id === "postgresql-equals")!;
    expect(pg.query).toContain("$1");
    expect(pg.parameters).toEqual({ "1": "Udine" });
    expect(pg.query).toContain('"customers"');
    const mysql = buildQueryCatalog("mysql", {
      ...schema,
      engine: "mysql",
    }).find((entry) => entry.id === "mysql-equals")!;
    expect(mysql.query).toContain("`customers`");
    expect(mysql.query).toContain(":valore");
    expect(mysql.parameters).toEqual({ valore: "Udine" });
  });
  it("produce solo JSON valido per Mongo e non inventa un comando BEGIN", () => {
    const mongoSchema = {
      ...schema,
      engine: "mongodb" as Engine,
      tables: schema.tables.map((table) => ({ ...table, kind: "collection" })),
    };
    const entries = buildQueryCatalog("mongodb", mongoSchema);
    for (const entry of entries)
      expect(() => JSON.parse(entry.query), entry.id).not.toThrow();
    expect(
      entries.find((entry) => entry.category === "TRANSACTIONS")?.query,
    ).toContain('"hello"');
    expect(
      entries.find((entry) => entry.id === "mongodb-lookup")?.assumptions?.[0],
    ).toContain("verificare");
  });
  it("gestisce una collezione vuota senza inventare campi campionati", () => {
    const entries = buildQueryCatalog("mongodb", {
      engine: "mongodb",
      database: "test",
      tables: [
        {
          name: "empty",
          kind: "collection",
          columns: [],
          indexes: [],
          foreignKeys: [],
        },
      ],
    });
    expect(
      entries.find((entry) => entry.id === "mongodb-find")?.query,
    ).toContain('"empty"');
    expect(
      entries.find((entry) => entry.id === "mongodb-find")?.available,
    ).toBe(true);
    expect(
      entries.find((entry) => entry.id === "mongodb-update")?.available,
    ).toBe(false);
  });
  it("non produce UPDATE/DELETE incompleti quando manca una chiave e usa il default del motore per INSERT", () => {
    const withoutKey: SchemaSnapshot = {
      engine: "sqlite",
      database: "test",
      tables: [
        {
          name: "optional",
          kind: "table",
          columns: [
            {
              name: "note",
              dataType: "TEXT",
              nullable: true,
              primaryKey: false,
              defaultValue: "'hello'",
            },
          ],
          indexes: [],
          foreignKeys: [],
        },
      ],
    };
    const entries = buildQueryCatalog("sqlite", withoutKey);
    for (const suffix of ["update", "delete"]) {
      const entry = entries.find((entry) => entry.id === "sqlite-" + suffix)!;
      expect(entry.available).toBe(false);
      expect(entry.query).toBe("");
    }
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE optional (note TEXT DEFAULT 'hello');");
    db.exec(entries.find((entry) => entry.id === "sqlite-insert")!.query);
    expect(db.prepare("SELECT note FROM optional").get()?.note).toBe("hello");
    db.close();
  });
  it("preserva parametri e modalità quando una query salvata viene riaperta dalla libreria", () => {
    const saved = {
      id: "saved-1",
      name: "Clienti di una città",
      engine: "sqlite" as Engine,
      query: "SELECT * FROM customers WHERE city=:city",
      favorite: true,
      parameters: { city: "Udine" },
      executionMode: "script",
    };
    expect(savedQueryAction(saved)).toMatchObject({
      source: "saved",
      sourceId: "saved-1",
      query: saved.query,
      parameters: { city: "Udine" },
      executionMode: "script",
    });
  });
});
