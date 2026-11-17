import type {
  ColumnInfo,
  Engine,
  ObjectRef,
  SchemaSnapshot,
  TableInfo,
} from "../types";
import { objectKey } from "../utils";
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
export interface DesignTable extends ObjectRef {
  source?: TableInfo;
  position?: { x: number; y: number };
  id: string;
  columns: DesignColumn[];
  options: DesignerOptions;
  createSchema?: boolean;
  mongo?: {
    validate: boolean;
    validationLevel?: string;
    validationAction?: string;
  };
}

export interface DesignProject {
  engine: Engine;
  tables: DesignTable[];
}

export function isEditableDesignObject(table: Pick<TableInfo, "kind">) {
  return /^(table|partitioned table|collection(?: \(schema campionato[^)]*\))?)$/i.test(
    table.kind,
  );
}

export function readDesignProject(value: unknown): DesignProject {
  if (!value || typeof value !== "object")
    throw new Error("Formato progetto non valido.");
  const candidate = value as Partial<DesignProject> & { version?: number };
  const { engine, tables } = candidate;
  if (
    (candidate.version !== undefined && candidate.version !== 1) ||
    !engine ||
    !Object.hasOwn(TYPE_CHOICES, engine) ||
    !Array.isArray(tables) ||
    !tables.length ||
    tables.length > 100
  )
    throw new Error("Formato progetto non valido.");

  for (const table of tables) {
    if (
      typeof table?.name !== "string" ||
      (table.schema !== undefined && typeof table.schema !== "string") ||
      (table.createSchema !== undefined &&
        typeof table.createSchema !== "boolean") ||
      !Array.isArray(table.columns) ||
      table.columns.length > 500 ||
      !table.columns.every(
        (column) =>
          typeof column?.name === "string" &&
          typeof column.dataType === "string" &&
          (column.defaultValue == null ||
            typeof column.defaultValue === "string"),
      ) ||
      !Array.isArray(table.options?.keys) ||
      !table.options.keys.every(
        (key) =>
          typeof key?.column === "string" &&
          typeof key.table === "string" &&
          typeof key.targetColumn === "string" &&
          (key.targetSchema === undefined ||
            typeof key.targetSchema === "string"),
      ) ||
      !Array.isArray(table.options?.indexes) ||
      !table.options.indexes.every(
        (index) =>
          typeof index?.name === "string" &&
          typeof index.columns === "string" &&
          typeof index.unique === "boolean",
      ) ||
      typeof table.options.validator !== "string" ||
      (table.source &&
        (typeof table.source.name !== "string" ||
          !Array.isArray(table.source.columns) ||
          !Array.isArray(table.source.foreignKeys) ||
          !Array.isArray(table.source.indexes)))
    )
      throw new Error("Una struttura del progetto non è valida.");
  }
  const ids = new Set<string>();
  return {
    engine,
    tables: tables.map((table) => {
      const id =
        typeof table.id === "string" && table.id && !ids.has(table.id)
          ? table.id
          : crypto.randomUUID();
      ids.add(id);
      const position =
        table.position &&
        Number.isFinite(table.position.x) &&
        Number.isFinite(table.position.y)
          ? table.position
          : undefined;
      return { ...table, id, position };
    }),
  };
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
    "timestamp",
    "regex",
    "null",
    "any",
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

export function linkedDesignTemplate(engine: Engine): DesignTable[] {
  const contacts = newDesignTable(engine);
  const notes = newDesignTable(engine, 2);
  contacts.name = "contatti";
  notes.name = "note";
  const reference = engine === "mongodb" ? "contattoId" : "contatto_id";
  const contactId = contacts.columns[0];
  notes.columns[1].name = "testo";
  notes.columns.push({
    name: reference,
    dataType: contactId.dataType,
    primaryKey: false,
    nullable: false,
  });
  notes.options.keys.push({
    column: reference,
    table: contacts.name,
    targetColumn: contactId.name,
  });
  notes.options.indexes.push({
    name: "idx_note_contatto",
    columns: reference,
    unique: false,
  });
  return [contacts, notes];
}
function validateName(name: string, label: string) {
  if (!name.trim() || name.length > 128 || /[\u0000-\u001f]/.test(name))
    throw new Error(
      `${label}: inserisci un nome valido (massimo 128 caratteri).`,
    );
}
function equalIdentifier(engine: Engine, left: string, right: string): boolean {
  return identifierKey(engine, left) === identifierKey(engine, right);
}
export function identifierKey(engine: Engine, name: string): string {
  return engine === "sqlite" || engine === "mysql" || engine === "mariadb"
    ? name.toLowerCase()
    : name;
}
export function designObject(engine: Engine, object: ObjectRef): ObjectRef {
  return engine === "postgresql"
    ? { name: object.name, schema: object.schema || "public" }
    : { name: object.name };
}
export function designObjectKey(engine: Engine, object: ObjectRef): string {
  const normalized = designObject(engine, object);
  return objectKey({
    ...normalized,
    name: identifierKey(engine, normalized.name),
  });
}
export function designReference(
  engine: Engine,
  owner: ObjectRef,
  key: DesignerOptions["keys"][number],
): ObjectRef {
  return designObject(engine, {
    name: key.table,
    schema: key.targetSchema || owner.schema,
  });
}
export function qualifiedDesignObject(
  engine: Engine,
  table: ObjectRef,
): string {
  const object = designObject(engine, table);
  const quote = (name: string) => quoteIdentifier(name, engine);
  return object.schema
    ? `${quote(object.schema)}.${quote(object.name)}`
    : quote(object.name);
}
export function checkDesignReferenceTarget(
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
  if (engine === "postgresql" && table.schema !== undefined)
    validateName(table.schema, "Schema");
  if (!table.columns.length && engine !== "mongodb")
    throw new Error("Aggiungi almeno una colonna.");
  const names = new Set<string>();
  for (const c of table.columns) {
    validateName(c.name, "Colonna");
    const normalized = identifierKey(engine, c.name);
    if (names.has(normalized)) throw new Error(`Colonna duplicata: ${c.name}`);
    names.add(normalized);
    if (!c.dataType.trim() || /[^\w\s(),\[\]]/.test(c.dataType))
      throw new Error(`Tipo non valido per ${c.name}`);
    if (
      c.defaultValue &&
      /[;]|--|\/\*/.test(c.defaultValue) &&
      !/^'(?:[^'\\]|'')*'$/.test(c.defaultValue)
    )
      throw new Error(`Valore predefinito non valido per ${c.name}`);
  }
  if (engine === "mongodb") {
    const required = table.columns
      .filter((c) => !c.nullable && c.name !== "_id")
      .map((c) => c.name);
    const properties = Object.fromEntries(
      table.columns.map((c) => [
        c.name,
        c.dataType === "any"
          ? {}
          : {
              bsonType:
                c.nullable && c.dataType !== "null"
                  ? [c.dataType, "null"]
                  : c.dataType,
            },
      ]),
    );
    const validator =
      table.mongo?.validate === false
        ? {}
        : table.options.customValidator
          ? JSON.parse(table.options.validator)
          : { $jsonSchema: { bsonType: "object", required, properties } };
    if (!validator || typeof validator !== "object" || Array.isArray(validator))
      throw new Error("Il validatore MongoDB deve essere un oggetto JSON.");
    if (
      table.mongo?.validationLevel &&
      !["off", "strict", "moderate"].includes(table.mongo.validationLevel)
    )
      throw new Error("Livello di convalida MongoDB non valido.");
    if (
      table.mongo?.validationAction &&
      !["error", "warn", "errorAndLog"].includes(table.mongo.validationAction)
    )
      throw new Error("Azione di convalida MongoDB non valida.");
    if (table.mongo?.validate !== false && !table.options.customValidator)
      for (const column of table.columns)
        if (!TYPE_CHOICES.mongodb.includes(column.dataType))
          throw new Error(`Tipo BSON non rappresentabile per ${column.name}.`);
    const commands: Record<string, unknown>[] = [
      {
        create: table.name,
        ...(table.mongo?.validate !== false
          ? {
              validator,
              validationLevel: table.mongo?.validationLevel || "strict",
              ...(table.mongo?.validationAction
                ? { validationAction: table.mongo.validationAction }
                : {}),
            }
          : {}),
      },
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
    if (new Set(indexes.map((index) => index.name)).size !== indexes.length)
      throw new Error("I nomi degli indici MongoDB devono essere distinti.");
    if (indexes.length)
      commands.push({
        createIndexes: table.name,
        indexes: indexes.map((i) => {
          const fields = i.columns.split(",").map((name) => name.trim());
          if (!i.name.trim() || fields.some((name) => !name))
            throw new Error("Specifica nome e campi per ogni indice MongoDB.");
          if (new Set(fields).size !== fields.length)
            throw new Error(`L’indice ${i.name} contiene campi duplicati.`);
          return {
            name: i.name,
            key: Object.fromEntries(fields.map((name) => [name, 1])),
            unique: i.unique,
          };
        }),
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
  let ddl = `CREATE TABLE ${qualifiedDesignObject(engine, table)} (\n  ${defs.join(",\n  ")}\n);`;
  ddl = extendDdl(
    ddl,
    engine,
    table.name,
    table.columns,
    table.options,
    designObject(engine, table).schema,
  );
  return ddl;
}
export function buildProjectDdl(engine: Engine, tables: DesignTable[]): string {
  const names = new Set<string>();
  for (const t of tables) {
    const normalized = designObjectKey(engine, t);
    if (names.has(normalized)) throw new Error(`Tabella duplicata: ${t.name}`);
    names.add(normalized);
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
      validateName(key.table, "Tabella collegata");
      validateName(key.targetColumn, "Campo collegato");
      if (
        !table.columns.some((column) =>
          equalIdentifier(engine, column.name, key.column),
        )
      )
        throw new Error(
          `Campo origine della relazione inesistente: ${table.name}.${key.column}`,
        );
      if (engine === "postgresql" && key.targetSchema !== undefined)
        validateName(key.targetSchema, "Schema collegato");
      const reference = designReference(engine, table, key);
      const target = tables.find(
        (target) =>
          designObjectKey(engine, target) ===
          designObjectKey(engine, reference),
      );
      if (target) checkDesignReferenceTarget(engine, target, key.targetColumn);
    }
  // Referenced tables precede children. Cycles stay visible and require review.
  const pending = [...tables],
    ordered: DesignTable[] = [];
  while (pending.length) {
    const i = pending.findIndex((t) =>
      t.options.keys.every(
        (k) =>
          !pending.some(
            (p) =>
              designObjectKey(engine, p) ===
                designObjectKey(engine, designReference(engine, t, k)) &&
              p.id !== t.id,
          ),
      ),
    );
    if (i < 0) {
      ordered.push(...pending);
      break;
    }
    ordered.push(...pending.splice(i, 1));
  }
  const q = (n: string) => quoteIdentifier(n, engine);
  const schemaDdl =
    engine === "postgresql"
      ? [
          ...new Set(
            ordered
              .filter((table) => table.createSchema)
              .map((table) => designObject(engine, table).schema!),
          ),
        ]
          .map((schema) => `CREATE SCHEMA IF NOT EXISTS ${q(schema)};\n\n`)
          .join("")
      : "";
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
                `ALTER TABLE ${qualifiedDesignObject(engine, t)} ADD FOREIGN KEY (${q(k.column)}) REFERENCES ${qualifiedDesignObject(engine, designReference(engine, t, k))} (${q(k.targetColumn)});`,
            ),
          )
          .join("\n");
  return `-- Progetto Database Manager · ${engine}\n-- Rivedere il codice prima dell’applicazione.\n\n${schemaDdl}${ddl}\n${relations}`;
}

export interface CreationPlan {
  pendingTables: DesignTable[];
  sql: string;
}

export function inDesignNamespace(schema: SchemaSnapshot, table: TableInfo) {
  if (!table.schema) return true;
  if (schema.engine === "postgresql") return true;
  if (schema.engine === "sqlite") return table.schema === "main";
  if (schema.engine === "mysql" || schema.engine === "mariadb")
    return !schema.database || table.schema === schema.database;
  return true;
}
/** Existing, qualified database metadata takes
 * precedence over edited project copies which are intentionally not re-created. */
export function buildCreationPlan(
  engine: Engine,
  tables: DesignTable[],
  schema: SchemaSnapshot | null,
): CreationPlan {
  const sameEngine = schema?.engine === engine ? schema : null;
  const relationKind = (table: TableInfo) =>
    /^(table|view|collection|materialized view|partitioned table)(?:\b|$)/i.test(
      table.kind,
    );
  const existing =
    sameEngine?.tables.filter(
      (table) => relationKind(table) && inDesignNamespace(sameEngine, table),
    ) || [];
  function findExisting(object: ObjectRef): TableInfo | undefined {
    const { name } = object;
    const matches = existing.filter(
      (table) =>
        designObjectKey(engine, table) === designObjectKey(engine, object),
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
    const normalized = designObjectKey(engine, table);
    if (names.has(normalized))
      throw new Error(`Tabella duplicata: ${table.name}`);
    names.add(normalized);
  }
  const pendingTables = tables.filter((table) => !findExisting(table));
  if (engine === "postgresql" && sameEngine?.namespaces) {
    const available = new Set(sameEngine.namespaces);
    for (const pending of pendingTables) {
      const namespace = designObject(engine, pending).schema!;
      if (pending.createSchema) available.add(namespace);
    }
    for (const pending of pendingTables) {
      const namespace = designObject(engine, pending).schema!;
      if (!available.has(namespace))
        throw new Error(
          `Lo schema ${namespace} non esiste. Seleziona Crea schema se manca o scegli uno schema esistente.`,
        );
    }
  }
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
        const reference = designReference(engine, table, key);
        const pending = pendingTables.find(
          (target) =>
            designObjectKey(engine, target) ===
            designObjectKey(engine, reference),
        );
        if (pending) {
          checkDesignReferenceTarget(engine, pending, key.targetColumn);
          continue;
        }
        const target = findExisting(reference);
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
      ? buildProjectDdl(
          engine,
          pendingTables.map((table) =>
            table.createSchema &&
            sameEngine?.namespaces?.includes(
              designObject(engine, table).schema!,
            )
              ? { ...table, createSchema: false }
              : table,
          ),
        )
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
      ...designObject(engine, t),
      kind: engine === "mongodb" ? "collection" : "table",
      columns: t.columns.map((c) => ({
        ...c,
        nullable: c.primaryKey ? false : c.nullable,
        identity:
          engine === "mongodb"
            ? c.name === "_id"
            : !!c.autoIncrement ||
              /\b(?:SMALLSERIAL|SERIAL|BIGSERIAL)\b/i.test(c.dataType),
      })),
      indexes: t.options.indexes.map((i) => ({
        ...i,
        columns: i.columns.split(",").map((s) => s.trim()),
      })),
      foreignKeys: t.options.keys.map((k) => ({
        column: k.column,
        referencedTable: k.table,
        referencedSchema: designReference(engine, t, k).schema,
        referencedColumn: k.targetColumn,
      })),
      definition: buildTableDdl(engine, t),
    })),
  };
}
const MONGO_TYPES: Record<string, string> = {
  double: "double",
  string: "string",
  embeddeddocument: "object",
  document: "object",
  object: "object",
  array: "array",
  binary: "binData",
  bindata: "binData",
  objectid: "objectId",
  boolean: "bool",
  bool: "bool",
  datetime: "date",
  date: "date",
  null: "null",
  int32: "int",
  int: "int",
  int64: "long",
  long: "long",
  decimal128: "decimal",
  decimal: "decimal",
  timestamp: "timestamp",
  regularexpression: "regex",
  regex: "regex",
};

