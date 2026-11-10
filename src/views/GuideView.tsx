import { useMemo, useState } from "react";
import {
  BookOpen,
  Check,
  Copy,
  FileCode2,
  Search,
  Terminal,
} from "lucide-react";
import type { Engine } from "../types";
import { ENGINES, ENGINE_LABELS } from "../types";
import { guideSteps, queryRecipes, GUIDE_SOURCES } from "../help/guideContent";
import { Button, Field, Notice } from "../components/UI";
import { errorMessage } from "../utils";
import "../guide.css";

export function GuideView({
  initialEngine,
  onOpenQuery,
  onOpenPowerShell,
}: {
  initialEngine: Engine;
  onOpenQuery: (code: string, engine: Engine, title: string) => void;
  onOpenPowerShell: () => void;
}) {
  const [engine, setEngine] = useState(initialEngine);
  const [tab, setTab] = useState<"steps" | "queries">("steps");
  const [search, setSearch] = useState("");
  const [copied, setCopied] = useState("");
  const [error, setError] = useState("");
  const items = useMemo(
    () =>
      tab === "steps"
        ? guideSteps(engine)
        : queryRecipes(engine).map((recipe) => ({
            ...recipe,
            code: recipe.sql,
            language:
              engine === "mongodb" ? ("json" as const) : ("sql" as const),
          })),
    [tab, engine],
  );
  const matching = items.filter((item) =>
    `${item.title} ${item.explanation} ${item.code || ""}`
      .toLocaleLowerCase("it")
      .includes(search.trim().toLocaleLowerCase("it")),
  );
  async function copy(code: string, id: string) {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(id);
      setError("");
    } catch (error) {
      setError(errorMessage(error));
    }
  }
  return (
    <div className="guide-view">
      <div className="guide-toolbar">
        <Field label="Motore della guida">
          <select
            value={engine}
            onChange={(event) => {
              setEngine(event.target.value as Engine);
              setCopied("");
            }}
          >
            {ENGINES.map((engine) => (
              <option key={engine} value={engine}>
                {ENGINE_LABELS[engine]}
              </option>
            ))}
          </select>
        </Field>
        <label className="guide-search">
          <Search size={16} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            aria-label="Cerca nella guida"
            placeholder="Cerca comandi, operazioni o esempi…"
          />
        </label>
        <Button onClick={onOpenPowerShell}>
          <Terminal size={15} />
          Catalogo PowerShell
        </Button>
      </div>
      <div
        className="guide-tabs"
        role="tablist"
        aria-label="Sezioni della guida"
      >
        <button
          role="tab"
          aria-selected={tab === "steps"}
          aria-controls="guide-content"
          id="guide-steps"
          onClick={() => setTab("steps")}
        >
          <BookOpen size={16} />
          Passo passo
        </button>
        <button
          role="tab"
          aria-selected={tab === "queries"}
          aria-controls="guide-content"
          id="guide-queries"
          onClick={() => setTab("queries")}
        >
          <FileCode2 size={16} />
          Prontuario query · {queryRecipes(engine).length} esempi
        </button>
      </div>
      <Notice>
        Guida offline con dati sintetici. Le istruzioni sono esempi per un
        laboratorio dedicato. Aprire una query prepara una scheda: l’esecuzione
        richiede un’azione separata nella connessione scelta.
      </Notice>
      {error && <Notice tone="error">{error}</Notice>}
      <div
        id="guide-content"
        className="guide-articles"
        role="tabpanel"
        aria-labelledby={tab === "steps" ? "guide-steps" : "guide-queries"}
      >
        {!matching.length && (
          <p>
            Nessun esempio corrispondente. Prova un’altra parola o azzera la
            ricerca.
          </p>
        )}
        {matching.map((item) => (
          <article key={item.title}>
            <h3>{item.title}</h3>
            <p>{item.explanation}</p>
            {item.code &&
              (() => {
                let blocks = [item.code];
                if (item.language === "json") {
                  try {
                    const value = JSON.parse(item.code);
                    if (Array.isArray(value))
                      blocks = value.map((command) =>
                        JSON.stringify(command, null, 2),
                      );
                  } catch {}
                }
                return blocks.map((code, index) => (
                  <div className="guide-code" key={index}>
                    <div className="guide-code-actions">
                      <span>
                        {item.language === "powershell"
                          ? "PowerShell"
                          : item.language === "json"
                            ? `Comando MongoDB ${blocks.length > 1 ? index + 1 : ""}`
                            : "SQL"}
                      </span>
                      <Button
                        onClick={() => void copy(code, item.title + index)}
                      >
                        {copied === item.title + index ? (
                          <Check size={14} />
                        ) : (
                          <Copy size={14} />
                        )}
                        {copied === item.title + index ? "Copiato" : "Copia"}
                      </Button>
                      {item.language !== "powershell" && (
                        <Button
                          onClick={() => onOpenQuery(code, engine, item.title)}
                        >
                          Apri nell’editor
                        </Button>
                      )}
                    </div>
                    <pre tabIndex={0}>
                      <code>{code}</code>
                    </pre>
                  </div>
                ));
              })()}
          </article>
        ))}
        <details className="guide-sources">
          <summary>Fonti ufficiali e approfondimenti</summary>
          {GUIDE_SOURCES.map(([label, url]) => (
            <a key={url} href={url} target="_blank" rel="noreferrer">
              {label}
            </a>
          ))}
        </details>
      </div>
    </div>
  );
}
