import { describe, expect, it } from "vitest";
import { importGraphQuery } from "../designer/operationGraphImport";
import { designSnapshot } from "../designer/schemaProject";
import {
  compileProjectDatabase,
  newApplicationProject,
  newProjectDatabase,
  newProjectOperation,
  readApplicationProject,
  updateProjectTables,
} from "./applicationProject";

describe("progetto applicativo", () => {
  it("ripristina schema, semina tipizzata e posizione dei grafi indipendenti", () => {
    const project = newApplicationProject("QA");
    const sqlite = project.databases[0];
    const schema = designSnapshot(sqlite.engine, sqlite.tables);
    sqlite.seed = [
      {
        id: "seed",
        table: { name: sqlite.tables[0].name },
        values: { nome: { type: "text", value: "Ada" } },
        enabled: false,
      },
    ];
    const graph = importGraphQuery(
      { query: `SELECT nome FROM ${sqlite.tables[0].name}` },
      schema,
      sqlite.engine,
    );
    graph.nodes[0].position.x = 233;
    sqlite.operations.push({ ...newProjectOperation("Mostra nomi"), graph });
    project.databases.push(newProjectDatabase("postgresql", "altro"));
    const restored = readApplicationProject(
      JSON.parse(JSON.stringify(project)),
    );
    expect(restored.databases).toHaveLength(2);
    expect(restored.databases[0].operations[0].graph.nodes[0].position.x).toBe(
      233,
    );
    expect(restored.databases[0].seed[0].enabled).toBe(false);
    expect(
      compileProjectDatabase(restored.databases[0]).operations[0].compiled,
    ).toMatchObject({ kind: "read" });
  });

  it("propaga la rinomina di campi e tabelle alla semina e alle operazioni", () => {
    const database = newProjectDatabase();
    const table = database.tables[0];
    database.seed = [
      {
        id: "seed",
        table: { name: table.name },
        values: { nome: { type: "text", value: "Ada" } },
      },
    ];
    database.operations.push({
      ...newProjectOperation("Leggi"),
      graph: importGraphQuery(
        { query: `SELECT nome FROM ${table.name}` },
        designSnapshot(database.engine, database.tables),
        database.engine,
      ),
    });
    const changed = updateProjectTables(database, [
      {
        ...table,
        name: "people",
        columns: table.columns.map((column) =>
          column.name === "nome" ? { ...column, name: "display_name" } : column,
        ),
      },
    ]);
    expect(changed.seed[0]).toMatchObject({
      table: { name: "people" },
      values: { display_name: { type: "text", value: "Ada" } },
    });
    expect(
      compileProjectDatabase(changed).operations[0].compiled,
    ).toMatchObject({
      query: expect.stringContaining('SELECT "display_name"'),
    });
  });

  it("rifiuta database duplicati e non promuove un grafo non valido", () => {
    const project = newApplicationProject();
    project.databases.push(project.databases[0]);
    expect(() => readApplicationProject(project)).toThrow("duplicati");
    project.databases.pop();
    project.databases[0].operations.push({
      ...newProjectOperation("Bozza"),
      graph: { nodes: [], edges: [] },
    });
    expect(() => readApplicationProject(project)).toThrow("grafo non validi");
  });
});
