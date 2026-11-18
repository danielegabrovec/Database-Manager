import {
  Beaker,
  Code2,
  Database,
  Download,
  FolderOpen,
  GitFork,
  Plus,
  Table2,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type SetStateAction } from "react";
import { useConfirmation } from "../components/ConfirmationProvider";
import { Button, Field, Modal, Notice } from "../components/UI";
import { designSnapshot, type DesignTable } from "../designer/schemaProject";
import { type GraphDraft } from "../designer/operationGraph";
import { importGraphQuery } from "../designer/operationGraphImport";
import {
  newApplicationProject,
  newProjectDatabase,
  newProjectOperation,
  readApplicationProject,
  updateProjectTables,
  type ApplicationProject,
  type ProjectDatabase,
} from "../project/applicationProject";
import { ProjectSeeds } from "../project/ProjectSeeds";
import {
  testApplicationProject,
  type ProjectTestReport,
} from "../project/projectTest";
import {
  ENGINES,
  ENGINE_LABELS,
  type Engine,
  type SchemaSnapshot,
} from "../types";
import { cellText, errorMessage } from "../utils";
import { OperationGraphView } from "./OperationGraphView";
import { ProjectCodeView } from "./ProjectCodeView";
import { TableDesignerView } from "./TableDesignerView";
import "../project/application-project.css";

const sections = [
  { id: "schema", label: "Schema", icon: Database },
  { id: "operations", label: "Operazioni", icon: GitFork },
  { id: "seed", label: "Dati di prova", icon: Table2 },
  { id: "code", label: "Codice", icon: Code2 },
] as const;
type Section = (typeof sections)[number]["id"];

export type ApplicationProjectCommand = {
  id: string;
  action: "test" | "copy" | "integrate" | "reimport" | "export";
};

export type ApplicationProjectSelection = {
  databaseId: string;
  operationId?: string;
  section: Section;
};

interface Props {
  project: ApplicationProject;
  onProjectChange: (next: ApplicationProject) => void;
  dark: boolean;
  command?: ApplicationProjectCommand;
  onSelectionChange?: (selection: ApplicationProjectSelection) => void;
  onOpenLaboratory?: () => void;
  onOpenQuery?: (
    query: string,
    parameters: Record<string, unknown>,
    engine: Engine,
  ) => void;
  activeConnection?: { schema: SchemaSnapshot | null };
}

