import { useEffect, useRef, useState } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowRight,
  Braces,
  Database,
  GitFork,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import { api, executeQuery } from "../api";
import { useConfirmation } from "../components/ConfirmationProvider";
import { Button, Field, Notice, SectionHeader } from "../components/UI";
import type { CellType, Engine, QueryResult, SchemaSnapshot } from "../types";
import { ENGINE_LABELS } from "../types";
import {
  canBrowseData,
  cellText,
  errorMessage,
  objectKey,
  objectLabel,
} from "../utils";
import {
  compileOperationGraph,
  connectGraphNodes,
  GRAPH_LABELS,
  GRAPH_OPERATORS,
  GRAPH_ORDER,
  initialGraph,
  insertGraphNode,
  loadGraphDraft,
  removeGraphNode,
  type FilterDraft,
  type GraphNode,
  type GraphOperator,
  type ValueDraft,
  type WriteKind,
} from "../designer/operationGraph";
import type { ReadOptions } from "../designer/readOperation";
import {
  importGraphQuery,
  type GraphQueryDraft,
} from "../designer/operationGraphImport";
import "@xyflow/react/dist/style.css";
import "../operation-graph.css";

type Props = {
  schema: SchemaSnapshot | null;
  engine: Engine;
  dark: boolean;
  sessionId: string;
  readOnly: boolean;
  workspaceKey?: string;
  queryDraft?: GraphQueryDraft;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onOpenQuery: (
    query: string,
    params: Record<string, unknown>,
    engine: Engine,
  ) => void;
};
type PreparedWrite = {
  query: string;
  parameters: Record<string, unknown>;
  fingerprint: string;
};
type Kind = GraphNode["id"];
const KINDS = Object.keys(GRAPH_LABELS) as Kind[];
const WRITES: Record<WriteKind, string> = {
  insert: "Inserisci",
  update: "Modifica",
  delete: "Elimina",
};
const CELL_TYPES: [CellType | "auto", string][] = [
  ["auto", "Dal tipo del campo"],
  ["text", "Testo"],
  ["integer", "Intero"],
  ["decimal", "Decimale"],
  ["float", "Float"],
  ["boolean", "Booleano"],
  ["datetime", "Data e ora"],
  ["json", "JSON / Extended JSON"],
  ["null", "NULL"],
];

function OperationCard({ id, data, selected }: NodeProps) {
  const kind = id as Kind;
  const terminal = kind === "read" || kind === "write";
  return (
    <div
      className={`operation-card${selected ? " active" : ""}${kind === "write" ? " write" : ""}`}
    >
      {kind !== "source" && (
        <Handle
          type="target"
          position={Position.Left}
          aria-label={`Ingresso: ${GRAPH_LABELS[kind]}`}
        />
      )}
      <div className="operation-card-title">
        {kind === "source" ? <Database size={15} /> : <GitFork size={15} />}
        {GRAPH_LABELS[kind]}
      </div>
      <small title={String(data.detail)}>{String(data.detail)}</small>
      {!terminal && (
        <Handle
          type="source"
          position={Position.Right}
          aria-label={`Uscita: ${GRAPH_LABELS[kind]}`}
        />
      )}
    </div>
  );
}
const NODE_TYPES = { operation: OperationCard };
const CARD_SIZE = { width: 200, height: 68 };

export function OperationGraphView(props: Props) {
  const key = `dbm-operation-graph-v1:${JSON.stringify([props.engine, props.workspaceKey || "", props.schema?.database || ""])}`;
  return <OperationGraph key={key} {...props} storageKey={key} />;
}

