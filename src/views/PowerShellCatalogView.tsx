import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  ArrowUpRight,
  Check,
  Copy,
  FileCode2,
  FileDown,
  RotateCcw,
  Search,
  TerminalSquare,
} from "lucide-react";
import { CatalogShell } from "../components/CatalogShell";
import { Button, Field, Notice } from "../components/UI";
import { ENGINES, ENGINE_LABELS } from "../types";
import {
  buildPowerShellScript,
  powerShellCatalog,
  type PowerShellEntry,
  type PowerShellParameter,
  type PowerShellValues,
} from "../powershell/catalog";
import { errorMessage } from "../utils";
import "../powershell-catalog.css";

export interface PowerShellPreviewDraft {
  name: string;
  content: string;
  language: "powershell";
  autoSaveAs?: boolean;
}

export interface PowerShellCatalogViewProps {
  dark: boolean;
  active?: boolean;
  onPreview: (draft: PowerShellPreviewDraft) => void | Promise<void>;
}

const CATEGORIES: Record<PowerShellEntry["category"], string> = {
  files: "File e cartelle",
  diagnostics: "Diagnostica",
  database: "Database",
  docker: "Docker",
  ollama: "Ollama",
};
const LEVELS: Record<PowerShellEntry["level"], string> = {
  base: "Base",
  intermedio: "Intermedio",
};
const EFFECTS: Record<PowerShellEntry["effects"], string> = {
  read: "Sola lettura",
  "write-files": "Scrive file",
  "modify-database": "Modifica il database",
  "modify-environment": "Modifica l’ambiente",
};