function saveDownload(project: ApplicationProject) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.download = `${project.name.trim().replace(/[^\p{L}\p{N}_-]+/gu, "-") || "progetto"}.dbm-project.json`;
  link.href = url;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ApplicationProjectView({
  project,
  onProjectChange,
  dark,
  command,
  onSelectionChange,
  onOpenLaboratory,
  onOpenQuery,
  activeConnection,
}: Props) {
  const confirm = useConfirmation();
  const fileInputId = useId();
  const [section, setSection] = useState<Section>("schema");
  const [databaseId, setDatabaseId] = useState("");
  const [operationId, setOperationId] = useState("");
  const [addingEngine, setAddingEngine] = useState<Engine>("sqlite");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [tested, setTested] = useState<{
    project: ApplicationProject;
    results: ProjectTestReport[];
  }>();
  const [codeCommand, setCodeCommand] = useState<ApplicationProjectCommand>();
  const [importOperation, setImportOperation] = useState(false);
  const [operationSource, setOperationSource] = useState("");
  const [operationParams, setOperationParams] = useState("{}");
  const running = useRef<AbortController | null>(null);
  const handled = useRef("");
  const database =
    project.databases.find((item) => item.id === databaseId) ||
    project.databases[0];
  const operation =
    database.operations.find((item) => item.id === operationId) ||
    database.operations[0];
  const busy = !!progress;
  let schema: SchemaSnapshot | null = null;
  try {
    schema = designSnapshot(database.engine, database.tables);
  } catch {
    // Incomplete schema drafts stay editable in the Schema tab.
  }

  useEffect(() => {
    onSelectionChange?.({
      databaseId: database.id,
      operationId: operation?.id,
      section,
    });
  }, [database.id, operation?.id, section, onSelectionChange]);

  useEffect(() => () => running.current?.abort(), []);

  async function runProject() {
    if (running.current) return;
    const remote = project.databases.some((item) => item.engine !== "sqlite");
    if (
      remote &&
      !(await confirm(
        "La prova aprirà laboratori server temporanei a partire dai motori di laboratorio già avviati. I dati di prova saranno applicati alle risorse temporanee, che verranno eliminate alla fine. Continuare?",
      ))
    )
      return;
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setSection("seed");
    setProgress("Preparazione della prova…");
    setError("");
    setTested(undefined);
    try {
      const results = await testApplicationProject(project, {
        signal: controller.signal,
        onProgress: setProgress,
      });
      setTested({ project, results });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      running.current = null;
      setProgress("");
    }
  }

  useEffect(() => {
    if (!command || handled.current === command.id) return;
    handled.current = command.id;
    if (command.action === "test") void runProject();
    else {
      setSection("code");
      setCodeCommand(command);
    }
  }, [command]);

  function changeDatabase(
    change: (current: ProjectDatabase) => ProjectDatabase,
  ) {
    onProjectChange({
      ...project,
      databases: project.databases.map((item) =>
        item.id === database.id ? change(item) : item,
      ),
    });
  }

  function changeTables(update: SetStateAction<DesignTable[]>) {
    changeDatabase((current) =>
      updateProjectTables(
        current,
        typeof update === "function" ? update(current.tables) : update,
      ),
    );
  }

  function changeOperation(update: SetStateAction<GraphDraft>) {
    if (!operation) return;
    changeDatabase((current) => ({
      ...current,
      operations: current.operations.map((item) =>
        item.id === operation.id
          ? {
              ...item,
              graph: typeof update === "function" ? update(item.graph) : update,
            }
          : item,
      ),
    }));
  }

  function open(next: ApplicationProject) {
    onProjectChange(next);
    setDatabaseId("");
    setOperationId("");
    setSection("schema");
    setTested(undefined);
    setError("");
    setNotice(`Aperto «${next.name}».`);
  }

  async function importFile(file: File) {
    setError("");
    try {
      if (file.size > 6 * 1024 * 1024)
        throw new Error("Il progetto supera 6 MiB.");
      const input = readApplicationProject(JSON.parse(await file.text()));
      open(input);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const openQuery = (
    query: string,
    params: Record<string, unknown>,
    engine: Engine,
  ) => onOpenQuery?.(query, params, engine);

  function addImportedOperation() {
    try {
      const parameters: unknown = JSON.parse(operationParams);
      if (
        !parameters ||
        typeof parameters !== "object" ||
        Array.isArray(parameters)
      )
        throw new Error("Inserisci un oggetto JSON per i parametri.");
      const graph = importGraphQuery(
        {
          query: operationSource,
          parameters: parameters as Record<string, unknown>,
        },
        schema,
        database.engine,
      );
      const next = {
        ...newProjectOperation(
          `Operazione importata ${database.operations.length + 1}`,
        ),
        graph,
      };
      changeDatabase((current) => ({
        ...current,
        operations: [...current.operations, next],
      }));
      setOperationId(next.id);
      setImportOperation(false);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="view-content application-project">
      <header className="application-project-header">
        <div>
          <h1>Progetto applicativo</h1>
          <p className="muted">
            Organizza schema, operazioni, dati di prova e codice per uno o più
            database.
          </p>
        </div>
        <div className="row application-project-actions">
          <Button disabled={busy} onClick={() => open(newApplicationProject())}>
            <Plus size={15} /> Nuovo progetto
          </Button>
          <label className="button secondary" htmlFor={fileInputId}>
            <FolderOpen size={15} /> Apri progetto
          </label>
          <input
            id={fileInputId}
            className="project-file-input"
            type="file"
            accept=".json,application/json"
            aria-label="Apri progetto applicativo JSON"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
          <Button disabled={busy} onClick={() => saveDownload(project)}>
            <Download size={15} /> Salva progetto
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void runProject()}
          >
            <Beaker size={15} /> Prova progetto
          </Button>
        </div>
      </header>

      <div className="panel application-project-config">
        <Field label="Nome del progetto">
          <input
            value={project.name}
            maxLength={120}
            disabled={busy}
            onChange={(event) =>
              onProjectChange({ ...project, name: event.target.value })
            }
          />
        </Field>
        <Field label="Database del progetto">
          <select
            value={database.id}
            disabled={busy}
            onChange={(event) => {
              setDatabaseId(event.target.value);
              setOperationId("");
            }}
          >
            {project.databases.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} · {ENGINE_LABELS[item.engine]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Nome del database">
          <input
            value={database.name}
            maxLength={120}
            disabled={busy}
            onChange={(event) =>
              changeDatabase((current) => ({
                ...current,
                name: event.target.value,
              }))
            }
          />
        </Field>
        <div className="row application-project-database-actions">
          <Field label="Motore del nuovo database">
            <select
              value={addingEngine}
              disabled={busy}
              onChange={(event) =>
                setAddingEngine(event.target.value as Engine)
              }
            >
              {ENGINES.map((engine) => (
                <option key={engine} value={engine}>
                  {ENGINE_LABELS[engine]}
                </option>
              ))}
            </select>
          </Field>
          <Button
            disabled={busy || project.databases.length >= 12}
            onClick={() => {
              const next = newProjectDatabase(
                addingEngine,
                `${ENGINE_LABELS[addingEngine]} ${project.databases.length + 1}`,
              );
              onProjectChange({
                ...project,
                databases: [...project.databases, next],
              });
              setDatabaseId(next.id);
              setSection("schema");
            }}
          >
            <Plus size={15} /> Aggiungi database
          </Button>
          <Button
            variant="ghost"
            disabled={busy || project.databases.length === 1}
            aria-label="Rimuovi database dal progetto"
            onClick={async () => {
              if (
                await confirm(
                  `Rimuovere «${database.name}» e le sue bozze da questo progetto?`,
                )
              )
                onProjectChange({
                  ...project,
                  databases: project.databases.filter(
                    (item) => item.id !== database.id,
                  ),
                });
            }}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      </div>

      <nav
        aria-label="Aree del progetto applicativo"
        className="application-project-tabs"
      >
        {sections.map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            aria-current={section === id ? "page" : undefined}
            variant={section === id ? "primary" : "secondary"}
            disabled={busy && id !== "seed"}
            onClick={() => setSection(id)}
          >
            <Icon size={15} />
            {label}
          </Button>
        ))}
      </nav>
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && (
        <div role="alert">
          <Notice tone="error">{error}</Notice>
        </div>
      )}

      {section === "schema" && (
        <TableDesignerView
          key={database.id}
          engine={database.engine}
          dark={dark}
          mode="work"
          connected={false}
          readOnly
          schema={
            activeConnection?.schema?.engine === database.engine
              ? activeConnection.schema
              : null
          }
          projectDesign={{
            tables: database.tables,
            onTablesChange: changeTables,
          }}
          onApply={async () => {
            throw new Error(
              "Usa Prova progetto per applicare lo schema al laboratorio isolato.",
            );
          }}
          onOpenQuery={openQuery}
        />
      )}
      {section === "operations" && (
        <>
          <div className="panel row application-project-operation">
            <Field label="Operazione">
              <select
                value={operation?.id ?? ""}
                onChange={(event) => setOperationId(event.target.value)}
              >
                {!operation && <option value="">Nessuna operazione</option>}
                {database.operations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
            {operation && (
              <Field label="Nome dell’operazione">
                <input
                  value={operation.name}
                  maxLength={120}
                  onChange={(event) =>
                    changeDatabase((current) => ({
                      ...current,
                      operations: current.operations.map((item) =>
                        item.id === operation.id
                          ? { ...item, name: event.target.value }
                          : item,
                      ),
                    }))
                  }
                />
              </Field>
            )}
            <Button
              disabled={database.operations.length >= 64}
              onClick={() => {
                const next = newProjectOperation(
                  `Operazione ${database.operations.length + 1}`,
                );
                changeDatabase((current) => ({
                  ...current,
                  operations: [...current.operations, next],
                }));
                setOperationId(next.id);
              }}
            >
              <Plus size={15} /> Nuova operazione
            </Button>
            <Button
              disabled={!schema || database.operations.length >= 64}
              onClick={() => {
                setError("");
                setOperationSource("");
                setOperationParams("{}");
                setImportOperation(true);
              }}
            >
              <Code2 size={15} /> Importa query
            </Button>
            {operation && (
              <Button
                variant="ghost"
                aria-label="Rimuovi operazione"
                onClick={async () => {
                  if (
                    await confirm(`Rimuovere «${operation.name}» dal progetto?`)
                  )
                    changeDatabase((current) => ({
                      ...current,
                      operations: current.operations.filter(
                        (item) => item.id !== operation.id,
                      ),
                    }));
                }}
              >
                <Trash2 size={15} />
              </Button>
            )}
          </div>
          {!schema && (
            <Notice tone="warning">
              Completa lo schema prima di compilare le operazioni.
            </Notice>
          )}
          {operation && (
            <OperationGraphView
              engine={database.engine}
              schema={schema}
              dark={dark}
              sessionId=""
              readOnly={false}
              projectGraph={{
                id: operation.id,
                draft: operation.graph,
                onChange: changeOperation,
              }}
              onOpenQuery={openQuery}
            />
          )}
        </>
      )}
      {section === "seed" && (
        <>
          <ProjectSeeds
            key={database.id}
            database={database}
            disabled={busy}
            onChange={(seed) =>
              changeDatabase((current) => ({ ...current, seed }))
            }
          />
          <section className="panel stack">
            <h2>Prova del progetto</h2>
            {busy && (
              <div className="row">
                <span role="status">{progress}</span>
                <Button onClick={() => running.current?.abort()}>
                  Interrompi prova
                </Button>
              </div>
            )}
            {tested && (
              <ProjectReports
                reports={tested.results}
                stale={tested.project !== project}
              />
            )}
            <details>
              <summary>Procedura manuale</summary>
              <ol>
                <li>
                  Apri Codice e genera il pacchetto del motore di destinazione.
                </li>
                <li>
                  Prepara un database di laboratorio vuoto e segui le istruzioni
                  del pacchetto per creare lo schema e inserire i dati di prova.
                </li>
                <li>
                  Esegui le operazioni nell’ordine previsto e confronta
                  risultati e righe modificate con il caso di prova.
                </li>
              </ol>
            </details>
            {onOpenLaboratory &&
              project.databases.some((item) => item.engine !== "sqlite") && (
                <Button disabled={busy} onClick={onOpenLaboratory}>
                  Apri Laboratorio
                </Button>
              )}
          </section>
        </>
      )}
      {section === "code" && (
        <ProjectCodeView
          project={project}
          dark={dark}
          command={codeCommand}
          onImportProject={open}
        />
      )}
      {importOperation && (
        <Modal
          title="Importa operazione da codice"
          wide
          onClose={() => {
            setImportOperation(false);
            setError("");
          }}
        >
          <div className="modal-body stack">
            {error && <Notice tone="error">{error}</Notice>}
            <Field
              label={
                database.engine === "mongodb" ? "Comando MongoDB" : "Query SQL"
              }
            >
              <textarea
                rows={9}
                className="mono"
                value={operationSource}
                onChange={(event) => setOperationSource(event.target.value)}
              />
            </Field>
            <Field label="Parametri JSON">
              <textarea
                rows={3}
                className="mono"
                value={operationParams}
                onChange={(event) => setOperationParams(event.target.value)}
              />
            </Field>
          </div>
          <footer>
            <Button
              onClick={() => {
                setImportOperation(false);
                setError("");
              }}
            >
              Annulla
            </Button>
            <span className="spacer" />
            <Button
              variant="primary"
              disabled={!operationSource.trim()}
              onClick={addImportedOperation}
            >
              Crea operazione grafica
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
}

function ProjectReports({
  reports,
  stale,
}: {
  reports: ProjectTestReport[];
  stale: boolean;
}) {
  return (
    <div className="stack">
      {stale && (
        <Notice tone="warning">
          Il progetto è cambiato dopo questa prova.
        </Notice>
      )}
      {reports.map((report) => (
        <section className="project-test-report" key={report.databaseId}>
          <strong>
            {report.name} · {ENGINE_LABELS[report.engine]}
          </strong>
          <span className="badge">
            {report.status === "passed"
              ? "Superata"
              : report.status === "cancelled"
                ? "Interrotta"
                : "Da correggere"}
          </span>
          <ul>
            {report.steps.map((step, index) => (
              <li key={index}>
                <strong>{step.name}</strong> · {step.detail}
                {step.result?.sets[0]?.rows.length ? (
                  <details>
                    <summary>Risultati</summary>
                    <div className="operation-results">
                      <table>
                        <thead>
                          <tr>
                            {step.result.sets[0].columns.map((column) => (
                              <th key={column.name}>{column.name}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {step.result.sets[0].rows
                            .slice(0, 50)
                            .map((row, number) => (
                              <tr key={number}>
                                {step.result!.sets[0].columns.map((column) => (
                                  <td key={column.name}>
                                    {cellText(row[column.name])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
