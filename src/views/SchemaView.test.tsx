import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SchemaView } from "./SchemaView";
import { canBrowseData } from "../utils";
import type { SchemaSnapshot, TableInfo } from "../types";

const trigger: TableInfo = {
  name: "audit_insert",
  kind: "trigger",
  columns: [],
  indexes: [],
  foreignKeys: [],
  definition:
    "CREATE TRIGGER audit_insert AFTER INSERT ON customers BEGIN SELECT 1; END;",
};
describe("definizioni degli oggetti schema", () => {
  it("mostra la definizione di un trigger senza proporre l’apertura dei dati", () => {
    const schema: SchemaSnapshot = {
      engine: "sqlite",
      database: "test",
      tables: [trigger],
    };
    const markup = renderToStaticMarkup(
      <SchemaView
        schema={schema}
        sessionId="session"
        profiles={[]}
        query=""
        onQuery={() => {}}
        onOpenTable={() => {}}
      />,
    );
    expect(markup).toContain("Definizione");
    expect(markup).toContain("CREATE TRIGGER audit_insert");
    expect(markup).toContain("Apri nell’editor");
    expect(markup).not.toContain("Apri dati");
  });
  it("esclude routine e trigger senza colonne dai selettori dati", () => {
    expect(canBrowseData(trigger)).toBe(false);
    expect(canBrowseData({ ...trigger, kind: "routine" })).toBe(false);
    expect(canBrowseData({ ...trigger, kind: "view" })).toBe(true);
    expect(canBrowseData({ ...trigger, kind: "collection" })).toBe(true);
  });
});
