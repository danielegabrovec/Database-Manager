import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Button, Field, Modal, Notice } from "../components/UI";
import { useConfirmation } from "../components/ConfirmationProvider";
import { buildProjectDdl } from "../designer/schemaProject";
import { interpretProjectGoal } from "../project/goalPlan";
import { testApplicationProject } from "../project/projectTest";
import { buildApplicationPackage } from "../project/packageModel";
import type { ApplicationProject } from "../project/applicationProject";
import { errorMessage, newId } from "../utils";
import type { QueryResult } from "../types";

type Permission = "suggest" | "simulate" | "real";
type Proposal = ReturnType<typeof interpretProjectGoal>;
type RealPreview = {
  session: string;
  operation: unknown;
  query: string;
  parameters: Record<string, unknown>;
  fingerprint: string;
};
export function ProjectGoalDialog({
  initialGoal = "",
  sessionId,
  target,
  readOnly,
  currentProject,
  onDesign,
  onClose,
  onProject,
}: {
  currentProject: ApplicationProject;
  onDesign: (project: ApplicationProject) => void;
  initialGoal?: string;
  sessionId: string;
  target: string;
  readOnly: boolean;
  onClose: () => void;
  onProject: (value: ApplicationProject, language: string) => void;
}) {
  const confirm = useConfirmation();
  const [goal, setGoal] = useState(initialGoal);
  const [permission, setPermission] = useState<Permission>("suggest");
  const [includeProject, setIncludeProject] = useState(false);
  const [structure, setStructure] = useState(false);
  const [packageInfo, setPackageInfo] =
    useState<{ path: string; content: string }[]>();
  const [auto, setAuto] = useState(false);
  const [proposal, setProposal] = useState<Proposal>();
  const [real, setReal] = useState<RealPreview>();
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<{ id: string; controller: AbortController } | null>(
    null,
  );
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;
  function stop() {
    const run = active.current;
    if (!run) return;
    run.controller.abort();
    void api("project_ai_cancel", { requestId: run.id }).catch(() => {});
    setLog((l) => [...l, "Interruzione richiesta."]);
  }
  useEffect(
    () => () => {
      if (active.current) {
        active.current.controller.abort();
        void api("project_ai_cancel", { requestId: active.current.id }).catch(
          () => {},
        );
      }
    },
    [],
  );
  function reset() {
    setReal(undefined);
    setPackageInfo(undefined);
    setProposal(undefined);
    setLog([]);
    setError("");
  }
  async function run(existing?: Proposal) {
    if (active.current) return;
    const job = { id: newId(), controller: new AbortController() };
    active.current = job;
    setBusy(true);
    setError("");
    if (!existing) reset();
    const { signal } = job.controller;
    const step = (text: string) => {
      signal.throwIfAborted();
      setLog((old) => [...old, text].slice(-200));
    };
    try {
      let candidate = existing;
      if (!candidate) {
        step("Preparazione della proposta con il modello locale…");
        const raw = await api("project_ai_plan", {
          requestId: job.id,
          goal,
          permission,
          structure: permission === "real" && structure,
          sessionId: permission === "real" ? sessionId : undefined,
          projectInventory:
            includeProject && permission !== "real"
              ? currentProject.databases.map((db) => ({
                  name: db.name,
                  engine: db.engine,
                  tables: db.tables.map((t) => ({
                    name: t.name,
                    schema: t.schema,
                    columns: t.columns.map((c) => [c.name, c.dataType]),
                  })),
                  operations: db.operations.map((o) => o.name),
                }))
              : undefined,
        });
        signal.throwIfAborted();
        if (permission === "real" && !structure) {
          if (sessionId !== currentSession.current)
            throw new Error("La connessione è cambiata.");
          const prepared = await api<
            Omit<RealPreview, "operation" | "session">
          >("preview_graph_write", { sessionId, operation: raw });
          signal.throwIfAborted();
          setReal({ ...prepared, session: sessionId, operation: raw });
          step("Anteprima preparata sul database selezionato.");
          return;
        }
        candidate = interpretProjectGoal(raw);
        setProposal(candidate);
        step("Schema, dati e operazioni convertiti in un progetto grafico.");
      }
      if (permission !== "simulate" || (!existing && !auto)) return;
      const reports = await testApplicationProject(candidate.project, {
        signal,
        onProgress: step,
        stopOnFailure: true,
      });
      signal.throwIfAborted();
      for (const report of reports) {
        const failed = report.steps.find((s) => s.status === "failed");
        if (report.status !== "passed")
          throw new Error(
            report.name + " · " + (failed?.detail || report.status),
          );
        step(
          report.name +
            " · " +
            report.steps.map((s) => s.name + " (" + s.detail + ")").join(", "),
        );
      }
      const output = await buildApplicationPackage(
        candidate.project,
        candidate.language,
        true,
      );
      signal.throwIfAborted();
      setPackageInfo(output.files);
      step(
        "Pacchetto " +
          candidate.language +
          " generato in anteprima: " +
          output.files.length +
          " file.",
      );
    } catch (cause) {
      setError(signal.aborted ? "Operazione interrotta." : errorMessage(cause));
    } finally {
      active.current = null;
      setBusy(false);
    }
  }
  async function applyReal() {
    if (!real || busy || real.session !== sessionId || permission !== "real")
      return;
    const preview = real;
    if (
      !(await confirm(
        "Applicare questa specifica scrittura su «" + target + "»?",
      ))
    )
      return;
    if (preview.session !== currentSession.current) {
      setError("Destinazione cambiata. Genera una nuova anteprima.");
      return;
    }
    setReal(undefined);
    setBusy(true);
    try {
      const result = await api<QueryResult>("execute_graph_write", {
        sessionId: preview.session,
        operation: preview.operation,
        fingerprint: preview.fingerprint,
      });
      setLog((old) => [
        ...old,
        "Scrittura confermata: " + result.affectedRows + " record interessati.",
      ]);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Obiettivo con AI locale"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <div className="modal-body stack">
        <Field label="Obiettivo">
          <textarea
            value={goal}
            rows={3}
            disabled={busy}
            maxLength={8000}
            onChange={(e) => {
              reset();
              setGoal(e.target.value);
            }}
            placeholder="Crea clienti e ordini, inserisci tre esempi e prepara il codice Python."
          />
        </Field>
        <div className="row">
          <Field label="Permessi">
            <select
              disabled={busy}
              value={permission}
              onChange={(e) => {
                reset();
                setPermission(e.target.value as Permission);
              }}
            >
              <option value="suggest">Solo suggerimenti</option>
              <option value="simulate">Lettura e simulazione</option>
              <option value="real" disabled={!sessionId || readOnly}>
                Modifiche reali
              </option>
            </select>
          </Field>
          <Field label="Conduzione">
            <select
              value={auto ? "auto" : "assisted"}
              disabled={busy}
              onChange={(e) => setAuto(e.target.value === "auto")}
            >
              <option value="assisted">Assistita</option>
              <option value="auto">Autonoma</option>
            </select>
          </Field>
        </div>
        {permission === "real" && (
          <Field label="Oggetto della modifica">
            <select
              value={structure ? "structure" : "records"}
              disabled={busy}
              onChange={(e) => {
                reset();
                setStructure(e.target.value === "structure");
              }}
            >
              <option value="records">Record della tabella</option>
              <option value="structure">
                Struttura da rivedere nel Designer
              </option>
            </select>
          </Field>
        )}
        {permission !== "real" && (
          <label className="check">
            <input
              disabled={busy}
              type="checkbox"
              checked={includeProject}
              onChange={(e) => {
                reset();
                setIncludeProject(e.target.checked);
              }}
            />{" "}
            Includi nomi e tipi dello schema di «{currentProject.name}»
          </label>
        )}
        {permission === "real" && (
          <Notice>
            Destinazione: {target}. Condivide nomi e tipi delle colonne con
            Ollama per preparare una scrittura.
          </Notice>
        )}
        {permission === "simulate" && (
          <Notice>
            La prova usa database isolati. Per i motori server occorre un
            laboratorio locale disponibile.
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {proposal && (
          <section>
            <strong>
              {proposal.project.name} · {proposal.language}
            </strong>
            {proposal.project.databases.map((db) => (
              <p key={db.id}>
                {db.name} · {db.engine} ·{" "}
                {db.tables.map((t) => t.name).join(", ")} · {db.seed.length}{" "}
                record · {db.operations.length} operazioni
              </p>
            ))}
          </section>
        )}
        {proposal && (
          <details>
            <summary>Strutture proposte</summary>
            {proposal.project.databases.map((db) => (
              <pre key={db.id}>{buildProjectDdl(db.engine, db.tables)}</pre>
            ))}
          </details>
        )}
        {packageInfo && (
          <details>
            <summary>File generati · {packageInfo.length}</summary>
            <ul>
              {packageInfo.map((file) => (
                <li key={file.path}>{file.path}</li>
              ))}
            </ul>
          </details>
        )}
        {real && (
          <pre>
            {real.query}
            {"\n"}
            {JSON.stringify(real.parameters, null, 2)}
          </pre>
        )}
        {log.length > 0 && (
          <ol className="goal-progress" aria-live="polite">
            {log.map((entry, i) => (
              <li key={i}>{entry}</li>
            ))}
          </ol>
        )}
      </div>
      <footer>
        <Button onClick={onClose} disabled={busy}>
          Chiudi
        </Button>
        {busy ? (
          <Button disabled={!active.current} onClick={stop}>
            {active.current ? "Interrompi" : "Scrittura in corso…"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!goal.trim()}
            onClick={() => void run()}
          >
            {auto && permission === "simulate"
              ? "Genera, prova e prepara codice"
              : "Prepara proposta"}
          </Button>
        )}
        {proposal && !busy && (
          <>
            {permission === "simulate" && !auto && (
              <Button onClick={() => void run(proposal)}>
                Prova e prepara codice
              </Button>
            )}
            <Button
              onClick={() => onProject(proposal.project, proposal.language)}
            >
              Apri progetto grafico
            </Button>
          </>
        )}
        {proposal && permission === "real" && structure && (
          <Button onClick={() => onDesign(proposal.project)}>
            Rivedi la struttura nel Designer
          </Button>
        )}
        {real && (
          <Button
            variant="danger"
            disabled={busy || real.session !== sessionId}
            onClick={() => void applyReal()}
          >
            Conferma scrittura…
          </Button>
        )}
      </footer>
    </Modal>
  );
}
