import { useState } from "react";
import { api } from "../api";
import { PathInput } from "./PathInput";
import { Field, Button, Notice } from "./UI";
import {
  applySourceChanges,
  scanProjectChanges,
  type SourceInspection,
} from "../project/packageSync";
import type { ApplicationProject } from "../project/applicationProject";
import { errorMessage } from "../utils";

export function ProjectSyncPanel({
  project,
  onImport,
}: {
  project: ApplicationProject;
  onImport?: (value: ApplicationProject) => void;
}) {
  const [directory, setDirectory] = useState("");
  const [inspection, setInspection] = useState<SourceInspection>();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  let changes: ReturnType<typeof scanProjectChanges> = [];
  let problem = "";
  try {
    if (inspection) changes = scanProjectChanges(project, inspection);
  } catch (e) {
    problem = errorMessage(e);
  }
  async function scan(apply = false) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const fresh = await api<SourceInspection>("inspect_project_sources", {
        directory,
      });
      const diff = scanProjectChanges(project, fresh);
      if (apply) {
        if (JSON.stringify(fresh) !== JSON.stringify(inspection)) {
          setInspection(fresh);
          setSelected([]);
          throw new Error(
            "I sorgenti sono cambiati. Rivedi il nuovo confronto.",
          );
        }
        const approved = diff.filter(
          (c) => selected.includes(c.key) && !c.error,
        );
        if (!approved.length)
          throw new Error("Seleziona almeno una modifica valida.");
        onImport?.(applySourceChanges(project, approved));
        setNotice("Modifiche applicate al progetto grafico.");
        setInspection(undefined);
        setSelected([]);
      } else {
        setInspection(fresh);
        setSelected(diff.filter((d) => !d.error).map((d) => d.key));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel stack">
      <h3>Confronta il progetto con i sorgenti</h3>
      <Field label="Cartella che contiene il manifesto esportato">
        <PathInput
          kind="directory"
          value={directory}
          onChange={(v) => {
            setDirectory(v);
            setInspection(undefined);
            setNotice("");
          }}
        />
      </Field>
      <Button disabled={busy || !directory.trim()} onClick={() => void scan()}>
        Confronta file su disco
      </Button>
      {(error || problem) && <Notice tone="error">{error || problem}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {inspection &&
        !problem &&
        (!changes.length ? (
          <Notice>I sorgenti tracciati coincidono con l’esportazione.</Notice>
        ) : (
          changes.map((c) => (
            <div key={c.key}>
              <label>
                <input
                  type="checkbox"
                  checked={selected.includes(c.key)}
                  disabled={!!c.error}
                  onChange={(e) =>
                    setSelected((old) =>
                      e.target.checked
                        ? [...old, c.key]
                        : old.filter((k) => k !== c.key),
                    )
                  }
                />{" "}
                {c.label}
              </label>
              <small>{c.paths.join(" · ")}</small>
              {c.error ? (
                <Notice tone="error">{c.error}</Notice>
              ) : (
                <details>
                  <summary>Anteprima</summary>
                  <pre>{c.detail}</pre>
                </details>
              )}
            </div>
          ))
        ))}
      {inspection && !!changes.length && (
        <Button
          variant="primary"
          disabled={busy || !selected.length || !onImport}
          onClick={() => void scan(true)}
        >
          Applica le modifiche selezionate al progetto
        </Button>
      )}
    </section>
  );
}
