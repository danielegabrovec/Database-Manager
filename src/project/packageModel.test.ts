import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { designSnapshot, newDesignTable } from "../designer/schemaProject";
import { compileOperationGraph } from "../designer/operationGraph";
import { editExistingTable } from "../designer/schemaMigration";
import type { ApplicationProject } from "./applicationProject";
import {
  addProjectSourceOperation,
  analyzeProjectSource,
  prepareProjectPackage,
  projectImportConflicts,
  readProjectPackageManifest,
} from "./packageModel";

function fixture(): ApplicationProject {
  const table = { ...newDesignTable("sqlite"), name: "customers" };
  return {
    version: 1,
    id: "workspace",
    name: "Esempio",
    databases: [
      {
        id: "sales",
        name: "Vendite",
        engine: "sqlite",
        tables: [table],
        operations: [],
        seed: [
          {
            id: "selected",
            table: { name: "customers" },
            values: { id: { type: "integer", value: "2" } },
          },
          {
            id: "excluded",
            table: { name: "customers" },
            enabled: false,
            values: { id: { type: "integer", value: "3" } },
          },
        ],
      },
    ],
  };
}

describe("pacchetto dei database", () => {
  it("confronta il progetto con la baseline salvata senza usare una connessione", () => {
    const project = fixture();
    const database = project.databases[0];
    const saved = designSnapshot(database.engine, database.tables).tables[0];
    const draft = editExistingTable(saved, database.engine);
    draft.columns.push({
      name: "zipcode",
      dataType: "TEXT",
      nullable: true,
      primaryKey: false,
    });
    database.tables = [draft];
    const result = prepareProjectPackage(project, "Python", false).databases[0]
      .migration;
    expect(result?.blockers).toEqual([]);
    expect(
      result?.baseline.tables[0].columns.some(
        (column) => column.name === "zipcode",
      ),
    ).toBe(false);
    expect(result?.sql).toContain('ADD COLUMN "zipcode" TEXT');
    expect(result?.rebuildSqlite).toBe(false);
  });
  it("allega soltanto il seed scelto in modo esplicito", () => {
    const project = fixture();
    const omitted = prepareProjectPackage(project, "Python", false);
    expect(omitted.databases[0].seed).toEqual([]);
    expect(omitted.project.databases[0].seed).toEqual([]);
    const included = prepareProjectPackage(project, "C#", true);
    expect(included.language).toBe("csharp");
    expect(included.databases[0].seed).toHaveLength(1);
    expect(included.project.databases[0].seed[0].id).toBe("selected");
    expect(project.databases[0].seed).toHaveLength(2);
  });

  it("riapre il manifesto e identifica modifiche locali", () => {
    const project = fixture();
    const incoming = readProjectPackageManifest(
      JSON.stringify({
        format: "database-manager-project",
        version: 1,
        project,
      }),
    );
    expect(incoming.databases[0].id).toBe("sales");
    expect(
      projectImportConflicts(incoming, {
        ...incoming,
        databases: [{ ...incoming.databases[0], name: "Cambiato" }],
      }),
    ).toEqual(["Vendite"]);
  });

  it("ricostruisce il filtro dal sorgente Python effettivamente modificato", () => {
    const fixturePath = process.env.DBM_PACKAGE_EMITTED_SOURCE;
    const project = fixture();
    const database = project.databases[0];
    database.tables[0].columns = [
      ...database.tables[0].columns,
      { name: "name", dataType: "TEXT", nullable: false, primaryKey: false },
    ];
    const text = fixturePath
      ? readFileSync(fixturePath, "utf8")
      : `def esegui_operazione(connection, values=()):
    cursor = connection.cursor()
    try:
        cursor.execute("SELECT id,name FROM customers WHERE id >= ? ORDER BY id LIMIT 10;", values)
        return cursor.fetchall()
    finally:
        cursor.close()
`;
    const operations = analyzeProjectSource(text, "operazione.py");
    expect(operations).toHaveLength(1);
    expect(operations[0].text).toContain("id >= ?");
    const edited = addProjectSourceOperation(
      project,
      database.id,
      operations[0],
      { 1: "9007199254740993" },
    );
    const graph = edited.databases[0].operations[0].graph;
    const result = compileOperationGraph(
      graph,
      designSnapshot(database.engine, database.tables),
      database.engine,
    );
    expect(result.kind).toBe("read");
    if (result.kind === "read") {
      expect(result.query).toContain('"id" >= :p1');
      expect(result.params.p1).toBe("9007199254740993");
    }
  });
});
