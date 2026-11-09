import { lazy, Suspense, useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { WindowsServiceDialog } from "../components/WindowsServiceDialog";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bot,
  Box,
  CheckCircle2,
  DatabaseBackup,
  Download,
  HardDrive,
  Play,
  RefreshCw,
  Send,
  Settings2,
  Square,
  Trash2,
} from "lucide-react";
import { api } from "../api";
import { ENGINES, ENGINE_LABELS, ENGINE_PORTS } from "../types";
import type { Engine, EnvironmentInfo, SchemaSnapshot } from "../types";
import { errorMessage, pretty } from "../utils";
import {
  Button,
  Empty,
  Field,
  Modal,
  Notice,
  SectionHeader,
} from "../components/UI";
import { PathInput } from "../components/PathInput";
const AboutPanel = lazy(() =>
  import("../components/AboutPanel").then((module) => ({
    default: module.AboutPanel,
  })),
);

export function TransferView({
  sessionId,
  schema,
}: {
  sessionId: string;
  schema: SchemaSnapshot | null;
}) {
  const [tab, setTab] = useState("export");
  const [table, setTable] = useState("");
  const [format, setFormat] = useState("csv");
  const [path, setPath] = useState("");
  const [content, setContent] = useState("");
  const [limit, setLimit] = useState(10000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [previewFingerprint, setPreviewFingerprint] = useState("");
  const [executablePath, setExecutablePath] = useState("");
  const fingerprint = JSON.stringify([
    sessionId,
    table || schema?.tables[0]?.name,
    format,
    path,
    content,
  ]);
  async function run(action = tab) {
    if (
      action === "import" &&
      format === "sql" &&
      !window.confirm(
        `Eseguire lo script SQL sul database ${schema?.database || "selezionato"}? Rivedi prima DDL e modifiche nell'anteprima.`,
      )
    )
      return;
    setBusy(true);
    setError("");
    try {
      const command = ["backup", "restore"].includes(tab)
        ? "schema_tools"
        : "transfer_data";
      const response = await api(command, {
        request: {
          action,
          confirmed:
            action === "restore" || (action === "import" && format === "sql"),
          executablePath,
          sessionId,
          scope: table === "__database__" ? "database" : "table",
          table:
            table === "__database__" ? "" : table || schema?.tables[0]?.name,
          format,
          path,
          content,
          limit,
          header: true,
        },
      });
      setResult(pretty(response));
      if (action === "previewImport") setPreviewFingerprint(fingerprint);
      else if (action === "import") setPreviewFingerprint("");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="view-content">
      <SectionHeader
        eyebrow="DATI IN MOVIMENTO"
        title="Importa, esporta e conserva"
        description="Trasferisci dati con formati espliciti e gestisci copie di sicurezza con gli strumenti del motore."
      />
      <div className="tab-strip">
        {[
          ["export", "Esporta", ArrowUpFromLine],
          ["import", "Importa", ArrowDownToLine],
          ["backup", "Backup", DatabaseBackup],
          ["restore", "Ripristina", HardDrive],
        ].map(([id, label, Icon]) => {
          const Component = Icon as typeof Download;
          return (
            <button
              key={String(id)}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(String(id));
                setResult("");
                setError("");
              }}
            >
              <Component size={15} />
              {String(label)}
            </button>
          );
        })}
      </div>
      <div className="two-columns">
        <div className="panel stack">
          <div className="form-grid">
            {["export", "import"].includes(tab) && (
              <>
                <Field label="Tabella o collezione">
                  <select
                    value={table || schema?.tables[0]?.name || ""}
                    onChange={(e) => setTable(e.target.value)}
                  >
                    <option value="" disabled>
                      Apri una connessione
                    </option>
                    {format === "sql" && tab === "export" && (
                      <option value="__database__">
                        Intero database · schema e dati
                      </option>
                    )}
                    {schema?.tables
                      .filter((item) => item.columns.length > 0)
                      .map((item) => (
                        <option key={item.name}>{item.name}</option>
                      ))}
                  </select>
                </Field>
                <Field label="Formato">
                  <select
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    <option value="csv">CSV · intestazioni incluse</option>
                    <option value="json">JSON</option>
                    <option value="sql">Script SQL</option>
                    <option value="extended-json">MongoDB Extended JSON</option>
                  </select>
                </Field>
              </>
            )}
            <Field
              label={
                tab === "restore"
                  ? "File di backup da ripristinare"
                  : "Percorso del file"
              }
              hint={
                tab === "import"
                  ? "Puoi indicare un file oppure incollare il contenuto qui sotto."
                  : "Inserisci un percorso assoluto sul computer."
              }
            >
              <PathInput
                value={path}
                onChange={setPath}
                kind={tab === "import" || tab === "restore" ? "open" : "save"}
                placeholder="C:\\Dati\\esportazione.csv"
              />
            </Field>
            {(["backup", "restore"].includes(tab) || format === "sql") &&
              schema?.engine !== "sqlite" && (
                <Field
                  label="Eseguibile del motore (facoltativo)"
                  hint="Lascia vuoto per usare lo strumento rilevato dal gestore."
                >
                  <PathInput
                    value={executablePath}
                    onChange={setExecutablePath}
                    kind="open"
                    placeholder="Rilevamento automatico"
                    filters={[
                      { name: "Programma Windows", extensions: ["exe"] },
                    ]}
                  />
                </Field>
              )}
            {tab === "export" && format !== "sql" && (
              <Field label="Massimo record">
                <input
                  type="number"
                  min={1}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value))}
                />
              </Field>
            )}
          </div>
          {tab === "import" && (
            <Field label="Contenuto da importare">
              <textarea
                className="mono"
                rows={10}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder={
                  format === "csv"
                    ? "nome,email\nMario,mario@example.com"
                    : format === "sql"
                      ? "-- Incolla lo script SQL da rivedere"
                      : '[{"nome":"Mario"}]'
                }
              />
            </Field>
          )}
          {tab === "restore" && (
            <Notice tone="warning">
              Il ripristino può sostituire dati esistenti. Il backend applica le
              verifiche previste dal motore prima dell’operazione.
            </Notice>
          )}
          {tab === "import" && (
            <Button
              onClick={() => run("previewImport")}
              busy={busy}
              disabled={!sessionId || (!path.trim() && !content.trim())}
            >
              <SearchIcon />
              Anteprima e verifica tipi
            </Button>
          )}
          <Button
            variant={tab === "restore" ? "danger" : "primary"}
            busy={busy}
            disabled={
              !sessionId ||
              (!path.trim() && !(tab === "import" && content.trim())) ||
              (tab === "import" && previewFingerprint !== fingerprint)
            }
            onClick={() => {
              if (
                tab !== "restore" ||
                window.confirm(
                  `Ripristinare il database ${schema?.database || "attivo"} dal backup ${path}? Il ripristino può sostituire dati esistenti.`,
                )
              )
                void run(tab);
            }}
          >
            {tab === "export"
              ? "Esporta dati"
              : tab === "import"
                ? "Importa dati"
                : tab === "backup"
                  ? "Crea backup"
                  : "Ripristina backup"}
          </Button>
        </div>
        <div className="panel stack">
          <h2>
            {["backup", "restore"].includes(tab)
              ? "Copie ripristinabili"
              : "Un trasferimento leggibile"}
          </h2>
          <p className="muted">
            {["backup", "restore"].includes(tab)
              ? "Un export di righe e un backup completo hanno scopi differenti. Disponibilità, formato e strumenti richiesti vengono verificati per la connessione attiva."
              : "I valori nulli, le date, i decimali e i documenti MongoDB richiedono formati corretti. Verifica il risultato prima di usarlo in un altro sistema."}
          </p>
          <div className="feature-list">
            <span>
              <CheckCircle2 size={16} />
              Formato e destinazione espliciti
            </span>
            <span>
              <CheckCircle2 size={16} />
              Esito riportato dal backend
            </span>
            <span>
              <CheckCircle2 size={16} />
              Operazioni separate per ogni motore
            </span>
          </div>
          {schema && (
            <div className="context-card">
              <small>CONNESSIONE ATTIVA</small>
              <strong>{schema.database}</strong>
              <span>{ENGINE_LABELS[schema.engine]}</span>
            </div>
          )}
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <div className="panel">
          <h3>Esito operazione</h3>
          <pre className="code-preview">{result}</pre>
        </div>
      )}
    </div>
  );
}

