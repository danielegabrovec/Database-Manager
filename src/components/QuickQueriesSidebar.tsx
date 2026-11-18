import { useId, useMemo, useState } from "react";
import { CircleCheck, CircleX, History, Search, Table2 } from "lucide-react";
import { ENGINE_LABELS } from "../types";
import type { Engine, SchemaSnapshot, TableInfo } from "../types";
import { canBrowseData, objectKey, objectLabel } from "../utils";
import "./quick-queries-sidebar.css";

export interface QuickHistoryEntry {
  id?: string;
  query: string;
  engine: Engine;
  executedAt: string;
  success: boolean;
  elapsedMs?: number;
  error?: string;
  parametersText?: string;
}

interface QuickQueriesSidebarProps {
  schema: SchemaSnapshot | null;
  history: QuickHistoryEntry[];
  onTable: (table: TableInfo) => void;
  onRestore: (entry: QuickHistoryEntry) => void;
}

const IN_ITALIAN = new Intl.Collator("it", { numeric: true });
const HISTORY_DATE = new Intl.DateTimeFormat("it-IT", {
  dateStyle: "short",
  timeStyle: "short",
});

function describeTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf())
    ? "Ora sconosciuta"
    : HISTORY_DATE.format(date);
}

function searchText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("it");
}

export function QuickQueriesSidebar({
  schema,
  history,
  onTable,
  onRestore,
}: QuickQueriesSidebarProps) {
  const tablesId = useId();
  const historyId = useId();
  const [search, setSearch] = useState("");
  const groups = useMemo(() => {
    const matched = searchText(search.trim());
    const grouped = new Map<string, TableInfo[]>();
    const objects = (schema?.tables || []).filter(
      (table) =>
        canBrowseData(table) &&
        searchText(objectLabel(table)).includes(matched),
    );
    for (const table of objects) {
      const namespace = table.schema || schema?.database || "";
      const existing = grouped.get(namespace);
      if (existing) existing.push(table);
      else grouped.set(namespace, [table]);
    }
    return Array.from(grouped, ([namespace, tables]) => ({
      namespace,
      tables: tables.sort((left, right) =>
        IN_ITALIAN.compare(left.name, right.name),
      ),
    })).sort((left, right) =>
      IN_ITALIAN.compare(left.namespace, right.namespace),
    );
  }, [schema, search]);
  const entries = useMemo(
    () =>
      history
        .map((entry) => ({ entry, order: Date.parse(entry.executedAt) || 0 }))
        .sort((left, right) => right.order - left.order)
        .map(({ entry }) => entry),
    [history],
  );

  return (
    <div className="quick-queries-sidebar">
      <section
        className="quick-queries-sidebar-section"
        aria-labelledby={tablesId}
      >
        <h2 id={tablesId}>
          <Table2 size={14} aria-hidden="true" />
          {schema?.engine === "mongodb" ? "Collezioni" : "Tabelle e viste"}
        </h2>
        {schema && (
          <label className="quick-queries-sidebar-search">
            <Search size={13} aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filtra oggetti"
              aria-label="Filtra tabelle e collezioni"
            />
          </label>
        )}
        <div
          className="quick-queries-sidebar-scroll"
          role="region"
          aria-labelledby={tablesId}
          tabIndex={0}
        >
          {groups.length === 0 && (
            <p className="quick-queries-sidebar-empty">
              {schema === null
                ? "Apri una connessione per vedere i dati."
                : search.trim()
                  ? "Nessun oggetto corrisponde al filtro."
                  : "Il database non contiene oggetti da visualizzare."}
            </p>
          )}
          {groups.map(({ namespace, tables }) => (
            <div key={namespace} className="quick-queries-table-group">
              {namespace && <h3 title={namespace}>{namespace}</h3>}
              <ul>
                {tables.map((table) => (
                  <li key={objectKey(table)}>
                    <button
                      type="button"
                      className="quick-queries-sidebar-item"
                      title={objectLabel(table)}
                      aria-label={`Anteprima di ${objectLabel(table)} in sola lettura`}
                      onClick={() => onTable(table)}
                    >
                      <Table2 size={13} aria-hidden="true" />
                      <span className="quick-queries-object-name">
                        {table.name}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
      <section
        className="quick-queries-sidebar-section"
        aria-labelledby={historyId}
      >
        <h2 id={historyId}>
          <History size={14} aria-hidden="true" />
          Cronologia query rapide
        </h2>
        <div
          className="quick-queries-sidebar-scroll"
          role="region"
          aria-labelledby={historyId}
          tabIndex={0}
        >
          {entries.length === 0 ? (
            <p className="quick-queries-sidebar-empty">
              Le simulazioni compariranno qui.
            </p>
          ) : (
            <ul>
              {entries.map((entry, index) => {
                const summary =
                  entry.query.replace(/\s+/g, " ").trim() || "Query vuota";
                const date = describeTime(entry.executedAt);
                const status = entry.success ? "Riuscita" : "Errore";
                return (
                  <li key={entry.id || `${entry.executedAt}:${index}`}>
                    <button
                      type="button"
                      className="quick-queries-sidebar-item quick-queries-history-item"
                      title={`Ripristina nell’editor: ${summary.slice(0, 300)}`}
                      onClick={() => onRestore(entry)}
                    >
                      {entry.success ? (
                        <CircleCheck
                          className="quick-queries-passed"
                          size={14}
                          aria-hidden="true"
                        />
                      ) : (
                        <CircleX
                          className="quick-queries-failed"
                          size={14}
                          aria-hidden="true"
                        />
                      )}
                      <span className="quick-queries-history-content">
                        <code>{summary.slice(0, 300)}</code>
                        <small>
                          <time dateTime={entry.executedAt}>{date}</time>
                          {" · "}
                          {ENGINE_LABELS[entry.engine]}
                          {" · "}
                          {status}
                          {entry.elapsedMs !== undefined &&
                            ` · ${entry.elapsedMs} ms`}
                        </small>
                        {!entry.success && entry.error && (
                          <small
                            className="quick-queries-failed"
                            title={entry.error}
                          >
                            {entry.error}
                          </small>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
