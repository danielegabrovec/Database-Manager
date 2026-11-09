import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LabView } from "./LabView";
import type { SchemaSnapshot } from "../types";

describe("stato del laboratorio", () => {
  const base = {
    onOpened: () => {},
    onQuery: () => {},
    query: "",
    laboratory: true,
  };
  it("non mostra un laboratorio attivo se il profilo è selezionato ma manca lo schema della connessione", () => {
    const markup = renderToStaticMarkup(
      <LabView {...base} currentSession="session-id" schema={null} />,
    );
    expect(markup).not.toContain("Laboratorio attivo:");
    expect(markup).not.toContain("Ripristina dati");
  });
  it("riconosce il laboratorio aperto da un’altra vista senza uno stato locale di apertura", () => {
    const schema: SchemaSnapshot = {
      engine: "sqlite",
      database: "shop",
      tables: [],
    };
    const markup = renderToStaticMarkup(
      <LabView {...base} currentSession="session-id" schema={schema} />,
    );
    expect(markup).toContain("Laboratorio attivo:");
    expect(markup).toContain("Ripristina dati");
  });
});
