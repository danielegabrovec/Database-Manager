import { useEffect, useState } from "react";
import { Code2, Copy, Download, FolderOpen, RotateCcw } from "lucide-react";
import { api } from "../api";
import { AppIntegrationPanel } from "../components/AppIntegrationPanel";
import { PathInput } from "../components/PathInput";
import { ProjectSchemaAdmin } from "../components/ProjectSchemaAdmin";
import { ProjectSyncPanel } from "../components/ProjectSyncPanel";
import { Button, Field, Notice, SectionHeader } from "../components/UI";
import type { ExtractedDatabaseOperation } from "../files/queryExtraction";
import type { ApplicationProject } from "../project/applicationProject";
import {
  addProjectSourceOperation,
  analyzeProjectSource,
  buildApplicationPackage,
  PACKAGE_MANIFEST,
  projectImportConflicts,
  readProjectPackageManifest,
  type ApplicationPackage,
} from "../project/packageModel";
import { LANGUAGES } from "../types";
import { errorMessage, objectLabel } from "../utils";
import "../code-workbench.css";

export type ProjectCodeAction =
  "test" | "copy" | "integrate" | "reimport" | "export";
type Props = {
  project: ApplicationProject;
  dark: boolean;
  onImportProject?: (project: ApplicationProject) => void;
  onImport?: (project: ApplicationProject) => void;
  command?: ProjectCodeAction | { action: ProjectCodeAction; id?: string };
};

function configuredLanguage(projectId: string) {
  try {
    const saved = localStorage.getItem(`dbm-project-language:${projectId}`);
    const normalized = saved?.toLowerCase();
    return (
      LANGUAGES.find((language) => language.toLowerCase() === normalized) ??
      (normalized === "csharp" ? "C#" : normalized === "cpp" ? "C++" : "Python")
    );
  } catch {
    return "Python";
  }
}