export function adoptMongoTable(source: TableInfo): DesignTable {
  const validator = source.mongo?.validator;
  const hasValidator = !!validator && Object.keys(validator).length > 0;
  const declaredColumns = new Map(
    mongoValidatorColumns(validator).map((column) => [column.name, column]),
  );
  for (const column of source.columns) {
    if (!declaredColumns.has(column.name))
      declaredColumns.set(column.name, {
        ...column,
        dataType: MONGO_TYPES[column.dataType.toLowerCase()] || "any",
      });
  }
  return {
    id: crypto.randomUUID(),
    name: source.name,
    columns: [...declaredColumns.values()],
    options: {
      ...structuredClone(INITIAL_DESIGNER),
      indexes: source.indexes
        .filter(
          (index) =>
            index.name !== "_id_" &&
            index.mongoEditable === true &&
            index.columns.every((column) => !column.includes(",")),
        )
        .map((index) => ({
          name: index.name,
          columns: index.columns.join(", "),
          unique: !!index.unique,
        })),
      ...(hasValidator
        ? {
            customValidator: true,
            validator: JSON.stringify(validator, null, 2),
          }
        : {}),
    },
    mongo: {
      validate: hasValidator,
      validationLevel: source.mongo?.validationLevel,
      validationAction: source.mongo?.validationAction,
    },
  };
}

