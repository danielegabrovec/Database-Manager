import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { INITIAL_DESIGNER } from "../components/SchemaBuilders";
import {
  adoptTable,
  buildProjectDdl,
  buildCreationPlan,
  buildTableDdl,
  designSnapshot,
} from "./schemaProject";
import type { DesignTable } from "./schemaProject";
import type { TableInfo } from "../types";

function project(): DesignTable[] {
  return [
    {
      id: "orders",
      name: "orders",
      columns: [
        {
          name: "id",
          dataType: "INTEGER",
          primaryKey: true,
          nullable: false,
          autoIncrement: true,
        },
        {
          name: "customer_id",
          dataType: "INTEGER",
          primaryKey: false,
          nullable: false,
        },
        {
          name: "amount",
          dataType: "NUMERIC",
          primaryKey: false,
          nullable: false,
          defaultValue: "0",
        },
      ],
      options: {
        ...structuredClone(INITIAL_DESIGNER),
        keys: [
          { column: "customer_id", table: "customers", targetColumn: "id" },
        ],
        indexes: [
          {
            name: "idx_orders_customer_amount",
            columns: "customer_id, amount",
            unique: false,
          },
        ],
      },
    },
    {
      id: "customers",
      name: "customers",
      columns: [
        {
          name: "id",
          dataType: "INTEGER",
          primaryKey: true,
          nullable: false,
          autoIncrement: true,
        },
        {
          name: "email",
          dataType: "TEXT",
          primaryKey: false,
          nullable: false,
          unique: true,
        },
        {
          name: "city",
          dataType: "TEXT",
          primaryKey: false,
          nullable: true,
          defaultValue: "'Udine'",
        },
      ],
      options: {
        ...structuredClone(INITIAL_DESIGNER),
        indexes: [
          { name: "idx_customers_city", columns: "city", unique: false },
        ],
      },
    },
  ];
}
function introspect(db: DatabaseSync, name: string): TableInfo {
  const definition = db
    .prepare("SELECT sql FROM sqlite_master WHERE name=? AND type='table'")
    .get(name)?.sql;
  const columns = db
    .prepare(
      'SELECT name,type,"notnull",dflt_value,pk FROM pragma_table_info(?) ORDER BY cid',
    )
    .all(name)
    .map((column) => ({
      name: String(column.name),
      dataType: String(column.type),
      nullable: !Number(column.notnull) && !Number(column.pk),
      primaryKey: !!Number(column.pk),
      ...(column.dflt_value === null
        ? {}
        : { defaultValue: String(column.dflt_value) }),
    }));
  const indexes = db
    .prepare('SELECT name,"unique",partial FROM pragma_index_list(?)')
    .all(name)
    .map((index) => ({
      name: String(index.name),
      unique: !!Number(index.unique),
      ...(Number(index.partial) ? { partial: true } : {}),
      columns: db
        .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(String(index.name))
        .map((column) => String(column.name)),
    }));
  const foreignKeys = db
    .prepare(
      'SELECT "from","table","to" FROM pragma_foreign_key_list(?) ORDER BY id,seq',
    )
    .all(name)
    .map((key) => ({
      column: String(key.from),
      referencedTable: String(key.table),
      referencedColumn: String(key.to),
    }));
  return {
    name,
    kind: "table",
    columns,
    indexes,
    foreignKeys,
    definition: typeof definition === "string" ? definition : null,
  };
}
describe("designer: progetto visuale → DDL → SQLite reale", () => {
  it("crea tabelle referenziate prima delle figlie, con FK, indici, vincoli e identità funzionanti", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(buildProjectDdl("sqlite", project()));
      const created = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
        )
        .all()
        .map((row) => row.name);
      expect(created).toEqual(["customers", "orders"]);
      db.exec(
        "INSERT INTO customers(email) VALUES('a@example.com'),('b@example.com');DELETE FROM customers WHERE id=2;INSERT INTO customers(email) VALUES('c@example.com');",
      );
      expect(
        db
          .prepare("SELECT id,city FROM customers WHERE email='c@example.com'")
          .get(),
      ).toMatchObject({ id: 3, city: "Udine" });
      expect(() =>
        db.exec("INSERT INTO customers(email) VALUES('a@example.com')"),
      ).toThrow();
      expect(() =>
        db.exec("INSERT INTO orders(customer_id,amount) VALUES(999,1)"),
      ).toThrow();
      db.exec("INSERT INTO orders(customer_id) VALUES(1)");
      expect(db.prepare("SELECT amount FROM orders").get()?.amount).toBe(0);
      expect(
        introspect(db, "orders").indexes.find(
          (index) => index.columns.join(",") === "customer_id,amount",
        )?.columns,
      ).toEqual(["customer_id", "amount"]);
    } finally {
      db.close();
    }
  });
  it("il diagramma snapshot corrisponde alle colonne, agli indici e alle relazioni create davvero", () => {
    const tables = project(),
      db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      db.exec(buildProjectDdl("sqlite", tables));
      const snapshot = designSnapshot("sqlite", tables);
      for (const table of snapshot.tables) {
        const actual = introspect(db, table.name);
        expect(actual.columns).toEqual(
          table.columns.map(
            ({ name, dataType, nullable, primaryKey, defaultValue }) => ({
              name,
              dataType,
              nullable,
              primaryKey,
              ...(defaultValue ? { defaultValue } : {}),
            }),
          ),
        );
        expect(actual.foreignKeys).toEqual(table.foreignKeys);
        for (const index of table.indexes)
          expect(actual.indexes).toContainEqual(index);
      }
    } finally {
      db.close();
    }
  });
  it("la copia inversa di una struttura non perde PK, FK, UNIQUE e indici", () => {
    const original = new DatabaseSync(":memory:"),
      copy = new DatabaseSync(":memory:");
    try {
      original.exec("PRAGMA foreign_keys=ON");
      original.exec(buildProjectDdl("sqlite", project()));
      const adopted = [
        adoptTable(introspect(original, "orders")),
        adoptTable(introspect(original, "customers")),
      ];
      copy.exec("PRAGMA foreign_keys=ON");
      copy.exec(buildProjectDdl("sqlite", adopted));
      copy.exec(
        "INSERT INTO customers(id,email) VALUES(1,'unique@example.com')",
      );
      expect(() =>
        copy.exec(
          "INSERT INTO customers(id,email) VALUES(2,'unique@example.com')",
        ),
      ).toThrow();
      expect(() =>
        copy.exec("INSERT INTO orders(id,customer_id) VALUES(1,999)"),
      ).toThrow();
      expect(
        introspect(copy, "orders").indexes.find(
          (index) => index.columns.join(",") === "customer_id,amount",
        )?.columns,
      ).toEqual(["customer_id", "amount"]);
      expect(
        introspect(copy, "orders").columns.map((column) => [
          column.name,
          column.primaryKey,
        ]),
      ).toEqual(
        introspect(original, "orders").columns.map((column) => [
          column.name,
          column.primaryKey,
        ]),
      );
    } finally {
      original.close();
      copy.close();
    }
  });
  it("quote e nomi riservati non diventano comandi SQL", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE guard(value TEXT);INSERT INTO guard VALUES('preserved')",
      );
      const table: DesignTable = {
        id: "quoted",
        name: 'select "name"; DROP TABLE guard;--',
        columns: [
          {
            name: 'order "id"',
            dataType: "INTEGER",
            nullable: false,
            primaryKey: true,
            autoIncrement: true,
          },
          {
            name: "full name",
            dataType: "TEXT",
            nullable: false,
            primaryKey: false,
          },
        ],
        options: structuredClone(INITIAL_DESIGNER),
      };
      db.exec(buildTableDdl("sqlite", table));
      expect(
        introspect(db, table.name).columns.map((column) => column.name),
      ).toEqual(['order "id"', "full name"]);
      expect(db.prepare("SELECT value FROM guard").get()?.value).toBe(
        "preserved",
      );
    } finally {
      db.close();
    }
  });
  it("rifiuta strutture ambigue e identità SQLite non supportate prima di creare tabelle", () => {
    const parent = project()[1];
    expect(() =>
      buildProjectDdl("sqlite", [parent, { ...parent, id: "duplicate" }]),
    ).toThrow("duplicata");
    expect(() =>
      buildTableDdl("sqlite", {
        ...parent,
        columns: [...parent.columns, { ...parent.columns[1], name: "EMAIL" }],
      }),
    ).toThrow("duplicata");
    expect(() =>
      buildTableDdl("sqlite", {
        ...parent,
        columns: parent.columns.map((column) =>
          column.primaryKey ? { ...column, dataType: "BIGINT" } : column,
        ),
      }),
    ).toThrow("AUTOINCREMENT");
    expect(() =>
      buildTableDdl("sqlite", {
        ...parent,
        columns: parent.columns.map((column) =>
          column.name === "city"
            ? { ...column, defaultValue: "0); DROP TABLE guard;--" }
            : column,
        ),
      }),
    ).toThrow("predefinito");
  });
});

