import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import {
  Bot,
  Circle,
  Copy,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Send,
  Square,
  Trash2,
} from "lucide-react";
import { api } from "../api";
import {
  readAssistantSettings,
  assistantQueryBlocks,
} from "../editor/assistantContext";
import type { CompletionMode } from "../editor/assistantContext";
import type { Engine } from "../types";
import { errorMessage, newId } from "../utils";
import { useConfirmation } from "./ConfirmationProvider";
import { Button, Field, Modal, Notice } from "./UI";
import "./local-assistant.css";

type Startup = "manual" | "automatic";
type Scope = "work" | "quick";
type Settings = Record<string, unknown>;
interface LocalAiConfig {
  endpoint: string;
  model: string;
  startup: Startup | null;
  completionMode: CompletionMode;
}
interface LocalStatus {
  online: boolean;
  installed: boolean;
  ownership?: "owned" | "shared";
  pid?: number;
  stopFingerprint?: string;
  diagnostic: string;
  modelError?: string;
}
interface LocalModel {
  name: string;
  sizeBytes?: number;
  capabilities: string[];
}
interface ControlState {
  config: LocalAiConfig | null;
  status: LocalStatus | null;
  busy: boolean;
  starting: boolean;
  stopping: boolean;
  error: string;
  revision: number;
  refresh: () => Promise<void>;
  save: (config: LocalAiConfig) => Promise<void>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  touchChats: () => void;
}
const AI = createContext<ControlState | null>(null);
const CAPABILITY_LABELS: Record<string, string> = {
  completion: "testo",
  tools: "strumenti",
  thinking: "ragionamento",
  vision: "immagini",
  audio: "audio",
  insert: "completamento nel testo",
};

function statusLabel(status: LocalStatus | null) {
  if (status?.online) return "Ollama attivo";
  if (status?.ownership === "owned") return "Ollama in avvio";
  if (status && !status.installed) return "Ollama non installato";
  return status ? "Ollama spento" : "Verifica Ollama";
}

function baseModel(name: string) {
  return /(?:^|[.:_-])base(?:[._-]|$)/i.test(name);
}

function useLocalAi() {
  const value = useContext(AI);
  if (!value) throw new Error("LocalAiProvider non configurato");
  return value;
}

