import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  compileOperationGraph,
  initialGraph,
  insertGraphNode,
} from "./operationGraph";
import { importGraphQuery } from "./operationGraphImport";
import type { Engine, SchemaSnapshot, TableInfo } from "../types";
import { objectKey } from "../utils";

function schema(engine: Engine, namespace?: string): SchemaSnapshot {
  const table: TableInfo = {
    name: "people",
    schema: namespace,
    kind: "table",
    indexes: [],
    foreignKeys: [],
    columns: [
      { name: "id", dataType: "integer", primaryKey: true, nullable: false },
      { name: "name", dataType: "text", primaryKey: false, nullable: true },
    ],
  };
  return { tables: [table], database: "qa", engine };
}

describe("diagramma operativo", () => {
  it("mantiene distinta una lettura SQLite con valore INTEGER e TEXT", () => {
    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE people(id BLOB PRIMARY KEY, name TEXT); INSERT INTO people VALUES(42, 'numero'), ('42', 'testo');",
      );
      const metadata = schema("sqlite");
      metadata.tables[0].columns[0].dataType = "BLOB";
      for (const [literal, name] of [
        ["42", "numero"],
        ["'42'", "testo"],
      ]) {
        const visual = importGraphQuery(
          { query: `SELECT name FROM people WHERE id=${literal}` },
          metadata,
          "sqlite",
        );
        const compiled = compileOperationGraph(visual, metadata, "sqlite");
        if (compiled.kind !== "read") throw new Error("Lettura attesa");
        expect(
          database
            .prepare(compiled.query)
            .all(compiled.params as Record<string, number | string>),
        ).toEqual([{ name }]);
      }
    } finally {
      database.close();
    }
  });
  it("ricostruisce una lettura SQL e conserva parametri, proiezione e ordinamento", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO people VALUES(1,'Ada'),(2,'René'),(3,'Anna');",
    );
    const metadata = schema("sqlite");
    const query =
      "SELECT name FROM people WHERE id >= :min AND name IS NOT NULL ORDER BY id DESC LIMIT 1";
    const visual = importGraphQuery(
      { query, parameters: { min: 2 } },
      metadata,
      "sqlite",
    );
    const compiled = compileOperationGraph(visual, metadata, "sqlite");
    expect(compiled.kind).toBe("read");
    if (compiled.kind === "read")
      expect(
        db
          .prepare(compiled.query)
          .all(compiled.params as Record<string, number>),
      ).toEqual([{ name: "Anna" }]);
    db.close();
  });

  it("blocca l’uscita di scrittura senza filtro e conserva schema e valori tipizzati", () => {
    const metadata = schema("postgresql", "qa.region");
    expect(() =>
      importGraphQuery(
        { query: 'DELETE FROM "qa.region".people' },
        metadata,
        "postgresql",
      ),
    ).toThrow("filtro");
    const visual = importGraphQuery(
      {
        query: 'UPDATE "qa.region".people SET name=$1 WHERE id > $2',
        parameters: { 1: "d’aria", 2: "9007199254740993" },
      },
      metadata,
      "postgresql",
    );
    expect(compileOperationGraph(visual, metadata, "postgresql")).toEqual({
      kind: "write",
      operation: {
        table: { name: "people", schema: "qa.region" },
        kind: "update",
        filters: [
          {
            column: "id",
            operator: ">",
            value: { type: "integer", value: "9007199254740993" },
          },
        ],
        values: { name: { type: "text", value: "d’aria" } },
      },
    });
  });

  it("rifiuta un grafo scollegato e una query non rappresentabile", () => {
    const metadata = schema("sqlite");
    const graph = initialGraph();
    graph.nodes[0].table = objectKey(metadata.tables[0]);
    graph.edges = [];
    expect(() =>
      compileOperationGraph(
        insertGraphNode(graph, "filter"),
        metadata,
        "sqlite",
      ),
    ).toThrow("Collega tutti");
    expect(() =>
      importGraphQuery(
        { query: "SELECT * FROM people WHERE id=1 OR id=2" },
        metadata,
        "sqlite",
      ),
    ).toThrow("SELECT semplice");
  });

  it("produce Extended JSON per ObjectId MongoDB", () => {
    const metadata = schema("mongodb");
    metadata.tables[0].columns[0] = {
      name: "_id",
      dataType: "ObjectId",
      primaryKey: true,
      nullable: false,
    };
    let graph = initialGraph();
    graph.nodes[0].table = objectKey(metadata.tables[0]);
    graph = insertGraphNode(insertGraphNode(graph, "write"), "filter");
    graph.nodes.find((item) => item.id === "write")!.operation = "delete";
    graph.nodes.find((item) => item.id === "filter")!.filters = [
      {
        column: "_id",
        type: "auto",
        text: "507f1f77bcf86cd799439011",
        operator: "=",
      },
    ];
    expect(compileOperationGraph(graph, metadata, "mongodb")).toMatchObject({
      kind: "write",
      operation: {
        filters: [
          {
            value: {
              type: "json",
              value: '{"$oid":"507f1f77bcf86cd799439011"}',
            },
          },
        ],
      },
    });
  });
});