function OperationGraph({
  schema,
  engine,
  dark,
  sessionId,
  readOnly,
  queryDraft,
  disabled,
  onBusyChange,
  onOpenQuery,
  storageKey,
}: Props & { storageKey: string }) {
  const [draft, setDraft] = useState(() => loadGraphDraft(storageKey));
  const [selection, setSelection] = useState<Kind>("source");
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<{
    key: string;
    value: PreparedWrite;
  }>();
  const [result, setResult] = useState<{ key: string; value: QueryResult }>();
  const [failure, setFailure] = useState<{ key: string; message: string }>();
  const [importStatus, setImportStatus] = useState<{
    draft: GraphQueryDraft;
    message: string;
    error: boolean;
  }>();
  const confirm = useConfirmation();
  const selectionRef = useRef<string>("");
  const tables = schema?.tables.filter(canBrowseData) || [];
  const table = tables.find(
    (t) =>
      objectKey(t) === draft.nodes.find((item) => item.id === "source")?.table,
  );
  const node = draft.nodes.find((item) => item.id === selection);
  const writes = draft.nodes.some((item) => item.id === "write");
  const terminal = draft.nodes.find((item) => item.id === "write");
  const options = node?.options || {};
  const joinTable = tables.find((t) => objectKey(t) === options.joinTable);
  const grouped = draft.nodes.find((item) => item.id === "aggregate");
  let problem = "";
  let compiled: ReturnType<typeof compileOperationGraph> | undefined;
  try {
    compiled = compileOperationGraph(draft, schema, engine);
  } catch (error) {
    problem = errorMessage(error);
  }
  const executionKey = JSON.stringify([sessionId, readOnly, compiled]);
  selectionRef.current = executionKey;
  const preview = prepared?.key === executionKey ? prepared.value : undefined;
  const actual = result?.key === executionKey ? result.value : undefined;
  const issue = failure?.key === executionKey ? failure.message : "";

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(draft));
    } catch {
      /* storage unavailable */
    }
  }, [draft, storageKey]);

  function patchNode(patch: Partial<GraphNode>) {
    setDraft((old) => ({
      ...old,
      nodes: old.nodes.map((item) =>
        item.id === selection ? { ...item, ...patch } : item,
      ),
    }));
  }
  function patchOptions(patch: Partial<ReadOptions>) {
    patchNode({ options: { ...options, ...patch } });
  }
  function selectSource(tableKey: string) {
    setDraft((old) => ({
      ...old,
      nodes: old.nodes.map((item) => ({
        ...item,
        table: item.id === "source" ? tableKey : item.table,
        options: undefined,
        filters: undefined,
        values: undefined,
      })),
    }));
  }
  function add(kind: Kind) {
    setDraft((old) => insertGraphNode(old, kind));
    setSelection(kind);
  }
  async function loadQuery() {
    if (!queryDraft || busy || disabled) return;
    try {
      const incoming = importGraphQuery(queryDraft, schema, engine);
      compileOperationGraph(incoming, schema, engine);
      if (
        !(await confirm(
          "Sostituire la bozza del diagramma con la query dell’editor?",
        ))
      )
        return;
      setDraft(incoming);
      setSelection("source");
      setPrepared(undefined);
      setResult(undefined);
      setImportStatus({
        draft: queryDraft,
        message:
          "Query importata nel diagramma. La lettura del diagramma applica un limite di 100 righe se la query non ne indica uno.",
        error: false,
      });
    } catch (error) {
      setImportStatus({
        draft: queryDraft,
        message: errorMessage(error),
        error: true,
      });
    }
  }
  async function run(action: "preview" | "execute") {
    if (
      !compiled ||
      !sessionId ||
      busy ||
      disabled ||
      (compiled.kind === "write" && readOnly)
    )
      return;
    setFailure(undefined);
    setBusy(true);
    onBusyChange?.(true);
    try {
      if (compiled.kind === "read") {
        const output = await executeQuery({
          sessionId,
          query: compiled.query,
          parameters: compiled.params,
          executionMode: "script",
        });
        if (selectionRef.current === executionKey)
          setResult({ key: executionKey, value: output });
      } else if (action === "preview") {
        const output = await api<PreparedWrite>("preview_graph_write", {
          sessionId,
          operation: compiled.operation,
        });
        if (selectionRef.current === executionKey)
          setPrepared({ key: executionKey, value: output });
      } else if (
        preview &&
        (await confirm(
          `${WRITES[compiled.operation.kind]} in ${objectLabel(compiled.operation.table)} su ${schema?.database || "database attivo"}. Confermi l’esecuzione del piano mostrato?`,
        ))
      ) {
        if (selectionRef.current !== executionKey) return;
        const output = await api<QueryResult>("execute_graph_write", {
          sessionId,
          operation: compiled.operation,
          fingerprint: preview.fingerprint,
        });
        if (selectionRef.current === executionKey) {
          setResult({ key: executionKey, value: output });
          setPrepared(undefined);
        }
      }
    } catch (error) {
      if (selectionRef.current === executionKey) {
        setFailure({ key: executionKey, message: errorMessage(error) });
        if (compiled.kind === "write") setPrepared(undefined);
      }
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  const detail = (item: GraphNode) => {
    if (item.id === "source")
      return table ? objectLabel(table) : "Seleziona una sorgente";
    if (item.id === "filter") return `${item.filters?.length || 0} condizioni`;
    if (item.id === "values") return `${item.values?.length || 0} valori`;
    if (item.id === "write") return WRITES[item.operation || "insert"];
    if (item.id === "limit") return `${item.options?.limit ?? 100} risultati`;
    if (item.id === "aggregate") return item.options?.aggregate || "COUNT";
    if (item.id === "order")
      return item.options?.orderBy || "Nessun ordinamento";
    if (item.id === "projection")
      return item.options?.columns?.join(", ") || "Tutte le colonne";
    if (item.id === "join")
      return tables.find((t) => objectKey(t) === item.options?.joinTable)
        ? objectLabel(
            tables.find((t) => objectKey(t) === item.options?.joinTable)!,
          )
        : "Seleziona una tabella";
    return "Anteprima dei risultati";
  };
  const simpleFields = (fields = table?.columns || []) =>
    fields.map((column) => <option key={column.name}>{column.name}</option>);
  const availableKinds = KINDS.filter(
    (kind) =>
      !draft.nodes.some((item) => item.id === kind) &&
      (kind !== "join" || engine !== "mongodb") &&
      (kind !== "write" || !readOnly) &&
      (writes
        ? !["join", "projection", "aggregate", "order", "limit"].includes(kind)
        : kind !== "values") &&
      !(kind === "projection" && grouped) &&
      !(
        kind === "aggregate" &&
        draft.nodes.some(
          (item) => item.id === "projection" || item.id === "join",
        )
      ),
  );
  const visibleQuery =
    compiled?.kind === "read" ? compiled.query : preview?.query;
  const visibleParams =
    compiled?.kind === "read" ? compiled.params : preview?.parameters;
  return (
    <div className="view-content operation-graph">
      <SectionHeader
        title="Diagramma operativo"
        description={`${ENGINE_LABELS[engine]} · Collega la sorgente, le trasformazioni e l’uscita.`}
        action={
          <Button
            disabled={busy || disabled}
            onClick={async () => {
              if (
                await confirm(
                  "Sostituire la bozza del diagramma con una nuova?",
                )
              ) {
                setDraft(initialGraph());
                setSelection("source");
                setPrepared(undefined);
                setResult(undefined);
              }
            }}
          >
            Nuovo diagramma
          </Button>
        }
      />
      <div className="operation-add row" aria-label="Aggiungi nodo">
        {availableKinds.map((id) => (
          <Button key={id} onClick={() => add(id)}>
            <Plus size={13} /> {GRAPH_LABELS[id]}
          </Button>
        ))}
      </div>
      {queryDraft && (
        <div className="row">
          <Button disabled={busy || disabled} onClick={() => void loadQuery()}>
            Importa query nel diagramma
          </Button>
          {importStatus?.draft === queryDraft && (
            <Notice tone={importStatus.error ? "error" : "success"}>
              {importStatus.message}
            </Notice>
          )}
        </div>
      )}
      <div className="operation-layout">
        <div
          className="operation-canvas"
          aria-label="Diagramma delle operazioni"
        >
          <ReactFlow
            colorMode={dark ? "dark" : "light"}
            fitView
            minZoom={0.2}
            nodes={draft.nodes.map((item) => ({
              id: item.id,
              type: "operation",
              data: { detail: detail(item) },
              position: item.position,
              ...CARD_SIZE,
              measured: CARD_SIZE,
              selected: item.id === selection,
            }))}
            edges={draft.edges.map((edge) => ({
              ...edge,
              type: "smoothstep",
              markerEnd: { type: MarkerType.ArrowClosed },
            }))}
            nodeTypes={NODE_TYPES}
            nodesDraggable
            deleteKeyCode={null}
            onNodeClick={(_, selected) => setSelection(selected.id as Kind)}
            onNodesChange={(changes) => {
              const moved = changes.filter((change) => change.type === "position");
              if (!moved.length) return;
              setDraft((old) => ({
                ...old,
                nodes: old.nodes.map((item) => {
                  const change = moved.find(
                    (candidate) => candidate.id === item.id,
                  );
                  return change?.type === "position" && change.position
                    ? { ...item, position: change.position }
                    : item;
                }),
              }));
            }}
            isValidConnection={(connection) =>
              GRAPH_ORDER[connection.source as Kind] <
              GRAPH_ORDER[connection.target as Kind]
            }
            onConnect={(connection) =>
              setDraft((old) =>
                connectGraphNodes(
                  old,
                  connection.source as Kind,
                  connection.target as Kind,
                ),
              )
            }
            onEdgeDoubleClick={(_, edge) =>
              setDraft((old) => ({
                ...old,
                edges: old.edges.filter((item) => item.id !== edge.id),
              }))
            }
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>
        <aside
          className="operation-inspector panel stack"
          aria-label="Impostazioni del nodo"
        >
          <Field label="Nodo">
            <select
              value={selection}
              onChange={(event) => setSelection(event.target.value as Kind)}
            >
              {draft.nodes.map((item) => (
                <option key={item.id} value={item.id}>
                  {GRAPH_LABELS[item.id]}
                </option>
              ))}
            </select>
          </Field>
          {node?.id === "source" && (
            <Field label="Sorgente">
              <select
                value={node.table || ""}
                onChange={(event) => selectSource(event.target.value)}
              >
                <option value="">Scegli una tabella o collezione</option>
                {tables.map((item) => (
                  <option key={objectKey(item)} value={objectKey(item)}>
                    {objectLabel(item)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {node?.id === "join" && (
            <>
              <Field label="Tabella collegata">
                <select
                  value={options.joinTable || ""}
                  onChange={(event) =>
                    patchOptions({
                      joinTable: event.target.value,
                      joinForeign: "",
                    })
                  }
                >
                  <option value="">Scegli una tabella</option>
                  {tables
                    .filter((item) => item !== table)
                    .map((item) => (
                      <option value={objectKey(item)} key={objectKey(item)}>
                        {objectLabel(item)}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Tipo di JOIN">
                <select
                  value={options.joinType || "LEFT"}
                  onChange={(event) =>
                    patchOptions({
                      joinType: event.target.value as "LEFT" | "INNER",
                    })
                  }
                >
                  <option>LEFT</option>
                  <option>INNER</option>
                </select>
              </Field>
              <Field label="Colonna della sorgente">
                <select
                  value={options.joinLocal || ""}
                  onChange={(event) =>
                    patchOptions({ joinLocal: event.target.value })
                  }
                >
                  <option value="">Scegli una colonna</option>
                  {simpleFields()}
                </select>
              </Field>
              <Field label="Colonna collegata">
                <select
                  value={options.joinForeign || ""}
                  onChange={(event) =>
                    patchOptions({ joinForeign: event.target.value })
                  }
                >
                  <option value="">Scegli una colonna</option>
                  {simpleFields(joinTable?.columns || [])}
                </select>
              </Field>
            </>
          )}
          {node?.id === "projection" && (
            <Field
              label="Colonne da leggere"
              hint="Seleziona più colonne con Ctrl. Senza selezione la query legge tutte le colonne."
            >
              <select
                multiple
                value={options.columns || []}
                onChange={(event) =>
                  patchOptions({
                    columns: Array.from(
                      event.target.selectedOptions,
                      (item) => item.value,
                    ),
                  })
                }
              >
                {simpleFields()}
              </select>
            </Field>
          )}
          {node?.id === "aggregate" && (
            <>
              <Field label="Funzione">
                <select
                  value={options.aggregate || "COUNT"}
                  onChange={(event) =>
                    patchOptions({ aggregate: event.target.value })
                  }
                >
                  {["COUNT", "SUM", "AVG", "MIN", "MAX"].map((type) => (
                    <option key={type}>{type}</option>
                  ))}
                </select>
              </Field>
              <Field label="Campo del calcolo">
                <select
                  value={options.aggregateColumn || "*"}
                  onChange={(event) =>
                    patchOptions({ aggregateColumn: event.target.value })
                  }
                >
                  <option value="*">Tutte le righe</option>
                  {simpleFields()}
                </select>
              </Field>
              <Field label="Raggruppa per">
                <select
                  multiple
                  value={options.groupBy || []}
                  onChange={(event) =>
                    patchOptions({
                      groupBy: Array.from(
                        event.target.selectedOptions,
                        (item) => item.value,
                      ),
                    })
                  }
                >
                  {simpleFields()}
                </select>
              </Field>
            </>
          )}
          {node?.id === "order" && (
            <>
              <Field label="Ordina per">
                <select
                  value={options.orderBy || ""}
                  onChange={(event) =>
                    patchOptions({ orderBy: event.target.value })
                  }
                >
                  <option value="">Nessun ordinamento</option>
                  {grouped && (
                    <option value={engine === "mongodb" ? "total" : "totale"}>
                      Totale
                    </option>
                  )}
                  {simpleFields(
                    grouped
                      ? table?.columns.filter((column) =>
                          grouped.options?.groupBy?.includes(column.name),
                        ) || []
                      : undefined,
                  )}
                </select>
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!options.descending}
                  onChange={(event) =>
                    patchOptions({ descending: event.target.checked })
                  }
                />
                Ordine decrescente
              </label>
            </>
          )}
          {node?.id === "limit" && (
            <Field label="Numero massimo di risultati">
              <input
                type="number"
                min={1}
                max={10000}
                value={options.limit ?? 100}
                onChange={(event) =>
                  patchOptions({ limit: Number(event.target.value) })
                }
              />
            </Field>
          )}
          {node?.id === "write" && (
            <Field label="Operazione">
              <select
                value={node.operation || "insert"}
                onChange={(event) =>
                  patchNode({ operation: event.target.value as WriteKind })
                }
              >
                {Object.entries(WRITES).map(([name, label]) => (
                  <option key={name} value={name}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(node?.id === "filter" || node?.id === "values") &&
            (() => {
              const filters = node.id === "filter";
              const entries = filters ? node.filters || [] : node.values || [];
              function update(entries: ValueDraft[]) {
                patchNode(
                  filters
                    ? { filters: entries as FilterDraft[] }
                    : { values: entries },
                );
              }
              return (
                <>
                  {entries.map((entry, index) => (
                    <fieldset key={index} className="operation-value stack">
                      <legend>
                        {filters ? "Condizione" : "Valore"} {index + 1}
                      </legend>
                      <Field label="Campo">
                        {engine === "mongodb" && !filters ? (
                          <input
                            value={entry.column}
                            onChange={(event) =>
                              update(
                                entries.map((row, i) =>
                                  i === index
                                    ? { ...row, column: event.target.value }
                                    : row,
                                ),
                              )
                            }
                          />
                        ) : (
                          <select
                            value={entry.column}
                            onChange={(event) =>
                              update(
                                entries.map((row, i) =>
                                  i === index
                                    ? { ...row, column: event.target.value }
                                    : row,
                                ),
                              )
                            }
                          >
                            <option value="">Scegli un campo</option>
                            {simpleFields()}
                          </select>
                        )}
                      </Field>
                      {filters && (
                        <Field label="Confronto">
                          <select
                            value={(entry as FilterDraft).operator}
                            onChange={(event) =>
                              update(
                                entries.map((row, i) =>
                                  i === index
                                    ? {
                                        ...row,
                                        operator: event.target
                                          .value as GraphOperator,
                                      }
                                    : row,
                                ),
                              )
                            }
                          >
                            {GRAPH_OPERATORS.map((operator) => (
                              <option key={operator}>{operator}</option>
                            ))}
                          </select>
                        </Field>
                      )}
                      {!(entry as FilterDraft).operator?.includes("NULL") && (
                        <>
                          {writes && (
                            <Field label="Tipo di valore">
                              <select
                                value={entry.type}
                                onChange={(event) =>
                                  update(
                                    entries.map((row, i) =>
                                      i === index
                                        ? {
                                            ...row,
                                            type: event.target
                                              .value as ValueDraft["type"],
                                          }
                                        : row,
                                    ),
                                  )
                                }
                              >
                                {CELL_TYPES.filter(
                                  ([type]) => type !== "null" || !filters,
                                ).map(([type, label]) => (
                                  <option key={type} value={type}>
                                    {label}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          )}
                          {entry.type !== "null" && (
                            <Field label="Valore">
                              <input
                                value={entry.text}
                                onChange={(event) =>
                                  update(
                                    entries.map((row, i) =>
                                      i === index
                                        ? { ...row, text: event.target.value }
                                        : row,
                                    ),
                                  )
                                }
                              />
                            </Field>
                          )}
                        </>
                      )}
                      <Button
                        onClick={() =>
                          update(entries.filter((_, i) => i !== index))
                        }
                      >
                        <Trash2 size={14} /> Rimuovi
                      </Button>
                    </fieldset>
                  ))}
                  <Button
                    disabled={entries.length >= 32}
                    onClick={() =>
                      update([
                        ...entries,
                        {
                          column: table?.columns[0]?.name || "",
                          text: "",
                          type: "auto",
                          ...(filters ? { operator: "=" } : {}),
                        },
                      ])
                    }
                  >
                    <Plus size={13} />{" "}
                    {filters ? "Aggiungi condizione" : "Aggiungi valore"}
                  </Button>
                </>
              );
            })()}
          {node && node.id !== "source" && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft((old) => removeGraphNode(old, node.id));
                setSelection("source");
              }}
            >
              <Trash2 size={14} /> Rimuovi nodo
            </Button>
          )}
          {node && draft.edges.some((item) => item.source === node.id) && (
            <Button
              variant="ghost"
              onClick={() =>
                setDraft((old) => ({
                  ...old,
                  edges: old.edges.filter((item) => item.source !== node.id),
                }))
              }
            >
              Scollega uscita
            </Button>
          )}
          {node && GRAPH_ORDER[node.id] < GRAPH_ORDER.read && (
            <Field label="Collega l’uscita">
              <select
                value=""
                onChange={(event) =>
                  setDraft((old) =>
                    connectGraphNodes(old, node.id, event.target.value as Kind),
                  )
                }
              >
                <option value="">Scegli il nodo successivo</option>
                {draft.nodes
                  .filter((item) => GRAPH_ORDER[item.id] > GRAPH_ORDER[node.id])
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {GRAPH_LABELS[item.id]}
                    </option>
                  ))}
              </select>
            </Field>
          )}
        </aside>
      </div>
      {problem && <Notice>{problem}</Notice>}
      {issue && <Notice tone="error">{issue}</Notice>}
      {writes && readOnly && (
        <Notice>La connessione attiva è in sola lettura.</Notice>
      )}
      <section className="panel stack operation-output">
        <div className="row">
          <Braces size={16} />
          <strong>
            {writes ? "Piano di scrittura" : "Anteprima della query"}
          </strong>
        </div>
        {visibleQuery && <pre>{visibleQuery}</pre>}
        {visibleParams && !!Object.keys(visibleParams).length && (
          <details>
            <summary>Parametri</summary>
            <pre>{JSON.stringify(visibleParams, null, 2)}</pre>
          </details>
        )}
        <div className="row">
          {compiled?.kind === "read" && (
            <Button
              disabled={busy}
              onClick={() =>
                onOpenQuery(compiled.query, compiled.params, engine)
              }
            >
              Apri nell’editor <ArrowRight size={14} />
            </Button>
          )}
          <Button
            variant="primary"
            disabled={
              !compiled ||
              !sessionId ||
              (writes && readOnly) ||
              busy ||
              disabled
            }
            onClick={() => void run(writes ? "preview" : "execute")}
          >
            <Play size={14} />{" "}
            {busy
              ? "Operazione in corso"
              : writes
                ? "Prepara anteprima"
                : "Esegui lettura"}
          </Button>
          {writes && preview && (
            <Button
              disabled={busy || disabled}
              onClick={() =>
                onOpenQuery(preview.query, preview.parameters, engine)
              }
            >
              Apri script nell’editor <ArrowRight size={14} />
            </Button>
          )}
          {writes && preview && (
            <Button
              variant="danger"
              disabled={busy || readOnly || disabled}
              onClick={() => void run("execute")}
            >
              {WRITES[terminal?.operation || "insert"]} dopo conferma
            </Button>
          )}
        </div>
      </section>
      {actual && (
        <section
          className="panel stack operation-output"
          aria-label="Risultati del diagramma"
        >
          <strong>
            {actual.message ||
              (writes
                ? `${actual.affectedRows} record interessati`
                : "Risultati")}
          </strong>
          {actual.sets.map((set, index) => (
            <div className="operation-results" key={index}>
              <table>
                <thead>
                  <tr>
                    {set.columns.map((column) => (
                      <th key={column.name}>{column.name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {set.rows.slice(0, 100).map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      {set.columns.map((column) => (
                        <td key={column.name}>{cellText(row[column.name])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {(set.truncated || set.rows.length > 100) && (
                <small>
                  Anteprima delle prime 100 righe. Apri la query nell’editor per
                  vedere il risultato completo.
                </small>
              )}
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
