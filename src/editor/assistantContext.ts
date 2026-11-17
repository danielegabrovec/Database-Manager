const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
const MAX_HISTORY_BYTES = 32 * 1024;

export interface AssistantTurn {
  user: string;
  assistant: string;
}

export type CompletionMode = "off" | "manual" | "automatic";

export interface AssistantSettings {
  provider: "ollama" | "openai-compatible";
  endpoint: string;
  model: string;
  completionMode: CompletionMode;
}

export function readAssistantSettings(
  settings: Record<string, unknown>,
): AssistantSettings {
  const ai = (
    settings.ai && typeof settings.ai === "object" ? settings.ai : {}
  ) as Record<string, unknown>;
  return {
    provider:
      ai.provider === "openai-compatible" ? "openai-compatible" : "ollama",
    endpoint: typeof ai.baseUrl === "string" ? ai.baseUrl : DEFAULT_ENDPOINT,
    model: typeof ai.model === "string" ? ai.model : "",
    completionMode:
      ai.completionMode === "manual" || ai.completionMode === "automatic"
        ? ai.completionMode
        : "off",
  };
}

export function assistantHistory(turns: AssistantTurn[]): AssistantTurn[] {
  const recent: AssistantTurn[] = [];
  const utf8 = new TextEncoder();
  let remaining = MAX_HISTORY_BYTES;
  for (const turn of turns.slice(-4).reverse()) {
    const size =
      utf8.encode(turn.user).length + utf8.encode(turn.assistant).length;
    if (size > remaining) break;
    recent.unshift(turn);
    remaining -= size;
  }
  return recent;
}

export function assistantQueryBlocks(text: string, mongodb: boolean): string[] {
  const languages = mongodb
    ? ["json", "mql", "mongodb"]
    : ["sql", "sqlite", "psql", "postgresql", "mysql", "mariadb"];
  const blocks = [];
  for (const match of text.matchAll(
    /^\s*```([\w-]*)[^\S\r\n]*\r?\n([\s\S]*?)^\s*```[^\S\r\n]*$/gm,
  )) {
    const language = match[1].toLowerCase();
    const body = match[2].trim();
    if (!body) continue;
    if (mongodb) {
      if (language && !languages.includes(language)) continue;
      try {
        const command = JSON.parse(body);
        if (command && typeof command === "object" && !Array.isArray(command))
          blocks.push(body);
      } catch {
        // The query editor expects Extended JSON, including for MongoDB.
      }
    } else if (languages.includes(language)) {
      blocks.push(body);
    }
  }
  return blocks;
}
