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
} from "lucide-react";
import type { Engine, SchemaSnapshot, Mode, TableInfo } from "../types";
import { ENGINE_LABELS, ENGINES } from "../types";
import { Button, Field, Modal, Notice, SectionHeader } from "../components/UI";
import { DesignerExtras, INITIAL_DESIGNER } from "../components/SchemaBuilders";
import { CodegenView } from "./CodegenView";
import {
  adoptTable,
  buildTableDdl,
  buildProjectDdl,
  buildCreationPlan,
  designSnapshot,
  newDesignTable,
  TYPE_CHOICES,
  type DesignTable,
} from "../designer/schemaProject";
import { errorMessage } from "../utils";
import { useConfirmation } from "../components/ConfirmationProvider";
import {
  buildMigrationPlan,
  editExistingTable,
} from "../designer/schemaMigration";
import "../designer.css";

function DesignNode({
  data,
}: {
  data: {
    name: string;
    columns: { name: string; dataType: string; primaryKey: boolean }[];
    origin?: boolean;
  };
}) {
  return (
    <div className={`design-graph-table ${data.origin ? "origin" : ""}`}>
      <strong>{data.name}</strong>
      {data.columns.map((c) => (
        <div key={c.name}>
          <Handle
            type="target"
            position={Position.Left}
            id={c.name}
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
            id={c.name}
            aria-label={`Collega da ${data.name}.${c.name}`}
            title={`Origine: ${data.name}.${c.name}`}
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
function loadSavedDesign() {
  try {
    const p = JSON.parse(
      localStorage.getItem("dbm-schema-design-v2") || "null",
    );
    if (
      p?.tables?.length &&
      p.tables.length <= 100 &&
      ENGINES.includes(p.engine)
    ) {
      buildProjectDdl(p.engine, p.tables);
      return p as { engine: Engine; tables: DesignTable[] };
    }
  } catch {}
  return null;
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
  onOpenQuery: (query: string) => void;
  onCreated?: (table: TableInfo) => void;
}) {
  const confirm = useConfirmation();
  const [projectEngine, setProjectEngine] = useState<Engine>(
    () => loadSavedDesign()?.engine || engine,
  );
  const [tables, setTables] = useState<DesignTable[]>(
    () => loadSavedDesign()?.tables || [newDesignTable(engine)],
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
  const [currentSchema, setCurrentSchema] = useState(schema);
  useEffect(() => setCurrentSchema(schema), [schema]);
  useEffect(() => {
    try {
      localStorage.setItem(
        "dbm-schema-design-v2",
        JSON.stringify({ engine: projectEngine, tables }),
      );
    } catch {
      setError(
        "Impossibile conservare automaticamente il progetto. Usa Salva progetto per esportare la bozza.",
      );
    }
    setReviewed(false);
  }, [tables, projectEngine]);
  const table = tables.find((t) => t.id === selected) || tables[0];
  function update(patch: Partial<DesignTable>) {
    const renamed =
      patch.name && patch.name !== table.name ? patch.name : table.name;
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
            keys: next.options.keys.map((k) => ({
              ...k,
              column:
                t.id === table.id
                  ? renames.get(k.column) || k.column
                  : k.column,
              table: k.table === table.name ? renamed : k.table,
              targetColumn:
                k.table === table.name
                  ? renames.get(k.targetColumn) || k.targetColumn
                  : k.targetColumn,
            })),
            indexes: next.options.indexes.map((i) => ({
              ...i,
              columns:
                t.id === table.id
                  ? i.columns
                      .split(",")
                      .map((c) => renames.get(c.trim()) || c.trim())
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
    built.error ||
    (sqlScope === "changes" ? migration.blockers.join(" ") : creation.error);
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
      /^(table|view|collection)/i.test(t.kind) &&
      (projectEngine !== "postgresql" || !t.schema || t.schema === "public"),
  );
  const sourceTables = [
    ...tables.map((t) => ({
      name: t.name,
      columns: t.columns,
      kind: "table",
      indexes: [],
      foreignKeys: [],
    })),
    ...currentRelations.filter(
      (t) => t.columns.length && !tables.some((p) => p.name === t.name),
    ),
  ];
  function editTable(source: TableInfo) {
    try {
      const existing = tables.find(
        (t) => t.source?.name === source.name || t.name === source.name,
      );
      if (existing) {
        setSelected(existing.id);
        setTab("structure");
        return;
      }
      const draft = editExistingTable(source);
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
      const loaded = currentRelations
        .filter((t) => /^(table|collection|partitioned table)$/i.test(t.kind))
        .map(editExistingTable);
      if (!loaded.length)
        throw new Error("Non ci sono tabelle modificabili da caricare.");
      setTables(loaded);
      setSelected(loaded[0].id);
      setSqlScope("changes");
      setError("");
      setMessage(
        "Schema caricato dal database: modifica campi o relazioni e rivedi il piano prima di applicarlo.",
      );
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  const graph = useMemo(() => {
    const nodes = sourceTables.map((t, i) => ({
      id: t.name,
      type: "design",
      position: tables.find((p) => p.name === t.name)?.position || {
        x: (i % 3) * 320,
        y: Math.floor(i / 3) * 270,
      },
      data: {
        name: t.name,
        columns: t.columns,
        origin: tables.some((p) => p.name === t.name),
      },
    }));
    const edges = tables.flatMap((t) =>
      t.options.keys.map((k, i) => ({
        id: `${t.id}-${i}`,
        source: t.name,
        sourceHandle: k.column,
        target: k.table,
        targetHandle: k.targetColumn,
        label: `${k.column} → ${k.targetColumn}`,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    );
    return { nodes, edges };
  }, [tables, currentSchema]);
  function connectRelation(c: Connection) {
    const source = tables.find((t) => t.name === c.source);
    if (!source || !c.sourceHandle || !c.targetHandle || !c.target) return;
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
                        k.column === c.sourceHandle &&
                        k.table === c.target &&
                        k.targetColumn === c.targetHandle
                      ),
                  ),
                  {
                    column: c.sourceHandle!,
                    table: c.target!,
                    targetColumn: c.targetHandle!,
                  },
                ],
              },
            }
          : t,
      ),
    );
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
      setTables((old) =>
        old.map((draft) => {
          const actual = next.tables.find(
            (t) =>
              t.name === draft.name &&
              (!t.schema ||
                t.schema === "public" ||
                t.schema === "main" ||
                t.schema === next.database),
          );
          if (!actual) return draft;
          try {
            return {
              ...editExistingTable(actual),
              id: draft.id,
              position: draft.position,
            };
          } catch {
            return draft;
          }
        }),
      );
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
      const p = JSON.parse(await file.text());
      if (
        p.version !== 1 ||
        !ENGINES.includes(p.engine) ||
        !Array.isArray(p.tables) ||
        !p.tables.length ||
        p.tables.length > 100
      )
        throw new Error("Formato progetto non valido.");
      for (const t of p.tables) {
        if (
          typeof t.name !== "string" ||
          !Array.isArray(t.columns) ||
          t.columns.length > 500 ||
          !t.columns.every(
            (c: Record<string, unknown>) =>
              typeof c.name === "string" && typeof c.dataType === "string",
          ) ||
          !Array.isArray(t.options?.keys) ||
          !Array.isArray(t.options?.indexes)
        )
          throw new Error("Una struttura del progetto non è valida.");
      }
      buildProjectDdl(p.engine, p.tables);
      setProjectEngine(p.engine);
      setTables(
        p.tables.map((t: DesignTable) => ({ ...t, id: crypto.randomUUID() })),
      );
      setSelected("");
      setMessage(
        "Progetto caricato. Nessuna modifica è stata applicata al database.",
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function saveProject() {
    const blob = new Blob(
      [JSON.stringify({ version: 1, engine: projectEngine, tables }, null, 2)],
      { type: "application/json" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "progetto-database.json";
    a.click();
    URL.revokeObjectURL(a.href);
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
            onChange={(e) => {
              setProjectEngine(e.target.value as Engine);
              setTables([newDesignTable(e.target.value as Engine)]);
              setSelected("");
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
          onClick={() => {
            const t = newDesignTable(projectEngine, tables.length + 1);
            setTables([...tables, t]);
            setSelected(t.id);
            setTab("structure");
          }}
        >
          <Plus size={15} />
          Nuova tabella
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
            hidden
            onChange={(event) => {
              const f = event.target.files?.[0];
              if (f) void importProject(f);
              event.target.value = "";
            }}
          />
        </label>
        <span className="spacer" />
        <span className="badge">{tables.length} strutture nel progetto</span>
      </div>
      <div className="designer-steps">
        {[
          ["structure", "1 · Campi e vincoli", Table2],
          ["relations", "2 · Relazioni grafiche", GitFork],
          ["sql", "3 · Script e creazione", Database],
          ["code", "4 · Codice nel linguaggio", Code2],
        ].map(([id, label, Icon]) => {
          const I = Icon as typeof Table2;
          return (
            <button
              key={String(id)}
              className={tab === id ? "active" : ""}
              onClick={() => setTab(String(id))}
            >
              <I size={16} />
              {String(label)}
            </button>
          );
        })}
      </div>
      {(error || scriptError) && (
        <Notice tone="error">{error || scriptError}</Notice>
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
                {t.name}
                <small>{t.columns.length} campi</small>
              </button>
            ))}
            {currentRelations.filter((t) => t.columns.length > 0).length >
              0 && (
              <Field label="Modifica una struttura esistente">
                <select
                  value=""
                  onChange={(event) => {
                    const source = currentRelations.find(
                      (t) => t.name === event.target.value,
                    );
                    if (source) editTable(source);
                  }}
                >
                  <option value="">Scegli una tabella da modificare</option>
                  {currentRelations
                    .filter((t) =>
                      /^(table|collection|partitioned table)$/i.test(t.kind),
                    )
                    .map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                </select>
              </Field>
            )}
            {currentRelations.filter((t) => t.columns.length > 0).length >
              0 && (
              <Field label="Copia una struttura esistente">
                <select
                  value=""
                  onChange={(e) => {
                    const found = currentRelations.find(
                      (t) => t.name === e.target.value,
                    );
                    if (found) {
                      try {
                        const t = adoptTable(found);
                        t.name += "_copia";
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
                      <option key={t.name}>{t.name}</option>
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
                Modifica di <strong>{table.source.name}</strong> nel database
                esistente. Rimozioni e conversioni compaiono nel piano di
                migrazione; rimuovere una tabella dal progetto non elimina il
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
              <span className="spacer" />
              <Button
                variant="danger"
                disabled={tables.length === 1}
                onClick={() => {
                  setTables(
                    tables
                      .filter((t) => t.id !== table.id)
                      .map((t) => ({
                        ...t,
                        options: {
                          ...t.options,
                          keys: t.options.keys.filter(
                            (k) => k.table !== table.name,
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
            <div className="schema-fields-scroll">
              <table className="schema-fields">
                <thead>
                  <tr>
                    <th>Campo</th>
                    <th>Tipo</th>
                    <th>PK</th>
                    <th>NULL</th>
                    <th>Univoco</th>
                    <th>Identità</th>
                    <th>Predefinito</th>
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
                      ).map((key) => (
                        <td key={key}>
                          <input
                            type="checkbox"
                            aria-label={`${key} campo ${i + 1}`}
                            disabled={
                              (key === "nullable" && c.primaryKey) ||
                              (key === "autoIncrement" &&
                                projectEngine === "mongodb")
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
                                      defaultValue: e.target.value || undefined,
                                    }
                                  : v,
                              ),
                            })
                          }
                        />
                      </td>
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
                onClick={() =>
                  update({
                    columns: [
                      ...table.columns,
                      {
                        name: `campo_${table.columns.length + 1}`,
                        dataType:
                          projectEngine === "mongodb" ? "string" : "TEXT",
                        nullable: true,
                        primaryKey: false,
                      },
                    ],
                  })
                }
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
                columns={table.columns}
                tables={sourceTables}
                options={table.options}
                onChange={(options) => update({ options })}
                onColumns={(columns) => update({ columns })}
                hideDefaults
              />
            ) : (
              <div className="stack">
                <Notice>
                  Il validatore MongoDB viene creato automaticamente dai campi
                  della griglia.
                </Notice>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={!!table.options.customValidator}
                    onChange={(e) => {
                      let validator = table.options.validator;
                      if (
                        e.target.checked &&
                        validator === INITIAL_DESIGNER.validator
                      ) {
                        const doc = JSON.parse(
                          buildTableDdl(projectEngine, table),
                        );
                        validator = JSON.stringify(
                          (Array.isArray(doc) ? doc[0] : doc).validator,
                          null,
                          2,
                        );
                      }
                      update({
                        options: {
                          ...table.options,
                          customValidator: e.target.checked,
                          validator,
                        },
                      });
                    }}
                  />
                  Usa un validatore JSON personalizzato avanzato
                </label>
                {table.options.customValidator && (
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
            <span className="muted small">
              Trascina per collegare · doppio clic sulla linea per rimuoverla
              dal progetto
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
                onNodeClick={(_, node) => {
                  const draft = tables.find((t) => t.name === node.id);
                  if (draft) setSelected(draft.id);
                  else {
                    const source = currentRelations.find(
                      (t) => t.name === node.id,
                    );
                    if (source) editTable(source);
                  }
                }}
                onEdgeDoubleClick={async (_, edge) => {
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
                          (_, index) => `${t.id}-${index}` !== edge.id,
                        ),
                      },
                    })),
                  );
                }}
                onConnect={connectRelation}
                onNodeDragStop={(_, node) =>
                  setTables((old) =>
                    old.map((t) =>
                      t.name === node.id
                        ? { ...t, position: node.position }
                        : t,
                    ),
                  )
                }
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
              disabled={!displayedSql || !!scriptError}
              onClick={() => onOpenQuery(displayedSql)}
            >
              Apri nell’editor
              <ArrowRight size={14} />
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
            </div>
          )}
          <div className="designer-sql">
            <Editor
              height="330px"
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
              Il designer crea le strutture nello schema public. Lo script
              imposta esplicitamente search_path; per altri schemi usa l’editor
              SQL o una migrazione.
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
            {currentRelations.find((t) => t.name === table.name) && (
              <Button
                onClick={() =>
                  onCreated?.(
                    currentRelations.find((t) => t.name === table.name)!,
                  )
                }
              >
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
          designSource
          initialTable={table.name}
          onOpenQuery={onOpenQuery}
        />
      )}
    </div>
  );
}
