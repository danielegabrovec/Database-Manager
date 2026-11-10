import type { ColumnInfo, Engine, SchemaSnapshot, TableInfo } from "../types";
import {
  quoteIdentifier,
  extendDdl,
  INITIAL_DESIGNER,
  type DesignerOptions,
} from "../components/SchemaBuilders";

export interface DesignColumn extends ColumnInfo {
  sourceName?: string;
  unique?: boolean;
  autoIncrement?: boolean;
}
export interface DesignTable {
  source?: TableInfo;
  position?: { x: number; y: number };
  id: string;
  name: string;
  columns: DesignColumn[];
  options: DesignerOptions;
}
export const TYPE_CHOICES: Record<Engine, string[]> = {
  sqlite: [
    "INTEGER",
    "TEXT",
    "REAL",
    "NUMERIC",
    "BLOB",
    "BOOLEAN",
    "DATE",
    "DATETIME",
    "JSON",
  ],
  postgresql: [
    "INTEGER",
    "BIGINT",
    "TEXT",
    "VARCHAR(255)",
    "NUMERIC(12,2)",
    "BOOLEAN",
    "DATE",
    "TIMESTAMPTZ",
    "JSONB",
    "UUID",
    "BYTEA",
  ],
  mysql: [
    "INT",
    "BIGINT",
    "VARCHAR(255)",
    "TEXT",
    "DECIMAL(12,2)",
    "DOUBLE",
    "BOOLEAN",
    "DATE",
    "DATETIME",
    "JSON",
    "LONGBLOB",
  ],
  mariadb: [
    "INT",
    "BIGINT",
    "VARCHAR(255)",
    "TEXT",
    "DECIMAL(12,2)",
    "DOUBLE",
    "BOOLEAN",
    "DATE",
    "DATETIME",
    "JSON",
    "LONGBLOB",
  ],
  mongodb: [
    "objectId",
    "string",
    "int",
    "long",
    "double",
    "decimal",
    "bool",
    "date",
    "object",
    "array",
    "binData",
  ],
};
export function newDesignTable(engine: Engine, index = 1): DesignTable {
  return {
    id: crypto.randomUUID(),
    name: index === 1 ? "nuova_tabella" : `tabella_${index}`,
    columns: [
      {
        name: engine === "mongodb" ? "_id" : "id",
        dataType:
          engine === "mongodb"
            ? "objectId"
            : engine === "mysql" || engine === "mariadb"
              ? "INT"
              : "INTEGER",
        primaryKey: true,
        nullable: false,
        autoIncrement: engine !== "mongodb",
      },
      {
        name: "nome",
        dataType: engine === "mongodb" ? "string" : "TEXT",
        primaryKey: false,
        nullable: false,
      },
    ],
    options: structuredClone(INITIAL_DESIGNER),
  };
}
function validateName(name: string, label: string) {
  if (!name.trim() || name.length > 128 || /[\u0000-\u001f]/.test(name))
    throw new Error(
      `${label}: inserisci un nome valido (massimo 128 caratteri).`,
    );
}
function equalIdentifier(engine: Engine, left: string, right: string): boolean {
  return engine === "sqlite" || engine === "mysql" || engine === "mariadb"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
function projectReferenceTarget(
  engine: Engine,
  target: DesignTable,
  columnName: string,
): void {
  const column = target.columns.find((column) =>
    equalIdentifier(engine, column.name, columnName),
  );
  if (!column)
    throw new Error(
      `Campo destinazione inesistente: ${target.name}.${columnName}`,
    );
  const primary = target.columns.filter((column) => column.primaryKey);
  const unique =
    (column.primaryKey && primary.length === 1) ||
    !!column.unique ||
    target.options.indexes.some(
      (index) =>
        index.unique &&
        index.columns.split(",").map((name) => name.trim()).length === 1 &&
        equalIdentifier(engine, index.columns.trim(), column.name),
    );
  if (!unique)
    throw new Error(
      `La relazione verso ${target.name}.${column.name} richiede una chiave primaria singola o un vincolo UNIQUE singolo. Una parte di chiave composta non basta.`,
    );
}
export function buildTableDdl(engine: Engine, table: DesignTable): string {
  validateName(table.name, "Tabella");
  if (!table.columns.length) throw new Error("Aggiungi almeno una colonna.");
  const names = new Set<string>();
  for (const c of table.columns) {
    validateName(c.name, "Colonna");
    if (names.has(c.name.toLowerCase()))
      throw new Error(`Colonna duplicata: ${c.name}`);
    names.add(c.name.toLowerCase());
    if (!c.dataType.trim() || /[^\w\s(),\[\]]/.test(c.dataType))
      throw new Error(`Tipo non valido per ${c.name}`);
    if (c.defaultValue && /[;]|--|\/\*/.test(c.defaultValue))
      throw new Error(`Valore predefinito non valido per ${c.name}`);
  }
  if (engine === "mongodb") {
    const required = table.columns
      .filter((c) => !c.nullable && c.name !== "_id")
      .map((c) => c.name);
    const properties = Object.fromEntries(
      table.columns.map((c) => [
        c.name,
        { bsonType: c.nullable ? [c.dataType, "null"] : c.dataType },
      ]),
    );
    const validator = table.options.customValidator
      ? JSON.parse(table.options.validator)
      : { $jsonSchema: { bsonType: "object", required, properties } };
    const commands: Record<string, unknown>[] = [
      { create: table.name, validator, validationLevel: "strict" },
    ];
    const indexes = [
      ...table.options.indexes,
      ...table.columns
        .filter((c) => c.unique && !c.primaryKey)
        .map((c) => ({
          name: "uq_" + table.name + "_" + c.name,
          columns: c.name,
          unique: true,
        })),
    ];
    if (indexes.length)
      commands.push({
        createIndexes: table.name,
        indexes: indexes.map((i) => ({
          name: i.name,
          key: Object.fromEntries(
            i.columns.split(",").map((s) => [s.trim(), 1]),
          ),
          unique: i.unique,
        })),
      });
    return JSON.stringify(
      commands.length === 1 ? commands[0] : commands,
      null,
      2,
    );
  }
  for (const key of table.options.keys) {
    if (!table.columns.some((c) => c.name === key.column))
      throw new Error(
        `Campo origine della relazione inesistente: ${key.column}`,
      );
  }
  const q = (s: string) => quoteIdentifier(s, engine);
  const primary = table.columns.filter((c) => c.primaryKey);
  const auto = table.columns.filter((c) => c.autoIncrement);
  if (auto.length > 1)
    throw new Error("È ammessa una sola colonna con identità automatica.");
  if (
    auto.some(
      (c) =>
        !c.primaryKey ||
        !["INTEGER", "INT", "BIGINT"].includes(c.dataType.toUpperCase()),
    )
  )
    throw new Error("L’identità automatica richiede una chiave intera.");
  if (
    engine === "sqlite" &&
    auto.length &&
    (primary.length !== 1 || auto[0].dataType.toUpperCase() !== "INTEGER")
  )
    throw new Error(
      "SQLite: AUTOINCREMENT richiede una singola chiave INTEGER.",
    );
  const defs = table.columns.map((c) => {
    let text = `${q(c.name)} ${c.dataType}`;
    if (c.autoIncrement && engine === "sqlite")
      return `${text} PRIMARY KEY AUTOINCREMENT`;
    if (c.autoIncrement && engine === "postgresql")
      text += " GENERATED BY DEFAULT AS IDENTITY";
    if (!c.nullable || c.primaryKey) text += " NOT NULL";
    if (c.autoIncrement && (engine === "mysql" || engine === "mariadb"))
      text += " AUTO_INCREMENT";
    if (c.unique && !c.primaryKey) text += " UNIQUE";
    if (c.defaultValue && !c.autoIncrement)
      text += ` DEFAULT ${c.defaultValue}`;
    return text;
  });
  if (primary.length && !(engine === "sqlite" && auto.length))
    defs.push(`PRIMARY KEY (${primary.map((c) => q(c.name)).join(", ")})`);
  let ddl = `CREATE TABLE ${q(table.name)} (\n  ${defs.join(",\n  ")}\n);`;
  ddl = extendDdl(ddl, engine, table.name, table.columns, table.options);
  return ddl;
}
export function buildProjectDdl(engine: Engine, tables: DesignTable[]): string {
  const names = new Set<string>();
  for (const t of tables) {
    if (names.has(t.name.toLowerCase()))
      throw new Error(`Tabella duplicata: ${t.name}`);
    names.add(t.name.toLowerCase());
  }
  if (engine === "mongodb") {
    const commands = tables.flatMap((t) => {
      const v = JSON.parse(buildTableDdl(engine, t));
      return Array.isArray(v) ? v : [v];
    });
    return JSON.stringify(
      commands.length === 1 ? commands[0] : commands,
      null,
      2,
    );
  }
  for (const table of tables)
    for (const key of table.options.keys) {
      const target = tables.find((target) =>
        equalIdentifier(engine, target.name, key.table),
      );
      if (target) projectReferenceTarget(engine, target, key.targetColumn);
    }
  // Referenced tables precede children. Cycles stay visible and require review.
  const pending = [...tables],
    ordered: DesignTable[] = [];
  while (pending.length) {
    const i = pending.findIndex((t) =>
      t.options.keys.every(
        (k) => !pending.some((p) => p.name === k.table && p.id !== t.id),
      ),
    );
    if (i < 0) {
      ordered.push(...pending);
      break;
    }
    ordered.push(...pending.splice(i, 1));
  }
  const q = (n: string) => quoteIdentifier(n, engine);
  for (const t of ordered)
    for (const k of t.options.keys) {
      const target = ordered.find((v) => v.name === k.table);
      if (target && !target.columns.some((c) => c.name === k.targetColumn))
        throw new Error(
          `Campo destinazione inesistente: ${k.table}.${k.targetColumn}`,
        );
    }
  const ddl = ordered
    .map((t) =>
      buildTableDdl(
        engine,
        engine === "sqlite" ? t : { ...t, options: { ...t.options, keys: [] } },
      ),
    )
    .join("\n\n");
  const relations =
    engine === "sqlite"
      ? ""
      : ordered
          .flatMap((t) =>
            t.options.keys.map(
              (k) =>
                `ALTER TABLE ${q(t.name)} ADD FOREIGN KEY (${q(k.column)}) REFERENCES ${q(k.table)} (${q(k.targetColumn)});`,
            ),
          )
          .join("\n");
  return `-- Progetto Database Manager · ${engine}\n-- Rivedere il codice prima dell’applicazione.\n\n${engine === "postgresql" ? "SET search_path TO public;\n\n" : ""}${ddl}\n${relations}`;
}

export interface CreationPlan {
  pendingTables: DesignTable[];
  sql: string;
}
/** The designer creates PostgreSQL relations in public; other namespaces never
 * turn a pending public table into an existing one. Existing DB metadata takes
 * precedence over edited project copies which are intentionally not re-created. */
export function buildCreationPlan(
  engine: Engine,
  tables: DesignTable[],
  schema: SchemaSnapshot | null,
): CreationPlan {
  const sameEngine = schema?.engine === engine ? schema : null;
  const inTargetNamespace = (table: TableInfo) =>
    engine === "postgresql"
      ? !table.schema || table.schema === "public"
      : engine === "sqlite"
        ? !table.schema || table.schema === "main"
        : engine === "mysql" || engine === "mariadb"
          ? !table.schema ||
            !sameEngine?.database ||
            table.schema === sameEngine.database
          : true;
  const relationKind = (table: TableInfo) =>
    /^(table|view|collection|materialized view|partitioned table)(?:\b|$)/i.test(
      table.kind,
    );
  const existing = (sameEngine?.tables || []).filter(
    (table) => relationKind(table) && inTargetNamespace(table),
  );
  function findExisting(name: string): TableInfo | undefined {
    const matches = existing.filter((table) =>
      equalIdentifier(engine, table.name, name),
    );
    if (
      (engine === "mysql" || engine === "mariadb") &&
      matches.some((table) => table.name !== name)
    )
      throw new Error(
        `Il nome ${name} coincide con una struttura esistente con maiuscole diverse. Verifica la sensibilità ai nomi del server prima di creare la tabella.`,
      );
    if (matches.length > 1)
      throw new Error(
        `Metadati ambigui per ${name}: aggiorna lo schema prima di creare strutture.`,
      );
    return matches[0];
  }
  const names = new Set<string>();
  for (const table of tables) {
    validateName(table.name, "Tabella");
    const normalized = table.name.toLowerCase();
    if (names.has(normalized))
      throw new Error(`Tabella duplicata: ${table.name}`);
    names.add(normalized);
  }
  const pendingTables = tables.filter((table) => !findExisting(table.name));
  if (engine !== "mongodb")
    for (const table of pendingTables)
      for (const key of table.options.keys) {
        if (
          !table.columns.some((column) =>
            equalIdentifier(engine, column.name, key.column),
          )
        )
          throw new Error(
            `Campo origine della relazione inesistente: ${table.name}.${key.column}`,
          );
        const pending = pendingTables.find((target) =>
          equalIdentifier(engine, target.name, key.table),
        );
        if (pending) {
          projectReferenceTarget(engine, pending, key.targetColumn);
          continue;
        }
        const target = findExisting(key.table);
        if (!target)
          throw new Error(
            `La relazione ${table.name}.${key.column} riferisce ${key.table}, che non è nel progetto da creare né nello schema effettivo della destinazione.`,
          );
        if (!/^(table|partitioned table)(?:\b|$)/i.test(target.kind))
          throw new Error(
            `La relazione non può riferire ${target.name}: la destinazione deve essere una tabella, non una vista o un altro oggetto.`,
          );
        const column = target.columns.find((column) =>
          equalIdentifier(engine, column.name, key.targetColumn),
        );
        if (!column)
          throw new Error(
            `Il campo ${target.name}.${key.targetColumn} non esiste nel database di destinazione. Le modifiche alla copia di progetto di una tabella già presente non vengono applicate automaticamente.`,
          );
        const primary = target.columns.filter((column) => column.primaryKey);
        const unique =
          (column.primaryKey && primary.length === 1) ||
          target.indexes.some(
            (index) =>
              index.unique &&
              !(index as typeof index & { partial?: boolean }).partial &&
              index.columns.length === 1 &&
              equalIdentifier(engine, index.columns[0], column.name),
          );
        if (!unique)
          throw new Error(
            `La relazione verso ${target.name}.${column.name} richiede una chiave primaria singola o un indice UNIQUE completo e singolo nel database. Indici parziali e parti di chiavi composte non sono sufficienti.`,
          );
      }
  return {
    pendingTables,
    sql: pendingTables.length
      ? buildProjectDdl(engine, pendingTables)
      : "-- Le strutture del progetto sono già presenti nella destinazione.\n-- Le modifiche a strutture esistenti richiedono una migrazione esplicita.",
  };
}
export function designSnapshot(
  engine: Engine,
  tables: DesignTable[],
): SchemaSnapshot {
  return {
    engine,
    database: "Progetto visuale · non ancora applicato",
    tables: tables.map((t) => ({
      name: t.name,
      ...(engine === "postgresql" ? { schema: "public" } : {}),
      kind: engine === "mongodb" ? "collection" : "table",
      columns: t.columns.map((c) => ({
        ...c,
        nullable: c.primaryKey ? false : c.nullable,
      })),
      indexes: t.options.indexes.map((i) => ({
        ...i,
        columns: i.columns.split(",").map((s) => s.trim()),
      })),
      foreignKeys: t.options.keys.map((k) => ({
        column: k.column,
        referencedTable: k.table,
        referencedColumn: k.targetColumn,
      })),
      definition: buildTableDdl(engine, t),
    })),
  };
}
export function adoptTable(t: TableInfo): DesignTable {
  if (
    t.foreignKeys.some(
      (key) =>
        (key.columns?.length || 0) > 1 ||
        (key.referencedColumns?.length || 0) > 1,
    )
  )
    throw new Error(
      "La copia visuale delle chiavi esterne composte non è supportata: usa la definizione SQL originale per conservarne il vincolo completo.",
    );
  if (
    t.indexes.some(
      (index) => (index as typeof index & { partial?: boolean }).partial,
    )
  )
    throw new Error(
      "La copia di indici parziali richiede di conservarne la condizione. Usa la definizione SQL originale; l’indice non viene trasformato silenziosamente in un vincolo completo.",
    );
  if (
    t.indexes.some(
      (index) =>
        !index.columns.length ||
        index.columns.some(
          (name) => !t.columns.some((column) => column.name === name),
        ),
    )
  )
    throw new Error(
      "La copia visuale di indici su espressioni o con metadati incompleti non è supportata. Usa la definizione SQL originale.",
    );
  const primary = t.columns.filter((c) => c.primaryKey).map((c) => c.name);
  const uniqueColumns = new Set(
    t.indexes
      .filter((i) => i.unique && i.columns.length === 1)
      .map((i) => i.columns[0]),
  );
  const indexes = t.indexes
    .filter(
      (i) =>
        !(i.unique && i.columns.length === 1) &&
        !(
          i.unique &&
          i.columns.length === primary.length &&
          i.columns.every((c) => primary.includes(c))
        ),
    )
    .map((i, index) => ({
      name: `idx_${t.name}_copia_${index + 1}`,
      columns: i.columns.join(", "),
      unique: !!i.unique,
    }));
  return {
    id: crypto.randomUUID(),
    name: t.name,
    columns: t.columns.map((c) => ({
      ...c,
      unique: uniqueColumns.has(c.name) && !c.primaryKey,
      autoIncrement: false,
    })),
    options: {
      ...structuredClone(INITIAL_DESIGNER),
      indexes,
      keys: t.foreignKeys.map((k) => ({
        column: k.column || k.columns?.[0] || "",
        table: k.referencedTable || "",
        targetColumn: k.referencedColumn || k.referencedColumns?.[0] || "",
      })),
    },
  };
}
