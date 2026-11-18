import {
  buildProjectDdl,
  designObject,
  designSnapshot,
  newDesignTable,
  readDesignProject,
  type DesignTable,
} from "../designer/schemaProject";
import {
  compileOperationGraph,
  initialGraph,
  readGraphDraft,
  type GraphDraft,
} from "../designer/operationGraph";
import {
  ENGINES,
  ENGINE_LABELS,
  type CellType,
  type CellValue,
  type Engine,
  type ObjectRef,
} from "../types";
import { objectKey } from "../utils";

export interface ProjectSeedRow {
  id: string;
  table: ObjectRef;
  values: Record<string, CellValue>;
  enabled?: boolean;
}

export interface ProjectOperation {
  id: string;
  name: string;
  graph: GraphDraft;
}

export interface ProjectDatabase {
  id: string;
  name: string;
  engine: Engine;
  tables: DesignTable[];
  operations: ProjectOperation[];
  seed: ProjectSeedRow[];
}

export interface ApplicationProject {
  version: 1;
  id: string;
  name: string;
  databases: ProjectDatabase[];
}

const STORAGE = "dbm-application-projects-v1";
const CELL_TYPES = new Set<CellType>([
  "null",
  "text",
  "integer",
  "decimal",
  "boolean",
  "json",
  "binary",
  "datetime",
  "float",
]);

export function newProjectDatabase(
  engine: Engine = "sqlite",
  name = ENGINE_LABELS[engine],
): ProjectDatabase {
  return {
    id: crypto.randomUUID(),
    name,
    engine,
    tables: [newDesignTable(engine)],
    operations: [],
    seed: [],
  };
}

export function newProjectOperation(name: string): ProjectOperation {
  return { id: crypto.randomUUID(), name, graph: initialGraph() };
}

export function newApplicationProject(
  name = "Nuovo progetto",
): ApplicationProject {
  return {
    version: 1,
    id: crypto.randomUUID(),
    name,
    databases: [newProjectDatabase()],
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown, maximum: number, field: string) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    value.includes("\0")
  )
    throw new Error(`${field} non valido.`);
  return value;
}

function entries(value: unknown, maximum: number, field: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new Error(
      `${field}: lista non valida o oltre il limite di ${maximum} elementi.`,
    );
  return value;
}

function unique(items: { id: string }[], field: string) {
  if (
    items.some((item) => !item.id) ||
    new Set(items.map((item) => item.id)).size !== items.length
  )
    throw new Error(`${field}: identificatori mancanti o duplicati.`);
}

function seedRow(raw: unknown): ProjectSeedRow {
  if (!record(raw) || !record(raw.table) || !record(raw.values))
    throw new Error("Record di prova non valido.");
  const values = Object.entries(raw.values).map(([name, value]) => {
    if (
      !name ||
      !record(value) ||
      !CELL_TYPES.has(value.type as CellType) ||
      (value.type !== "null" &&
        typeof value.value !== "string" &&
        typeof value.value !== "boolean")
    )
      throw new Error(`Valore di prova non valido per ${name}.`);
    const typed: CellValue = {
      type: value.type as CellType,
      ...(value.type !== "null"
        ? {
            value:
              typeof value.value === "boolean"
                ? value.value
                : string(value.value, 64 * 1024, "Valore"),
          }
        : {}),
      ...(typeof value.nativeType === "string"
        ? { nativeType: string(value.nativeType, 100, "Tipo nativo") }
        : {}),
    };
    if (typed.type === "json") JSON.parse(String(typed.value));
    return [name, typed] as const;
  });
  if (values.length > 500)
    throw new Error("Troppi campi in un record di prova.");
  return {
    id: string(raw.id, 128, "Identificatore record"),
    table: {
      name: string(raw.table.name, 128, "Tabella di prova"),
      ...(raw.table.schema === undefined
        ? {}
        : { schema: string(raw.table.schema, 128, "Schema di prova") }),
    },
    values: Object.fromEntries(values),
    ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
  };
}

export function readApplicationProject(value: unknown): ApplicationProject {
  if (!record(value) || value.version !== 1)
    throw new Error("Versione del progetto applicativo non supportata.");
  const databases = entries(value.databases, 12, "Database").map(
    (entry): ProjectDatabase => {
      if (!record(entry) || !ENGINES.includes(entry.engine as Engine))
        throw new Error("Motore del database di progetto non supportato.");
      const design = readDesignProject({
        engine: entry.engine,
        tables: entry.tables,
      });
      const operations = entries(entry.operations, 64, "Operazioni").map(
        (raw): ProjectOperation => {
          if (!record(raw)) throw new Error("Operazione non valida.");
          return {
            id: string(raw.id, 128, "Identificatore operazione"),
            name: string(raw.name, 120, "Nome operazione"),
            graph: readGraphDraft(raw.graph),
          };
        },
      );
      const seed = entries(entry.seed, 500, "Dati di prova").map(seedRow);
      unique(operations, "Operazioni");
      unique(seed, "Dati di prova");
      return {
        id: string(entry.id, 128, "Identificatore database"),
        name: string(entry.name, 120, "Nome database"),
        ...design,
        operations,
        seed,
      };
    },
  );
  unique(databases, "Database");
  if (!databases.length)
    throw new Error("Aggiungi almeno un database al progetto.");
  const id = string(value.id, 128, "Identificatore progetto");
  if (!id) throw new Error("Identificatore progetto mancante.");
  return {
    version: 1,
    id,
    name: string(value.name, 120, "Nome progetto"),
    databases,
  };
}

