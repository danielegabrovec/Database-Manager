import { previewSchemaImport } from "../designer/schemaImport";
import { designSnapshot } from "../designer/schemaProject";
import { importGraphQuery } from "../designer/operationGraphImport";
import { compileOperationGraph } from "../designer/operationGraph";
import {
  readApplicationProject,
  type ApplicationProject,
  type ProjectDatabase,
} from "./applicationProject";
import { ENGINES, LANGUAGES, type DataRow, type Engine } from "../types";
import { newId, objectRef, parseCell } from "../utils";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Il modello ha restituito un elemento incompleto.");
  return value as Record<string, unknown>;
}
function name(input: unknown, limit = 100): string {
  if (typeof input !== "string" || !input.trim() || input.length > limit)
    throw new Error("Nome o testo della proposta mancante o troppo lungo.");
  return input.trim();
}
function list(value: unknown, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit)
    throw new Error("La proposta supera i limiti del progetto.");
  return value;
}
export function interpretProjectGoal(raw: unknown): {
  project: ApplicationProject;
  language: string;
} {
  const input = record(raw);
  const aliases = new Set<string>();
  const databases = list(input.databases, 8).map((value): ProjectDatabase => {
    const db = record(value);
    const alias = name(db.name);
    if (aliases.has(alias.toLowerCase()))
      throw new Error("Alias database duplicato: " + alias);
    aliases.add(alias.toLowerCase());
    const engine = db.engine as Engine;
    if (!ENGINES.includes(engine)) throw new Error("Motore sconosciuto.");
    const schema = previewSchemaImport({
      id: newId(),
      name: alias,
      engine,
      format: engine === "mongodb" ? "mongodb" : "sql",
      source: name(db.schema, 512 * 1024),
    });
    if (schema.issues.length || !schema.tables.length)
      throw new Error(
        alias +
          " · " +
          (schema.issues
            .map((i) => "riga " + i.line + ": " + i.message)
            .join("\n") || "Schema vuoto."),
      );
    const snapshot = designSnapshot(engine, schema.tables);
    const seed = list(db.seed, 80).flatMap((entry) => {
      const group = record(entry);
      const matches = snapshot.tables.filter(
        (table) =>
          table.name === group.table ||
          (table.schema && table.schema + "." + table.name === group.table),
      );
      if (matches.length !== 1)
        throw new Error(
          "Destinazione dei dati di esempio ambigua o inesistente: " +
            group.table,
        );
      const table = matches[0];
      return list(group.rows, 200).map((rawRow) => {
        const values: DataRow = Object.create(null);
        for (const [field, value] of Object.entries(record(rawRow))) {
          const column = table.columns.find((c) => c.name === field);
          if (!column)
            throw new Error("Campo di esempio sconosciuto: " + field);
          if (
            value !== null &&
            !["string", "number", "boolean"].includes(typeof value)
          )
            throw new Error("Valore di esempio non valido.");
          if (
            typeof value === "number" &&
            Number.isInteger(value) &&
            !Number.isSafeInteger(value)
          )
            throw new Error(
              "Gli interi a 64 bit vanno trasmessi come stringhe.",
            );
          values[field] =
            value === null
              ? { type: "null" }
              : parseCell(String(value), column, undefined, false);
        }
        return { id: newId(), table: objectRef(table), values };
      });
    });
    const operations = list(db.operations, 40).map((item) => {
      const op = record(item);
      const graph = importGraphQuery(
        { query: name(op.query, 64 * 1024) },
        snapshot,
        engine,
      );
      compileOperationGraph(graph, snapshot, engine);
      return { id: newId(), name: name(op.name), graph };
    });
    return {
      id: newId(),
      name: alias,
      engine,
      tables: schema.tables,
      seed,
      operations,
    };
  });
  if (!databases.length) throw new Error("Nessun database nella proposta.");
  const language = LANGUAGES.find(
    (l) => l.toLowerCase() === name(input.language).toLowerCase(),
  );
  if (!language) throw new Error("Linguaggio di esportazione non supportato.");
  const steps = databases.reduce(
    (count, db) => count + 2 + db.seed.length + db.operations.length,
    1,
  );
  if (steps > 100)
    throw new Error(
      "Il piano supera 100 passi. Riduci l’obiettivo o suddividi i dati di prova.",
    );
  return {
    project: readApplicationProject({
      version: 1,
      id: newId(),
      name: name(input.name),
      databases,
    }),
    language,
  };
}
