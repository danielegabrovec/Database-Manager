import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  detectSourceLanguage,
  extractDatabaseOperations,
} from "./queryExtraction";

const fixtures: [string, string, string][] = [
  [
    "rust",
    "read.rs",
    "const QUERY: &str = r#\"SELECT id, name FROM people WHERE name = 'O''Brien' AND id = :id\"#;\nlet rows=sqlx::query(QUERY).bind(42);",
  ],
  [
    "python",
    "read.py",
    'query = """SELECT id, name\nFROM people WHERE id = :id"""\ncursor.execute(query, {"id": 42})',
  ],
  [
    "javascript",
    "read.mjs",
    'const statement = "SELECT id FROM people WHERE id = :id";\nconnection.query(statement, {id: 42});',
  ],
  [
    "typescript",
    "read.ts",
    "const sql: string = `SELECT id FROM people WHERE id = $1`;\nclient.query(sql, [42]);",
  ],
  [
    "php",
    "read.php",
    "<?php\n$sql = <<<'QUERY'\nSELECT id FROM people\nWHERE id = :id\nQUERY;\n$pdo->prepare($sql);",
  ],
  [
    "java",
    "Read.java",
    'String SQL = """\n    SELECT id FROM people\n    WHERE id = ?\n    """;\nconnection.prepareStatement(SQL);',
  ],
  [
    "csharp",
    "Read.cs",
    'var sql = @"SELECT ""id"" FROM ""people"" WHERE ""name""=\'O\'\'Brien\' AND ""id""=@id";\ncommand.CommandText=sql;',
  ],
  [
    "c",
    "read.c",
    'const char *SQL = "SELECT id " "FROM people WHERE id = ?";\nsqlite3_prepare_v2(connection, SQL, -1, &stmt, 0);',
  ],
  [
    "cpp",
    "read.cpp",
    'std::string query = R"DB(SELECT id FROM people WHERE id = $1)DB";\ntransaction.exec(query);',
  ],
  [
    "go",
    "read.go",
    "query := `SELECT id FROM people WHERE id = ?`;\nrows, err := db.QueryContext(ctx, query, 42)",
  ],
  [
    "kotlin",
    "Read.kt",
    'val query = """\n|SELECT id FROM people\n|WHERE id = ?\n""".trimMargin()\nconnection.prepareStatement(query)',
  ],
  [
    "ruby",
    "read.rb",
    "SQL = <<~QUERY\n  SELECT id FROM people\n  WHERE id = :id\nQUERY\ndb.exec(SQL)",
  ],
];
describe("estrazione statica dei dodici linguaggi", () => {
  it("riconosce le estensioni senza interpretare un TXT come programma", () => {
    expect(detectSourceLanguage("C:\\Source\\READ.SQL")).toBe("sql");
    expect(detectSourceLanguage("module.hpp")).toBe("cpp");
    expect(detectSourceLanguage("module.mts")).toBe("typescript");
    expect(detectSourceLanguage("notes.txt")).toBe("unknown");
  });
  it("text block Java e raw string C# rispettano l’indentazione del delimitatore", () => {
    const java =
      'String SQL="""\n      SELECT \'line1\n        line2\' AS note\n    """;';
    const cs =
      'var sql="""\n      SELECT \'line1\n        line2\' AS note\n    """;';
    expect(extractDatabaseOperations(java, "Q.java").operations[0].text).toBe(
      "  SELECT 'line1\n    line2' AS note\n",
    );
    expect(extractDatabaseOperations(cs, "Q.cs").operations[0].text).toBe(
      "  SELECT 'line1\n    line2' AS note",
    );
  });
  for (const [language, fileName, source] of fixtures)
    it(`${language}: riconosce literal e uso driver senza avviare codice`, () => {
      const result = extractDatabaseOperations(source, fileName);
      expect(result.language).toBe(language);
      expect(result.operations).toHaveLength(1);
      const operation = result.operations[0];
      expect(operation.kind).toBe("sql");
      expect(operation.confidence).toBe("literal");
      expect(operation.text).toMatch(/SELECT/);
      expect(operation.text).toContain("people");
      expect(operation.parameters).toHaveLength(1);
      expect(operation.parameters[0].dataType).toBe("unknown");
      expect(operation.parameters[0].value).toBeNull();
      expect(operation.startLine).toBeGreaterThan(0);
      expect(operation.endLine).toBeGreaterThanOrEqual(operation.startLine);
    });
  it("le concatenazioni di soli literal C, Python e Java conservano la query reale", () => {
    for (const [file, source] of [
      ["q.c", 'const char *SQL="SELECT id " "FROM people WHERE id=1";'],
      ["q.py", 'query = ("SELECT id " "FROM people WHERE id=1")'],
      ["Q.java", 'String query = "SELECT id " + "FROM people WHERE id=1";'],
    ]) {
      const operation = extractDatabaseOperations(source, file).operations[0];
      expect(operation.text).toBe("SELECT id FROM people WHERE id=1");
      expect(operation.confidence).toBe("literal");
      const db = new DatabaseSync(":memory:");
      try {
        db.exec(
          "CREATE TABLE people(id INTEGER);INSERT INTO people VALUES(1),(2)",
        );
        expect(db.prepare(operation.text).all()).toEqual([
          expect.objectContaining({ id: 1 }),
        ]);
      } finally {
        db.close();
      }
    }
  });
  it("Unicode, apostrofi SQL e escape Unicode rimangono dati del literal", () => {
    const source =
      "const SQL=\"SELECT \\u00c8 AS label, 'O''Brien' AS surname FROM people\";";
    const result = extractDatabaseOperations(source, "q.ts");
    expect(result.operations[0].text).toBe(
      "SELECT È AS label, 'O''Brien' AS surname FROM people",
    );
  });
  it("mantiene provenienza fisica e ID distinti anche con testo SQL ripetuto", () => {
    const source =
      '// prima riga\r\nconst SQL_A = "SELECT 1";\r\n\r\nconst SQL_B = "SELECT 1";';
    const operations = extractDatabaseOperations(source, "q.js").operations;
    expect(
      operations.map((operation) => [operation.startLine, operation.endLine]),
    ).toEqual([
      [2, 2],
      [4, 4],
    ]);
    expect(new Set(operations.map((operation) => operation.id)).size).toBe(2);
    expect(
      extractDatabaseOperations(source, "q.js").operations.map(
        (operation) => operation.id,
      ),
    ).toEqual(operations.map((operation) => operation.id));
  });
  it("un literal usato da più chiamate non viene duplicato", () => {
    const result = extractDatabaseOperations(
      'const SQL="SELECT id FROM people WHERE id=:id OR parent_id=:id";db.query(SQL);db.execute(SQL);',
      "q.ts",
    );
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].parameters).toEqual([
      expect.objectContaining({
        name: "id",
        placeholder: ":id",
        occurrences: 2,
      }),
    ]);
  });
  it("riconosce query passate direttamente alle API native e alle chiamate generiche", () => {
    for (const [file, source] of [
      ["q.c", 'PQexec(connection,"SELECT id FROM people WHERE id=$1");'],
      ["q.go", 'db.QueryContext(ctx,"SELECT id FROM people WHERE id=?",42)'],
      [
        "q.cs",
        'connection.QueryAsync<Row>("SELECT id FROM people WHERE id=@id", args);',
      ],
      [
        "q.py",
        'cursor.execute("SELECT id FROM people WHERE id=:id", {"id":42})',
      ],
    ])
      expect(extractDatabaseOperations(source, file).operations).toHaveLength(
        1,
      );
  });
});
describe("confini, falsi positivi e codice dinamico", () => {
  it("non promuove commenti, documentazione, regex o messaggi generici a istruzioni database", () => {
    const source =
      '// db.query("SELECT * FROM hidden");\n/* const SQL="DROP TABLE hidden"; */\nconst message="SELECT one option from the menu";\nconsole.log("SELECT a value");\nconst pattern=/db.query("SELECT * FROM hidden")/;';
    expect(extractDatabaseOperations(source, "sample.js").operations).toEqual(
      [],
    );
    expect(
      extractDatabaseOperations(
        '"""SELECT * FROM docs"""\nmessage="SELECT one option"',
        "sample.py",
      ).operations,
    ).toEqual([]);
  });
  it("concat dinamica, template e formattazione restano bozze, senza eseguire espressioni", () => {
    const box = globalThis as typeof globalThis & {
      extractionSentinel?: number;
    };
    box.extractionSentinel = 0;
    const sources = [
      [
        "q.ts",
        "const SQL = `SELECT id FROM people WHERE id=${globalThis.extractionSentinel++}`;",
      ],
      ["q.py", 'query = f"SELECT id FROM {table} WHERE id=:id"'],
      ["q.rs", 'let sql = format!("SELECT id FROM {} WHERE id = ?", table);'],
      ["q.cs", 'var sql = $"SELECT id FROM {table} WHERE id=@id";'],
      ["q.php", '$sql = "SELECT id FROM ".$table." WHERE id=:id";'],
      ["q.js", 'const query = "SELECT id FROM "+table+" WHERE id=:id";'],
    ];
    for (const [file, source] of sources) {
      const operation = extractDatabaseOperations(source, file).operations[0];
      expect(operation).toBeDefined();
      expect(operation.confidence).toBe("partial");
      expect(operation.warnings.join(" ")).toMatch(
        /parziale|non valutata|non letterale/,
      );
    }
    expect(box.extractionSentinel).toBe(0);
    delete box.extractionSentinel;
  });
  it("i segnaposto dentro stringhe, identificatori e commenti SQL non sono binding", () => {
    const source =
      "SELECT ':hidden', \"odd:name\" FROM people -- :comment\nWHERE id=:id OR parent=:id AND owner=$1 /* @hidden ? */ AND kind=%(kind)s";
    const operation = extractDatabaseOperations(source, "q.sql").operations[0];
    expect(operation.parameters.map((parameter) => parameter.name)).toEqual([
      "id",
      "1",
      "kind",
    ]);
    expect(operation.parameters[0].occurrences).toBe(2);
  });
  it("un file SQL è una singola unità completa, comprese transazioni e DDL", () => {
    const script =
      "-- schema\nBEGIN;\nCREATE TABLE people(id INTEGER);\nINSERT INTO people VALUES(1);\nCOMMIT;";
    const operation = extractDatabaseOperations(script, "schema.SQL")
      .operations[0];
    expect(operation.text).toBe(script);
    expect(operation.startLine).toBe(1);
    expect(operation.endLine).toBe(5);
    expect(operation.confidence).toBe("literal");
  });
  it("TXT e linguaggi sconosciuti non eseguono euristiche su stringhe casuali", () => {
    for (const file of ["notes.txt", "query.bin", "README.md"]) {
      const result = extractDatabaseOperations(
        'const SQL="SELECT id FROM people";',
        file,
      );
      expect(result.language).toBe("unknown");
      expect(result.operations).toEqual([]);
      expect(result.warnings.join(" ")).toMatch(/non riconosciuta|generica/);
    }
  });
  it("limiti di file e numero operazioni producono un esito esplicito", () => {
    const oversized = extractDatabaseOperations(
      'const SQL="SELECT 1";'.repeat(10),
      "q.js",
      { maxCharacters: 10 },
    );
    expect(oversized.truncated).toBe(true);
    expect(oversized.operations).toEqual([]);
    const limited = extractDatabaseOperations(
      'const SQL_A="SELECT 1";const SQL_B="SELECT 2";const SQL_C="SELECT 3";',
      "q.ts",
      { maxOperations: 2 },
    );
    expect(limited.operations).toHaveLength(2);
    expect(limited.truncated).toBe(true);
  });
});
describe("MongoDB: solo documenti statici o bozze JSON esplicite", () => {
  it("una ricerca generica su un oggetto non viene inventata come operazione MongoDB", () => {
    expect(
      extractDatabaseOperations(
        'const users=[{active:true}]; const item=users.find({active:true}); const pipeline=reports.aggregate([{field:"value"}]);',
        "generic.js",
      ).operations,
    ).toEqual([]);
  });
  it("un template Mongo dinamico diventa una bozza JSON valida con marcatori", () => {
    const source =
      'const command = `{"find":"people","filter":{"age":${age}}}`; db.runCommand(JSON.parse(command));';
    const operation = extractDatabaseOperations(source, "q.ts").operations[0];
    expect(operation.kind).toBe("mongodb");
    expect(operation.confidence).toBe("partial");
    expect(() => JSON.parse(operation.text)).not.toThrow();
    expect(operation.text).toContain("{{DYNAMIC}}");
  });
  it("preserva Extended JSON e interi esatti senza riserializzare i numeri del file", () => {
    const text =
      '{"find":"people","filter":{"_id":{"$numberLong":"9223372036854775807"},"raw":9223372036854775807}}';
    const operation = extractDatabaseOperations(text, "query.json")
      .operations[0];
    expect(operation.text).toBe(text);
    expect(operation.kind).toBe("mongodb");
    expect(operation.confidence).toBe("literal");
  });
  it("non scambia JSON di dati generici per comandi MongoDB", () => {
    expect(
      extractDatabaseOperations(
        '[{"name":"Anna"},{"name":"Marco"}]',
        "data.json",
      ).operations,
    ).toEqual([]);
    expect(
      extractDatabaseOperations('{find: "people"}', "q.json").operations,
    ).toEqual([]);
  });
  it("riconosce pipeline JSON autonome spiegando il contesto necessario", () => {
    const operation = extractDatabaseOperations(
      '[{"$match":{"active":true}},{"$group":{"_id":"$city","n":{"$sum":1}}}]',
      "pipeline.mql",
    ).operations[0];
    expect(operation.kind).toBe("mongodb");
    expect(operation.warnings.join(" ")).toMatch(/collezione/);
  });
  it("converte solo oggetti letterali delle chiamate Mongo, senza valutare JavaScript", () => {
    const source =
      'db.people.find({active:true,age:{$gte:18},name:"È Anna"});db.runCommand({find:"people",filter:{_id:{$numberLong:"9223372036854775807"}}});';
    const operations = extractDatabaseOperations(source, "query.js").operations;
    expect(operations).toHaveLength(2);
    expect(JSON.parse(operations[0].text)).toMatchObject({
      find: "people",
      filter: { active: true, age: { $gte: 18 }, name: "È Anna" },
    });
    expect(JSON.parse(operations[1].text)).toMatchObject({
      find: "people",
      filter: { _id: { $numberLong: "9223372036854775807" } },
    });
    expect(
      operations.every((operation) => operation.confidence === "literal"),
    ).toBe(true);
  });
  it("risolve pipeline e nome collezione da assegnazioni letterali senza eval", () => {
    const source =
      'const collection = db.collection("people"); const pipeline=[{$match:{active:true}},{$limit:10}]; collection.aggregate(pipeline);';
    const operation = extractDatabaseOperations(source, "q.ts").operations[0];
    expect(JSON.parse(operation.text)).toMatchObject({
      aggregate: "people",
      pipeline: [{ $match: { active: true } }, { $limit: 10 }],
      cursor: {},
    });
    expect(operation.confidence).toBe("literal");
  });
  it("espressioni Mongo non letterali diventano marcatori JSON e non vengono invocate", () => {
    const box = globalThis as typeof globalThis & {
      mongoExtractionSentinel?: number;
    };
    box.mongoExtractionSentinel = 0;
    const source =
      'db.runCommand({find:"people",filter:{age:(()=>{globalThis.mongoExtractionSentinel++;return 18})()}});';
    const operation = extractDatabaseOperations(source, "q.js").operations[0];
    expect(operation.confidence).toBe("partial");
    expect(() => JSON.parse(operation.text)).not.toThrow();
    expect(operation.text).not.toContain("globalThis");
    expect(box.mongoExtractionSentinel).toBe(0);
    delete box.mongoExtractionSentinel;
  });
  it("non interpreta backtick PHP/Ruby come query da comandi shell", () => {
    expect(
      extractDatabaseOperations("$sql=`SELECT id FROM people`;", "q.php")
        .operations,
    ).toEqual([]);
    expect(
      extractDatabaseOperations("sql=`SELECT id FROM people`", "q.rb")
        .operations,
    ).toEqual([]);
  });
});
describe("script e segnaposto di dialetto", () => {
  it("conserva come bozza l’intero file SQL con direttive client iniziali", () => {
    const source =
      "DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;";
    const operation = extractDatabaseOperations(source, "procedure.sql")
      .operations[0];
    expect(operation.text).toBe(source);
    expect(operation.confidence).toBe("partial");
  });
  it("ignora i commenti SQL annidati e distingue la numerazione dei segnaposto SQLite", () => {
    const operation = extractDatabaseOperations(
      "/* outer /* inner */ end */ SELECT id FROM people WHERE id=?1 OR id=?1 OR parent=?;",
      "q.sql",
    ).operations[0];
    expect(
      operation.parameters.map((parameter) => [
        parameter.name,
        parameter.occurrences,
      ]),
    ).toEqual([
      ["1", 2],
      ["2", 1],
    ]);
  });
});
