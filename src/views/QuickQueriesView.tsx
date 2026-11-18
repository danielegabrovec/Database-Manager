import Editor, { type OnMount } from "@monaco-editor/react";
import {
  Braces,
  CopyPlus,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  Table2,
  Timer,
} from "lucide-react";
import type * as Monaco from "monaco-editor";
import { useId, useRef, useState, type RefObject } from "react";
import { DataGrid } from "../components/DataGrid";
import { Button, Field, Notice } from "../components/UI";
import {
  installLocalCompletion,
  isLocalCompletionEnabled,
} from "../editor/localCompletion";
import { installSqlLanguage } from "../editor/sqlLanguage";
import type {
  Bootstrap,
  DataChange,
  Engine,
  QueryResult,
  SchemaSnapshot,
} from "../types";
import { ENGINE_LABELS } from "../types";
import "../quick-queries.css";

interface Props {
  engine: Engine;
  schema: SchemaSnapshot | null;
  sessionId: string;
  dark: boolean;
  settings: Bootstrap["settings"];
  query: string;
  parametersText: string;
  onQueryChange: (value: string) => void;
  onParametersChange: (value: string) => void;
  onRun: () => void;
  onCancel?: () => void;
  onReset: () => void;
  editorRef?: RefObject<Monaco.editor.IStandaloneCodeEditor | null>;
  onCopySource?: () => void;
  canCopySource?: boolean;
  onReconnect?: () => void;
  opening?: boolean;
  resetting?: boolean;
  busy: boolean;
  error?: string;
  message?: string;
  result: QueryResult | null;
  mode?: "synthetic" | "sqlite_copy";
}

const EMPTY_CHANGES = new Map<number, DataChange>();
const ignore = () => {};

