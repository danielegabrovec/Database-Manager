import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildOperation, INITIAL_READ } from "./readOperation";
import type { ReadOptions, WorkbenchParameter } from "./readOperation";
import type { Engine, SchemaSnapshot, TableInfo } from "../types";

const customers: TableInfo = {
  name: "customers",
  kind: "table",
  indexes: [],
  foreignKeys: [],
  columns: [
    { name: "id", dataType: "INTEGER", nullable: false, primaryKey: true },
    { name: "name", dataType: "TEXT", nullable: false, primaryKey: false },
    { name: "city", dataType: "TEXT", nullable: false, primaryKey: false },
    { name: "note", dataType: "TEXT", nullable: true, primaryKey: false },
    { name: "active", dataType: "BOOLEAN", nullable: false, primaryKey: false },
  ],
};
const orders: TableInfo = {
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
    { name: "id", dataType: "INTEGER", nullable: false, primaryKey: true },
    {
      name: "customer_id",
      dataType: "INTEGER",
      nullable: false,
      primaryKey: false,
    },
    { name: "amount", dataType: "NUMERIC", nullable: false, primaryKey: false },
  ],
};
const schema: SchemaSnapshot = {
  engine: "sqlite",
  database: "test",
  tables: [customers, orders],
};
function options(patch: Partial<ReadOptions>): ReadOptions {
  return { ...structuredClone(INITIAL_READ), ...patch };
}
function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE customers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,city TEXT NOT NULL,note TEXT,active BOOLEAN NOT NULL);CREATE TABLE orders(id INTEGER PRIMARY KEY,customer_id INTEGER NOT NULL REFERENCES customers(id),amount NUMERIC NOT NULL);INSERT INTO customers VALUES(1,'Anna','Udine',NULL,1),(2,'Marco','Trieste','NULL',0),(3,'Sara','Udine','present',1);INSERT INTO orders VALUES(1,1,10.25),(2,1,20.5),(3,3,7.5);",
  );
  return db;
}
function binding(value: unknown): SQLInputValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  )
    return value;
  if (value && typeof value === "object" && "type" in value) {
    const cell = value as { type: string; value?: unknown };
    if (cell.type === "null") return null;
    if (cell.type === "integer") return BigInt(String(cell.value));
    if (cell.type === "boolean") return cell.value ? 1 : 0;
    if (cell.type === "float") return Number(cell.value);
    return String(cell.value ?? "");
  }
  throw new Error("Parametro del protocollo non riconosciuto");
}
function execute(
  db: DatabaseSync,
  table: TableInfo,
  read: ReadOptions,
  engine: Engine = "sqlite",
) {
  const built = buildOperation(engine, table, schema, read);
  const params = Object.fromEntries(
    built.parameters.map((parameter, index) => [
      engine === "postgresql" ? String(index + 1) : parameter.name,
      binding(parameter.value),
    ]),
  );
  const statement = db.prepare(built.query);
  return {
    built,
    rows: built.parameters.length ? statement.all(params) : statement.all(),
  };
}
function scalar(parameter: WorkbenchParameter) {
  return parameter.value &&
    typeof parameter.value === "object" &&
    "type" in parameter.value
    ? (parameter.value as { value?: unknown }).value
    : parameter.value;
}
describe("compositore: letture eseguite davvero con SQLite", () => {
  it("i filtri BIGINT conservano tutte le cifre nel protocollo e raggiungono la riga corretta", () => {
    const db = database();
    try {
      db.exec("CREATE TABLE huge(id BIGINT PRIMARY KEY,label TEXT)");
      db.prepare("INSERT INTO huge VALUES(?,?)").run(
        9223372036854775807n,
        "exact",
      );
      const table: TableInfo = {
        name: "huge",
        kind: "table",
        indexes: [],
        foreignKeys: [],
        columns: [
          { name: "id", dataType: "BIGINT", nullable: false, primaryKey: true },
          {
            name: "label",
            dataType: "TEXT",
            nullable: true,
            primaryKey: false,
          },
        ],
      };
      const { built, rows } = execute(
        db,
        table,
        options({
          operation: "filter",
          columns: ["label"],
          filters: [
            { column: "id", operator: "=", value: "9223372036854775807" },
          ],
        }),
      );
      expect(String(scalar(built.parameters[0]))).toBe("9223372036854775807");
      expect(built.parameters[0].dataType).toBe("BIGINT");
      expect(rows.map((row) => row.label)).toEqual(["exact"]);
    } finally {
      db.close();
    }
  });
  it("seleziona solo i campi scelti e applica ordinamento e limite", () => {
    const db = database();
    try {
      const { rows } = execute(
        db,
        customers,
        options({
          columns: ["name", "city"],
          orderBy: "name",
          descending: true,
          limit: 2,
        }),
      );
      expect(rows.map((row) => Object.keys(row))).toEqual([
        ["name", "city"],
        ["name", "city"],
      ]);
      expect(rows.map((row) => row.name)).toEqual(["Sara", "Marco"]);
    } finally {
      db.close();
    }
  });
  it("tiene i valori separati dal codice SQL, anche quando contengono SQL ostile", () => {
    const db = database(),
      payload = "' OR 1=1; DROP TABLE orders;--";
    try {
      db.prepare("INSERT INTO customers VALUES(4,?,'Udine',NULL,1)").run(
        payload,
      );
      const { built, rows } = execute(
        db,
        customers,
        options({
          operation: "filter",
          columns: ["id", "name"],
          filters: [{ column: "name", operator: "=", value: payload }],
        }),
      );
      expect(built.query).not.toContain(payload);
      expect(built.parameters[0]).toMatchObject({
        name: "p1",
        dataType: "TEXT",
      });
      expect(scalar(built.parameters[0])).toBe(payload);
      expect(rows.map((row) => row.id)).toEqual([4]);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM orders").get()?.count,
      ).toBe(3);
    } finally {
      db.close();
    }
  });
  it("distingue un NULL SQL dalla stringa letterale NULL", () => {
    const db = database();
    try {
      const nulls = execute(
        db,
        customers,
        options({
          operation: "filter",
          columns: ["id"],
          filters: [{ column: "note", operator: "IS NULL", value: "ignored" }],
        }),
      );
      expect(nulls.built.parameters).toHaveLength(0);
      expect(nulls.rows.map((row) => row.id)).toEqual([1]);
      const nonNulls = execute(
        db,
        customers,
        options({
          operation: "filter",
          columns: ["id"],
          filters: [
            { column: "note", operator: "IS NOT NULL", value: "ignored" },
          ],
          orderBy: "id",
        }),
      );
      expect(nonNulls.rows.map((row) => row.id)).toEqual([2, 3]);
      const text = execute(
        db,
        customers,
        options({
          operation: "filter",
          columns: ["id"],
          filters: [{ column: "note", operator: "=", value: "NULL" }],
        }),
      );
      expect(text.rows.map((row) => row.id)).toEqual([2]);
    } finally {
      db.close();
    }
  });
  it("le booleane selezionate nel filtro si comportano come booleane nel driver", () => {
    const db = database();
    try {
      const { rows, built } = execute(
        db,
        customers,
        options({
          operation: "filter",
          columns: ["id"],
          filters: [{ column: "active", operator: "=", value: "true" }],
          orderBy: "id",
        }),
      );
      expect(built.parameters[0].dataType).toBe("BOOLEAN");
      expect(rows.map((row) => row.id)).toEqual([1, 3]);
    } finally {
      db.close();
    }
  });
  it("legge per chiave composita e conserva la corrispondenza dei parametri PostgreSQL numerati", () => {
    const db = database();
    try {
      db.exec(
        "CREATE TABLE scoped(tenant INTEGER,id INTEGER,label TEXT,PRIMARY KEY(tenant,id));INSERT INTO scoped VALUES(1,1,'target'),(2,1,'other');",
      );
      const scoped: TableInfo = {
        name: "scoped",
        kind: "table",
        indexes: [],
        foreignKeys: [],
        columns: [
          {
            name: "tenant",
            dataType: "INTEGER",
            nullable: false,
            primaryKey: true,
          },
          {
            name: "id",
            dataType: "INTEGER",
            nullable: false,
            primaryKey: true,
          },
          {
            name: "label",
            dataType: "TEXT",
            nullable: true,
            primaryKey: false,
          },
        ],
      };
      for (const engine of ["sqlite", "postgresql"] as const) {
        const { rows, built } = execute(
          db,
          scoped,
          options({ operation: "findByKey", columns: ["label"] }),
          engine,
        );
        expect(rows.map((row) => row.label)).toEqual(["target"]);
        expect(built.parameters.map((parameter) => parameter.name)).toEqual([
          "p1",
          "p2",
        ]);
        if (engine === "postgresql") {
          expect(built.query).toContain("$1");
          expect(built.query).toContain("$2");
          expect(built.query).not.toContain(":p1");
        }
      }
    } finally {
      db.close();
    }
  });
  it("esegue JOIN qualificata con filtri e restituisce i campi collegati", () => {
    const db = database();
    try {
      const { rows } = execute(
        db,
        orders,
        options({
          operation: "join",
          columns: ["id", "amount"],
          joinTable: "customers",
          joinLocal: "customer_id",
          joinForeign: "id",
          joinType: "INNER",
          filters: [{ column: "amount", operator: ">=", value: "10" }],
          orderBy: "id",
        }),
      );
      expect(rows.map((row) => row.id)).toEqual([1, 2]);
      expect(rows.map((row) => row.customers_name)).toEqual(["Anna", "Anna"]);
    } finally {
      db.close();
    }
  });
  it("COUNT e SUM raggruppano realmente i dati del risultato", () => {
    const db = database();
    try {
      const grouped = execute(
        db,
        customers,
        options({
          operation: "aggregate",
          aggregate: "COUNT",
          aggregateColumn: "*",
          groupBy: ["city"],
          orderBy: "city",
        }),
      );
      expect(grouped.rows).toEqual([
        expect.objectContaining({ city: "Trieste", totale: 1 }),
        expect.objectContaining({ city: "Udine", totale: 2 }),
      ]);
      const sums = execute(
        db,
        orders,
        options({
          operation: "aggregate",
          aggregate: "SUM",
          aggregateColumn: "amount",
          groupBy: ["customer_id"],
          orderBy: "customer_id",
        }),
      );
      expect(sums.rows).toEqual([
        expect.objectContaining({ customer_id: 1, totale: 30.75 }),
        expect.objectContaining({ customer_id: 3, totale: 7.5 }),
      ]);
    } finally {
      db.close();
    }
  });
  it("gestisce identificatori con spazi e virgolette senza interpretarne il contenuto", () => {
    const db = database();
    try {
      db.exec(
        'CREATE TABLE "order ""items"""("key" INTEGER PRIMARY KEY,"display name" TEXT);INSERT INTO "order ""items""" VALUES(1,\'quoted\')',
      );
      const table: TableInfo = {
        name: 'order "items"',
        kind: "table",
        indexes: [],
        foreignKeys: [],
        columns: [
          {
            name: "key",
            dataType: "INTEGER",
            nullable: false,
            primaryKey: true,
          },
          {
            name: "display name",
            dataType: "TEXT",
            nullable: true,
            primaryKey: false,
          },
        ],
      };
      expect(
        execute(
          db,
          table,
          options({
            columns: ["display name"],
            filters: [{ column: "key", operator: "=", value: "1" }],
          }),
        ).rows[0]["display name"],
      ).toBe("quoted");
    } finally {
      db.close();
    }
  });
  it("rifiuta riferimenti a colonne non presenti anche in aggregazione e ordinamento", () => {
    for (const patch of [
      { groupBy: ["missing"], operation: "aggregate" as const },
      {
        aggregateColumn: "missing",
        aggregate: "SUM",
        operation: "aggregate" as const,
      },
      { orderBy: "missing" },
    ])
      expect(() =>
        buildOperation("sqlite", customers, schema, options(patch)),
      ).toThrow(/campo|colonna|sconosciut|presente/i);
  });
});
function mongoOperatorValues(value: unknown, operator: string): unknown[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value))
    return value.flatMap((item) => mongoOperatorValues(item, operator));
  return Object.entries(value).flatMap(([key, child]) =>
    key === operator ? [child] : mongoOperatorValues(child, operator),
  );
}
function mongoInteger(value: unknown): number {
  if (typeof value === "number") return value;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    if (object.$numberInt !== undefined) return Number(object.$numberInt);
    if (object.$numberLong !== undefined) return Number(object.$numberLong);
  }
  return NaN;
}
describe("compositore MongoDB: JSON valido e tipi del protocollo", () => {
  const table: TableInfo = {
    name: "people",
    kind: "collection",
    indexes: [],
    foreignKeys: [],
    columns: [
      { name: "_id", dataType: "string", nullable: false, primaryKey: true },
      { name: "age", dataType: "int", nullable: false, primaryKey: false },
      { name: "active", dataType: "bool", nullable: false, primaryKey: false },
      {
        name: "amount",
        dataType: "decimal",
        nullable: true,
        primaryKey: false,
      },
    ],
  };
  it("Long mantiene 64 bit nei valori eseguibili e nei marcatori del generatore", () => {
    const withLong = {
      ...table,
      columns: [
        ...table.columns,
        {
          name: "sequence",
          dataType: "long",
          nullable: false,
          primaryKey: false,
        },
      ],
    };
    const built = buildOperation(
      "mongodb",
      withLong,
      null,
      options({
        operation: "filter",
        filters: [
          { column: "sequence", operator: "=", value: "9223372036854775807" },
        ],
      }),
    );
    expect(JSON.parse(built.query).filter.sequence).toEqual({
      $numberLong: "9223372036854775807",
    });
    expect(built.parameters[0].value).toEqual({
      $numberLong: "9223372036854775807",
    });
    expect(JSON.parse(built.template!).filter.sequence).toEqual({
      $param: "p1",
    });
  });
  it("mantiene numeri, booleane e Decimal128 invece di confrontarli con stringhe", () => {
    const built = buildOperation(
      "mongodb",
      table,
      null,
      options({
        operation: "filter",
        filters: [
          { column: "age", operator: ">", value: "18" },
          { column: "active", operator: "=", value: "true" },
          {
            column: "amount",
            operator: ">=",
            value: "9007199254740993.12345678",
          },
        ],
      }),
    );
    const command = JSON.parse(built.query);
    expect(command.find).toBe("people");
    const serialized = JSON.stringify(command.filter);
    expect(
      mongoOperatorValues(command.filter, "$gt").map(mongoInteger),
    ).toContain(18);
    expect(serialized).toContain("true");
    expect(serialized).toContain(
      '"$numberDecimal":"9007199254740993.12345678"',
    );
    expect(built.parameters.map((parameter) => parameter.dataType)).toEqual([
      "int",
      "bool",
      "decimal",
    ]);
    expect(mongoInteger(built.parameters[0].value)).toBe(18);
    expect(built.parameters[1].value).toBe(true);
    expect(built.parameters[2].value).toEqual({
      $numberDecimal: "9007199254740993.12345678",
    });
    const template = JSON.parse(built.template!);
    expect(JSON.stringify(template)).toContain('"$param":"p1"');
    expect(JSON.stringify(template)).toContain('"$param":"p3"');
    expect(JSON.stringify(template)).not.toContain("9007199254740993.12345678");
  });
  it("IS NOT NULL usa la semantica non nulla e la lettura per chiave rispetta il tipo _id", () => {
    const notNull = JSON.parse(
      buildOperation(
        "mongodb",
        table,
        null,
        options({
          operation: "filter",
          filters: [
            { column: "amount", operator: "IS NOT NULL", value: "ignored" },
          ],
        }),
      ).query,
    );
    expect(JSON.stringify(notNull.filter)).toContain('"$ne":null');
    const byKey = JSON.parse(
      buildOperation(
        "mongodb",
        table,
        null,
        options({ operation: "findByKey" }),
      ).query,
    );
    expect(typeof byKey.filter._id).toBe("string");
    expect(byKey.filter._id).not.toEqual(
      expect.objectContaining({ $oid: expect.anything() }),
    );
  });
  it("due filtri sullo stesso campo non si sovrascrivono", () => {
    const command = JSON.parse(
      buildOperation(
        "mongodb",
        table,
        null,
        options({
          operation: "filter",
          filters: [
            { column: "age", operator: ">", value: "18" },
            { column: "age", operator: "<", value: "65" },
          ],
        }),
      ).query,
    );
    expect(
      mongoOperatorValues(command.filter, "$gt").map(mongoInteger),
    ).toContain(18);
    expect(
      mongoOperatorValues(command.filter, "$lt").map(mongoInteger),
    ).toContain(65);
  });
  it("genera una pipeline aggregazione JSON con il raggruppamento richiesto", () => {
    const command = JSON.parse(
      buildOperation(
        "mongodb",
        table,
        null,
        options({
          operation: "aggregate",
          aggregate: "COUNT",
          aggregateColumn: "*",
          groupBy: ["active"],
        }),
      ).query,
    );
    expect(command).toMatchObject({
      aggregate: "people",
      pipeline: [{ $group: { _id: "$active", total: { $sum: 1 } } }],
      cursor: {},
    });
  });
});
