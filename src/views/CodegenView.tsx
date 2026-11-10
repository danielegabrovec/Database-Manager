import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Code2,
  Copy,
  Download,
  FolderOpen,
  WandSparkles,
  Plus,
  Trash2,
  ArrowRight,
  Table2,
  Play,
  Check,
} from "lucide-react";
import { api } from "../api";
import type { Engine, GeneratedProject, Mode, SchemaSnapshot } from "../types";
import { ENGINE_LABELS, ENGINES, LANGUAGES } from "../types";
import { canBrowseData, errorMessage } from "../utils";
import { Button, Field, Notice, SectionHeader } from "../components/UI";
import { PathInput } from "../components/PathInput";
import {
  buildOperation,
  INITIAL_READ,
  type ReadOptions,
  type OperationKind,
} from "../designer/readOperation";
import "../code-workbench.css";
const LANGUAGE_IDS: Record<string, string> = { "C#": "csharp", "C++": "cpp" };
const ARTIFACTS = [
  ["read", "Codice di lettura"],
  ["function", "Funzione parametrizzata"],
  ["model", "Modello / classe / DTO"],
  ["repository", "Repository di lettura"],
  ["writes", "Funzioni CRUD da integrare"],
  ["schema", "Funzione di creazione schema"],
  ["project", "Programma completo CRUD"],
  ["rest", "API REST CRUD"],
  ["script", "Script SQL / MongoDB"],
];
const OPERATIONS: [OperationKind, string][] = [
  ["select", "Leggi tutti / campi selezionati"],
  ["findByKey", "Leggi per chiave primaria"],
  ["filter", "Leggi con filtri"],
  ["join", "Leggi tabelle collegate (JOIN)"],
  ["aggregate", "Conteggi, totali e raggruppamenti"],
  ["custom", "Usa la query dell’editor"],
];
export function CodegenView({
  schema,
  engine,
  query,
  mode,
  dark,
  schemaScript,
  designSource = false,
  onDesign,
  onOpenQuery,
  initialTable,
  queryParameters = {},
}: {
  schema: SchemaSnapshot | null;
  engine: Engine;
  query: string;
  mode: Mode;
  dark: boolean;
  schemaScript?: string;
  designSource?: boolean;
  initialTable?: string;
  queryParameters?: Record<string, unknown>;
  onDesign?: () => void;
  onOpenQuery?: (query: string, parameters?: Record<string, unknown>) => void;
}) {
  const [customParameterText, setCustomParameterText] = useState(
    JSON.stringify(queryParameters, null, 2),
  );
  const [language, setLanguage] = useState("Python");
  const [selectedEngine, setEngine] = useState(engine);
  const [artifact, setArtifact] = useState("read");
  const [table, setTable] = useState("");
  const [options, setOptions] = useState<ReadOptions>({
    ...INITIAL_READ,
    custom: query,
  });
  const [allModels, setAllModels] = useState(false);
  const [project, setProject] = useState<GeneratedProject | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const [destination, setDestination] = useState("");
  const [exported, setExported] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [educational, setEducational] = useState(mode !== "expert");
  const [generationKey, setGenerationKey] = useState("");
  useEffect(
    () => setCustomParameterText(JSON.stringify(queryParameters, null, 2)),
    [JSON.stringify(queryParameters)],
  );
  useEffect(() => {
    setEngine(engine);
  }, [engine]);
  useEffect(() => {
    if (initialTable) setTable(initialTable);
  }, [initialTable]);
  useEffect(() => setOptions((old) => ({ ...old, custom: query })), [query]);
  const dataTables = schema?.tables.filter(canBrowseData) || [];
  const activeTable = dataTables.find((t) => t.name === table) || dataTables[0];
  const languageId = LANGUAGE_IDS[language] || language.toLowerCase();
  const isRead = ["read", "function", "repository"].includes(artifact);
  const built = useMemo<
    ReturnType<typeof buildOperation> & { error: string }
  >(() => {
    if (!activeTable)
      return {
        query: options.operation === "custom" ? query : "",
        parameters: [],
        lesson:
          "Definisci lo schema con il designer oppure apri una connessione.",
        error: "",
      };
    try {
      const result = buildOperation(selectedEngine, activeTable, schema, {
        ...options,
        custom: query,
      });
      if (options.operation === "custom") {
        const raw = JSON.parse(customParameterText);
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new Error("I parametri devono essere un oggetto JSON.");
        result.parameters = Object.entries(raw).map(([name, value], i) => ({
          name: /^[A-Za-z_]\w*$/.test(name) ? name : `p${i + 1}`,
          dataType:
            activeTable.columns.find((c) => c.name === name)?.dataType ||
            (typeof value === "boolean"
              ? "BOOLEAN"
              : typeof value === "number"
                ? Number.isInteger(value)
                  ? "INTEGER"
                  : "DOUBLE"
                : "TEXT"),
          nullable: value === null,
          value,
        }));
      }
      return { ...result, error: "" };
    } catch (e) {
      return { query: "", parameters: [], lesson: "", error: errorMessage(e) };
    }
  }, [
    schema,
    activeTable,
    selectedEngine,
    options,
    query,
    customParameterText,
  ]);
  const fingerprint = JSON.stringify({
    languageId,
    artifact,
    table: activeTable?.name,
    columns: activeTable?.columns,
    options,
    engine: selectedEngine,
    educational,
    allModels,
    schemaScript,
    customParameterText,
  });
  const stale = !!project && fingerprint !== generationKey;
  function patch(p: Partial<ReadOptions>) {
    setOptions((o) => ({ ...o, ...p }));
  }
  async function generate() {
    setBusy("generate");
    setError("");
    try {
      if (!activeTable)
        throw new Error(
          "Crea prima una struttura nel Designer database o apri un database.",
        );
      if (built.error && isRead) throw new Error(built.error);
      if (
        artifact === "rest" &&
        !["rust", "python", "javascript", "typescript"].includes(languageId)
      )
        throw new Error(
          "Le API REST sono disponibili in Rust, Python, JavaScript e TypeScript. Gli altri formati supportano tutti i dodici linguaggi.",
        );
      let output: GeneratedProject;
      if (artifact === "script" && schemaScript) {
        output = {
          files: [
            {
              path: selectedEngine === "mongodb" ? "schema.json" : "schema.sql",
              content: schemaScript,
            },
          ],
          command:
            "Apri lo script nella connessione del motore corrispondente e rivedilo prima di eseguire.",
          notes: [
            "Script ricavato dal progetto visuale con tabelle, chiavi, relazioni e indici.",
          ],
        };
      } else if (artifact === "model" && allModels) {
        output = { files: [], command: "", notes: [] };
        for (const [index, target] of dataTables.entries()) {
          const generated = await api<GeneratedProject>("generate_workbench", {
            request: {
              engine: selectedEngine,
              language: languageId,
              artifact,
              operation: "select",
              table: target.name,
              tableSchema: target.schema || null,
              columns: target.columns,
              query: "",
              parameters: [],
              educational,
            },
          });
          const prefix = `${index + 1}-${target.name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
          output.files.push(
            ...generated.files.map((f) => ({
              ...f,
              path: `${prefix}/${f.path}`,
            })),
          );
          output.notes.push(...generated.notes);
        }
        output.notes = [...new Set(output.notes)];
      } else {
        output = await api<GeneratedProject>("generate_workbench", {
          request: {
            engine: selectedEngine,
            language: languageId,
            artifact: artifact === "writes" ? "function" : artifact,
            operation:
              artifact === "writes"
                ? ["insert", "update", "delete"].includes(options.operation)
                  ? options.operation
                  : "insert"
                : options.operation === "findByKey"
                  ? "findByKey"
                  : options.operation === "custom"
                    ? "custom"
                    : "select",
            table: activeTable.name,
            tableSchema: activeTable.schema || null,
            columns:
              artifact === "schema"
                ? []
                : artifact === "model" && options.columns.length
                  ? activeTable.columns.filter((c) =>
                      options.columns.includes(c.name),
                    )
                  : activeTable.columns,
            query:
              artifact === "schema"
                ? schemaScript || activeTable.definition || ""
                : isRead
                  ? built.template || built.query
                  : "",
            parameters: isRead ? built.parameters : [],
            educational,
          },
        });
        if (schemaScript && artifact === "project") {
          const path =
            selectedEngine === "mongodb" ? "schema.json" : "schema.sql";
          output.files = output.files.filter(
            (f) => f.path !== path && f.path !== "database.sql",
          );
          output.files.push({ path, content: schemaScript });
          output.notes.push(
            "Lo script dello schema contiene l’intero progetto visuale; il codice operativo usa la tabella selezionata.",
          );
        }
      }
      setProject(output);
      setFileIndex(0);
      setExported("");
      setGenerationKey(fingerprint);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function exportProject() {
    if (!project || stale) return;
    setBusy("export");
    setError("");
    try {
      setExported(
        await api<string>("export_project", { project, destination }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function copy() {
    if (!project || stale) return;
    try {
      await navigator.clipboard.writeText(
        project.files[fileIndex]?.content || "",
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function tryQuery() {
    const params = Object.fromEntries(
      built.parameters.map((p, i) => [
        selectedEngine === "postgresql" ? String(i + 1) : p.name,
        p.value,
      ]),
    );
    onOpenQuery?.(built.query, params);
  }
  const file = project?.files[fileIndex];
  const editorLanguage =
    (
      {
        rs: "rust",
        py: "python",
        js: "javascript",
        ts: "typescript",
        php: "php",
        java: "java",
        cs: "csharp",
        c: "cpp",
        cpp: "cpp",
        h: "cpp",
        go: "go",
        kt: "kotlin",
        rb: "ruby",
        sql: "sql",
        json: "json",
        md: "markdown",
      } as Record<string, string>
    )[file?.path.split(".").pop() || ""] || "plaintext";
  return (
    <div className="view-content code-workbench">
      <SectionHeader
        eyebrow={
          designSource
            ? "PROGETTO VISUALE → CODICE"
            : "DATABASE → OPERAZIONE → LINGUAGGIO"
        }
        title={
          designSource
            ? "Il codice delle tue strutture"
            : "Generatore visuale di codice"
        }
        description="Scegli cosa leggere, come filtrare e il formato da incollare nel tuo programma. Puoi partire dal database oppure da uno schema disegnato."
        action={
          onDesign && (
            <Button onClick={onDesign}>
              <Table2 size={15} />
              Disegna tabelle
            </Button>
          )
        }
      />
      {!activeTable && (
        <Notice>
          Apri un database oppure usa il Designer per creare campi, tabelle e
          relazioni. Poi puoi generare codice anche prima di creare fisicamente
          il database.
        </Notice>
      )}
      <div className="code-workbench-settings">
        <Field label="1 · Motore">
          <select
            value={selectedEngine}
            onChange={(e) => setEngine(e.target.value as Engine)}
          >
            {ENGINES.map((e) => (
              <option key={e} value={e}>
                {ENGINE_LABELS[e]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="2 · Tabella o collezione">
          <select
            value={activeTable?.name || ""}
            onChange={(e) => {
              setTable(e.target.value);
              setOptions({ ...INITIAL_READ, custom: query });
            }}
          >
            <option value="" disabled>
              Definisci o apri uno schema
            </option>
            {dataTables.map((t) => (
              <option key={`${t.schema}.${t.name}`} value={t.name}>
                {t.schema ? t.schema + "." : ""}
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="3 · Linguaggio">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="4 · Cosa generare">
          <select
            value={artifact}
            onChange={(e) => setArtifact(e.target.value)}
          >
            {ARTIFACTS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="operation-code-layout">
        <section className="panel operation-builder stack">
          <h2>
            <WandSparkles size={17} />
            Componi l’operazione
          </h2>
          {isRead && (
            <Field label="Operazione di lettura">
              <select
                value={options.operation}
                onChange={(e) =>
                  patch({ operation: e.target.value as OperationKind })
                }
              >
                {OPERATIONS.filter(
                  ([id]) => selectedEngine !== "mongodb" || id !== "join",
                ).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {artifact === "rest" && (
            <Notice>
              {["rust", "python", "javascript", "typescript"].includes(
                languageId,
              )
                ? (
                    {
                      rust: "Axum",
                      python: "FastAPI",
                      javascript: "Fastify",
                      typescript: "Fastify",
                    } as Record<string, string>
                  )[languageId] + " · endpoint CRUD, validazione e paginazione."
                : "Scegli Rust, Python, JavaScript o TypeScript per un’API REST."}
            </Notice>
          )}
          {artifact === "project" && (
            <Notice>
              Programma completo con connessione, lettura, inserimento, modifica
              e cancellazione. Il README contiene i comandi per ciascuna
              operazione.
            </Notice>
          )}
          {artifact === "writes" && (
            <>
              <Field label="Operazione da integrare">
                <select
                  value={
                    ["insert", "update", "delete"].includes(options.operation)
                      ? options.operation
                      : "insert"
                  }
                  onChange={(event) =>
                    patch({ operation: event.target.value as OperationKind })
                  }
                >
                  <option value="insert">Inserisci record</option>
                  <option value="update">Modifica per chiave primaria</option>
                  <option value="delete">Elimina per chiave primaria</option>
                </select>
              </Field>
              <Notice>
                Genera il modulo driver con la funzione execute e le operazioni
                list, insert, update e delete. Per scrivere passa esplicitamente
                l’operazione selezionata e un oggetto con i valori;
                aggiornamenti e cancellazioni richiedono la chiave completa. Il
                generatore non esegue operazioni.
              </Notice>
            </>
          )}
          {artifact === "schema" && (
            <Notice>
              Genera una funzione da chiamare con una connessione già aperta
              nella tua applicazione e include lo schema SQL. Usa il designer
              per definire più tabelle, indici e relazioni. Disponibile nei
              dodici linguaggi per SQLite, PostgreSQL, MySQL e MariaDB; per
              MongoDB esporta lo schema JSON.
            </Notice>
          )}
          {activeTable && artifact !== "schema" && (
            <>
              <h3>
                Campi{" "}
                {artifact === "model"
                  ? "del modello"
                  : artifact === "writes"
                    ? "del payload CRUD"
                    : "da leggere"}
              </h3>
              <div className="code-field-checks">
                {activeTable.columns.map((c) => (
                  <label className="check" key={c.name}>
                    <input
                      type="checkbox"
                      disabled={["writes", "project", "rest"].includes(
                        artifact,
                      )}
                      checked={
                        !options.columns.length ||
                        options.columns.includes(c.name)
                      }
                      onChange={(e) => {
                        const current = options.columns.length
                          ? options.columns
                          : activeTable.columns.map((c) => c.name);
                        patch({
                          columns: e.target.checked
                            ? [...new Set([...current, c.name])]
                            : current.filter((n) => n !== c.name),
                        });
                      }}
                    />
                    {c.name}
                    <small>
                      {c.dataType}
                      {c.primaryKey ? " · PK" : ""}
                    </small>
                  </label>
                ))}
              </div>
            </>
          )}
          {artifact === "model" && (
            <label className="check">
              <input
                type="checkbox"
                checked={allModels}
                onChange={(e) => setAllModels(e.target.checked)}
              />
              Genera un modello per tutte le tabelle del progetto
            </label>
          )}
          {isRead && options.operation === "findByKey" && (
            <Notice>
              La lettura per chiave usa{" "}
              {activeTable?.columns
                .filter((c) => c.primaryKey)
                .map((c) => c.name)
                .join(", ") ||
                "una chiave primaria: seleziona una tabella che la possiede"}{" "}
              come parametri.
            </Notice>
          )}
          {isRead &&
            ["filter", "join", "aggregate"].includes(options.operation) && (
              <>
                <div className="row">
                  <h3>Condizioni</h3>
                  <span className="spacer" />
                  <Button
                    variant="ghost"
                    onClick={() =>
                      patch({
                        filters: [
                          ...options.filters,
                          {
                            column: activeTable?.columns[0]?.name || "",
                            operator: "=",
                            value: "",
                          },
                        ],
                      })
                    }
                  >
                    <Plus size={13} />
                    Filtro
                  </Button>
                </div>
                {options.filters.map((f, i) => (
                  <div className="operation-filter" key={i}>
                    <select
                      aria-label={`Campo filtro ${i + 1}`}
                      value={f.column}
                      onChange={(e) =>
                        patch({
                          filters: options.filters.map((v, j) =>
                            j === i ? { ...v, column: e.target.value } : v,
                          ),
                        })
                      }
                    >
                      {activeTable?.columns.map((c) => (
                        <option key={c.name}>{c.name}</option>
                      ))}
                    </select>
                    <select
                      aria-label={`Operatore filtro ${i + 1}`}
                      value={f.operator}
                      onChange={(e) =>
                        patch({
                          filters: options.filters.map((v, j) =>
                            j === i ? { ...v, operator: e.target.value } : v,
                          ),
                        })
                      }
                    >
                      {[
                        "=",
                        "!=",
                        ">",
                        ">=",
                        "<",
                        "<=",
                        "LIKE",
                        "IS NULL",
                        "IS NOT NULL",
                      ].map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                    <input
                      aria-label={`Valore filtro ${i + 1}`}
                      disabled={f.operator.includes("NULL")}
                      value={f.value}
                      onChange={(e) =>
                        patch({
                          filters: options.filters.map((v, j) =>
                            j === i ? { ...v, value: e.target.value } : v,
                          ),
                        })
                      }
                      placeholder="Valore di esempio"
                    />
                    <button
                      className="icon-button"
                      aria-label={`Rimuovi filtro ${i + 1}`}
                      onClick={() =>
                        patch({
                          filters: options.filters.filter((_, j) => j !== i),
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </>
            )}
          {isRead && options.operation === "join" && (
            <div className="form-grid">
              <Field label="Tabella collegata">
                <select
                  value={options.joinTable}
                  onChange={(e) =>
                    patch({ joinTable: e.target.value, joinForeign: "" })
                  }
                >
                  <option value="">Scegli una tabella</option>
                  {dataTables
                    .filter((t) => t.name !== activeTable?.name)
                    .map((t) => (
                      <option key={t.name}>{t.name}</option>
                    ))}
                </select>
              </Field>
              <Field label="Tipo di relazione">
                <select
                  value={options.joinType}
                  onChange={(e) =>
                    patch({ joinType: e.target.value as "LEFT" | "INNER" })
                  }
                >
                  <option>LEFT</option>
                  <option>INNER</option>
                </select>
              </Field>
              <Field label="Campo della tabella iniziale">
                <select
                  value={options.joinLocal}
                  onChange={(e) => patch({ joinLocal: e.target.value })}
                >
                  <option value="">Campo origine</option>
                  {activeTable?.columns.map((c) => (
                    <option key={c.name}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Campo collegato">
                <select
                  value={options.joinForeign}
                  onChange={(e) => patch({ joinForeign: e.target.value })}
                >
                  <option value="">Campo destinazione</option>
                  {dataTables
                    .find((t) => t.name === options.joinTable)
                    ?.columns.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                </select>
              </Field>
            </div>
          )}
          {isRead && options.operation === "aggregate" && (
            <>
              <div className="form-grid">
                <Field label="Funzione">
                  <select
                    value={options.aggregate}
                    onChange={(e) => patch({ aggregate: e.target.value })}
                  >
                    {["COUNT", "SUM", "AVG", "MIN", "MAX"].map((f) => (
                      <option key={f}>{f}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Campo del calcolo">
                  <select
                    value={options.aggregateColumn}
                    onChange={(e) => patch({ aggregateColumn: e.target.value })}
                  >
                    <option value="*">Tutte le righe (*)</option>
                    {activeTable?.columns.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Raggruppa per">
                <select
                  multiple
                  value={options.groupBy}
                  onChange={(e) =>
                    patch({
                      groupBy: Array.from(e.target.selectedOptions).map(
                        (o) => o.value,
                      ),
                    })
                  }
                >
                  {activeTable?.columns.map((c) => (
                    <option key={c.name}>{c.name}</option>
                  ))}
                </select>
              </Field>
            </>
          )}
          {isRead && options.operation === "custom" && (
            <Field
              label="Parametri della query · JSON"
              hint="I parametri dell’editor vengono riportati qui. Per PostgreSQL usa chiavi 1, 2 oppure nomi coerenti con l’ordine dei segnaposto."
            >
              <textarea
                className="mono"
                rows={5}
                value={customParameterText}
                onChange={(event) => setCustomParameterText(event.target.value)}
              />
            </Field>
          )}
          {isRead && options.operation !== "custom" && (
            <div className="form-grid">
              <Field label="Ordina per">
                <select
                  value={options.orderBy}
                  onChange={(e) => patch({ orderBy: e.target.value })}
                >
                  <option value="">Nessun ordinamento</option>
                  {activeTable?.columns.map((c) => (
                    <option key={c.name}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Massimo risultati">
                <input
                  type="number"
                  min={1}
                  max={10000}
                  value={options.limit}
                  onChange={(e) => patch({ limit: Number(e.target.value) })}
                />
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={options.descending}
                  onChange={(e) => patch({ descending: e.target.checked })}
                />
                Decrescente
              </label>
            </div>
          )}
          {isRead && (
            <>
              <div className="operation-sql-preview">
                <small>
                  {selectedEngine === "mongodb"
                    ? "COMANDO MONGODB"
                    : "QUERY PARAMETRIZZATA"}
                </small>
                <pre>
                  {built.query ||
                    built.error ||
                    "Definisci lo schema per vedere la query."}
                </pre>
              </div>
              {built.parameters.length > 0 && (
                <details>
                  <summary>Parametri separati dalla query</summary>
                  <pre>{JSON.stringify(built.parameters, null, 2)}</pre>
                </details>
              )}
              <p className="muted small">{built.lesson}</p>
              {onOpenQuery && (
                <Button
                  disabled={!built.query || !!built.error}
                  onClick={tryQuery}
                >
                  <Play size={13} />
                  Prova nell’editor
                </Button>
              )}
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={educational}
              onChange={(e) => setEducational(e.target.checked)}
            />
            Commenti e spiegazioni italiane
          </label>
          <Button
            variant="primary"
            disabled={!activeTable || !!(isRead && built.error)}
            busy={busy === "generate"}
            onClick={generate}
          >
            <WandSparkles size={15} />
            Genera{" "}
            {ARTIFACTS.find(([id]) => id === artifact)?.[1].toLowerCase()}
          </Button>
        </section>
        <section className="panel generated-panel">
          <div className="code-output-heading">
            <h2>
              <Code2 size={17} />
              {language} · {ARTIFACTS.find(([id]) => id === artifact)?.[1]}
            </h2>
            {project && (
              <Button disabled={stale} onClick={copy}>
                {copied ? <Check size={14} /> : <Copy size={14} />}Copia file
              </Button>
            )}
          </div>
          {stale && (
            <Notice>
              Le scelte sono cambiate. Premi Genera per aggiornare il codice
              prima di copiarlo.
            </Notice>
          )}
          {project ? (
            <>
              <div className="file-tabs">
                {project.files.map((f, i) => (
                  <button
                    key={f.path}
                    className={i === fileIndex ? "active" : ""}
                    onClick={() => setFileIndex(i)}
                  >
                    {f.path}
                  </button>
                ))}
              </div>
              <div className="generated-editor">
                <Editor
                  height="450px"
                  value={file?.content || ""}
                  language={editorLanguage}
                  theme={dark ? "vs-dark" : "light"}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 14,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              </div>
              {project.command && (
                <div className="command-line">
                  <span>USO</span>
                  <code>{project.command}</code>
                </div>
              )}
              <div className="generator-notes">
                {project.notes.map((n, i) => (
                  <p key={i}>{n}</p>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-state">
              <Code2 size={35} />
              <h2>Il codice nasce dalle tue scelte</h2>
              <p>
                Disegna lo schema oppure seleziona una tabella. Scegli lettura,
                filtri o relazioni e genera il formato adatto.
              </p>
              <div className="language-chips">
                {LANGUAGES.map((l) => (
                  <span key={l}>{l}</span>
                ))}
              </div>
              {onDesign && (
                <Button onClick={onDesign}>
                  Crea uno schema graficamente
                  <ArrowRight size={14} />
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {project && (
        <div className="panel export-bar">
          <Field label="Cartella di destinazione">
            <PathInput
              kind="directory"
              value={destination}
              onChange={setDestination}
              placeholder="C:\\Progetti\\mia-app"
            />
          </Field>
          <Button
            disabled={stale || !destination.trim()}
            busy={busy === "export"}
            onClick={exportProject}
          >
            <Download size={14} />
            Esporta file
          </Button>
          <Button
            disabled={!exported || stale}
            onClick={async () => {
              try {
                await api("open_vscode", { path: exported });
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            <FolderOpen size={14} />
            Apri in VS Code
          </Button>
        </div>
      )}
      {exported && <Notice tone="success">File esportati in {exported}</Notice>}
    </div>
  );
}
