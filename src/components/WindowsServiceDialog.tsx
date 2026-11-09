import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { api } from "../api";
import { errorMessage, pretty } from "../utils";
import { Button, Field, Modal, Notice } from "./UI";

interface ServicePlan {
  environmentName: string;
  serviceName: string;
  account: string;
  sourceData: string;
  serviceRoot: string;
  runtimeRoot: string;
  dataPath: string;
  distributionId: string;
  version: string;
  archivePath: string;
  archiveSha256: string;
  port: number;
  installed: boolean;
  status: string;
  actions: string[];
  steps: string[];
  liveScmCertified: boolean;
  fingerprint: string;
}
const ACTIONS: Record<string, string> = {
  install: "Installa servizio a richiesta",
  start: "Avvia servizio",
  stop: "Arresta servizio",
  remove: "Rimuovi registrazione del servizio",
};
export function WindowsServiceDialog({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [plan, setPlan] = useState<ServicePlan | null>(null);
  const [action, setAction] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  async function load() {
    setError("");
    try {
      const next = await api<ServicePlan>("service_plan", { id });
      setPlan(next);
      setAction(next.actions[0] || "");
      setReviewed(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  useEffect(() => {
    void load();
  }, [id]);
  async function request() {
    if (!plan || !reviewed || !action) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await api("service_action", {
        id,
        action,
        confirmed: true,
      });
      setResult(pretty(outcome));
      onChanged();
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Servizio Windows · ambiente gestito" onClose={onClose} wide>
      <div className="modal-body stack">
        {!plan && !error && (
          <p className="muted">
            Verifica di ambiente, catalogo e registrazione SCM…
          </p>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {plan && (
          <>
            <Notice>
              <strong>{plan.environmentName}</strong> · stato servizio:{" "}
              <strong>{plan.status}</strong>. L’applicazione rimane senza
              privilegi amministrativi; Windows richiede il consenso soltanto
              dopo la conferma dell’azione qui sotto.
            </Notice>
            <div className="form-grid">
              <Field label="Nome univoco del servizio">
                <input readOnly value={plan.serviceName} />
              </Field>
              <Field label="Account virtuale dedicato">
                <input readOnly value={plan.account} />
              </Field>
              <Field label="Dati originali">
                <input readOnly value={plan.sourceData} />
              </Field>
              <Field label="Dati del servizio in ProgramData">
                <input readOnly value={plan.dataPath} />
              </Field>
              <Field label="Distribuzione verificata">
                <input
                  readOnly
                  value={`${plan.distributionId} · ${plan.version}`}
                />
              </Field>
              <Field label="Porta locale">
                <input readOnly value={plan.port} />
              </Field>
            </div>
            <Field label="SHA-256 dell’archivio approvato">
              <input className="mono" readOnly value={plan.archiveSha256} />
            </Field>
            <details>
              <summary>Operazioni previste e percorsi</summary>
              <ol className="service-steps">
                {plan.steps.map((step, index) => (
                  <li key={index}>{step}</li>
                ))}
              </ol>
              <pre className="code-preview">
                {pretty({
                  runtime: plan.runtimeRoot,
                  archive: plan.archivePath,
                  fingerprint: plan.fingerprint,
                })}
              </pre>
            </details>
            {!plan.liveScmCertified && (
              <Notice tone="warning">
                Pianificazione, proprietà dei percorsi e controlli SCM
                verificati con test automatici. L’installazione reale del
                servizio Windows non è ancora certificata da un collaudo
                completo.
              </Notice>
            )}
            {plan.status === "retainedData" && (
              <Notice tone="warning">
                I dati più recenti restano in ProgramData dopo la rimozione. Il
                programma blocca il riavvio della vecchia copia AppData. Nessuna
                cancellazione o sovrascrittura viene avviata da questa finestra.
              </Notice>
            )}
            {plan.actions.length > 0 && (
              <>
                <Field label="Azione da richiedere a Windows">
                  <select
                    value={action}
                    disabled={busy}
                    onChange={(e) => {
                      setAction(e.target.value);
                      setReviewed(false);
                    }}
                  >
                    {plan.actions.map((item) => (
                      <option key={item} value={item}>
                        {ACTIONS[item] || item}
                      </option>
                    ))}
                  </select>
                </Field>
                {action === "install" && (
                  <Notice>
                    La creazione arresta prima l’istanza nativa e copia i dati
                    in ProgramData. Il servizio usa avvio manuale: l’avvio è una
                    seconda azione esplicita. Gli originali vengono conservati.
                  </Notice>
                )}
                {action === "remove" && (
                  <Notice tone="warning">
                    Viene arrestato e rimosso soltanto questo servizio, dopo la
                    verifica di nome, account, marker e percorso SCM. Runtime e
                    dati ProgramData rimangono conservati.
                  </Notice>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    disabled={busy}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  Ho verificato servizio, account, cartella dati e azione
                  selezionata.
                </label>
              </>
            )}
          </>
        )}
        {result && <pre className="code-preview">{result}</pre>}
      </div>
      <footer>
        <Button onClick={onClose} disabled={busy}>
          Chiudi
        </Button>
        <div className="spacer" />
        {plan && plan.actions.length > 0 && (
          <Button
            variant={action === "remove" ? "danger" : "primary"}
            disabled={!reviewed || !action}
            busy={busy}
            onClick={request}
          >
            <ShieldCheck size={15} />
            Conferma e richiedi UAC
          </Button>
        )}
      </footer>
    </Modal>
  );
}
