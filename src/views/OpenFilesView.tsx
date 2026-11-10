import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { isTauri } from "@tauri-apps/api/core";
import {
  ArrowRight,
  ArrowLeft,
  ArrowUp,
  Check,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "../api";
import type { ConnectionProfile, Mode, SchemaSnapshot } from "../types";
import { errorMessage } from "../utils";
import { Button, Field, Notice, SectionHeader } from "../components/UI";
import { useConfirmation } from "../components/ConfirmationProvider";
import { PathInput } from "../components/PathInput";
import {
  captureFileRecovery,
  needsFileRecovery,
  type FileRecovery,
} from "../files/fileRecovery";
import {
  detectSourceLanguage,
  extractDatabaseOperations,
} from "../files/queryExtraction";
import type { ExtractedDatabaseOperation } from "../files/queryExtraction";
import "../file-workspace.css";

export interface OpenedFileDatabase {
  profile: ConnectionProfile;
  sessionId: string;
  schema: SchemaSnapshot;
}
export interface FileQueryOpenOptions {
  kind: "sql" | "mongodb";
  encoding?: string;
  fingerprint?: string;
  confidence?: "literal" | "partial";
  /** Static hints, not invented binding values. */
  parameters?: ExtractedDatabaseOperation["parameters"];
  startLine?: number;
  endLine?: number;
  sourceOnly?: boolean;
  originalContent?: string;
}
export interface GeneratedFileDraft {
  id: string;
  name: string;
  content: string;
  language: "powershell";
  autoSaveAs?: boolean;
  originLabel?: string;
}
export interface OpenFilesViewProps {
  initialRecovery?: FileRecovery | null;
  onRecoveryChange?: (recovery: FileRecovery | null) => void;
  onRecoveryError?: (message: string) => void;
  onBusyChange?: (busy: boolean) => void;
  initialPath?: string;
  initialDraft?: GeneratedFileDraft;
  onReturnToCatalog?: () => void;
  openRequestToken?: number;
  folderOpenRequestToken?: number;
  active?: boolean;
  mode?: Mode;
  dark?: boolean;
  onOpenDatabase: (opened: OpenedFileDatabase) => void | Promise<void>;
  onOpenQuery: (
    query: string,
    label?: string,
    path?: string,
    options?: FileQueryOpenOptions,
  ) => void;
  onOpenSourceText?: (text: string, language: string, path?: string) => void;
  onImportScript?: (path: string) => void;
  onNewConnection?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}
type FileKind = "sqlite" | "sql" | "source" | "text" | "binary";
export interface WorkspaceFile {
  path: string;
  name: string;
  kind: FileKind;
  extension: string;
  sizeBytes: number;
  fingerprint: string;
  encoding: string | null;
  content: string | null;
  requiresEncoding: boolean;
  readOnly: boolean;
  syntaxLanguage: string;
  sqlite?: {
    valid: boolean;
    tableCount: number;
    viewCount: number;
    tables: { name: string; kind: string }[];
    userVersion: number;
    schemaTruncated?: boolean;
  };
  warnings: string[];
}
interface RecentFile {
  path: string;
  name: string;
  kind: FileKind;
  encoding?: string;
  openedAt: string;
}
interface DirectoryEntry {
  path: string;
  name: string;
  kind: "directory" | "file";
  extension: string;
  sizeBytes: number;
}
interface DirectoryListing {
  path: string;
  entries: DirectoryEntry[];
  nextOffset: number | null;
  truncated: boolean;
  unreadableEntries?: number;
}
export interface OpenDocument extends Omit<
  WorkspaceFile,
  "path" | "fingerprint"
> {
  path?: string;
  fingerprint?: string;
  origin: "disk" | "browser" | "generated";
  generatedId?: string;
  originLabel?: string;
  headerOnly?: boolean;
}
const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const ENCODINGS = [
  ["utf-8", "UTF-8"],
  ["utf-8-bom", "UTF-8 con BOM"],
  ["utf-16le", "UTF-16 LE"],
  ["utf-16le-bom", "UTF-16 LE con BOM"],
  ["utf-16be", "UTF-16 BE"],
  ["utf-16be-bom", "UTF-16 BE con BOM"],
  ["windows-1252", "Windows-1252"],
] as const;
const KINDS: Record<FileKind, string> = {
  sqlite: "Database SQLite",
  sql: "Script SQL",
  source: "Codice sorgente",
  text: "File di testo",
  binary: "File binario",
};
const CODE_EXTENSIONS = new Set(
  "rs py js jsx mjs cjs ts tsx php java cs c cpp cc cxx h hpp go kt kts rb r sql json html htm vue svelte swift scala sh ps1".split(
    " ",
  ),
);
const LANGUAGES = new Set([
  "sql",
  "json",
  "javascript",
  "typescript",
  "python",
  "rust",
  "php",
  "java",
  "csharp",
  "cpp",
  "go",
  "kotlin",
  "ruby",
  "markdown",
  "plaintext",
  "powershell",
]);

export function hasSqliteHeader(bytes: Uint8Array): boolean {
  const magic = "SQLite format 3\0";
  return (
    bytes.length >= 16 &&
    Array.from(magic).every(
      (character, index) => bytes[index] === character.charCodeAt(0),
    )
  );
}
/** Fatal decoding prevents silent replacement characters. Saving browser copies is explicitly UTF-8. */
export function decodeBrowserBytes(
  bytes: Uint8Array,
  chosen?: string,
): {
  content: string | null;
  encoding: string | null;
  requiresEncoding: boolean;
  warnings: string[];
} {
  let encoding = chosen;
  if (!encoding) {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      encoding = "utf-8-bom";
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le-bom";
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be-bom";
    else encoding = "utf-8";
  }
  const decoder = encoding.replace(/-bom$/, "");
  try {
    const content = new TextDecoder(decoder, { fatal: true }).decode(bytes);
    if (content.includes("\0"))
      return {
        content: null,
        encoding: null,
        requiresEncoding: true,
        warnings: [
          "Il contenuto include byte NUL: scegli la codifica corretta oppure trattalo come binario.",
        ],
      };
    return {
      content,
      encoding,
      requiresEncoding: false,
      warnings: chosen
        ? [
            "Codifica selezionata esplicitamente; controlla i caratteri nell'anteprima.",
          ]
        : [],
    };
  } catch {
    return {
      content: null,
      encoding: null,
      requiresEncoding: true,
      warnings: [
        "Il testo non è UTF-8 valido. Scegli la codifica prima di modificarlo: nessun carattere è stato sostituito automaticamente.",
      ],
    };
  }
}
export function extractedOpenOptions(
  operation: ExtractedDatabaseOperation,
): FileQueryOpenOptions {
  return {
    kind: operation.kind,
    confidence: operation.confidence,
    parameters: operation.parameters,
    startLine: operation.startLine,
    endLine: operation.endLine,
    sourceOnly: true,
  };
}
export function wholeSqlOpenOptions(file: {
  encoding: string | null;
  fingerprint?: string;
  origin: "disk" | "browser" | "generated";
  content: string | null;
}): FileQueryOpenOptions {
  return {
    kind: "sql",
    encoding: file.encoding ?? undefined,
    fingerprint: file.origin === "disk" ? file.fingerprint : undefined,
    confidence: "literal",
    sourceOnly: file.origin !== "disk",
    originalContent: file.content ?? undefined,
  };
}
function extension(name: string): string {
  return name.split(".").at(-1)?.toLowerCase() ?? "";
}
function fileKind(name: string): FileKind {
  const ext = extension(name);
  return ext === "sql" ? "sql" : CODE_EXTENSIONS.has(ext) ? "source" : "text";
}
function displayPath(path: string): string {
  return path.replace(/^\\\\\?\\UNC\\/, "\\\\").replace(/^\\\\\?\\/, "");
}
function parentPath(path: string): string | undefined {
  const clean = displayPath(path).replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(clean) || clean === "") return undefined;
  if (
    clean.startsWith("\\\\") &&
    clean.split(/\\+/).filter(Boolean).length <= 2
  )
    return undefined;
  const index = Math.max(clean.lastIndexOf("\\"), clean.lastIndexOf("/"));
  return index < 0
    ? undefined
    : index === 2 && clean[1] === ":"
      ? clean.slice(0, 3)
      : clean.slice(0, index) || "/";
}
function sizeLabel(bytes: number): string {
  return bytes < 1024
    ? bytes + " B"
    : bytes < 1024 * 1024
      ? (bytes / 1024).toLocaleString("it-IT", { maximumFractionDigits: 1 }) +
        " KiB"
      : (bytes / 1024 / 1024).toLocaleString("it-IT", {
          maximumFractionDigits: 1,
        }) + " MiB";
}
function sourceLanguage(name: string, fallback: string): string {
  const detected = detectSourceLanguage(name);
  const aliases: Record<string, string> = {
    c: "cpp",
    cs: "csharp",
    tsx: "typescript",
    jsx: "javascript",
    text: "plaintext",
  };
  const candidate = typeof detected === "string" ? detected : fallback,
    language = aliases[candidate] ?? candidate;
  return LANGUAGES.has(language)
    ? language
    : LANGUAGES.has(fallback)
      ? fallback
      : "plaintext";
}
function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
}

