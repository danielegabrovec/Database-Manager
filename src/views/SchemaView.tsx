import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, MarkerType } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  ArrowRight,
  Columns3,
  GitCompare,
  GitFork,
  KeyRound,
  ListFilter,
  Plus,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { api } from "../api";
import type {
  ColumnInfo,
  ConnectionProfile,
  SchemaSnapshot,
  TableInfo,
} from "../types";
import { canBrowseData, errorMessage, pretty } from "../utils";
import { Button, Empty, Field, Notice, SectionHeader } from "../components/UI";
import {
  DesignerExtras,
  QueryBuilderExtras,
  INITIAL_DESIGNER,
  INITIAL_QUERY_OPTIONS,
  buildQuery,
  extendDdl,
} from "../components/SchemaBuilders";

interface Props {
  schema: SchemaSnapshot | null;
  sessionId: string;
  profiles: ConnectionProfile[];
  onQuery: (query: string) => void;
  onOpenTable: (table: TableInfo) => void;
  query: string;
  initialTab?: string;
}
export function SchemaView({
  schema,
  sessionId,
  profiles,
  onQuery,
  onOpenTable,
  query,
  initialTab = "objects",
}: Props) {
  const [tab, setTab] = useState(initialTab);
  const [selected, setSelected] = useState("");
  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<ColumnInfo[]>([
    { name: "id", dataType: "INTEGER", nullable: false, primaryKey: true },
    { name: "name", dataType: "TEXT", nullable: false, primaryKey: false },
  ]);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [target, setTarget] = useState("");
  const [filter, setFilter] = useState("");
  const [limit, setLimit] = useState(100);
  const [chosenColumns, setChosenColumns] = useState<string[]>([]);
  const [designerOptions, setDesignerOptions] = useState(INITIAL_DESIGNER);
  const [queryOptions, setQueryOptions] = useState(INITIAL_QUERY_OPTIONS);
  const [script, setScript] = useState("");
  const tables = schema?.tables || [];
  const dataTables = tables.filter(canBrowseData);
  const selectableTables = tab === "builder" ? dataTables : tables;
  const table =
    selectableTables.find((t) => t.name === selected) || selectableTables[0];
  async function tool(action: string, extra: Record<string, unknown> = {}) {
    if (!sessionId) {
      setError("Apri prima una connessione.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<unknown>("schema_tools", {
        request: {
          action,
          sessionId,
          query,
          table: tableName,
          columns,
          targetProfileId: target,
          ...extra,
        },
      });
      let sql =
        typeof result === "object" && result && "sql" in result
          ? String((result as { sql: string }).sql)
          : typeof result === "string"
            ? result
            : "";
      if (action === "ddl" && schema)
        sql = extendDdl(
          sql,
          schema.engine,
          tableName,
          columns,
          designerOptions,
        );
      setScript(sql);
      setOutput(action === "ddl" ? sql : pretty(result));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const graph = useMemo(
    () => ({
      nodes: dataTables.map((item, index) => ({
        id: item.name,
        position: { x: (index % 3) * 310, y: Math.floor(index / 3) * 230 },
        data: {
          label: (
            <div className="er-table">
              <strong>{item.name}</strong>
              {item.columns.slice(0, 9).map((column) => (
                <span key={column.name}>
                  {column.primaryKey && <KeyRound size={10} />}
                  <b>{column.name}</b>
                  <small>{column.dataType}</small>
                </span>
              ))}
              {item.columns.length > 9 && (
                <small>+ {item.columns.length - 9} colonne</small>
              )}
            </div>
          ),
        },
        style: {
          width: 260,
          padding: 0,
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--surface)",
          color: "var(--text)",
        },
      })),
      edges: dataTables.flatMap((item) =>
        (item.foreignKeys || []).map((key, index) => ({
          id: `${item.name}-${index}`,
          source: item.name,
          target: key.referencedTable || key.targetTable || "",
          label: key.columns?.join(", ") || key.column,
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: "#568dea" },
          labelStyle: { fill: "#849bb8", fontSize: 11 },
        })),
      ),
    }),
    [dataTables],
  );
  function generateSelect() {
    if (!table || !schema) return;
    try {
      onQuery(
        buildQuery(schema, table, chosenColumns, filter, limit, queryOptions),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="view-content">
      <SectionHeader
        eyebrow="STRUTTURA E RELAZIONI"
        title="Progetta il tuo database"
        description="Esplora gli oggetti, componi query e prepara modifiche allo schema."
      />
      <div className="tab-strip">
        <button
          className={tab === "objects" ? "active" : ""}
          onClick={() => setTab("objects")}
        >
          <Columns3 size={15} />
          Oggetti
        </button>
        <button
          className={tab === "designer" ? "active" : ""}
          onClick={() => setTab("designer")}
        >
          <Plus size={15} />
          Designer
        </button>
        <button
          className={tab === "builder" ? "active" : ""}
          onClick={() => setTab("builder")}
        >
          <ListFilter size={15} />
          Query builder
        </button>
        <button
          className={tab === "diagram" ? "active" : ""}
          onClick={() => setTab("diagram")}
        >
          <GitFork size={15} />
          Diagramma ER
        </button>
        <button
          className={tab === "compare" ? "active" : ""}
          onClick={() => setTab("compare")}
        >
          <GitCompare size={15} />
          Confronto e piani
        </button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {tab === "objects" &&
        (tables.length ? (
          <div className="schema-objects">
            <div className="object-list">
              {tables.map((item) => (
                <button
                  key={`${item.schema}.${item.name}`}
                  className={table?.name === item.name ? "active" : ""}
                  onClick={() => setSelected(item.name)}
                >
                  <Columns3 size={15} />
                  <span>
                    {item.name}
                    <small>
                      {item.kind} · {item.columns.length} colonne
                    </small>
                  </span>
                </button>
              ))}
            </div>
            {table && (
              <div className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>{table.name}</h2>
                    <small>
                      {table.schema || schema?.database} · {table.kind}
                    </small>
                  </div>
                  {canBrowseData(table) && (
                    <Button onClick={() => onOpenTable(table)}>
                      Apri dati
                      <ArrowRight size={14} />
                    </Button>
                  )}
                </div>
                <table className="plain-table">
                  <thead>
                    <tr>
                      <th>Colonna</th>
                      <th>Tipo</th>
                      <th>Null</th>
                      <th>Predefinito</th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.columns.map((column) => (
                      <tr key={column.name}>
                        <td>
                          {column.primaryKey && <KeyRound size={12} />}{" "}
                          {column.name}
                        </td>
                        <td className="mono">{column.dataType}</td>
                        <td>{column.nullable ? "Sì" : "No"}</td>
                        <td className="mono">{column.defaultValue || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <h3>Indici</h3>
                {table.indexes?.length ? (
                  table.indexes.map((index) => (
                    <div className="list-line" key={index.name}>
                      <code>{index.name}</code>
                      <span>
                        {index.columns?.join(", ")}{" "}
                        {index.unique ? "· univoco" : ""}
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="muted">Nessun indice riportato dal motore.</p>
                )}
                {table.definition && (
                  <div className="stack" style={{ marginTop: 24 }}>
                    <div className="panel-heading">
                      <h3>Definizione</h3>
                      <Button onClick={() => onQuery(table.definition!)}>
                        Apri nell’editor
                        <ArrowRight size={14} />
                      </Button>
                    </div>
                    <pre className="code-preview">{table.definition}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <Empty icon={<Columns3 />} title="Lo schema è ancora vuoto">
            Apri una connessione o usa il designer per preparare la prima
            tabella.
          </Empty>
        ))}
      {tab === "designer" && (
        <div className="panel stack">
          <div className="form-grid">
            <Field label="Nome tabella o collezione">
              <input
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
                placeholder="nuova_tabella"
              />
            </Field>
            <Field label="Motore">
              <input
                readOnly
                value={schema?.engine || "Apri una connessione"}
              />
            </Field>
          </div>
          <div className="designer-header">
            <span>Nome colonna</span>
            <span>Tipo</span>
            <span>Null</span>
            <span>PK</span>
            <span />
          </div>
          {columns.map((column, index) => (
            <div className="designer-row" key={index}>
              <input
                aria-label={`Nome colonna ${index + 1}`}
                value={column.name}
                onChange={(e) =>
                  setColumns((old) =>
                    old.map((c, i) =>
                      i === index ? { ...c, name: e.target.value } : c,
                    ),
                  )
                }
              />
              <input
                aria-label={`Tipo colonna ${index + 1}`}
                value={column.dataType}
                onChange={(e) =>
                  setColumns((old) =>
                    old.map((c, i) =>
                      i === index ? { ...c, dataType: e.target.value } : c,
                    ),
                  )
                }
              />
              <input
                aria-label={`Consenti null colonna ${index + 1}`}
                type="checkbox"
                checked={column.nullable}
                onChange={(e) =>
                  setColumns((old) =>
                    old.map((c, i) =>
                      i === index ? { ...c, nullable: e.target.checked } : c,
                    ),
                  )
                }
              />
              <input
                aria-label={`Chiave primaria colonna ${index + 1}`}
                type="checkbox"
                checked={column.primaryKey}
                onChange={(e) =>
                  setColumns((old) =>
                    old.map((c, i) =>
                      i === index ? { ...c, primaryKey: e.target.checked } : c,
                    ),
                  )
                }
              />
              <button
                className="icon-button"
                aria-label="Rimuovi colonna"
                onClick={() =>
                  setColumns((old) => old.filter((_, i) => i !== index))
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <DesignerExtras
            engine={schema?.engine || "sqlite"}
            tableName={tableName}
            columns={columns}
            tables={dataTables}
            options={designerOptions}
            onChange={setDesignerOptions}
            onColumns={setColumns}
          />
          <div className="row">
            <Button
              onClick={() =>
                setColumns((old) => [
                  ...old,
                  {
                    name: "",
                    dataType: "TEXT",
                    nullable: true,
                    primaryKey: false,
                  },
                ])
              }
            >
              <Plus size={14} />
              Aggiungi colonna
            </Button>
            <div className="spacer" />
            <Button
              variant="primary"
              onClick={() => tool("ddl", { execute: false })}
              busy={busy}
              disabled={!tableName || !columns.length}
            >
              <WandSparkles size={14} />
              Genera script
            </Button>
          </div>
          <Notice>
            Lo script generato si apre nell’editor per essere verificato ed
            eseguito. La disponibilità delle operazioni dipende dal motore
            connesso.
          </Notice>
        </div>
      )}
      {tab === "builder" && (
        <div className="panel stack">
          <Field label="Tabella o collezione">
            <select
              value={table?.name || ""}
              onChange={(e) => {
                setSelected(e.target.value);
                setChosenColumns([]);
                setQueryOptions(INITIAL_QUERY_OPTIONS);
              }}
            >
              <option value="" disabled>
                Seleziona un oggetto
              </option>
              {dataTables.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="check-grid">
            {table?.columns.map((column) => (
              <label className="check" key={column.name}>
                <input
                  type="checkbox"
                  checked={chosenColumns.includes(column.name)}
                  onChange={(e) =>
                    setChosenColumns((old) =>
                      e.target.checked
                        ? [...old, column.name]
                        : old.filter((name) => name !== column.name),
                    )
                  }
                />
                {column.name}
              </label>
            ))}
          </div>
          <div className="form-grid">
            <Field
              label={
                schema?.engine === "mongodb"
                  ? "Filtro Extended JSON"
                  : "Condizione WHERE"
              }
              hint="Lascia vuoto per leggere tutte le righe, entro il limite."
            >
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={
                  schema?.engine === "mongodb"
                    ? '{"active": true}'
                    : "active = 1"
                }
              />
            </Field>
            <Field label="Limite righe">
              <input
                type="number"
                min={1}
                max={10000}
                value={limit}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </Field>
          </div>
          {table && schema && (
            <QueryBuilderExtras
              schema={{ ...schema, tables: dataTables }}
              table={table}
              options={queryOptions}
              onChange={setQueryOptions}
            />
          )}
          <Button
            variant="primary"
            disabled={!table}
            onClick={() => {
              try {
                generateSelect();
              } catch (e) {
                setError(errorMessage(e));
              }
            }}
          >
            Apri query nell’editor
            <ArrowRight size={14} />
          </Button>
        </div>
      )}
      {tab === "diagram" && (
        <div className="diagram-panel">
          {tables.length ? (
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              fitView
              minZoom={0.15}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#62748c" gap={22} />
              <Controls />
            </ReactFlow>
          ) : (
            <Empty icon={<GitFork />} title="Nessun oggetto da collegare">
              Apri una connessione per visualizzare tabelle e chiavi esterne.
            </Empty>
          )}
        </div>
      )}
      {tab === "compare" && (
        <div className="two-columns">
          <div className="panel stack">
            <h2>Confronta gli schemi</h2>
            <p className="muted">
              Confronto con una seconda connessione dello stesso motore e script
              revisionabile.
            </p>
            <Field label="Connessione di destinazione">
              <select
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              >
                <option value="">Scegli connessione</option>
                {profiles
                  .filter((profile) => profile.engine === schema?.engine)
                  .map((profile) => (
                    <option value={profile.id} key={profile.id}>
                      {profile.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Button onClick={() => tool("diff")} disabled={!target} busy={busy}>
              <GitCompare size={14} />
              Confronta
            </Button>
          </div>
          <div className="panel stack">
            <h2>Piano della query corrente</h2>
            <p className="muted">
              Richiedi al motore il piano di esecuzione della query presente
              nell’editor.
            </p>
            <pre className="code-preview compact">
              {query || "Scrivi prima una query nell’editor."}
            </pre>
            <Button
              onClick={() => tool("explain")}
              disabled={!query.trim()}
              busy={busy}
            >
              Mostra EXPLAIN
            </Button>
          </div>
        </div>
      )}
      {output && tab !== "diagram" && (
        <div className="panel output-panel">
          <div className="panel-heading">
            <h3>Risultato</h3>
            <Button disabled={!script} onClick={() => onQuery(script)}>
              Apri script nell’editor
              <ArrowRight size={14} />
            </Button>
          </div>
          <pre className="code-preview">{output}</pre>
        </div>
      )}
    </div>
  );
}