export function LocalAiProvider({ children }: { children: ReactNode }) {
  const confirm = useConfirmation();
  const [config, setConfig] = useState<LocalAiConfig | null>(null);
  const [status, setStatus] = useState<LocalStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const launchId = useRef<string | null>(null);
  const stoppingNow = useRef(false);
  const statusSequence = useRef(0);
  const [verifyUntil, setVerifyUntil] = useState(0);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [dismissedIntro, setDismissedIntro] = useState(false);
  const startupRequest = useRef(false);
  const sync = useCallback(async () => {
    const sequence = ++statusSequence.current;
    const response = await api<{ config: LocalAiConfig; state: LocalStatus }>(
      "local_ai_status",
    );
    if (sequence === statusSequence.current) {
      setConfig(response.config);
      setStatus(response.state);
    }
  }, []);
  const transition = useCallback(
    async (command?: string, args?: Settings) => {
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError("");
      try {
        if (command) {
          const result = await api(command, args);
          if (command === "local_ai_config") setConfig(result as LocalAiConfig);
        }
        await sync();
      } catch (cause) {
        setError(errorMessage(cause));
        if (command) {
          try {
            await sync();
          } catch {
            /* The first error describes the attempted action. */
          }
        }
      } finally {
        pending.current = false;
        setBusy(false);
      }
    },
    [sync],
  );
  useEffect(() => {
    void transition();
  }, [transition]);
  const launch = useCallback(
    async (automatic: boolean) => {
      if (launchId.current || stoppingNow.current) return;
      const requestId = newId();
      launchId.current = requestId;
      setStarting(true);
      setError("");
      try {
        const result = await api<{
          accepted: boolean;
          state?: LocalStatus | null;
        }>("local_ai_start", { automatic, requestId });
        if (launchId.current !== requestId) return;
        if (result.state) {
          statusSequence.current++;
          setStatus(result.state);
        }
        await sync();
      } catch (cause) {
        if (launchId.current === requestId) setError(errorMessage(cause));
      } finally {
        if (launchId.current === requestId) {
          launchId.current = null;
          setStarting(false);
        }
      }
    },
    [sync],
  );
  useEffect(() => {
    const onFocus = () => void transition();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [transition]);
  useEffect(() => {
    if (busy || !config || config.startup === null || startupRequest.current)
      return;
    startupRequest.current = true;
    if (config.startup === "automatic" && !status?.online) void launch(true);
  }, [busy, config, status?.online, launch]);
  useEffect(() => {
    if (stopping || busy || starting) return;
    if (
      !(status?.ownership === "owned" && !status.online) &&
      Date.now() >= verifyUntil
    )
      return;
    const timer = window.setTimeout(
      () => void sync().catch((cause) => setError(errorMessage(cause))),
      700,
    );
    return () => window.clearTimeout(timer);
  }, [busy, starting, status, stopping, sync, verifyUntil]);
  const refresh = useCallback(() => transition(), [transition]);
  const save = useCallback(
    (next: LocalAiConfig) => transition("local_ai_config", { config: next }),
    [transition],
  );
  const start = useCallback(() => launch(false), [launch]);
  const stop = useCallback(async () => {
    const request = launchId.current;
    const fingerprint = status?.stopFingerprint;
    if ((!fingerprint && !request) || stoppingNow.current) return;
    const shared = !request && status?.ownership === "shared";
    if (
      shared &&
      !(await confirm(
        `Spegnere Ollama condiviso (processo ${status?.pid ?? "—"})? Anche altre applicazioni collegate a questa istanza perderanno l’accesso.`,
      ))
    )
      return;
    if (stoppingNow.current) return;
    startupRequest.current = true;
    stoppingNow.current = true;
    launchId.current = null;
    statusSequence.current++;
    setStarting(false);
    setStopping(true);
    setError("");
    try {
      const target =
        request && status?.ownership !== "owned"
          ? { cancelStart: request }
          : { fingerprint, confirmed: shared };
      await api("local_ai_stop", target);
      if (shared) setVerifyUntil(Date.now() + 12000);
      await sync();
    } catch (cause) {
      setError(errorMessage(cause));
      try {
        await sync();
      } catch {
        /* Keep the original reason. */
      }
    } finally {
      stoppingNow.current = false;
      setStopping(false);
    }
  }, [confirm, status, sync]);
  const touchChats = useCallback(() => setRevision((old) => old + 1), []);
  return (
    <AI.Provider
      value={{
        config,
        status,
        busy,
        starting,
        stopping,
        error,
        revision,
        refresh,
        save,
        start,
        stop,
        touchChats,
      }}
    >
      {children}
      {config && config.startup === null && !dismissedIntro && (
        <Modal title="Avvio di Ollama" onClose={() => setDismissedIntro(true)}>
          <div className="modal-body stack">
            <p>
              Scegli quando avviare il servizio AI locale. Puoi cambiare la
              scelta nelle impostazioni.
            </p>
            <p className="muted">
              Se Ollama è già attivo, Database Manager usa il servizio
              esistente.
            </p>
            {error && <Notice tone="error">{error}</Notice>}
          </div>
          <footer>
            <Button
              disabled={busy}
              onClick={() => void save({ ...config, startup: "manual" })}
            >
              Su richiesta
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void save({ ...config, startup: "automatic" })}
            >
              All’apertura dell’app
            </Button>
          </footer>
        </Modal>
      )}
    </AI.Provider>
  );
}

export function useLocalAiEditorSettings(settings: Settings): Settings {
  const { config } = useLocalAi();
  if (!config || config.startup === null) return settings;
  const existing = readAssistantSettings(settings);
  if (
    existing.provider === "ollama" &&
    existing.endpoint === config.endpoint &&
    existing.model === config.model &&
    existing.completionMode === config.completionMode
  )
    return settings;
  return {
    ...settings,
    ai: {
      provider: "ollama",
      baseUrl: config.endpoint,
      model: config.model,
      completionMode: config.completionMode,
    },
  };
}

