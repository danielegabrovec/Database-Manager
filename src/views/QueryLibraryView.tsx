import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownToLine,
  BookOpen,
  Check,
  Clock3,
  Code2,
  Copy,
  Database,
  ExternalLink,
  Lightbulb,
  Search,
  Star,
} from "lucide-react";
import type {
  Engine,
  HistoryEntry,
  SavedQuery,
  SchemaSnapshot,
} from "../types";
import { ENGINES, ENGINE_LABELS } from "../types";
import { Button, Field, Notice, SectionHeader } from "../components/UI";
import {
  buildQueryCatalog,
  catalogAction,
  historyQueryAction,
  savedQueryAction,
  QUERY_CATEGORIES,
} from "../editor/queryCatalog";
import type {
  LibraryEntry,
  QueryCategory,
  QueryLevel,
  QueryTemplate,
} from "../editor/queryCatalog";
import { dataTables, explainQuery } from "../editor/sqlLanguage";
import "../query-tools.css";

export interface QueryLibraryViewProps {
  engine: Engine;
  schema: SchemaSnapshot | null;
  savedQueries: SavedQuery[];
  history: HistoryEntry[];
  onOpen: (entry: LibraryEntry) => void;
  onInsert: (entry: LibraryEntry) => void;
  onExplain?: (entry: LibraryEntry) => void;
  onFavorite?: (query: SavedQuery) => void | Promise<unknown>;
  onCreateDataset?: () => void;
}
interface DisplayEntry {
  action: LibraryEntry;
  description: string;
  category?: QueryCategory;
  level?: QueryLevel;
  template?: QueryTemplate;
  saved?: SavedQuery;
  history?: HistoryEntry;
  available: boolean;
}

