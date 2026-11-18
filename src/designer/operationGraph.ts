import type {
  CellType,
  CellValue,
  Engine,
  ObjectRef,
  SchemaSnapshot,
} from "../types";
import { canBrowseData, objectKey, objectRef, parseCell } from "../utils";
import {
  buildOperation,
  INITIAL_READ,
  type ReadOptions,
} from "./readOperation";

export const GRAPH_LABELS = {
  source: "Tabella o collezione",
  join: "JOIN",
  filter: "Filtro",
  projection: "Colonne",
  aggregate: "Aggregazione",
  order: "Ordinamento",
  limit: "Limite",
  values: "Valori da scrivere",
  read: "Leggi risultati",
  write: "Scrivi nel database",
} as const;

type NodeKind = keyof typeof GRAPH_LABELS;
export const GRAPH_ORDER: Record<NodeKind, number> = {
  source: 0,
  join: 1,
  filter: 2,
  projection: 3,
  aggregate: 3,
  values: 3,
  order: 4,
  limit: 5,
  read: 6,
  write: 6,
};
export const GRAPH_OPERATORS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "IS NULL",
  "IS NOT NULL",
] as const;
export type GraphOperator = (typeof GRAPH_OPERATORS)[number];
export type WriteKind = "insert" | "update" | "delete";
export type ValueDraft = {
  column: string;
  text: string;
  type: CellType | "auto";
};
export type FilterDraft = ValueDraft & { operator: GraphOperator };
export type GraphNode = {
  id: NodeKind;
  position: { x: number; y: number };
  table?: string;
  options?: Partial<ReadOptions>;
  filters?: FilterDraft[];
  values?: ValueDraft[];
  operation?: WriteKind;
};
type GraphEdge = { id: string; source: NodeKind; target: NodeKind };
export type GraphDraft = { nodes: GraphNode[]; edges: GraphEdge[] };
export type GraphWrite = {
  table: ObjectRef;
  kind: WriteKind;
  filters: { column: string; operator: GraphOperator; value?: CellValue }[];
  values: Record<string, CellValue>;
};

export function graphEdge(source: NodeKind, target: NodeKind): GraphEdge {
  return { id: `${source}-${target}`, source, target };
}

export function initialGraph(): GraphDraft {
  return {
    nodes: [
      { id: "source", position: { x: 35, y: 75 } },
      { id: "read", position: { x: 295, y: 75 } },
    ],
    edges: [graphEdge("source", "read")],
  };
}

export function loadGraphDraft(key: string): GraphDraft {
  try {
    return readGraphDraft(JSON.parse(localStorage.getItem(key) || "null"));
  } catch {
    return initialGraph();
  }
}

export function readGraphDraft(value: unknown): GraphDraft {
  const draft = value as GraphDraft | null;
  if (
    !draft ||
    !Array.isArray(draft.nodes) ||
    !Array.isArray(draft.edges) ||
    draft.nodes.length > 10 ||
    draft.edges.length > 9
  )
    throw new Error("Formato del grafo non valido.");
  const ids = new Set(draft.nodes.map((node) => node?.id));
  if (
    !ids.has("source") ||
    ids.size !== draft.nodes.length ||
    draft.nodes.some(
      (node) =>
        !node ||
        !Object.hasOwn(GRAPH_LABELS, node.id) ||
        !Number.isFinite(node.position?.x) ||
        !Number.isFinite(node.position?.y) ||
        (node.table !== undefined && typeof node.table !== "string") ||
        (node.operation !== undefined &&
          !["insert", "update", "delete"].includes(node.operation)) ||
        (node.options &&
          (typeof node.options !== "object" || Array.isArray(node.options))) ||
        [node.values, node.filters].some(
          (fields) =>
            fields !== undefined &&
            (!Array.isArray(fields) ||
              fields.length > 500 ||
              fields.some(
                (field) =>
                  !field ||
                  typeof field.column !== "string" ||
                  typeof field.text !== "string" ||
                  ![
                    "auto",
                    "text",
                    "integer",
                    "decimal",
                    "float",
                    "boolean",
                    "datetime",
                    "null",
                    "json",
                    "binary",
                  ].includes(field.type),
              )),
        ),
    ) ||
    draft.edges.some(
      (edge) =>
        !edge ||
        typeof edge.id !== "string" ||
        !ids.has(edge.source) ||
        !ids.has(edge.target),
    )
  )
    throw new Error("Nodi o collegamenti del grafo non validi.");
  return draft;
}
export function insertGraphNode(draft: GraphDraft, id: NodeKind): GraphDraft {
  if (draft.nodes.some((node) => node.id === id)) return draft;
  const terminal = id === "read" || id === "write";
  const previousTerminal = terminal
    ? draft.nodes.find((node) => node.id === "read" || node.id === "write")
    : undefined;
  if (previousTerminal) {
    return {
      nodes: draft.nodes.map((node) =>
        node.id === previousTerminal.id
          ? { id, position: node.position }
          : node,
      ),
      edges: draft.edges.map((edge) =>
        edge.target === previousTerminal.id ? graphEdge(edge.source, id) : edge,
      ),
    };
  }
  const nodes = [...draft.nodes, { id, position: { x: 0, y: 0 } }].sort(
    (a, b) => GRAPH_ORDER[a.id] - GRAPH_ORDER[b.id],
  );
  const index = nodes.findIndex((node) => node.id === id);
  const before = nodes[index - 1];
  const after = nodes[index + 1];
  const bridge =
    before && after
      ? draft.edges.find(
          (edge) => edge.source === before.id && edge.target === after.id,
        )
      : undefined;
  return {
    nodes: nodes.map((node, i) => ({
      ...node,
      position: { x: 35 + 220 * i, y: node.position.y || 75 },
    })),
    edges: bridge
      ? [
          ...draft.edges.filter((edge) => edge !== bridge),
          graphEdge(before.id, id),
          graphEdge(id, after.id),
        ]
      : draft.edges,
  };
}

