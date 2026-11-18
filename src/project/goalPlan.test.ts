import { describe, it, expect } from "vitest";
import { interpretProjectGoal } from "./goalPlan";
import { applySourceChanges, scanProjectChanges } from "./packageSync";
import { compileProjectDatabase } from "./applicationProject";

const plan = {
  name: "Esempio",
  language: "Python",
  databases: [
    {
      name: "catalogo",
      engine: "sqlite",
      schema: "CREATE TABLE clienti(id INTEGER PRIMARY KEY, nome TEXT);",
      seed: [
        { table: "clienti", rows: [{ id: "9223372036854775806", nome: "A" }] },
      ],
      operations: [
        {
          name: "cerca",
          query: "SELECT nome FROM clienti WHERE id = 1 LIMIT 3;",
        },
      ],
    },
  ],
};
describe("Proposta locale e confronto con sorgenti", () => {
  it("conserva interi esatti e importa il grafo soltanto dopo validazione", () => {
    const { project } = interpretProjectGoal(plan);
    expect(project.databases[0].seed[0].values.id.value).toBe(
      "9223372036854775806",
    );
    expect(
      compileProjectDatabase(project.databases[0]).operations[0].compiled.kind,
    ).toBe("read");
    expect(() =>
      interpretProjectGoal({
        ...plan,
        databases: [...plan.databases, ...plan.databases],
      }),
    ).toThrow(/duplicato/);
  });
  it("rilegge il vero filtro dal sorgente e conserva l’identità del grafo", () => {
    const { project } = interpretProjectGoal(plan);
    const db = project.databases[0],
      op = db.operations[0];
    const source = {
      kind: "source" as const,
      path: "databases/sample/fn.py",
      databaseId: db.id,
      operationId: op.id,
      changed: true,
      content: `def rows(c):\n    return c.execute("SELECT nome FROM clienti WHERE id > 1 LIMIT 3").fetchall()\n`,
    };
    const diff = scanProjectChanges(project, {
      manifest: { project },
      files: [source],
    });
    expect(diff[0].error).toBeUndefined();
    const updated = applySourceChanges(project, diff);
    expect(updated.databases[0].operations[0].id).toBe(op.id);
    expect(
      updated.databases[0].operations[0].graph.nodes.find(
        (n) => n.id === "filter",
      )?.filters?.[0].operator,
    ).toBe(">");
    const other = structuredClone(updated);
    other.databases[0].operations[0].graph.nodes.find(
      (n) => n.id === "filter",
    )!.filters![0].operator = "<";
    expect(
      scanProjectChanges(other, { manifest: { project }, files: [source] })[0]
        .error,
    ).toMatch(/conflitto/);
  });
});
