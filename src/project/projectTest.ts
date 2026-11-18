import { api } from "../api";
import type { GraphWrite } from "../designer/operationGraph";
import { designObject } from "../designer/schemaProject";
import type { Engine, QueryResult, SchemaSnapshot } from "../types";
import { errorMessage } from "../utils";
import {
  compileProjectDatabase,
  type ApplicationProject,
  type ProjectDatabase,
} from "./applicationProject";

export interface ProjectTestReport {
  databaseId: string;
  name: string;
  engine: Engine;
  status: "passed" | "failed" | "cancelled";
  steps: {
    name: string;
    status: "passed" | "failed";
    detail: string;
    result?: QueryResult;
  }[];
}

export interface ProjectTestOptions {
  signal?: AbortSignal;
  stopOnFailure?: boolean;
  onProgress?: (label: string) => void;
}

interface PreparedOperation {
  query: string;
  parameters: Record<string, unknown>;
}

export function prepareProjectWrite(
  operation: GraphWrite,
  schema: SchemaSnapshot,
) {
  return api<PreparedOperation>("compile_project_write", { operation, schema });
}

export async function testProjectDatabase(
  database: ProjectDatabase,
  { signal, onProgress }: ProjectTestOptions = {},
): Promise<ProjectTestReport> {
  const report: ProjectTestReport = {
    databaseId: database.id,
    name: database.name,
    engine: database.engine,
    status: "passed",
    steps: [],
  };
  let name = "Verifica del progetto";
  let sessionId = "";
  const requestId = crypto.randomUUID();
  const cancel = () => {
    if (database.engine !== "sqlite")
      void api("cancel_project_test", { requestId }).catch(() => {});
    if (sessionId)
      void api("quick_query_cancel", { sessionId }).catch(() => {});
  };
  signal?.addEventListener("abort", cancel);
  const progress = (next: string) => {
    signal?.throwIfAborted();
    name = next;
    onProgress?.(`${database.name} · ${next}`);
  };
  try {
    progress(name);
    const plan = compileProjectDatabase(database);
    const steps = [
      ...database.seed
        .filter((row) => row.enabled !== false)
        .map((row, index) => ({
          name: `Dato di prova ${index + 1} · ${row.table.name}`,
          kind: "write" as const,
          operation: {
            kind: "insert" as const,
            table: designObject(database.engine, row.table),
            filters: [],
            values: row.values,
          },
        })),
      ...plan.operations.map(({ name, compiled }) => ({ name, ...compiled })),
    ];
    if (database.engine !== "sqlite") {
      progress("Prova sul laboratorio dedicato");
      const result = await api<{ steps: ProjectTestReport["steps"] }>(
        "test_project_remote",
        {
          engine: database.engine,
          requestId,
          ddl: plan.ddl,
          steps,
        },
      );
      report.steps.push(...result.steps);
      signal?.throwIfAborted();
      if (report.steps.some((step) => step.status === "failed"))
        report.status = "failed";
    } else {
      progress("Apertura SQLite in memoria");
      const opened = await api<{ sessionId: string }>("quick_query_open", {
        engine: "sqlite",
        dataset: "empty",
      });
      sessionId = opened.sessionId;
      const execute = (
        query: string,
        parameters: Record<string, unknown> = {},
      ) =>
        api<QueryResult>("quick_query_execute", {
          sessionId,
          query,
          parameters,
        });
      progress("Creazione dello schema");
      await execute(plan.ddl);
      const actual = await api<SchemaSnapshot>("quick_query_schema", {
        sessionId,
      });
      report.steps.push({
        name,
        status: "passed",
        detail: "Schema creato in memoria.",
      });
      for (const step of steps) {
        progress(step.name);
        const prepared =
          step.kind === "write"
            ? await prepareProjectWrite(step.operation, actual)
            : { query: step.query, parameters: step.params };
        signal?.throwIfAborted();
        const result = await execute(prepared.query, prepared.parameters);
        report.steps.push({
          name,
          status: "passed",
          detail:
            step.kind === "read"
              ? `${result.sets.reduce((count, set) => count + set.rows.length, 0)} righe lette`
              : `${result.affectedRows} righe modificate`,
          result,
        });
      }
      signal?.throwIfAborted();
    }
  } catch (error) {
    if (signal?.aborted) report.status = "cancelled";
    else {
      report.status = "failed";
      report.steps.push({
        name,
        status: "failed",
        detail: errorMessage(error),
      });
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (sessionId) {
      try {
        await api("quick_query_close", { sessionId });
      } catch (error) {
        report.status = "failed";
        report.steps.push({
          name: "Chiusura SQLite in memoria",
          status: "failed",
          detail: errorMessage(error),
        });
      }
    }
  }
  return report;
}

export async function testApplicationProject(
  project: ApplicationProject,
  options: ProjectTestOptions = {},
): Promise<ProjectTestReport[]> {
  const reports = [];
  for (const database of project.databases) {
    reports.push(await testProjectDatabase(database, options));
    if (
      options.signal?.aborted ||
      (options.stopOnFailure && reports.at(-1)?.status !== "passed")
    )
      break;
  }
  return reports;
}
