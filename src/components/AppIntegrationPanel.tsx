import { FolderInput, RotateCcw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import type { GeneratedProject } from "../types";
import { errorMessage } from "../utils";
import { useConfirmation } from "./ConfirmationProvider";
import { PathInput } from "./PathInput";
import { Button, Field, Notice } from "./UI";

type IntegrationFile = {
  path: string;
  before: string | null;
  after: string;
  status: "create" | "update" | "unchanged" | "conflict";
};
interface Preview {
  destination: string;
  stateHash: string | null;
  lastTransaction: string | null;
  interrupted: boolean;
  files: IntegrationFile[];
}
interface FileDiff {
  path: string;
  before: string | null;
  after: string;
  truncated: boolean;
}
const STATUS = {
  create: "Da aggiungere",
  update: "Da aggiornare",
  unchanged: "Identico",
  conflict: "Conflitto · file conservato",
};
const writable = (item: IntegrationFile) =>
  item.status === "create" || item.status === "update";

export function AppIntegrationPanel({
  bundle,
  projectId,
}: {
  bundle: GeneratedProject;
  projectId: string;
}) {
  const confirm = useConfirmation();
  const [root, setRoot] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [comparison, setComparison] = useState<FileDiff>();
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => setPreview(null), [bundle, projectId]);

  async function load() {
    const plan = await api<Preview>("preview_app_integration", {
      root: root.trim(),
      projectId,
      files: bundle.files,
    });
    setPreview(plan);
    setComparison(undefined);
    setSelected(new Set(plan.files.filter(writable).map((item) => item.path)));
  }
  async function inspect() {
    setBusy("preview");
    setError("");
    setMessage("");
    setPreview(null);
    try {
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  async function apply() {
    if (!preview || !selected.size) return;
    if (
      !(await confirm(
        `Integrare ${selected.size} file nella cartella «${preview.destination}»?`,
      ))
    )
      return;
    setBusy("apply");
    setError("");
    setMessage("");
    try {
      const result = await api<{ changed: number }>("apply_app_integration", {
        root: root.trim(),
        projectId,
        files: bundle.files,
        stateHash: preview.stateHash,
        selected: preview.files
          .filter((item) => selected.has(item.path))
          .map(({ path, before, after }) => ({ path, before, after })),
      });
      setMessage(
        result.changed
          ? `${result.changed} file integrati nella sottocartella del progetto.`
          : "I file selezionati sono già aggiornati.",
      );
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      setPreview(null);
    } finally {
      setBusy("");
    }
  }
  async function rollback() {
    if (!preview?.lastTransaction) return;
    if (
      !(await confirm(
        "Annullare l’ultima integrazione e ripristinare i file precedenti?",
      ))
    )
      return;
    setBusy("rollback");
    setError("");
    setMessage("");
    try {
      const result = await api<{ changed: number }>(
        "rollback_app_integration",
        {
          root: root.trim(),
          projectId,
          transactionId: preview.lastTransaction,
        },
      );
      setMessage(`Integrazione annullata per ${result.changed} file.`);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
      setPreview(null);
    } finally {
      setBusy("");
    }
  }
  async function recoverInterrupted() {
    if (
      !preview?.interrupted ||
      !(await confirm(
        "Completare il recupero della transazione interrotta? Le modifiche manuali saranno controllate prima di toccare i file.",
      ))
    )
      return;
    setBusy("recover");
    setError("");
    setMessage("");
    try {
      const result = await api<{ changed: number; committed: boolean }>(
        "recover_app_integration",
        {
          root: root.trim(),
          projectId,
        },
      );
      setMessage(
        result.committed
          ? "L’integrazione risultava già completata."
          : `Recupero concluso. File ripristinati: ${result.changed}.`,
      );
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  async function compare(item: IntegrationFile) {
    if (comparison?.path === item.path) {
      setComparison(undefined);
      return;
    }
    const file = bundle.files.find((entry) => entry.path === item.path);
    if (!file) return;
    setBusy("diff");
    setError("");
    setComparison(undefined);
    try {
      const response = await api<
        Omit<FileDiff, "path" | "after"> & {
          beforeHash: string | null;
          afterHash: string;
        }
      >("diff_app_integration", {
        root: root.trim(),
        projectId,
        files: [file],
      });
      if (
        response.beforeHash !== item.before ||
        response.afterHash !== item.after
      )
        throw new Error(
          "Il file è cambiato dopo l’anteprima. Aggiorna l’elenco prima di confrontarlo.",
        );
      setComparison({
        path: item.path,
        before: response.before,
        after: file.content.slice(0, 32_000),
        truncated: response.truncated || file.content.length > 32_000,
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  return (
    <section
      id="app-integration-panel"
      className="panel stack app-integration-panel"
      tabIndex={-1}
    >
      <h2>Integra in un’app esistente</h2>
      <p className="muted">
        Scegli la cartella dell’app. I file generati vengono installati in una
        sottocartella del progetto, dalla quale puoi importarli nel tuo codice.
      </p>
      <fieldset className="row" disabled={!!busy}>
        <Field label="Cartella dell’app">
          <PathInput
            kind="directory"
            value={root}
            onChange={(value) => {
              setRoot(value);
              setPreview(null);
              setComparison(undefined);
              setMessage("");
              setError("");
            }}
            placeholder="C:\\progetti\\mia-app"
          />
        </Field>
        <Button
          disabled={!root.trim() || !!busy}
          onClick={() => void inspect()}
        >
          <FolderInput size={15} />{" "}
          {busy === "preview" ? "Analisi…" : "Prepara anteprima"}
        </Button>
      </fieldset>
      {error && (
        <div role="alert">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {message && (
        <div role="status">
          <Notice tone="success">{message}</Notice>
        </div>
      )}
      {preview && (
        <>
          {preview.interrupted && (
            <Notice tone="warning">
              <span>
                Integrazione interrotta. Recupera la transazione prima di
                procedere.
              </span>{" "}
              <Button
                disabled={!!busy}
                onClick={() => void recoverInterrupted()}
              >
                Recupera integrazione
              </Button>
            </Notice>
          )}
          <div className="row">
            <ShieldCheck size={16} aria-hidden />
            <code className="mono">{preview.destination}</code>
          </div>
          <div className="operation-results app-integration-files">
            <table aria-label="File da integrare">
              <thead>
                <tr>
                  <th>Includi</th>
                  <th>File</th>
                  <th>Stato</th>
                  <th>Confronto</th>
                </tr>
              </thead>
              <tbody>
                {preview.files.map((item) => (
                  <tr key={item.path}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Includi ${item.path}`}
                        checked={selected.has(item.path)}
                        disabled={
                          !!busy || preview.interrupted || !writable(item)
                        }
                        onChange={(event) => {
                          const next = new Set(selected);
                          if (event.target.checked) next.add(item.path);
                          else next.delete(item.path);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td>
                      <code>{item.path}</code>
                    </td>
                    <td>{STATUS[item.status]}</td>
                    <td>
                      <Button
                        variant="ghost"
                        disabled={!!busy}
                        aria-expanded={comparison?.path === item.path}
                        onClick={() => void compare(item)}
                      >
                        {comparison?.path === item.path
                          ? "Chiudi diff"
                          : "Mostra diff"}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {comparison && <IntegrationDiff comparison={comparison} />}
          <div className="row">
            <Button
              variant="primary"
              disabled={!!busy || preview.interrupted || !selected.size}
              onClick={() => void apply()}
            >
              {busy === "apply"
                ? "Integrazione…"
                : `Integra ${selected.size} file`}
            </Button>
            {preview.lastTransaction && (
              <Button
                disabled={!!busy || preview.interrupted}
                onClick={() => void rollback()}
              >
                <RotateCcw size={15} />{" "}
                {busy === "rollback"
                  ? "Ripristino…"
                  : "Annulla ultima integrazione"}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function IntegrationDiff({ comparison }: { comparison: FileDiff }) {
  const before = comparison.before ? comparison.before.split("\n") : [];
  const after = comparison.after ? comparison.after.split("\n") : [];
  const canMarkLines =
    comparison.before !== null && before.length <= 250 && after.length <= 250;
  const lines: { marker: string; value: string }[] = [];
  if (canMarkLines) {
    const lengths = Array.from(
      { length: before.length + 1 },
      () => new Uint16Array(after.length + 1),
    );
    for (let left = before.length - 1; left >= 0; left--)
      for (let right = after.length - 1; right >= 0; right--)
        lengths[left][right] =
          before[left] === after[right]
            ? 1 + lengths[left + 1][right + 1]
            : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    let left = 0;
    let right = 0;
    while (left < before.length || right < after.length) {
      if (
        left < before.length &&
        right < after.length &&
        before[left] === after[right]
      ) {
        lines.push({ marker: " ", value: before[left++] });
        right++;
      } else if (
        left < before.length &&
        (right >= after.length ||
          lengths[left + 1][right] >= lengths[left][right + 1])
      )
        lines.push({ marker: "-", value: before[left++] });
      else lines.push({ marker: "+", value: after[right++] });
    }
  }
  return (
    <section
      className="app-integration-diff"
      aria-label={`Differenze per ${comparison.path}`}
    >
      <strong>{comparison.path}</strong>
      {comparison.truncated && (
        <p className="muted">Anteprima limitata all’inizio del file.</p>
      )}
      {canMarkLines ? (
        <pre>
          {lines.map(({ marker, value }, index) => (
            <span key={index} data-line={marker}>
              {marker} {value}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <div className="app-integration-compare">
          <div>
            <small>File attuale</small>
            <pre>{comparison.before ?? "File non testuale"}</pre>
          </div>
          <div>
            <small>File generato</small>
            <pre>{comparison.after}</pre>
          </div>
        </div>
      )}
    </section>
  );
}