export function removeGraphNode(draft: GraphDraft, id: NodeKind): GraphDraft {
  if (id === "source") return draft;
  const inbound = draft.edges.find((edge) => edge.target === id);
  const outbound = draft.edges.find((edge) => edge.source === id);
  return {
    nodes: draft.nodes.filter((node) => node.id !== id),
    edges: [
      ...draft.edges.filter((edge) => edge.source !== id && edge.target !== id),
      ...(inbound && outbound
        ? [graphEdge(inbound.source, outbound.target)]
        : []),
    ],
  };
}

export function connectGraphNodes(
  draft: GraphDraft,
  source: NodeKind,
  target: NodeKind,
): GraphDraft {
  if (
    GRAPH_ORDER[source] >= GRAPH_ORDER[target] ||
    !draft.nodes.some((node) => node.id === source) ||
    !draft.nodes.some((node) => node.id === target)
  )
    return draft;
  return {
    ...draft,
    edges: [
      ...draft.edges.filter(
        (edge) => edge.source !== source && edge.target !== target,
      ),
      graphEdge(source, target),
    ],
  };
}

export function compileOperationGraph(
  draft: GraphDraft,
  schema: SchemaSnapshot | null,
  engine: Engine,
) {
  const sequence: GraphNode[] = [];
  let node = draft.nodes.find((item) => item.id === "source");
  while (node && !sequence.includes(node)) {
    sequence.push(node);
    const next = draft.edges.find((edge) => edge.source === node?.id);
    node = next && draft.nodes.find((item) => item.id === next.target);
  }
  const terminal = sequence.at(-1);
  if (
    sequence.length !== draft.nodes.length ||
    draft.edges.length !== sequence.length - 1 ||
    (terminal?.id !== "read" && terminal?.id !== "write")
  )
    throw new Error(
      "Collega tutti i nodi dalla sorgente fino a un’uscita di lettura o scrittura.",
    );
  if (
    sequence.some(
      (item, i) =>
        i > 0 && GRAPH_ORDER[sequence[i - 1].id] >= GRAPH_ORDER[item.id],
    )
  )
    throw new Error(
      "Collega i nodi nell’ordine delle operazioni. Colonne, aggregazione e valori sono percorsi alternativi.",
    );
  if (!schema || schema.engine !== engine)
    throw new Error("Apri un database per scegliere una sorgente.");
  const tables = schema.tables.filter(canBrowseData);
  const table = tables.find((item) => objectKey(item) === sequence[0].table);
  if (!table) throw new Error("Scegli la tabella o collezione di partenza.");
  const filterDrafts =
    sequence.find((item) => item.id === "filter")?.filters || [];
  if (filterDrafts.some((filter) => !GRAPH_OPERATORS.includes(filter.operator)))
    throw new Error("Operatore di filtro non disponibile.");
  if (terminal.id === "read") {
    if (sequence.some((item) => item.id === "values"))
      throw new Error("Rimuovi il nodo dei valori per leggere i risultati.");
    const join = sequence.some((item) => item.id === "join");
    const aggregate = sequence.some((item) => item.id === "aggregate");
    if (join && aggregate)
      throw new Error(
        "Componi un JOIN oppure un’aggregazione in questo diagramma.",
      );
    const options = Object.assign(
      {},
      INITIAL_READ,
      ...sequence.map((item) =>
        Object.fromEntries(
          Object.entries(item.options || {}).filter(
            ([, value]) => value !== undefined,
          ),
        ),
      ),
    );
    options.operation = join ? "join" : aggregate ? "aggregate" : "select";
    options.filters = filterDrafts.map((filter) => ({
      column: filter.column,
      operator: filter.operator,
      value: filter.text,
      boundValue:
        engine === "mongodb" ||
        filter.type === "auto" ||
        filter.operator.includes("NULL")
          ? undefined
          : explicitReadValue(filter),
    }));
    const result = buildOperation(engine, table, schema, options);
    return {
      kind: "read" as const,
      query: result.query,
      params:
        engine === "mongodb"
          ? {}
          : Object.fromEntries(
              result.parameters.map((parameter, index) => [
                engine === "postgresql" ? String(index + 1) : parameter.name,
                parameter.value,
              ]),
            ),
    };
  }
  if (
    sequence.some(
      (item) => !["source", "values", "filter", "write"].includes(item.id),
    )
  )
    throw new Error(
      "Per la scrittura usa solo sorgente, filtro, valori e uscita di scrittura.",
    );
  if (/view/i.test(table.kind))
    throw new Error("Scegli una tabella o collezione modificabile.");
  const kind = terminal.operation || "insert";
  const valueDrafts =
    sequence.find((item) => item.id === "values")?.values || [];
  if (kind === "insert" && filterDrafts.length)
    throw new Error("Rimuovi il filtro per inserire un record.");
  if (kind === "delete" && valueDrafts.length)
    throw new Error("Rimuovi i valori per eliminare i record.");
  if (kind !== "insert" && !filterDrafts.length)
    throw new Error("Aggiungi un filtro per modificare o eliminare record.");
  if (kind === "update" && !valueDrafts.length)
    throw new Error("Aggiungi almeno un valore da modificare.");
  if (
    new Set(valueDrafts.map((item) => item.column)).size !== valueDrafts.length
  )
    throw new Error("Inserisci un solo valore per campo.");
  function parseValue(item: ValueDraft) {
    if (!item.column.trim())
      throw new Error("Ogni valore deve avere un nome di campo.");
    const column = table!.columns.find(
      (candidate) => candidate.name === item.column,
    );
    if (!column && engine !== "mongodb")
      throw new Error(`Campo sconosciuto: ${item.column}`);
    if (
      item.type === "json" ||
      (engine === "mongodb" &&
        item.type === "auto" &&
        /objectid/i.test(column?.dataType || ""))
    ) {
      const value =
        item.type === "json" ? item.text : JSON.stringify({ $oid: item.text });
      JSON.parse(value);
      return { type: "json", value } as const;
    }
    if (item.type === "null") return { type: "null" } as const;
    if (
      engine === "mongodb" &&
      item.type === "auto" &&
      /^(int64|long)$/i.test(column?.dataType || "")
    )
      return {
        type: "json",
        value: JSON.stringify({ $numberLong: item.text }),
      } as const;
    const metadata = column ?? {
      name: item.column,
      dataType: "text",
      nullable: true,
      primaryKey: false,
    };
    if (item.type === "text")
      return { type: "text", value: item.text } as const;
    return parseCell(
      item.text,
      item.type === "auto" ? metadata : { ...metadata, dataType: item.type },
      item.type === "auto" ? undefined : { type: item.type },
      false,
    );
  }
  const operation: GraphWrite = {
    table: objectRef(table),
    kind,
    filters: filterDrafts.map((filter) => ({
      column: filter.column,
      operator: filter.operator,
      value: filter.operator.includes("NULL") ? undefined : parseValue(filter),
    })),
    values: Object.fromEntries(
      valueDrafts.map((item) => [item.column, parseValue(item)]),
    ),
  };
  return { kind: "write" as const, operation };
}

function explicitReadValue(filter: FilterDraft): unknown {
  if (filter.type === "text") return filter.text;
  if (filter.type === "null" || filter.type === "auto")
    throw new Error("Scegli un valore esplicito per il confronto.");
  const value = parseCell(
    filter.text,
    {
      name: filter.column,
      dataType: filter.type,
      nullable: true,
      primaryKey: false,
    },
    { type: filter.type },
    false,
  );
  if (value.type === "integer" && Number.isSafeInteger(Number(value.value)))
    return Number(value.value);
  if (value.type === "float") return Number(value.value);
  if (value.type === "boolean") return value.value;
  return value;
}
