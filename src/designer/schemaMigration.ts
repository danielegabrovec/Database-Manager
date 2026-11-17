import type { Engine, SchemaSnapshot, TableInfo } from "../types";
import { quoteIdentifier } from "../components/SchemaBuilders";
import {
  adoptTable,
  buildCreationPlan,
  buildTableDdl,
  checkDesignReferenceTarget,
  designObjectKey,
  designReference,
  inDesignNamespace,
  isEditableDesignObject,
  qualifiedDesignObject,
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
  affectedTableIds: string[];
}

export function editExistingTable(
  source: TableInfo,
  engine?: Engine,
): DesignTable {
  if (!isEditableDesignObject(source))
    throw new Error("Seleziona una tabella o collezione modificabile.");
  const table = adoptTable(source, engine);
  table.source = structuredClone(source);
  table.columns = table.columns.map((column) => ({
    ...column,
    sourceName: column.name,
    autoIncrement:
      (!!column.identity && !/\bserial\b/i.test(column.dataType)) ||
      (column.primaryKey &&
        /\bAUTOINCREMENT\b/i.test(source.definition || "") &&
        normalType(column.dataType) === "INTEGER"),
  }));
  if (/^collection\b/i.test(source.kind)) return table;
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

export function rebaseAppliedDesign(
  current: DesignTable[],
  submitted: DesignTable[],
  affected: Set<string>,
  snapshot: SchemaSnapshot,
): DesignTable[] {
  return current.map((draft) => {
    if (!affected.has(draft.id) || !submitted.includes(draft)) return draft;
    const actual = snapshot.tables.find(
      (table) =>
        isEditableDesignObject(table) &&
        inDesignNamespace(snapshot, table) &&
        designObjectKey(snapshot.engine, table) ===
          designObjectKey(snapshot.engine, draft),
    );
    if (!actual) return draft;
    try {
      const rebased = editExistingTable(actual, snapshot.engine);
      if (snapshot.engine === "mongodb") {
        rebased.options.keys = draft.options.keys;
        const actualNames = new Set(
          rebased.columns.map((column) => column.name),
        );
        rebased.columns.push(
          ...draft.columns
            .filter((column) => !actualNames.has(column.name))
            .map((column) => ({ ...column, unique: false })),
        );
      }
      return { ...rebased, id: draft.id, position: draft.position };
    } catch {
      return draft;
    }
  });
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
  targetSchema?: string;
}) =>
  JSON.stringify([key.column, key.table, key.targetColumn, key.targetSchema]);

