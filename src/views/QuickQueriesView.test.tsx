import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QuickQueriesView } from "./QuickQueriesView";
import type { ComponentProps } from "react";
import type { QueryResult, SchemaSnapshot } from "../types";

const schema: SchemaSnapshot = {
  engine: "sqlite",
  database: "quick",
  tables: [],
};
const initial: ComponentProps<typeof QuickQueriesView> = {
  engine: "sqlite",
  schema,
  sessionId: "quick",
  dark: true,
  settings: {},
  query: "SELECT 1",
  parametersText: "{}",
  onQueryChange() {},
  onParametersChange() {},
  onRun() {},
  onReset() {},
  busy: false,
  result: null,
};

describe("Quick Queries simulation editor", () => {
  it("shows the synthetic connection and the editor before the results", () => {
    const markup = renderToStaticMarkup(<QuickQueriesView {...initial} />);
    expect(markup).toContain("SQLite · dati di esempio");
    expect(markup.indexOf("Editor SQL")).toBeLessThan(
      markup.indexOf("Risultati"),
    );
  });

  it("offers recovery when the simulated schema has not been loaded", () => {
    const markup = renderToStaticMarkup(
      <QuickQueriesView
        {...initial}
        schema={null}
        opening={false}
        onReconnect={() => {}}
      />,
    );
    expect(markup).toContain("Simulazione inattiva");
    expect(markup).toContain("Avvia");
    expect(markup).not.toContain("Ripristina");
  });

  it("keeps cancellation available during a running copy simulation", () => {
    const markup = renderToStaticMarkup(
      <QuickQueriesView
        {...initial}
        busy
        mode="sqlite_copy"
        onCancel={() => {}}
        error="Interrotta"
      />,
    );
    expect(markup).toContain("SQLite · copia isolata");
    expect(markup).toContain("Interrompi");
    expect(markup).toContain("Interrotta");
  });

  it("shows populated parameters, multiple result sets and truncation status", () => {
    const result: QueryResult = {
      elapsedMs: 30,
      affectedRows: 0,
      message: "",
      sets: [
        {
          table: "first",
          columns: [
            {
              name: "total",
              primaryKey: false,
              nullable: false,
              dataType: "INT",
            },
          ],
          rows: [{ total: { type: "integer", value: "2" } }],
          truncated: true,
        },
        { table: "second", columns: [], rows: [] },
      ],
    };
    const markup = renderToStaticMarkup(
      <QuickQueriesView
        {...initial}
        parametersText='{"count":2}'
        result={result}
      />,
    );
    expect(markup).toContain("Parametri JSON");
    expect(markup).toContain("first");
    expect(markup).toContain("second");
    expect(markup).toContain("Risultato parziale");
    expect(markup).toContain("Tabella risultati della simulazione");
  });
});
