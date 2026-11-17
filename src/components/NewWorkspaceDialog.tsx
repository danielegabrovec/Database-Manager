import { useState } from "react";
import { Cable, Database, FileInput, FilePlus2, GitFork } from "lucide-react";
import { ENGINE_LABELS, type ConnectionProfile } from "../types";
import { errorMessage } from "../utils";
import { PathInput } from "./PathInput";
import { Button, Field, Modal, Notice } from "./UI";

type Route = "sqlite" | "existing" | "design" | "script" | "connect" | "server";
const routes = [
  { id: "sqlite", label: "Crea un file SQLite", icon: FilePlus2 },
  { id: "design", label: "Disegna uno schema", icon: GitFork },
  { id: "existing", label: "Apri SQLite esistente", icon: Database },
  { id: "script", label: "Importa uno script", icon: FileInput },
  { id: "connect", label: "Configura una connessione", icon: Cable },
  { id: "server", label: "Crea un database su server", icon: Database },
] as const;

export function NewWorkspaceDialog({
  profiles,
  onClose,
  onNavigate,
  onCreateFile,
  onCreateServer,
}: {
  profiles: ConnectionProfile[];
  onClose: () => void;
  onNavigate: (route: "existing" | "design" | "script" | "connect") => void;
  onCreateFile: (path: string) => Promise<void>;
  onCreateServer: (
    profile: ConnectionProfile,
    name: string,
    collection: string,
  ) => Promise<void>;
}) {
  const [route, setRoute] = useState<Route>("sqlite");
  const [path, setPath] = useState("");
  const [connection, setConnection] = useState("");
  const [name, setName] = useState("");
  const [collection, setCollection] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const servers = profiles.filter(
    (profile) =>
      profile.engine !== "sqlite" && !profile.readOnly && !profile.laboratory,
  );
  const target =
    servers.find((profile) => profile.id === connection) || servers[0];
  const disabled =
    busy ||
    (route === "sqlite" && !path.trim()) ||
    (route === "server" &&
      (!target ||
        !name.trim() ||
        (target.engine === "mongodb" && !collection.trim())));

  async function advance() {
    if (disabled) return;
    if (route !== "sqlite" && route !== "server") {
      onNavigate(route);
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (route === "sqlite") await onCreateFile(path);
      else if (target) await onCreateServer(target, name, collection);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Nuovo lavoro" onClose={() => !busy && onClose()} wide>
      <div className="modal-body stack">
        <div
          className="workspace-wizard-routes"
          role="group"
          aria-label="Tipo di lavoro"
        >
          {routes.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant={route === id ? "primary" : "secondary"}
              disabled={busy}
              aria-pressed={route === id}
              onClick={() => {
                setRoute(id);
                setError("");
              }}
            >
              <Icon size={16} /> {label}
            </Button>
          ))}
        </div>
        {route === "sqlite" && (
          <Field label="Percorso del nuovo file SQLite">
            <PathInput
              value={path}
              onChange={setPath}
              kind="save"
              placeholder={"C:\\database\\progetto.sqlite"}
              filters={[
                {
                  name: "Database SQLite",
                  extensions: ["sqlite", "sqlite3", "db"],
                },
              ]}
            />
          </Field>
        )}
        {route === "server" &&
          (target ? (
            <>
              <Field label="Connessione con permessi di creazione">
                <select
                  value={target.id}
                  onChange={(event) => setConnection(event.target.value)}
                >
                  {servers.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name} · {ENGINE_LABELS[profile.engine]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Nome del nuovo database">
                <input
                  maxLength={63}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              {target.engine === "mongodb" && (
                <Field label="Prima collezione">
                  <input
                    maxLength={120}
                    value={collection}
                    onChange={(event) => setCollection(event.target.value)}
                  />
                </Field>
              )}
            </>
          ) : (
            <Notice tone="info">
              Configura prima una connessione server modificabile.
            </Notice>
          ))}
        {error && <Notice tone="error">{error}</Notice>}
      </div>
      <footer className="modal-actions">
        <Button disabled={busy} onClick={onClose}>
          Annulla
        </Button>
        <Button
          variant="primary"
          disabled={disabled}
          onClick={() => void advance()}
        >
          {busy
            ? "Creazione in corso…"
            : route === "sqlite" || route === "server"
              ? "Crea"
              : "Continua"}
        </Button>
      </footer>
    </Modal>
  );
}
