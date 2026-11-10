import { describe, expect, it } from "vitest";
import { analyzeSqlScript } from "./sqlScriptAnalysis";

describe("SQL dump/client preflight", () => {
  it("flags psql COPY data and commands before a prefix could be executed", () => {
    const result = analyzeSqlScript(
      "CREATE TABLE t(id int);\nCOPY t (id) FROM stdin;\n1\n\\.\n\\connect example",
    );
    expect(result.nativeClientRequired).toBe(true);
    expect(result.directives).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ line: 2, command: "COPY FROM stdin" }),
        expect.objectContaining({ line: 5, command: "\\connect" }),
      ]),
    );
  });
  it("recognizes MySQL delimiter changes, SQLite dot commands and SQL Server batches", () => {
    expect(
      analyzeSqlScript(
        "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END $$",
      ).directives[0],
    ).toMatchObject({ client: "mysql", line: 1 });
    expect(
      analyzeSqlScript("CREATE TABLE t(id);\n.read other.sql").directives[0],
    ).toMatchObject({ client: "sqlite-cli", line: 2 });
    expect(
      analyzeSqlScript("CREATE TABLE t(id int);\nGO\nSELECT 1;").directives[0],
    ).toMatchObject({ client: "sqlserver", line: 2 });
  });
  it("ignores directive-looking comments, quoted identifiers and multiline/dollar literals", () => {
    const sql =
      "-- DELIMITER $$\n/* COPY t FROM stdin;\nGO */\nSELECT 'text\nGO\n\\connect test', $$\nSOURCE secret.sql\n$$, \"COPY FROM stdin;\";";
    expect(analyzeSqlScript(sql)).toEqual({
      nativeClientRequired: false,
      directives: [],
      warnings: [],
    });
  });
  it("permits ordinary SQL scripts and a COPY query without inline stdin data", () => {
    expect(
      analyzeSqlScript(
        "CREATE TABLE t(id INTEGER PRIMARY KEY); INSERT INTO t VALUES(1); SELECT * FROM t;",
      ).nativeClientRequired,
    ).toBe(false);
    expect(
      analyzeSqlScript("COPY t TO '/server/export.csv';").nativeClientRequired,
    ).toBe(false);
  });
});
