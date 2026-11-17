import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildMigrationPlan, editExistingTable, rebaseAppliedDesign } from "./schemaMigration";
import { newDesignTable } from "./schemaProject";
import type { SchemaSnapshot, TableInfo } from "../types";

const source: TableInfo = {
  name: "people",
  kind: "table",
  columns: [
    { name: "id", dataType: "INTEGER", primaryKey: true, nullable: false },
    { name: "name", dataType: "TEXT", primaryKey: false, nullable: false },
  ],
  indexes: [],
  foreignKeys: [],
  definition:
    "CREATE TABLE people(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL)",
};
const schema = (): SchemaSnapshot => ({
  engine: "sqlite",
  database: "fixture",
  tables: [structuredClone(source)],
});

describe("graphical migration plans", () => {
  it("preserves an existing draft when only a new table is applied", () => {
    const existing = editExistingTable(source);
    existing.columns[1].name = "display_name";
    const fresh = newDesignTable("sqlite");
    const snapshot = schema();
    const live = { ...source, name: fresh.name };
    snapshot.tables.push(live);
    const submitted = [existing, fresh];
    const result = rebaseAppliedDesign(submitted, submitted, new Set([fresh.id]), snapshot);
    expect(result[0]).toBe(existing);
    expect(result[0].columns[1].name).toBe("display_name");
    expect(result[1].source?.name).toBe(fresh.name);
  });

  it("edits Mongo validators and simple indexes without replaying advanced or unchanged indexes", () => {
    const collection: TableInfo = {
      name: "profiles",
      kind: "collection (schema campionato: max 20 documenti)",
      columns: [],
      foreignKeys: [],
      indexes: [
        { name: "_id_", columns: ["_id"], unique: true },
        { name: "city", columns: ["city"], mongoEditable: true },
        { name: "advanced", columns: ["body"], mongoEditable: false },
      ],
      mongo: {
        sampled: true,
        validator: { $jsonSchema: { bsonType: "object", properties: { city: { bsonType: "string" } } } },
        validationLevel: "moderate",
        validationAction: "warn",
      },
    };
    const snapshot: SchemaSnapshot = { engine: "mongodb", database: "test", tables: [collection] };
    const draft = editExistingTable(collection, "mongodb");
    expect(draft.columns).toMatchObject([{ name: "city", dataType: "string" }]);
    expect(buildMigrationPlan("mongodb", [draft], snapshot).changes).toEqual([]);
    draft.options.indexes = [{ name: "name", columns: "name", unique: true }];
    draft.options.validator = '{"$jsonSchema":{"bsonType":"object","required":["city"]}}';
    const plan = buildMigrationPlan("mongodb", [draft], snapshot);
    expect(plan.blockers).toEqual([]);
    expect(plan.affectedTableIds).toEqual([draft.id]);
    expect(JSON.parse(plan.sql)).toEqual([
      { collMod: "profiles", validator: { $jsonSchema: { bsonType: "object", required: ["city"] } }, validationLevel: "moderate", validationAction: "warn" },
      { dropIndexes: "profiles", index: "city" },
      { createIndexes: "profiles", indexes: [{ name: "name", key: { name: 1 }, unique: true }] },
    ]);
  });

  it("retains composite unique constraints when rebuilding a simple SQLite table", () => {
    const original: TableInfo = { ...structuredClone(source),
      definition: "CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL,city TEXT,UNIQUE(name,city))",
      columns: [...structuredClone(source.columns),{ name:"city",dataType:"TEXT",nullable:true,primaryKey:false }],
      indexes:[{name:"sqlite_autoindex_people_1",columns:["name","city"],unique:true}] };
    const draft=editExistingTable(original);draft.columns[1].nullable=true;
    const plan=buildMigrationPlan("sqlite",[draft],{engine:"sqlite",database:"fixture",tables:[original]});
    expect(plan.blockers).toEqual([]);
    const db=new DatabaseSync(":memory:");db.exec(original.definition!+";INSERT INTO people VALUES(1,'Ada','Udine');BEGIN IMMEDIATE;");db.exec(plan.sql);db.exec("COMMIT");
    expect(()=>db.exec("INSERT INTO people VALUES(2,'Ada','Udine')")).toThrow();db.close();
  });
  it("is empty immediately after adopting a real structure and preserves autoincrement", () => {
    const draft = editExistingTable(source);
    expect(draft.columns[0].autoIncrement).toBe(true);
    expect(
      buildMigrationPlan("sqlite", [draft], schema()).changes,
    ).toHaveLength(0);
  });
  it("runs rename, column addition and index creation on a real SQLite database without losing data", () => {
    const draft = editExistingTable(source);
    draft.columns[1].name = "display_name";
    draft.columns.push({
      name: "email",
      dataType: "TEXT",
      nullable: true,
      primaryKey: false,
    });
    draft.options.indexes.push({
      name: "idx_people_email",
      columns: "email",
      unique: true,
    });
    const plan = buildMigrationPlan("sqlite", [draft], schema());
    expect(plan.blockers).toEqual([]);
    expect(plan.rebuildSqlite).toBe(false);
    const db = new DatabaseSync(":memory:");
    db.exec(
      source.definition! + "; INSERT INTO people(name) VALUES ('città €');",
    );
    db.exec(plan.sql);
    expect(
      db.prepare("SELECT id,display_name,email FROM people").get(),
    ).toMatchObject({ id: 1, display_name: "città €", email: null });
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE name='idx_people_email'")
        .get(),
    ).toBeTruthy();
    db.close();
  });
  it("rebuilds a simple table with constraints and mapped renamed columns inside a rollback-capable transaction", () => {
    const draft = editExistingTable(source);
    draft.columns[1].name = "display_name";
    draft.columns[1].unique = true;
    const plan = buildMigrationPlan("sqlite", [draft], schema());
    expect(plan.blockers).toEqual([]);
    expect(plan.rebuildSqlite).toBe(true);
    expect(plan.changes[0].destructive).toBe(true);
    const db = new DatabaseSync(":memory:");
    db.exec(
      source.definition! +
        "; INSERT INTO people(name) VALUES ('città €'); BEGIN IMMEDIATE;",
    );
    db.exec(plan.sql);
    db.exec("COMMIT");
    expect(db.prepare("SELECT * FROM people").get()).toMatchObject({
      id: 1,
      display_name: "città €",
    });
    expect(() =>
      db.exec("INSERT INTO people(display_name) VALUES ('città €')"),
    ).toThrow();
    db.close();
  });
  it("blocks lossy reconstruction, stale metadata, key removal and name collisions", () => {
    const stale = schema();
    stale.tables[0].columns.push({
      name: "outside",
      dataType: "TEXT",
      primaryKey: false,
      nullable: true,
    });
    expect(
      buildMigrationPlan(
        "sqlite",
        [editExistingTable(source)],
        stale,
      ).blockers.join(),
    ).toMatch(/cambiato/);
    const draft = editExistingTable(source);
    draft.columns[1].unique = true;
    const advanced = schema();
    advanced.tables.push({
      name: "view1",
      kind: "view",
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(
      buildMigrationPlan("sqlite", [draft], advanced).blockers.join(),
    ).toMatch(/viste|trigger/);
    draft.columns = draft.columns.slice(1);
    expect(
      buildMigrationPlan("sqlite", [draft], schema()).blockers.join(),
    ).toMatch(/chiave primaria/);
  });
  it("generates PostgreSQL conversion and nullability changes with qualified identifiers", () => {
    const pg = {
      ...structuredClone(source),
      schema: "public",
      definition:
        "CREATE TABLE people(id integer primary key,name text not null)",
    };
    const draft = editExistingTable(pg);
    draft.columns[1].dataType = "VARCHAR(100)";
    draft.columns[1].nullable = true;
    const plan = buildMigrationPlan("postgresql", [draft], {
      engine: "postgresql",
      database: "fixture",
      tables: [pg],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.sql).toContain(
      'ALTER TABLE "public"."people" ALTER COLUMN "name" TYPE VARCHAR(100) USING "name"::VARCHAR(100)',
    );
    expect(plan.sql).toContain("DROP NOT NULL");
  });

  it("edits PostgreSQL tables outside public and resolves ordinary cross-schema constraints", () => {
    const pg = { ...structuredClone(source), schema: "archive", definition: null };
    const parent = { ...pg, schema: "public" };
    const draft = editExistingTable(pg, "postgresql");
    draft.options.keys.push({
      column: "id", table: "people", targetSchema: "public", targetColumn: "id",
    });
    const target = { engine: "postgresql" as const, database: "fixture", namespaces: ["public", "archive"], tables: [parent, pg] };
    const plan = buildMigrationPlan("postgresql", [draft], target);
    expect(plan.blockers).toEqual([]);
    expect(plan.sql).toContain('ALTER TABLE "archive"."people" ADD FOREIGN KEY ("id") REFERENCES "public"."people" ("id");');
    const saved = {
      ...pg,
      foreignKeys: [{ name: "people_parent", column: "id", referencedTable: "people", referencedSchema: "public", referencedColumn: "id" }],
    };
    const remove = editExistingTable(saved, "postgresql");
    remove.options.keys = [];
    const removal = buildMigrationPlan("postgresql", [remove], { ...target, tables: [parent, saved] });
    expect(removal.blockers).toEqual([]);
    expect(removal.sql).toContain('ALTER TABLE "archive"."people" DROP CONSTRAINT "people_parent";');
  });

  it("lets PostgreSQL retarget existing references after a cross-schema parent rename", () => {
    const parent: TableInfo = { ...structuredClone(source), schema: "public" };
    const child: TableInfo = {
      ...structuredClone(source),
      name: "notes",
      schema: "archive",
      foreignKeys: [{
        name: "owner_fk", column: "id", referencedTable: "people",
        referencedSchema: "public", referencedColumn: "id",
      }],
    };
    const parentDraft = editExistingTable(parent, "postgresql");
    parentDraft.name = "contacts";
    const childDraft = editExistingTable(child, "postgresql");
    childDraft.options.keys[0].table = "contacts";
    const plan = buildMigrationPlan("postgresql", [childDraft, parentDraft], {
      engine: "postgresql", database: "fixture", namespaces: ["public", "archive"],
      tables: [child, parent],
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.sql).toContain('ALTER TABLE "public"."people" RENAME TO "contacts";');
    expect(plan.sql).not.toContain("DROP CONSTRAINT");
    expect(new Set(plan.affectedTableIds)).toEqual(new Set([childDraft.id, parentDraft.id]));
  });
});
