import { describe, expect, it } from "vitest";
import {
  decodeBrowserBytes,
  extractedOpenOptions,
  hasSqliteHeader,
  wholeSqlOpenOptions,
  createGeneratedWorkspaceDocument,
} from "./OpenFilesView";
import type { ExtractedDatabaseOperation } from "../files/queryExtraction";

describe("confini del centro file", () => {
  it("prepara PowerShell come bozza senza percorso o fingerprint e con BOM per Windows 5.1", () => {
    const file = createGeneratedWorkspaceDocument({
      id: "ps1",
      name: "C:\\Dati\\diagnosi.ps1",
      content: "\ufeffWrite-Output 'città €'",
      language: "powershell",
    });
    expect(file).toMatchObject({
      name: "diagnosi.ps1",
      encoding: "utf-8-bom",
      origin: "generated",
      syntaxLanguage: "powershell",
      content: "Write-Output 'città €'",
    });
    expect(file.path).toBeUndefined();
    expect(file.fingerprint).toBeUndefined();
    expect(wholeSqlOpenOptions(file).sourceOnly).toBe(true);
  });
  it("rifiuta nomi con controlli e script generati oltre il limite dell'anteprima", () => {
    expect(() =>
      createGeneratedWorkspaceDocument({
        id: "bad",
        name: "bad\0.ps1",
        content: "",
        language: "powershell",
      }),
    ).toThrow(/Nome/);
    expect(() =>
      createGeneratedWorkspaceDocument({
        id: "large",
        name: "large.ps1",
        content: "x".repeat(8 * 1024 * 1024),
        language: "powershell",
      }),
    ).toThrow(/limite/);
  });
  it("riconosce la firma SQLite esatta senza fidarsi dell'estensione", () => {
    expect(
      hasSqliteHeader(new TextEncoder().encode("SQLite format 3\0extra")),
    ).toBe(true);
    expect(
      hasSqliteHeader(new TextEncoder().encode("CREATE TABLE db(id);")),
    ).toBe(false);
    expect(hasSqliteHeader(new TextEncoder().encode("SQLite format 3"))).toBe(
      false,
    );
  });
  it("legge Unicode e BOM UTF-8 senza conservare il BOM come carattere SQL", () => {
    const text = "SELECT 'È Unicode';";
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(text),
    ]);
    expect(decodeBrowserBytes(bytes)).toMatchObject({
      content: text,
      encoding: "utf-8-bom",
      requiresEncoding: false,
    });
  });
  it("decodifica UTF-16 LE e BE dal BOM", () => {
    expect(
      decodeBrowserBytes(new Uint8Array([0xff, 0xfe, 0x41, 0, 0xe8, 0])),
    ).toMatchObject({
      content: "Aè",
      encoding: "utf-16le-bom",
      requiresEncoding: false,
    });
    expect(
      decodeBrowserBytes(new Uint8Array([0xfe, 0xff, 0, 0x41, 0, 0xe8])),
    ).toMatchObject({
      content: "Aè",
      encoding: "utf-16be-bom",
      requiresEncoding: false,
    });
  });
  it("rifiuta UTF-8 invalido senza inventare caratteri sostitutivi e richiede legacy esplicita", () => {
    const bytes = new Uint8Array([0x80]);
    expect(decodeBrowserBytes(bytes)).toMatchObject({
      content: null,
      requiresEncoding: true,
    });
    expect(decodeBrowserBytes(bytes, "windows-1252")).toMatchObject({
      content: "€",
      encoding: "windows-1252",
      requiresEncoding: false,
    });
  });
  it("non presenta UTF-16 senza BOM come testo UTF-8 con NUL invisibili", () => {
    const bytes = new Uint8Array([0x41, 0, 0x42, 0]);
    expect(decodeBrowserBytes(bytes).requiresEncoding).toBe(true);
    expect(decodeBrowserBytes(bytes, "utf-16le").content).toBe("AB");
  });
  it("non associa il salvataggio di una query estratta al programma originale", () => {
    const operation: ExtractedDatabaseOperation = {
      id: "q1",
      label: "Query dinamica",
      language: "python",
      kind: "sql",
      text: "SELECT * FROM customers WHERE id = {id}",
      startLine: 12,
      endLine: 14,
      confidence: "partial",
      parameters: [
        {
          name: "id",
          placeholder: "{id}",
          kind: "interpolation",
          dataType: "unknown",
          value: null,
          occurrences: 1,
        },
      ],
      warnings: ["Valore dinamico non risolto"],
    };
    const metadata = extractedOpenOptions(operation);
    expect(metadata).toMatchObject({
      sourceOnly: true,
      confidence: "partial",
      startLine: 12,
      endLine: 14,
    });
    expect(metadata.fingerprint).toBeUndefined();
    expect(metadata.originalContent).toBeUndefined();
    expect(metadata.parameters?.[0].value).toBeNull();
  });
  it("trasferisce il baseline originale, non la bozza modificata, e non inventa un binding per il browser", () => {
    const disk = wholeSqlOpenOptions({
      origin: "disk",
      encoding: "utf-8",
      fingerprint: "original-sha",
      content: "SELECT 1;",
    });
    expect(disk).toMatchObject({
      sourceOnly: false,
      fingerprint: "original-sha",
      originalContent: "SELECT 1;",
    });
    const browser = wholeSqlOpenOptions({
      origin: "browser",
      encoding: "utf-8",
      content: "SELECT 2;",
    });
    expect(browser.sourceOnly).toBe(true);
    expect(browser.fingerprint).toBeUndefined();
  });
});