/** Explicit migration plan. Unsupported metadata is a blocker, never silently dropped. */
export function buildMigrationPlan(
  engine: Engine,
  tables: DesignTable[],
  schema: SchemaSnapshot | null,
): MigrationPlan {
  const changes: SchemaChange[] = [],
    deferredKeys: SchemaChange[] = [],
    blockers: string[] = [],
    warnings: string[] = [];
  let rebuildSqlite = false;
  const affected = new Set<string>();
  let currentId: string | undefined;
  if (!schema || schema.engine !== engine)
    return {
      changes,
      blockers: [
        "Collega il database del progetto per confrontare le modifiche.",
      ],
      warnings,
      sql: "",
      rebuildSqlite,
      affectedTableIds: [],
    };
  const q = (name: string) => quoteIdentifier(name, engine);
  const add = (label: string, sql: string, destructive = false) => {
    changes.push({ label, sql, destructive });
    if (currentId) affected.add(currentId);
  };
  const names = new Set<string>();
  for (const table of tables) {
    buildTableDdl(engine, table);
    const key = designObjectKey(engine, table);
    if (names.has(key)) throw new Error(`Tabella duplicata: ${table.name}`);
    names.add(key);
  }
  const fresh = tables.filter((table) => !table.source);
  const creation = buildCreationPlan(engine, fresh, schema);
  if (creation.pendingTables.length) {
    add(`Crea ${creation.pendingTables.length} nuove strutture`, creation.sql);
    for (const table of creation.pendingTables) affected.add(table.id);
  }
  for (const table of tables.filter((item) => item.source)) {
    currentId = table.id;
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
        mongo: value.mongo && {
          validator: value.mongo.validator,
          validationLevel: value.mongo.validationLevel,
          validationAction: value.mongo.validationAction,
        },
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
      engine === "postgresql" &&
      designObjectKey(engine, table) !==
        designObjectKey(engine, { name: table.name, schema: source.schema })
    ) {
      blockers.push(
        `${source.name}: spostare una tabella in un altro schema richiede una migrazione dedicata.`,
      );
      continue;
    }
    if (
      table.name !== source.name &&
      schema.tables.some(
        (item) =>
          designObjectKey(engine, item) === designObjectKey(engine, table),
      )
    ) {
      blockers.push(
        `${table.name}: nome già usato da un oggetto del database.`,
      );
      continue;
    }
    const baseline = editExistingTable(source, engine);
    const ref = (name: string) =>
      engine === "postgresql"
        ? qualifiedDesignObject(engine, { name, schema: source.schema })
        : source.schema && engine !== "mongodb"
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
    const oldKeys = baseline.options.keys.map((key) => {
      const reference = designReference(engine, baseline, key);
      const target = tables.find(
        (item) =>
          item.source &&
          designObjectKey(engine, item.source) ===
            designObjectKey(engine, reference),
      );
      const targetColumn =
        target?.columns.find((column) => column.sourceName === key.targetColumn)
          ?.name || key.targetColumn;
      if (
        target &&
        (target.name !== key.table || targetColumn !== key.targetColumn)
      )
        affected.add(table.id);
      return {
        ...key,
        column: renamedColumns.get(key.column) || key.column,
        table: target?.name || key.table,
        targetColumn,
      };
    });
    const removedKeys = oldKeys.filter(
      (key) =>
        !table.options.keys.some(
          (next) =>
            keySignature(key) ===
            keySignature({
              ...next,
              targetSchema: designReference(engine, table, next).schema,
            }),
        ),
    );
    const addedKeys = table.options.keys.filter(
      (key) =>
        !oldKeys.some(
          (old) =>
            keySignature(old) ===
            keySignature({
              ...key,
              targetSchema: designReference(engine, table, key).schema,
            }),
        ),
    );
    const changedPrimary =
      changed.some(
        (c) =>
          baseline.columns.find((old) => old.sourceName === c.sourceName)
            ?.primaryKey !== c.primaryKey,
      ) ||
      added.some((c) => c.primaryKey || c.autoIncrement) ||
      deleted.some((c) => c.primaryKey);
    if (changedPrimary && engine !== "mongodb") {
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
      function definitions(draft: DesignTable) {
        const value = JSON.parse(buildTableDdl(engine, draft));
        const [collection, indexes] = Array.isArray(value) ? value : [value];
        return {
          validator: collection.validator || {},
          validationLevel: collection.validationLevel || "strict",
          validationAction: collection.validationAction || "error",
          indexes: new Map<string, object>(
            (indexes?.indexes || []).map((index: { name: string }) => [
              index.name,
              index,
            ]),
          ),
        };
      }
      const old = definitions(baseline);
      const next = definitions(table);
      if (
        JSON.stringify(old.validator) !== JSON.stringify(next.validator) ||
        old.validationLevel !== next.validationLevel ||
        old.validationAction !== next.validationAction
      )
        add(
          `Aggiorna validatore di ${table.name}`,
          JSON.stringify({
            collMod: table.name,
            validator: next.validator,
            validationLevel: next.validationLevel,
            validationAction: next.validationAction,
          }),
        );
      const readonlyIndexes = source.indexes.filter(
        (index) => !old.indexes.has(index.name),
      );
      for (const name of next.indexes.keys())
        if (readonlyIndexes.some((index) => index.name === name))
          blockers.push(
            `${table.name}: l’indice ${name} è gestito dal server o ha opzioni avanzate.`,
          );
      for (const [name, spec] of old.indexes) {
        const intended = next.indexes.get(name);
        if (JSON.stringify(spec) !== JSON.stringify(intended))
          add(
            `Rimuovi indice ${table.name}.${name}`,
            JSON.stringify({ dropIndexes: table.name, index: name }),
            true,
          );
      }
      for (const [name, spec] of next.indexes) {
        if (JSON.stringify(old.indexes.get(name)) !== JSON.stringify(spec))
          add(
            `Crea indice ${table.name}.${name}`,
            JSON.stringify({ createIndexes: table.name, indexes: [spec] }),
          );
      }
      if (affected.has(table.id))
        warnings.push(
          "MongoDB: il validatore si applica alle scritture successive. I documenti esistenti conservano i valori correnti.",
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
        source.columns.some((column) => column.generated) ||
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
        source.foreignKeys.some(
          (key) =>
            key.column === column.name || key.columns?.includes(column.name),
        ) ||
        schema.tables.some((t) =>
          t.foreignKeys.some(
            (key) =>
              key.referencedTable === source.name &&
              (key.referencedSchema || t.schema) === source.schema &&
              (key.referencedColumn === column.name ||
                key.referencedColumns?.includes(column.name)),
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
          : `DROP INDEX ${engine === "postgresql" ? qualifiedDesignObject(engine, { name: index.name, schema: source.schema }) : source.schema ? q(source.schema) + "." + q(index.name) : q(index.name)};`,
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
    for (const key of removedKeys) {
      const index = oldKeys.indexOf(key);
      const name = source.foreignKeys[index]?.name;
      if (!name || engine === "sqlite") {
        blockers.push(
          `${table.name}: la rimozione di una chiave esterna richiede il nome del vincolo dal server.`,
        );
        continue;
      }
      add(
        `Rimuovi la chiave esterna ${name} da ${table.name}`,
        `ALTER TABLE ${ref(table.name)} ${engine === "postgresql" ? "DROP CONSTRAINT" : "DROP FOREIGN KEY"} ${q(name)};`,
        true,
      );
    }
    for (const key of addedKeys) {
      const requested = designReference(engine, table, key);
      const targetDraft = tables.find(
        (candidate) =>
          designObjectKey(engine, candidate) ===
          designObjectKey(engine, requested),
      );
      const target = schema.tables.find(
        (t) =>
          isEditableDesignObject(t) &&
          designObjectKey(engine, t) === designObjectKey(engine, requested),
      );
      const targetColumn = target?.columns.find(
        (c) => c.name === key.targetColumn,
      );
      let validTarget =
        !!targetColumn &&
        ((targetColumn.primaryKey &&
          target!.columns.filter((c) => c.primaryKey).length === 1) ||
          target!.indexes.some(
            (i) =>
              i.unique &&
              !i.partial &&
              i.columns.length === 1 &&
              i.columns[0] === key.targetColumn,
          ));
      if (targetDraft) {
        try {
          checkDesignReferenceTarget(engine, targetDraft, key.targetColumn);
          validTarget = true;
        } catch {
          validTarget = false;
        }
      }
      if (!table.columns.some((c) => c.name === key.column) || !validTarget) {
        blockers.push(
          `${table.name}: la nuova relazione richiede una colonna destinazione PK/UNIQUE singola effettiva.`,
        );
        continue;
      }
      deferredKeys.push({
        label: `Collega ${table.name}.${key.column} → ${key.table}.${key.targetColumn}`,
        sql: `ALTER TABLE ${ref(table.name)} ADD FOREIGN KEY (${q(key.column)}) REFERENCES ${engine === "postgresql" ? qualifiedDesignObject(engine, requested) : ref(key.table)} (${q(key.targetColumn)});`,
        destructive: false,
      });
      affected.add(table.id);
    }
  }
  changes.push(...deferredKeys);
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
    affectedTableIds: [...affected],
  };
}