export function QueryLibraryView({
  engine,
  schema,
  savedQueries,
  history,
  onOpen,
  onInsert,
  onExplain,
  onFavorite,
  onCreateDataset,
}: QueryLibraryViewProps) {
  const [source, setSource] = useState<"catalog" | "saved" | "history">(
    "catalog",
  );
  const [selectedEngine, setEngine] = useState(engine),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState("all"),
    [level, setLevel] = useState("all"),
    [favoritesOnly, setFavorites] = useState(false);
  const [selectedId, setSelectedId] = useState(""),
    [copied, setCopied] = useState(""),
    [error, setError] = useState(""),
    [showExplanation, setExplanation] = useState(false);
  useEffect(() => setEngine(engine), [engine]);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(""), 1800);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  const catalog = useMemo(
    () => buildQueryCatalog(selectedEngine, schema),
    [selectedEngine, schema],
  );
  const allEntries = useMemo<DisplayEntry[]>(() => {
    if (source === "catalog")
      return catalog.map((template) => ({
        action: catalogAction(template),
        description: template.description,
        category: template.category,
        level: template.level,
        template,
        available: template.available,
      }));
    if (source === "saved")
      return [...savedQueries]
        .sort(
          (a, b) =>
            Number(b.favorite) - Number(a.favorite) ||
            a.name.localeCompare(b.name, "it"),
        )
        .map((saved) => ({
          action: savedQueryAction(saved),
          description: saved.favorite
            ? "Query personale · preferita"
            : "Query personale salvata",
          saved,
          available: true,
        }));
    return history.map((item) => ({
      action: historyQueryAction(item),
      description: item.profileName + " · " + item.elapsedMs + " ms",
      history: item,
      available: true,
    }));
  }, [source, catalog, savedQueries, history]);
  const entries = allEntries.filter(
    (entry) =>
      entry.action.engine === selectedEngine &&
      (source !== "catalog" ||
        category === "all" ||
        entry.category === category) &&
      (source !== "catalog" || level === "all" || entry.level === level) &&
      (!favoritesOnly || entry.saved?.favorite) &&
      (!search.trim() ||
        [
          entry.action.title,
          entry.action.query,
          entry.description,
          entry.action.lesson,
          entry.category ? QUERY_CATEGORIES[entry.category] : "",
        ]
          .join(" ")
          .toLocaleLowerCase("it")
          .includes(search.toLocaleLowerCase("it"))),
  );
  const selected =
    entries.find((entry) => entry.action.id === selectedId) ?? entries[0];
  const analysis = useMemo(
    () =>
      selected
        ? explainQuery(selected.action.query, selected.action.engine, schema)
        : null,
    [selected, schema],
  );
  const schemaReady =
    !!schema &&
    schema.engine === selectedEngine &&
    dataTables(schema).length > 0;
  async function copy(entry: DisplayEntry) {
    try {
      await navigator.clipboard.writeText(entry.action.query);
      setCopied(entry.action.id);
      setError("");
    } catch {
      setError(
        "La copia negli appunti non è disponibile. Seleziona il testo dell'anteprima e usa Ctrl+C.",
      );
    }
  }
  function explain(entry: DisplayEntry) {
    setExplanation(true);
    onExplain?.(entry.action);
  }
  return (
    <div className="view-content qt-library">
      <SectionHeader
        eyebrow="UN REPERTORIO DA USARE E CAPIRE"
        title="Libreria query"
        description="Esempi adattati allo schema, query salvate e cronologia. Aprire o inserire una query non la esegue."
      />
      <div className="qt-library-top">
        <div
          className="qt-tabs"
          role="tablist"
          aria-label="Origine delle query"
        >
          {(
            [
              ["catalog", "Catalogo", BookOpen],
              ["saved", "Salvate", Star],
              ["history", "Cronologia", Clock3],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={source === id}
              className={source === id ? "active" : ""}
              onClick={() => {
                setSource(id);
                setFavorites(false);
                setExplanation(false);
              }}
            >
              <Icon size={15} />
              {label}
              <span>
                {id === "catalog"
                  ? catalog.length
                  : id === "saved"
                    ? savedQueries.filter(
                        (query) => query.engine === selectedEngine,
                      ).length
                    : history.filter((query) => query.engine === selectedEngine)
                        .length}
              </span>
            </button>
          ))}
        </div>
        <span className="qt-offline">
          <Lightbulb size={14} />
          Spiegazioni offline · nessuna AI necessaria
        </span>
      </div>
      <div className="panel qt-library-filters">
        <label className="qt-search">
          <Search size={16} />
          <input
            aria-label="Cerca nella libreria query"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cerca un'operazione, una clausola o del codice…"
          />
        </label>
        <Field label="Motore">
          <select
            value={selectedEngine}
            onChange={(event) => setEngine(event.target.value as Engine)}
          >
            {ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {ENGINE_LABELS[engine]}
              </option>
            ))}
          </select>
        </Field>
        {source === "catalog" ? (
          <>
            <Field label="Categoria">
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="all">Tutte le categorie</option>
                {Object.entries(QUERY_CATEGORIES).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
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
                {["Base", "Intermedio", "Avanzato"].map((level) => (
                  <option key={level}>{level}</option>
                ))}
              </select>
            </Field>
          </>
        ) : source === "saved" ? (
          <label className="check qt-favorites">
            <input
              type="checkbox"
              checked={favoritesOnly}
              onChange={(event) => setFavorites(event.target.checked)}
            />
            Solo preferite
          </label>
        ) : null}
      </div>
      {source === "catalog" && !schemaReady && (
        <Notice>
          <div className="qt-demo-notice">
            <div>
              <strong>
                Gli esempi con tabelle attendono uno schema reale.
              </strong>
              <p>
                Il catalogo mostra il dataset didattico «Negozio e ordini» come
                riferimento, senza fingere che esista nella connessione. Apri il
                laboratorio per provarlo.
              </p>
            </div>
            {onCreateDataset && (
              <Button onClick={onCreateDataset}>
                <Database size={15} />
                Apri dataset clienti e ordini
              </Button>
            )}
          </div>
        </Notice>
      )}
      {selectedEngine !== engine && (
        <Notice tone="warning">
          Stai consultando esempi per {ENGINE_LABELS[selectedEngine]}; la
          connessione attiva usa {ENGINE_LABELS[engine]}. Controlla il motore
          prima dell'esecuzione.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="qt-library-body">
        <section className="panel qt-query-list" aria-label="Elenco query">
          <div className="qt-list-caption">
            <strong>
              {entries.length} {entries.length === 1 ? "query" : "query"}
            </strong>
            <span>
              {source === "catalog"
                ? "Dal semplice al composto"
                : "Nel tuo spazio di lavoro"}
            </span>
          </div>
          {entries.slice(0, 250).map((entry) => (
            <div
              key={entry.action.id}
              className={
                "qt-query-card " +
                (selected?.action.id === entry.action.id ? "selected" : "")
              }
            >
              <button
                className="qt-query-card-main"
                onClick={() => {
                  setSelectedId(entry.action.id);
                  setExplanation(false);
                }}
                aria-pressed={selected?.action.id === entry.action.id}
              >
                <span className="qt-card-icon">
                  {entry.history ? (
                    <span
                      className={
                        "status-dot " +
                        (entry.history.success ? "success" : "error")
                      }
                    />
                  ) : (
                    <Code2 size={17} />
                  )}
                </span>
                <span>
                  <strong>{entry.action.title}</strong>
                  <small>{entry.description}</small>
                  <span className="qt-badges">
                    {entry.level && <em>{entry.level}</em>}
                    {entry.category && (
                      <em>{QUERY_CATEGORIES[entry.category]}</em>
                    )}
                    {entry.template && !entry.template.readOnly && (
                      <em className="warning">Scrittura</em>
                    )}
                    {!entry.available && <em>Richiede schema</em>}
                  </span>
                </span>
              </button>
              {entry.saved && onFavorite && (
                <button
                  className="qt-favorite-button"
                  aria-label={
                    entry.saved.favorite
                      ? "Rimuovi dai preferiti"
                      : "Aggiungi ai preferiti"
                  }
                  onClick={() =>
                    void Promise.resolve(onFavorite(entry.saved!)).catch(() =>
                      setError("Impossibile aggiornare il preferito."),
                    )
                  }
                >
                  <Star
                    size={15}
                    fill={entry.saved.favorite ? "currentColor" : "none"}
                  />
                </button>
              )}
            </div>
          ))}
          {!entries.length && (
            <div className="qt-empty">
              <Search size={24} />
              <h3>Nessuna query trovata</h3>
              <p>
                {source === "catalog"
                  ? "Prova un'altra categoria o un termine più breve. Alcune categorie SQL non hanno un equivalente diretto in MongoDB."
                  : source === "saved"
                    ? "Salva una query dall'editor per ritrovarla qui."
                    : "Le esecuzioni compariranno qui con tempi ed eventuali errori."}
              </p>
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch("");
                  setCategory("all");
                  setLevel("all");
                  setFavorites(false);
                }}
              >
                Azzera i filtri
              </Button>
            </div>
          )}
          {entries.length > 250 && (
            <p className="qt-muted">
              Mostrate le prime 250 voci: usa la ricerca per restringere
              l'elenco.
            </p>
          )}
        </section>
        <section
          className="panel qt-query-detail"
          aria-label="Anteprima e spiegazione della query"
        >
          {selected ? (
            <>
              <header className="qt-detail-header">
                <div>
                  <small>
                    {selected.category
                      ? QUERY_CATEGORIES[selected.category]
                      : selected.action.source === "saved"
                        ? "QUERY SALVATA"
                        : "CRONOLOGIA"}
                  </small>
                  <h2>{selected.action.title}</h2>
                  <p>{selected.description}</p>
                </div>
                <span className="engine-badge">
                  {ENGINE_LABELS[selected.action.engine]}
                </span>
              </header>
              <div className="qt-query-actions">
                <Button
                  variant="primary"
                  disabled={!selected.available || !selected.action.query}
                  title={selected.template?.unavailableReason}
                  onClick={() => onOpen(selected.action)}
                >
                  <Code2 size={15} />
                  Apri nell'editor
                </Button>
                <Button
                  disabled={!selected.available || !selected.action.query}
                  onClick={() => onInsert(selected.action)}
                >
                  <ArrowDownToLine size={15} />
                  Inserisci al cursore
                </Button>
                <Button variant="ghost" onClick={() => explain(selected)}>
                  <Lightbulb size={15} />
                  Spiega
                </Button>
                <Button
                  variant="ghost"
                  disabled={!selected.action.query}
                  onClick={() => void copy(selected)}
                >
                  {copied === selected.action.id ? (
                    <Check size={15} />
                  ) : (
                    <Copy size={15} />
                  )}
                  Copia
                </Button>
              </div>
              {!selected.available && (
                <Notice>
                  {selected.template?.unavailableReason ??
                    "Collega uno schema per usare questo esempio."}
                </Notice>
              )}
              {selected.template?.usesDemoSchema && (
                <p className="qt-demo-label">
                  Anteprima sul dataset didattico da aprire · non è lo schema
                  della connessione
                </p>
              )}
              {selected.action.query ? (
                <pre className="qt-code" tabIndex={0}>
                  <code>{selected.action.query}</code>
                </pre>
              ) : (
                <div className="qt-empty">
                  <Database size={25} />
                  <p>{selected.action.lesson}</p>
                </div>
              )}
              <div className="qt-lesson">
                <span>
                  <BookOpen size={17} />
                  Come leggerla
                </span>
                <p>{selected.action.lesson}</p>
                {selected.action.executionMode === "script" && (
                  <p className="qt-parameter-note">
                    Questa voce contiene più statement: seleziona «Intero
                    script» nell'editor.
                  </p>
                )}
              </div>
              {!!selected.template?.parameterDefinitions.length && (
                <section className="qt-parameters">
                  <h3>Parametri già preparati</h3>
                  <p>
                    I valori si aprono nel pannello Parametri dell'editor e
                    possono essere modificati prima dell'esecuzione.
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>Parametro</th>
                        <th>Tipo</th>
                        <th>Valore di esempio</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selected.template.parameterDefinitions.map(
                        (parameter) => (
                          <tr key={parameter.key}>
                            <td>
                              <code>{parameter.placeholder}</code>
                              <small>{parameter.description}</small>
                            </td>
                            <td>{parameter.type}</td>
                            <td>
                              <code>{JSON.stringify(parameter.example)}</code>
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </section>
              )}
              {selected.history && (
                <div className="qt-history-detail">
                  <strong>
                    {selected.history.success
                      ? "Esecuzione riuscita"
                      : "Esecuzione con errore"}
                  </strong>
                  <span>
                    {selected.history.profileName} ·{" "}
                    {selected.history.elapsedMs} ms ·{" "}
                    {dateLabel(selected.history.timestamp)}
                  </span>
                  {selected.history.error && (
                    <Notice tone="error">{selected.history.error}</Notice>
                  )}
                </div>
              )}
              {showExplanation && analysis && (
                <section className="qt-analysis">
                  <h3>Clausola per clausola</h3>
                  {analysis.steps.map((step, index) => (
                    <article key={index}>
                      <code>{step.clause}</code>
                      <div>
                        <strong>{step.title}</strong>
                        <p>{step.explanation}</p>
                      </div>
                    </article>
                  ))}
                  {analysis.warnings.map((warning, index) => (
                    <Notice key={index} tone="warning">
                      {warning}
                    </Notice>
                  ))}
                </section>
              )}
              {selected.template?.assumptions?.map((assumption, index) => (
                <Notice key={index}>{assumption}</Notice>
              ))}
              {!!selected.template?.sourceUrls.length && (
                <details className="qt-sources">
                  <summary>Riferimenti del motore</summary>
                  {selected.template.sourceUrls.map((url) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <ExternalLink size={12} />
                      {new URL(url).hostname} ·{" "}
                      {decodeURIComponent(new URL(url).pathname)
                        .split("/")
                        .filter(Boolean)
                        .at(-1)}
                    </a>
                  ))}
                </details>
              )}
              <p className="qt-footer-note">
                Apri, inserisci e copia preparano testo. L'esecuzione rimane
                un'azione esplicita nell'editor.
              </p>
            </>
          ) : (
            <div className="qt-empty">
              <BookOpen size={34} />
              <h2>Una query alla volta</h2>
              <p>
                Seleziona una voce per leggerne codice, parametri e spiegazione.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
function dateLabel(timestamp: string): string {
  const value = new Date(timestamp);
  return Number.isNaN(value.getTime())
    ? timestamp
    : value.toLocaleString("it-IT", {
        timeZone: "Europe/Rome",
        dateStyle: "short",
        timeStyle: "short",
      });
}
