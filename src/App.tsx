import { useCallback, useEffect, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Bot,
  Braces,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Database,
  DatabaseBackup,
  Download,
  FileCode2,
  FlaskConical,
  FolderOpen,
  GitFork,
  HelpCircle,
  History,
  Layers3,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Star,
  SunMoon,
  Table2,
  Terminal,
  X,
} from "lucide-react";
import { api, executeQuery } from "./api";
import type {
  Bootstrap,
  ColumnInfo,
  ConnectionProfile,
  DataChange,
  DataRow,
  Engine,
  HistoryEntry,
  Mode,
  QueryResult,
  SavedQuery,
  SchemaSnapshot,
  TableInfo,
  Theme,
} from "./types";
import { ENGINE_LABELS } from "./types";
import {
  canBrowseData,
  cellText,
  errorMessage,
  newId,
  parseCell,
  statementAt,
  updateChange,
} from "./utils";
import { Button, Empty, Field, Modal, Notice } from "./components/UI";
import { ProfileDialog } from "./components/ProfileDialog";
import { DataGrid } from "./components/DataGrid";
import { TableDataWorkspace } from "./components/TableDataWorkspace";
import { TableDesignerView } from "./views/TableDesignerView";
import { QueryLibraryView } from "./views/QueryLibraryView";
import { QueryElementsPanel } from "./components/QueryElementsPanel";
import {
  installSqlLanguage,
  explainQuery,
  explainQueryError,
  type QueryExplanation,
} from "./editor/sqlLanguage";
import type { LibraryEntry } from "./editor/queryCatalog";
import "./workbench.css";
import { RecordDialog } from "./components/RecordDialog";
import { CodegenView } from "./views/CodegenView";
import { LabView } from "./views/LabView";
import { SchemaView } from "./views/SchemaView";
import {
  AssistantPanel,
  EnvironmentsView,
  SettingsView,
  TransferView,
} from "./views/ToolsViews";

const DRAFT_STORAGE = "dbm-ui-v1";
function readLocalDrafts(): Record<string, unknown> {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_STORAGE) || "{}");
    return value.version === 1 ? value : {};
  } catch {
    return {};
  }
}
const LOCAL_UI = readLocalDrafts();
type View =
  | "editor"
  | "data"
  | "designer"
  | "library"
  | "builder"
  | "laboratory"
  | "schema"
  | "codegen"
  | "transfer"
  | "environments"
  | "settings";
const NAV = [
  { id: "editor", label: "Editor SQL / MongoDB", icon: Terminal },
  { id: "data", label: "Dati tabella", icon: Table2 },
  { id: "designer", label: "Designer database", icon: Plus },
  { id: "library", label: "Catalogo query", icon: BookOpen },
  { id: "builder", label: "Compositore query", icon: Layers3 },
  { id: "laboratory", label: "Laboratorio", icon: FlaskConical },
  { id: "schema", label: "Struttura e relazioni", icon: GitFork },
  { id: "codegen", label: "Generatore codice", icon: Braces },
  { id: "transfer", label: "Import / Export", icon: DatabaseBackup },
  { id: "environments", label: "Ambienti locali", icon: Layers3 },
] as const;
const MODE_LABELS: Record<Mode, string> = {
  learning: "Apprendimento personale",
  work: "Studio e lavoro",
  expert: "Sviluppatori esperti",
};
const ENV_LABELS: Record<string, string> = {
  development: "Sviluppo",
  test: "Test",
  production: "Produzione",
  laboratory: "Laboratorio",
};
const EMPTY_BOOTSTRAP: Bootstrap = {
  profiles: [],
  savedQueries: [],
  history: [],
  settings: {},
  engines: [],
};