export function loadRecentApplicationProjects(): ApplicationProject[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE) || "[]");
    return Array.isArray(raw)
      ? raw.slice(0, 5).flatMap((item) => {
          try {
            return [readApplicationProject(item)];
          } catch {
            return [];
          }
        })
      : [];
  } catch {
    return [];
  }
}

export function loadApplicationProject(): ApplicationProject {
  return loadRecentApplicationProjects()[0] || newApplicationProject();
}

export function saveApplicationProject(project: ApplicationProject) {
  const recents = loadRecentApplicationProjects().filter(
    (item) => item.id !== project.id,
  );
  localStorage.setItem(
    STORAGE,
    JSON.stringify([project, ...recents].slice(0, 5)),
  );
}

export function compileProjectDatabase(database: ProjectDatabase) {
  const schema = designSnapshot(database.engine, database.tables);
  return {
    schema,
    ddl: buildProjectDdl(database.engine, database.tables),
    operations: database.operations.map((operation) => ({
      ...operation,
      compiled: compileOperationGraph(operation.graph, schema, database.engine),
    })),
  };
}

export function updateProjectTables(
  database: ProjectDatabase,
  tables: DesignTable[],
): ProjectDatabase {
  const changed = new Map<
    string,
    { object: ObjectRef; names: Map<string, string> }
  >();
  for (const original of database.tables) {
    const next = tables.find((table) => table.id === original.id);
    if (!next) continue;
    const names = new Map<string, string>();
    if (original.columns.length === next.columns.length) {
      for (const [index, column] of original.columns.entries()) {
        const name = next.columns[index].name;
        if (name !== column.name) names.set(column.name, name);
      }
    }
    if (
      names.size ||
      objectKey(designObject(database.engine, original)) !==
        objectKey(designObject(database.engine, next))
    )
      changed.set(objectKey(designObject(database.engine, original)), {
        object: designObject(database.engine, next),
        names,
      });
  }
  if (!changed.size) return { ...database, tables };
  return {
    ...database,
    tables,
    seed: database.seed.map((row) => {
      const next = changed.get(
        objectKey(designObject(database.engine, row.table)),
      );
      return next
        ? {
            ...row,
            table: next.object,
            values: Object.fromEntries(
              Object.entries(row.values).map(([field, value]) => [
                next.names.get(field) ?? field,
                value,
              ]),
            ),
          }
        : row;
    }),
    operations: database.operations.map((operation) => {
      const sourceKey = operation.graph.nodes.find(
        (node) => node.id === "source",
      )?.table;
      const source = sourceKey ? changed.get(sourceKey) : undefined;
      const rename = (field: string) => source?.names.get(field) ?? field;
      return {
        ...operation,
        graph: {
          ...operation.graph,
          nodes: operation.graph.nodes.map((node) => {
            const options = node.options;
            const join = options?.joinTable
              ? changed.get(options.joinTable)
              : undefined;
            return {
              ...node,
              table:
                node.id === "source" && source
                  ? objectKey(source.object)
                  : node.table,
              filters: node.filters?.map((filter) => ({
                ...filter,
                column: rename(filter.column),
              })),
              values: node.values?.map((value) => ({
                ...value,
                column: rename(value.column),
              })),
              ...(options
                ? {
                    options: {
                      ...options,
                      columns: options.columns?.map(rename),
                      groupBy: options.groupBy?.map(rename),
                      orderBy: options.orderBy
                        ? rename(options.orderBy)
                        : options.orderBy,
                      aggregateColumn: options.aggregateColumn
                        ? rename(options.aggregateColumn)
                        : options.aggregateColumn,
                      joinTable: join
                        ? objectKey(join.object)
                        : options.joinTable,
                      joinLocal: options.joinLocal
                        ? rename(options.joinLocal)
                        : options.joinLocal,
                      joinForeign: options.joinForeign
                        ? (join?.names.get(options.joinForeign) ??
                          options.joinForeign)
                        : options.joinForeign,
                    },
                  }
                : {}),
            };
          }),
        },
      };
    }),
  };
}
