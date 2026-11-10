import type { Engine, SchemaSnapshot, TableInfo } from "../types";
import { quoteIdentifier } from "../components/SchemaBuilders";
import {
  adoptTable,
  buildCreationPlan,
  buildTableDdl,
  type DesignColumn,
  type DesignTable,
} from "./schemaProject";

export interface SchemaChange {
  label: string;
  sql: string;
  destructive: boolean;
}
export interface MigrationPlan {
  changes: SchemaChange[];
  blockers: string[];
  warnings: string[];
  sql: string;
  rebuildSqlite: boolean;
}

export function editExistingTable(source: TableInfo): DesignTable {
  if (!/^(table|collection|partitioned table)$/i.test(source.kind))
    throw new Error("Seleziona una tabella o collezione modificabile.");
  const table = adoptTable(source);
  table.source = structuredClone(source);
  table.columns = table.columns.map((column) => ({
    ...column,
    sourceName: column.name,
    autoIncrement:
      column.primaryKey &&
      /\bAUTOINCREMENT\b/i.test(source.definition || "") &&
      normalType(column.dataType) === "INTEGER",
  }));
  table.options.indexes = source.indexes
    .filter(
      (index) =>
        !(
          index.unique &&
          index.columns.length === 1 &&
          table.columns.some(
            (c) => c.name === index.columns[0] && (c.primaryKey || c.unique),
          )
        ) &&
        !(
          index.unique &&
          index.columns.length ===
            source.columns.filter((column) => column.primaryKey).length &&
          index.columns.every((name) =>
            source.columns.some(
              (column) => column.primaryKey && column.name === name,
            ),
          )
        ),
    )
    .map((index, number) => ({
      name: index.name.startsWith("sqlite_autoindex_")
        ? `uq_${source.name}_composite_${number + 1}`
        : index.name,
      columns: index.columns.join(", "),
      unique: !!index.unique,
    }));
  return table;
}

function columnDefinition(engine: Engine, column: DesignColumn): string {
  // Reuse validation and dialect rules without extracting SQL with a regexp.
  buildTableDdl(engine, {
    id: "validation",
    name: "validation",
    columns: [column],
    options: { keys: [], indexes: [], validator: "{}" },
  });
  return `${quoteIdentifier(column.name, engine)} ${column.dataType}${!column.nullable ? " NOT NULL" : ""}${column.defaultValue ? ` DEFAULT ${column.defaultValue}` : ""}`;
}
const normalType = (type: string) =>
  type.trim().toUpperCase().replace(/\s+/g, " ");
const normalizedDefault = (value: string | undefined) => value?.trim() || "";
const keySignature = (key: {
  column: string;
  table: string;
  targetColumn: string;
}) => JSON.stringify([key.column, key.table, key.targetColumn]);