function ParameterField({
  parameter,
  value,
  onChange,
}: {
  parameter: PowerShellParameter;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (parameter.type === "boolean")
    return (
      <label className="ps-boolean-field">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <strong>{parameter.label}</strong>
          <small>{parameter.help}</small>
        </span>
      </label>
    );
  return (
    <Field
      label={parameter.label + (parameter.required ? " *" : "")}
      hint={parameter.help}
    >
      {parameter.type === "choice" ? (
        <select
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          required={parameter.required}
        >
          {parameter.choices?.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={parameter.type === "integer" ? "number" : "text"}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
          placeholder={parameter.placeholder}
          required={parameter.required}
          min={parameter.min}
          max={parameter.max}
          step={parameter.type === "integer" ? 1 : undefined}
          spellCheck={false}
          autoComplete="off"
        />
      )}
    </Field>
  );
}

export function PowerShellCatalogView({
  dark,
  active = true,
  onPreview,
}: PowerShellCatalogViewProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [engine, setEngine] = useState("all");
  const [level, setLevel] = useState("all");
  const [selectedId, setSelectedId] = useState("");
  const [valuesByEntry, setValuesByEntry] = useState<
    Record<string, PowerShellValues>
  >({});
  const [busy, setBusy] = useState<"copy" | "preview" | "export" | null>(null);
  const [feedback, setFeedback] = useState<{ id: string; text: string } | null>(
    null,
  );
  const [error, setError] = useState<{ id: string; text: string } | null>(null);
  const searchTerm = search.trim().toLocaleLowerCase("it");
  const entries = useMemo(
    () =>
      powerShellCatalog.filter(
        (entry) =>
          (category === "all" || entry.category === category) &&
          (engine === "all" ||
            (engine === "general" ? !entry.engine : entry.engine === engine)) &&
          (level === "all" || entry.level === level) &&
          (!searchTerm ||
            [
              entry.title,
              entry.description,
              entry.explanation,
              CATEGORIES[entry.category],
              ...entry.prerequisites,
              ...entry.parameters.map((parameter) => parameter.label),
            ]
              .join(" ")
              .toLocaleLowerCase("it")
              .includes(searchTerm)),
      ),
    [category, engine, level, searchTerm],
  );
  const selected =
    entries.find((entry) => entry.id === selectedId) || entries[0];
  const selectedValues = selected ? valuesByEntry[selected.id] : undefined;
  const visibleFeedback = feedback?.id === selected?.id ? feedback?.text : "";
  const visibleError = error?.id === selected?.id ? error?.text : "";
  const generated = useMemo(() => {
    if (!selected) return null;
    try {
      return {
        project: buildPowerShellScript(selected.id, selectedValues || {}),
        error: "",
      };
    } catch (cause) {
      return { project: null, error: errorMessage(cause) };
    }
  }, [selected, selectedValues]);
  useEffect(() => {
    if (!feedback) return;
    const timer = setTimeout(() => setFeedback(null), 2400);
    return () => clearTimeout(timer);
  }, [feedback]);
  function updateParameter(name: string, value: string | number | boolean) {
    if (!selected) return;
    setValuesByEntry((old) => ({
      ...old,
      [selected.id]: { ...old[selected.id], [name]: value },
    }));
    setFeedback(null);
    setError(null);
  }
  function resetFilters() {
    setSearch("");
    setCategory("all");
    setEngine("all");
    setLevel("all");
  }
  const act = useCallback(
    async (action: "copy" | "preview" | "export") => {
      if (!generated?.project || !selected || busy) return;
      const project = generated.project;
      const entryId = selected.id;
      setBusy(action);
      setError(null);
      try {
        if (action === "copy") {
          await navigator.clipboard.writeText(project.content);
          setFeedback({ id: entryId, text: "Script copiato negli appunti." });
        } else {
          await onPreview({
            name: project.name,
            content: project.content,
            language: "powershell",
            ...(action === "export" ? { autoSaveAs: true } : {}),
          });
        }
      } catch (cause) {
        setError({
          id: entryId,
          text:
            action === "copy"
              ? "Copia non disponibile. Seleziona lo script nell’anteprima e usa Ctrl+C."
              : errorMessage(cause),
        });
      } finally {
        setBusy(null);
      }
    },
    [generated, selected, busy, onPreview],
  );
  useEffect(() => {
    if (!active || !generated?.project || busy) return;
    const saveShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s"
      )
        return;
      event.preventDefault();
      void act("export");
    };
    window.addEventListener("keydown", saveShortcut);
    return () => window.removeEventListener("keydown", saveShortcut);
  }, [active, generated, busy, act]);
  return (
    <CatalogShell
      title="Catalogo PowerShell"
      description="Scegli uno script, personalizza i valori e leggi il risultato. Anteprima ed esportazione non eseguono comandi."
      className="ps-catalog"
    >
      <div
        className="ps-catalog-filters"
        role="search"
        aria-label="Cerca script PowerShell"
      >
        <Field label="Cerca nel catalogo">
          <span className="ps-search-input">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label="Cerca nel catalogo PowerShell"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Backup, Docker, CSV, connessione…"
              type="search"
            />
          </span>
        </Field>
        <Field label="Motore">
          <select
            value={engine}
            onChange={(event) => setEngine(event.target.value)}
          >
            <option value="all">Tutti i motori</option>
            <option value="general">Generali</option>
            {ENGINES.map((item) => (
              <option key={item} value={item}>
                {ENGINE_LABELS[item]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Livello">
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          >
            <option value="all">Tutti i livelli</option>
            {Object.entries(LEVELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Button onClick={resetFilters} title="Azzera ricerca e filtri">
          <RotateCcw size={15} /> Azzera filtri
        </Button>
      </div>
      <div
        className="ps-category-bar"
        role="group"
        aria-label="Categorie PowerShell"
      >
        {[["all", "Tutte"], ...Object.entries(CATEGORIES)].map(
          ([value, label]) => (
            <button
              key={value}
              type="button"
              className={category === value ? "active" : ""}
              aria-pressed={category === value}
              onClick={() => setCategory(value)}
            >
              {label}
            </button>
          ),
        )}
        <span className="ps-entry-count" aria-live="polite">
          {entries.length} di {powerShellCatalog.length} script
        </span>
      </div>
      {selected ? (
        <div className="ps-catalog-layout">
          <nav className="ps-script-list" aria-label="Script disponibili">
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={selected.id === entry.id ? "selected" : ""}
                aria-current={selected.id === entry.id ? "true" : undefined}
                onClick={() => {
                  setSelectedId(entry.id);
                  setError(null);
                  setFeedback(null);
                }}
              >
                <span className="ps-script-category">
                  {CATEGORIES[entry.category]}
                </span>
                <strong>{entry.title}</strong>
                <span className="ps-script-meta">
                  {entry.engine ? ENGINE_LABELS[entry.engine] : "Generale"} ·{" "}
                  {LEVELS[entry.level]}
                </span>
              </button>
            ))}
          </nav>
          <section className="ps-script-detail" aria-label={selected.title}>
            <header className="ps-detail-heading">
              <div>
                <span className="ps-script-category">
                  {CATEGORIES[selected.category]}
                </span>
                <h2>{selected.title}</h2>
                <p>{selected.description}</p>
              </div>
              <span
                className={`ps-effects ${selected.effects === "read" ? "read" : "writes"}`}
              >
                {EFFECTS[selected.effects]}
              </span>
            </header>
            <div className="ps-detail-actionbar">
              <div className="ps-script-actions">
                <Button
                  disabled={!generated?.project || !!busy}
                  busy={busy === "copy"}
                  onClick={() => void act("copy")}
                >
                  {visibleFeedback ? <Check size={15} /> : <Copy size={15} />}{" "}
                  Copia
                </Button>
                <Button
                  disabled={!generated?.project || !!busy}
                  busy={busy === "preview"}
                  onClick={() => void act("preview")}
                >
                  <ArrowUpRight size={15} /> Apri nell’editor file
                </Button>
                <Button
                  variant="primary"
                  disabled={!generated?.project || !!busy}
                  busy={busy === "export"}
                  onClick={() => void act("export")}
                >
                  <FileDown size={15} /> Esporta .ps1
                </Button>
              </div>
              {visibleFeedback && (
                <div
                  className="ps-action-feedback"
                  role="status"
                  aria-live="polite"
                >
                  {visibleFeedback}
                </div>
              )}
              {visibleError && (
                <div role="alert">
                  <Notice tone="error">{visibleError}</Notice>
                </div>
              )}
            </div>
            <details key={selected.id} className="ps-script-guide">
              <summary>
                Come funziona e prerequisiti
                <span>
                  {selected.prerequisites.length}{" "}
                  {selected.prerequisites.length === 1
                    ? "prerequisito"
                    : "prerequisiti"}
                </span>
              </summary>
              <div className="ps-script-guide-content">
                <p className="ps-script-explanation">{selected.explanation}</p>
                {!!selected.prerequisites.length && (
                  <section
                    className="ps-prerequisites"
                    aria-label="Prerequisiti"
                  >
                    <h3>Prima di iniziare</h3>
                    <ul>
                      {selected.prerequisites.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </section>
                )}
              </div>
            </details>
            <div className="ps-script-workspace">
              <section
                className="ps-parameters"
                aria-label="Parametri dello script"
              >
                <div className="ps-subheading">
                  <h3>Parametri</h3>
                  <button
                    type="button"
                    className="ps-text-button"
                    onClick={() => {
                      setValuesByEntry((old) => ({
                        ...old,
                        [selected.id]: {},
                      }));
                      setError(null);
                      setFeedback(null);
                    }}
                  >
                    Valori di esempio
                  </button>
                </div>
                <p className="ps-form-help">
                  I valori iniziali sono esempi. Adattali al tuo ambiente prima
                  di usare lo script.
                </p>
                <div className="ps-parameter-fields">
                  {selected.parameters.length ? (
                    selected.parameters.map((parameter) => (
                      <ParameterField
                        key={`${selected.id}:${parameter.name}`}
                        parameter={parameter}
                        value={
                          selectedValues?.[parameter.name] ??
                          parameter.defaultValue
                        }
                        onChange={(value) =>
                          updateParameter(parameter.name, value)
                        }
                      />
                    ))
                  ) : (
                    <p className="muted">
                      Questo script non richiede parametri.
                    </p>
                  )}
                </div>
              </section>
              <section
                className="ps-code-preview"
                aria-label="Anteprima dello script PowerShell"
              >
                <div className="ps-subheading ps-code-heading">
                  <span>
                    <FileCode2 size={16} />{" "}
                    <strong>
                      {generated?.project?.name || "Anteprima .ps1"}
                    </strong>
                  </span>
                  <span>PowerShell</span>
                </div>
                {generated?.error ? (
                  <div className="ps-preview-error" role="alert">
                    <Notice tone="error">{generated.error}</Notice>
                  </div>
                ) : (
                  <Editor
                    height="260px"
                    language="powershell"
                    value={generated?.project?.content || ""}
                    theme={dark ? "vs-dark" : "light"}
                    options={{
                      readOnly: true,
                      domReadOnly: true,
                      ariaLabel: `Script PowerShell: ${selected.title}`,
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbersMinChars: 3,
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                      wordWrap: "on",
                      padding: { top: 12, bottom: 12 },
                    }}
                  />
                )}
              </section>
            </div>
            {!!generated?.project?.warnings.length && (
              <Notice tone="warning">
                <ul className="ps-warning-list">
                  {generated.project.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Notice>
            )}
            {!!selected.docs.length && (
              <footer className="ps-documentation">
                <span>Documentazione</span>
                {selected.docs.map((doc) => (
                  <a
                    key={doc.url}
                    href={doc.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {doc.title}
                    <ArrowUpRight size={13} />
                  </a>
                ))}
              </footer>
            )}
          </section>
        </div>
      ) : (
        <div className="ps-catalog-empty">
          <TerminalSquare size={30} aria-hidden="true" />
          <h2>Nessuno script corrisponde ai filtri</h2>
          <p>
            Prova un altro termine oppure mostra di nuovo l’intero catalogo.
          </p>
          <Button onClick={resetFilters}>Mostra tutti gli script</Button>
        </div>
      )}
    </CatalogShell>
  );
}
