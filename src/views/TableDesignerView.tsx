import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Editor from "@monaco-editor/react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Connection,
} from "@xyflow/react";
import {
  Plus,
  Trash2,
  Copy,
  Code2,
  Database,
  ArrowRight,
  GitFork,
  Table2,
  Download,
  FolderOpen,
  FileCode2,
  LayoutGrid,
} from "lucide-react";
import type {
  Engine,
  ObjectRef,
  SchemaSnapshot,
  Mode,
  TableInfo,
} from "../types";
import { ENGINE_LABELS, ENGINES } from "../types";
import { Button, Field, Modal, Notice, SectionHeader } from "../components/UI";
import {
  DesignerExtras,
  DesignerIndexes,
  INITIAL_DESIGNER,
} from "../components/SchemaBuilders";
import { CodegenView } from "./CodegenView";
import {
  adoptTable,
  buildTableDdl,
  buildProjectDdl,
  buildCreationPlan,
  designObject,
  designObjectKey,
  designReference,
  designSnapshot,
  identifierKey,
  inDesignNamespace,
  linkedDesignTemplate,
  isEditableDesignObject,
  newDesignTable,
  readDesignProject,
  TYPE_CHOICES,
  type DesignTable,
} from "../designer/schemaProject";
import { errorMessage, objectKey } from "../utils";
import { useConfirmation } from "../components/ConfirmationProvider";
import {
  buildMigrationPlan,
  editExistingTable,
  rebaseAppliedDesign,
} from "../designer/schemaMigration";
import {
  previewSchemaImport,
  type SchemaImportRequest,
} from "../designer/schemaImport";
import "../designer.css";

function flowIdentifier(value: string) {
  return encodeURIComponent(value).replaceAll("'", "%27");
}
function draftNodeId(draft: Pick<DesignTable, "id">) {
  return `draft:${flowIdentifier(draft.id)}`;
}
function liveNodeId(object: ObjectRef) {
  return `live:${flowIdentifier(objectKey(object))}`;
}
function columnPortId(name: string) {
  return `column:${flowIdentifier(name)}`;
}

