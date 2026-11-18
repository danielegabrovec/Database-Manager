import { buildProjectDdl, designSnapshot } from "../designer/schemaProject";
import { buildMigrationPlan } from "../designer/schemaMigration";
import { compileOperationGraph } from "../designer/operationGraph";
import { importGraphQuery } from "../designer/operationGraphImport";
import { extractDatabaseOperations } from "../files/queryExtraction";
import { api } from "../api";
import type {
  CellValue,
  Engine,
  GeneratedProject,
  ObjectRef,
  SchemaSnapshot,
} from "../types";
import { objectKey, objectRef } from "../utils";
import {
  readApplicationProject,
  type ApplicationProject,
} from "./applicationProject";

export const PACKAGE_MANIFEST = "database-manager-project.json";

export type ProjectPackageRequest = {
  language: string;
  project: ApplicationProject;
  databases: {
    id: string;
    name: string;
    engine: Engine;
    schema: SchemaSnapshot;
    ddl: string;
    migration?: {
      baseline: SchemaSnapshot;
      sql: string;
      blockers: string[];
      warnings: string[];
      rebuildSqlite: boolean;
      changes: { label: string; destructive: boolean }[];
    };
    seed: { table: ObjectRef; values: Record<string, CellValue> }[];
    operations: {
      id: string;
      name: string;
      table: ObjectRef;
      plan: ReturnType<typeof compileOperationGraph>;
    }[];
  }[];
};

const LANGUAGE_IDS: Record<string, string> = { "C#": "csharp", "C++": "cpp" };

export type ApplicationPackage = GeneratedProject & {
  migrations: {
    databaseId: string;
    databaseName: string;
    status: "ready" | "blocked" | "designer" | "unchanged";
    scriptPath?: string;
    guidePath: string;
    baselinePath: string;
    baselineSha256: string;
    destructive: boolean;
  }[];
  operations: {
    id: string;
    name: string;
    databaseId: string;
    databaseName: string;
    table: ObjectRef;
    sourcePath?: string;
    queryPath: string;
    parametersPath?: string;
  }[];
};

export function buildApplicationPackage(
  project: ApplicationProject,
  language: string,
  includeSeed = false,
): Promise<ApplicationPackage> {
  return api<ApplicationPackage>("generate_application_package", {
    request: prepareProjectPackage(project, language, includeSeed),
  });
}

export function prepareProjectPackage(
  project: ApplicationProject,
  language: string,
  includeSeed: boolean,
): ProjectPackageRequest {
  const exportProject = {
    ...project,
    databases: project.databases.map((database) => ({
      ...database,
      seed: includeSeed
        ? database.seed.filter((row) => row.enabled !== false)
        : [],
    })),
  };
  return {
    project: exportProject,
    language: LANGUAGE_IDS[language] || language.toLowerCase(),
    databases: exportProject.databases.map((database) => {
      const schema = designSnapshot(database.engine, database.tables);
      const ddl = buildProjectDdl(database.engine, database.tables);
      const baselineTables = database.tables.flatMap((table) =>
        table.source ? [table.source] : [],
      );
      const baseline = baselineTables.length
        ? { ...schema, tables: baselineTables }
        : undefined;
      const migration = baseline
        ? buildMigrationPlan(database.engine, database.tables, baseline)
        : undefined;
      const operations = database.operations.map((operation) => {
        try {
          const table = schema.tables.find(
            (candidate) =>
              objectKey(candidate) ===
              operation.graph.nodes.find((node) => node.id === "source")?.table,
          );
          if (!table)
            throw new Error("Seleziona la tabella o collezione di partenza.");
          return {
            id: operation.id,
            name: operation.name,
            table: objectRef(table),
            plan: compileOperationGraph(
              operation.graph,
              schema,
              database.engine,
            ),
          };
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`${database.name} · ${operation.name}. ${reason}`);
        }
      });
      return {
        id: database.id,
        name: database.name,
        engine: database.engine,
        seed: database.seed,
        schema,
        ddl,
        operations,
        ...(baseline && migration
          ? {
              migration: {
                ...migration,
                baseline,
                changes: migration.changes.map(({ label, destructive }) => ({
                  label,
                  destructive,
                })),
              },
            }
          : {}),
      };
    }),
  };
}

export function readProjectPackageManifest(text: string): ApplicationProject {
  const manifest: unknown = JSON.parse(text);
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("format" in manifest) ||
    manifest.format !== "database-manager-project" ||
    !("version" in manifest) ||
    manifest.version !== 1 ||
    !("project" in manifest)
  ) {
    throw new Error(
      "Seleziona il manifesto database-manager-project.json di un pacchetto esportato.",
    );
  }
  return readApplicationProject(manifest.project);
}

export function projectImportConflicts(
  current: ApplicationProject,
  incoming: ApplicationProject,
): string[] {
  if (current.id !== incoming.id) return [];
  const incomingDatabases = new Map(
    incoming.databases.map((database) => [database.id, database]),
  );
  const conflicts = current.databases.filter(
    (database) =>
      JSON.stringify(database) !==
      JSON.stringify(incomingDatabases.get(database.id)),
  );
  return conflicts.map((database) => database.name);
}

export function analyzeProjectSource(text: string, filename: string) {
  const analyzed = extractDatabaseOperations(text, filename);
  return analyzed.operations.filter(
    (operation) => operation.confidence === "literal",
  );
}

export function addProjectSourceOperation(
  project: ApplicationProject,
  databaseId: string,
  source: { text: string; label: string },
  parameters: Record<string, unknown> = {},
): ApplicationProject {
  const database = project.databases.find((value) => value.id === databaseId);
  if (!database)
    throw new Error("Scegli il database di destinazione del grafo.");
  const schema = designSnapshot(database.engine, database.tables);
  const graph = importGraphQuery(
    { query: source.text, parameters },
    schema,
    database.engine,
  );
  compileOperationGraph(graph, schema, database.engine);
  const operation = { id: crypto.randomUUID(), name: source.label, graph };
  return {
    ...project,
    databases: project.databases.map((item) =>
      item.id === databaseId
        ? { ...item, operations: [...item.operations, operation] }
        : item,
    ),
  };
}