export function mongoValidatorColumns(
  validator: Record<string, unknown> | undefined,
): DesignColumn[] {
  const schema = validator?.$jsonSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const { properties, required } = schema as Record<string, unknown>;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return [];
  return Object.entries(properties).map(([name, field]) => {
    const bsonType = field?.bsonType;
    const candidate = Array.isArray(bsonType)
      ? bsonType.filter((type) => type !== "null")
      : [bsonType];
    const dataType =
      candidate.length === 1 && typeof candidate[0] === "string"
        ? candidate[0]
        : "any";
    return {
      name,
      dataType,
      nullable:
        !(Array.isArray(required) && required.includes(name)) && name !== "_id",
      primaryKey: name === "_id",
    };
  });
}

export function adoptTable(t: TableInfo, engine?: Engine): DesignTable {
  if (engine === "mongodb" || /^collection\b/i.test(t.kind))
    return adoptMongoTable(t);
  if (t.columns.some((column) => column.generated))
    throw new Error(
      "Le colonne calcolate richiedono la definizione SQL originale.",
    );
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
    t.foreignKeys.some(
      (key) =>
        (engine !== "postgresql" &&
          key.referencedSchema &&
          key.referencedSchema !== t.schema) ||
        [key.onUpdate, key.onDelete].some(
          (action) =>
            action &&
            action.toUpperCase() !== "NO ACTION" &&
            !(
              action.toUpperCase() === "RESTRICT" &&
              (engine === "mysql" || engine === "mariadb")
            ),
        ),
    )
  )
    throw new Error(
      "La copia visuale di FK tra schemi o con azioni avanzate richiede la definizione SQL originale.",
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
    ...(engine === "postgresql" ? { schema: t.schema || "public" } : {}),
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
        targetSchema:
          engine === "postgresql"
            ? k.referencedSchema || t.schema || "public"
            : undefined,
      })),
    },
  };
}
