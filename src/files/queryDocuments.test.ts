import { describe, expect, it } from "vitest";
import {
  createQueryDocument,
  restoreQueryWorkspace,
  isQueryDocumentDirty,
  sameDocumentPath,
  checkDocumentCapacity,
  MAX_QUERY_DOCUMENTS,
  MAX_QUERY_WORKSPACE_CHARACTERS,
} from "./queryDocuments";

describe("query document recovery and file identity", () => {
  it("closing a saved query notices unsaved parameters and execution mode even when SQL is unchanged", () => {
    const document = {
      ...createQueryDocument("SELECT :id"),
      baseline: "SELECT :id",
      savedQueryId: "saved-1",
      parametersText: '{"id":42}',
      savedParametersText: '{"id":42}',
      executionMode: "current",
      savedExecutionMode: "current",
    };
    expect(isQueryDocumentDirty(document)).toBe(false);
    expect(
      isQueryDocumentDirty({ ...document, parametersText: '{"id":43}' }),
    ).toBe(true);
    expect(isQueryDocumentDirty({ ...document, executionMode: "script" })).toBe(
      true,
    );
    expect(
      isQueryDocumentDirty({
        ...document,
        parametersText: '{"id":43}',
        savedParametersText: '{"id":43}',
        executionMode: "script",
        savedExecutionMode: "script",
      }),
    ).toBe(false);
  });
  it("file-only parameter changes do not pretend to change file text, and a file save does not save library metadata", () => {
    const file = {
      ...createQueryDocument("SELECT :id"),
      baseline: "SELECT :id",
      path: "C:/Dati/query.sql",
      parametersText: '{"id":42}',
      executionMode: "script",
    };
    expect(isQueryDocumentDirty(file)).toBe(false);
    const linked = {
      ...file,
      savedQueryId: "saved-1",
      savedParametersText: '{"id":1}',
      savedExecutionMode: "current",
    };
    expect(isQueryDocumentDirty({ ...linked, baseline: file.content })).toBe(
      true,
    );
    expect(isQueryDocumentDirty({ ...file, content: "SELECT 2" })).toBe(true);
  });
  it("recovery preserves bounded saved metadata baselines and normalizes invalid legacy fields", () => {
    const document = {
      ...createQueryDocument("SELECT :id"),
      baseline: "SELECT :id",
      savedQueryId: "saved",
      parametersText: '{"id":42}',
      savedParametersText: '{"id":42}',
      executionMode: "script",
      savedExecutionMode: "script",
    };
    const restored = restoreQueryWorkspace({
      version: 1,
      activeId: document.id,
      documents: [document],
    })!;
    expect(restored.documents[0]).toMatchObject({
      savedParametersText: '{"id":42}',
      savedExecutionMode: "script",
    });
    expect(isQueryDocumentDirty(restored.documents[0])).toBe(false);
    const invalid = restoreQueryWorkspace({
      version: 1,
      activeId: document.id,
      documents: [
        {
          ...document,
          savedParametersText: "x".repeat(65537),
          savedExecutionMode: "execute-immediately",
        },
      ],
    })!;
    expect(invalid.documents[0]).toMatchObject({
      savedParametersText: "{}",
      savedExecutionMode: "current",
    });
    expect(isQueryDocumentDirty(invalid.documents[0])).toBe(true);
  });
  it("restores separate SQL/Mongo buffers, provenance and file versions without merging their parameters", () => {
    const first = {
      ...createQueryDocument("SELECT :id", "sqlite", "ricerca.sql"),
      path: "C:\\Dati\\ricerca.sql",
      fingerprint: "sha256-v1",
      encoding: "utf-16le-bom",
      baseline: "SELECT 1",
      parametersText: '{"id":42}',
    };
    const second = {
      ...createQueryDocument('{"find":"orders"}', "mongodb", "estrazione"),
      sourcePath: "C:\\Progetto\\main.ts",
      sourceLine: 14,
      partial: true,
    };
    const restored = restoreQueryWorkspace(
      JSON.parse(
        JSON.stringify({
          version: 1,
          activeId: second.id,
          documents: [first, second],
        }),
      ),
    )!;
    expect(restored.activeId).toBe(second.id);
    expect(restored.documents[0]).toMatchObject({
      path: first.path,
      fingerprint: "sha256-v1",
      encoding: first.encoding,
      parametersText: '{"id":42}',
    });
    expect(restored.documents[1]).toMatchObject({
      kind: "mongodb",
      sourcePath: second.sourcePath,
      sourceLine: 14,
      partial: true,
      parametersText: "{}",
    });
    expect(restored.documents[1].path).toBeUndefined();
    expect(isQueryDocumentDirty(restored.documents[0])).toBe(true);
  });
  it("rejects ambiguous identities and oversized recovery rather than restoring a partial buffer", () => {
    const doc = createQueryDocument("SELECT 1");
    expect(
      restoreQueryWorkspace({
        version: 1,
        activeId: doc.id,
        documents: [doc, { ...doc }],
      }),
    ).toBeNull();
    expect(
      restoreQueryWorkspace({
        version: 1,
        activeId: doc.id,
        documents: [{ ...doc, id: "x".repeat(129) }],
      }),
    ).toBeNull();
    expect(
      restoreQueryWorkspace({
        version: 1,
        activeId: doc.id,
        documents: [
          { ...doc, content: "x".repeat(MAX_QUERY_WORKSPACE_CHARACTERS + 1) },
        ],
      }),
    ).toBeNull();
  });
  it("selects an available document after a stale active id and normalizes unsafe control metadata", () => {
    const doc = createQueryDocument("SELECT 1");
    const restored = restoreQueryWorkspace({
      version: 1,
      activeId: "missing",
      documents: [
        { ...doc, executionMode: "execute-automatically", parametersText: 42 },
      ],
    })!;
    expect(restored.activeId).toBe(doc.id);
    expect(restored.documents[0]).toMatchObject({
      executionMode: "current",
      parametersText: "{}",
    });
  });
  it("treats an opened file as clean until the current editor text changes", () => {
    const doc = {
      ...createQueryDocument("SELECT 'è'"),
      baseline: "SELECT 'è'",
    };
    expect(isQueryDocumentDirty(doc)).toBe(false);
    expect(isQueryDocumentDirty(doc, "SELECT 'è';")).toBe(true);
    expect(
      isQueryDocumentDirty({ ...doc, baseline: "SELECT 'è';" }, "SELECT 'è';"),
    ).toBe(false);
  });
  it("deduplicates Windows slash/case variants but preserves POSIX case sensitivity", () => {
    expect(sameDocumentPath("C:\\Dati\\Query.SQL", "c:/dati/query.sql")).toBe(
      true,
    );
    expect(
      sameDocumentPath("\\\\Server\\Share\\d.sql", "//server/share/D.SQL"),
    ).toBe(true);
    expect(sameDocumentPath("/work/A.sql", "/work/a.sql")).toBe(false);
    expect(sameDocumentPath("C:/a.sql", "C:/ab.sql")).toBe(false);
  });
  it("limits the combined content and baselines and the number of retained tabs", () => {
    const docs = Array.from({ length: MAX_QUERY_DOCUMENTS }, () =>
      createQueryDocument(),
    );
    expect(() => checkDocumentCapacity(docs, createQueryDocument())).toThrow(
      /schede/,
    );
    const large = {
      ...createQueryDocument(),
      content: "x".repeat(MAX_QUERY_WORKSPACE_CHARACTERS / 2),
      baseline: "x".repeat(MAX_QUERY_WORKSPACE_CHARACTERS / 2),
    };
    expect(() => checkDocumentCapacity([], large)).not.toThrow();
    expect(() =>
      checkDocumentCapacity([large], createQueryDocument("x")),
    ).toThrow(/memoria/);
  });
});
