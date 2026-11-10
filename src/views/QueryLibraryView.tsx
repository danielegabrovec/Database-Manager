import { useEffect, useId, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
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
  SlidersHorizontal,
  Star,
} from "lucide-react";
import type {
  Engine,
  HistoryEntry,
  SavedQuery,
  SchemaSnapshot,
} from "../types";
import { ENGINES, ENGINE_LABELS } from "../types";
import { Button, Field, Notice } from "../components/UI";
import { CatalogShell } from "../components/CatalogShell";
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
import "../query-library.css";

type QuerySource = "catalog" | "saved" | "history";
const QUERY_SOURCES = [
  ["catalog", "Esempi", BookOpen],
  ["saved", "Query salvate", Star],
  ["history", "Cronologia", Clock3],
] as const;

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
  const tabPrefix = useId();
  const [source, setSource] = useState<QuerySource>("catalog");
  const [showFilters, setShowFilters] = useState(false);
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
  function chooseSource(next: QuerySource) {
    setSource(next);
    setFavorites(false);
    setExplanation(false);
  }
  function handleTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = QUERY_SOURCES.findIndex(([id]) => id === source);
    let nextIndex: number;
    if (event.key === "ArrowRight")
      nextIndex = (index + 1) % QUERY_SOURCES.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (index + QUERY_SOURCES.length - 1) % QUERY_SOURCES.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = QUERY_SOURCES.length - 1;
    else return;
    event.preventDefault();
    const next = QUERY_SOURCES[nextIndex][0];
    chooseSource(next);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-source="${next}"]`)
      ?.focus();
  }
  const filterCount =
    source === "catalog"
      ? Number(category !== "all") + Number(level !== "all")
      : Number(source === "saved" && favoritesOnly);
  return (
    <CatalogShell
      className="qt-library"
      title="Catalogo Query"
      description="Scegli una query, leggila e aprila nell'editor. L'esecuzione resta una tua azione."
      actions={
        <span className="qt-offline">
          <Lightbulb size={14} />
          Guida offline
        </span>
      }
    >
      <div className="qt-library-top">
        <div
          className="qt-tabs"
          role="tablist"
          aria-label="Origine delle query"
          onKeyDown={handleTabKey}
        >
          {QUERY_SOURCES.map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`${tabPrefix}-${id}-tab`}
              aria-controls={`${tabPrefix}-panel`}
              aria-selected={source === id}
              tabIndex={source === id ? 0 : -1}
              data-source={id}
              className={source === id ? "active" : ""}
              onClick={() => chooseSource(id)}
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
      </div>
      <div className="qt-library-filters">
        <label className="qt-search">
          <Search size={16} />
          <input
            aria-label="Cerca nel Catalogo Query"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Cerca query, clausola o codice…"
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
        {source !== "history" && (
          <Button
            variant="ghost"
            className={
              showFilters ? "qt-filter-toggle active" : "qt-filter-toggle"
            }
            aria-expanded={showFilters}
            aria-controls={`${tabPrefix}-filters`}
            onClick={() => setShowFilters((value) => !value)}
          >
            <SlidersHorizontal size={14} />
            Filtri{filterCount > 0 && <span>{filterCount}</span>}
          </Button>
        )}
        {filterCount > 0 && (
          <Button
            variant="ghost"
            onClick={() => {
              setCategory("all");
              setLevel("all");
              setFavorites(false);
            }}
          >
            Azzera
          </Button>
        )}
      </div>
      <div
        id={`${tabPrefix}-filters`}
        className="qt-library-extra-filters"
        hidden={!showFilters || source === "history"}
      >
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
      {source === "catalog" && (
        <div
          className={`qt-schema-status ${schemaReady ? "ready" : "demo"}`}
          role="status"
        >
          <Database size={14} aria-hidden="true" />
          <span>
            {schemaReady
              ? "Esempi adattati allo schema collegato."
              : "Anteprima didattica «Negozio e ordini»: queste tabelle non sono lo schema della connessione."}
          </span>
          {!schemaReady && onCreateDataset && (
            <Button variant="ghost" onClick={onCreateDataset}>
              Apri laboratorio
            </Button>
          )}
        </div>
      )}
      {selectedEngine !== engine && (
        <Notice tone="warning">
          Stai consultando esempi per {ENGINE_LABELS[selectedEngine]}; la
          connessione attiva usa {ENGINE_LABELS[engine]}. Controlla il motore
          prima dell'esecuzione.
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <div
        className="qt-library-body"
        role="tabpanel"
        id={`${tabPrefix}-panel`}
        aria-labelledby={`${tabPrefix}-${source}-tab`}
      >
        <section className="panel qt-query-list" aria-label="Elenco query">
          <div className="qt-list-caption">
            <strong>{entries.length} query</strong>
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
    </CatalogShell>
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
