import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ENGINES, type Engine } from "../types";
import { previewSchemaImport, type SchemaImportRequest } from "./schemaImport";
import {
  buildProjectDdl,
  linkedDesignTemplate,
  readDesignProject,
} from "./schemaProject";

function input(
  source: string,
  engine: Engine,
  options: Partial<SchemaImportRequest> = {},
) {
  return previewSchemaImport({
    id: "test",
    name: "schema.sql",
    source,
    engine,
    format: engine === "mongodb" ? "mongodb" : "sql",
    ...options,
  });
}

describe("Designer source conversion", () => {
  it.each(ENGINES)("reimports the generated %s schema", (engine) => {
    const original = buildProjectDdl(engine, linkedDesignTemplate(engine));
    const draft = input(original, engine);
    expect(draft.issues).toEqual([]);
    expect(draft.tables.map((table) => table.name)).toEqual([
      "contatti",
      "note",
    ]);
    expect(buildProjectDdl(engine, draft.tables)).toEqual(original);
  });

  it("keeps SQLite columns, literal defaults, indexes and foreign keys after a source round trip", () => {
    const draft = input(
      `CREATE TABLE "people" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "note" TEXT DEFAULT 'a; b, c');
CREATE TABLE "notes" ("id" INTEGER PRIMARY KEY, "owner" INTEGER NOT NULL REFERENCES "people"("id"));
CREATE INDEX "notes_owner" ON "notes" ("owner");`,
      "sqlite",
    );
    expect(draft.issues).toEqual([]);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(buildProjectDdl("sqlite", draft.tables));
      db.exec("INSERT INTO people DEFAULT VALUES");
      expect(db.prepare("SELECT note FROM people").get()).toMatchObject({
        note: "a; b, c",
      });
      expect(db.prepare("PRAGMA index_list(notes)").all()).toContainEqual(
        expect.objectContaining({ name: "notes_owner" }),
      );
      expect(() => db.exec("INSERT INTO notes VALUES (1, 999)")).toThrow(
        /foreign key/i,
      );
    } finally {
      db.close();
    }
  });

  it("reports source lines for unsupported or lossy instructions", () => {
    const draft = input(
      `CREATE TABLE ok (id INTEGER);
CREATE TABLE complex (id INTEGER CHECK (id > 0));
CREATE TABLE scoped.extra (id INTEGER);
INSERT INTO ok VALUES (1);`,
      "sqlite",
    );
    expect(draft.tables.map((table) => table.name)).toEqual(["ok"]);
    expect(draft.issues.map((issue) => issue.line)).toEqual([2, 3, 4]);
  });

  it("imports literal DDL from a source file and reports non-DDL operations", () => {
    const draft = input(
      'cursor.execute("CREATE TABLE owners (id INTEGER PRIMARY KEY)")\ncursor.execute("SELECT id FROM owners")',
      "sqlite",
      { format: "source", name: "setup.py" },
    );
    expect(draft.tables.map((table) => table.name)).toEqual(["owners"]);
    expect(draft.issues.map((issue) => issue.line)).toEqual([2]);
  });

  it("round-trips qualified PostgreSQL tables with the same name and a cross-schema FK", () => {
    const inputDdl = `CREATE SCHEMA "Archive";
CREATE TABLE public.records (id INTEGER PRIMARY KEY);
CREATE TABLE "Archive".records (id INTEGER PRIMARY KEY, parent_id INTEGER);
CREATE INDEX "by_parent" ON "Archive".records (parent_id);
ALTER TABLE "Archive".records ADD FOREIGN KEY (parent_id) REFERENCES public.records (id);`;
    const draft = input(inputDdl, "postgresql");
    expect(draft.issues).toEqual([]);
    expect(draft.tables[1]).toMatchObject({
      name: "records",
      schema: "Archive",
      createSchema: true,
      options: { keys: [{ table: "records", targetSchema: "public" }] },
    });
    const output = buildProjectDdl("postgresql", draft.tables);
    expect(output).toContain('CREATE SCHEMA IF NOT EXISTS "Archive"');
    expect(output).toContain('ON "Archive"."records" ("parent_id")');
    expect(output).toContain(
      'ALTER TABLE "Archive"."records" ADD FOREIGN KEY ("parent_id") REFERENCES "public"."records" ("id")',
    );
    expect(
      buildProjectDdl("postgresql", input(output, "postgresql").tables),
    ).toEqual(output);
  });

  it("reopens temporarily invalid drafts without executing or filtering them", () => {
    const [table] = linkedDesignTemplate("sqlite");
    table.name = "";
    table.columns = [];
    expect(() => buildProjectDdl("sqlite", [table])).toThrow();
    expect(
      readDesignProject(
        JSON.parse(
          JSON.stringify({ version: 1, engine: "sqlite", tables: [table] }),
        ),
      ),
    ).toMatchObject({ tables: [{ id: table.id, name: "", columns: [] }] });
  });
});