export function QuickQueriesView({
  engine,
  schema,
  sessionId,
  dark,
  settings,
  query,
  parametersText,
  onQueryChange,
  onParametersChange,
  onRun,
  onCancel,
  onReset,
  editorRef,
  onCopySource,
  canCopySource,
  onReconnect,
  opening = false,
  resetting = false,
  busy,
  error,
  message,
  result,
  mode,
}: Props) {
  const [parametersOpen, setParametersOpen] = useState<boolean | null>(null);
  const [resultChoice, setResultChoice] = useState<{
    result: QueryResult;
    index: number;
  } | null>(null);
  const [completionStatus, setCompletionStatus] = useState("");
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const parametersId = useId();
  const editorLabel = useId();
  const resultsLabel = useId();
  const active = !!sessionId && !!schema;
  const working = busy || opening || resetting;
  const runEnabled = active && !working && !!query.trim();
  const documentId = `quick-queries-${sessionId || "draft"}`;
  const current = useRef({
    engine,
    schema,
    documentId,
    settings,
    onRun,
    runEnabled,
    quickSessionId: active ? sessionId : "",
  });
  current.current = {
    engine,
    schema,
    documentId,
    settings,
    onRun,
    runEnabled,
    quickSessionId: active ? sessionId : "",
  };
  const hasParameters =
    !!parametersText.trim() && parametersText.trim() !== "{}";
  const displayParameters = parametersOpen ?? hasParameters;
  const index =
    resultChoice && resultChoice.result === result ? resultChoice.index : 0;
  const selectedResult = result?.sets[index];
  const localCompletion = active && isLocalCompletionEnabled(settings);

  const bindEditor: OnMount = (instance, monaco) => {
    editor.current = instance;
    if (editorRef) editorRef.current = instance;
    const language = installSqlLanguage(
      monaco,
      instance,
      () => current.current,
    );
    const completion = installLocalCompletion(
      monaco,
      instance,
      () => current.current,
      (text) => setCompletionStatus(text),
    );
    const run = instance.addAction({
      id: "dbm.runQuickQuery",
      label: "Esegui nella simulazione",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => {
        if (current.current.runEnabled) current.current.onRun();
      },
    });
    instance.onDidDispose(() => {
      run.dispose();
      language.dispose();
      completion.dispose();
      if (editor.current === instance) editor.current = null;
      if (editorRef?.current === instance) editorRef.current = null;
    });
  };

  return (
    <div className="view-content quick-queries-view">
      <header className="quick-queries-heading">
        <div>
          <h1>Query rapide</h1>
          <p>Scrivi ed esegui query in una sessione di simulazione isolata.</p>
        </div>
        <div className="quick-queries-status" data-active={active}>
          <span className="quick-queries-status-dot" aria-hidden />
          <span role="status">
            {opening
              ? "Apertura della simulazione…"
              : resetting
                ? "Ripristino della simulazione…"
                : active
                  ? mode === "sqlite_copy"
                    ? `${ENGINE_LABELS[engine]} · copia isolata`
                    : `${ENGINE_LABELS[engine]} · dati di esempio`
                  : "Simulazione inattiva"}
          </span>
        </div>
      </header>

      <section
        className="panel quick-queries-editor-panel"
        aria-labelledby={editorLabel}
      >
        <div className="quick-queries-toolbar">
          <h2 id={editorLabel}>
            Editor {engine === "mongodb" ? "MongoDB" : "SQL"}
          </h2>
          <div className="quick-queries-actions">
            <Button
              variant="ghost"
              aria-expanded={displayParameters}
              aria-controls={parametersId}
              disabled={working}
              onClick={() => setParametersOpen(!displayParameters)}
            >
              <Braces size={15} /> Parametri
            </Button>
            {localCompletion && (
              <Button
                variant="ghost"
                disabled={working || !query.trim()}
                onClick={() => {
                  setCompletionStatus("");
                  void editor.current
                    ?.getAction("dbm.requestLocalCompletion")
                    ?.run();
                }}
                title="Suggerimento locale al cursore · Ctrl+Alt+Spazio"
              >
                <Sparkles size={15} /> Suggerisci
              </Button>
            )}
            {onCopySource && (
              <Button
                disabled={working || !canCopySource}
                onClick={onCopySource}
                title={
                  canCopySource
                    ? "Crea una copia SQLite isolata"
                    : "Collega prima un database SQLite"
                }
              >
                <CopyPlus size={15} /> Usa copia SQLite
              </Button>
            )}
            {!active && onReconnect && (
              <Button disabled={working} onClick={onReconnect}>
                <RotateCcw size={15} /> Avvia
              </Button>
            )}
            {active && (
              <Button disabled={working} onClick={onReset} busy={resetting}>
                {!resetting && <RotateCcw size={15} />} Ripristina
              </Button>
            )}
            {busy && onCancel && (
              <Button onClick={onCancel}>
                <Square size={14} /> Interrompi
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!runEnabled}
              busy={busy}
              onClick={onRun}
            >
              {!busy && <Play size={15} />}
              {busy ? "Esecuzione…" : "Esegui"}
              <kbd>Ctrl ↵</kbd>
            </Button>
          </div>
        </div>

        {displayParameters && (
          <div className="quick-queries-parameters" id={parametersId}>
            <Field label="Parametri JSON">
              <textarea
                rows={3}
                className="mono"
                value={parametersText}
                readOnly={working}
                onChange={(event) => onParametersChange(event.target.value)}
                spellCheck={false}
                placeholder="{}"
              />
            </Field>
          </div>
        )}

        <div className="quick-queries-editor">
          <Editor
            key={documentId}
            path={`${documentId}.${engine === "mongodb" ? "json" : "sql"}`}
            height="100%"
            theme={dark ? "vs-dark" : "light"}
            language={engine === "mongodb" ? "json" : "sql"}
            value={query}
            onMount={bindEditor}
            onChange={(text) => {
              setCompletionStatus("");
              onQueryChange(text ?? "");
            }}
            options={{
              automaticLayout: true,
              ariaLabel: "Editor della simulazione query rapide",
              fontSize: 14,
              lineHeight: 23,
              minimap: { enabled: false },
              readOnly: working,
              scrollBeyondLastLine: false,
              scrollbar: { alwaysConsumeMouseWheel: false },
              wordWrap: "on",
              inlineSuggest: { enabled: localCompletion },
            }}
          />
        </div>
      </section>

      {error && (
        <div role="alert">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {completionStatus && (
        <div role="status">
          <Notice>{completionStatus}</Notice>
        </div>
      )}
      {message && !error && (selectedResult || message !== result?.message) && (
        <div role="status" className="quick-queries-message">
          {message}
        </div>
      )}

      <section
        className="panel quick-queries-results"
        aria-labelledby={resultsLabel}
        aria-busy={busy}
      >
        <div className="quick-queries-results-header">
          <h2 id={resultsLabel}>
            <Table2 size={16} /> Risultati
          </h2>
          {result && (
            <div className="quick-queries-metrics">
              {selectedResult && (
                <span>
                  {selectedResult.rows.length.toLocaleString("it-IT")} righe
                </span>
              )}
              <span>
                <Timer size={14} /> {result.elapsedMs.toLocaleString("it-IT")}{" "}
                ms
              </span>
              {result.affectedRows > 0 && (
                <span>
                  {result.affectedRows.toLocaleString("it-IT")} modificate
                </span>
              )}
            </div>
          )}
        </div>
        {result && result.sets.length > 1 && (
          <nav
            aria-label="Risultati delle istruzioni"
            className="quick-queries-result-tabs"
          >
            {result.sets.map((set, itemIndex) => (
              <Button
                key={itemIndex}
                variant="ghost"
                aria-pressed={index === itemIndex}
                onClick={() => setResultChoice({ result, index: itemIndex })}
              >
                {set.table || `Set ${itemIndex + 1}`}
              </Button>
            ))}
          </nav>
        )}
        {!selectedResult ? (
          <p className="quick-queries-empty muted">
            {busy
              ? "La query è in esecuzione."
              : result
                ? result.message ||
                  "L’istruzione è terminata senza restituire righe."
                : "Esegui una query per vedere i risultati."}
          </p>
        ) : (
          <>
            {selectedResult.truncated && (
              <Notice tone="warning">
                Risultato parziale. Riduci l’intervallo o filtra le righe da
                consultare.
              </Notice>
            )}
            <DataGrid
              key={index}
              result={selectedResult}
              changes={EMPTY_CHANGES}
              editable={false}
              onEdit={ignore}
              onDelete={ignore}
              onSelect={ignore}
              ariaLabel="Tabella risultati della simulazione"
              hideHint
            />
          </>
        )}
      </section>
    </div>
  );
}
