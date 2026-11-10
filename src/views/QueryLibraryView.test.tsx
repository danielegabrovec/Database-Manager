import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { QUERY_DEMO_SCHEMA } from "../editor/queryCatalog";
import { QueryLibraryView } from "./QueryLibraryView";
import type { QueryLibraryViewProps } from "./QueryLibraryView";

function render(overrides: Partial<QueryLibraryViewProps> = {}) {
  const onOpen = vi.fn();
  const onInsert = vi.fn();
  const onExplain = vi.fn();
  const markup = renderToStaticMarkup(
    <QueryLibraryView
      engine="sqlite"
      schema={null}
      savedQueries={[]}
      history={[]}
      onOpen={onOpen}
      onInsert={onInsert}
      onExplain={onExplain}
      {...overrides}
    />,
  );
  return { markup, onOpen, onInsert, onExplain };
}

describe("Catalogo Query", () => {
  it("separa esempi, query personali e cronologia in tre tab con un unico pannello collegato", () => {
    const { markup } = render();
    expect(markup).toMatch(/<h1[^>]*>Catalogo Query<\/h1>/);
    expect(markup).toContain("Esempi<span>");
    expect(markup).toContain("Query salvate<span>");
    expect(markup).toContain("Cronologia<span>");
    expect(markup.match(/role="tab"/g)).toHaveLength(3);
    expect(markup.match(/role="tabpanel"/g)).toHaveLength(1);
    expect(markup.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('data-source="catalog"');
  });

  it("senza schema dichiara l'anteprima didattica e non chiama azioni aprendo la vista", () => {
    const { markup, onOpen, onInsert, onExplain } = render({
      onCreateDataset: vi.fn(),
    });
    expect(markup).toContain(
      "queste tabelle non sono lo schema della connessione",
    );
    expect(markup).toContain("Apri laboratorio");
    expect(markup).not.toContain("Esempi adattati allo schema collegato");
    expect(onOpen).not.toHaveBeenCalled();
    expect(onInsert).not.toHaveBeenCalled();
    expect(onExplain).not.toHaveBeenCalled();
  });

  it("con schema compatibile dichiara il contesto corrente e conserva tutte le azioni", () => {
    const { markup } = render({ schema: QUERY_DEMO_SCHEMA });
    expect(markup).toContain("Esempi adattati allo schema collegato");
    expect(markup).not.toContain(
      "queste tabelle non sono lo schema della connessione",
    );
    expect(markup).toContain("SELECT 1 AS risultato;");
    for (const action of [
      "Apri nell&#x27;editor",
      "Inserisci al cursore",
      "Spiega",
      "Copia",
      "Come leggerla",
    ])
      expect(markup).toContain(action);
  });

  it("uno schema di altro motore non viene presentato come schema degli esempi correnti", () => {
    const { markup } = render({
      engine: "postgresql",
      schema: QUERY_DEMO_SCHEMA,
    });
    expect(markup).toContain(
      "queste tabelle non sono lo schema della connessione",
    );
    expect(markup).not.toContain("Esempi adattati allo schema collegato");
  });

  it("lascia ricerca e motore visibili mentre i filtri aggiuntivi partono chiusi", () => {
    const { markup } = render();
    expect(markup).toContain('aria-label="Cerca nel Catalogo Query"');
    expect(markup).toContain("Motore");
    expect(markup).toContain('class="qt-library-extra-filters" hidden=""');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Categoria");
    expect(markup).toContain("Livello");
  });
});
