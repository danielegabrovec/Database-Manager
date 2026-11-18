import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { buildOperation, INITIAL_READ } from "./designer/readOperation";
import type { QuickHistoryEntry } from "./components/QuickQueriesSidebar";
import type {
  ConnectionProfile,
  QueryResult,
  SchemaSnapshot,
  TableInfo,
} from "./types";
import { errorMessage, newId, objectLabel } from "./utils";

interface QuickSession {
  sessionId: string;
  profile: ConnectionProfile;
  schema: SchemaSnapshot;
  dataset: string;
  mode: "synthetic" | "sqlite_copy";
}

function parseParameters(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Scrivi i parametri come oggetto JSON.");
  }
  return parsed as Record<string, unknown>;
}

export function useQuickQueries(active: boolean) {
  const [session, setSession] = useState<QuickSession | null>(null);
  const [query, setQuery] = useState("SELECT * FROM customers LIMIT 25;");
  const [parametersText, setParametersText] = useState("{}");
  const [history, setHistory] = useState<QuickHistoryEntry[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const activeSession = useRef<QuickSession | null>(null);
  const attempted = useRef(false);
  const inFlight = useRef(false);

  function adopt(next: QuickSession) {
    activeSession.current = next;
    setSession(next);
    setResult(null);
    setMessage(
      next.mode === "sqlite_copy"
        ? "Copia di simulazione pronta."
        : "Database sintetico pronto.",
    );
  }

  async function open(sourceSessionId?: string) {
    if (inFlight.current) return;
    attempted.current = true;
    inFlight.current = true;
    setOpening(true);
    setError("");
    try {
      const previous = activeSession.current;
      const next = await api<QuickSession>("quick_query_open", {
        engine: "sqlite",
        sourceSessionId,
      });
      adopt(next);
      if (previous && previous.sessionId !== next.sessionId) {
        void api("quick_query_close", { sessionId: previous.sessionId }).catch(
          () => {},
        );
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setOpening(false);
    }
  }

  useEffect(() => {
    if (active && !attempted.current) void open();
  }, [active]);

  async function reset() {
    const prior = activeSession.current;
    if (!prior || inFlight.current) return;
    inFlight.current = true;
    setResetting(true);
    setError("");
    try {
      adopt(
        await api<QuickSession>("quick_query_reset", {
          sessionId: prior.sessionId,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      inFlight.current = false;
      setResetting(false);
    }
  }

  async function cancel() {
    const current = activeSession.current;
    if (!current || !busy) return;
    try {
      setMessage(
        await api<string>("quick_query_cancel", {
          sessionId: current.sessionId,
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function execute(table?: TableInfo) {
    const current = activeSession.current;
    if (!current || inFlight.current || (!table && !query.trim())) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setMessage(
      table
        ? `Lettura di ${objectLabel(table)}…`
        : "Esecuzione nel database di simulazione…",
    );
    setResult(null);
    const entry = {
      id: newId(),
      query,
      parametersText,
      engine: current.schema.engine,
      executedAt: new Date().toISOString(),
    };
    const start = performance.now();
    try {
      const read =
        table &&
        buildOperation(
          current.schema.engine,
          table,
          current.schema,
          INITIAL_READ,
        );
      const next = await api<QueryResult>("quick_query_execute", {
        sessionId: current.sessionId,
        query: read ? read.query : query,
        parameters: read ? {} : parseParameters(parametersText),
      });
      if (activeSession.current !== current) return;
      setResult(next);
      setMessage(
        table
          ? `${objectLabel(table)} · ${next.sets[0]?.rows.length ?? 0} righe`
          : next.message,
      );
      if (!table)
        setHistory((old) =>
          [
            { ...entry, success: true, elapsedMs: next.elapsedMs },
            ...old,
          ].slice(0, 50),
        );
    } catch (cause) {
      if (activeSession.current !== current) return;
      const reason = errorMessage(cause);
      setError(reason);
      setMessage("");
      if (!table)
        setHistory((old) =>
          [
            {
              ...entry,
              success: false,
              elapsedMs: Math.round(performance.now() - start),
              error: reason,
            },
            ...old,
          ].slice(0, 50),
        );
    } finally {
      if (!table && activeSession.current === current) {
        try {
          const schema = await api<SchemaSnapshot>("quick_query_schema", {
            sessionId: current.sessionId,
          });
          const updated = { ...current, schema };
          activeSession.current = updated;
          setSession(updated);
        } catch {
          // Keep the latest known structure if introspection is temporarily unavailable.
        }
      }
      inFlight.current = false;
      setBusy(false);
    }
  }

  function restore(entry: QuickHistoryEntry) {
    setQuery(entry.query);
    setParametersText(entry.parametersText ?? "{}");
    setError("");
  }

  return {
    session,
    query,
    setQuery,
    parametersText,
    setParametersText,
    history,
    result,
    busy,
    opening,
    resetting,
    error,
    message,
    open,
    reset,
    cancel,
    execute,
    restore,
  };
}
