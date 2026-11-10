import { describe, expect, it } from "vitest";
import {
  captureFileRecovery,
  restoreFileRecovery,
  needsFileRecovery,
  MAX_FILE_RECOVERY_CHARACTERS,
} from "./fileRecovery";
import type { OpenDocument } from "../views/OpenFilesView";

const file: OpenDocument = {
  name: "città.sql",
  path: "C:\\Dati\\città.sql",
  fingerprint: "original-sha",
  content: "SELECT 'è';\r\n",
  kind: "sql",
  extension: "sql",
  encoding: "utf-16le-bom",
  origin: "disk",
  sizeBytes: 32,
  readOnly: false,
  requiresEncoding: false,
  syntaxLanguage: "sql",
  warnings: [],
};

describe("file center recovery after an interruption", () => {
  it("keeps baseline, encoding and original fingerprint so a recovered save still detects external edits", () => {
    const snapshot = captureFileRecovery(
      file,
      "SELECT 'modificato';\r\n",
      true,
    );
    const restored = restoreFileRecovery(JSON.parse(JSON.stringify(snapshot)))!;
    expect(restored).toEqual(snapshot);
    expect(restored.document.content).toBe(file.content);
    expect(restored.document.fingerprint).toBe("original-sha");
    expect(restored.draft).not.toBe(restored.document.content);
    expect(restored.editing).toBe(true);
  });
  it("does not silently truncate text or restore writable bindings with missing guards", () => {
    const snapshot = captureFileRecovery(file, "SELECT 2", false)!;
    for (const patch of [
      { fingerprint: undefined },
      { path: undefined },
      { encoding: undefined },
      { kind: "sqlite" },
      { content: null },
    ]) {
      expect(
        restoreFileRecovery({ ...snapshot, document: { ...file, ...patch } }),
      ).toBeNull();
    }
    expect(() =>
      captureFileRecovery(
        file,
        "x".repeat(MAX_FILE_RECOVERY_CHARACTERS),
        false,
      ),
    ).toThrow(/limite/);
    expect(
      restoreFileRecovery({
        ...snapshot,
        draft: "x".repeat(MAX_FILE_RECOVERY_CHARACTERS),
      }),
    ).toBeNull();
  });
  it("preserves generated scripts even before their first edit, without a disk binding", () => {
    const generated: OpenDocument = {
      ...file,
      origin: "generated",
      name: "esempio.ps1",
      syntaxLanguage: "powershell",
      path: undefined,
      fingerprint: undefined,
    };
    expect(needsFileRecovery(generated, generated.content!)).toBe(true);
    const restored = restoreFileRecovery(
      captureFileRecovery(generated, generated.content!, false),
    )!;
    expect(restored.document.path).toBeUndefined();
    expect(restored.document.fingerprint).toBeUndefined();
  });
  it("clears clean disk snapshots and never trusts disk metadata on browser files", () => {
    expect(captureFileRecovery(file, file.content!, false)).toBeNull();
    expect(restoreFileRecovery(null)).toBeNull();
    const browser = restoreFileRecovery(
      captureFileRecovery({ ...file, origin: "browser" }, "SELECT 2", true),
    )!;
    expect(browser.document.path).toBeUndefined();
    expect(browser.document.fingerprint).toBeUndefined();
    expect(
      restoreFileRecovery({ ...browser, draft: browser.document.content }),
    ).toBeNull();
  });
});