describe("piano di creazione: progetto, pending e metadati effettivi", () => {
  it("dopo la prima creazione non rigenera CREATE per le tabelle già presenti e conserva i dati", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const tables = project();
      const first = buildCreationPlan("sqlite", tables, {
        engine: "sqlite",
        database: "test",
        tables: [],
      });
      expect(first.pendingTables).toHaveLength(2);
      db.exec(first.sql);
      db.exec("INSERT INTO customers(email) VALUES('preserved@example.com')");
      const existing = {
        engine: "sqlite" as const,
        database: "test",
        tables: [introspect(db, "customers"), introspect(db, "orders")],
      };
      const next = buildCreationPlan("sqlite", tables, existing);
      expect(next.pendingTables).toHaveLength(0);
      expect(next.sql).not.toMatch(/CREATE TABLE/i);
      db.exec(next.sql);
      expect(db.prepare("SELECT email FROM customers").get()?.email).toBe(
        "preserved@example.com",
      );
    } finally {
      db.close();
    }
  });
  it("crea soltanto la figlia mancante e valida la FK contro la tabella reale già presente", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      const tables = project(),
        parent = tables[1];
      db.exec(buildTableDdl("sqlite", parent));
      db.exec("INSERT INTO customers(email) VALUES('existing@example.com')");
      const schema = {
        engine: "sqlite" as const,
        database: "test",
        tables: [introspect(db, "customers")],
      };
      const plan = buildCreationPlan("sqlite", tables, schema);
      expect(plan.pendingTables.map((table) => table.name)).toEqual(["orders"]);
      expect(plan.sql).not.toContain('CREATE TABLE "customers"');
      db.exec(plan.sql);
      db.exec("INSERT INTO orders(customer_id,amount) VALUES(1,12)");
      expect(() =>
        db.exec("INSERT INTO orders(customer_id,amount) VALUES(999,12)"),
      ).toThrow();
      expect(db.prepare("SELECT COUNT(*) AS n FROM customers").get()?.n).toBe(
        1,
      );
    } finally {
      db.close();
    }
  });
  it("una colonna fantasma nella copia di progetto di un genitore esistente non diventa una destinazione FK valida", () => {
    const db = new DatabaseSync(":memory:");
    try {
      const tables = project();
      db.exec(buildTableDdl("sqlite", tables[1]));
      const ghostParent = {
        ...tables[1],
        columns: [
          {
            name: "ghost_id",
            dataType: "INTEGER",
            nullable: false,
            primaryKey: true,
          },
        ],
      };
      const child = {
        ...tables[0],
        options: {
          ...tables[0].options,
          keys: [
            {
              column: "customer_id",
              table: "customers",
              targetColumn: "ghost_id",
            },
          ],
        },
      };
      expect(() =>
        buildCreationPlan("sqlite", [ghostParent, child], {
          engine: "sqlite",
          database: "test",
          tables: [introspect(db, "customers")],
        }),
      ).toThrow(/non esiste nel database/);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name='orders'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it("non accetta un genitore rimosso dal progetto e assente dalla destinazione", () => {
    const child = project()[0];
    expect(() => buildCreationPlan("sqlite", [child], null)).toThrow(
      /né nello schema effettivo/,
    );
    expect(() =>
      buildCreationPlan("sqlite", [child], {
        engine: "sqlite",
        database: "test",
        tables: [],
      }),
    ).toThrow(/né nello schema effettivo/);
  });
  it("rifiuta una FK disegnata su un campo non univoco prima che SQLite possa creare uno schema con DML non funzionante", () => {
    const parent: DesignTable = {
      id: "parent",
      name: "parent",
      columns: [
        { name: "id", dataType: "INTEGER", primaryKey: true, nullable: false },
        { name: "label", dataType: "TEXT", primaryKey: false, nullable: false },
      ],
      options: structuredClone(INITIAL_DESIGNER),
    };
    const child: DesignTable = {
      id: "child",
      name: "child",
      columns: [
        { name: "label", dataType: "TEXT", primaryKey: false, nullable: false },
      ],
      options: {
        ...structuredClone(INITIAL_DESIGNER),
        keys: [{ column: "label", table: "parent", targetColumn: "label" }],
      },
    };
    expect(() => buildProjectDdl("sqlite", [parent, child])).toThrow(/UNIQUE/);
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "PRAGMA foreign_keys=ON;CREATE TABLE parent(id INTEGER PRIMARY KEY,label TEXT NOT NULL);CREATE TABLE child(label TEXT REFERENCES parent(label));INSERT INTO parent VALUES(1,'value')",
      );
      expect(() => db.exec("INSERT INTO child VALUES('value')")).toThrow(
        /foreign key mismatch/,
      );
    } finally {
      db.close();
    }
  });
  it("un UNIQUE completo del genitore esistente rende la relazione utilizzabile", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "PRAGMA foreign_keys=ON;CREATE TABLE parent(id INTEGER PRIMARY KEY,email TEXT UNIQUE);INSERT INTO parent VALUES(1,'valid@example.com')",
      );
      const child: DesignTable = {
        id: "emails",
        name: "emails",
        columns: [
          {
            name: "email",
            dataType: "TEXT",
            nullable: false,
            primaryKey: false,
          },
        ],
        options: {
          ...structuredClone(INITIAL_DESIGNER),
          keys: [{ column: "email", table: "parent", targetColumn: "email" }],
        },
      };
      const plan = buildCreationPlan("sqlite", [child], {
        engine: "sqlite",
        database: "test",
        tables: [introspect(db, "parent")],
      });
      db.exec(plan.sql);
      db.exec("INSERT INTO emails VALUES('valid@example.com')");
      expect(() =>
        db.exec("INSERT INTO emails VALUES('missing@example.com')"),
      ).toThrow();
    } finally {
      db.close();
    }
  });
  it("un indice UNIQUE parziale non viene trattato come destinazione FK completa o clonato senza predicato", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        "CREATE TABLE parent(id INTEGER PRIMARY KEY,email TEXT);CREATE UNIQUE INDEX unique_present_email ON parent(email) WHERE email IS NOT NULL",
      );
      const parent = introspect(db, "parent");
      expect(
        parent.indexes.find((index) => index.name === "unique_present_email")
          ?.partial,
      ).toBe(true);
      const child: DesignTable = {
        id: "emails",
        name: "emails",
        columns: [
          {
            name: "email",
            dataType: "TEXT",
            nullable: false,
            primaryKey: false,
          },
        ],
        options: {
          ...structuredClone(INITIAL_DESIGNER),
          keys: [{ column: "email", table: "parent", targetColumn: "email" }],
        },
      };
      expect(() =>
        buildCreationPlan("sqlite", [child], {
          engine: "sqlite",
          database: "test",
          tables: [parent],
        }),
      ).toThrow(/parziali/);
      expect(() => adoptTable(parent)).toThrow(/parziali/);
    } finally {
      db.close();
    }
  });
  it("una sola parte di una PK composta non autorizza una FK singola", () => {
    const parent: DesignTable = {
      id: "parent",
      name: "parent",
      columns: [
        { name: "a", dataType: "INTEGER", primaryKey: true, nullable: false },
        { name: "b", dataType: "INTEGER", primaryKey: true, nullable: false },
      ],
      options: structuredClone(INITIAL_DESIGNER),
    };
    const child: DesignTable = {
      id: "child",
      name: "child",
      columns: [
        { name: "a", dataType: "INTEGER", primaryKey: false, nullable: false },
      ],
      options: {
        ...structuredClone(INITIAL_DESIGNER),
        keys: [{ column: "a", table: "parent", targetColumn: "a" }],
      },
    };
    expect(() => buildProjectDdl("sqlite", [parent, child])).toThrow(
      /composta/,
    );
  });
  it("PostgreSQL usa public in modo esplicito e non scarta una tabella per omonimi in altri schemi o per routine", () => {
    const table = project()[1];
    const other: TableInfo = {
      name: "customers",
      schema: "archive",
      kind: "table",
      columns: table.columns,
      indexes: [],
      foreignKeys: [],
    };
    const routine: TableInfo = {
      ...other,
      schema: "public",
      kind: "function",
      columns: [],
    };
    const schema = {
      engine: "postgresql" as const,
      database: "test",
      tables: [other, routine],
    };
    const plan = buildCreationPlan("postgresql", [table], schema);
    expect(plan.pendingTables).toHaveLength(1);
    expect(plan.sql).toContain("SET search_path TO public;");
    expect(designSnapshot("postgresql", [table]).tables[0].schema).toBe(
      "public",
    );
    expect(
      buildCreationPlan("postgresql", [table], {
        ...schema,
        tables: [{ ...other, schema: "public" }],
      }).pendingTables,
    ).toHaveLength(0);
  });
  it("matching nomi: SQLite è insensibile al caso, PostgreSQL quotato è sensibile, MySQL ambiguo viene bloccato", () => {
    const table = project()[1],
      existing: TableInfo = {
        name: "CUSTOMERS",
        kind: "table",
        columns: table.columns,
        indexes: [],
        foreignKeys: [],
      };
    expect(
      buildCreationPlan("sqlite", [table], {
        engine: "sqlite",
        database: "test",
        tables: [existing],
      }).pendingTables,
    ).toHaveLength(0);
    expect(
      buildCreationPlan("postgresql", [table], {
        engine: "postgresql",
        database: "test",
        tables: [{ ...existing, schema: "public" }],
      }).pendingTables,
    ).toHaveLength(1);
    expect(() =>
      buildCreationPlan("mysql", [table], {
        engine: "mysql",
        database: "test",
        tables: [existing],
      }),
    ).toThrow(/maiuscole/);
  });
  it("trigger omonimi non impediscono una nuova tabella, mentre una collezione campionata Mongo esistente non viene ricreata", () => {
    const table = project()[1];
    const trigger: TableInfo = {
      name: table.name,
      kind: "trigger",
      columns: [],
      indexes: [],
      foreignKeys: [],
    };
    expect(
      buildCreationPlan("sqlite", [table], {
        engine: "sqlite",
        database: "test",
        tables: [trigger],
      }).pendingTables,
    ).toHaveLength(1);
    expect(
      buildCreationPlan("mongodb", [table], {
        engine: "mongodb",
        database: "test",
        tables: [
          {
            ...trigger,
            kind: "collection (schema campionato: max 20 documenti)",
          },
        ],
      }).pendingTables,
    ).toHaveLength(0);
  });
  it("la copia visuale rifiuta FK composte ed indici su espressioni anziché perderne la semantica", () => {
    const table: TableInfo = {
      name: "child",
      kind: "table",
      columns: [
        { name: "a", dataType: "INTEGER", nullable: false, primaryKey: false },
        { name: "b", dataType: "INTEGER", nullable: false, primaryKey: false },
      ],
      indexes: [],
      foreignKeys: [
        {
          columns: ["a", "b"],
          referencedTable: "parent",
          referencedColumns: ["a", "b"],
        },
      ],
    };
    expect(() => adoptTable(table)).toThrow(/composte/);
    expect(() =>
      adoptTable({
        ...table,
        foreignKeys: [],
        indexes: [{ name: "expression", unique: true, columns: ["lower(a)"] }],
      }),
    ).toThrow(/espressioni/);
  });
});
describe("designer MongoDB: comandi JSON e vincoli", () => {
  it("produce validatori, nullabilità e indici senza trasformare documenti in SQL", () => {
    const table: DesignTable = {
      id: "mongo",
      name: "people",
      columns: [
        {
          name: "_id",
          dataType: "objectId",
          nullable: false,
          primaryKey: true,
        },
        {
          name: "email",
          dataType: "string",
          nullable: false,
          primaryKey: false,
        },
        {
          name: "score",
          dataType: "decimal",
          nullable: true,
          primaryKey: false,
        },
      ],
      options: {
        ...structuredClone(INITIAL_DESIGNER),
        indexes: [{ name: "idx_email", columns: "email", unique: true }],
      },
    };
    const commands = JSON.parse(buildProjectDdl("mongodb", [table]));
    expect(Array.isArray(commands)).toBe(true);
    expect(commands[0]).toMatchObject({
      create: "people",
      validator: {
        $jsonSchema: {
          required: ["email"],
          properties: { score: { bsonType: ["decimal", "null"] } },
        },
      },
    });
    expect(commands[1]).toMatchObject({
      createIndexes: "people",
      indexes: [{ name: "idx_email", key: { email: 1 }, unique: true }],
    });
  });
  it("il vincolo Univoco scelto per un campo Mongo genera un indice univoco reale nel comando", () => {
    const table: DesignTable = {
      id: "mongo-unique",
      name: "contacts",
      columns: [
        {
          name: "_id",
          dataType: "objectId",
          nullable: false,
          primaryKey: true,
        },
        {
          name: "email",
          dataType: "string",
          nullable: false,
          primaryKey: false,
          unique: true,
        },
      ],
      options: structuredClone(INITIAL_DESIGNER),
    };
    const value = JSON.parse(buildTableDdl("mongodb", table));
    const commands = Array.isArray(value) ? value : [value];
    const indexes = commands.flatMap((command) => command.indexes || []);
    expect(
      indexes.some((index) => index.unique === true && index.key?.email === 1),
    ).toBe(true);
  });
});