function DesignNode({
  data,
}: {
  data: {
    name: string;
    columns: { name: string; dataType: string; primaryKey: boolean }[];
    origin?: boolean;
    badge: string;
  };
}) {
  return (
    <div className={`design-graph-table ${data.origin ? "origin" : ""}`}>
      <strong title={data.name}>{data.name}</strong>
      <small className="design-graph-kind">{data.badge}</small>
      {data.columns.map((c) => (
        <div key={c.name}>
          <Handle
            type="target"
            position={Position.Left}
            id={columnPortId(c.name)}
            aria-label={`Collega a ${data.name}.${c.name}`}
            title={`Destinazione: ${data.name}.${c.name}`}
          />
          <span>
            {c.primaryKey ? "◆ " : ""}
            {c.name}
          </span>
          <small>{c.dataType}</small>
          <Handle
            type="source"
            position={Position.Right}
            id={columnPortId(c.name)}
            aria-label={`Collega da ${data.name}.${c.name}`}
            title={`Origine: ${data.name}.${c.name}`}
            isConnectable={data.origin}
          />
        </div>
      ))}
    </div>
  );
}
const NODE_TYPES = { design: DesignNode };
function DiagramContainer({
  expanded,
  onClose,
  children,
}: {
  expanded: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return expanded ? (
    <Modal title="Relazioni del database" fullScreen onClose={onClose}>
      <div className="designer-expanded-canvas">{children}</div>
    </Modal>
  ) : (
    <>{children}</>
  );
}
const STORAGE_KEY = "dbm-schema-design-v2";
const REFERENCE_POSITIONS_KEY = "dbm-schema-reference-positions";

function loadSavedDesign(engine?: Engine) {
  try {
    const key = engine ? `${STORAGE_KEY}:${engine}` : STORAGE_KEY;
    const project = readDesignProject(
      JSON.parse(localStorage.getItem(key) || "null"),
    );
    if (!engine || project.engine === engine) return project;
  } catch {}
  return null;
}

function loadReferencePositions(): Record<string, { x: number; y: number }> {
  try {
    const saved = JSON.parse(
      localStorage.getItem(REFERENCE_POSITIONS_KEY) || "{}",
    );
    return Object.fromEntries(
      Object.entries(saved).filter(([, position]) => {
        const value = position as { x?: number; y?: number } | null;
        return value && Number.isFinite(value.x) && Number.isFinite(value.y);
      }),
    ) as Record<string, { x: number; y: number }>;
  } catch {
    return {};
  }
}
export function TableDesignerView({
  engine,
  schema,
  mode,
  dark,
  connected,
  readOnly,
  onApply,
  onOpenQuery,
  onCreated,
  schemaImport,
  onSchemaImportHandled,
}: {
  engine: Engine;
  schema: SchemaSnapshot | null;
  mode: Mode;
  dark: boolean;
  connected: boolean;
  readOnly: boolean;
  onApply: (
    script: string,
    engine: Engine,
    expectedSchema?: SchemaSnapshot | null,
    rebuildSqlite?: boolean,
  ) => Promise<SchemaSnapshot>;
  onOpenQuery: (
    query: string,
    parameters: Record<string, unknown>,
    engine: Engine,
  ) => void;
  onCreated?: (table: TableInfo) => void;
  schemaImport?: SchemaImportRequest | null;
  onSchemaImportHandled?: () => void;
}) {
  const confirm = useConfirmation();
  const [saved] = useState(() => loadSavedDesign());
  const [projectEngine, setProjectEngine] = useState<Engine>(
    () => saved?.engine || engine,
  );
  const [tables, setTables] = useState<DesignTable[]>(
    () => saved?.tables || [newDesignTable(engine)],
  );
  const [selected, setSelected] = useState(tables[0]?.id || "");
  const [tab, setTab] = useState("structure");
  const [sqlScope, setSqlScope] = useState<"pending" | "project" | "changes">(
    "pending",
  );
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [graphExpanded, setGraphExpanded] = useState(false);
  const [referencePositions, setReferencePositions] = useState(
    loadReferencePositions,
  );
  const [importRequest, setImportRequest] =
    useState<SchemaImportRequest | null>(null);
  const [validateImport, setValidateImport] = useState(false);
  const [currentSchema, setCurrentSchema] = useState(schema);
  useEffect(() => setCurrentSchema(schema), [schema]);
  useEffect(() => {
    if (!schemaImport) return;
    setImportRequest(schemaImport);
    setValidateImport(true);
    onSchemaImportHandled?.();
  }, [schemaImport, onSchemaImportHandled]);
  useEffect(() => {
    try {
      localStorage.setItem(
        REFERENCE_POSITIONS_KEY,
        JSON.stringify(
          Object.fromEntries(Object.entries(referencePositions).slice(-800)),
        ),
      );
    } catch {}
  }, [referencePositions]);
  useEffect(() => {
    try {
      const project = JSON.stringify({ engine: projectEngine, tables });
      localStorage.setItem(STORAGE_KEY, project);
      localStorage.setItem(`${STORAGE_KEY}:${projectEngine}`, project);
    } catch {
      setError(
        "Impossibile conservare automaticamente il progetto. Usa Salva progetto per esportare la bozza.",
      );
    }
    setReviewed(false);
  }, [tables, projectEngine]);
  const table = tables.find((t) => t.id === selected) || tables[0];
  const describe = (item: ObjectRef) => {
    const { name, schema } = designObject(projectEngine, item);
    return schema ? `${schema}.${name}` : name;
  };
  const namespace = designObject(projectEngine, table).schema;
  const namespaces = [
    ...new Set([
      "public",
      ...(currentSchema?.engine === "postgresql"
        ? currentSchema.namespaces ||
          currentSchema.tables.flatMap((item) =>
            item.schema ? [item.schema] : [],
          )
        : []),
      ...tables
        .map((item) => item.schema)
        .filter((item): item is string => !!item),
    ]),
  ];
  const importPreview = useMemo(
    () =>
      validateImport && importRequest
        ? previewSchemaImport(importRequest)
        : null,
    [importRequest, validateImport],
  );
  function replaceProject(engine: Engine, next: DesignTable[]) {
    setProjectEngine(engine);
    setTables(next);
    setSelected(next[0].id);
    setTab("structure");
    setSqlScope("pending");
    setError("");
    setMessage("");
  }
  function update(patch: Partial<DesignTable>) {
    if (busy) return;
    const renamed = patch.name ?? table.name;
    const originalRef = designObjectKey(projectEngine, table);
    const renamedRef = designObject(projectEngine, { ...table, ...patch });
    const renames = new Map<string, string>();
    if (patch.columns?.length === table.columns.length)
      patch.columns.forEach((c, i) => {
        if (c.name !== table.columns[i].name)
          renames.set(table.columns[i].name, c.name);
      });
    setTables((old) =>
      old.map((t) => {
        const next = t.id === table.id ? { ...t, ...patch } : t;
        return {
          ...next,
          options: {
            ...next.options,
            keys: next.options.keys.map((k) => {
              const target = designReference(projectEngine, t, k);
              const isRenamed =
                designObjectKey(projectEngine, target) === originalRef;
              return {
                ...k,
                column:
                  t.id === table.id
                    ? (renames.get(k.column) ?? k.column)
                    : k.column,
                table: isRenamed ? renamed : k.table,
                targetSchema: isRenamed ? renamedRef.schema : target.schema,
                targetColumn: isRenamed
                  ? (renames.get(k.targetColumn) ?? k.targetColumn)
                  : k.targetColumn,
              };
            }),
            indexes: next.options.indexes.map((i) => ({
              ...i,
              columns:
                t.id === table.id
                  ? i.columns
                      .split(",")
                      .map((c) => renames.get(c.trim()) ?? c.trim())
                      .join(", ")
                  : i.columns,
            })),
          },
        };
      }),
    );
    setMessage("");
  }
  const built = useMemo(() => {
    try {
      return {
        sql: buildProjectDdl(projectEngine, tables),
        schema: designSnapshot(projectEngine, tables),
        error: "",
      };
    } catch (e) {
      return { sql: "", schema: null, error: errorMessage(e) };
    }
  }, [tables, projectEngine]);
  const creation = useMemo(() => {
    try {
      return {
        ...buildCreationPlan(
          projectEngine,
          tables.filter((table) => !table.source),
          currentSchema,
        ),
        error: "",
      };
    } catch (e) {
      return {
        pendingTables: [] as DesignTable[],
        sql: "",
        error: errorMessage(e),
      };
    }
  }, [projectEngine, tables, currentSchema]);
  const { pendingTables } = creation;
  const migration = useMemo(() => {
    try {
      return buildMigrationPlan(projectEngine, tables, currentSchema);
    } catch (error) {
      return {
        changes: [],
        blockers: [errorMessage(error)],
        warnings: [],
        sql: "",
        rebuildSqlite: false,
        affectedTableIds: [],
      };
    }
  }, [projectEngine, tables, currentSchema]);
  const displayedSql =
    sqlScope === "changes"
      ? migration.sql
      : sqlScope === "project"
        ? built.sql
        : creation.sql;
  const scriptError =
    sqlScope === "changes"
      ? migration.blockers.join(" ")
      : sqlScope === "project"
        ? built.error
        : creation.error;
  const applyingMigration = sqlScope === "changes";
  const destructive =
    applyingMigration && migration.changes.some((change) => change.destructive);
  const hasChanges = applyingMigration
    ? !!migration.changes.length
    : !!pendingTables.length;
  const conflicts =
    sqlScope === "project" && pendingTables.length !== tables.length;
  useEffect(() => {
    setReviewed(false);
    setAllowDestructive(false);
  }, [displayedSql, currentSchema, connected, readOnly, engine]);
  const currentRelations = (
    currentSchema?.engine === projectEngine ? currentSchema.tables : []
  ).filter(
    (t) =>
      (isEditableDesignObject(t) || t.kind === "view") &&
      !!currentSchema &&
      inDesignNamespace(currentSchema, t),
  );
  const selectedLive = currentRelations.find(
    (item) =>
      designObjectKey(projectEngine, item) ===
      designObjectKey(projectEngine, table),
  );
  const normalized = (name: string) => identifierKey(projectEngine, name);
  const sourceTables = [
    ...tables.map((t) => ({
      ...designObject(projectEngine, t),
      columns: t.columns,
      kind: "table",
      indexes: [],
      foreignKeys: [],
    })),
    ...currentRelations
      .filter(
        (t) =>
          !tables.some(
            (p) =>
              designObjectKey(projectEngine, p) ===
              designObjectKey(projectEngine, t),
          ),
      )
      .map((t) => ({ ...t, ...designObject(projectEngine, t) })),
  ];
  const referencePositionKey = (relation: TableInfo) =>
    JSON.stringify([
      projectEngine,
      currentSchema?.database,
      objectKey(relation),
    ]);
  function editTable(source: TableInfo) {
    if (busy) return;
    try {
      const existing = tables.find(
        (t) => t.source && objectKey(t.source) === objectKey(source),
      );
      if (existing) {
        setSelected(existing.id);
        setTab("structure");
        return;
      }
      if (
        tables.some(
          (t) =>
            designObjectKey(projectEngine, t) ===
            designObjectKey(projectEngine, source),
        )
      ) {
        setError(
          `Il progetto contiene già una bozza chiamata ${describe(source)}. Rinominane una prima di importare la struttura esistente.`,
        );
        return;
      }
      const draft = editExistingTable(source, projectEngine);
      draft.position = referencePositions[referencePositionKey(source)];
      setTables((old) => [...old, draft]);
      setSelected(draft.id);
      setTab("structure");
      setSqlScope("changes");
      setError("");
      setMessage(
        "Struttura esistente nel progetto. Le modifiche saranno applicate solo dopo la revisione del piano.",
      );
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function loadExistingSchema() {
    if (
      !(await confirm(
        "Caricare le tabelle del database nel progetto visuale? Il progetto corrente verrà sostituito: usa Salva progetto se vuoi conservarne una copia.",
      ))
    )
      return;
    try {
      const skipped: string[] = [];
      const loaded = currentRelations
        .filter(isEditableDesignObject)
        .flatMap((source) => {
          try {
            const draft = editExistingTable(source, projectEngine);
            draft.position = referencePositions[referencePositionKey(source)];
            return [draft];
          } catch (error) {
            skipped.push(`${describe(source)}: ${errorMessage(error)}`);
            return [];
          }
        });
      if (!loaded.length)
        throw new Error(
          skipped.join(" ") ||
            "Non ci sono strutture modificabili da caricare.",
        );
      if (loaded.length > 100)
        throw new Error(
          "Il progetto supporta fino a 100 strutture. Seleziona singolarmente quelle da modificare.",
        );
      setTables(loaded);
      setSelected(loaded[0].id);
      setSqlScope("changes");
      setError(skipped.join(" "));
      setMessage(
        "Schema caricato dal database: modifica campi o relazioni e rivedi il piano prima di applicarlo.",
      );
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  const graph = useMemo(() => {
    const liveObjects = currentRelations.filter(
      (item) =>
        !tables.some(
          (draft) =>
            designObjectKey(projectEngine, draft) ===
            designObjectKey(projectEngine, item),
        ),
    );
    const items = [
      ...tables.map((draft) => ({
        id: draftNodeId(draft),
        name: draft.name,
        schema: draft.schema,
        columns: draft.columns,
        origin: true,
        badge: draft.source ? "Struttura in modifica" : "Bozza",
        position: draft.position,
      })),
      ...liveObjects.map((relation) => ({
        id: liveNodeId(relation),
        name: relation.name,
        schema: relation.schema,
        columns: relation.columns,
        origin: false,
        badge: relation.kind === "view" ? "Vista" : "Nel database",
        position: referencePositions[referencePositionKey(relation)],
      })),
    ];
    const byName = new Map(
      items.map((item) => [designObjectKey(projectEngine, item), item.id]),
    );
    const rowTops = [0];
    for (let start = 0; start < items.length; start += 3) {
      const height = Math.max(
        190,
        ...items
          .slice(start, start + 3)
          .map((item) => 100 + item.columns.length * 28),
      );
      rowTops.push(rowTops[rowTops.length - 1] + height);
    }
    const nodes = items.map((item, i) => ({
      id: item.id,
      type: "design",
      position: item.position || {
        x: (i % 3) * 340,
        y: rowTops[Math.floor(i / 3)],
      },
      data: {
        name: item.name ? describe(item) : "Struttura senza nome",
        object: designObject(projectEngine, item),
        columns: [
          ...new Map(
            item.columns.map((column) => [column.name, column]),
          ).values(),
        ],
        origin: item.origin,
        badge: item.badge,
      },
    }));
    const edges = tables.flatMap((t) =>
      t.options.keys.flatMap((k, i) => {
        const target = byName.get(
          designObjectKey(projectEngine, designReference(projectEngine, t, k)),
        );
        if (!target || !k.column || !k.targetColumn) return [];
        return [
          {
            id: `${draftNodeId(t)}:${i}`,
            source: draftNodeId(t),
            sourceHandle: columnPortId(k.column),
            target,
            targetHandle: columnPortId(k.targetColumn),
            label: `${k.column} → ${k.targetColumn}`,
            markerEnd: { type: MarkerType.ArrowClosed },
          },
        ];
      }),
    );
    const referenceEdges = liveObjects.flatMap((relation) =>
      relation.foreignKeys.flatMap((key, index) => {
        const target = byName.get(
          designObjectKey(projectEngine, {
            name: key.referencedTable || "",
            schema: key.referencedSchema || relation.schema,
          }),
        );
        const from = key.columns || (key.column ? [key.column] : []);
        const to =
          key.referencedColumns ||
          (key.referencedColumn ? [key.referencedColumn] : []);
        if (!target) return [];
        return from.flatMap((column, pair) =>
          to[pair]
            ? [
                {
                  id: `${liveNodeId(relation)}:${index}:${pair}`,
                  source: liveNodeId(relation),
                  sourceHandle: columnPortId(column),
                  target,
                  targetHandle: columnPortId(to[pair]),
                  style: { strokeDasharray: "5 4" },
                  markerEnd: { type: MarkerType.ArrowClosed },
                },
              ]
            : [],
        );
      }),
    );
    return { nodes, edges: [...edges, ...referenceEdges], liveObjects };
  }, [tables, currentSchema, projectEngine, referencePositions]);
  function connectRelation(c: Connection) {
    if (busy) return;
    const source = tables.find((t) => draftNodeId(t) === c.source);
    const target = graph.nodes.find((node) => node.id === c.target);
    if (!source || !target || !c.sourceHandle || !c.targetHandle) return;
    if (
      projectEngine !== "mongodb" &&
      graph.liveObjects.some(
        (item) => liveNodeId(item) === c.target && item.kind === "view",
      )
    ) {
      setError("Una chiave esterna richiede una tabella come destinazione.");
      return;
    }
    const targetRef = target.data.object;
    const sourceColumn = source.columns.find(
      (column) => columnPortId(column.name) === c.sourceHandle,
    );
    const targetColumn = target.data.columns.find(
      (column) => columnPortId(column.name) === c.targetHandle,
    );
    if (!sourceColumn || !targetColumn) return;
    setTables((old) =>
      old.map((t) =>
        t.id === source.id
          ? {
              ...t,
              options: {
                ...t.options,
                keys: [
                  ...t.options.keys.filter(
                    (k) =>
                      !(
                        k.column === sourceColumn.name &&
                        designObjectKey(
                          projectEngine,
                          designReference(projectEngine, source, k),
                        ) === designObjectKey(projectEngine, targetRef) &&
                        k.targetColumn === targetColumn.name
                      ),
                  ),
                  {
                    column: sourceColumn.name,
                    table: targetRef.name,
                    targetSchema: targetRef.schema,
                    targetColumn: targetColumn.name,
                  },
                ],
              },
            }
          : t,
      ),
    );
    setError("");
  }
  async function apply() {
    if (
      !displayedSql ||
      scriptError ||
      !reviewed ||
      !connected ||
      readOnly ||
      projectEngine !== engine ||
      conflicts ||
      !hasChanges ||
      (destructive && !allowDestructive) ||
      busy
    )
      return;
    const appliedIds = new Set(
      applyingMigration
        ? migration.affectedTableIds
        : pendingTables.map((draft) => draft.id),
    );
    setBusy(true);
    setError("");
    try {
      const next = await onApply(
        displayedSql,
        projectEngine,
        currentSchema,
        applyingMigration && migration.rebuildSqlite,
      );
      setCurrentSchema(next);
      setTables((old) => rebaseAppliedDesign(old, tables, appliedIds, next));
      setMessage(
        "Piano applicato e schema riletto dal database. Puoi aprire i dati o generare il codice.",
      );
      setReviewed(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(displayedSql);
      setMessage("Script copiato negli appunti.");
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function importProject(file: File) {
    setError("");
    try {
      if (file.size > 1024 * 1024)
        throw new Error("Il file progetto supera 1 MiB.");
      const p = readDesignProject(JSON.parse(await file.text()));
      if (
        !(await confirm(
          `Caricare ${file.name} al posto del progetto ${ENGINE_LABELS[p.engine]} corrente?`,
        ))
      )
        return;
      replaceProject(p.engine, p.tables);
      if (p.tables.some((table) => table.source)) setSqlScope("changes");
      setMessage(
        "Progetto caricato. Nessuna modifica è stata applicata al database.",
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function startSourceImport() {
    setImportRequest({
      id: crypto.randomUUID(),
      name: "",
      source: "",
      format: projectEngine === "mongodb" ? "mongodb" : "sql",
      engine: projectEngine,
    });
    setValidateImport(false);
  }
  async function acceptSourceImport() {
    if (!importPreview?.tables.length || !importRequest) return;
    const suffix = importPreview.issues.length
      ? " Le istruzioni segnalate resteranno nel sorgente originale."
      : "";
    if (
      !(await confirm(
        `Sostituire il progetto ${ENGINE_LABELS[importPreview.engine]} con le ${importPreview.tables.length} strutture dell’anteprima?${suffix}`,
      ))
    )
      return;
    replaceProject(importPreview.engine, importPreview.tables);
    setImportRequest(null);
    setMessage(
      "Strutture importate nella bozza. Rivedi campi, relazioni e destinazione prima dell’applicazione.",
    );
  }
  function download(content: string, name: string, type: string) {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function saveProject() {
    download(
      JSON.stringify({ version: 1, engine: projectEngine, tables }, null, 2),
      "progetto-database.json",
      "application/json",
    );
  }
  function showGraphNode(id: string) {
    const draft = tables.find((item) => draftNodeId(item) === id);
    const reference = graph.liveObjects.find((item) => liveNodeId(item) === id);
    if (draft) {
      setSelected(draft.id);
      setTab("structure");
      setGraphExpanded(false);
    } else if (reference && isEditableDesignObject(reference)) {
      editTable(reference);
      setGraphExpanded(false);
    } else if (reference) {
      onCreated?.(reference);
      setGraphExpanded(false);
    }
  }
  return (
    <div className={`view-content designer-workbench designer-tab-${tab}`}>
      <SectionHeader
        eyebrow="DAL DISEGNO AL DATABASE E AL CODICE"
        title="Designer database"
        description="Crea tabelle, campi, chiavi, relazioni e indici. Lo script e il codice applicativo derivano dallo stesso progetto."
      />
      <div className="designer-project-bar">
        <Field label="Motore del progetto">
          <select
            value={projectEngine}
            disabled={busy}
            onChange={(e) => {
              const nextEngine = e.target.value as Engine;
              replaceProject(
                nextEngine,
                loadSavedDesign(nextEngine)?.tables || [
                  newDesignTable(nextEngine),
                ],
              );
            }}
          >
            {ENGINES.map((e) => (
              <option value={e} key={e}>
                {ENGINE_LABELS[e]}
              </option>
            ))}
          </select>
        </Field>
        <Button
          disabled={busy || tables.length >= 100}
          onClick={() => {
            let index = tables.length + 1;
            while (
              tables.some(
                (item) =>
                  designObjectKey(projectEngine, item) ===
                  designObjectKey(projectEngine, {
                    name: `tabella_${index}`,
                    schema: namespace,
                  }),
              )
            )
              index++;
            const t = newDesignTable(projectEngine, index);
            t.schema = namespace;
            setTables([...tables, t]);
            setSelected(t.id);
            setTab("structure");
          }}
        >
          <Plus size={15} />
          {projectEngine === "mongodb" ? "Nuova collezione" : "Nuova tabella"}
        </Button>
        <Button onClick={saveProject}>
          <Download size={15} />
          Salva progetto
        </Button>
        <Button
          disabled={
            !currentSchema || projectEngine !== currentSchema.engine || busy
          }
          onClick={() => void loadExistingSchema()}
        >
          <Database size={15} /> Carica schema esistente
        </Button>
        <label className="button secondary">
          <FolderOpen size={15} />
          Apri progetto
          <input
            type="file"
            accept="application/json,.json"
            disabled={busy}
            hidden
            onChange={(event) => {
              const f = event.target.files?.[0];
              if (f) void importProject(f);
              event.target.value = "";
            }}
          />
        </label>
        <Button onClick={startSourceImport} disabled={busy}>
          <FileCode2 size={15} /> Importa schema da codice
        </Button>
        <Button
          disabled={busy}
          onClick={async () => {
            if (
              !(await confirm(
                "Caricare il modello Contatti e note al posto del progetto corrente?",
              ))
            )
              return;
            replaceProject(projectEngine, linkedDesignTemplate(projectEngine));
            setTab("relations");
          }}
        >
          <GitFork size={15} /> Modello Contatti e note
        </Button>
        <span className="spacer" />
        <span className="badge">{tables.length} strutture nel progetto</span>
      </div>
      <div className="designer-steps">
        {[
          ["structure", "Campi e vincoli", Table2],
          ["relations", "Relazioni grafiche", GitFork],
          ["sql", "Script e creazione", Database],
          ["code", "Codice applicativo", Code2],
        ].map(([id, label, Icon]) => {
          const I = Icon as typeof Table2;
          return (
            <button
              key={String(id)}
              className={tab === id ? "active" : ""}
              disabled={busy}
              onClick={() => setTab(String(id))}
            >
              <I size={16} />
              {String(label)}
            </button>
          );
        })}
      </div>
      {(error ||
        (tab === "sql" && scriptError) ||
        (tab === "code" && built.error)) && (
        <Notice tone="error">
          {error || (tab === "code" ? built.error : scriptError)}
        </Notice>
      )}
      {message && <Notice tone="success">{message}</Notice>}
      {tab === "structure" && (
        <div className="designer-columns-layout">
          <aside className="panel stack">
            <h3>Progetto</h3>
            {tables.map((t) => (
              <button
                className={`designer-table-choice ${t.id === table.id ? "active" : ""}`}
                key={t.id}
                onClick={() => setSelected(t.id)}
              >
                <Table2 size={15} />
                {describe(t)}
                <small>{t.columns.length} campi</small>
              </button>
            ))}
            {currentRelations.some(isEditableDesignObject) && (
              <Field label="Modifica una struttura esistente">
                <select
                  value=""
                  disabled={busy || tables.length >= 100}
                  onChange={(event) => {
                    const source = currentRelations.find(
                      (t) => objectKey(t) === event.target.value,
                    );
                    if (source) editTable(source);
                  }}
                >
                  <option value="">Scegli una tabella da modificare</option>
                  {currentRelations.filter(isEditableDesignObject).map((t) => (
                    <option key={objectKey(t)} value={objectKey(t)}>
                      {describe(t)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {currentRelations.filter((t) => t.columns.length > 0).length >
              0 && (
              <Field label="Copia una struttura esistente">
                <select
                  value=""
                  disabled={busy || tables.length >= 100}
                  onChange={(e) => {
                    const found = currentRelations.find(
                      (t) => objectKey(t) === e.target.value,
                    );
                    if (found) {
                      try {
                        const t = adoptTable(found, projectEngine);
                        let copy = `${found.name}_copia`;
                        let number = 2;
                        while (
                          tables.some(
                            (item) =>
                              designObjectKey(projectEngine, item) ===
                              designObjectKey(projectEngine, {
                                name: copy,
                                schema: t.schema,
                              }),
                          )
                        )
                          copy = `${found.name}_copia_${number++}`;
                        t.name = copy;
                        setTables([...tables, t]);
                        setSelected(t.id);
                        setError("");
                      } catch (e) {
                        setError(errorMessage(e));
                      }
                    }
                  }}
                >
                  <option value="">Scegli una tabella</option>
                  {currentRelations
                    .filter((t) => t.columns.length)
                    .map((t) => (
                      <option key={objectKey(t)} value={objectKey(t)}>
                        {describe(t)}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            <p className="muted small">
              Le strutture del progetto restano separate dal database finché
              scegli Crea nel database.
            </p>
          </aside>
          <section className="panel stack">
            {table.source && (
              <Notice>
                Modifica di <strong>{describe(table.source)}</strong> nel
                database esistente. Rimozioni e conversioni compaiono nel piano
                di migrazione; rimuovere una tabella dal progetto non elimina il
                database.
              </Notice>
            )}
            <div className="row">
              <Field
                label={
                  projectEngine === "mongodb"
                    ? "Nome collezione"
                    : "Nome tabella"
                }
              >
                <input
                  value={table.name}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </Field>
              {projectEngine === "postgresql" && (
                <Field label="Schema PostgreSQL">
                  <input
                    value={table.schema ?? "public"}
                    disabled={!!table.source}
                    list="designer-postgresql-schemas"
                    onChange={(event) => update({ schema: event.target.value })}
                  />
                  <datalist id="designer-postgresql-schemas">
                    {namespaces.map((item) => (
                      <option key={item} value={item} />
                    ))}
                  </datalist>
                </Field>
              )}
              <span className="spacer" />
              <Button
                variant="danger"
                disabled={tables.length === 1 || busy}
                onClick={() => {
                  setTables(
                    tables
                      .filter((t) => t.id !== table.id)
                      .map((t) => ({
                        ...t,
                        options: {
                          ...t.options,
                          keys: t.options.keys.filter(
                            (k) =>
                              designObjectKey(
                                projectEngine,
                                designReference(projectEngine, t, k),
                              ) !== designObjectKey(projectEngine, table),
                          ),
                        },
                      })),
                  );
                  setSelected("");
                }}
              >
                <Trash2 size={14} />
                Rimuovi dal progetto
              </Button>
            </div>
            {projectEngine === "postgresql" && !table.source && (
              <label className="check">
                <input
                  type="checkbox"
                  checked={!!table.createSchema}
                  onChange={(event) =>
                    update({ createSchema: event.target.checked })
                  }
                />
                Crea lo schema se manca
              </label>
            )}
            <div className="schema-fields-scroll">
              <table className="schema-fields">
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Tipo</th>
                    {projectEngine !== "mongodb" && <th>PK</th>}
                    <th>NULL</th>
                    <th>Univoco</th>
                    {projectEngine !== "mongodb" && <th>Identità</th>}
                    {projectEngine !== "mongodb" && <th>Predefinito</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {table.columns.map((c, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          aria-label={`Nome campo ${i + 1}`}
                          value={c.name}
                          onChange={(e) =>
                            update({
                              columns: table.columns.map((v, j) =>
                                j === i ? { ...v, name: e.target.value } : v,
                              ),
                            })
                          }
                        />
                      </td>
                      <td>
                        <input
                          list={`types-${projectEngine}`}
                          aria-label={`Tipo campo ${i + 1}`}
                          value={c.dataType}
                          onChange={(e) =>
                            update({
                              columns: table.columns.map((v, j) =>
                                j === i
                                  ? { ...v, dataType: e.target.value }
                                  : v,
                              ),
                            })
                          }
                        />
                      </td>
                      {(
                        [
                          "primaryKey",
                          "nullable",
                          "unique",
                          "autoIncrement",
                        ] as const
                      )
                        .filter(
                          (key) =>
                            projectEngine !== "mongodb" ||
                            key === "nullable" ||
                            key === "unique",
                        )
                        .map((key) => (
                          <td key={key}>
                            <input
                              type="checkbox"
                              aria-label={`${key} campo ${i + 1}`}
                              disabled={
                                (key === "nullable" || key === "unique") &&
                                c.primaryKey
                              }
                              checked={!!c[key]}
                              onChange={(e) =>
                                update({
                                  columns: table.columns.map((v, j) =>
                                    j === i
                                      ? {
                                          ...v,
                                          [key]: e.target.checked,
                                          ...(key === "primaryKey" &&
                                          e.target.checked
                                            ? { nullable: false }
                                            : {}),
                                        }
                                      : v,
                                  ),
                                })
                              }
                            />
                          </td>
                        ))}
                      {projectEngine !== "mongodb" && (
                        <td>
                          <input
                            aria-label={`Predefinito campo ${i + 1}`}
                            value={c.defaultValue || ""}
                            disabled={c.autoIncrement}
                            placeholder="es. CURRENT_TIMESTAMP"
                            onChange={(e) =>
                              update({
                                columns: table.columns.map((v, j) =>
                                  j === i
                                    ? {
                                        ...v,
                                        defaultValue:
                                          e.target.value || undefined,
                                      }
                                    : v,
                                ),
                              })
                            }
                          />
                        </td>
                      )}
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`Rimuovi campo ${i + 1}`}
                          onClick={() =>
                            update({
                              columns: table.columns.filter((_, j) => j !== i),
                            })
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <datalist id={`types-${projectEngine}`}>
                {TYPE_CHOICES[projectEngine].map((t) => (
                  <option value={t} key={t} />
                ))}
              </datalist>
            </div>
            <div className="row">
              <Button
                disabled={table.columns.length >= 500}
                onClick={() => {
                  let index = table.columns.length + 1;
                  while (
                    table.columns.some(
                      (column) =>
                        normalized(column.name) ===
                        normalized(`campo_${index}`),
                    )
                  )
                    index++;
                  update({
                    columns: [
                      ...table.columns,
                      {
                        name: `campo_${index}`,
                        dataType:
                          projectEngine === "mongodb" ? "string" : "TEXT",
                        nullable: true,
                        primaryKey: false,
                      },
                    ],
                  });
                }}
              >
                <Plus size={14} />
                Aggiungi campo
              </Button>
              <Button onClick={() => setTab("sql")}>
                Vedi lo script
                <ArrowRight size={14} />
              </Button>
            </div>
            {projectEngine !== "mongodb" ? (
              <DesignerExtras
                engine={projectEngine}
                tableName={table.name}
                tableSchema={namespace}
                columns={table.columns}
                tables={sourceTables}
                options={table.options}
                onChange={(options) => update({ options })}
                onColumns={(columns) => update({ columns })}
                hideDefaults
              />
            ) : (
              <div className="stack">
                <Field label="Convalida documenti">
                  <select
                    value={
                      table.mongo?.validate === false
                        ? "none"
                        : table.options.customValidator
                          ? "json"
                          : "fields"
                    }
                    onChange={(event) => {
                      const choice = event.target.value;
                      let validator = table.options.validator;
                      if (
                        choice === "json" &&
                        validator === INITIAL_DESIGNER.validator
                      ) {
                        try {
                          const doc = JSON.parse(
                            buildTableDdl("mongodb", {
                              ...table,
                              mongo: { ...table.mongo, validate: true },
                              options: {
                                ...table.options,
                                customValidator: false,
                              },
                            }),
                          );
                          validator = JSON.stringify(
                            (Array.isArray(doc) ? doc[0] : doc).validator,
                            null,
                            2,
                          );
                        } catch (error) {
                          setError(errorMessage(error));
                          return;
                        }
                      }
                      update({
                        mongo: { ...table.mongo, validate: choice !== "none" },
                        options: {
                          ...table.options,
                          customValidator: choice === "json",
                          validator,
                        },
                      });
                      setError("");
                    }}
                  >
                    <option value="none">Senza validatore</option>
                    <option value="fields">
                      Regole dai campi della griglia
                    </option>
                    <option value="json">Validatore JSON</option>
                  </select>
                </Field>
                {table.source?.mongo?.sampled && (
                  <Notice>
                    I campi sono ricavati da un campione di documenti. Attiva le
                    regole dalla griglia dopo aver controllato che valgano anche
                    per i documenti fuori dal campione.
                  </Notice>
                )}
                {table.mongo?.validate !== false &&
                  table.options.customValidator && (
                    <DesignerExtras
                      engine={projectEngine}
                      tableName={table.name}
                      columns={table.columns}
                      tables={sourceTables}
                      options={table.options}
                      onChange={(options) => update({ options })}
                      onColumns={(columns) => update({ columns })}
                    />
                  )}
                <DesignerIndexes
                  tableName={table.name}
                  columns={table.columns}
                  options={table.options}
                  onChange={(options) => update({ options })}
                />
                {table.source?.indexes.some(
                  (index) =>
                    index.mongoEditable !== true && index.name !== "_id_",
                ) && (
                  <Notice>
                    Indici avanzati conservati:{" "}
                    {table.source.indexes
                      .filter(
                        (index) =>
                          index.mongoEditable !== true && index.name !== "_id_",
                      )
                      .map((index) => index.name)
                      .join(", ")}
                    .
                  </Notice>
                )}
              </div>
            )}
          </section>
        </div>
      )}
      {tab === "relations" && (
        <section className="panel stack">
          <p>
            Trascina un collegamento dal campo della tabella da progettare al
            campo della tabella referenziata, oppure fai clic sul punto di
            origine e poi su quello di destinazione.{" "}
            {projectEngine === "mongodb"
              ? "In MongoDB questi collegamenti documentano relazioni logiche: non vengono creati vincoli di chiave esterna."
              : "Le relazioni aggiungono chiavi esterne allo script."}
          </p>
          <div className="row">
            <Button onClick={() => setGraphExpanded(true)}>
              Espandi diagramma
            </Button>
            <Button
              onClick={() => {
                setTables((old) =>
                  old.map((item) => ({ ...item, position: undefined })),
                );
                setReferencePositions((old) =>
                  Object.fromEntries(
                    Object.entries(old).filter(
                      ([key]) =>
                        !currentRelations.some(
                          (relation) => referencePositionKey(relation) === key,
                        ),
                    ),
                  ),
                );
              }}
            >
              <LayoutGrid size={15} /> Ripristina disposizione
            </Button>
            <span className="muted small">
              Doppio clic sulla scheda per aprirla o sulla linea della bozza per
              rimuoverla.
            </span>
          </div>
          <DiagramContainer
            expanded={graphExpanded}
            onClose={() => setGraphExpanded(false)}
          >
            <div className="designer-graph">
              <ReactFlow
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={NODE_TYPES}
                connectOnClick
                onNodeDoubleClick={(_, node) => showGraphNode(node.id)}
                onEdgeDoubleClick={async (_, edge) => {
                  if (!edge.id.startsWith("draft:")) return;
                  if (
                    !(await confirm(
                      "Rimuovere questa relazione dal progetto? Rivedi poi il piano per applicare la modifica al database.",
                    ))
                  )
                    return;
                  setTables((old) =>
                    old.map((t) => ({
                      ...t,
                      options: {
                        ...t.options,
                        keys: t.options.keys.filter(
                          (_, index) =>
                            `${draftNodeId(t)}:${index}` !== edge.id,
                        ),
                      },
                    })),
                  );
                }}
                onConnect={connectRelation}
                onNodeDragStop={(_, node) => {
                  const reference = graph.liveObjects.find(
                    (item) => liveNodeId(item) === node.id,
                  );
                  if (reference) {
                    setReferencePositions((old) => ({
                      ...old,
                      [referencePositionKey(reference)]: node.position,
                    }));
                    return;
                  }
                  setTables((old) =>
                    old.map((t) =>
                      draftNodeId(t) === node.id
                        ? { ...t, position: node.position }
                        : t,
                    ),
                  );
                }}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls />
              </ReactFlow>
            </div>
          </DiagramContainer>
          <Button onClick={() => setTab("sql")}>
            Controlla lo script generato
            <ArrowRight size={14} />
          </Button>
        </section>
      )}
      {tab === "sql" && (
        <section className="panel stack">
          <div className="row">
            <h2>Script del progetto</h2>
            <select
              aria-label="Ambito dello script"
              value={sqlScope}
              onChange={(e) => {
                setSqlScope(
                  e.target.value as "pending" | "project" | "changes",
                );
                setReviewed(false);
              }}
            >
              <option value="pending">
                Solo strutture mancanti ({pendingTables.length})
              </option>
              <option value="changes">
                Modifiche al database ({migration.changes.length})
              </option>
              <option value="project">
                Progetto completo ({tables.length})
              </option>
            </select>
            <span className="spacer" />
            <Button disabled={!displayedSql || !!scriptError} onClick={copy}>
              <Copy size={14} />
              Copia
            </Button>
            <Button
              disabled={
                !displayedSql ||
                !!scriptError ||
                (applyingMigration && migration.rebuildSqlite)
              }
              onClick={() => onOpenQuery(displayedSql, {}, projectEngine)}
            >
              Apri nell’editor
              <ArrowRight size={14} />
            </Button>
            <Button
              disabled={!displayedSql || !!scriptError}
              onClick={() => {
                const name = applyingMigration ? "modifiche-schema" : "schema";
                if (applyingMigration && migration.rebuildSqlite) {
                  download(
                    "Piano di ricostruzione SQLite da consultare in Database Manager. L’applicazione richiede i controlli del Designer.\n\n" +
                      displayedSql,
                    `${name}.txt`,
                    "text/plain",
                  );
                } else if (projectEngine === "mongodb")
                  download(displayedSql, `${name}.json`, "application/json");
                else download(displayedSql, `${name}.sql`, "application/sql");
              }}
            >
              <Download size={14} /> Esporta
            </Button>
          </div>
          {applyingMigration && (
            <div className="migration-summary">
              <h3>
                {migration.changes.length
                  ? "Operazioni del piano"
                  : "Nessuna modifica strutturale da applicare"}
              </h3>
              {migration.changes.map((change, index) => (
                <div
                  key={index}
                  className={change.destructive ? "migration-destructive" : ""}
                >
                  <span>{index + 1}</span>
                  {change.label}
                  {change.destructive && (
                    <strong>Richiede revisione dei dati</strong>
                  )}
                </div>
              ))}
              {migration.warnings.map((warning) => (
                <Notice key={warning} tone="warning">
                  {warning}
                </Notice>
              ))}
              {migration.rebuildSqlite && (
                <Notice>
                  Applica la ricostruzione dal Designer per conservare i
                  progressivi e verificare le chiavi esterne in transazione.
                </Notice>
              )}
            </div>
          )}
          <div className="designer-sql">
            <Editor
              height="100%"
              value={displayedSql}
              language={projectEngine === "mongodb" ? "json" : "sql"}
              theme={dark ? "vs-dark" : "light"}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 14,
                automaticLayout: true,
                scrollBeyondLastLine: false,
              }}
            />
          </div>
          <Notice>
            {connected
              ? `Destinazione: ${currentSchema?.database || "database connesso"}.`
              : "Puoi progettare e generare codice senza collegarti. Per creare fisicamente le strutture, collega un database."}{" "}
            {projectEngine !== engine && connected
              ? "Il motore del progetto è diverso dalla connessione attiva."
              : ""}
          </Notice>
          {projectEngine === "postgresql" && (
            <Notice>
              Le istruzioni indicano lo schema di ciascuna tabella. Controlla
              che l’utente della connessione abbia i privilegi richiesti sugli
              schemi coinvolti.
            </Notice>
          )}
          {!applyingMigration && pendingTables.length !== tables.length && (
            <Notice>
              Le strutture già presenti non vengono ricreate o modificate
              automaticamente. Per la creazione scegli Solo strutture mancanti;
              per modifiche esistenti scegli Modifiche al database.
            </Notice>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={reviewed}
              onChange={(e) => setReviewed(e.target.checked)}
            />
            Ho controllato nomi, tipi, relazioni e destinazione dello script.
          </label>
          {destructive && (
            <label className="check">
              <input
                type="checkbox"
                checked={allowDestructive}
                onChange={(event) => setAllowDestructive(event.target.checked)}
              />
              Ho un backup verificato e accetto rimozioni, ricostruzioni o
              conversioni indicate nel piano.
            </label>
          )}
          <div className="row">
            <Button
              variant="primary"
              disabled={
                !displayedSql ||
                !!scriptError ||
                !connected ||
                readOnly ||
                projectEngine !== engine ||
                !reviewed ||
                !hasChanges ||
                (destructive && !allowDestructive) ||
                conflicts
              }
              busy={busy}
              onClick={apply}
            >
              <Database size={15} />
              {applyingMigration
                ? "Applica modifiche al database"
                : "Crea nel database"}
            </Button>
            <Button onClick={() => setTab("code")} disabled={!built.schema}>
              <Code2 size={15} />
              Trasforma in codice
            </Button>
            {selectedLive && (
              <Button onClick={() => onCreated?.(selectedLive)}>
                Apri dati tabella
              </Button>
            )}
          </div>
        </section>
      )}
      {tab === "code" && built.schema && (
        <CodegenView
          schema={built.schema}
          engine={projectEngine}
          query=""
          mode={mode}
          dark={dark}
          schemaScript={built.sql}
          migrationScript={
            migration.blockers.length || migration.rebuildSqlite
              ? undefined
              : migration.sql
          }
          designSource
          initialTable={designObject(projectEngine, table)}
          onOpenQuery={(text, parameters = {}) =>
            onOpenQuery(text, parameters, projectEngine)
          }
        />
      )}
      {importRequest && (
        <Modal
          title="Importa schema da codice"
          onClose={() => setImportRequest(null)}
          wide
        >
          <div className="modal-body stack">
            <div className="form-grid">
              <Field label="Motore dello schema">
                <select
                  value={importRequest.engine}
                  onChange={(event) => {
                    const next = event.target.value as Engine;
                    setImportRequest({ ...importRequest, engine: next });
                    setValidateImport(false);
                  }}
                >
                  {ENGINES.map((item) => (
                    <option key={item} value={item}>
                      {ENGINE_LABELS[item]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Formato del sorgente">
                <select
                  value={importRequest.format}
                  onChange={(event) => {
                    setImportRequest({
                      ...importRequest,
                      format: event.target
                        .value as SchemaImportRequest["format"],
                    });
                    setValidateImport(false);
                  }}
                >
                  <option value="sql">Definizioni SQL</option>
                  <option value="mongodb">Schema o comandi JSON MongoDB</option>
                  <option value="source">File di programma</option>
                </select>
              </Field>
            </div>
            <Field label="File di origine">
              <input
                type="file"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  try {
                    if (file.size > 512 * 1024)
                      throw new Error("Il file supera 512 KiB.");
                    const source = await file.text();
                    const format = /\.sql$/i.test(file.name)
                      ? "sql"
                      : /\.json$/i.test(file.name)
                        ? "mongodb"
                        : "source";
                    setImportRequest((old) =>
                      old?.id === importRequest.id
                        ? {
                            ...old,
                            name: file.name,
                            source,
                            format,
                            engine:
                              format === "mongodb" ? "mongodb" : old.engine,
                          }
                        : old,
                    );
                    setValidateImport(true);
                  } catch (error) {
                    setError(errorMessage(error));
                    setImportRequest(null);
                  }
                }}
              />
            </Field>
            {importRequest.format === "source" && (
              <Field label="Nome del sorgente con estensione">
                <input
                  value={importRequest.name}
                  onChange={(event) => {
                    setImportRequest({
                      ...importRequest,
                      name: event.target.value,
                    });
                    setValidateImport(false);
                  }}
                />
              </Field>
            )}
            <Field label="Sorgente">
              <textarea
                className="mono"
                rows={8}
                value={importRequest.source}
                onChange={(event) => {
                  setImportRequest({
                    ...importRequest,
                    source: event.target.value,
                  });
                  setValidateImport(false);
                }}
              />
            </Field>
            {importPreview && (
              <section className="stack designer-import-preview">
                <h3>{importPreview.tables.length} strutture riconosciute</h3>
                {importPreview.tables.length > 0 && (
                  <ul>
                    {importPreview.tables.map((item) => (
                      <li key={item.id}>
                        {item.schema ? `${item.schema}.` : ""}
                        {item.name} · {item.columns.length} campi ·{" "}
                        {item.options.indexes.length} indici
                      </li>
                    ))}
                  </ul>
                )}
                {importPreview.issues.length > 0 && (
                  <Notice tone="warning">
                    {importPreview.issues.map((issue, index) => (
                      <div key={index}>
                        Riga {issue.line}: {issue.message}
                      </div>
                    ))}
                  </Notice>
                )}
              </section>
            )}
          </div>
          <footer>
            <Button onClick={() => setImportRequest(null)}>Annulla</Button>
            <span className="spacer" />
            <Button
              disabled={!importRequest.source.trim()}
              onClick={() => setValidateImport(true)}
            >
              Analizza sorgente
            </Button>
            <Button
              variant="primary"
              disabled={!importPreview?.tables.length}
              onClick={() => void acceptSourceImport()}
            >
              Apri come progetto
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