/** Explicit migration plan. Unsupported metadata is a blocker, never silently dropped. */
export function buildMigrationPlan(
  engine: Engine,
  tables: DesignTable[],
  schema: SchemaSnapshot | null,
): MigrationPlan {
  const changes: SchemaChange[] = [],
    blockers: string[] = [],
    warnings: string[] = [];
  let rebuildSqlite = false;
  if (!schema || schema.engine !== engine)
    return {
      changes,
      blockers: [
        "Collega il database del progetto per confrontare le modifiche.",
      ],
      warnings,
      sql: "",
      rebuildSqlite,
    };
  const q = (name: string) => quoteIdentifier(name, engine);
  const add = (label: string, sql: string, destructive = false) =>
    changes.push({ label, sql, destructive });
  const names = new Set<string>();
  for (const table of tables) {
    buildTableDdl(engine, table);
    const key = table.name.toLocaleLowerCase();
    if (names.has(key)) throw new Error(`Tabella duplicata: ${table.name}`);
    names.add(key);
  }
  const fresh = tables.filter((table) => !table.source);
  const creation = buildCreationPlan(engine, fresh, schema);
  if (creation.pendingTables.length)
    add(`Crea ${creation.pendingTables.length} nuove strutture`, creation.sql);
  for (const table of tables.filter((item) => item.source)) {
    const source = table.source!;
    const original = schema.tables.find(
      (item) => item.name === source.name && item.schema === source.schema,
    );
    if (!original) {
      blockers.push(
        `${source.name}: la struttura di origine non esiste più. Ricarica il progetto dal database.`,
      );
      continue;
    }
    const signature = (value: TableInfo) =>
      JSON.stringify({
        name: value.name,
        schema: value.schema,
        kind: value.kind,
        definition: value.definition,
        columns: value.columns,
        indexes: [...value.indexes].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
        foreignKeys: [...value.foreignKeys].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
      });
    if (signature(source) !== signature(original)) {
      blockers.push(
        `${source.name}: lo schema è cambiato rispetto alla copia del progetto. Ricarica la struttura prima di pianificare.`,
      );
      continue;
    }
    if (
      schema.engine === "postgresql" &&
      source.schema &&
      source.schema !== "public"
    ) {
      blockers.push(
        `${source.name}: il designer modifica lo schema public. Usa l’editor SQL per ${source.schema}.`,
      );
      continue;
    }
    if (
      table.name !== source.name &&
      schema.tables.some(
        (item) => item.name === table.name && item.schema === source.schema,
      )
    ) {
      blockers.push(
        `${table.name}: nome già usato da un oggetto del database.`,
      );
      continue;
    }
    const baseline = editExistingTable(source);
    const ref = (name: string) =>
      source.schema && engine !== "mongodb"
        ? `${q(source.schema)}.${q(name)}`
        : q(name);
    const renamedColumns = new Map(
      table.columns
        .filter((c) => c.sourceName)
        .map((c) => [c.sourceName!, c.name]),
    );
    const oldColumns = baseline.columns.map((c) => ({
      ...c,
      name: renamedColumns.get(c.name) || c.name,
    }));
    const deleted = baseline.columns.filter(
      (c) => !table.columns.some((next) => next.sourceName === c.name),
    );
    const added = table.columns.filter((c) => !c.sourceName);
    const changed = table.columns.filter((c) => {
      const previous = oldColumns.find(
        (old) => old.sourceName === c.sourceName,
      );
      return (
        previous &&
        (normalType(previous.dataType) !== normalType(c.dataType) ||
          previous.nullable !== c.nullable ||
          normalizedDefault(previous.defaultValue) !==
            normalizedDefault(c.defaultValue) ||
          !!previous.unique !== !!c.unique ||
          previous.primaryKey !== c.primaryKey ||
          !!previous.autoIncrement !== !!c.autoIncrement)
      );
    });
    const oldKeys = baseline.options.keys.map((k) => ({
      ...k,
      column: renamedColumns.get(k.column) || k.column,
      table: k.table === source.name ? table.name : k.table,
      targetColumn:
        k.table === source.name
          ? renamedColumns.get(k.targetColumn) || k.targetColumn
          : k.targetColumn,
    }));
    const removedKeys = oldKeys.filter(
      (key) =>
        !table.options.keys.some(
          (next) => keySignature(key) === keySignature(next),
        ),
    );
    const addedKeys = table.options.keys.filter(
      (key) => !oldKeys.some((old) => keySignature(old) === keySignature(key)),
    );
    const changedPrimary =
      changed.some(
        (c) =>
          baseline.columns.find((old) => old.sourceName === c.sourceName)
            ?.primaryKey !== c.primaryKey,
      ) ||
      added.some((c) => c.primaryKey || c.autoIncrement) ||
      deleted.some((c) => c.primaryKey);
    if (changedPrimary) {
      blockers.push(
        `${table.name}: il cambio della chiave primaria o dell’identità richiede una migrazione dedicata.`,
      );
      continue;
    }
    if (engine === "mongodb") {
      if (table.name !== source.name) {
        blockers.push(
          `${source.name}: la rinomina della collezione richiede renameCollection nell’editor con i privilegi appropriati.`,
        );
        continue;
      }
      const definition = JSON.parse(buildTableDdl(engine, table));
      const commands = Array.isArray(definition) ? definition : [definition];
      if (
        JSON.stringify(table.columns) !== JSON.stringify(baseline.columns) ||
        table.options.customValidator
      )
        add(
          `Aggiorna validatore di ${table.name}`,
          JSON.stringify({
            collMod: table.name,
            validator: commands[0].validator,
            validationLevel: "strict",
            validationAction: "error",
          }),
        );
      for (const command of commands.slice(1))
        add(`Indici di ${table.name}`, JSON.stringify(command));
      warnings.push(
        "MongoDB: il validatore si applica alle scritture successive; i documenti esistenti non vengono riscritti o convertiti.",
      );
      continue;
    }
    const needsRebuild =
      engine === "sqlite" &&
      (changed.length > 0 || removedKeys.length > 0 || addedKeys.length > 0);
    if (needsRebuild) {
      // Preserve complex objects by refusing a lossy inferred reconstruction.
      const definition = source.definition || "";
      if (
        /\b(CHECK|COLLATE|GENERATED|WITHOUT\s+ROWID|STRICT|VIRTUAL|DEFERRABLE|ON\s+(DELETE|UPDATE|CONFLICT))\b/i.test(
          definition,
        ) ||
        schema.tables.some(
          (object) => object.kind === "trigger" || object.kind === "view",
        )
      ) {
        blockers.push(
          `${source.name}: la ricostruzione coinvolge vincoli avanzati, viste o trigger. Conserva le definizioni originali e usa una migrazione SQL dedicata.`,
        );
        continue;
      }
      if (table.name !== source.name) {
        blockers.push(
          `${source.name}: applica prima le modifiche dei campi, poi la rinomina della tabella.`,
        );
        continue;
      }
      if (
        source.columns.filter((c) => c.primaryKey).length !== 1 ||
        !source.columns.some(
          (c) => c.primaryKey && normalType(c.dataType) === "INTEGER",
        )
      ) {
        blockers.push(
          `${source.name}: la ricostruzione automatica richiede una singola chiave INTEGER, per conservare anche l’identità rowid.`,
        );
        continue;
      }
      if (!table.columns.some((c) => c.sourceName)) {
        blockers.push(
          `${source.name}: la ricostruzione richiede almeno una colonna di origine.`,
        );
        continue;
      }
      const tempName = "__dbm_migrate_" + table.name;
      if (
        schema.tables.some((t) => t.name === tempName) ||
        tables.some((t) => t.name === tempName)
      ) {
        blockers.push(`${tempName}: nome temporaneo già presente.`);
        continue;
      }
      const temp: DesignTable = {
        ...table,
        name: tempName,
        options: { ...table.options, indexes: [] },
      };
      const create = buildTableDdl(engine, temp);
      const retained = table.columns.filter((c) => c.sourceName);
      const indexes = table.options.indexes.map(
        (index) =>
          `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(index.name)} ON ${q(table.name)} (${index.columns
            .split(",")
            .map((name) => q(name.trim()))
            .join(", ")});`,
      );
      add(
        `Ricostruisci ${table.name} conservando le colonne mappate`,
        `${create}\nINSERT INTO ${q(tempName)} (${retained.map((c) => q(c.name)).join(", ")}) SELECT ${retained.map((c) => q(c.sourceName!)).join(", ")} FROM ${ref(source.name)};\nDROP TABLE ${ref(source.name)};\nALTER TABLE ${q(tempName)} RENAME TO ${q(table.name)};\n${indexes.join("\n")}`,
        true,
      );
      rebuildSqlite = true;
      warnings.push(
        "SQLite: ricostruzione in transazione, controllo delle chiavi esterne prima del commit. La conversione dei valori segue le affinità SQLite; verifica i dati dopo l’applicazione.",
      );
      continue;
    }
    if (table.name !== source.name)
      add(
        `Rinomina ${source.name} → ${table.name}`,
        `ALTER TABLE ${ref(source.name)} RENAME TO ${q(table.name)};`,
      );
    for (const column of table.columns.filter(
      (c) => c.sourceName && c.sourceName !== c.name,
    )) {
      if (source.columns.some((c) => c.name === column.name)) {
        blockers.push(
          `${table.name}.${column.name}: rinomina in collisione. Applica rinomine intermedie distinte.`,
        );
        continue;
      }
      add(
        `Rinomina ${column.sourceName} → ${column.name}`,
        `ALTER TABLE ${ref(table.name)} RENAME COLUMN ${q(column.sourceName!)} TO ${q(column.name)};`,
      );
    }
    for (const column of added) {
      if (
        !column.nullable &&
        (!column.defaultValue || /^NULL$/i.test(column.defaultValue))
      ) {
        blockers.push(
          `${table.name}.${column.name}: una nuova colonna NOT NULL richiede un valore predefinito per i record esistenti.`,
        );
        continue;
      }
      if (
        engine === "sqlite" &&
        /CURRENT_(TIME|DATE|TIMESTAMP)|^\s*\(/i.test(column.defaultValue || "")
      ) {
        blockers.push(
          `${table.name}.${column.name}: SQLite ADD COLUMN richiede un default costante.`,
        );
        continue;
      }
      add(
        `Aggiungi ${table.name}.${column.name}`,
        `ALTER TABLE ${ref(table.name)} ADD COLUMN ${columnDefinition(engine, column)}${column.unique && engine !== "sqlite" ? " UNIQUE" : ""};`,
      );
      if (column.unique && engine === "sqlite")
        add(
          `Vincolo univoco su ${column.name}`,
          `CREATE UNIQUE INDEX ${q(`uq_${table.name}_${column.name}`)} ON ${q(table.name)} (${q(column.name)});`,
        );
    }
    for (const column of changed) {
      const old = oldColumns.find((c) => c.sourceName === column.sourceName)!;
      if (engine !== "postgresql") {
        blockers.push(
          `${table.name}.${column.name}: modifica di tipo/default/vincoli da revisionare nell’editor SQL con la definizione completa del server.`,
        );
        continue;
      }
      if (
        !!old.unique !== !!column.unique ||
        !!old.autoIncrement !== !!column.autoIncrement
      ) {
        blockers.push(
          `${table.name}.${column.name}: modifica dei vincoli UNIQUE/identità richiede nomi e definizioni originali.`,
        );
        continue;
      }
      if (normalType(old.dataType) !== normalType(column.dataType))
        add(
          `Tipo di ${column.name} → ${column.dataType}`,
          `ALTER TABLE ${ref(table.name)} ALTER COLUMN ${q(column.name)} DROP DEFAULT;\nALTER TABLE ${ref(table.name)} ALTER COLUMN ${q(column.name)} TYPE ${column.dataType} USING ${q(column.name)}::${column.dataType};${column.defaultValue ? `\nALTER TABLE ${ref(table.name)} ALTER COLUMN ${q(column.name)} SET DEFAULT ${column.defaultValue};` : ""}`,
          true,
        );
      else if (
        normalizedDefault(old.defaultValue) !==
        normalizedDefault(column.defaultValue)
      )
        add(
          `Default di ${column.name}`,
          `ALTER TABLE ${ref(table.name)} ALTER COLUMN ${q(column.name)} ${column.defaultValue ? `SET DEFAULT ${column.defaultValue}` : "DROP DEFAULT"};`,
        );
      if (old.nullable !== column.nullable)
        add(
          `Vincolo NULL di ${column.name}`,
          `ALTER TABLE ${ref(table.name)} ALTER COLUMN ${q(column.name)} ${column.nullable ? "DROP" : "SET"} NOT NULL;`,
        );
    }
    for (const column of deleted) {
      if (
        source.indexes.some((index) => index.columns.includes(column.name)) ||
        source.foreignKeys.some((key) => key.column === column.name) ||
        schema.tables.some((t) =>
          t.foreignKeys.some(
            (key) =>
              key.referencedTable === source.name &&
              key.referencedColumn === column.name,
          ),
        )
      ) {
        blockers.push(
          `${source.name}.${column.name}: rimuovi prima indici e relazioni dipendenti in una migrazione separata.`,
        );
        continue;
      }
      add(
        `Elimina colonna e valori ${column.name}`,
        `ALTER TABLE ${ref(table.name)} DROP COLUMN ${q(column.name)};`,
        true,
      );
    }
    const baselineIndexes = baseline.options.indexes.map((index) => ({
      ...index,
      columns: index.columns
        .split(",")
        .map((name) => renamedColumns.get(name.trim()) || name.trim())
        .join(", "),
    }));
    for (const index of baselineIndexes.filter(
      (old) =>
        !table.options.indexes.some(
          (i) => JSON.stringify(i) === JSON.stringify(old),
        ),
    ))
      add(
        `Rimuovi indice ${index.name}`,
        engine === "mysql" || engine === "mariadb"
          ? `DROP INDEX ${q(index.name)} ON ${ref(table.name)};`
          : `DROP INDEX ${source.schema ? q(source.schema) + "." : ""}${q(index.name)};`,
      );
    for (const index of table.options.indexes.filter(
      (i) =>
        !baselineIndexes.some(
          (old) => JSON.stringify(old) === JSON.stringify(i),
        ),
    ))
      add(
        `Crea indice ${index.name}`,
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${q(index.name)} ON ${ref(table.name)} (${index.columns
          .split(",")
          .map((name) => q(name.trim()))
          .join(", ")});`,
      );
    if (removedKeys.length)
      blockers.push(
        `${table.name}: la rimozione di chiavi esterne richiede il nome del vincolo dal server e una migrazione dedicata.`,
      );
    for (const key of addedKeys) {
      const target = schema.tables.find((t) => t.name === key.table);
      const targetColumn = target?.columns.find(
        (c) => c.name === key.targetColumn,
      );
      if (
        !table.columns.some((c) => c.name === key.column) ||
        !targetColumn ||
        !(
          (targetColumn.primaryKey &&
            target!.columns.filter((c) => c.primaryKey).length === 1) ||
          target!.indexes.some(
            (i) =>
              i.unique &&
              !i.partial &&
              i.columns.length === 1 &&
              i.columns[0] === key.targetColumn,
          )
        )
      ) {
        blockers.push(
          `${table.name}: la nuova relazione richiede una colonna destinazione PK/UNIQUE singola effettiva.`,
        );
        continue;
      }
      add(
        `Collega ${table.name}.${key.column} → ${key.table}.${key.targetColumn}`,
        `ALTER TABLE ${ref(table.name)} ADD FOREIGN KEY (${q(key.column)}) REFERENCES ${source.schema ? q(source.schema) + "." : ""}${q(key.table)} (${q(key.targetColumn)});`,
      );
    }
  }
  if (engine === "mysql" || engine === "mariadb" || engine === "mongodb")
    warnings.push(
      "Questo motore può applicare le operazioni DDL separatamente. In caso di errore controlla lo schema prima di riprovare; non è promesso un rollback globale.",
    );
  const sql =
    engine === "mongodb"
      ? JSON.stringify(
          changes.flatMap((change) => {
            const command = JSON.parse(change.sql);
            return Array.isArray(command) ? command : [command];
          }),
          null,
          2,
        )
      : changes
          .map((change) => `-- ${change.label}\n${change.sql}`)
          .join("\n\n");
  return {
    changes,
    blockers,
    warnings: [...new Set(warnings)],
    sql,
    rebuildSqlite,
  };
}