export function createGeneratedWorkspaceDocument(
  input: GeneratedFileDraft,
): OpenDocument {
  const name =
    input.name.replaceAll("\\", "/").split("/").at(-1) || "script.ps1";
  if (!name.trim() || /[\u0000-\u001f]/.test(name))
    throw new Error("Nome dello script non valido.");
  const content = input.content.replace(/^\ufeff/, "");
  const bytes = new TextEncoder().encode(content).byteLength + 3;
  if (bytes > MAX_TEXT_BYTES)
    throw new Error("Lo script supera il limite dell’anteprima.");
  return {
    name,
    kind: "source",
    extension: "ps1",
    sizeBytes: bytes,
    encoding: "utf-8-bom",
    content,
    requiresEncoding: false,
    readOnly: false,
    syntaxLanguage: "powershell",
    origin: "generated",
    generatedId: input.id,
    originLabel: input.originLabel || "Catalogo PowerShell",
    warnings: [
      "Bozza dal catalogo: controlla parametri e prerequisiti prima di usarla nel terminale. L’app non esegue lo script.",
    ],
  };
}

export function OpenFilesView({
  initialRecovery,
  onRecoveryChange,
  onRecoveryError,
  onBusyChange,
  initialPath,
  initialDraft,
  onReturnToCatalog,
  openRequestToken,
  folderOpenRequestToken,
  active = true,
  mode = "work",
  dark = true,
  onOpenDatabase,
  onOpenQuery,
  onOpenSourceText,
  onImportScript,
  onNewConnection,
  onDirtyChange,
}: OpenFilesViewProps) {
  const confirm = useConfirmation();
  const [path, setPath] = useState(initialPath ?? ""),
    [document, setDocument] = useState<OpenDocument | null>(
      initialRecovery?.document ?? null,
    ),
    [draft, setDraft] = useState(initialRecovery?.draft ?? ""),
    [editing, setEditing] = useState(initialRecovery?.editing ?? false),
    [readOnlyDatabase, setReadOnlyDatabase] = useState(true);
  const [busy, setBusy] = useState<"inspect" | "save" | "database" | null>(
      null,
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [conflict, setConflict] = useState(false),
    [encoding, setEncoding] = useState(
      initialRecovery?.document.encoding ?? "utf-8",
    ),
    [viewToken, setViewToken] = useState(0);
  const [recents, setRecents] = useState<RecentFile[]>([]),
    [recentError, setRecentError] = useState(""),
    [sideTab, setSideTab] = useState<"recent" | "folder">("recent"),
    [recentSearch, setRecentSearch] = useState("");
  const [folderPath, setFolderPath] = useState(""),
    [directory, setDirectory] = useState<DirectoryListing | null>(null),
    [folderError, setFolderError] = useState(""),
    [folderBusy, setFolderBusy] = useState(false),
    [folderSearch, setFolderSearch] = useState(""),
    [folderFilter, setFolderFilter] = useState("all");
  const [copied, setCopied] = useState(false),
    [operationSearch, setOperationSearch] = useState("");
  const [externalChange, setExternalChange] = useState(false);
  const [shellBusy, setShellBusy] = useState<"directory" | "file" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null),
    sourceEditor = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null),
    browserFile = useRef<File | null>(null),
    inspectSequence = useRef(0),
    initialHandled = useRef(""),
    requestHandled = useRef<number | undefined>(undefined),
    folderRequestHandled = useRef<number | undefined>(undefined);
  const generatedHandled = useRef("");
  const generatedSaveRequested = useRef("");
  const [recovered, setRecovered] = useState(!!initialRecovery);
  const [recoveryError, setRecoveryError] = useState("");
  const dirty = needsFileRecovery(document, draft);
  useEffect(() => {
    onBusyChange?.(!!busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);
  useEffect(() => {
    try {
      onRecoveryChange?.(captureFileRecovery(document, draft, editing));
      setRecoveryError("");
      onRecoveryError?.("");
    } catch (error) {
      setRecoveryError(errorMessage(error));
      onRecoveryError?.(errorMessage(error));
    }
  }, [document, draft, editing, onRecoveryChange, onRecoveryError]);
  const deferredDraft = useDeferredValue(draft);
  const extraction = useMemo(
    () =>
      document?.content !== null &&
      document &&
      !["sqlite", "binary"].includes(document.kind) &&
      document.syntaxLanguage !== "powershell"
        ? extractDatabaseOperations(deferredDraft, document.name, {
            maxCharacters: 1_000_000,
            maxOperations: 200,
          })
        : null,
    [
      deferredDraft,
      document?.name,
      document?.kind,
      document?.content,
      document?.syntaxLanguage,
    ],
  );
  const extractionCurrent = deferredDraft === draft;
  const language = document
    ? sourceLanguage(document.name, document.syntaxLanguage)
    : "plaintext";
  const canEdit =
    !!document &&
    document.content !== null &&
    !document.requiresEncoding &&
    !document.readOnly &&
    !["sqlite", "binary"].includes(document.kind);
  const currentOperations =
    extraction?.operations.filter(
      (operation) =>
        !operationSearch ||
        [operation.label, operation.text, operation.context ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(operationSearch.toLowerCase()),
    ) ?? [];
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const before = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty]);
  useEffect(() => {
    if (copied) {
      const timer = setTimeout(() => setCopied(false), 1600);
      return () => clearTimeout(timer);
    }
  }, [copied]);
  useEffect(() => {
    void loadRecents();
  }, []);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ path?: string; origin?: string }>)
        .detail;
      if (
        !detail?.path ||
        detail.origin === "file-center" ||
        !document?.path ||
        displayPath(detail.path).toLowerCase() !==
          displayPath(document.path).toLowerCase()
      )
        return;
      if (dirty || busy) {
        setExternalChange(true);
        return;
      }
      void openPath(document.path, document.encoding ?? undefined, true);
    };
    window.addEventListener("dbm:workspace-file-saved", changed);
    return () =>
      window.removeEventListener("dbm:workspace-file-saved", changed);
  }, [document?.path, document?.encoding, dirty, busy]);
  useEffect(() => {
    if (
      active &&
      initialPath &&
      initialPath !== initialHandled.current &&
      busy !== "save"
    ) {
      initialHandled.current = initialPath;
      void openPath(initialPath);
    }
  }, [initialPath, active, busy]);
  useEffect(() => {
    if (
      active &&
      openRequestToken &&
      openRequestToken !== requestHandled.current
    ) {
      requestHandled.current = openRequestToken;
      void browse("all");
    }
  }, [openRequestToken, active]);
  useEffect(() => {
    if (
      active &&
      folderOpenRequestToken &&
      folderOpenRequestToken !== folderRequestHandled.current
    ) {
      folderRequestHandled.current = folderOpenRequestToken;
      void chooseFolder();
    }
  }, [active, folderOpenRequestToken]);
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "o"
      ) {
        event.preventDefault();
        if (!folderBusy) void chooseFolder();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!busy) {
          if (event.shiftKey) void saveAs();
          else if (document?.origin === "generated") void saveAs();
          else if (document?.origin === "browser") downloadCopy();
          else void save();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, document, draft, busy, dirty, folderPath, folderBusy]);

  useEffect(() => {
    if (
      !active ||
      !initialDraft ||
      generatedHandled.current === initialDraft.id ||
      busy
    )
      return;
    generatedHandled.current = initialDraft.id;
    void (async () => {
      if (!(await confirmDiscard())) return;
      try {
        browserFile.current = null;
        setPath("");
        acceptDocument(createGeneratedWorkspaceDocument(initialDraft));
        if (initialDraft.autoSaveAs)
          generatedSaveRequested.current = initialDraft.id;
      } catch (error) {
        setError(errorMessage(error));
      }
    })();
  }, [active, initialDraft, busy]);
  useEffect(() => {
    if (
      active &&
      document?.generatedId &&
      generatedSaveRequested.current === document.generatedId &&
      !busy
    ) {
      generatedSaveRequested.current = "";
      void saveAs();
    }
  }, [active, document?.generatedId, busy]);
  async function confirmDiscard(): Promise<boolean> {
    return (
      !dirty ||
      (await confirm(
        "Ci sono modifiche al file non salvate. Scartarle e aprire o ricaricare un file?",
      ))
    );
  }
  function acceptDocument(file: OpenDocument) {
    setRecovered(false);
    setDocument(file);
    setDraft(file.content ?? "");
    setEditing(false);
    setReadOnlyDatabase(true);
    setEncoding(file.encoding ?? "utf-8");
    setError("");
    setNotice("");
    setConflict(false);
    setExternalChange(false);
    setOperationSearch("");
    setViewToken((old) => old + 1);
  }
  async function loadRecents() {
    try {
      setRecents(await api<RecentFile[]>("recent_workspace_files"));
      setRecentError("");
    } catch (error) {
      setRecentError(errorMessage(error));
    }
  }
  async function openPath(
    value: string,
    chosenEncoding?: string,
    discardChecked = false,
  ) {
    const target = value.trim().replace(/^"([\s\S]*)"$/, "$1");
    if (
      !target ||
      busy === "save" ||
      (!discardChecked && !(await confirmDiscard()))
    )
      return;
    const sequence = ++inspectSequence.current;
    setBusy("inspect");
    setError("");
    setNotice("");
    try {
      const file = await api<WorkspaceFile>("inspect_workspace_file", {
        path: target,
        ...(chosenEncoding ? { encoding: chosenEncoding } : {}),
      });
      if (sequence !== inspectSequence.current) return;
      browserFile.current = null;
      setPath(file.path);
      const sameDocument =
        document?.path &&
        displayPath(document.path).toLowerCase() ===
          displayPath(file.path).toLowerCase();
      acceptDocument({
        ...file,
        origin: "disk",
        ...(sameDocument
          ? {
              generatedId: document.generatedId,
              originLabel: document.originLabel,
            }
          : {}),
      });
      void loadRecents();
    } catch (error) {
      if (sequence === inspectSequence.current) setError(errorMessage(error));
    } finally {
      if (sequence === inspectSequence.current) setBusy(null);
    }
  }
  async function openBrowserFile(
    file: File,
    chosenEncoding?: string,
    discardChecked = false,
  ) {
    if (busy === "save" || (!discardChecked && !(await confirmDiscard())))
      return;
    const sequence = ++inspectSequence.current;
    setBusy("inspect");
    setError("");
    try {
      const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      const base = {
        name: file.name,
        extension: extension(file.name),
        sizeBytes: file.size,
        readOnly: false,
        syntaxLanguage: sourceLanguage(file.name, "plaintext"),
        origin: "browser" as const,
      };
      if (hasSqliteHeader(header)) {
        if (sequence !== inspectSequence.current) return;
        browserFile.current = file;
        setPath("");
        acceptDocument({
          ...base,
          kind: "sqlite",
          encoding: null,
          content: null,
          requiresEncoding: false,
          headerOnly: true,
          warnings: [
            "Firma SQLite rilevata. Il browser non rende disponibile il percorso nativo: incollalo nel campo Percorso per validare il database e collegarlo. Nessuna copia o nuovo database è stato creato.",
          ],
        });
        return;
      }
      if (file.size > MAX_TEXT_BYTES)
        throw new Error(
          "Il file supera 8 MiB: l'anteprima testuale è limitata. Usa il percorso nativo per un database SQLite o gli strumenti di importazione per script grandi.",
        );
      const bytes = new Uint8Array(await file.arrayBuffer()),
        decoded = decodeBrowserBytes(bytes, chosenEncoding);
      if (sequence !== inspectSequence.current) return;
      browserFile.current = file;
      setPath("");
      acceptDocument({
        ...base,
        ...decoded,
        kind: fileKind(file.name),
        warnings: [
          ...decoded.warnings,
          "Anteprima del file selezionato nel browser: il percorso sul disco non è disponibile. Puoi aprire una bozza o scaricare una copia UTF-8, senza sovrascrivere l'originale.",
        ],
      });
    } catch (error) {
      if (sequence === inspectSequence.current) setError(errorMessage(error));
    } finally {
      if (sequence === inspectSequence.current) setBusy(null);
    }
  }
  async function browse(kind: "all" | "sqlite" | "sql" | "source") {
    if (busy === "save" || busy === "database") {
      setNotice(
        "Attendi il completamento dell'operazione prima di scegliere un altro file.",
      );
      return;
    }
    setError("");
    if (!isTauri()) {
      if (inputRef.current) {
        inputRef.current.accept =
          kind === "sqlite"
            ? ".db,.sqlite,.sqlite3,.db3"
            : kind === "sql"
              ? ".sql"
              : kind === "source"
                ? ".rs,.py,.js,.jsx,.ts,.tsx,.php,.java,.cs,.c,.cpp,.h,.hpp,.go,.kt,.rb,.json,.txt"
                : "";
        inputRef.current.click();
      }
      return;
    }
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const selected = await dialog.open({
        multiple: false,
        directory: false,
        defaultPath: path || undefined,
        filters:
          kind === "sqlite"
            ? [
                {
                  name: "Database SQLite",
                  extensions: ["db", "sqlite", "sqlite3", "db3"],
                },
                { name: "Tutti i file", extensions: ["*"] },
              ]
            : kind === "sql"
              ? [{ name: "Script SQL", extensions: ["sql"] }]
              : kind === "source"
                ? [
                    {
                      name: "Codice e testo",
                      extensions: [
                        "rs",
                        "py",
                        "js",
                        "jsx",
                        "ts",
                        "tsx",
                        "php",
                        "java",
                        "cs",
                        "c",
                        "cpp",
                        "h",
                        "hpp",
                        "go",
                        "kt",
                        "rb",
                        "json",
                        "txt",
                      ],
                    },
                  ]
                : undefined,
      });
      if (typeof selected === "string") await openPath(selected);
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  async function chooseFolder() {
    setSideTab("folder");
    setFolderError("");
    if (!isTauri()) {
      setFolderError(
        "Il selettore grafico di cartella è disponibile nell'app desktop Windows. Nel browser incolla il percorso reale: puoi elencare i file o aprire Esplora risorse tramite il backend locale.",
      );
      return;
    }
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const selected = await dialog.open({
        directory: true,
        multiple: false,
        defaultPath: folderPath || undefined,
      });
      if (typeof selected === "string") {
        setFolderPath(selected);
        await loadDirectory(selected);
      }
    } catch (error) {
      setFolderError(errorMessage(error));
    }
  }
  async function openFolderInExplorer() {
    const selected = (folderPath || directory?.path || "")
      .trim()
      .replace(/^"([\s\S]*)"$/, "$1");
    if (!selected || shellBusy) return;
    setShellBusy("directory");
    setFolderError("");
    try {
      await api("open_workspace_directory", { path: selected });
      setNotice(
        "Richiesta di apertura della cartella inviata a Esplora risorse.",
      );
    } catch (error) {
      setFolderError(errorMessage(error));
    } finally {
      setShellBusy(null);
    }
  }
  async function revealFileInExplorer() {
    if (!document?.path || document.origin !== "disk" || shellBusy) return;
    setShellBusy("file");
    setError("");
    try {
      await api("reveal_workspace_file", { path: document.path });
      setNotice(
        "Richiesta a Esplora risorse di mostrare il file nella sua cartella.",
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setShellBusy(null);
    }
  }
  async function loadDirectory(value = folderPath, offset = 0) {
    if (!value.trim() || folderBusy) return;
    setFolderBusy(true);
    setFolderError("");
    try {
      const next = await api<DirectoryListing>("list_workspace_directory", {
        path: value.trim(),
        offset,
      });
      setDirectory((old) =>
        offset > 0 && old?.path === next.path
          ? {
              ...next,
              entries: [
                ...old.entries,
                ...next.entries.filter(
                  (entry) =>
                    !old.entries.some((prior) => prior.path === entry.path),
                ),
              ],
            }
          : next,
      );
      setFolderPath(next.path);
      if (offset === 0) setFolderSearch("");
    } catch (error) {
      setFolderError(errorMessage(error));
    } finally {
      setFolderBusy(false);
    }
  }
  async function reload() {
    if (!document || !(await confirmDiscard())) return;
    if (document.origin === "generated") {
      acceptDocument({ ...document });
      return;
    }
    if (document.origin === "disk" && document.path)
      await openPath(document.path, document.encoding ?? undefined, true);
    else if (browserFile.current)
      await openBrowserFile(
        browserFile.current,
        document.encoding ?? undefined,
        true,
      );
    else
      setNotice(
        "Per rileggere il file del browser recuperato, sceglilo nuovamente con Scegli file. La bozza resta conservata.",
      );
  }
  async function selectEncoding(chosen: string) {
    if (!document || !(await confirmDiscard())) return;
    if (document.origin === "disk" && document.path)
      await openPath(document.path, chosen, true);
    else if (browserFile.current)
      await openBrowserFile(browserFile.current, chosen, true);
  }
  async function save() {
    if (!document || !dirty || !canEdit || busy) return;
    if (
      document.origin !== "disk" ||
      !document.path ||
      !document.fingerprint ||
      !document.encoding
    ) {
      setError(
        "Per salvare sull'originale serve un percorso nativo e una codifica nota. Usa Scarica copia UTF-8 per il file del browser.",
      );
      return;
    }
    setBusy("save");
    setError("");
    setConflict(false);
    try {
      const next = await api<WorkspaceFile>("save_workspace_text", {
        path: document.path,
        content: draft,
        encoding: document.encoding,
        expectedFingerprint: document.fingerprint,
      });
      setDocument({
        ...next,
        origin: "disk",
        generatedId: document.generatedId,
        originLabel: document.originLabel,
      });
      setDraft(next.content ?? draft);
      setNotice("File salvato. Il contenuto non è stato eseguito.");
      setExternalChange(false);
      window.dispatchEvent(
        new CustomEvent("dbm:workspace-file-saved", {
          detail: { path: next.path, origin: "file-center" },
        }),
      );
      void loadRecents();
    } catch (error) {
      const message = errorMessage(error);
      setError(message);
      setConflict(
        /fingerprint|conflitt|cambiat|modificat.*(?:disco|estern)/i.test(
          message,
        ),
      );
    } finally {
      setBusy(null);
    }
  }
  function downloadCopy() {
    if (!document || document.content === null) return;
    const content =
      document.syntaxLanguage === "powershell"
        ? "\ufeff" + draft.replace(/^\ufeff/, "")
        : draft;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob),
      anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = document.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice(
      "Richiesto il download di una copia UTF-8. Il file originale non è stato modificato.",
    );
  }
  async function saveAs() {
    if (
      !document ||
      document.content === null ||
      document.requiresEncoding ||
      busy
    )
      return;
    if (!isTauri()) {
      downloadCopy();
      return;
    }
    setError("");
    try {
      const dialog = await import("@tauri-apps/plugin-dialog");
      const dot = document.name.lastIndexOf(".");
      const copyName =
        document.origin === "generated"
          ? document.name
          : dot > 0
            ? document.name.slice(0, dot) + "-copia" + document.name.slice(dot)
            : document.name + "-copia.txt";
      const folder =
        document.path?.slice(
          0,
          Math.max(
            document.path.lastIndexOf("\\"),
            document.path.lastIndexOf("/"),
          ) + 1,
        ) ?? "";
      const selected = await dialog.save({ defaultPath: folder + copyName });
      if (!selected) return;
      setBusy("save");
      const saved = await api<WorkspaceFile>("save_workspace_text", {
        path: selected,
        content: draft,
        encoding: document.encoding ?? "utf-8",
        expectedFingerprint: null,
      });
      browserFile.current = null;
      setPath(saved.path);
      acceptDocument({
        ...saved,
        origin: "disk",
        generatedId: document.generatedId,
        originLabel: document.originLabel,
      });
      setNotice(
        "Copia salvata in un nuovo file. Nessun file esistente è stato sovrascritto.",
      );
      void loadRecents();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  async function openDatabase() {
    if (
      !document?.path ||
      !document.sqlite?.valid ||
      document.origin !== "disk" ||
      busy
    )
      return;
    setBusy("database");
    setError("");
    try {
      const opened = await api<OpenedFileDatabase>("open_existing_sqlite", {
        path: document.path,
        readOnly: readOnlyDatabase,
        profileName:
          document.name.slice(0, 90) +
          " · " +
          (readOnlyDatabase ? "sola lettura" : "modificabile"),
      });
      await onOpenDatabase(opened);
      void loadRecents();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  function openSql() {
    if (!document || document.content === null || !draft.trim()) return;
    onOpenQuery(
      draft,
      document.name,
      document.path,
      wholeSqlOpenOptions(document),
    );
  }
  function openExtracted(operation: ExtractedDatabaseOperation) {
    if (!document || !extractionCurrent) return;
    onOpenQuery(
      operation.text,
      document.name + ":" + operation.startLine + " · " + operation.label,
      document.path,
      extractedOpenOptions(operation),
    );
  }
  function reveal(operation: ExtractedDatabaseOperation) {
    const editor = sourceEditor.current,
      model = editor?.getModel();
    if (!editor || !model) return;
    const first = Math.max(
        1,
        Math.min(model.getLineCount(), operation.startLine),
      ),
      last = Math.max(first, Math.min(model.getLineCount(), operation.endLine));
    editor.revealLineInCenter(first);
    editor.setSelection({
      startLineNumber: first,
      startColumn: 1,
      endLineNumber: last,
      endColumn: model.getLineMaxColumn(last),
    });
    editor.focus();
  }
  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError(
        "Appunti non disponibili: seleziona il testo nell'anteprima e usa Ctrl+C.",
      );
    }
  }
  async function removeRecent(file: RecentFile) {
    try {
      await api("remove_workspace_recent", { path: file.path });
      setRecents((old) => old.filter((item) => item.path !== file.path));
    } catch (error) {
      setRecentError(errorMessage(error));
    }
  }
  const folderEntries =
    directory?.entries.filter(
      (entry) =>
        (!folderSearch ||
          entry.name.toLowerCase().includes(folderSearch.toLowerCase())) &&
        (entry.kind === "directory" ||
          folderFilter === "all" ||
          (folderFilter === "sqlite" &&
            ["db", "sqlite", "sqlite3", "db3"].includes(
              entry.extension.replace(/^\./, ""),
            )) ||
          (folderFilter === "sql" &&
            entry.extension.replace(/^\./, "") === "sql") ||
          (folderFilter === "source" &&
            CODE_EXTENSIONS.has(entry.extension.replace(/^\./, "")))),
    ) ?? [];

  const compactPreview = document?.originLabel === "Catalogo PowerShell";
  const revealAction = document && (
    <Button
      variant="ghost"
      disabled={!document.path || document.origin !== "disk" || !!shellBusy}
      busy={shellBusy === "file"}
      onClick={() => void revealFileInExplorer()}
      title={
        document.path
          ? "Mostra il file selezionato in Esplora risorse"
          : document.origin === "generated"
            ? "Salva lo script per mostrarlo nella cartella"
            : "Il file del browser non fornisce un percorso nativo"
      }
    >
      <FolderOpen size={14} />
      Mostra file nella cartella
    </Button>
  );

  return (
    <div
      className={`view-content fw-workspace ${document ? "fw-has-document" : ""} ${compactPreview ? "fw-catalog-preview" : ""}`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes("Files")) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        if (isTauri()) return;
        const files = event.dataTransfer.files;
        void openBrowserFile(files[0]);
        if (files.length > 1)
          setNotice(
            "L'anteprima web apre un file per volta; seleziona gli altri separatamente.",
          );
      }}
    >
      {!compactPreview && (
        <SectionHeader
          eyebrow="UN PUNTO DI INGRESSO PER I TUOI FILE"
          title="Apri file e database"
          description="Collega un SQLite esistente, leggi e salva uno script oppure trova le istruzioni database nel codice. L'apertura non esegue file."
          action={
            onNewConnection ? (
              <Button onClick={onNewConnection}>
                <Database size={15} />
                Connessione a un server
              </Button>
            ) : undefined
          }
        />
      )}
      {recovered && (
        <Notice tone="success">
          Bozza del centro file recuperata. Controlla il testo prima di
          salvarlo; il file originale non è stato modificato.
        </Notice>
      )}
      {recoveryError && <Notice tone="error">{recoveryError}</Notice>}
      <input
        ref={inputRef}
        type="file"
        className="fw-hidden-input"
        aria-label="Seleziona un file dal browser"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openBrowserFile(file);
          event.target.value = "";
        }}
      />
      {!compactPreview && (
        <section className="panel fw-path-bar">
          <Field label="Percorso reale del file o database">
            <PathInput
              value={path}
              onChange={setPath}
              placeholder="Incolla il percorso o usa Scegli file"
            />
          </Field>
          <Button
            variant="primary"
            disabled={!path.trim() || !!busy}
            busy={busy === "inspect"}
            onClick={() => void openPath(path)}
          >
            <FolderOpen size={15} />
            Apri percorso
          </Button>
          <Button disabled={!!busy} onClick={() => void browse("all")}>
            <Upload size={15} />
            Scegli file <kbd>Ctrl O</kbd>
          </Button>
        </section>
      )}
      {!compactPreview &&
        onImportScript &&
        /\.sql\s*$/i.test(path) &&
        (!document?.path ||
          displayPath(document.path).toLowerCase() !==
            displayPath(path.trim()).toLowerCase()) && (
          <div className="fw-large-import">
            <p>
              Un dump può essere troppo grande o contenere direttive del client:
              puoi passare al percorso di importazione con anteprima e conferma.
            </p>
            <Button
              disabled={dirty || !!busy}
              onClick={() => onImportScript(path.trim())}
            >
              Importazione guidata nel database
            </Button>
          </div>
        )}
      {!compactPreview && (
        <div className="fw-entry-cards">
          <button onClick={() => void browse("sqlite")} disabled={!!busy}>
            <Database size={21} />
            <span>
              <strong>Database SQLite</strong>
              <small>.db · .sqlite · .sqlite3 · firma verificata</small>
            </span>
          </button>
          <button onClick={() => void browse("sql")} disabled={!!busy}>
            <FileText size={21} />
            <span>
              <strong>Script SQL</strong>
              <small>Anteprima, modifica e salvataggio controllato</small>
            </span>
          </button>
          <button onClick={() => void browse("source")} disabled={!!busy}>
            <FileCode2 size={21} />
            <span>
              <strong>Codice con query</strong>
              <small>Estrazione statica con righe e avvisi</small>
            </span>
          </button>
          <button onClick={() => void chooseFolder()} disabled={folderBusy}>
            <Folder size={21} />
            <span>
              <strong>
                {isTauri() ? "Scegli cartella…" : "Cartella di lavoro"}
              </strong>
              <small>
                {isTauri()
                  ? "Selettore grafico Windows · Ctrl ⇧ O"
                  : "Percorso reale, elenco ed Esplora risorse"}
              </small>
            </span>
          </button>
        </div>
      )}
      {error && (
        <Notice tone="error">
          {error}
          {conflict && (
            <p className="fw-conflict-help">
              La bozza è stata conservata. Il salvataggio non forza la
              sovrascrittura: copia la bozza prima di ricaricare il contenuto
              esterno.
            </p>
          )}
        </Notice>
      )}
      {notice && <Notice tone="success">{notice}</Notice>}
      {externalChange && (
        <Notice tone="warning">
          Il file su disco è stato aggiornato da un'altra scheda. La bozza qui è
          conservata: copiala prima di ricaricare; il salvataggio continua a
          verificare la fingerprint originale.
        </Notice>
      )}
      <div className="fw-layout">
        {!compactPreview && (
          <aside className="panel fw-files-sidebar">
            <div
              className="fw-side-tabs"
              role="tablist"
              aria-label="Origine dei file"
            >
              <button
                role="tab"
                aria-selected={sideTab === "recent"}
                className={sideTab === "recent" ? "active" : ""}
                onClick={() => setSideTab("recent")}
              >
                <Clock3 size={14} />
                Recenti
              </button>
              <button
                role="tab"
                aria-selected={sideTab === "folder"}
                className={sideTab === "folder" ? "active" : ""}
                onClick={() => setSideTab("folder")}
              >
                <Folder size={14} />
                Cartella
              </button>
            </div>
            {sideTab === "recent" ? (
              <>
                <label className="fw-search">
                  <Search size={14} />
                  <input
                    value={recentSearch}
                    onChange={(event) => setRecentSearch(event.target.value)}
                    placeholder="Cerca nei file recenti"
                    aria-label="Cerca nei file recenti"
                  />
                </label>
                {recentError && (
                  <p className="fw-inline-error">{recentError}</p>
                )}
                <div className="fw-file-list">
                  {recents
                    .filter((file) =>
                      [file.name, file.path]
                        .join(" ")
                        .toLowerCase()
                        .includes(recentSearch.toLowerCase()),
                    )
                    .map((file) => (
                      <div
                        key={file.path}
                        className={
                          document?.path === file.path ? "selected" : ""
                        }
                      >
                        <button
                          className="fw-file-item"
                          onClick={() =>
                            void openPath(file.path, file.encoding)
                          }
                          disabled={!!busy}
                        >
                          {file.kind === "sqlite" ? (
                            <Database size={16} />
                          ) : file.kind === "sql" ? (
                            <FileText size={16} />
                          ) : (
                            <FileCode2 size={16} />
                          )}
                          <span>
                            <strong>{file.name}</strong>
                            <small title={displayPath(file.path)}>
                              {displayPath(file.path)}
                            </small>
                            <em>{dateLabel(file.openedAt)}</em>
                          </span>
                        </button>
                        <button
                          className="fw-remove-recent"
                          title="Rimuovi dall'elenco, senza cancellare il file"
                          aria-label={"Rimuovi recente " + file.name}
                          onClick={() => void removeRecent(file)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                </div>
                {!recents.length && (
                  <p className="fw-empty-small">
                    I file aperti dal loro percorso reale compariranno qui.
                  </p>
                )}
                <Button variant="ghost" onClick={() => void loadRecents()}>
                  <RotateCcw size={13} />
                  Aggiorna recenti
                </Button>
              </>
            ) : (
              <>
                <div className="fw-folder-location">
                  <Field label="Percorso della cartella">
                    <PathInput
                      kind="directory"
                      value={folderPath}
                      onChange={setFolderPath}
                      placeholder="Percorso reale della cartella"
                    />
                  </Field>
                  <Button
                    className="fw-choose-folder"
                    disabled={!isTauri() || folderBusy}
                    onClick={() => void chooseFolder()}
                    title={
                      isTauri()
                        ? "Apri il selettore grafico delle cartelle Windows (Ctrl+Maiusc+O)"
                        : "Selettore disponibile nell'app desktop Windows; nel browser usa un percorso reale"
                    }
                  >
                    <FolderOpen size={14} />
                    Scegli cartella…
                  </Button>
                </div>
                {!isTauri() && (
                  <p className="fw-browser-folder-note">
                    Selettore grafico disponibile nell'app desktop. Nel browser
                    inserisci un percorso reale: i pulsanti Elenca e Apri in
                    Esplora risorse usano il backend locale.
                  </p>
                )}
                <div className="fw-folder-actions">
                  <Button
                    variant="primary"
                    disabled={
                      !(folderPath || directory?.path)?.trim() || !!shellBusy
                    }
                    busy={shellBusy === "directory"}
                    onClick={() => void openFolderInExplorer()}
                  >
                    <FolderOpen size={14} />
                    Apri in Esplora risorse
                  </Button>
                  <Button
                    disabled={!folderPath.trim() || folderBusy}
                    busy={folderBusy}
                    onClick={() => void loadDirectory()}
                  >
                    <FolderOpen size={13} />
                    Elenca
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={
                      !directory || !parentPath(directory.path) || folderBusy
                    }
                    onClick={() =>
                      void loadDirectory(parentPath(directory!.path)!)
                    }
                    title="Cartella superiore"
                  >
                    <ArrowUp size={13} />
                  </Button>
                </div>
                <label className="fw-search">
                  <Search size={13} />
                  <input
                    value={folderSearch}
                    onChange={(event) => setFolderSearch(event.target.value)}
                    placeholder="Cerca nei file caricati"
                    aria-label="Cerca nella cartella"
                  />
                </label>
                <select
                  aria-label="Tipo di file nella cartella"
                  value={folderFilter}
                  onChange={(event) => setFolderFilter(event.target.value)}
                >
                  <option value="all">Tutti i tipi</option>
                  <option value="sqlite">Estensioni SQLite</option>
                  <option value="sql">Script SQL</option>
                  <option value="source">Codice e JSON</option>
                </select>
                {folderError && (
                  <p className="fw-inline-error">{folderError}</p>
                )}
                {directory && (
                  <p
                    className="fw-small-path"
                    title={displayPath(directory.path)}
                  >
                    {displayPath(directory.path)}
                  </p>
                )}
                <div className="fw-file-list">
                  {folderEntries.map((entry) => (
                    <div
                      key={entry.path}
                      className={
                        document?.path === entry.path ? "selected" : ""
                      }
                    >
                      <button
                        className="fw-file-item"
                        disabled={
                          entry.kind === "directory" ? folderBusy : !!busy
                        }
                        onClick={() =>
                          entry.kind === "directory"
                            ? void loadDirectory(entry.path)
                            : void openPath(entry.path)
                        }
                      >
                        {entry.kind === "directory" ? (
                          <Folder size={15} />
                        ) : entry.extension === "sql" ? (
                          <FileText size={15} />
                        ) : (
                          <FileCode2 size={15} />
                        )}
                        <span>
                          <strong>{entry.name}</strong>
                          <small>
                            {entry.kind === "directory"
                              ? "Cartella"
                              : sizeLabel(entry.sizeBytes)}
                          </small>
                        </span>
                        {entry.kind === "directory" && <ArrowRight size={12} />}
                      </button>
                    </div>
                  ))}
                </div>
                {directory && !folderEntries.length && (
                  <p className="fw-empty-small">
                    Nessun elemento corrispondente nei file caricati.
                  </p>
                )}
                {directory?.nextOffset != null && (
                  <Button
                    disabled={folderBusy}
                    onClick={() =>
                      void loadDirectory(directory.path, directory.nextOffset!)
                    }
                  >
                    Carica altri elementi
                  </Button>
                )}
                {directory?.truncated && (
                  <p className="fw-help">
                    Elenco paginato. La ricerca riguarda gli elementi caricati,
                    non scandisce ricorsivamente le cartelle.
                  </p>
                )}
              </>
            )}
          </aside>
        )}
        <section className="panel fw-document">
          {!document ? (
            <div className="fw-welcome">
              <FolderOpen size={39} />
              <h2>Apri ciò che hai già</h2>
              <p>
                Puoi scegliere un database, uno script o un file di programma.
                Controlliamo il contenuto prima di proporre le azioni.
              </p>
              <div>
                <span>
                  <ShieldCheck size={15} />
                  SQLite in sola lettura per impostazione iniziale
                </span>
                <span>
                  <Code2 size={15} />
                  SQL e sorgenti non vengono eseguiti
                </span>
                <span>
                  <FileText size={15} />
                  Salvataggio con controllo delle modifiche esterne
                </span>
              </div>
            </div>
          ) : (
            <>
              <header className="fw-document-header">
                <div>
                  <span className="fw-kind">
                    {document.syntaxLanguage === "powershell"
                      ? "Script PowerShell"
                      : KINDS[document.kind]}
                    {document.origin === "browser" ? " · browser" : ""}
                  </span>
                  <h2>
                    {document.name}
                    {dirty && (
                      <em>
                        {document.origin === "generated"
                          ? "non salvato"
                          : "modificato"}
                      </em>
                    )}
                  </h2>
                  <p
                    title={
                      document.path ? displayPath(document.path) : undefined
                    }
                  >
                    {document.path
                      ? displayPath(document.path)
                      : document.origin === "generated"
                        ? "Bozza dal catalogo · nessun file viene eseguito"
                        : "Anteprima in memoria · percorso nativo non disponibile"}
                  </p>
                </div>
                <div className="fw-document-meta">
                  <span>{sizeLabel(document.sizeBytes)}</span>
                  {document.encoding && <span>{document.encoding}</span>}
                  {document.fingerprint && (
                    <code title="Fingerprint del contenuto letto">
                      {document.fingerprint.slice(0, 12)}…
                    </code>
                  )}
                </div>
                {compactPreview && onReturnToCatalog && (
                  <Button
                    className="fw-catalog-back"
                    onClick={onReturnToCatalog}
                    title="Torna al Catalogo PowerShell"
                  >
                    <ArrowLeft size={14} />
                    Torna al catalogo
                  </Button>
                )}
              </header>
              {!compactPreview && document.originLabel && onReturnToCatalog && (
                <div className="row">
                  <Button onClick={onReturnToCatalog}>
                    <ArrowLeft size={13} />
                    Torna al Catalogo PowerShell
                  </Button>
                </div>
              )}
              {!compactPreview && (
                <div className="fw-reveal-action">{revealAction}</div>
              )}
              {document.warnings.map((warning, index) => (
                <Notice key={index} tone="warning">
                  {warning}
                </Notice>
              ))}
              {document.kind === "sqlite" ? (
                <div className="fw-sqlite-view">
                  <div className="fw-database-summary">
                    <ShieldCheck size={27} />
                    <div>
                      <h3>
                        {document.sqlite?.valid
                          ? "Database SQLite verificato sul percorso esistente"
                          : "Firma SQLite riconosciuta"}
                      </h3>
                      <p>
                        {document.sqlite?.valid
                          ? document.sqlite.tableCount +
                            " tabelle · " +
                            document.sqlite.viewCount +
                            " viste · user_version " +
                            document.sqlite.userVersion
                          : "Per leggere metadati e collegare il database serve il percorso reale."}
                      </p>
                    </div>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={readOnlyDatabase}
                      disabled={!!busy}
                      onChange={(event) =>
                        setReadOnlyDatabase(event.target.checked)
                      }
                    />
                    Apri in sola lettura
                  </label>
                  <p className="fw-help">
                    {readOnlyDatabase
                      ? "La connessione permette di leggere e interrogare il database senza preparare modifiche ai dati."
                      : "Connessione modificabile: gli aggiornamenti richiederanno comunque le azioni esplicite della griglia o dell'editor."}
                  </p>
                  <Button
                    variant="primary"
                    busy={busy === "database"}
                    disabled={
                      !document.path || !document.sqlite?.valid || !!busy
                    }
                    onClick={() => void openDatabase()}
                  >
                    <Database size={16} />
                    {readOnlyDatabase
                      ? "Apri database in sola lettura"
                      : "Apri database modificabile"}
                  </Button>
                  {document.sqlite?.valid && (
                    <div className="fw-database-tables">
                      {document.sqlite.tables.slice(0, 80).map((table) => (
                        <span key={table.name}>
                          <Database size={12} />
                          {table.name}
                          <small>{table.kind}</small>
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="fw-help">
                    I file di dati di MySQL, MariaDB, PostgreSQL o altri motori
                    non sono SQLite: usa Connessione a un server per quei
                    database.
                  </p>
                </div>
              ) : (
                <>
                  {document.kind === "sql" &&
                    document.path &&
                    onImportScript && (
                      <div className="fw-import-actions">
                        <Button
                          disabled={draft !== document.content || !!busy}
                          title={
                            dirty
                              ? "Salva prima la bozza: l'importazione legge il file sul disco"
                              : "Apre l'importazione con anteprima e conferma"
                          }
                          onClick={() => onImportScript(document.path!)}
                        >
                          <Database size={14} />
                          Importazione guidata nel database
                        </Button>
                        <p className="fw-help">
                          Per dump con direttive del client usa l'importazione
                          guidata. L'apertura del file non cambia il database.
                        </p>
                      </div>
                    )}
                  {(document.requiresEncoding || document.content !== null) && (
                    <div className="fw-text-toolbar">
                      <Field
                        label={
                          document.requiresEncoding
                            ? "Scegli la codifica per leggere il testo"
                            : "Codifica del file"
                        }
                      >
                        <select
                          value={encoding}
                          disabled={!!busy || document.origin === "generated"}
                          onChange={(event) =>
                            void selectEncoding(event.target.value)
                          }
                        >
                          {ENCODINGS.map(([value, label]) => (
                            <option key={value} value={value}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <div className="fw-text-actions">
                        <Button disabled={!!busy} onClick={() => void reload()}>
                          <RotateCcw size={14} />
                          {document.origin === "generated"
                            ? "Ripristina modello"
                            : document.origin === "browser"
                              ? "Rileggi selezione"
                              : "Ricarica"}
                        </Button>
                        {document.content !== null && (
                          <>
                            <Button
                              disabled={!canEdit || !!busy}
                              onClick={() => setEditing((old) => !old)}
                            >
                              {editing ? "Blocca modifica" : "Modifica testo"}
                            </Button>
                            {document.origin === "disk" ? (
                              <Button
                                busy={busy === "save"}
                                disabled={!dirty || !canEdit || !!busy}
                                onClick={() => void save()}
                              >
                                <Save size={14} />
                                Salva <kbd>Ctrl S</kbd>
                              </Button>
                            ) : document.origin !== "generated" ||
                              !isTauri() ? (
                              <Button onClick={downloadCopy}>
                                <Download size={14} />
                                Copia UTF-8
                              </Button>
                            ) : null}
                            <Button
                              variant={compactPreview ? "primary" : "secondary"}
                              disabled={!!busy}
                              onClick={() => void saveAs()}
                            >
                              <Save size={14} />
                              {document.origin === "generated"
                                ? "Salva script .ps1…"
                                : document.origin === "disk"
                                  ? "Salva come…"
                                  : "Salva copia UTF-8"}
                              <kbd>Ctrl ⇧ S</kbd>
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                  {document.content !== null ? (
                    <>
                      <div className="fw-preview-caption">
                        <span>
                          {editing
                            ? "Modifica testuale abilitata"
                            : "Anteprima in sola lettura"}
                        </span>
                        <span>
                          {dirty
                            ? "Bozza non salvata"
                            : "Nessuna modifica da salvare"}
                        </span>
                      </div>
                      <div className="fw-monaco">
                        <Editor
                          key={viewToken}
                          path={
                            "inmemory://file-center/" +
                            viewToken +
                            "/" +
                            encodeURIComponent(document.path ?? document.name)
                          }
                          value={draft}
                          language={language}
                          theme={dark ? "vs-dark" : "light"}
                          onChange={(value) => setDraft(value ?? "")}
                          onMount={(editor) => {
                            sourceEditor.current = editor;
                          }}
                          keepCurrentModel={false}
                          options={{
                            readOnly: !editing || !canEdit || !!busy,
                            fontSize: 13,
                            fontFamily: '"Cascadia Code", Consolas, monospace',
                            minimap: { enabled: false },
                            wordWrap: "off",
                            automaticLayout: true,
                            scrollBeyondLastLine: false,
                            padding: { top: 12, bottom: 12 },
                          }}
                        />
                      </div>
                      <div className="fw-open-text-actions">
                        {document.kind === "sql" && (
                          <Button
                            variant="primary"
                            onClick={openSql}
                            disabled={!draft.trim() || !!busy}
                          >
                            <Code2 size={14} />
                            Apri script nell'editor query
                          </Button>
                        )}
                        {onOpenSourceText && document.kind === "source" && (
                          <Button
                            onClick={() =>
                              onOpenSourceText(draft, language, document.path)
                            }
                          >
                            <FileCode2 size={14} />
                            Apri sorgente
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          onClick={() => void copyText(draft)}
                        >
                          {copied ? <Check size={14} /> : <Copy size={14} />}
                          Copia testo
                        </Button>
                        {compactPreview && revealAction}
                        <span className="fw-help">
                          Nessun testo viene eseguito da questa anteprima.
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="fw-unreadable">
                      <FileText size={28} />
                      <h3>
                        {document.requiresEncoding
                          ? "La codifica deve essere scelta esplicitamente"
                          : "Nessuna anteprima testuale disponibile"}
                      </h3>
                      <p>
                        {document.requiresEncoding
                          ? "Seleziona la codifica corretta sopra: il contenuto non viene corretto sostituendo byte sconosciuti."
                          : "Questo file è binario o non è un formato supportato per l'editor. Non viene aperto come database senza una firma SQLite valida."}
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </section>
      </div>
      {document &&
        document.content !== null &&
        document.kind !== "sql" &&
        extraction && (
          <section className="panel fw-extraction">
            <div className="fw-extraction-heading">
              <div>
                <span className="fw-kind">LETTURA STATICA DEL SORGENTE</span>
                <h2>
                  Istruzioni database trovate{" "}
                  <span>{extraction.operations.length}</span>
                </h2>
                <p>
                  Provenienza: {document.name}
                  {dirty ? " · bozza non salvata" : ""}. Il programma non viene
                  eseguito e i valori dinamici non vengono inventati.
                </p>
              </div>
              <label className="fw-search">
                <Search size={14} />
                <input
                  aria-label="Cerca nelle query estratte"
                  value={operationSearch}
                  onChange={(event) => setOperationSearch(event.target.value)}
                  placeholder="Cerca istruzione o testo SQL"
                />
              </label>
            </div>
            {!extractionCurrent && (
              <Notice>Analisi della bozza in aggiornamento…</Notice>
            )}
            {extraction.warnings.map((warning, index) => (
              <Notice key={index} tone="warning">
                {warning}
              </Notice>
            ))}
            {extraction.truncated && (
              <Notice tone="warning">
                Analisi limitata per dimensione o numero di istruzioni. Il resto
                del file non è dichiarato verificato.
              </Notice>
            )}
            {!extraction.operations.length ? (
              <div className="fw-empty-extraction">
                <FileCode2 size={25} />
                <p>
                  Nessuna istruzione statica riconosciuta. Una query può essere
                  costruita a runtime, nascosta in un ORM o dipendere da altri
                  file: l'assenza qui non dimostra che il programma non usi un
                  database.
                </p>
              </div>
            ) : (
              <div className="fw-operation-list">
                {currentOperations.map((operation) => (
                  <article key={operation.id}>
                    <header>
                      <div>
                        <strong>{operation.label}</strong>
                        <small>
                          {document.name}:{operation.startLine}–
                          {operation.endLine} · {operation.language}
                        </small>
                      </div>
                      <span
                        className={
                          operation.confidence === "partial"
                            ? "partial"
                            : "literal"
                        }
                      >
                        {operation.confidence === "partial"
                          ? "Parziale · da completare"
                          : "Testo letterale"}
                      </span>
                    </header>
                    {operation.context && (
                      <p className="fw-operation-context">
                        {operation.context}
                      </p>
                    )}
                    <pre>
                      <code>{operation.text}</code>
                    </pre>
                    {operation.warnings.map((warning, index) => (
                      <p key={index} className="fw-operation-warning">
                        {warning}
                      </p>
                    ))}
                    {operation.parameters.length > 0 && (
                      <div className="fw-parameter-hints">
                        <strong>Valori da fornire, non ricostruiti</strong>
                        {operation.parameters.map((parameter, index) => (
                          <span key={index}>
                            <code>{parameter.placeholder}</code>
                            {parameter.name} · {parameter.kind}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="fw-operation-actions">
                      <Button
                        variant="primary"
                        disabled={!extractionCurrent}
                        onClick={() => openExtracted(operation)}
                      >
                        <ArrowRight size={14} />
                        {operation.confidence === "partial"
                          ? "Apri bozza da completare"
                          : "Apri nell'editor query"}
                      </Button>
                      <Button variant="ghost" onClick={() => reveal(operation)}>
                        <FileCode2 size={14} />
                        Mostra origine
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => void copyText(operation.text)}
                      >
                        <Copy size={14} />
                        Copia
                      </Button>
                    </div>
                    <p className="fw-help">
                      L'editor riceve una bozza con provenienza. Salvare la
                      query non deve sovrascrivere il programma originale.
                    </p>
                  </article>
                ))}
              </div>
            )}
            {mode === "learning" && (
              <p className="fw-help">
                Le stringhe interpolate e i placeholder dipendono dal programma:
                completa manualmente i parametri e scegli la connessione
                corretta prima dell'esecuzione.
              </p>
            )}
          </section>
        )}
    </div>
  );
}
