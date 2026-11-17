import { useEffect, useId, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Database,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { api } from "../api";
import { errorMessage } from "../utils";
import "./workspace-start.css";

interface DirectoryEntry {
  path: string;
  name: string;
  kind: string;
  extension: string;
}

interface DirectoryPage {
  entries: DirectoryEntry[];
  nextOffset: number | null;
  unreadableEntries: number;
}

export interface WorkspaceFileExplorerProps {
  path: string;
  onPath: (path: string) => void;
  onOpenFile: (path: string) => void;
  onPickFolder: () => void;
}

export function WorkspaceFileExplorer({
  path,
  onPath,
  onOpenFile,
  onPickFolder,
}: WorkspaceFileExplorerProps) {
  const [typedPath, setTypedPath] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) || path;
  return (
    <section className="workspace-files" aria-label="Esplora file">
      <div className="workspace-files-heading">
        <h2>File</h2>
        <span className="spacer" />
        <button
          className="icon-button"
          title="Aggiorna file"
          aria-label="Aggiorna file"
          onClick={() => setRefresh((count) => count + 1)}
          disabled={!path}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-button"
          title="Apri cartella di lavoro"
          aria-label="Apri cartella di lavoro"
          onClick={onPickFolder}
        >
          <FolderOpen size={15} />
        </button>
      </div>
      {path && (
        <strong className="workspace-files-root" title={path}>
          {name}
        </strong>
      )}
      {typedPath === null ? (
        <button
          className="text-button workspace-files-path-action"
          type="button"
          onClick={() => setTypedPath(path)}
        >
          {path ? "Cambia percorso" : "Inserisci percorso cartella"}
        </button>
      ) : (
        <form
          className="workspace-files-path"
          onSubmit={(event) => {
            event.preventDefault();
            const next = typedPath.trim().replace(/^"([\s\S]*)"$/, "$1");
            if (next) {
              onPath(next);
              setTypedPath(null);
              setRefresh((count) => count + 1);
            }
          }}
        >
          <input
            value={typedPath}
            onChange={(event) => setTypedPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setTypedPath(null);
            }}
            autoFocus
            aria-label="Percorso cartella di lavoro"
          />
          <button
            type="submit"
            className="icon-button"
            title="Usa questa cartella"
            aria-label="Usa questa cartella"
          >
            <ChevronRight size={15} />
          </button>
        </form>
      )}
      {path && (
        <div className="workspace-files-body">
          <DirectoryTree
            key={`${refresh}:${path}`}
            root={path}
            path={path}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </section>
  );
}

function DirectoryTree({
  path,
  root,
  onOpenFile,
}: {
  path: string;
  root: string;
  onOpenFile: (path: string) => void;
}) {
  const [page, setPage] = useState<DirectoryPage>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  async function load(offset: number) {
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const next = await api<DirectoryPage>("list_workspace_directory", {
        path,
        root,
        offset,
      });
      if (requestId.current !== id) return;
      setPage((current) => {
        if (!offset || !current) return next;
        const previous = new Set(current.entries.map((entry) => entry.path));
        return {
          ...next,
          entries: [
            ...current.entries,
            ...next.entries.filter((entry) => !previous.has(entry.path)),
          ],
          unreadableEntries: current.unreadableEntries + next.unreadableEntries,
        };
      });
    } catch (cause) {
      if (requestId.current === id) setError(errorMessage(cause));
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  }
  useEffect(() => {
    void load(0);
    return () => {
      requestId.current += 1;
    };
  }, [path, root]);
  const entries = [...(page?.entries ?? [])].sort((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind === "directory"
        ? -1
        : 1,
  );
  return (
    <>
      <ul className="workspace-files-list" aria-busy={busy}>
        {entries.map((entry) =>
          entry.kind === "directory" ? (
            <DirectoryBranch
              key={entry.path}
              entry={entry}
              root={root}
              onOpenFile={onOpenFile}
            />
          ) : (
            <WorkspaceFileLeaf
              key={entry.path}
              entry={entry}
              onOpenFile={onOpenFile}
            />
          ),
        )}
      </ul>
      {error && (
        <p className="workspace-files-error" role="alert">
          {error}
        </p>
      )}
      {busy && (
        <p className="workspace-files-message" role="status">
          Caricamento…
        </p>
      )}
      {page && !busy && !entries.length && page.nextOffset === null && (
        <p className="workspace-files-message">Cartella vuota.</p>
      )}
      {!!page?.unreadableEntries && (
        <p className="workspace-files-message">
          Voci non accessibili: {page.unreadableEntries}
        </p>
      )}
      {page?.nextOffset != null && (
        <button
          type="button"
          className="text-button workspace-files-path-action"
          disabled={busy}
          onClick={() => void load(page.nextOffset!)}
        >
          Carica altre voci
        </button>
      )}
    </>
  );
}

function DirectoryBranch({
  entry,
  root,
  onOpenFile,
}: {
  entry: DirectoryEntry;
  root: string;
  onOpenFile: (path: string) => void;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return (
    <li>
      <button
        type="button"
        className="workspace-files-row"
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        title={entry.path}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
        <span>{entry.name}</span>
      </button>
      {expanded && (
        <div id={id} className="workspace-files-children">
          <DirectoryTree
            path={entry.path}
            root={root}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </li>
  );
}

function WorkspaceFileLeaf({
  entry,
  onOpenFile,
}: {
  entry: DirectoryEntry;
  onOpenFile: (path: string) => void;
}) {
  const Icon = ["db", "sqlite", "sqlite3"].includes(entry.extension)
    ? Database
    : entry.extension === "sql"
      ? FileCode2
      : File;
  return (
    <li>
      <button
        type="button"
        className="workspace-files-row workspace-files-leaf"
        title={entry.path}
        onClick={() => onOpenFile(entry.path)}
      >
        <Icon size={14} />
        <span>{entry.name}</span>
      </button>
    </li>
  );
}