export function ProjectCodeView({
  project,
  onImportProject,
  onImport,
  command,
}: Props) {
  const applyImport = onImportProject || onImport;
  const [language, setLanguage] = useState(() =>
    configuredLanguage(project.id),
  );
  const [includeSeed, setIncludeSeed] = useState(false);
  const [bundle, setBundle] = useState<ApplicationPackage | null>(null);
  const [bundleKey, setBundleKey] = useState("");
  const [operationIndex, setOperationIndex] = useState(0);
  const [filePath, setFilePath] = useState("");
  const [destination, setDestination] = useState("");
  const [exported, setExported] = useState("");
  const [panel, setPanel] = useState<
    "code" | "integrate" | "reimport" | "export"
  >("code");
  const [imported, setImported] = useState<ApplicationProject | null>(null);
  const [analyzed, setAnalyzed] = useState<ExtractedDatabaseOperation[]>([]);
  const [analysisIndex, setAnalysisIndex] = useState(0);
  const [analysisDb, setAnalysisDb] = useState("");
  const [analysisParams, setAnalysisParams] = useState("{}");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fingerprint = JSON.stringify({ project, language, includeSeed });
  const ready = !!bundle && bundleKey === fingerprint;
  const selectedOperation = bundle?.operations[operationIndex];
  const currentPath =
    filePath || selectedOperation?.sourcePath || bundle?.files[0]?.path || "";
  const currentFile = bundle?.files.find((file) => file.path === currentPath);
  const commandAction = typeof command === "string" ? command : command?.action;
  const commandId = typeof command === "object" ? command.id : undefined;
  const seedCount = project.databases.reduce(
    (total, db) =>
      total + db.seed.filter((row) => row.enabled !== false).length,
    0,
  );

  useEffect(() => setLanguage(configuredLanguage(project.id)), [project.id]);

  useEffect(() => {
    if (!commandAction) return;
    setPanel(
      commandAction === "test"
        ? "integrate"
        : commandAction === "copy"
          ? "code"
          : commandAction,
    );
  }, [commandAction, commandId]);

  async function generate() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await buildApplicationPackage(
        project,
        language,
        includeSeed,
      );
      setBundle(result);
      setBundleKey(fingerprint);
      setOperationIndex(0);
      setFilePath("");
      setExported("");
      setNotice(`Pacchetto generato con ${result.files.length} file.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copy(path?: string) {
    const file = bundle?.files.find((item) => item.path === path);
    if (!ready || !file) return;
    setError("");
    try {
      await navigator.clipboard.writeText(file.content);
      setNotice(`Copiato ${file.path.split("/").at(-1)}.`);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function exportPackage() {
    if (!ready || !bundle || !destination.trim()) return;
    setBusy(true);
    setError("");
    try {
      setExported(
        await api<string>("export_application_package", {
          package: bundle,
          destination,
        }),
      );
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setError("");
    setNotice("");
    setImported(null);
    setAnalyzed([]);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("Il file supera 8 MiB.");
      const text = await file.text();
      if (
        file.name.toLowerCase() === PACKAGE_MANIFEST ||
        /^\s*\{[^]*"format"\s*:\s*"database-manager-project"/.test(text)
      ) {
        setImported(readProjectPackageManifest(text));
        return;
      }
      const operations = analyzeProjectSource(text, file.name);
      if (!operations.length)
        throw new Error(
          "Il file non contiene query letterali riconoscibili. Puoi importare il manifesto o incollare una query nell’editor del grafo.",
        );
      setAnalyzed(operations);
      setAnalysisIndex(0);
      setAnalysisDb(
        selectedOperation?.databaseId ?? project.databases[0]?.id ?? "",
      );
      setAnalysisParams("{}");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function importOperation() {
    if (!applyImport || !analyzed[analysisIndex]) return;
    setError("");
    try {
      const parameters: unknown = JSON.parse(analysisParams);
      if (
        !parameters ||
        typeof parameters !== "object" ||
        Array.isArray(parameters)
      )
        throw new Error("I parametri devono essere un oggetto JSON.");
      applyImport(
        addProjectSourceOperation(
          project,
          analysisDb,
          analyzed[analysisIndex],
          parameters as Record<string, unknown>,
        ),
      );
      setAnalyzed([]);
      setNotice(
        "Query rianalizzata e aggiunta alle operazioni del database scelto.",
      );
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  const conflicts = imported ? projectImportConflicts(project, imported) : [];
  const nav: [typeof panel, string][] = [
    ["code", "Copia"],
    ["integrate", "Integra e prova"],
    ["reimport", "Rileggi codice"],
    ["export", "Esporta"],
  ];
  return (
    <section className="stack">
      <SectionHeader
        title="Codice del progetto"
        description="Genera un pacchetto per i database del progetto e copia le operazioni da integrare."
      />
      <div className="panel stack">
        <div className="row wrap">
          <Field label="Linguaggio">
            <select
              value={language}
              onChange={(event) => {
                const selected = event.target.value;
                setLanguage(selected);
                try {
                  localStorage.setItem(
                    `dbm-project-language:${project.id}`,
                    selected,
                  );
                } catch {}
              }}
            >
              {LANGUAGES.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={includeSeed}
              disabled={!seedCount}
              onChange={(event) => setIncludeSeed(event.target.checked)}
            />
            Includi {seedCount} righe seed selezionate
          </label>
          <Button variant="primary" busy={busy} onClick={() => void generate()}>
            <Code2 size={15} />
            Genera pacchetto
          </Button>
        </div>
        <div className="row wrap" aria-label="Azioni del pacchetto">
          {nav.map(([id, label]) => (
            <Button
              key={id}
              variant={panel === id ? "primary" : "secondary"}
              onClick={() => setPanel(id)}
            >
              {label}
            </Button>
          ))}
        </div>
        {bundle && !ready && (
          <Notice>
            Il progetto o le opzioni sono cambiati. Rigenera il pacchetto per
            copiarlo o esportarlo.
          </Notice>
        )}
      </div>
      {panel === "code" && (
        <section className="panel stack">
          <ProjectSchemaAdmin
            project={project}
            bundle={ready ? bundle : null}
          />
          {bundle && (
            <>
              <Field label="Operazione">
                <select
                  value={operationIndex}
                  onChange={(event) => {
                    setOperationIndex(Number(event.target.value));
                    setFilePath("");
                  }}
                >
                  {bundle.operations.map((operation, index) => (
                    <option
                      key={`${operation.databaseId}-${operation.id}`}
                      value={index}
                    >
                      {operation.databaseName} · {objectLabel(operation.table)}{" "}
                      · {operation.name}
                    </option>
                  ))}
                </select>
              </Field>
              <div className="row wrap">
                <Button
                  disabled={!ready || !selectedOperation?.sourcePath}
                  onClick={() => void copy(selectedOperation?.sourcePath)}
                >
                  <Copy size={14} />
                  Copia funzione
                </Button>
                <Button
                  disabled={!ready || !selectedOperation?.queryPath}
                  onClick={() => void copy(selectedOperation?.queryPath)}
                >
                  <Copy size={14} />
                  Copia SQL/MQL
                </Button>
                <Button
                  disabled={!ready || !selectedOperation?.parametersPath}
                  onClick={() => void copy(selectedOperation?.parametersPath)}
                >
                  <Copy size={14} />
                  Copia parametri
                </Button>
              </div>
              <Field label="File del pacchetto">
                <select
                  value={currentPath}
                  onChange={(event) => setFilePath(event.target.value)}
                >
                  {bundle.files.map((file) => (
                    <option key={file.path}>{file.path}</option>
                  ))}
                </select>
              </Field>
              {currentFile && (
                <>
                  <pre
                    className="mono"
                    style={{ maxHeight: "26rem", overflow: "auto" }}
                  >
                    {currentFile.content}
                  </pre>
                  <Button
                    disabled={!ready}
                    onClick={() => void copy(currentPath)}
                  >
                    Copia file selezionato
                  </Button>
                </>
              )}
            </>
          )}
        </section>
      )}
      {panel === "integrate" && (
        <section className="panel stack">
          <h2>Integrazione del pacchetto</h2>
          <p>
            Esporta i file, apri la cartella nell’IDE e segui il README della
            destinazione. Per incollare una funzione nell’applicazione usa la
            connessione e i parametri del tuo driver.
          </p>
          {bundle?.command && <pre>{bundle.command}</pre>}
          {bundle && (
            <details>
              <summary>Istruzioni del pacchetto</summary>
              <pre style={{ maxHeight: "24rem", overflow: "auto" }}>
                {
                  bundle.files.find((file) => file.path === "README.md")
                    ?.content
                }
              </pre>
            </details>
          )}
          {exported && (
            <Button
              onClick={() =>
                void api("open_vscode", { path: exported }).catch((reason) =>
                  setError(errorMessage(reason)),
                )
              }
            >
              <FolderOpen size={14} />
              Apri cartella in VS Code
            </Button>
          )}
          {ready && bundle && (
            <AppIntegrationPanel bundle={bundle} projectId={project.id} />
          )}
        </section>
      )}
      {panel === "export" && (
        <section className="panel stack">
          <Field
            label="Cartella di destinazione"
            hint="Ogni esportazione crea una nuova sottocartella."
          >
            <PathInput
              kind="directory"
              value={destination}
              onChange={setDestination}
            />
          </Field>
          <Button
            variant="primary"
            busy={busy}
            disabled={!ready || !destination.trim()}
            onClick={() => void exportPackage()}
          >
            <Download size={15} />
            Esporta progetto
          </Button>
          {exported && (
            <Notice tone="success">Pacchetto esportato in {exported}</Notice>
          )}
        </section>
      )}
      {panel === "reimport" && (
        <section className="panel stack">
          <ProjectSyncPanel project={project} onImport={applyImport} />
          <Field
            label="Manifesto o sorgente modificato"
            hint="Il file è analizzato senza eseguirlo."
          >
            <input
              type="file"
              onChange={(event) => {
                const selected = event.target.files?.[0];
                event.target.value = "";
                void loadFile(selected);
              }}
            />
          </Field>
          {imported && (
            <>
              <Notice>
                Il manifesto contiene il progetto {imported.name} con{" "}
                {imported.databases.length} database.
              </Notice>
              {!!conflicts.length && (
                <Notice tone="error">
                  Versioni diverse per {conflicts.join(", ")}. Conferma solo se
                  vuoi usare il contenuto del manifesto.
                </Notice>
              )}
              <div className="row wrap">
                <Button onClick={() => setImported(null)}>
                  Mantieni il progetto aperto
                </Button>
                <Button
                  variant="primary"
                  disabled={!applyImport}
                  onClick={() => {
                    applyImport?.(imported);
                    setImported(null);
                    setNotice("Progetto importato dal manifesto.");
                  }}
                >
                  <RotateCcw size={14} />
                  Usa il progetto importato
                </Button>
              </div>
            </>
          )}
          {!!analyzed.length && (
            <>
              <Field label="Database del grafo">
                <select
                  value={analysisDb}
                  onChange={(event) => setAnalysisDb(event.target.value)}
                >
                  {project.databases.map((db) => (
                    <option key={db.id} value={db.id}>
                      {db.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Istruzione riconosciuta">
                <select
                  value={analysisIndex}
                  onChange={(event) =>
                    setAnalysisIndex(Number(event.target.value))
                  }
                >
                  {analyzed.map((operation, index) => (
                    <option key={operation.id} value={index}>
                      {operation.label} · riga {operation.startLine}
                    </option>
                  ))}
                </select>
              </Field>
              <pre
                className="mono"
                style={{ maxHeight: "18rem", overflow: "auto" }}
              >
                {analyzed[analysisIndex]?.text}
              </pre>
              {!!analyzed[analysisIndex]?.parameters.length && (
                <Field
                  label="Valori dei parametri in JSON"
                  hint='Per quelli posizionali usa chiavi come "1" e "2".'
                >
                  <textarea
                    value={analysisParams}
                    onChange={(event) => setAnalysisParams(event.target.value)}
                  />
                </Field>
              )}
              <Button
                variant="primary"
                disabled={!applyImport}
                onClick={importOperation}
              >
                Aggiungi l’operazione al progetto
              </Button>
            </>
          )}
        </section>
      )}
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
    </section>
  );
}