function normalizeEnvironments(value: unknown): EnvironmentInfo[] {
  if (Array.isArray(value)) return value;
  if (
    value &&
    typeof value === "object" &&
    "environments" in value &&
    Array.isArray(value.environments)
  )
    return value.environments;
  return [];
}
export function EnvironmentsView({ onChanged }: { onChanged: () => void }) {
  const [items, setItems] = useState<EnvironmentInfo[]>([]);
  const [engine, setEngine] = useState<Engine>("postgresql");
  const [provider, setProvider] = useState("docker");
  const [mode, setMode] = useState("guided");
  const [name, setName] = useState("");
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [installReview, setInstallReview] = useState<unknown | null>(null);
  const [serviceId, setServiceId] = useState("");
  async function reviewInstall() {
    setBusy("review");
    setError("");
    try {
      const catalog = await api<unknown>("environment_action", {
        request: { action: "catalog" },
      });
      const matching = Array.isArray(catalog)
        ? catalog.filter((item) => item.engine === engine)
        : catalog;
      setInstallReview(matching);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function refresh() {
    try {
      setItems(normalizeEnvironments(await api("environment_list")));
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function action(actionName: string, item?: EnvironmentInfo) {
    setBusy(item?.id ? String(item.id) : actionName);
    setError("");
    try {
      const response = await api("environment_action", {
        request: {
          action: actionName,
          engine,
          provider,
          mode,
          name: name || `dbm-${engine}`,
          port: port ? Number(port) : undefined,
          id: item?.id,
        },
      });
      setResult(pretty(response));
      setInstallReview(null);
      await refresh();
      onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="view-content">
      <SectionHeader
        eyebrow="INFRASTRUTTURA LOCALE"
        title="Un ambiente per ogni progetto"
        description="Collega server esistenti, crea container oppure installa un server nativo Windows."
        action={
          <Button onClick={refresh}>
            <RefreshCw size={14} />
            Aggiorna
          </Button>
        }
      />
      <div className="two-columns">
        <div className="panel stack">
          <div className="segmented">
            <button
              className={provider === "docker" ? "active" : ""}
              onClick={() => setProvider("docker")}
            >
              <Box size={15} />
              Docker
            </button>
            <button
              className={provider === "native" ? "active" : ""}
              onClick={() => setProvider("native")}
            >
              <HardDrive size={15} />
              Server nativo
            </button>
          </div>
          <div className="form-grid">
            <Field label="Motore">
              <select
                value={engine}
                onChange={(e) => {
                  setEngine(e.target.value as Engine);
                  setPort("");
                }}
              >
                {ENGINES.filter((item) => item !== "sqlite").map((item) => (
                  <option value={item} key={item}>
                    {ENGINE_LABELS[item]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Nome ambiente">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`dbm-${engine}`}
              />
            </Field>
            <Field
              label="Porta locale (facoltativa)"
              hint="Lascia vuoto per assegnarne una libera. La porta richiesta viene verificata prima di creare l’ambiente."
            >
              <input
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(e.target.value)}
                placeholder={`Automatica · esempio ${ENGINE_PORTS[engine]}`}
              />
            </Field>
            {provider === "native" && (
              <>
                <Field label="Installazione">
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="guided">
                      Guidata · installer ufficiale
                    </option>
                    <option value="automatic">Automatizzata</option>
                  </select>
                </Field>
              </>
            )}
          </div>
          <Notice>
            {provider === "docker"
              ? "Le risorse gestite dal programma hanno nomi e proprietà riconoscibili. I dati persistono nei volumi finché non vengono rimossi esplicitamente."
              : "Il programma verifica prerequisiti e disponibilità del pacchetto. Le operazioni di sistema possono richiedere l’elevazione di Windows."}
          </Notice>
          <div className="row">
            <Button onClick={() => action("detect")} busy={busy === "detect"}>
              <Activity size={14} />
              Controlla prerequisiti
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                provider === "native" ? reviewInstall() : action("create")
              }
              busy={
                busy === "create" || busy === "install" || busy === "review"
              }
            >
              <PlusIcon />
              {provider === "docker" ? "Crea ambiente" : "Installa server"}
            </Button>
          </div>
        </div>
        <div className="panel">
          <h2>Ambienti rilevati</h2>
          {items.length ? (
            <div className="environment-list">
              {items.map((item, index) => (
                <div className="environment-card" key={item.id || index}>
                  <span className="env-avatar">
                    {item.provider === "docker" ? (
                      <Box size={20} />
                    ) : (
                      <HardDrive size={20} />
                    )}
                  </span>
                  <div>
                    <strong>
                      {item.name || item.id || `Ambiente ${index + 1}`}
                    </strong>
                    <small>
                      {item.engine || "Database"} ·{" "}
                      {item.status || "Stato non riportato"}
                    </small>
                  </div>
                  <div className="row">
                    {isTauri() &&
                      item.provider === "native" &&
                      item.laboratory !== true &&
                      item.id && (
                        <Button
                          variant="ghost"
                          onClick={() => setServiceId(String(item.id))}
                        >
                          Servizio Windows
                        </Button>
                      )}
                    <button
                      className="icon-button"
                      aria-label="Avvia ambiente"
                      disabled={!!busy}
                      onClick={() => action("start", item)}
                    >
                      <Play size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Ferma ambiente"
                      disabled={!!busy}
                      onClick={() => action("stop", item)}
                    >
                      <Square size={14} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label="Rimuovi ambiente"
                      disabled={!!busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Rimuovere l’ambiente ${item.name || item.id}? Verranno applicate le verifiche sulle risorse appartenenti al programma.`,
                          )
                        )
                          void action("delete", item);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={<Box />} title="Nessun ambiente registrato">
              Crea un ambiente oppure controlla i prerequisiti per rilevare ciò
              che è disponibile.
            </Empty>
          )}
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {result && (
        <div className="panel">
          <h3>Dettagli operazione</h3>
          <pre className="code-preview">{result}</pre>
        </div>
      )}
      {serviceId && (
        <WindowsServiceDialog
          id={serviceId}
          onClose={() => setServiceId("")}
          onChanged={() => {
            void refresh();
            onChanged();
          }}
        />
      )}
      {installReview !== null && (
        <Modal
          title="Rivedi installazione del server"
          onClose={() => setInstallReview(null)}
          wide
        >
          <div className="modal-body stack">
            <Notice>
              Motore: <strong>{ENGINE_LABELS[engine]}</strong>. Modalità:{" "}
              <strong>{mode === "guided" ? "Guidata" : "Automatizzata"}</strong>
              . Il catalogo seguente riporta le distribuzioni ammesse e i
              dettagli verificati dal gestore.
            </Notice>
            <pre className="code-preview">{pretty(installReview)}</pre>
            <Notice tone="warning">
              L’installazione crea un ambiente locale gestito dal programma.
              Verranno richiesti i privilegi di Windows solo se necessari. Le
              installazioni esistenti non vengono sostituite.
            </Notice>
          </div>
          <footer>
            <Button onClick={() => setInstallReview(null)}>Annulla</Button>
            <div className="spacer" />
            <Button
              variant="primary"
              busy={busy === "install"}
              onClick={() => action("install")}
            >
              Installa {ENGINE_LABELS[engine]}
            </Button>
          </footer>
        </Modal>
      )}
    </div>
  );
}
function SearchIcon() {
  return <CheckCircle2 size={14} />;
}
function PlusIcon() {
  return <span aria-hidden="true">+</span>;
}

export function SettingsView({
  settings,
  onSave,
}: {
  settings: Record<string, unknown>;
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const existing = (
    settings.ai && typeof settings.ai === "object" ? settings.ai : {}
  ) as Record<string, unknown>;
  const [provider, setProvider] = useState(
    String(existing.provider || "ollama"),
  );
  const [url, setUrl] = useState(
    String(existing.baseUrl || "http://localhost:11434"),
  );
  const [model, setModel] = useState(String(existing.model || ""));
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave({
        ai: { provider, baseUrl: url, model, ...(apiKey ? { apiKey } : {}) },
      });
      setApiKey("");
      setMessage("Configurazione salvata.");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="view-content">
      <SectionHeader
        eyebrow="PREFERENZE"
        title="Il tuo ambiente di lavoro"
        description="Scegli un assistente locale o un servizio cloud compatibile e conserva le preferenze del progetto."
      />
      <div className="two-columns">
        <div className="panel stack">
          <div className="panel-heading">
            <h2>
              <Bot size={19} />
              Assistente query
            </h2>
            <span className="badge">Facoltativo</span>
          </div>
          <Field label="Provider">
            <select
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setUrl(
                  e.target.value === "ollama"
                    ? "http://localhost:11434"
                    : "https://api.openai.com/v1",
                );
              }}
            >
              <option value="ollama">Ollama · modello locale</option>
              <option value="openai-compatible">
                Cloud · API compatibile OpenAI
              </option>
            </select>
          </Field>
          <Field label="Indirizzo del servizio">
            <input value={url} onChange={(e) => setUrl(e.target.value)} />
          </Field>
          <Field
            label="Nome modello"
            hint="Inserisci il nome esatto del modello disponibile nel servizio."
          >
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                provider === "ollama" ? "qwen2.5-coder:14b" : "Nome modello"
              }
            />
          </Field>
          {provider !== "ollama" && (
            <Field
              label="Chiave API"
              hint="Lascia vuoto per mantenere la chiave già configurata."
            >
              <input
                type="password"
                autoComplete="new-password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            </Field>
          )}
          <Button variant="primary" onClick={save} busy={busy}>
            <Settings2 size={15} />
            Salva configurazione
          </Button>
          {message && <Notice tone="success">{message}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
        </div>
        <div className="panel stack">
          <h2>Un’interfaccia, tre modalità</h2>
          <p className="muted">
            La modalità si cambia dal selettore in alto, mantenendo connessioni,
            editor e dati aperti.
          </p>
          <div className="mode-description">
            <strong>Apprendimento personale</strong>
            <span>Spiegazioni, esempi e indicazioni visibili.</span>
          </div>
          <div className="mode-description">
            <strong>Studio e lavoro</strong>
            <span>Strumenti completi e aiuti disponibili quando servono.</span>
          </div>
          <div className="mode-description">
            <strong>Sviluppatori esperti</strong>
            <span>Maggiore densità e accesso diretto alle operazioni.</span>
          </div>
          <div className="separator" />
          <Field label="Dimensione caratteri nell’editor">
            <select
              value={Number(settings.editorFontSize) || 14}
              onChange={(event) =>
                void onSave({
                  editorFontSize: Number(event.target.value),
                }).catch((error) => setError(errorMessage(error)))
              }
            >
              {[12, 14, 16, 18, 20, 24].map((size) => (
                <option key={size} value={size}>
                  {size} px
                </option>
              ))}
            </select>
          </Field>
          <Notice>
            La guida integrata e gli esercizi sono disponibili anche senza un
            modello AI. Le risposte dell’assistente si possono portare
            nell’editor per verificarle.
          </Notice>
          <h3>Comandi rapidi</h3>
          <div className="shortcut-list">
            <span>
              Esegui selezione o query corrente<kbd>Ctrl ↵</kbd>
            </span>
            <span>
              Salva query<kbd>Ctrl S</kbd>
            </span>
            <span>
              Ricerca globale<kbd>Ctrl K</kbd>
            </span>
          </div>
        </div>
      </div>
      <Suspense
        fallback={
          <p className="muted">Caricamento delle informazioni legali…</p>
        }
      >
        <AboutPanel />
      </Suspense>
    </div>
  );
}

export function AssistantPanel({
  sessionId,
  query,
  rows,
  settings,
  onClose,
  onQuery,
}: {
  sessionId: string;
  query: string;
  rows: unknown[];
  settings: Record<string, unknown>;
  onClose: () => void;
  onQuery: (query: string) => void;
}) {
  const [messages, setMessages] = useState<{ role: string; content: string }[]>(
    [],
  );
  const [input, setInput] = useState("");
  const [includeSchema, setIncludeSchema] = useState(false);
  const [includeQuery, setIncludeQuery] = useState(true);
  const [includeRows, setIncludeRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function send(text = input) {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError("");
    setMessages((old) => [...old, { role: "user", content: text }]);
    setInput("");
    try {
      const config = (settings.ai || {}) as Record<string, unknown>;
      const answer = await api<string>("assistant_chat", {
        request: {
          sessionId,
          message: text,
          query,
          provider: config.provider || "ollama",
          model: config.model || "",
          includeSchema,
          includeQuery,
          includeRows,
          rows: includeRows ? rows : undefined,
        },
      });
      setMessages((old) => [...old, { role: "assistant", content: answer }]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="assistant-panel">
      <div className="panel-heading">
        <h2>
          <Bot size={18} />
          Assistente
        </h2>
        <Button variant="ghost" onClick={onClose}>
          Chiudi
        </Button>
      </div>
      <p className="muted small">Spiegazioni ed esempi sulla query corrente.</p>
      <div className="assistant-suggestions">
        <button
          onClick={() =>
            send(
              "Spiega questa query passo dopo passo, usando lo schema disponibile.",
            )
          }
        >
          Spiega la query
        </button>
        <button
          onClick={() =>
            send("Mostra un esempio simile e spiega come cambia il risultato.")
          }
        >
          Un altro esempio
        </button>
        <button
          onClick={() =>
            send(
              "Controlla questa query e spiega eventuali errori o miglioramenti.",
            )
          }
        >
          Controlla gli errori
        </button>
      </div>
      <label className="check small">
        <input
          type="checkbox"
          checked={includeQuery}
          onChange={(e) => setIncludeQuery(e.target.checked)}
        />
        Includi query corrente
      </label>
      <label className="check small">
        <input
          type="checkbox"
          checked={includeSchema}
          onChange={(e) => setIncludeSchema(e.target.checked)}
        />
        Includi struttura del database
      </label>
      <label className="check small">
        <input
          type="checkbox"
          checked={includeRows}
          onChange={(e) => setIncludeRows(e.target.checked)}
          disabled={!rows.length}
        />
        Includi fino a 20 righe del risultato
      </label>
      <div className="chat-messages">
        {!messages.length && (
          <div className="chat-empty">
            <Bot size={28} />
            <p>Parti da una query o da una domanda.</p>
            <small>
              {includeRows
                ? "Sono incluse fino a 20 righe selezionate."
                : "Le righe dei risultati non vengono incluse."}
            </small>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index} className={`chat-message ${message.role}`}>
            <small>{message.role === "user" ? "TU" : "ASSISTENTE"}</small>
            <div>{message.content}</div>
            {message.role === "assistant" &&
              message.content.match(
                /```(?:sql|json|javascript)?\s*\n([\s\S]*?)```/i,
              )?.[1] && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    onQuery(
                      message.content.match(
                        /```(?:sql|json|javascript)?\s*\n([\s\S]*?)```/i,
                      )![1],
                    )
                  }
                >
                  Apri codice nell’editor
                </Button>
              )}
          </div>
        ))}
        {busy && <p className="muted small">L’assistente sta rispondendo…</p>}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        className="chat-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="Domanda all’assistente"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Chiedi una spiegazione o un esempio…"
          rows={3}
        />
        <Button
          type="submit"
          variant="primary"
          disabled={!input.trim()}
          busy={busy}
        >
          <Send size={14} />
          Invia
        </Button>
      </form>
    </aside>
  );
}
