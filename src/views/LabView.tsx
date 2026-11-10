import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  FlaskConical,
  Lightbulb,
  RotateCcw,
} from "lucide-react";
import { api } from "../api";
import type { ConnectionProfile, Engine, SchemaSnapshot } from "../types";
import { ENGINES, ENGINE_LABELS } from "../types";
import { errorMessage, pretty } from "../utils";
import { Button, Field, Notice, SectionHeader } from "../components/UI";
import { useConfirmation } from "../components/ConfirmationProvider";

interface Exercise {
  id: string;
  title: string;
  description: string;
  query: string;
  hints: string[];
  difficulty?: string;
}
interface CheckResult {
  passed: boolean;
  message: string;
  details?: unknown;
}
interface Props {
  onOpened: (data: {
    profile: ConnectionProfile;
    sessionId: string;
    schema: SchemaSnapshot;
  }) => void;
  onQuery: (query: string) => void;
  currentSession: string;
  schema: SchemaSnapshot | null;
  query: string;
  laboratory: boolean;
}
const DATASETS = [
  ["shop", "Negozio e ordini"],
  ["library", "Biblioteca"],
  ["company", "Azienda e dipendenti"],
  ["inventory", "Magazzino e scorte"],
];

export function LabView({
  onOpened,
  onQuery,
  currentSession,
  schema,
  query,
  laboratory,
}: Props) {
  const confirm = useConfirmation();
  const activeLaboratory = laboratory && !!currentSession && schema !== null;
  const [engine, setEngine] = useState<Engine>(schema?.engine || "sqlite");
  const [dataset, setDataset] = useState(
    DATASETS.some(([id]) => id === schema?.database)
      ? schema!.database
      : "shop",
  );
  const [provider, setProvider] = useState("docker");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [checks, setChecks] = useState<Record<string, CheckResult>>({});
  const [activeExercise, setActiveExercise] = useState("");
  useEffect(() => {
    if (!activeLaboratory) {
      setExercises([]);
      return;
    }
    let alive = true;
    api<Exercise[]>("lab_exercises", { sessionId: currentSession, dataset })
      .then((items) => {
        if (alive) setExercises(items);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [currentSession, dataset, activeLaboratory]);
  async function open() {
    setBusy("open");
    setError("");
    try {
      const data = await api<{
        profile: ConnectionProfile;
        sessionId: string;
        schema: SchemaSnapshot;
      }>("lab_open", { engine, dataset, provider });
      onOpened(data);
      setChecks({});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function reset() {
    if (
      !(await confirm(
        "Ripristinare i dati iniziali di questo laboratorio? Le modifiche al dataset verranno perse.",
      ))
    )
      return;
    setBusy("reset");
    setError("");
    try {
      const next = await api<SchemaSnapshot>("lab_reset", {
        sessionId: currentSession,
        dataset,
      });
      onOpened({
        profile: {
          id: "",
          name: "Laboratorio",
          engine,
          host: "",
          port: 0,
          database: next.database,
          username: "",
          filePath: "",
          environment: "laboratory",
          readOnly: false,
          tls: false,
          laboratory: true,
        },
        sessionId: currentSession,
        schema: next,
      });
      setChecks({});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  async function check(exercise: Exercise) {
    setBusy(exercise.id);
    setError("");
    try {
      const result = await api<CheckResult>("lab_check", {
        sessionId: currentSession,
        exerciseId: exercise.id,
        dataset,
        query,
      });
      setChecks((old) => ({ ...old, [exercise.id]: result }));
      setActiveExercise(exercise.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="view-content">
      <SectionHeader
        eyebrow="IMPARA FACENDO"
        title="Laboratorio query"
        description="Scrivi, esegui e capisci. Un ambiente dedicato per provare operazioni su dati di esempio."
      />
      <div className="lab-hero">
        <div className="lab-illustration">
          <FlaskConical size={49} />
          <span className="orbit orbit-a" />
          <span className="orbit orbit-b" />
        </div>
        <div>
          <span className="badge teal">SPAZIO DI PROVA</span>
          <h2>Dal primo SELECT alle query avanzate</h2>
          <p>
            Usa un motore reale, osserva i risultati e chiedi spiegazioni. Puoi
            ricominciare dai dati iniziali quando vuoi.
          </p>
        </div>
        <div className="lab-facts">
          <span>
            <CheckCircle2 size={15} />
            Dati separati
          </span>
          <span>
            <CheckCircle2 size={15} />
            Risultati reali
          </span>
          <span>
            <CheckCircle2 size={15} />
            Esercizi verificabili
          </span>
        </div>
      </div>
      <div className="panel">
        <div className="form-grid three">
          <Field label="Motore del laboratorio">
            <select
              value={engine}
              onChange={(e) => setEngine(e.target.value as Engine)}
            >
              {ENGINES.map((item) => (
                <option value={item} key={item}>
                  {ENGINE_LABELS[item]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scenario di esempio">
            <select
              value={dataset}
              onChange={(e) => setDataset(e.target.value)}
            >
              {DATASETS.map(([id, label]) => (
                <option value={id} key={id}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <div className="field action-field">
            <span>Ambiente dedicato</span>
            <Button variant="primary" onClick={open} busy={busy === "open"}>
              <FlaskConical size={15} />
              Crea e apri laboratorio
            </Button>
          </div>
        </div>
        {engine !== "sqlite" && (
          <div className="lab-provider">
            <Field label="Come avviare il motore">
              <select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              >
                <option value="docker">Container Docker</option>
                <option value="native">Istanza nativa gestita</option>
              </select>
            </Field>
            <p className="muted small">
              La disponibilità del motore e dei pacchetti necessari viene
              verificata all’apertura.
            </p>
          </div>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {activeLaboratory && (
        <div className="row">
          <Notice tone="success">
            Laboratorio attivo: {schema?.database}. Scrivi ed esegui le query
            nell’editor, poi torna qui per verificarle.
          </Notice>
          <Button onClick={reset} busy={busy === "reset"}>
            <RotateCcw size={14} />
            Ripristina dati
          </Button>
        </div>
      )}
      <div className="panel-heading">
        <h2>
          <BookOpen size={19} />
          Percorso pratico
        </h2>
        <small>
          {exercises.length
            ? `${Object.values(checks).filter((item) => item.passed).length} / ${exercises.length} verificati`
            : "Apri un laboratorio per attivare gli esercizi"}
        </small>
      </div>
      {exercises.length ? (
        <div className="lesson-grid">
          {exercises.map((exercise, index) => (
            <article
              className={`lesson-card ${checks[exercise.id]?.passed ? "passed" : ""}`}
              key={exercise.id}
            >
              <div className="row">
                <span className="lesson-number">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="spacer" />
                {checks[exercise.id]?.passed ? (
                  <CheckCircle2 className="passed-icon" size={17} />
                ) : (
                  <span className="badge">
                    {exercise.difficulty || "Esercizio"}
                  </span>
                )}
              </div>
              <h3>{exercise.title}</h3>
              <p>{exercise.description}</p>
              {hint === exercise.id && (
                <div className="lesson-hint">
                  {exercise.hints.map((text, i) => (
                    <p key={i}>{text}</p>
                  ))}
                </div>
              )}
              {checks[exercise.id] && (
                <Notice
                  tone={checks[exercise.id].passed ? "success" : "warning"}
                >
                  {checks[exercise.id].message}
                </Notice>
              )}
              <div className="row">
                <Button
                  variant="ghost"
                  onClick={() =>
                    setHint(hint === exercise.id ? null : exercise.id)
                  }
                >
                  <Lightbulb size={13} />
                  Aiuto
                </Button>
                <div className="spacer" />
                <Button
                  onClick={() => {
                    setActiveExercise(exercise.id);
                    onQuery(exercise.query);
                  }}
                >
                  Apri
                  <ArrowRight size={13} />
                </Button>
              </div>
              <Button
                variant={
                  activeExercise === exercise.id ? "primary" : "secondary"
                }
                busy={busy === exercise.id}
                disabled={!query.trim() || !!busy}
                onClick={() => check(exercise)}
              >
                Verifica query corrente
              </Button>
            </article>
          ))}
        </div>
      ) : (
        <div className="lesson-grid">
          {[
            [
              "01",
              "Esplora e filtra",
              "Leggi i record, scegli le colonne e applica condizioni.",
            ],
            [
              "02",
              "Collega e aggrega",
              "Prova JOIN, GROUP BY, conteggi e pipeline MongoDB.",
            ],
            [
              "03",
              "Modifica e controlla",
              "Prepara scritture, confronta risultati e verifica gli esercizi.",
            ],
          ].map(([number, title, text]) => (
            <article className="lesson-card" key={number}>
              <span className="lesson-number">{number}</span>
              <h3>{title}</h3>
              <p>{text}</p>
              <span className="badge">
                Disponibile con un laboratorio aperto
              </span>
            </article>
          ))}
        </div>
      )}
      {activeExercise && checks[activeExercise]?.details !== undefined && (
        <details className="panel">
          <summary>Confronto della verifica</summary>
          <pre className="code-preview">
            {pretty(checks[activeExercise].details)}
          </pre>
        </details>
      )}
    </div>
  );
}
