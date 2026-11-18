import type * as Monaco from "monaco-editor";
import { api } from "../api";
import type { Engine } from "../types";
import { errorMessage } from "../utils";
import { readAssistantSettings } from "./assistantContext";

export interface LocalCompletionContext {
  settings: Record<string, unknown>;
  engine: Engine;
  documentId: string;
  quickSessionId?: string;
}

export function isLocalCompletionEnabled(settings: Record<string, unknown>) {
  const config = readAssistantSettings(settings);
  return (
    config.provider === "ollama" &&
    Boolean(config.model.trim()) &&
    config.completionMode !== "off"
  );
}

export function completionWindow(text: string, offset: number) {
  const prefix = text.slice(Math.max(0, offset - 4096), offset);
  const suffix = text.slice(offset, offset + 2048);
  return {
    prefix: prefix.replace(/^[\udc00-\udfff]/, ""),
    suffix: suffix.replace(/[\ud800-\udbff]$/, ""),
  };
}

export function insertionWithoutEcho(
  suggestion: string,
  prefix: string,
  suffix: string,
) {
  let insertion = suggestion;
  const currentLineStart = prefix.slice(prefix.lastIndexOf("\n") + 1);
  const currentLineEnd = suffix.split("\n", 1)[0];
  // Some models return a full statement even with a schema for insertion text.
  for (const start of [prefix, currentLineStart]) {
    if (start.trim().length >= 4 && insertion.startsWith(start)) {
      insertion = insertion.slice(start.length);
      break;
    }
  }
  for (const end of [suffix, currentLineEnd]) {
    if (end && insertion.endsWith(end)) {
      insertion = insertion.slice(0, -end.length);
      break;
    }
  }
  return insertion;
}

export function installLocalCompletion(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  getContext: () => LocalCompletionContext,
  notify: (message: string, error?: boolean) => void,
): Monaco.IDisposable {
  const empty = { items: [] };
  let pending: Promise<string> | undefined;
  let disposed = false;
  const provider = monaco.languages.registerInlineCompletionsProvider(
    ["sql", "json"],
    {
      displayName: "Ollama locale",
      debounceDelayMs: 600,
      async provideInlineCompletions(model, position, context, token) {
        const saved = getContext();
        const config = readAssistantSettings(saved.settings);
        const explicit =
          context.triggerKind ===
          monaco.languages.InlineCompletionTriggerKind.Explicit;
        if (
          !isLocalCompletionEnabled(saved.settings) ||
          saved.quickSessionId === "" ||
          (!explicit &&
            (config.completionMode !== "automatic" ||
              context.selectedSuggestionInfo)) ||
          !context.includeInlineCompletions ||
          model.getLanguageId() !==
            (saved.engine === "mongodb" ? "json" : "sql")
        )
          return empty;
        const version = model.getVersionId();
        const matchesEditor = () => {
          const current = getContext();
          const next = readAssistantSettings(current.settings);
          return (
            !disposed &&
            !token.isCancellationRequested &&
            editor.getModel() === model &&
            model.getVersionId() === version &&
            editor.getPosition()?.equals(position) === true &&
            editor.getSelection()?.isEmpty() === true &&
            current.documentId === saved.documentId &&
            current.quickSessionId === saved.quickSessionId &&
            current.engine === saved.engine &&
            next.provider === config.provider &&
            next.endpoint === config.endpoint &&
            next.model === config.model &&
            next.completionMode === config.completionMode
          );
        };
        if (!matchesEditor()) return empty;
        if (pending) {
          // Wait for at most one local inference. Monaco cancels old cursor requests.
          await pending.catch(() => {});
        }
        if (!matchesEditor() || pending) return empty;
        const { prefix, suffix } = completionWindow(
          model.getValue(),
          model.getOffsetAt(position),
        );
        if (
          !prefix.trim() ||
          (/[\p{L}\p{N}_$]$/u.test(prefix) && /^[\p{L}\p{N}_$]/u.test(suffix))
        ) {
          return empty;
        }
        const request = api<string>("assistant_completion", {
          request: {
            engine: saved.engine,
            quickSessionId: saved.quickSessionId,
            endpoint: config.endpoint,
            model: config.model,
            trigger: explicit ? "manual" : "automatic",
            prefix,
            suffix,
          },
        });
        pending = request;
        try {
          const insertText = insertionWithoutEcho(
            await request,
            prefix,
            suffix,
          );
          if (
            !matchesEditor() ||
            !insertText.trim() ||
            suffix.startsWith(insertText)
          ) {
            return empty;
          }
          return {
            items: [
              {
                insertText,
                range: monaco.Range.fromPositions(position),
              },
            ],
          };
        } catch (error) {
          if (explicit && matchesEditor()) notify(errorMessage(error), true);
          return empty;
        } finally {
          if (pending === request) pending = undefined;
        }
      },
      disposeInlineCompletions() {},
    },
  );
  const action = editor.addAction({
    id: "dbm.requestLocalCompletion",
    label: "Chiedi un suggerimento a Ollama",
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.Space,
    ],
    run(current) {
      const context = getContext();
      if (
        !isLocalCompletionEnabled(context.settings) ||
        context.quickSessionId === ""
      ) {
        notify(
          "Abilita i suggerimenti nell’editor nelle impostazioni di Ollama.",
        );
        return;
      }
      current.focus();
      return current.getAction("editor.action.inlineSuggest.trigger")?.run();
    },
  });
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      action.dispose();
      provider.dispose();
    },
  };
}
