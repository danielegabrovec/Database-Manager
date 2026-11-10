import type { Engine } from "../types";

export interface QueryDocument {
  id: string;
  title: string;
  content: string;
  baseline: string;
  kind: "sql" | "mongodb";
  path?: string;
  sourcePath?: string;
  sourceLine?: number;
  originLabel?: string;
  originView?: "library";
  encoding?: string;
  fingerprint?: string;
  savedQueryId?: string;
  savedParametersText?: string;
  savedExecutionMode?: string;
  parametersText: string;
  executionMode: string;
  partial?: boolean;
}
export interface QueryWorkspace {
  version: 1;
  activeId: string;
  documents: QueryDocument[];
}
export const MAX_QUERY_DOCUMENTS = 24;
export const MAX_QUERY_WORKSPACE_CHARACTERS = 8 * 1024 * 1024;
export function createQueryDocument(
  content = "",
  engine: Engine = "sqlite",
  title = "Query senza titolo",
): QueryDocument {
  return {
    id: crypto.randomUUID(),
    title,
    content,
    baseline: "",
    kind: engine === "mongodb" ? "mongodb" : "sql",
    parametersText: "{}",
    executionMode: "current",
    savedParametersText: "{}",
    savedExecutionMode: "current",
  };
}
export function restoreQueryWorkspace(value: unknown): QueryWorkspace | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<QueryWorkspace>;
  if (
    source.version !== 1 ||
    !Array.isArray(source.documents) ||
    !source.documents.length ||
    source.documents.length > MAX_QUERY_DOCUMENTS
  )
    return null;
  const ids = new Set<string>();
  let size = 0;
  const documents: QueryDocument[] = [];
  for (const raw of source.documents) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.id !== "string" ||
      raw.id.length === 0 ||
      raw.id.length > 128 ||
      ids.has(raw.id) ||
      typeof raw.content !== "string" ||
      typeof raw.baseline !== "string" ||
      typeof raw.title !== "string" ||
      !["sql", "mongodb"].includes(raw.kind)
    )
      return null;
    ids.add(raw.id);
    size += raw.content.length + raw.baseline.length;
    if (size > MAX_QUERY_WORKSPACE_CHARACTERS) return null;
    const optional = (key: keyof QueryDocument, limit = 4096) =>
      typeof raw[key] === "string"
        ? String(raw[key]).slice(0, limit)
        : undefined;
    documents.push({
      id: raw.id.slice(0, 128),
      title: raw.title.slice(0, 256),
      content: raw.content,
      baseline: raw.baseline,
      kind: raw.kind,
      path: optional("path"),
      originLabel: optional("originLabel", 256),
      originView: raw.originView === "library" ? "library" : undefined,
      sourcePath: optional("sourcePath"),
      encoding: optional("encoding", 64),
      fingerprint: optional("fingerprint", 256),
      savedQueryId: optional("savedQueryId", 128),
      savedParametersText:
        typeof raw.savedParametersText === "string" &&
        raw.savedParametersText.length <= 65536
          ? raw.savedParametersText
          : "{}",
      savedExecutionMode: ["current", "selection", "script"].includes(
        raw.savedExecutionMode || "",
      )
        ? raw.savedExecutionMode
        : "current",
      parametersText:
        typeof raw.parametersText === "string" &&
        raw.parametersText.length <= 65536
          ? raw.parametersText
          : "{}",
      executionMode: ["current", "selection", "script"].includes(
        raw.executionMode,
      )
        ? raw.executionMode
        : "current",
      sourceLine:
        typeof raw.sourceLine === "number" && raw.sourceLine > 0
          ? Math.floor(raw.sourceLine)
          : undefined,
      partial: raw.partial === true,
    });
  }
  return {
    version: 1,
    activeId: documents.some((d) => d.id === source.activeId)
      ? source.activeId!
      : documents[0].id,
    documents,
  };
}
export function isQueryDocumentDirty(
  document: QueryDocument,
  currentContent = document.content,
): boolean {
  return (
    currentContent !== document.baseline ||
    (!!document.savedQueryId &&
      (document.parametersText !== (document.savedParametersText ?? "{}") ||
        document.executionMode !== (document.savedExecutionMode ?? "current")))
  );
}
export function sameDocumentPath(left: string, right: string): boolean {
  const normalize = (path: string) => {
    let normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
    if (normalized.toLowerCase().startsWith("//?/unc/"))
      normalized = "//" + normalized.slice(8);
    else if (normalized.startsWith("//?/")) normalized = normalized.slice(4);
    return normalized;
  };
  const a = normalize(left),
    b = normalize(right);
  return /^[a-z]:\//i.test(a) || a.startsWith("//")
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}
export function checkDocumentCapacity(
  documents: QueryDocument[],
  added: QueryDocument,
): void {
  if (documents.length >= MAX_QUERY_DOCUMENTS)
    throw new Error(
      `Sono aperte ${MAX_QUERY_DOCUMENTS} schede. Chiudine una prima di aprire altri documenti.`,
    );
  const size = [...documents, added].reduce(
    (n, doc) => n + doc.content.length + doc.baseline.length,
    0,
  );
  if (size > MAX_QUERY_WORKSPACE_CHARACTERS)
    throw new Error(
      "Il contenuto delle schede supera il limite di memoria. Salva e chiudi alcuni documenti; i file grandi restano consultabili in Apri file e database.",
    );
}
