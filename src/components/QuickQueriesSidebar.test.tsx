import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SchemaSnapshot, TableInfo } from "../types";
import { QuickQueriesSidebar } from "./QuickQueriesSidebar";

const firstObject: TableInfo = {
  name: "rubrica",
  schema: "public",
  kind: "table",
  columns: [],
  indexes: [],
  foreignKeys: [],
};
const schema: SchemaSnapshot = {
  engine: "postgresql",
  database: "laboratory",
  tables: [
    firstObject,
    { ...firstObject, schema: "archivio" },
    { ...firstObject, name: "audit", kind: "function" },
  ],
};

describe("navigazione simulazioni rapide", () => {
  it("raggruppa gli oggetti e presenta l’anteprima con il nome qualificato", () => {
    const page = renderToStaticMarkup(
      <QuickQueriesSidebar
        schema={schema}
        history={[]}
        onTable={() => {}}
        onRestore={() => {}}
      />,
    );
    expect(page).toContain("Anteprima di public.rubrica in sola lettura");
    expect(page).toContain("Anteprima di archivio.rubrica in sola lettura");
    expect(page).not.toContain("public.audit");
    expect(page).toContain("Le simulazioni compariranno qui.");
  });

  it("mostra la cronologia più recente in alto, con stato e orario", () => {
    const page = renderToStaticMarkup(
      <QuickQueriesSidebar
        schema={null}
        history={[
          {
            query: "SELECT 1",
            engine: "sqlite",
            executedAt: "2026-11-17T12:00:00Z",
            elapsedMs: 2,
            success: true,
          },
          {
            query: "SELECT missing",
            engine: "postgresql",
            executedAt: "2026-11-17T13:00:00Z",
            error: "Colonna sconosciuta",
            success: false,
          },
        ]}
        onTable={() => {}}
        onRestore={() => {}}
      />,
    );
    expect(page).toContain("Apri una connessione");
    expect(page).toContain("Cronologia query rapide");
    expect(page.indexOf("SELECT missing")).toBeLessThan(
      page.indexOf("SELECT 1"),
    );
    expect(page).toContain('dateTime="2026-11-17T13:00:00Z"');
    expect(page).toContain("Colonna sconosciuta");
    expect(page).toContain("Riuscita");
    expect(page).toContain("2 ms");
  });
});