export default function App() {
  const [boot, setBoot] = useState<Bootstrap>(EMPTY_BOOTSTRAP);
  const [initializing, setInitializing] = useState(true);
  const [bootError, setBootError] = useState("");
  const [view, setView] = useState<View>("editor");
  const [mode, setMode] = useState<Mode>("work");
  const [theme, setTheme] = useState<Theme>("dark");
  const [dark, setDark] = useState(true);
  const [profileId, setProfileId] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [showElements, setShowElements] = useState(true);
  const [querySelection, setQuerySelection] = useState("");
  const [lesson, setLesson] = useState<{
    title: string;
    analysis?: QueryExplanation;
    text?: string;
  } | null>(null);
  const [executionMode, setExecutionMode] = useState("current");
  const [showParameters, setShowParameters] = useState(false);
  const [parametersText, setParametersText] = useState("{}");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [resultIndex, setResultIndex] = useState(0);
  const [queryError, setQueryError] = useState("");
  const [running, setRunning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [tableLoading, setTableLoading] = useState(false);
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [pageSize, setPageSize] = useState(200);
  const [offset, setOffset] = useState(0);
  const [sortColumn, setSortColumn] = useState("");
  const [sortDesc, setSortDesc] = useState(false);
  const [changes, setChanges] = useState<Map<number, DataChange>>(new Map());
  const [applying, setApplying] = useState(false);
  const [preview, setPreview] = useState(false);
  const [record, setRecord] = useState<{
    row: DataRow;
    index: number;
    inserting?: boolean;
  } | null>(null);
  const [profileDialog, setProfileDialog] = useState<
    ConnectionProfile | null | undefined
  >(undefined);
  const [assistant, setAssistant] = useState(false);
  const [sidebarTab, setSidebarTab] = useState("explorer");
  const [explorerSearch, setExplorerSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [toast, setToast] = useState("");
  const [toastError, setToastError] = useState(false);
  const [saveDialog, setSaveDialog] = useState(false);
  const [savedName, setSavedName] = useState("");
  const [activeSavedId, setActiveSavedId] = useState("");
  const [message, setMessage] = useState("Pronto");
  const [editorHeight, setEditorHeight] = useState(280);
  const [sidebarWidth, setSidebarWidth] = useState(
    Number(LOCAL_UI.sidebarWidth) || 250,
  );
  const draftsRef = useRef<Record<string, string>>(
    (LOCAL_UI.drafts || {}) as Record<string, string>,
  );
  const previousEngine = useRef<Engine>("sqlite");
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const runRef = useRef<() => void>(() => {});
  const sqlToolsRef = useRef<{ dispose: () => void } | null>(null);
  const sqlContextRef = useRef<{
    engine: Engine;
    schema: SchemaSnapshot | null;
  }>({ engine: "sqlite", schema: null });
  const insertionRef = useRef<string | null>(null);
  const lastSelectionRef = useRef<{
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null>(null);
  useEffect(() => () => sqlToolsRef.current?.dispose(), []);
  const saveRef = useRef<() => void>(() => {});
  const initialized = useRef(false);
  const profile = boot.profiles.find((item) => item.id === profileId);
  const engine: Engine = profile?.engine || schema?.engine || "sqlite";
  sqlContextRef.current = { engine, schema };
  const activeResult = result?.sets[resultIndex];
  const effectiveColumns =
    activeResult?.columns.map((column) => ({
      ...column,
      primaryKey:
        column.primaryKey ||
        !!selectedTable?.columns.find((item) => item.name === column.name)
          ?.primaryKey,
    })) || [];
  const activeTableName = activeResult?.table || selectedTable?.name;
  const editable =
    !!activeTableName &&
    effectiveColumns.some((column) => column.primaryKey) &&
    !profile?.readOnly;
  const notify = useCallback((text: string, error = false) => {
    setToast(text);
    setToastError(error);
    window.setTimeout(() => setToast(""), 4500);
  }, []);
  async function bootstrap() {
    setInitializing(true);
    setBootError("");
    try {
      const data = await api<Bootstrap>("bootstrap");
      setBoot({ ...EMPTY_BOOTSTRAP, ...data });
      if (!initialized.current) {
        setTheme((data.settings.theme as Theme) || "dark");
        setMode((data.settings.mode as Mode) || "work");
        setProfileId(String(data.settings.lastProfileId || ""));
        draftsRef.current = {
          ...((data.settings.drafts || {}) as Record<string, string>),
          ...draftsRef.current,
        };
        setQuery(draftsRef.current.sqlite || String(data.settings.draft || ""));
        if (!LOCAL_UI.sidebarWidth)
          setSidebarWidth(Number(data.settings.sidebarWidth) || 250);
        initialized.current = true;
      }
    } catch (e) {
      setBootError(errorMessage(e));
    } finally {
      setInitializing(false);
    }
  }
  useEffect(() => {
    void bootstrap();
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      const next = theme === "system" ? media.matches : theme === "dark";
      setDark(next);
      document.documentElement.dataset.theme = next ? "dark" : "light";
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);
  useEffect(() => {
    if (previousEngine.current === engine) return;
    draftsRef.current[previousEngine.current] = query;
    setQuery(draftsRef.current[engine] || "");
    previousEngine.current = engine;
  }, [engine]);
  useEffect(() => {
    if (!initialized.current) return;
    draftsRef.current[engine] = query;
    try {
      localStorage.setItem(
        DRAFT_STORAGE,
        JSON.stringify({ version: 1, drafts: draftsRef.current, sidebarWidth }),
      );
    } catch {
      /* Le preferenze restano salvate anche nel workspace backend. */
    }
    const timer = window.setTimeout(() => {
      void api("update_settings", {
        settings: {
          theme,
          mode,
          lastProfileId: profileId,
          draft: query,
          drafts: draftsRef.current,
          sidebarWidth,
        },
      }).catch(() => {});
    }, 700);
    return () => window.clearTimeout(timer);
  }, [theme, mode, profileId, query, engine, sidebarWidth]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveRef.current();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === "Enter" &&
        view !== "editor"
      ) {
        event.preventDefault();
        setView("editor");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (changes.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [changes.size]);
  const canLeaveChanges = () =>
    !changes.size ||
    window.confirm(
      "Sono presenti modifiche preparate e non applicate. Scartarle e continuare?",
    );
  async function connect(nextProfile = profile) {
    if (running) {
      notify("Attendi il completamento della query o richiedi l’interruzione.");
      return null;
    }
    if (!nextProfile) {
      setProfileDialog(null);
      return null;
    }
    if (!canLeaveChanges()) return null;
    setConnecting(true);
    setQueryError("");
    setMessage(`Connessione a ${nextProfile.name}…`);
    try {
      const id = newId();
      const next = await api<SchemaSnapshot>("open_session", {
        profileId: nextProfile.id,
        sessionId: id,
      });
      setProfileId(nextProfile.id);
      setSessionId(id);
      setSchema(next);
      setSelectedTable(null);
      setResult(null);
      setChanges(new Map());
      setMessage(`Connesso a ${nextProfile.name}`);
      return { id, schema: next };
    } catch (e) {
      setQueryError(errorMessage(e));
      setMessage("Connessione non riuscita");
      return null;
    } finally {
      setConnecting(false);
    }
  }
  async function refreshSchema() {
    if (!sessionId) return;
    try {
      setSchema(await api<SchemaSnapshot>("introspect", { sessionId }));
      notify("Struttura aggiornata.");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function readTable(
    table: TableInfo,
    nextOffset = 0,
    nextSort = sortColumn,
    nextDesc = sortDesc,
    filter = tableFilter,
  ) {
    if (!canLeaveChanges()) return;
    let id = sessionId;
    if (!id) {
      const opened = await connect();
      if (!opened) return;
      id = opened.id;
    }
    setTableLoading(true);
    setQueryError("");
    try {
      const next = await api<QueryResult>("read_table", {
        sessionId: id,
        table: table.schema ? `${table.schema}.${table.name}` : table.name,
        limit: pageSize,
        offset: nextOffset,
        filter,
        orderBy: nextSort || undefined,
        orderDesc: nextDesc,
      });
      setResult(next);
      setSelectedTable(table);
      setResultIndex(0);
      setOffset(nextOffset);
      setSortColumn(nextSort);
      setSortDesc(nextDesc);
      setChanges(new Map());
      setView("data");
      setMessage(`${next.sets[0]?.rows.length || 0} record letti`);
    } catch (e) {
      setQueryError(errorMessage(e));
      setView("data");
      setSelectedTable(null);
      setResult(null);
    } finally {
      setTableLoading(false);
    }
  }
  function openQuery(text: string, id = "") {
    if (!canLeaveChanges()) return;
    setQuery(text);
    lastSelectionRef.current = null;
    setActiveSavedId(id);
    const saved = boot.savedQueries.find((item) => item.id === id);
    setParametersText(JSON.stringify(saved?.parameters || {}, null, 2));
    setShowParameters(Object.keys(saved?.parameters || {}).length > 0);
    setExecutionMode(saved?.executionMode || "current");
    setChanges(new Map());
    setView("editor");
    setSearchOpen(false);
  }
  function openParameterizedQuery(
    text: string,
    parameters: Record<string, unknown> = {},
    savedId = "",
  ) {
    openQuery(text, savedId);
    setParametersText(JSON.stringify(parameters, null, 2));
    setShowParameters(Object.keys(parameters).length > 0);
  }
  function insertQueryElement(
    text: string,
    parameters?: Record<string, unknown>,
  ) {
    if (parameters && Object.keys(parameters).length) {
      try {
        const existing = JSON.parse(parametersText);
        setParametersText(
          JSON.stringify({ ...existing, ...parameters }, null, 2),
        );
        setShowParameters(true);
      } catch {
        notify("Correggi prima il JSON dei parametri.", true);
        return;
      }
    }
    if (view !== "editor") {
      insertionRef.current = text;
      setView("editor");
      return;
    }
    const editor = editorRef.current,
      model = editor?.getModel();
    if (!editor || !model) {
      setQuery((old) => old + "\n" + text);
      return;
    }
    const range = editor.getSelection() || {
      startLineNumber: model.getLineCount(),
      startColumn: model.getLineMaxColumn(model.getLineCount()),
      endLineNumber: model.getLineCount(),
      endColumn: model.getLineMaxColumn(model.getLineCount()),
    };
    editor.executeEdits("query-elements", [
      { range, text, forceMoveMarkers: true },
    ]);
    editor.focus();
  }
  function openLibraryEntry(entry: LibraryEntry) {
    openParameterizedQuery(
      entry.query,
      entry.parameters || {},
      entry.source === "saved" ? entry.sourceId || "" : "",
    );
    setExecutionMode(entry.executionMode || "current");
    if (entry.engine !== engine)
      notify(
        `Esempio per ${ENGINE_LABELS[entry.engine]}. Controlla la connessione prima di eseguire.`,
      );
  }
  async function applyDesign(
    script: string,
    designEngine: Engine,
  ): Promise<SchemaSnapshot> {
    if (designEngine !== engine)
      throw new Error(
        "Collega una connessione dello stesso motore del progetto.",
      );
    if (profile?.readOnly) throw new Error("La connessione è in sola lettura.");
    let id = sessionId;
    if (!id) {
      const opened = await connect();
      if (!opened)
        throw new Error("Collega un database prima della creazione.");
      id = opened.id;
    }
    const commands = designEngine === "mongodb" ? JSON.parse(script) : null;
    const list = Array.isArray(commands)
      ? commands
      : designEngine === "mongodb"
        ? [commands]
        : [script];
    for (const command of list) {
      await api("execute_query", {
        sessionId: id,
        query: designEngine === "mongodb" ? JSON.stringify(command) : command,
        parameters: {},
      });
    }
    const next = await api<SchemaSnapshot>("introspect", { sessionId: id });
    setSchema(next);
    notify(
      "Strutture create. Apri Dati tabella per inserire e modificare i record.",
    );
    return next;
  }
  function addTableRecord() {
    if (!activeResult) return;
    setRecord({
      row: {},
      index: Math.max(
        activeResult.rows.length,
        ...[...changes.keys()].map((n) => n + 1),
      ),
      inserting: true,
    });
  }
  function showExplanation() {
    setLesson({
      title: "Spiegazione e ordine logico",
      analysis: explainQuery(query, engine, schema),
    });
  }
  async function run() {
    if (running || !query.trim()) return;
    if (!canLeaveChanges()) return;
    let id = sessionId;
    if (!id) {
      const opened = await connect();
      if (!opened) return;
      id = opened.id;
    }
    const editor = editorRef.current;
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const selected = model && selection ? model.getValueInRange(selection) : "";
    const position =
      model && editor?.getPosition()
        ? model.getOffsetAt(editor.getPosition()!)
        : 0;
    const text =
      executionMode === "script"
        ? query
        : executionMode === "selection"
          ? selected || query
          : selected || statementAt(query, position);
    if (!text.trim()) {
      notify("Seleziona o scrivi una query da eseguire.");
      return;
    }
    let parameters: Record<string, unknown>;
    try {
      const parsed = JSON.parse(parametersText);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw new Error("I parametri devono essere un oggetto JSON.");
      parameters = parsed;
    } catch (e) {
      setQueryError(errorMessage(e));
      return;
    }
    setRunning(true);
    setQueryError("");
    setSelectedTable(null);
    setChanges(new Map());
    setMessage("Esecuzione in corso…");
    try {
      const next = await executeQuery(
        {
          sessionId: id,
          query: text,
          parameters,
          executionMode,
        },
        (count) =>
          setMessage(`${count.toLocaleString("it-IT")} righe ricevute…`),
      );
      setResult(next);
      setResultIndex(0);
      setOffset(0);
      setMessage(next.message || `Completata in ${next.elapsedMs} ms`);
      try {
        const history = await api<HistoryEntry[]>("get_history");
        setBoot((old) => ({ ...old, history }));
      } catch {
        /* La query rimane riuscita anche se la cronologia non è disponibile. */
      }
    } catch (e) {
      setQueryError(errorMessage(e));
      setMessage("Query non riuscita");
    } finally {
      setRunning(false);
    }
  }
  runRef.current = () => void run();
  saveRef.current = () => {
    if (query.trim()) {
      setSavedName(
        boot.savedQueries.find((item) => item.id === activeSavedId)?.name || "",
      );
      setSaveDialog(true);
    } else notify("Scrivi una query da salvare.");
  };
  async function cancel() {
    try {
      const status = await api<string>("cancel_query", { sessionId });
      setMessage(status);
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function saveQuery() {
    if (!savedName.trim()) return;
    let savedParameters: Record<string, unknown>;
    try {
      savedParameters = JSON.parse(parametersText);
      if (
        !savedParameters ||
        Array.isArray(savedParameters) ||
        typeof savedParameters !== "object"
      )
        throw new Error("Usa un oggetto JSON per i parametri.");
    } catch (e) {
      notify(errorMessage(e), true);
      return;
    }
    const saved: SavedQuery = {
      parameters: savedParameters,
      executionMode,
      id: activeSavedId || newId(),
      name: savedName.trim(),
      query,
      engine,
      favorite:
        boot.savedQueries.find((item) => item.id === activeSavedId)?.favorite ||
        false,
    };
    try {
      await api("save_query", { query: saved });
      setBoot((old) => ({
        ...old,
        savedQueries: [
          ...old.savedQueries.filter((item) => item.id !== saved.id),
          saved,
        ],
      }));
      setActiveSavedId(saved.id);
      setSaveDialog(false);
      notify("Query salvata.");
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  async function favorite(saved: SavedQuery) {
    const next = { ...saved, favorite: !saved.favorite };
    try {
      await api("save_query", { query: next });
      setBoot((old) => ({
        ...old,
        savedQueries: old.savedQueries.map((item) =>
          item.id === next.id ? next : item,
        ),
      }));
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  function editCell(index: number, column: ColumnInfo, text: string) {
    if (!activeResult) return;
    try {
      const original = activeResult.rows[index] || {};
      const existing = changes.get(index);
      const parsed = parseCell(
        text,
        column,
        existing?.values[column.name] || original[column.name],
      );
      const values = { ...existing?.values, [column.name]: parsed };
      setChanges((old) => {
        const next = new Map(old);
        const change =
          existing?.kind === "insert"
            ? { ...existing, values }
            : updateChange(
                original,
                { ...original, ...values },
                effectiveColumns,
              );
        if (change) next.set(index, change);
        else next.delete(index);
        return next;
      });
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  function deleteRow(index: number) {
    if (!activeResult) return;
    setChanges((old) => {
      const next = new Map(old);
      const existing = next.get(index);
      if (existing?.kind === "insert") {
        next.delete(index);
        return next;
      }
      if (existing?.kind === "delete") {
        next.delete(index);
        return next;
      }
      const original = activeResult.rows[index];
      next.set(index, {
        kind: "delete",
        key: Object.fromEntries(
          effectiveColumns
            .filter((c) => c.primaryKey)
            .map((c) => [c.name, original[c.name]]),
        ),
        original,
        values: {},
      });
      return next;
    });
  }
  async function applyChanges() {
    if (!activeTableName || !changes.size) return;
    setApplying(true);
    try {
      const changed = await api<QueryResult>("apply_changes", {
        sessionId,
        table: activeTableName,
        changes: [...changes.values()],
      });
      setChanges(new Map());
      setPreview(false);
      notify(changed.message || "Modifiche applicate.");
      if (selectedTable) {
        setTableLoading(true);
        try {
          const refreshed = await api<QueryResult>("read_table", {
            sessionId,
            table: activeTableName,
            limit: pageSize,
            offset,
            filter: tableFilter,
            orderBy: sortColumn || undefined,
            orderDesc: sortDesc,
          });
          setResult(refreshed);
        } finally {
          setTableLoading(false);
        }
      } else setResult(changed);
      await refreshSchema();
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setApplying(false);
    }
  }
  function saveRecord(values: Record<string, string>, nullFields: string[]) {
    if (!record || !activeResult) return;
    try {
      const parsed: DataRow = {};
      for (const column of effectiveColumns) {
        const isNull = nullFields.includes(column.name);
        const value = isNull ? "NULL" : values[column.name];
        if (
          record.inserting &&
          isNull &&
          (column.primaryKey || column.defaultValue)
        )
          continue;
        parsed[column.name] = parseCell(
          value,
          column,
          record.row[column.name],
          isNull,
        );
      }
      if (record.inserting) {
        setChanges((old) => {
          const next = new Map(old);
          next.set(record.index, {
            kind: "insert",
            key: {},
            original: {},
            values: parsed,
          });
          return next;
        });
      } else {
        const original = activeResult.rows[record.index];
        const changed = updateChange(original, parsed, effectiveColumns);
        setChanges((old) => {
          const next = new Map(old);
          if (changed) next.set(record.index, changed);
          else next.delete(record.index);
          return next;
        });
      }
      setRecord(null);
    } catch (e) {
      notify(errorMessage(e), true);
    }
  }
  function openedLab(data: {
    profile: ConnectionProfile;
    sessionId: string;
    schema: SchemaSnapshot;
  }) {
    if (data.profile.id) {
      setBoot((old) => ({
        ...old,
        profiles: [
          ...old.profiles.filter((item) => item.id !== data.profile.id),
          data.profile,
        ],
      }));
      setProfileId(data.profile.id);
    }
    setSessionId(data.sessionId);
    setSchema(data.schema);
    setSelectedTable(null);
    setResult(null);
    setChanges(new Map());
    setMessage("Laboratorio pronto");
  }
  async function quickLab() {
    try {
      setConnecting(true);
      openedLab(await api("lab_open", { engine: "sqlite", dataset: "shop" }));
      notify(
        "Laboratorio SQLite aperto. Scegli una tabella o scrivi una query.",
      );
      setView("laboratory");
    } catch (e) {
      notify(errorMessage(e), true);
    } finally {
      setConnecting(false);
    }
  }
  async function updateSettings(patch: Record<string, unknown>) {
    const settings = await api<Record<string, unknown>>("update_settings", {
      settings: patch,
    });
    setBoot((old) => ({ ...old, settings }));
  }
  const visibleTables =
    schema?.tables.filter(
      (table) =>
        canBrowseData(table) &&
        table.name.toLowerCase().includes(explorerSearch.toLowerCase()),
    ) || [];
  const savedSorted = [...boot.savedQueries].sort(
    (a, b) =>
      Number(b.favorite) - Number(a.favorite) || a.name.localeCompare(b.name),
  );
  const searchResults = [
    ...boot.savedQueries.map((item) => ({
      type: "Query salvata",
      name: item.name,
      query: item.query,
      id: item.id,
    })),
    ...boot.history.map((item) => ({
      type: "Cronologia",
      name: item.query.slice(0, 90),
      query: item.query,
      id: "",
    })),
  ]
    .filter((item) =>
      `${item.name} ${item.query}`
        .toLowerCase()
        .includes(globalSearch.toLowerCase()),
    )
    .slice(0, 30);
  const noConnection = !sessionId && !result;

  return (
    <div
      className={`app-shell ${assistant ? "with-assistant" : ""}`}
      style={{
        gridTemplateColumns: `${sidebarWidth}px minmax(0,1fr)${assistant ? " 335px" : ""}`,
      }}
    >
      <aside className="sidebar">
        <div
          className="sidebar-resize"
          role="separator"
          aria-label="Larghezza esploratore"
          aria-orientation="vertical"
          aria-valuemin={190}
          aria-valuemax={450}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft")
              setSidebarWidth((w) => Math.max(190, w - 10));
            if (e.key === "ArrowRight")
              setSidebarWidth((w) => Math.min(450, w + 10));
          }}
          onMouseDown={(event) => {
            event.preventDefault();
            const start = event.clientX,
              initial = sidebarWidth;
            const move = (e: MouseEvent) =>
              setSidebarWidth(
                Math.max(190, Math.min(450, initial + e.clientX - start)),
              );
            const end = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", end);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", end);
          }}
        />
        <div className="brand">
          <span className="brand-mark">
            <Database size={23} />
          </span>
          <div>
            <strong>
              Database<span>Manager</span>
            </strong>
            <small>IL TUO SPAZIO DATI</small>
          </div>
          <span
            className="version-pill"
            title="Copyright © 2026 Daniele Gabrovec"
          >
            0.2.1
          </span>
        </div>
        <button className="global-search" onClick={() => setSearchOpen(true)}>
          <Search size={15} />
          <span>Cerca nel workspace</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="workspace-label">
          <FolderOpen size={12} />
          WORKSPACE LOCALE
        </div>
        <nav className="primary-nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={view === item.id ? "active" : ""}
              onClick={() => setView(item.id)}
            >
              <item.icon size={17} />
              <span>{item.label}</span>
              {item.id === "laboratory" && (
                <span className="nav-tag">IMPARA</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-tabs">
            <button
              className={sidebarTab === "explorer" ? "active" : ""}
              onClick={() => setSidebarTab("explorer")}
            >
              Connessioni
            </button>
            <button
              className={sidebarTab === "saved" ? "active" : ""}
              onClick={() => setSidebarTab("saved")}
            >
              Salvate
            </button>
            <button
              className={sidebarTab === "history" ? "active" : ""}
              onClick={() => setSidebarTab("history")}
            >
              <History size={13} />
            </button>
            <div className="spacer" />
            <button
              className="icon-button"
              aria-label="Nuova connessione"
              onClick={() => setProfileDialog(null)}
            >
              <Plus size={16} />
            </button>
          </div>
          {sidebarTab === "explorer" && (
            <>
              <div className="explorer-search">
                <Search size={13} />
                <input
                  aria-label="Filtra tabelle"
                  placeholder="Filtra oggetti…"
                  value={explorerSearch}
                  onChange={(e) => setExplorerSearch(e.target.value)}
                />
              </div>
              <div className="connection-tree">
                {boot.profiles.map((item) => (
                  <div key={item.id}>
                    <div
                      className={`connection-line ${profileId === item.id ? "selected" : ""}`}
                    >
                      <button
                        onClick={() => void connect(item)}
                        title={`${ENGINE_LABELS[item.engine]} · ${item.database || item.filePath}`}
                      >
                        <span className={`engine-dot ${item.engine}`} />
                        {profileId === item.id && sessionId ? (
                          <ChevronDown size={12} />
                        ) : (
                          <ChevronRight size={12} />
                        )}
                        <span>{item.name}</span>
                        {item.readOnly && <ShieldCheck size={12} />}
                      </button>
                      <button
                        className="tree-menu"
                        aria-label={`Modifica ${item.name}`}
                        onClick={() => setProfileDialog(item)}
                      >
                        <MoreHorizontal size={15} />
                      </button>
                    </div>
                    {profileId === item.id && sessionId && (
                      <div className="table-tree">
                        <div className="tree-folder">
                          <ChevronDown size={12} />
                          <FolderOpen size={13} />
                          {schema?.engine === "mongodb"
                            ? "Collezioni"
                            : "Tabelle"}
                          <span>
                            {schema?.tables.filter(canBrowseData).length || 0}
                          </span>
                          <button
                            className="icon-button"
                            aria-label="Aggiorna struttura"
                            onClick={refreshSchema}
                          >
                            <RefreshCw size={11} />
                          </button>
                        </div>
                        {visibleTables.map((table) => (
                          <button
                            key={`${table.schema}.${table.name}`}
                            className={
                              selectedTable?.name === table.name &&
                              view === "data"
                                ? "active"
                                : ""
                            }
                            onClick={() =>
                              void readTable(table, 0, "", false, "")
                            }
                          >
                            <Table2 size={13} />
                            <span>{table.name}</span>
                            <ChevronRight size={11} />
                          </button>
                        ))}
                        {!visibleTables.length && (
                          <p className="tree-empty">
                            {schema?.tables.length
                              ? "Nessuna corrispondenza"
                              : "Nessuna tabella"}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {!boot.profiles.length && (
                  <div className="sidebar-empty">
                    <Cable size={22} />
                    <p>Collega il tuo primo database</p>
                    <button onClick={() => setProfileDialog(null)}>
                      Aggiungi connessione
                      <Plus size={12} />
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
          {sidebarTab === "saved" && (
            <div className="saved-list">
              {savedSorted.map((item) => (
                <div
                  className={item.id === activeSavedId ? "active" : ""}
                  key={item.id}
                >
                  <button onClick={() => openQuery(item.query, item.id)}>
                    <FileCode2 size={14} />
                    <span>
                      {item.name}
                      <small>{ENGINE_LABELS[item.engine]}</small>
                    </span>
                  </button>
                  <button
                    className="star-button"
                    aria-label={
                      item.favorite
                        ? "Rimuovi dai preferiti"
                        : "Aggiungi ai preferiti"
                    }
                    onClick={() => void favorite(item)}
                  >
                    <Star
                      size={13}
                      fill={item.favorite ? "currentColor" : "none"}
                    />
                  </button>
                </div>
              ))}
              {!savedSorted.length && (
                <p className="tree-empty">
                  Salva una query dall’editor per ritrovarla qui.
                </p>
              )}
            </div>
          )}
          {sidebarTab === "history" && (
            <div className="history-list">
              {boot.history.slice(0, 80).map((item) => (
                <button
                  key={item.id}
                  onClick={() => openQuery(item.query)}
                  title={item.error || item.query}
                >
                  <span
                    className={`status-dot ${item.success ? "success" : "error"}`}
                  />
                  <span>
                    <code>{item.query.replace(/\s+/g, " ")}</code>
                    <small>
                      {item.profileName} · {item.elapsedMs} ms
                    </small>
                  </span>
                </button>
              ))}
              {!boot.history.length && (
                <p className="tree-empty">
                  Le query eseguite compariranno qui.
                </p>
              )}
            </div>
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={view === "settings" ? "active" : ""}
            onClick={() => setView("settings")}
          >
            <Settings2 size={16} />
            Impostazioni
          </button>
          <button
            onClick={() =>
              setTheme(
                theme === "dark"
                  ? "light"
                  : theme === "light"
                    ? "system"
                    : "dark",
              )
            }
            title={`Tema: ${theme}`}
          >
            <SunMoon size={16} />
            {theme === "dark"
              ? "Tema scuro"
              : theme === "light"
                ? "Tema chiaro"
                : "Tema di sistema"}
          </button>
          <div className="local-indicator">
            <span className="status-dot success" />
            Spazio di lavoro locale<span>RUST + TAURI</span>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {NAV.find((item) => item.id === view)?.label || "Impostazioni"}
            </strong>
            {profile && (
              <>
                <ChevronRight size={13} />
                <span className="active-profile-name">{profile.name}</span>
              </>
            )}
          </div>
          <div className="topbar-actions">
            <span className="mode-caption">MODALITÀ</span>
            <select
              aria-label="Modalità di utilizzo"
              className="mode-select"
              value={mode}
              onChange={(e) => setMode(e.target.value as Mode)}
            >
              {Object.entries(MODE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button
              className={`assistant-toggle ${assistant ? "active" : ""}`}
              onClick={() => setAssistant(!assistant)}
            >
              <Bot size={16} />
              <span>Assistente</span>
            </button>
          </div>
        </header>
        {bootError && (
          <div className="boot-error">
            <Notice tone="error">
              {bootError}{" "}
              <button className="text-button" onClick={bootstrap}>
                Riprova collegamento
              </button>
            </Notice>
          </div>
        )}
        {initializing ? (
          <div className="loading-screen">
            <LoaderCircle className="spin" size={30} />
            <p>Apertura dello spazio di lavoro…</p>
          </div>
        ) : (
          <div className="main-content">
            {view === "editor" && (
              <div
                className={`editor-tools-layout ${showElements ? "has-elements" : ""}`}
              >
                <div className="editor-view">
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        SCRIVI. ESEGUI. COMPRENDI.
                      </span>
                      <h1>
                        Editor query<span className="heading-dot">.</span>
                      </h1>
                    </div>
                    <div className="row">
                      <Button onClick={() => setProfileDialog(null)}>
                        <Plus size={14} />
                        Nuova connessione
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => setView("laboratory")}
                      >
                        <FlaskConical size={15} />
                        Vai al laboratorio
                        <ArrowRight size={13} />
                      </Button>
                    </div>
                  </div>
                  <div className="connection-toolbar">
                    <Cable size={16} />
                    <select
                      aria-label="Connessione attiva"
                      value={profileId}
                      onChange={(e) => {
                        const next = boot.profiles.find(
                          (item) => item.id === e.target.value,
                        );
                        if (next) void connect(next);
                      }}
                    >
                      <option value="">Seleziona una connessione</option>
                      {boot.profiles.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    {profile && (
                      <>
                        <span
                          className={`environment-badge ${profile.laboratory ? "laboratory" : { Produzione: "production", Test: "test", Locale: "development" }[profile.environment] || profile.environment}`}
                        >
                          <span />
                          {ENV_LABELS[profile.environment] ||
                            profile.environment}
                        </span>
                        <span className="database-label">
                          <Database size={13} />
                          {schema?.database ||
                            profile.database ||
                            profile.filePath}
                        </span>
                        <span className="engine-badge">
                          {ENGINE_LABELS[engine]}
                        </span>
                        {profile.readOnly && (
                          <span className="badge">Sola lettura</span>
                        )}
                      </>
                    )}
                    <div className="spacer" />
                    {sessionId ? (
                      <span className="connection-status">
                        <span className="status-dot success" />
                        Connesso
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        disabled={!profile}
                        busy={connecting}
                        onClick={() => void connect()}
                      >
                        Connetti
                      </Button>
                    )}
                  </div>
                  <section className="query-panel">
                    <div className="editor-tabbar">
                      <div className="editor-tab">
                        <FileCode2 size={14} />
                        {activeSavedId
                          ? boot.savedQueries.find(
                              (item) => item.id === activeSavedId,
                            )?.name || "Query"
                          : "Query senza titolo"}
                        <span className="unsaved-dot" />
                      </div>
                      <div className="spacer" />
                      <button
                        className="icon-button"
                        title="Salva query (Ctrl+S)"
                        onClick={() => saveRef.current()}
                      >
                        <Save size={15} />
                      </button>
                      <button
                        className="icon-button"
                        title="Nuova query"
                        onClick={() => openQuery("")}
                      >
                        <Plus size={16} />
                      </button>
                    </div>
                    {showParameters && (
                      <div className="parameters-panel">
                        <Field
                          label="Parametri · oggetto JSON"
                          hint={
                            engine === "postgresql"
                              ? "Per $1, $2 usa le chiavi 1, 2."
                              : "Per :nome usa la chiave nome."
                          }
                        >
                          <textarea
                            className="mono"
                            rows={3}
                            value={parametersText}
                            onChange={(e) => setParametersText(e.target.value)}
                            spellCheck={false}
                          />
                        </Field>
                      </div>
                    )}
                    <div
                      className="query-editor"
                      style={{ height: editorHeight }}
                    >
                      <Editor
                        value={query}
                        language={engine === "mongodb" ? "json" : "sql"}
                        theme={dark ? "vs-dark" : "light"}
                        onChange={(value) => setQuery(value || "")}
                        onMount={(editor, monaco) => {
                          editorRef.current = editor;
                          sqlToolsRef.current?.dispose();
                          sqlToolsRef.current = installSqlLanguage(
                            monaco,
                            editor,
                            () => sqlContextRef.current,
                          );
                          editor.onDidChangeCursorSelection(() => {
                            const model = editor.getModel(),
                              selection = editor.getSelection();
                            if (selection)
                              lastSelectionRef.current = {
                                startLineNumber: selection.startLineNumber,
                                startColumn: selection.startColumn,
                                endLineNumber: selection.endLineNumber,
                                endColumn: selection.endColumn,
                              };
                            setQuerySelection(
                              model && selection
                                ? model.getValueInRange(selection)
                                : "",
                            );
                          });
                          if (insertionRef.current !== null) {
                            const text = insertionRef.current;
                            insertionRef.current = null;
                            const model = editor.getModel();
                            if (model) {
                              const line = model.getLineCount(),
                                column = model.getLineMaxColumn(line);
                              editor.executeEdits("query-library", [
                                {
                                  range: lastSelectionRef.current
                                    ? model.validateRange(
                                        lastSelectionRef.current,
                                      )
                                    : {
                                        startLineNumber: line,
                                        startColumn: column,
                                        endLineNumber: line,
                                        endColumn: column,
                                      },
                                  text: lastSelectionRef.current
                                    ? text
                                    : "\n" + text,
                                  forceMoveMarkers: true,
                                },
                              ]);
                            }
                          }

                          editor.addAction({
                            id: "database-run-query",
                            label: "Esegui query",
                            keybindings: [2048 | 3],
                            run: () => runRef.current(),
                          });
                        }}
                        options={{
                          fontSize: Math.max(
                            12,
                            Math.min(
                              24,
                              Number(boot.settings.editorFontSize) || 14,
                            ),
                          ),
                          fontFamily: '"Cascadia Code", "Consolas", monospace',
                          lineHeight: 24,
                          minimap: { enabled: false },
                          padding: { top: 18, bottom: 18 },
                          scrollBeyondLastLine: false,
                          automaticLayout: true,
                          wordWrap: "on",
                          renderLineHighlight: "gutter",
                          tabSize: 2,
                          quickSuggestions: true,
                          suggestOnTriggerCharacters: true,
                          parameterHints: { enabled: true },
                          tabCompletion: "on",
                          wordBasedSuggestions: "off",
                          acceptSuggestionOnEnter: "on",
                        }}
                      />
                      {!query && (
                        <div className="editor-placeholder">
                          <code>
                            {engine === "mongodb"
                              ? "// Scrivi un comando Extended JSON…"
                              : "-- Scrivi una query oppure apri una tabella…"}
                          </code>
                          <span>
                            {engine === "mongodb"
                              ? 'Esempio: { "find": "collection", "filter": {}, "limit": 20 }'
                              : "Usa Ctrl + Invio per eseguire la selezione o la query corrente."}
                          </span>
                        </div>
                      )}
                    </div>
                    <div
                      className="editor-resize"
                      role="separator"
                      aria-label="Ridimensiona editor"
                      aria-orientation="horizontal"
                      onMouseDown={(event) => {
                        const start = event.clientY,
                          initial = editorHeight;
                        const move = (e: MouseEvent) =>
                          setEditorHeight(
                            Math.max(
                              150,
                              Math.min(600, initial + e.clientY - start),
                            ),
                          );
                        const end = () => {
                          window.removeEventListener("mousemove", move);
                          window.removeEventListener("mouseup", end);
                        };
                        window.addEventListener("mousemove", move);
                        window.addEventListener("mouseup", end);
                      }}
                    />
                    <div className="query-tool-strip">
                      <Button
                        onClick={() => {
                          editorRef.current?.focus();
                          editorRef.current?.trigger(
                            "toolbar",
                            "editor.action.triggerSuggest",
                            {},
                          );
                        }}
                      >
                        Completa <kbd>Ctrl Spazio</kbd>
                      </Button>
                      <Button onClick={() => setShowElements(!showElements)}>
                        <Layers3 size={14} />
                        {showElements ? "Nascondi elementi" : "Elementi query"}
                      </Button>
                      <Button
                        onClick={showExplanation}
                        disabled={!query.trim()}
                      >
                        <BookOpen size={14} />
                        Spiega passo passo
                      </Button>
                      <Button onClick={() => setView("library")}>
                        Catalogo query
                      </Button>
                    </div>
                    <div className="query-actions">
                      <Button
                        variant="primary"
                        onClick={() => void run()}
                        busy={running}
                        disabled={!query.trim() || connecting}
                      >
                        {!running && <Play size={14} fill="currentColor" />}
                        Esegui query<kbd>Ctrl ↵</kbd>
                      </Button>
                      <select
                        aria-label="Porzione di query da eseguire"
                        value={executionMode}
                        onChange={(e) => setExecutionMode(e.target.value)}
                      >
                        <option value="current">
                          Selezione / query corrente
                        </option>
                        <option value="selection">Selezione</option>
                        <option value="script">Intero script</option>
                      </select>
                      {running && (
                        <Button variant="danger" onClick={cancel}>
                          <Square size={12} />
                          Interrompi
                        </Button>
                      )}
                      <div className="spacer" />
                      <button
                        className="text-icon"
                        onClick={() => setShowParameters(!showParameters)}
                      >
                        <Braces size={14} />
                        Parametri
                      </button>
                      <button
                        className="text-icon"
                        onClick={() => {
                          setView("schema");
                        }}
                      >
                        <Activity size={14} />
                        Piano query
                      </button>
                      <button
                        className="text-icon"
                        onClick={() => setView("codegen")}
                      >
                        <Code2 size={15} />
                        Genera codice
                        <ArrowRight size={12} />
                      </button>
                    </div>
                  </section>
                  {mode === "learning" && (
                    <div className="learning-tip">
                      <BookOpen size={16} />
                      <p>
                        <strong>Un passo alla volta.</strong> SELECT legge i
                        dati. WHERE filtra le righe. Il pulsante Assistente può
                        spiegare la query e proporti esempi.
                      </p>
                      <button onClick={() => setAssistant(true)}>
                        Chiedi una spiegazione
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                  {queryError && (
                    <Notice tone="error">
                      {queryError}
                      <ul>
                        {explainQueryError(queryError, engine).map(
                          (hint, i) => (
                            <li key={i}>{hint}</li>
                          ),
                        )}
                      </ul>
                    </Notice>
                  )}
                  <section className="results-panel">
                    <div className="results-heading">
                      <div className="results-tabs">
                        <button className="active">
                          <Table2 size={14} />
                          {selectedTable?.name || "Risultati"}
                          {activeResult && (
                            <span>{activeResult.rows.length}</span>
                          )}
                        </button>
                        {result &&
                          result.sets.length > 1 &&
                          result.sets.map((_, index) => (
                            <button
                              key={index}
                              className={
                                resultIndex === index ? "selected" : ""
                              }
                              onClick={() => {
                                if (canLeaveChanges()) {
                                  setResultIndex(index);
                                  setChanges(new Map());
                                }
                              }}
                            >
                              Set {index + 1}
                            </button>
                          ))}
                      </div>
                      <div className="spacer" />
                      {result && (
                        <>
                          <span className="result-metric">
                            <Clock3 size={12} />
                            {result.elapsedMs} ms
                          </span>
                          <span className="result-metric">
                            {result.affectedRows || 0} modificate
                          </span>
                        </>
                      )}
                      <button
                        className="icon-button"
                        title="Esporta dati"
                        onClick={() => setView("transfer")}
                      >
                        <Download size={14} />
                      </button>
                    </div>
                    {activeResult && (
                      <div className="result-toolbar">
                        {selectedTable && (
                          <>
                            <div className="filter-input">
                              <Search size={13} />
                              <input
                                aria-label="Filtro server"
                                value={tableFilter}
                                onChange={(e) => setTableFilter(e.target.value)}
                                placeholder={
                                  engine === "mongodb"
                                    ? "Filtro JSON…"
                                    : "Cerca nei valori…"
                                }
                                onKeyDown={(e) => {
                                  if (e.key === "Enter")
                                    void readTable(selectedTable, 0);
                                }}
                              />
                            </div>
                            <Button
                              variant="ghost"
                              onClick={() => void readTable(selectedTable, 0)}
                              busy={tableLoading}
                            >
                              <RefreshCw size={13} />
                              Aggiorna
                            </Button>
                          </>
                        )}
                        {!editable && (
                          <span className="muted small">
                            <ShieldCheck size={12} />{" "}
                            {profile?.readOnly
                              ? "Connessione in sola lettura"
                              : "Modifica disponibile per risultati con tabella e chiave primaria"}
                          </span>
                        )}
                        <div className="spacer" />
                        {editable && (
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setRecord({
                                row: {},
                                index: Math.max(
                                  activeResult.rows.length,
                                  ...[...changes.keys()].map((n) => n + 1),
                                ),
                                inserting: true,
                              })
                            }
                          >
                            <Plus size={13} />
                            Record
                          </Button>
                        )}
                        {changes.size > 0 && (
                          <>
                            <span className="change-count">
                              {changes.size} modifiche
                            </span>
                            <Button
                              variant="ghost"
                              onClick={() => setChanges(new Map())}
                            >
                              Scarta
                            </Button>
                            <Button onClick={() => setPreview(true)}>
                              Anteprima
                            </Button>
                            <Button
                              variant="primary"
                              onClick={() => setPreview(true)}
                              busy={applying}
                            >
                              <Check size={13} />
                              Applica
                            </Button>
                          </>
                        )}
                      </div>
                    )}
                    {activeResult ? (
                      <DataGrid
                        result={{ ...activeResult, columns: effectiveColumns }}
                        changes={changes}
                        editable={editable}
                        onEdit={editCell}
                        onDelete={deleteRow}
                        onSelect={(row, index) => setRecord({ row, index })}
                        onSort={
                          selectedTable
                            ? (name) =>
                                void readTable(
                                  selectedTable,
                                  0,
                                  name,
                                  name === sortColumn ? !sortDesc : false,
                                )
                            : undefined
                        }
                        sortColumn={sortColumn}
                        sortDesc={sortDesc}
                      />
                    ) : result ? (
                      <Empty
                        icon={<Check size={25} />}
                        title="Operazione completata"
                      >
                        {result.message ||
                          `${result.affectedRows} righe interessate.`}
                      </Empty>
                    ) : noConnection ? (
                      <div className="editor-onboarding">
                        <div className="onboarding-art">
                          <Database size={36} />
                          <span />
                          <i />
                        </div>
                        <h2>Ogni progetto parte dai dati</h2>
                        <p>
                          Collega un database oppure apri il laboratorio SQLite.
                          <br />
                          Puoi esplorare, provare query e generare codice da
                          qui.
                        </p>
                        <div className="row">
                          <Button
                            variant="primary"
                            onClick={() => setProfileDialog(null)}
                          >
                            <Cable size={15} />
                            Collega database
                          </Button>
                          <Button onClick={quickLab} busy={connecting}>
                            <FlaskConical size={15} />
                            Prova il laboratorio
                          </Button>
                        </div>
                        <div className="supported-engines">
                          <span>SQLite</span>
                          <span>PostgreSQL</span>
                          <span>MySQL</span>
                          <span>MariaDB</span>
                          <span>MongoDB</span>
                        </div>
                      </div>
                    ) : (
                      <Empty
                        icon={<Terminal size={26} />}
                        title="Pronto per la prima query"
                      >
                        Apri una tabella nell’esploratore o esegui il comando
                        nell’editor.
                      </Empty>
                    )}
                    {activeResult && (
                      <div className="result-footer">
                        <span>
                          {activeResult.rows.length
                            ? `${offset + 1}–${offset + activeResult.rows.length}`
                            : "0"}{" "}
                          record{" "}
                          {activeResult.truncated && (
                            <b>· risultato limitato</b>
                          )}
                        </span>
                        <div className="spacer" />
                        {selectedTable && (
                          <>
                            <select
                              aria-label="Righe per pagina"
                              value={pageSize}
                              onChange={(e) =>
                                setPageSize(Number(e.target.value))
                              }
                            >
                              {[50, 100, 200, 500, 1000].map((size) => (
                                <option key={size} value={size}>
                                  {size} per pagina
                                </option>
                              ))}
                            </select>
                            <button
                              className="icon-button"
                              disabled={offset === 0 || tableLoading}
                              aria-label="Pagina precedente"
                              onClick={() =>
                                void readTable(
                                  selectedTable,
                                  Math.max(0, offset - pageSize),
                                )
                              }
                            >
                              <ArrowLeft size={14} />
                            </button>
                            <button
                              className="icon-button"
                              disabled={
                                activeResult.rows.length < pageSize ||
                                tableLoading
                              }
                              aria-label="Pagina successiva"
                              onClick={() =>
                                void readTable(selectedTable, offset + pageSize)
                              }
                            >
                              <ArrowRight size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </section>
                </div>
                {showElements && (
                  <QueryElementsPanel
                    engine={engine}
                    schema={schema}
                    query={query}
                    selection={querySelection}
                    selectedTable={selectedTable?.name}
                    onInsert={insertQueryElement}
                    onExplain={(text) =>
                      setLesson({ title: "Elemento della query", text })
                    }
                  />
                )}
              </div>
            )}
            {view === "data" && (
              <div className="view-content data-workbench">
                <div className="section-heading">
                  <div>
                    <small>EDITOR DATI DEL DATABASE</small>
                    <h1>Dati tabella</h1>
                  </div>
                  <div className="row">
                    <Button onClick={() => setView("designer")}>
                      <Plus size={14} />
                      Nuova tabella
                    </Button>
                    <Button onClick={() => setView("codegen")}>
                      <Code2 size={14} />
                      Genera lettura
                    </Button>
                    <Button onClick={() => setView("schema")}>Struttura</Button>
                  </div>
                </div>
                <div className="panel data-browser-bar">
                  <Field label="Tabella o collezione">
                    <select
                      value={
                        selectedTable
                          ? (selectedTable.schema
                              ? selectedTable.schema + "."
                              : "") + selectedTable.name
                          : ""
                      }
                      onChange={(e) => {
                        const found = schema?.tables.find(
                          (t) =>
                            (t.schema ? t.schema + "." : "") + t.name ===
                            e.target.value,
                        );
                        if (found) void readTable(found, 0, "", false, "");
                      }}
                    >
                      <option value="">Scegli una tabella</option>
                      {schema?.tables.filter(canBrowseData).map((t) => (
                        <option
                          key={`${t.schema}.${t.name}`}
                          value={(t.schema ? t.schema + "." : "") + t.name}
                        >
                          {t.schema ? t.schema + "." : ""}
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={
                      engine === "mongodb" ? "Filtro JSON" : "Cerca nei valori"
                    }
                  >
                    <input
                      value={tableFilter}
                      onChange={(e) => setTableFilter(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && selectedTable)
                          void readTable(selectedTable, 0);
                      }}
                      placeholder={
                        engine === "mongodb"
                          ? '{"city":"Udine"}'
                          : "Scrivi e premi Invio"
                      }
                    />
                  </Field>
                  <Button
                    disabled={!selectedTable}
                    busy={tableLoading}
                    onClick={() => {
                      if (selectedTable) void readTable(selectedTable, 0);
                    }}
                  >
                    <Search size={14} />
                    Filtra sul server
                  </Button>
                  <Field label="Righe per pagina">
                    <select
                      value={pageSize}
                      onChange={(e) => setPageSize(Number(e.target.value))}
                    >
                      {[50, 100, 200, 500, 1000].map((n) => (
                        <option key={n}>{n}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                {queryError && <Notice tone="error">{queryError}</Notice>}
                {selectedTable && activeResult ? (
                  <>
                    <TableDataWorkspace
                      key={
                        (selectedTable.schema || "") + "." + selectedTable.name
                      }
                      result={{ ...activeResult, columns: effectiveColumns }}
                      changes={changes}
                      editable={editable}
                      canInsert={
                        !profile?.readOnly &&
                        !!selectedTable &&
                        selectedTable.kind !== "view"
                      }
                      tableName={activeTableName || selectedTable.name}
                      engine={engine}
                      onChangesChange={setChanges}
                      onApply={() => setPreview(true)}
                      onDiscard={() => setChanges(new Map())}
                      onEdit={editCell}
                      onDelete={deleteRow}
                      onSelect={(row, index) => setRecord({ row, index })}
                      onSort={(name) =>
                        void readTable(
                          selectedTable,
                          0,
                          name,
                          name === sortColumn ? !sortDesc : false,
                        )
                      }
                      sortColumn={sortColumn}
                      sortDesc={sortDesc}
                      onRefresh={() => void readTable(selectedTable, offset)}
                      onPreview={() => setPreview(true)}
                      onAddRecord={addTableRecord}
                      applying={applying}
                      loading={tableLoading}
                      rowOffset={offset}
                      readOnlyReason={
                        profile?.readOnly
                          ? "Connessione in sola lettura"
                          : !editable
                            ? "La tabella richiede una chiave primaria per modifiche sicure."
                            : ""
                      }
                    />
                    <div className="data-pagination">
                      <span>
                        {offset + 1}–{offset + activeResult.rows.length} record
                      </span>
                      <span className="spacer" />
                      <Button
                        disabled={offset === 0 || tableLoading}
                        onClick={() =>
                          void readTable(
                            selectedTable,
                            Math.max(0, offset - pageSize),
                          )
                        }
                      >
                        Pagina precedente
                      </Button>
                      <Button
                        disabled={
                          activeResult.rows.length < pageSize || tableLoading
                        }
                        onClick={() =>
                          void readTable(selectedTable, offset + pageSize)
                        }
                      >
                        Pagina successiva
                      </Button>
                    </div>
                  </>
                ) : (
                  <Empty
                    icon={<Table2 size={30} />}
                    title={
                      tableLoading
                        ? "Caricamento dati…"
                        : "Scegli una tabella per leggere e modificare i dati"
                    }
                  >
                    <p>
                      Le tabelle si aprono nell’editor dati, con selezione,
                      copia, modifica delle celle e anteprima dei salvataggi.
                    </p>
                    <div className="row">
                      {!schema ? (
                        <Button onClick={quickLab}>
                          Apri laboratorio SQLite
                        </Button>
                      ) : (
                        schema.tables
                          .filter(canBrowseData)
                          .slice(0, 4)
                          .map((t) => (
                            <Button
                              key={t.name}
                              onClick={() =>
                                void readTable(t, 0, "", false, "")
                              }
                            >
                              {t.name}
                            </Button>
                          ))
                      )}
                    </div>
                  </Empty>
                )}
              </div>
            )}
            {view === "designer" && (
              <TableDesignerView
                engine={engine}
                schema={schema}
                mode={mode}
                dark={dark}
                connected={!!sessionId && !!schema}
                readOnly={!!profile?.readOnly}
                onApply={applyDesign}
                onOpenQuery={openParameterizedQuery}
                onCreated={(t) => void readTable(t, 0, "", false, "")}
              />
            )}
            {view === "library" && (
              <QueryLibraryView
                engine={engine}
                schema={schema}
                savedQueries={boot.savedQueries}
                history={boot.history}
                onOpen={openLibraryEntry}
                onInsert={(entry) =>
                  insertQueryElement(entry.query, entry.parameters)
                }
                onExplain={(entry) =>
                  setLesson({
                    title: entry.title,
                    analysis: explainQuery(entry.query, entry.engine, schema),
                    text: entry.lesson,
                  })
                }
                onFavorite={favorite}
                onCreateDataset={quickLab}
              />
            )}
            {view === "laboratory" && (
              <LabView
                currentSession={sessionId}
                schema={schema}
                query={query}
                laboratory={!!profile?.laboratory}
                onOpened={openedLab}
                onQuery={openQuery}
              />
            )}
            {(view === "schema" || view === "builder") && (
              <SchemaView
                key={view}
                initialTab={view === "builder" ? "builder" : "objects"}
                schema={schema}
                sessionId={sessionId}
                profiles={boot.profiles}
                onQuery={openQuery}
                onOpenTable={(table) => void readTable(table)}
                query={query}
              />
            )}
            {view === "codegen" && (
              <CodegenView
                schema={schema}
                engine={engine}
                query={query}
                mode={mode}
                dark={dark}
                initialTable={selectedTable?.name}
                queryParameters={(() => {
                  try {
                    return JSON.parse(parametersText);
                  } catch {
                    return {};
                  }
                })()}
                onDesign={() => setView("designer")}
                onOpenQuery={openParameterizedQuery}
              />
            )}
            {view === "transfer" && (
              <TransferView sessionId={sessionId} schema={schema} />
            )}
            {view === "environments" && (
              <EnvironmentsView
                onChanged={() => {
                  void api<Bootstrap>("bootstrap")
                    .then((data) => setBoot(data))
                    .catch((e) => notify(errorMessage(e), true));
                }}
              />
            )}
            {view === "settings" && (
              <SettingsView settings={boot.settings} onSave={updateSettings} />
            )}
          </div>
        )}
        <footer className="statusbar">
          <span
            className={`status-dot ${queryError ? "error" : running || connecting ? "working" : "success"}`}
          />
          <span>{message}</span>
          <div className="spacer" />
          {changes.size > 0 && (
            <span className="pending-label">
              {changes.size} modifiche in attesa
            </span>
          )}
          <span>{engine === "mongodb" ? "Extended JSON" : "SQL"}</span>
          <span>UTF-8</span>
          <button onClick={() => setView("laboratory")}>
            <HelpCircle size={12} />
            Guida
          </button>
        </footer>
      </main>
      {lesson && (
        <Modal title={lesson.title} onClose={() => setLesson(null)} wide>
          <div className="modal-body stack">
            {lesson.text && <p className="lesson-description">{lesson.text}</p>}
            {lesson.analysis && (
              <>
                <Notice>{lesson.analysis.summary}</Notice>
                <h3>Ordine logico di lettura</h3>
                <div className="logical-query-order">
                  {lesson.analysis.logicalOrder.map((clause, i) => (
                    <span key={i}>
                      {i + 1}. {clause}
                    </span>
                  ))}
                </div>
                <div className="query-explanation-steps">
                  {lesson.analysis.steps.map((step, i) => (
                    <button
                      key={i}
                      onClick={() => {
                        const ed = editorRef.current,
                          model = ed?.getModel();
                        if (model && view === "editor") {
                          const a = model.getPositionAt(step.start),
                            b = model.getPositionAt(step.end);
                          ed?.setSelection({
                            startLineNumber: a.lineNumber,
                            startColumn: a.column,
                            endLineNumber: b.lineNumber,
                            endColumn: b.column,
                          });
                          ed?.revealLineInCenter(a.lineNumber);
                          setLesson(null);
                          ed?.focus();
                        }
                      }}
                    >
                      <strong>
                        {step.clause} · {step.title}
                      </strong>
                      <span>{step.explanation}</span>
                    </button>
                  ))}
                </div>
                {lesson.analysis.warnings.map((warning, i) => (
                  <Notice key={i} tone="warning">
                    {warning}
                  </Notice>
                ))}
              </>
            )}
          </div>
          <footer>
            <Button onClick={() => setLesson(null)}>Chiudi spiegazione</Button>
          </footer>
        </Modal>
      )}
      {assistant && (
        <AssistantPanel
          sessionId={sessionId}
          query={query}
          rows={activeResult?.rows.slice(0, 20) || []}
          settings={boot.settings}
          onClose={() => setAssistant(false)}
          onQuery={openQuery}
        />
      )}
      {profileDialog !== undefined && (
        <ProfileDialog
          profile={profileDialog || undefined}
          onClose={() => setProfileDialog(undefined)}
          onDeleted={(id) => {
            setBoot((old) => ({
              ...old,
              profiles: old.profiles.filter((item) => item.id !== id),
            }));
            if (id === profileId) {
              void api("close_session", { sessionId }).catch(() => {});
              setProfileId("");
              setSessionId("");
              setSchema(null);
              setResult(null);
              setChanges(new Map());
            }
            notify("Connessione rimossa dal workspace.");
          }}
          onSaved={(saved) => {
            setBoot((old) => ({
              ...old,
              profiles: [
                ...old.profiles.filter((item) => item.id !== saved.id),
                saved,
              ],
            }));
            if (!sessionId) setProfileId(saved.id);
            else if (saved.id === profileId) {
              void api("close_session", { sessionId }).catch(() => {});
              setSessionId("");
              setSchema(null);
              setSelectedTable(null);
              setResult(null);
              setChanges(new Map());
            }
            notify("Connessione salvata.");
          }}
        />
      )}
      {saveDialog && (
        <Modal title="Salva query" onClose={() => setSaveDialog(false)}>
          <div className="modal-body">
            <Field label="Nome della query">
              <input
                autoFocus
                value={savedName}
                onChange={(e) => setSavedName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveQuery();
                }}
                placeholder="Es. Clienti attivi"
              />
            </Field>
          </div>
          <footer>
            <Button onClick={() => setSaveDialog(false)}>Annulla</Button>
            <div className="spacer" />
            <Button
              variant="primary"
              onClick={saveQuery}
              disabled={!savedName.trim()}
            >
              <Save size={14} />
              Salva query
            </Button>
          </footer>
        </Modal>
      )}
      {preview && (
        <Modal
          title="Rivedi le modifiche preparate"
          onClose={() => setPreview(false)}
          wide
        >
          <div className="modal-body stack">
            <Notice>
              {changes.size} operazioni su <strong>{activeTableName}</strong>.
              Le modifiche verranno inviate alla connessione{" "}
              <strong>{profile?.name}</strong>.
            </Notice>
            {[...changes.entries()].map(([index, change]) => (
              <div className={`change-preview ${change.kind}`} key={index}>
                <div className="panel-heading">
                  <strong>
                    {change.kind === "insert"
                      ? "Inserimento"
                      : change.kind === "delete"
                        ? "Eliminazione"
                        : "Modifica"}{" "}
                    · record {index + 1}
                  </strong>
                  <span className="badge">
                    {Object.entries(change.key)
                      .map(([key, value]) => `${key}=${cellText(value)}`)
                      .join(", ") || "Nuovo record"}
                  </span>
                </div>
                <table className="plain-table">
                  <thead>
                    <tr>
                      <th>Campo</th>
                      <th>Prima</th>
                      <th>Dopo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(
                      change.kind === "delete"
                        ? change.original
                        : change.values,
                    ).map((name) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td className="mono">
                          {cellText(change.original[name])}
                        </td>
                        <td className="mono">
                          {change.kind === "delete"
                            ? "—"
                            : cellText(change.values[name])}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <footer>
            <Button onClick={() => setPreview(false)}>Torna ai dati</Button>
            <div className="spacer" />
            <Button variant="primary" busy={applying} onClick={applyChanges}>
              <Check size={14} />
              Applica {changes.size} modifiche
            </Button>
          </footer>
        </Modal>
      )}
      {record && activeResult && (
        <RecordDialog
          row={record.row}
          columns={effectiveColumns}
          editable={
            record.inserting
              ? !profile?.readOnly &&
                !!selectedTable &&
                selectedTable.kind !== "view"
              : editable
          }
          inserting={record.inserting}
          onClose={() => setRecord(null)}
          onSave={saveRecord}
        />
      )}
      {searchOpen && (
        <Modal
          title="Cerca nel workspace"
          onClose={() => setSearchOpen(false)}
          wide
        >
          <div className="modal-body">
            <div className="search-modal-input">
              <Search size={20} />
              <input
                autoFocus
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder="Cerca query salvate, cronologia e comandi…"
              />
            </div>
            <div className="search-command-grid">
              {NAV.filter((item) =>
                item.label.toLowerCase().includes(globalSearch.toLowerCase()),
              ).map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setView(item.id);
                    setSearchOpen(false);
                  }}
                >
                  <item.icon size={17} />
                  {item.label}
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
            <div className="search-results">
              {searchResults.map((item, index) => (
                <button
                  key={index}
                  onClick={() => openQuery(item.query, item.id)}
                >
                  <FileCode2 size={15} />
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.type}</small>
                  </span>
                  <ArrowRight size={13} />
                </button>
              ))}
            </div>
          </div>
        </Modal>
      )}
      {toast && (
        <div className={`toast ${toastError ? "error" : ""}`} role="status">
          {toastError ? <X size={16} /> : <Check size={16} />}
          {toast}
          <button
            className="icon-button"
            aria-label="Chiudi notifica"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