export function LocalAiControls({
  variant,
}: {
  variant: "toolbar" | "home" | "settings";
}) {
  const state = useLocalAi();
  if (variant === "toolbar") {
    const switchOff =
      state.starting ||
      state.status?.online ||
      state.status?.ownership === "owned";
    const caption = switchOff
      ? state.status?.online
        ? "Spegni Ollama"
        : "Interrompi avvio Ollama"
      : "Avvia Ollama";
    return (
      <button
        type="button"
        className={`assistant-toggle local-ai-toolbar ${state.status?.online ? "online" : ""}`}
        title={state.error || state.status?.diagnostic || caption}
        aria-label={caption}
        disabled={
          state.stopping ||
          !state.config ||
          (switchOff
            ? !state.starting && !state.status?.stopFingerprint
            : state.busy)
        }
        onClick={() => void (switchOff ? state.stop() : state.start())}
      >
        <Power size={15} aria-hidden="true" />
        <span>{state.stopping ? "Arresto…" : caption}</span>
      </button>
    );
  }
  if (variant === "settings") return <LocalAiSettings />;
  return <LocalAiOverview />;
}

function LocalAiOverview() {
  const {
    status,
    config,
    busy,
    starting,
    stopping,
    error,
    refresh,
    start,
    stop,
  } = useLocalAi();
  const switchOff = starting || status?.online || status?.ownership === "owned";
  return (
    <div className="local-ai-overview">
      <div className="local-ai-state">
        <Circle
          size={10}
          className={status?.online ? "online" : ""}
          aria-hidden="true"
        />
        <strong>
          {starting && !status?.online
            ? "Ollama in avvio"
            : statusLabel(status)}
        </strong>
        {config?.model && <span className="muted">{config.model}</span>}
      </div>
      <div className="row">
        <Button
          variant="ghost"
          onClick={() => void refresh()}
          disabled={busy}
          title="Verifica Ollama"
          aria-label="Verifica Ollama"
        >
          <RefreshCw size={14} />
        </Button>
        <Button
          onClick={() => void (switchOff ? stop() : start())}
          disabled={
            stopping ||
            !config ||
            (switchOff ? !starting && !status?.stopFingerprint : busy)
          }
        >
          <Power size={14} />
          {switchOff
            ? status?.online
              ? "Spegni"
              : "Interrompi avvio"
            : "Avvia"}
        </Button>
      </div>
      {(error || status?.modelError || status?.diagnostic) && (
        <p className={error || status?.modelError ? "local-ai-error" : "muted"}>
          {error || status?.modelError || status?.diagnostic}
        </p>
      )}
    </div>
  );
}

