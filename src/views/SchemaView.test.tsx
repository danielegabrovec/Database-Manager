import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { relationEdges, SchemaView } from "./SchemaView";
import { canBrowseData, objectKey } from "../utils";
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
  it("apre l’oggetto con schema e firma richiesti dal navigatore", () => {
    const first = {
      ...trigger,
      schema: "public",
      name: "controlla",
      kind: "function",
      definition:
        "CREATE FUNCTION public.controlla(id integer) RETURNS integer",
    };
    const selected = {
      ...first,
      definition: "CREATE FUNCTION public.controlla(nome text) RETURNS text",
    };
    const otherSchema = { ...first, schema: "log" };
    const schema: SchemaSnapshot = {
      engine: "postgresql",
      database: "test",
      tables: [otherSchema, first, selected],
    };
    const markup = renderToStaticMarkup(
      <SchemaView
        schema={schema}
        sessionId="session"
        profiles={[]}
        query=""
        initialTab="diagram"
        initialObject={selected}
        onQuery={() => {}}
        onOpenTable={() => {}}
      />,
    );
    expect(markup).toContain("log.controlla");
    expect(markup).toContain("variante 1");
    expect(markup).toContain("variante 2");
    expect(markup).toContain("<h2>public.controlla</h2>");
    expect(markup).toContain(
      '<pre class="code-preview">' + selected.definition,
    );
    expect(markup.match(/aria-current="true"/g)).toHaveLength(1);
  });
  it("collega la chiave esterna allo schema dichiarato", () => {
    const common: TableInfo = {
      name: "ordini.v1",
      schema: "vendite",
      kind: "table",
      columns: [],
      indexes: [],
      foreignKeys: [],
    };
    const external = { ...common, schema: "archivio" };
    const source = {
      ...common,
      name: "righe",
      foreignKeys: [
        {
          columns: ["ordine"],
          referencedTable: common.name,
          referencedSchema: external.schema,
        },
        { columns: ["tra_a"], referencedTable: "tabella-non-visibile" },
      ],
    };
    const links = relationEdges([source, external, common]);
    expect(links).toHaveLength(1);
    expect(links[0].source).toBe(encodeURIComponent(objectKey(source)));
    expect(links[0].target).toBe(encodeURIComponent(objectKey(external)));
  });
});
