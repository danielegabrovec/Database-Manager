import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import type { ColumnInfo, DataRow, QueryResult } from "./types";

interface QueryStreamEvent {
  event: "columns" | "rows" | "complete";
  setIndex?: number;
  columns?: ColumnInfo[];
  rows?: DataRow[];
  table?: string;
  truncated?: boolean;
  elapsedMs?: number;
  affectedRows?: number;
  message?: string;
}

export async function executeQuery(
  args: {
    sessionId: string;
    query: string;
    parameters: Record<string, unknown>;
    executionMode: string;
  },
  onProgress?: (count: number) => void,
): Promise<QueryResult> {
  if (!isTauri()) return api<QueryResult>("execute_query", args);
  const result: QueryResult = {
    sets: [],
    elapsedMs: 0,
    affectedRows: 0,
    message: "",
  };
  let count = 0;
  let finish: () => void = () => {};
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const channel = new Channel<QueryStreamEvent>();
  channel.onmessage = (event) => {
    const index = event.setIndex ?? 0;
    if (event.event === "columns")
      result.sets[index] = {
        columns: event.columns ?? [],
        rows: [],
        table: event.table,
        truncated: event.truncated,
      };
    if (event.event === "rows") {
      const set = result.sets[index];
      if (!set) return;
      const incoming = event.rows ?? [];
      const kept = incoming.slice(0, Math.max(0, 10000 - count));
      set.rows.push(...kept);
      count += kept.length;
      if (kept.length < incoming.length) set.truncated = true;
      onProgress?.(count);
    }
    if (event.event === "complete") {
      result.elapsedMs = event.elapsedMs ?? 0;
      result.affectedRows = event.affectedRows ?? 0;
      result.message = event.message ?? "Query completata";
      finish();
    }
  };
  try {
    await invoke("execute_query_stream", {
      sessionId: args.sessionId,
      query: args.query,
      parameters: args.parameters,
      onEvent: channel,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        completed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Trasferimento dei risultati incompleto. La query potrebbe essere terminata: verifica prima di ripeterla.",
                ),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return result;
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
}

export async function api<T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  try {
    if (isTauri()) return await invoke<T>("backend_call", { command, args });
    const response = await fetch(`/api/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    const raw = await response.text();
    let data: unknown;
    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(
        `Il servizio locale ha risposto con un formato non valido (${response.status}).`,
      );
    }
    if (!response.ok) {
      const err = data as { error?: string; message?: string } | null;
      throw new Error(
        err?.error ||
          err?.message ||
          `Richiesta non riuscita (${response.status}).`,
      );
    }
    return data as T;
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error(
        "Servizio locale non raggiungibile. Avvia il backend Database Manager e riprova.",
      );
    throw error instanceof Error ? error : new Error(String(error));
  }
}