function LocalAiSettings() {
  const { config, status, busy, save } = useLocalAi();
  const [endpoint, setEndpoint] = useState("");
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<LocalModel[] | null>(null);
  const [modelsError, setModelsError] = useState("");
  const selectedModel = models?.find(({ name }) => name === config?.model);
  useEffect(() => {
    if (config) setEndpoint(config.endpoint);
  }, [config?.endpoint]);
  useEffect(() => setModels(null), [endpoint]);
  async function listModels() {
    setLoading(true);
    setModelsError("");
    try {
      setModels(
        await api<LocalModel[]>("local_ai_models", {
          endpoint: endpoint.trim(),
        }),
      );
    } catch (cause) {
      setModelsError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  if (!config) return <LocalAiOverview />;
  return (
    <section className="panel stack local-ai-settings">
      <h2>Ollama locale</h2>
      <LocalAiOverview />
      <Field label="Indirizzo del servizio locale">
        <input
          value={endpoint}
          onChange={(event) => setEndpoint(event.target.value)}
          disabled={busy || loading}
        />
      </Field>
      <div className="row">
        <Button
          onClick={() =>
            void save({ ...config, endpoint: endpoint.trim(), model: "" })
          }
          disabled={
            busy || !endpoint.trim() || config.endpoint === endpoint.trim()
          }
        >
          Applica indirizzo
        </Button>
        <Button
          onClick={() => void listModels()}
          busy={loading}
          disabled={
            busy || !status?.online || config.endpoint !== endpoint.trim()
          }
        >
          Cerca modelli locali
        </Button>
      </div>
      {modelsError && <Notice tone="error">{modelsError}</Notice>}
      {models?.length === 0 && (
        <Notice>
          Nessun modello locale con generazione di testo disponibile.
        </Notice>
      )}
      {models && models.length > 0 && (
        <Field label="Modello locale">
          <select
            value={config.model}
            onChange={(event) =>
              void save({ ...config, model: event.target.value })
            }
            disabled={busy}
          >
            <option value="">Scegli un modello</option>
            {config.model &&
              !models.some(({ name }) => name === config.model) && (
                <option value={config.model}>
                  {config.model} · non disponibile
                </option>
              )}
            {models.map(({ name, sizeBytes }) => (
              <option key={name} value={name}>
                {name}
                {baseModel(name) ? " · base" : ""}
                {sizeBytes
                  ? ` · ${(sizeBytes / 1_000_000_000).toLocaleString("it", { maximumFractionDigits: 1 })} GB`
                  : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      {selectedModel?.capabilities.length ? (
        <p className="muted small">
          Capacità dichiarate dal modello{" "}
          {selectedModel.capabilities
            .map((feature) => CAPABILITY_LABELS[feature] || feature)
            .join(" · ")}
        </p>
      ) : null}
      {selectedModel && baseModel(selectedModel.name) && (
        <p className="muted small">
          Modello base orientato al completamento del testo.
        </p>
      )}
      <div className="two-columns">
        <Field label="Avvio di Ollama">
          <select
            value={config.startup ?? "manual"}
            disabled={busy}
            onChange={(event) =>
              void save({ ...config, startup: event.target.value as Startup })
            }
          >
            <option value="manual">Su richiesta</option>
            <option value="automatic">All’apertura dell’app</option>
          </select>
        </Field>
        <Field label="Completamento Ollama nell’editor">
          <select
            value={config.completionMode}
            disabled={busy}
            onChange={(event) =>
              void save({
                ...config,
                completionMode: event.target.value as CompletionMode,
              })
            }
          >
            <option value="off">Disattivato</option>
            <option value="manual">Su richiesta</option>
            <option value="automatic">Durante la scrittura</option>
          </select>
        </Field>
      </div>
    </section>
  );
}

interface ChatSummary {
  id: string;
  name: string;
  updatedAt: string;
}
interface ChatPair {
  user: string;
  assistant: string;
  model: string;
  engine?: Engine;
  createdAt: string;
}
interface Conversation {
  id: string;
  name: string;
  updatedAt: string;
  turns: ChatPair[];
}
interface ChatProgress {
  requestId: string;
  conversationId: string;
  status: "running" | "complete" | "cancelled" | "failed";
  content: string;
  error?: string;
}

export function LocalAiRecents({
  onSelect,
}: {
  onSelect: (id: string) => void;
}) {
  const { revision } = useLocalAi();
  const [items, setItems] = useState<ChatSummary[]>([]);
  useEffect(() => {
    let live = true;
    void api<ChatSummary[]>("local_ai_conversations", { scope: "work" })
      .then((list) => {
        if (live) setItems(list.slice(0, 5));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [revision]);
  if (!items.length) return null;
  return (
    <section className="local-ai-recents" aria-label="Conversazioni recenti">
      <h2>Conversazioni recenti</h2>
      {items.map(({ id, name }) => (
        <button
          key={id}
          type="button"
          className="text-button"
          title={name}
          onClick={() => onSelect(id)}
        >
          {name}
        </button>
      ))}
    </section>
  );
}

export interface LocalChatContext {
  engine: Engine;
  documentId?: string;
  sessionId?: string;
  quickSessionId?: string;
  query?: string;
  rows?: unknown[];
}

export interface LocalAssistantWorkbenchProps {
  active?: boolean;
  scope?: Scope;
  context?: LocalChatContext;
  initialPrompt?: { id: string; text: string; send?: boolean };
  initialConversationId?: string;
  onClose?: () => void;
  onSuggestion?: (suggestion: { text: string; engine?: Engine }) => void;
  onAction?: (action: {
    type: "project-ai";
    payload?: { text: string };
  }) => void;
}

export function LocalAssistantWorkbench({
  scope = "work",
  active = true,
  ...props
}: LocalAssistantWorkbenchProps) {
  return (
    <>
      <ScopedLocalChat
        key="work"
        {...props}
        scope="work"
        active={active && scope === "work"}
      />
      <ScopedLocalChat
        key="quick"
        {...props}
        scope="quick"
        active={active && scope === "quick"}
      />
    </>
  );
}

function ScopedLocalChat({
  scope,
  active,
  context,
  initialPrompt,
  initialConversationId,
  onClose,
  onSuggestion,
  onAction,
}: LocalAssistantWorkbenchProps & { scope: Scope; active: boolean }) {
  const confirm = useConfirmation();
  const { config, status, busy, revision, touchChats } = useLocalAi();
  const [items, setItems] = useState<ChatSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const conversationDrafts = useRef(new Map<string, string>());
  const currentDraft = useRef({ id: "", text: "" });
  currentDraft.current = { id: conversation?.id || "", text: draft };
  const [loadingChat, setLoadingChat] = useState(false);
  const [query, setQuery] = useState(false);
  const [schema, setSchema] = useState(false);
  const [rows, setRows] = useState(false);
  const [progress, setProgress] = useState<ChatProgress | null>(null);
  const [pending, setPending] = useState<{
    id: string;
    question: string;
  } | null>(null);
  const pendingId = useRef<string | null>(null);
  const cancelRequested = useRef<string | null>(null);
  const promptHandled = useRef("");
  const incoming = useRef<string | undefined>(undefined);
  const [rename, setRename] = useState<string | null>(null);
  const [error, setError] = useState("");
  const chatListToken = useRef(0);
  const selectionToken = useRef(0);
  const log = useRef<HTMLDivElement | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const ready =
    !busy &&
    !loadingChat &&
    Boolean(config?.model && status?.online && !status.modelError);

  const load = useCallback(
    async (id: string, restore = false) => {
      const token = ++selectionToken.current;
      setRename(null);
      setError("");
      if (restore) setLoadingChat(true);
      try {
        const next = await api<Conversation>("local_ai_conversation", {
          id,
          scope,
        });
        if (token === selectionToken.current) {
          if (restore) {
            const prior = currentDraft.current;
            if (prior.id !== id) {
              conversationDrafts.current.set(prior.id, prior.text);
              setDraft(conversationDrafts.current.get(id) || "");
            }
            setProgress(null);
          }
          setConversation(next);
        }
      } catch (cause) {
        if (token === selectionToken.current) setError(errorMessage(cause));
      } finally {
        if (restore && token === selectionToken.current) setLoadingChat(false);
      }
    },
    [scope],
  );

  useEffect(() => {
    if (!active) return;
    const token = ++chatListToken.current;
    void api<ChatSummary[]>("local_ai_conversations", { scope })
      .then((result) => {
        if (token === chatListToken.current) setItems(result);
      })
      .catch((cause) => {
        if (token === chatListToken.current) setError(errorMessage(cause));
      });
    return () => {
      chatListToken.current++;
    };
  }, [active, revision, scope]);

  useEffect(() => {
    if (!active) {
      incoming.current = undefined;
      return;
    }
    if (
      initialConversationId &&
      incoming.current !== initialConversationId &&
      !pendingId.current
    ) {
      incoming.current = initialConversationId;
      void load(initialConversationId, true);
    }
  }, [active, initialConversationId, load]);

  // Context choices apply to the visible workspace target and start unchecked.
  useEffect(() => {
    setQuery(false);
    setSchema(false);
    setRows(false);
  }, [
    context?.sessionId,
    context?.quickSessionId,
    context?.engine,
    context?.documentId,
  ]);

  const send = useCallback(
    async (source: string, startFresh = false) => {
      const message = source.trim();
      if (!message || !ready || pendingId.current) return;
      const requestId = newId();
      pendingId.current = requestId;
      cancelRequested.current = null;
      setPending({ id: requestId, question: message });
      setDraft("");
      setProgress(null);
      setError("");
      setQuery(false);
      setSchema(false);
      setRows(false);
      try {
        const initial = await api<ChatProgress>("local_ai_chat_start", {
          scope,
          requestId,
          message,
          conversationId: startFresh ? undefined : conversation?.id,
          context: context
            ? {
                engine: context.engine,
                sessionId: context.sessionId,
                quickSessionId: context.quickSessionId,
                includeQuery: query && Boolean(context.query),
                includeSchema:
                  schema &&
                  Boolean(context.sessionId || context.quickSessionId),
                includeRows: rows && Boolean(context.rows?.length),
                query: query ? context.query : undefined,
                rows: rows ? context.rows?.slice(0, 20) : undefined,
              }
            : undefined,
        });
        if (pendingId.current === requestId) {
          setProgress(initial);
          if (cancelRequested.current === requestId)
            await api("local_ai_chat_cancel", { requestId });
        }
      } catch (cause) {
        if (pendingId.current !== requestId) return;
        pendingId.current = null;
        setPending(null);
        setDraft((value) => value || message);
        setError(errorMessage(cause));
      }
    },
    [scope, ready, conversation?.id, context, query, schema, rows],
  );

  useEffect(() => {
    if (!active || !initialPrompt || initialPrompt.id === promptHandled.current)
      return;
    const startFresh = !initialConversationId && !pendingId.current;
    if (startFresh) {
      const prior = currentDraft.current;
      if (prior.id) conversationDrafts.current.set(prior.id, prior.text);
      selectionToken.current++;
      setLoadingChat(false);
      setConversation(null);
      setProgress(null);
      setRename(null);
    }
    if (initialPrompt.send && ready && !pendingId.current) {
      promptHandled.current = initialPrompt.id;
      void send(initialPrompt.text, startFresh);
    } else {
      promptHandled.current = initialPrompt.id;
      setDraft(initialPrompt.text);
    }
  }, [active, initialPrompt, initialConversationId, ready, send]);

  useEffect(() => {
    if (!pending || !progress || progress.status !== "running") return;
    const { id, question } = pending;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await api<ChatProgress>("local_ai_chat_poll", {
          requestId: id,
        });
        if (!current || pendingId.current !== id) return;
        if (next.status === "running") {
          setProgress(next);
          timer = setTimeout(poll, 220);
          return;
        }
        await load(next.conversationId);
        if (next.status !== "complete") {
          setDraft((value) => value || question);
          if (next.status === "failed")
            setError(next.error || "Risposta Ollama non riuscita.");
        }
        if (!current || pendingId.current !== id) return;
        setProgress(next);
        pendingId.current = null;
        setPending(null);
        touchChats();
      } catch (cause) {
        if (!current || pendingId.current !== id) return;
        // Fail closed on transport loss so an old request cannot write into a new chat.
        void api("local_ai_chat_cancel", { requestId: id }).catch(() => {});
        setError(errorMessage(cause));
        setDraft((value) => value || question);
        setProgress(null);
        pendingId.current = null;
        setPending(null);
      }
    }
    timer = setTimeout(poll, 220);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [pending, progress?.status, load, touchChats]);

  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [active, progress?.content, pending, conversation]);

  async function cancel() {
    if (!pendingId.current) return;
    cancelRequested.current = pendingId.current;
    try {
      await api("local_ai_chat_cancel", { requestId: pendingId.current });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function saveName() {
    if (!conversation || !rename?.trim()) return;
    try {
      await api("local_ai_rename_conversation", {
        id: conversation.id,
        scope,
        name: rename.trim(),
      });
      await load(conversation.id);
      touchChats();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  async function deleteChat() {
    if (
      !conversation ||
      !(await confirm(
        `Eliminare dal PC la conversazione «${conversation.name}»?`,
      ))
    )
      return;
    try {
      await api("local_ai_delete_conversation", { id: conversation.id, scope });
      setConversation(null);
      setProgress(null);
      setRename(null);
      touchChats();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  if (!active) return null;
  return (
    <section
      className="local-ai-workbench"
      aria-label={
        scope === "quick" ? "Chat locale Query rapide" : "Chat locale"
      }
    >
      <header className="local-ai-chat-header">
        <Bot size={19} aria-hidden="true" />
        <div>
          <h2>{scope === "quick" ? "Chat Query rapide" : "Chat locale"}</h2>
          <small>
            {config?.model || "Modello da scegliere"} · {statusLabel(status)}
          </small>
        </div>
        <span className="spacer" />
        <div className="local-ai-drawer-switch">
          <LocalAiControls variant="toolbar" />
        </div>
        {onAction && (
          <Button
            variant="ghost"
            onClick={() =>
              onAction({ type: "project-ai", payload: { text: draft.trim() } })
            }
          >
            AI progetto
          </Button>
        )}
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            Chiudi
          </Button>
        )}
      </header>
      <div className="local-ai-chat-tools">
        <Button
          onClick={() => {
            const prior = currentDraft.current;
            if (prior.id) conversationDrafts.current.set(prior.id, prior.text);
            selectionToken.current++;
            setLoadingChat(false);
            setConversation(null);
            setRename(null);
            setProgress(null);
            setError("");
            setDraft("");
          }}
          disabled={Boolean(pending)}
        >
          <Plus size={15} /> Nuova chat
        </Button>
        <select
          aria-label="Conversazioni salvate"
          value={conversation?.id || ""}
          onChange={(event) => {
            if (event.target.value) void load(event.target.value, true);
          }}
          disabled={Boolean(pending)}
        >
          <option value="">Chat salvate</option>
          {items.map(({ id, name }) => (
            <option value={id} key={id}>
              {name}
            </option>
          ))}
        </select>
        {conversation && (
          <>
            <Button
              variant="ghost"
              aria-label="Rinomina conversazione"
              title="Rinomina"
              disabled={Boolean(pending)}
              onClick={() => setRename(conversation.name)}
            >
              <Pencil size={15} />
            </Button>
            <Button
              variant="ghost"
              aria-label="Elimina conversazione"
              title="Elimina"
              disabled={Boolean(pending)}
              onClick={() => void deleteChat()}
            >
              <Trash2 size={15} />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          aria-expanded={showConfig}
          onClick={() => setShowConfig((value) => !value)}
        >
          Ollama
        </Button>
      </div>
      {rename !== null && (
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void saveName();
          }}
        >
          <input
            aria-label="Titolo della conversazione"
            value={rename}
            maxLength={120}
            onChange={(event) => setRename(event.target.value)}
            autoFocus
          />
          <Button variant="primary" type="submit">
            Salva
          </Button>
          <Button type="button" onClick={() => setRename(null)}>
            Annulla
          </Button>
        </form>
      )}
      {(showConfig ||
        !config?.model ||
        !status?.online ||
        status.modelError) && <LocalAiSettings />}
      <div
        className="local-ai-transcript"
        ref={log}
        role="log"
        aria-live="polite"
      >
        {!conversation?.turns.length && !pending && (
          <p className="local-ai-chat-empty">
            Scrivi una domanda o chiedi aiuto con una query.
          </p>
        )}
        {conversation?.turns.map((pair, index) => (
          <div className="local-ai-pair" key={`${pair.createdAt}:${index}`}>
            <div className="local-ai-user">{pair.user}</div>
            <ChatAnswer
              text={pair.assistant}
              engine={pair.engine}
              onSuggestion={onSuggestion}
            />
          </div>
        ))}
        {pending && <div className="local-ai-user">{pending.question}</div>}
        {progress?.content && (pending || progress.status !== "complete") && (
          <ChatAnswer text={progress.content} engine={context?.engine} />
        )}
        {pending && !progress?.content && (
          <p className="muted">Attendo la risposta di Ollama…</p>
        )}
        {progress?.status === "cancelled" && (
          <p className="muted">Risposta interrotta.</p>
        )}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <form
        className="local-ai-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        {context && (
          <div className="local-ai-context">
            <span>Contesto della prossima domanda</span>
            <label>
              <input
                type="checkbox"
                checked={query}
                disabled={Boolean(pending) || !context.query}
                onChange={(event) => setQuery(event.target.checked)}
              />{" "}
              Query
            </label>
            <label>
              <input
                type="checkbox"
                checked={schema}
                disabled={
                  Boolean(pending) ||
                  !(context.sessionId || context.quickSessionId)
                }
                onChange={(event) => setSchema(event.target.checked)}
              />{" "}
              Schema
            </label>
            <label>
              <input
                type="checkbox"
                checked={rows}
                disabled={Boolean(pending) || !context.rows?.length}
                onChange={(event) => setRows(event.target.checked)}
              />{" "}
              Fino a 20 righe
            </label>
          </div>
        )}
        <div className="local-ai-composer">
          <textarea
            rows={3}
            value={draft}
            maxLength={8192}
            aria-label="Messaggio per la chat locale"
            placeholder="Scrivi un messaggio…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          {pending ? (
            <Button type="button" onClick={() => void cancel()}>
              <Square size={15} /> Interrompi
            </Button>
          ) : (
            <Button
              variant="primary"
              type="submit"
              disabled={!ready || !draft.trim()}
            >
              <Send size={15} /> Invia
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

function ChatAnswer({
  text,
  engine,
  onSuggestion,
}: {
  text: string;
  engine?: Engine;
  onSuggestion?: LocalAssistantWorkbenchProps["onSuggestion"];
}) {
  const parsed = text.split(
    /(^[\t ]*```[\w-]*[\t ]*\r?\n[\s\S]*?^[\t ]*```[\t ]*$)/gm,
  );
  return (
    <div className="local-ai-answer">
      {parsed.map((part, index) => {
        if (!part.trim()) return null;
        if (index % 2 === 0)
          return (
            <div className="local-ai-prose" key={index}>
              <ChatProse text={part.trim()} />
            </div>
          );
        const [, language, code] =
          part
            .trim()
            .match(/^```([\w-]*)[^\S\r\n]*\r?\n([\s\S]*?)\r?\n[	 ]*```$/) || [];
        if (!code)
          return (
            <div className="local-ai-prose" key={index}>
              <ChatProse text={part.trim()} />
            </div>
          );
        const candidate = assistantQueryBlocks(
          part.trim(),
          engine === "mongodb",
        )[0];
        return (
          <div className="local-ai-code" key={index}>
            <div className="row">
              <span>{language || "Codice"}</span>
              <span className="spacer" />
              <Button
                variant="ghost"
                onClick={() =>
                  void navigator.clipboard.writeText(code).catch(() => {})
                }
              >
                <Copy size={13} /> Copia
              </Button>
              {candidate && onSuggestion && (
                <Button
                  variant="ghost"
                  onClick={() => onSuggestion({ text: candidate, engine })}
                >
                  Inserisci in editor
                </Button>
              )}
            </div>
            <pre>
              <code>{code}</code>
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function ChatProse({ text }: { text: string }) {
  return text.split(/\r?\n/).map((line, index) => {
    const heading = line.match(/^#{1,6}\s+(.+)/);
    const inline = (heading?.[1] || line)
      .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
      .map((item, position) => {
        if (item.startsWith("**") && item.endsWith("**"))
          return <strong key={position}>{item.slice(2, -2)}</strong>;
        if (item.startsWith("`") && item.endsWith("`"))
          return <code key={position}>{item.slice(1, -1)}</code>;
        return item;
      });
    return heading ? (
      <h3 key={index}>{inline}</h3>
    ) : (
      <div key={index}>{inline.length && line ? inline : "\u00a0"}</div>
    );
  });
}
