import { describe, expect, it } from "vitest";
import {
  assistantHistory,
  assistantQueryBlocks,
  readAssistantSettings,
} from "./assistantContext";
import {
  completionWindow,
  insertionWithoutEcho,
  isLocalCompletionEnabled,
} from "./localCompletion";

describe("assistant context", () => {
  it("requires explicit local completion settings", () => {
    expect(readAssistantSettings({}).completionMode).toBe("off");
    expect(isLocalCompletionEnabled({ ai: { model: "local" } })).toBe(false);
    expect(
      isLocalCompletionEnabled({
        ai: {
          provider: "openai-compatible",
          completionMode: "automatic",
          model: "remote",
        },
      }),
    ).toBe(false);
    expect(
      isLocalCompletionEnabled({
        ai: { model: "local", completionMode: "manual" },
      }),
    ).toBe(true);
  });

  it("keeps a contiguous, bounded slice of history", () => {
    const turns = Array.from({ length: 6 }, (_, index) => ({
      user: String(index),
      assistant: "answer",
    }));
    expect(assistantHistory(turns)).toEqual(turns.slice(-4));
    expect(
      assistantHistory([
        ...turns,
        { user: "short", assistant: "🍵".repeat(8192) },
      ]),
    ).toEqual([]);
  });

  it("extracts all matching code blocks for the editor dialect", () => {
    const text = [
      "Prova questi esempi.",
      "```sql",
      "SELECT 1;",
      "```",
      "",
      "```json",
      '{"find":"books"}',
      "```",
      "",
      "```mql",
      '{"aggregate":"books","pipeline":[],"cursor":{}}',
      "```",
      "",
      "```json",
      "db.books.find({})",
      "```",
      "",
      "```sqlite",
      "SELECT 2;",
      "```",
    ].join("\n");
    expect(assistantQueryBlocks(text, false)).toEqual([
      "SELECT 1;",
      "SELECT 2;",
    ]);
    expect(assistantQueryBlocks(text, true)).toEqual([
      '{"find":"books"}',
      '{"aggregate":"books","pipeline":[],"cursor":{}}',
    ]);
  });

  it("clips editor context without splitting Unicode pairs", () => {
    const leading = "🍵" + "a".repeat(4095);
    const trailing = "b".repeat(2047) + "🍵";
    expect(completionWindow(leading + trailing, leading.length)).toEqual({
      prefix: "a".repeat(4095),
      suffix: "b".repeat(2047),
    });
  });

  it("inserts only the missing text when a local model echoes the query", () => {
    expect(
      insertionWithoutEcho(
        "SELECT 1 + 1 AS risultato;",
        "SELECT 1 +",
        " AS risultato;",
      ),
    ).toBe(" 1");
    expect(insertionWithoutEcho(" 1", "SELECT 1 +", " AS risultato;")).toBe(
      " 1",
    );
    expect(insertionWithoutEcho(";", "SELECT 1", ";")).toBe("");
  });
});
