import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildQuery,
  extendDdl,
  INITIAL_DESIGNER,
  INITIAL_QUERY_OPTIONS,
} from "./SchemaBuilders";
import type { SchemaSnapshot } from "../types";

const schema: SchemaSnapshot = {
  database: "test",
  engine: "sqlite",
  tables: [
    {
      name: "customers",
      kind: "table",
      indexes: [],
      foreignKeys: [],
      columns: [
        { name: "id", dataType: "INTEGER", primaryKey: true, nullable: false },
        { name: "city", dataType: "TEXT", primaryKey: false, nullable: false },
      ],
    },
    {
      name: "orders",
      kind: "table",
      indexes: [],
      foreignKeys: [
        {
          column: "customer_id",
          referencedTable: "customers",
          referencedColumn: "id",
        },
      ],
      columns: [
        { name: "id", dataType: "INTEGER", primaryKey: true, nullable: false },
        {
          name: "customer_id",
          dataType: "INTEGER",
          primaryKey: false,
          nullable: false,
        },
      ],
    },
  ],
};
describe("query builder su un motore SQLite reale", () => {
  it("genera JOIN, raggruppamento e ordinamento eseguibili", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE customers(id INTEGER PRIMARY KEY,city TEXT NOT NULL);CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER);INSERT INTO customers VALUES(1,'Udine'),(2,'Trieste'),(3,'Udine');INSERT INTO orders VALUES(1,1),(2,1),(3,3);",
      );
      const query = buildQuery(schema, schema.tables[0], [], "", 100, {
        ...INITIAL_QUERY_OPTIONS,
        joinTarget: "orders",
        joinType: "INNER",
        joinLeft: "id",
        joinRight: "customer_id",
        groupBy: "city",
        orderBy: "total",
        descending: true,
      });
      const rows = db.prepare(query).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].city).toBe("Udine");
      expect(rows[0].total).toBe(3);
    } finally {
      db.close();
    }
  });
  it("genera chiavi esterne e indici verificabili dal motore", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "PRAGMA foreign_keys=ON;CREATE TABLE parent(id INTEGER PRIMARY KEY);",
      );
      const columns = [
        {
          name: "parent_id",
          dataType: "INTEGER",
          nullable: false,
          primaryKey: false,
        },
      ];
      const sql = extendDdl(
        'CREATE TABLE "child" (\n  "parent_id" INTEGER NOT NULL\n);',
        "sqlite",
        "child",
        columns,
        {
          ...INITIAL_DESIGNER,
          keys: [{ column: "parent_id", table: "parent", targetColumn: "id" }],
          indexes: [
            { name: "idx_child_parent", columns: "parent_id", unique: false },
          ],
        },
      );
      db.exec(sql);
      expect(db.prepare("PRAGMA foreign_key_list(child)").all()).toHaveLength(
        1,
      );
      expect(db.prepare("PRAGMA index_list(child)").all()).toHaveLength(1);
      expect(() => db.exec("INSERT INTO child VALUES(999)")).toThrow();
    } finally {
      db.close();
    }
  });
  it("mantiene i tipi dei comandi MongoDB e valida il JSON", () => {
    const mongo = { ...schema, engine: "mongodb" as const };
    const query = JSON.parse(
      buildQuery(
        mongo,
        schema.tables[0],
        [],
        '{"id":{"$numberLong":"9223372036854775807"}}',
        20,
        INITIAL_QUERY_OPTIONS,
      ),
    );
    expect(query.filter.id.$numberLong).toBe("9223372036854775807");
    expect(() =>
      buildQuery(
        mongo,
        schema.tables[0],
        [],
        "{bad",
        20,
        INITIAL_QUERY_OPTIONS,
      ),
    ).toThrow();
  });
});
