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
import type {
  Engine,
  GeneratedProject,
  Mode,
  ObjectRef,
  SchemaSnapshot,
} from "../types";
import { ENGINE_LABELS, LANGUAGES } from "../types";
import { canBrowseData, errorMessage, objectKey } from "../utils";
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
  ["script", "Script della query"],
  ["schemaScript", "Script dello schema"],
  ["migration", "Script della migrazione"],
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
  migrationScript,
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
  migrationScript?: string;
  designSource?: boolean;
  initialTable?: ObjectRef;
  queryParameters?: Record<string, unknown>;
  onDesign?: () => void;
  onOpenQuery?: (query: string, parameters?: Record<string, unknown>) => void;
}) {
  const [customParameterText, setCustomParameterText] = useState(
    JSON.stringify(queryParameters, null, 2),
  );
  const [language, setLanguage] = useState("Python");
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
  const initialTableKey = initialTable ? objectKey(initialTable) : "";
  useEffect(() => {
    if (initialTableKey) {
      setTable(initialTableKey);
      setOptions({ ...INITIAL_READ, custom: "" });
    }
  }, [initialTableKey]);
  useEffect(() => setOptions((old) => ({ ...old, custom: query })), [query]);
  const selectedEngine = schema?.engine ?? engine;
  const dataTables = useMemo(
    () => schema?.tables.filter(canBrowseData) || [],
    [schema],
  );
  const activeTable =
    dataTables.find((t) => objectKey(t) === table) || dataTables[0];
  const activeDefinition = schemaScript || activeTable?.definition || "";
  const languageId = LANGUAGE_IDS[language] || language.toLowerCase();
  const isRead = ["read", "function", "repository", "script"].includes(
    artifact,
  );
  const isWrite = ["writes", "project", "rest"].includes(artifact);
  const artifactError = !activeTable
    ? "Apri una struttura o seleziona una tabella."
    : artifact === "migration" && !migrationScript
      ? "Apri un piano di migrazione valido nel Designer."
      : (artifact === "schemaScript" || artifact === "schema") &&
          !activeDefinition
        ? "Apri lo schema nel Designer o usa l’esportazione nativa da Trasferimenti."
        : (artifact === "rest" ||
              (artifact === "schema" && selectedEngine === "mongodb")) &&
            !["rust", "python", "javascript", "typescript"].includes(languageId)
          ? "Scegli Rust, Python, JavaScript o TypeScript per questo formato."
          : isWrite && /view/i.test(activeTable.kind)
            ? "Seleziona una tabella o collezione per generare codice CRUD."
            : "";
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
    table: allModels && artifact === "model" ? dataTables : activeTable,
    options,
    built: isRead ? built : null,
    engine: selectedEngine,
    educational,
    allModels,
    schemaScript,
    migrationScript,
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
      if (!activeTable || artifactError) throw new Error(artifactError);
      if (built.error && isRead) throw new Error(built.error);
      let output: GeneratedProject;
      if (artifact === "schemaScript" || artifact === "migration") {
        const name = artifact === "schemaScript" ? "schema" : "migrazione";
        output = {
          files: [
            {
              path: `${name}.${selectedEngine === "mongodb" ? "json" : "sql"}`,
              content:
                artifact === "migration" ? migrationScript! : activeDefinition,
            },
          ],
          command:
            "Apri lo script nella connessione del motore corrispondente e rivedilo prima di eseguire.",
          notes:
            artifact === "migration"
              ? [
                  "Rivedi il piano, verifica la destinazione e prova su una copia prima di applicarlo.",
                ]
              : [
                  schemaScript
                    ? "Script delle strutture del progetto visuale."
                    : "Definizione dell’oggetto selezionato.",
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
            schemaDefinition: activeDefinition,
            writeColumnMetadata: activeTable.columns.map((column) => ({
              name: column.name,
              defaultValue: column.defaultValue,
              identity: column.identity,
              generated: column.generated,
            })),
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
                ? activeDefinition
                : isRead
                  ? built.template || built.query
                  : "",
            parameters: isRead ? built.parameters : [],
            educational,
          },
        });
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
    const params =
      options.operation === "custom"
        ? JSON.parse(customParameterText)
        : Object.fromEntries(
            built.parameters.map((p, i) => [
              selectedEngine === "postgresql" ? String(i + 1) : p.name,
              p.value,
            ]),
          );
    onOpenQuery?.(built.query, params);
  }
  const file = project?.files[fileIndex];
  const joinTable = dataTables.find(
    (target) => objectKey(target) === options.joinTable,
  );
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
        description="Esporta query, funzioni, progetti CRUD o script di struttura dal database o dal Designer."
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
        <Field label="Motore della sorgente">
          <input value={ENGINE_LABELS[selectedEngine]} readOnly />
        </Field>
        <Field label="Tabella o collezione">
          <select
            value={activeTable ? objectKey(activeTable) : ""}
            onChange={(e) => {
              setTable(e.target.value);
              setOptions({ ...INITIAL_READ, custom: query });
            }}
          >
            <option value="" disabled>
              Definisci o apri uno schema
            </option>
            {dataTables.map((t) => (
              <option key={objectKey(t)} value={objectKey(t)}>
                {t.schema ? t.schema + "." : ""}
                {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Linguaggio">
          <select
            value={language}
            disabled={["script", "schemaScript", "migration"].includes(
              artifact,
            )}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGUAGES.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </Field>
        <Field label="Formato da generare">
          <select
            value={artifact}
            onChange={(e) => setArtifact(e.target.value)}
          >
            {ARTIFACTS.filter(
              ([id]) =>
                id !== "migration" ||
                !!migrationScript ||
                artifact === "migration",
            ).map(([id, label]) => (
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
          {artifactError && activeTable && <Notice>{artifactError}</Notice>}
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
              Genera una funzione per applicare lo schema usando una connessione
              aperta dalla tua applicazione. I quattro motori SQL supportano i
              dodici linguaggi. Per MongoDB sono disponibili Rust, Python,
              JavaScript e TypeScript e lo script dello schema JSON.
            </Notice>
          )}
          {activeTable &&
            ((isRead && !["custom", "aggregate"].includes(options.operation)) ||
              artifact === "model") && (
              <>
                <h3>
                  Campi {artifact === "model" ? "del modello" : "da leggere"}
                </h3>
                <div className="code-field-checks">
                  {activeTable.columns.map((c) => (
                    <label className="check" key={c.name}>
                      <input
                        type="checkbox"
                        disabled={
                          (artifact === "model" && allModels) ||
                          (options.columns.length === 1 &&
                            options.columns[0] === c.name) ||
                          (!options.columns.length &&
                            activeTable.columns.length === 1)
                        }
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
                    .filter(
                      (t) =>
                        !activeTable || objectKey(t) !== objectKey(activeTable),
                    )
                    .map((t) => (
                      <option key={objectKey(t)} value={objectKey(t)}>
                        {t.schema ? `${t.schema}.` : ""}
                        {t.name}
                      </option>
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
                  {joinTable?.columns.map((c) => (
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
                  {options.operation === "aggregate" && (
                    <option
                      value={selectedEngine === "mongodb" ? "total" : "totale"}
                    >
                      Totale
                    </option>
                  )}
                  {activeTable?.columns
                    .filter(
                      (column) =>
                        options.operation !== "aggregate" ||
                        options.groupBy.includes(column.name),
                    )
                    .map((c) => (
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
            disabled={!!artifactError || !!(isRead && built.error)}
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
              {!["script", "schemaScript", "migration"].includes(artifact) &&
                `${language} · `}
              {ARTIFACTS.find(([id]) => id === artifact)?.[1]}
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
