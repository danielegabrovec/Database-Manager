import {
  buildProjectDdl,
  designObjectKey,
  designSnapshot,
  type DesignTable,
} from "../designer/schemaProject";
import { previewSchemaImport } from "../designer/schemaImport";
import { importGraphQuery } from "../designer/operationGraphImport";
import {
  compileOperationGraph,
  type GraphDraft,
} from "../designer/operationGraph";
import { extractDatabaseOperations } from "../files/queryExtraction";
import {
  compileProjectDatabase,
  readApplicationProject,
  type ApplicationProject,
} from "./applicationProject";
import { errorMessage } from "../utils";

export interface MappedSource {
  path: string;
  kind: "schema" | "schemaSource" | "source" | "query" | "parameters";
  databaseId: string;
  operationId?: string;
  content?: string;
  changed: boolean;
  missing?: boolean;
  actualHash?: string;
}
export interface SourceInspection {
  manifest: { project: unknown };
  files: MappedSource[];
}
export interface SourceChange {
  key: string;
  label: string;
  paths: string[];
  detail: string;
  error?: string;
  databaseId: string;
  operationId?: string;
  tables?: DesignTable[];
  graph?: GraphDraft;
}
export function scanProjectChanges(
  project: ApplicationProject,
  inspection: SourceInspection,
): SourceChange[] {
  const baseline = readApplicationProject(inspection.manifest.project);
  if (baseline.id !== project.id)
    throw new Error(
      "Questo pacchetto appartiene a un altro progetto. Apri prima il suo manifesto.",
    );
  const out: SourceChange[] = [];
  for (const srcDb of baseline.databases) {
    const db = project.databases.find((item) => item.id === srcDb.id);
    const files = inspection.files.filter((f) => f.databaseId === srcDb.id);
    if (!db) {
      if (files.some((f) => f.changed))
        out.push({
          key: srcDb.id,
          databaseId: srcDb.id,
          label: srcDb.name,
          paths: [],
          detail: "",
          error: "Database rimosso dal progetto locale.",
        });
      continue;
    }
    let tables = db.tables;
    const schemaFiles = files.filter(
      (f) => f.changed && (f.kind === "schema" || f.kind === "schemaSource"),
    );
    if (schemaFiles.length) {
      const change: SourceChange = {
        key: db.id,
        databaseId: db.id,
        label: db.name + " · Schema",
        paths: schemaFiles.map((f) => f.path),
        detail: "",
      };
      try {
        const versions = schemaFiles.map((f) => {
          if (f.missing)
            throw new Error(
              "File rimosso. La rimozione del file richiede revisione manuale.",
            );
          const parsed = previewSchemaImport({
            id: db.id,
            name: f.path,
            source: f.content!,
            format:
              f.kind === "schemaSource"
                ? "source"
                : db.engine === "mongodb"
                  ? "mongodb"
                  : "sql",
            engine: db.engine,
          });
          if (parsed.issues.length || !parsed.tables.length)
            throw new Error(
              parsed.issues
                .map((i) => "riga " + i.line + " · " + i.message)
                .join("\n") || "Schema non riconosciuto.",
            );
          return parsed.tables;
        });
        const ddl = (t: DesignTable[]) => buildProjectDdl(db.engine, t);
        if (versions.some((v) => ddl(v) !== ddl(versions[0])))
          throw new Error(
            "Schema e funzione di creazione contengono modifiche diverse.",
          );
        if (
          ddl(db.tables) !== ddl(srcDb.tables) &&
          ddl(db.tables) !== ddl(versions[0])
        )
          throw new Error(
            "Anche lo schema nel designer è stato modificato. Confronta le due versioni.",
          );
        const before = db.tables
          .map((t) =>
            [t.name, t.columns.map((c) => c.name).join(", ")].join(": "),
          )
          .join("\n");
        tables = versions[0].map((t) => {
          const old = db.tables.find(
            (p) =>
              designObjectKey(db.engine, p) === designObjectKey(db.engine, t),
          );
          return old
            ? { ...t, id: old.id, position: old.position, source: old.source }
            : t;
        });
        change.tables = tables;
        change.detail =
          before +
          "\n→\n" +
          tables
            .map((t) => t.name + ": " + t.columns.map((c) => c.name).join(", "))
            .join("\n");
      } catch (e) {
        change.error = errorMessage(e);
      }
      out.push(change);
    }
    for (const orig of srcDb.operations) {
      const related = files.filter((f) => f.operationId === orig.id);
      const changed = related.filter((f) => f.changed);
      if (!changed.length) continue;
      const change: SourceChange = {
        key: db.id + "/" + orig.id,
        databaseId: db.id,
        operationId: orig.id,
        label: db.name + " · " + orig.name,
        paths: changed.map((f) => f.path),
        detail: "",
      };
      try {
        if (changed.some((f) => f.missing))
          throw new Error(
            "Un sorgente è stato rimosso. Verifica l’operazione prima di aggiornare.",
          );
        const current = db.operations.find((o) => o.id === orig.id);
        if (!current) throw new Error("Operazione rimossa localmente.");
        const snapshot = designSnapshot(db.engine, tables);
        const baselineOp = compileOperationGraph(
          orig.graph,
          designSnapshot(srcDb.engine, srcDb.tables),
          db.engine,
        );
        const editedOp = compileOperationGraph(
          current.graph,
          designSnapshot(db.engine, db.tables),
          db.engine,
        );
        const rawParams = related.find((f) => f.kind === "parameters")?.content;
        const params = rawParams
          ? JSON.parse(rawParams)
          : baselineOp.kind === "read"
            ? baselineOp.params
            : {};
        const sql: string[] = [];
        for (const file of changed.filter((f) => f.kind === "source")) {
          const extracted = extractDatabaseOperations(
            file.content!,
            file.path,
          ).operations.filter((op) => op.confidence === "literal");
          const queries = [...new Set(extracted.map((v) => v.text))];
          if (queries.length !== 1)
            throw new Error(
              "Sorgente dinamico o ambiguo in " +
                file.path +
                ". Usa l’estrazione manuale.",
            );
          sql.push(queries[0]);
        }
        const query = related.find((f) => f.kind === "query");
        if (query && (query.changed || !sql.length)) sql.push(query.content!);
        if (!sql.length) throw new Error("Manca la query associata.");
        const candidates = sql.map((text) =>
          importGraphQuery(
            { query: text, parameters: params },
            snapshot,
            db.engine,
          ),
        );
        const revised = compileOperationGraph(
          candidates[0],
          snapshot,
          db.engine,
        );
        if (
          candidates.some(
            (c) =>
              JSON.stringify(compileOperationGraph(c, snapshot, db.engine)) !==
              JSON.stringify(revised),
          )
        )
          throw new Error(
            "La funzione e lo script descrivono operazioni diverse.",
          );
        if (
          JSON.stringify(editedOp) !== JSON.stringify(baselineOp) &&
          JSON.stringify(editedOp) !== JSON.stringify(revised)
        )
          throw new Error(
            "Operazione modificata anche nel grafo. Risolvi il conflitto prima di applicare.",
          );
        change.graph = {
          ...candidates[0],
          nodes: candidates[0].nodes.map((n) => ({
            ...n,
            position:
              current.graph.nodes.find((old) => old.id === n.id)?.position ??
              n.position,
          })),
        };
        change.detail = sql[0] + "\n" + JSON.stringify(params, null, 2);
      } catch (e) {
        change.error = errorMessage(e);
      }
      out.push(change);
    }
  }
  return out;
}
export function applySourceChanges(
  project: ApplicationProject,
  changes: SourceChange[],
): ApplicationProject {
  if (changes.some((c) => c.error))
    throw new Error("Risolvi i conflitti prima di applicare.");
  const databases = project.databases.map((db) => {
    const selected = changes.filter((c) => c.databaseId === db.id);
    if (!selected.length) return db;
    const next = {
      ...db,
      tables: selected.find((c) => c.tables)?.tables ?? db.tables,
      operations: db.operations.map((op) => ({
        ...op,
        graph: selected.find((c) => c.operationId === op.id)?.graph ?? op.graph,
      })),
    };
    compileProjectDatabase(next);
    return next;
  });
  return { ...project, databases };
}
