import { useState } from "react";
import { Cable, Database, LockKeyhole, Server } from "lucide-react";
import { api } from "../api";
import { ENGINES, ENGINE_LABELS, ENGINE_PORTS } from "../types";
import type { ConnectionProfile, Engine } from "../types";
import { errorMessage, newId } from "../utils";
import { Button, Field, Modal, Notice } from "./UI";
import { PathInput } from "./PathInput";

export function ProfileDialog({
  profile,
  onClose,
  onSaved,
  onDeleted,
}: {
  profile?: ConnectionProfile;
  onClose: () => void;
  onSaved: (profile: ConnectionProfile) => void;
  onDeleted: (id: string) => void;
}) {
  const [form, setForm] = useState<ConnectionProfile>(
    profile
      ? {
          ...profile,
          environment: profile.laboratory
            ? "laboratory"
            : {
                Locale: "development",
                Sviluppo: "development",
                Test: "test",
                Produzione: "production",
                Laboratorio: "laboratory",
              }[profile.environment] || profile.environment,
        }
      : {
          id: newId(),
          name: "",
          engine: "sqlite",
          host: "localhost",
          port: 0,
          database: "",
          username: "",
          filePath: "",
          environment: "development",
          readOnly: false,
          tls: false,
          ssh: {
            enabled: false,
            host: "",
            port: 22,
            username: "",
            keyPath: "",
          },
        },
  );
  const [password, setPassword] = useState("");
  const [tab, setTab] = useState("connection");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const patch = (key: keyof ConnectionProfile, value: unknown) =>
    setForm((old) => ({ ...old, [key]: value }));
  async function test() {
    setBusy("test");
    setError("");
    setMessage("");
    try {
      setMessage(
        await api<string>("test_connection", {
          profile: form,
          password: password || undefined,
        }),
      );
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function save() {
    if (!form.name.trim()) {
      setError("Assegna un nome alla connessione.");
      return;
    }
    if (form.engine === "sqlite" && !form.filePath.trim()) {
      setError(
        "Indica il percorso del file SQLite, oppure :memory: per un database temporaneo.",
      );
      return;
    }
    setBusy("save");
    setError("");
    try {
      const saved = await api<ConnectionProfile>("save_profile", {
        profile: form,
        password: password || undefined,
      });
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <Modal
      title={profile ? "Modifica connessione" : "Nuova connessione"}
      onClose={onClose}
      wide
    >
      <div className="modal-body">
        <div className="engine-picker">
          {ENGINES.map((engine) => (
            <button
              key={engine}
              className={`engine-option ${form.engine === engine ? "selected" : ""}`}
              onClick={() =>
                setForm((old) => ({
                  ...old,
                  engine,
                  port: ENGINE_PORTS[engine],
                  tls: engine === "sqlite" ? false : old.tls,
                }))
              }
            >
              <Database size={20} />
              {ENGINE_LABELS[engine]}
            </button>
          ))}
        </div>
        <div className="tab-strip">
          <button
            className={tab === "connection" ? "active" : ""}
            onClick={() => setTab("connection")}
          >
            <Cable size={15} />
            Connessione
          </button>
          <button
            className={tab === "security" ? "active" : ""}
            onClick={() => setTab("security")}
          >
            <LockKeyhole size={15} />
            TLS e protezioni
          </button>
          <button
            className={tab === "ssh" ? "active" : ""}
            onClick={() => setTab("ssh")}
          >
            <Server size={15} />
            Tunnel SSH
          </button>
        </div>
        {tab === "connection" && (
          <div className="form-grid">
            <Field label="Nome connessione">
              <input
                autoFocus
                value={form.name}
                onChange={(e) => patch("name", e.target.value)}
                placeholder="Es. Applicazione · sviluppo"
              />
            </Field>
            <Field label="Ambiente">
              <select
                value={form.environment}
                onChange={(e) => patch("environment", e.target.value)}
              >
                <option value="development">Sviluppo</option>
                <option value="test">Test</option>
                <option value="production">Produzione</option>
                {profile?.laboratory && (
                  <option value="laboratory">Laboratorio</option>
                )}
              </select>
            </Field>
            {form.engine === "sqlite" ? (
              <Field
                label="File SQLite"
                hint="Il file viene creato se non esiste. :memory: crea un database temporaneo."
              >
                <PathInput
                  value={form.filePath}
                  onChange={(value) => patch("filePath", value)}
                  kind="save"
                  placeholder="C:\\Dati\\progetto.sqlite"
                  filters={[
                    {
                      name: "Database SQLite",
                      extensions: ["sqlite", "db", "sqlite3"],
                    },
                  ]}
                />
              </Field>
            ) : (
              <>
                <Field
                  label={
                    form.engine === "mongodb"
                      ? "Host oppure URI MongoDB"
                      : "Host"
                  }
                >
                  <input
                    value={form.host}
                    onChange={(e) => patch("host", e.target.value)}
                    placeholder="localhost"
                  />
                </Field>
                <Field label="Porta">
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={form.port}
                    onChange={(e) => patch("port", Number(e.target.value))}
                  />
                </Field>
                <Field label="Database">
                  <input
                    value={form.database}
                    onChange={(e) => patch("database", e.target.value)}
                  />
                </Field>
                <Field label="Utente">
                  <input
                    autoComplete="username"
                    value={form.username}
                    onChange={(e) => patch("username", e.target.value)}
                  />
                </Field>
                <Field
                  label="Password"
                  hint={
                    profile
                      ? "Lascia vuoto per mantenere la credenziale già salvata."
                      : "La credenziale viene conservata dal backend, separata dal profilo."
                  }
                >
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
              </>
            )}
          </div>
        )}
        {tab === "security" && (
          <div className="stack">
            <Field label="Crittografia TLS">
              <select
                value={form.tls ? "required" : "disabled"}
                disabled={form.engine === "sqlite"}
                onChange={(e) => patch("tls", e.target.value === "required")}
              >
                <option value="disabled">Disabilitata</option>
                <option value="required">Richiedi TLS verificato</option>
              </select>
            </Field>
            {form.tls && (
              <Field label="Certificato CA personalizzato (facoltativo)">
                <input
                  value={form.caPath || ""}
                  onChange={(e) => patch("caPath", e.target.value)}
                  placeholder="C:\\Certificati\\server-ca.pem"
                />
              </Field>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={form.readOnly}
                onChange={(e) => patch("readOnly", e.target.checked)}
              />
              Apri questa connessione in sola lettura
            </label>
            <Notice>
              Il nome del database e l’ambiente rimangono visibili nell’editor.
              Le modifiche preparate nella griglia richiedono un’applicazione
              esplicita.
            </Notice>
          </div>
        )}
        {tab === "ssh" && (
          <div className="stack">
            <label className="check">
              <input
                type="checkbox"
                checked={form.ssh?.enabled || false}
                onChange={(e) =>
                  patch("ssh", { ...form.ssh, enabled: e.target.checked })
                }
              />
              Usa un tunnel SSH
            </label>
            <div className="form-grid">
              {(
                [
                  ["host", "Server SSH"],
                  ["port", "Porta SSH"],
                  ["username", "Utente SSH"],
                  ["keyPath", "Percorso chiave privata"],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} label={label}>
                  <input
                    disabled={!form.ssh?.enabled}
                    value={form.ssh?.[key] || ""}
                    onChange={(e) =>
                      patch("ssh", {
                        ...form.ssh,
                        [key]:
                          key === "port"
                            ? Number(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                </Field>
              ))}
            </div>
            <Notice>
              Il tunnel viene gestito dal backend. Se il metodo di
              autenticazione richiesto non è disponibile, il test della
              connessione ne mostra il motivo.
            </Notice>
          </div>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {message && <Notice tone="success">{message}</Notice>}
      </div>
      <footer>
        {profile && (
          <Button
            variant="danger"
            disabled={!!busy}
            onClick={async () => {
              if (
                !window.confirm(
                  "Rimuovere questa connessione dal workspace? Il database e i suoi dati rimangono al loro posto.",
                )
              )
                return;
              setBusy("delete");
              try {
                await api("delete_profile", { id: profile.id });
                onDeleted(profile.id);
                onClose();
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy("");
              }
            }}
          >
            Rimuovi
          </Button>
        )}
        <Button onClick={test} busy={busy === "test"} disabled={!!busy}>
          Verifica connessione
        </Button>
        <div className="spacer" />
        <Button onClick={onClose}>Annulla</Button>
        <Button
          variant="primary"
          onClick={save}
          busy={busy === "save"}
          disabled={!!busy || profile?.laboratory}
        >
          Salva connessione
        </Button>
      </footer>
    </Modal>
  );
}
export function engineFrom(value: string): Engine {
  return ENGINES.includes(value as Engine) ? (value as Engine) : "sqlite";
}
