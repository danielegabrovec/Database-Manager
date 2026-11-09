import { describe, expect, it } from "vitest";
import { QUERY_DEMO_SCHEMA } from "./queryCatalog";
import {
  explainQuery,
  explainQueryError,
  getFunctionSignature,
  getSqlCompletions,
  parseSqlAliases,
} from "./sqlLanguage";
import type { Engine, SchemaSnapshot } from "../types";

const complete = (
  text: string,
  offset = text.indexOf("|") >= 0 ? text.indexOf("|") : text.length,
  engine: Engine = "sqlite",
  schema: SchemaSnapshot = QUERY_DEMO_SCHEMA,
) => getSqlCompletions({ text: text.replace("|", ""), offset, engine, schema });
describe("completamento SQL contestuale", () => {
  it("completa il prefisso keyword con Ctrl+Spazio senza uno schema", () => {
    const suggestions = getSqlCompletions({
      engine: "sqlite",
      schema: null,
      text: "SEL",
      offset: 3,
    });
    expect(
      suggestions.some(
        (item) => item.label === "SELECT" && item.replacementStart === 0,
      ),
    ).toBe(true);
  });
  it("risolve alias dichiarati dopo il cursore ed esclude colonne di altre origini dopo il punto", () => {
    const suggestions = complete(
      "SELECT c.| FROM customers AS c JOIN orders AS o ON o.customer_id = c.id",
    );
    expect(suggestions.map((item) => item.label)).toContain("city");
    expect(suggestions.map((item) => item.label)).not.toContain("customer_id");
    expect(suggestions.find((item) => item.label === "name")?.insertText).toBe(
      '"name"',
    );
  });
  it("suggerisce solo tabelle dopo FROM e quota per il dialetto", () => {
    const suggestions = complete("SELECT * FROM cus|", undefined, "mysql");
    expect(suggestions.map((item) => item.kind)).toEqual(["table"]);
    expect(suggestions[0].insertText).toBe("`customers`");
  });
  it("gestisce identificatori quotati con spazi e parentesi nei nomi", () => {
    const schema: SchemaSnapshot = {
      ...QUERY_DEMO_SCHEMA,
      tables: [
        {
          ...QUERY_DEMO_SCHEMA.tables[0],
          name: 'odd "table',
          columns: [
            {
              name: "full name",
              dataType: "TEXT",
              nullable: false,
              primaryKey: false,
            },
          ],
        },
      ],
    };
    const text =
      'SELECT "Alias with spaces".| FROM "odd ""table" AS "Alias with spaces"';
    const suggestions = complete(text, undefined, "postgresql", schema);
    expect(suggestions.map((item) => item.insertText)).toEqual(['"full name"']);
  });
  it("ignora FROM falsi in stringhe, dollar quoting e commenti", () => {
    const text =
      "SELECT 'FROM orders fake', $$ JOIN products stolen $$, c.name FROM customers c -- JOIN orders evil\n/* FROM products nope */";
    const bindings = parseSqlAliases(text, QUERY_DEMO_SCHEMA);
    expect(bindings.map((binding) => binding.alias)).toEqual(["c"]);
  });
  it("isola gli statement e non espone alias di query precedenti", () => {
    const suggestions = complete("SELECT x.name FROM customers x; SELECT x.|");
    expect(suggestions).toEqual([]);
  });
  it("completa proiezioni di CTE e sottoquery senza inventare espressioni senza alias", () => {
    expect(
      complete(
        "WITH grouped AS (SELECT city, COUNT(*) AS total FROM customers GROUP BY city) SELECT g.| FROM grouped g",
      ).map((item) => item.label),
    ).toEqual(["city", "total"]);
    expect(
      complete(
        "SELECT s.| FROM (SELECT name AS customer_name, city FROM customers) s",
      ).map((item) => item.label),
    ).toEqual(["customer_name", "city"]);
  });
  it("supporta liste di colonne CTE e CTE concatenate", () => {
    expect(
      complete(
        "WITH first_cte(person_name, town) AS (SELECT name,city FROM customers), second_cte AS (SELECT * FROM first_cte) SELECT s.| FROM second_cte s",
      ).map((item) => item.label),
    ).toEqual(["person_name", "town"]);
  });
  it("normalizza gli alias PostgreSQL non quotati quando li inserisce con le virgolette", () => {
    const suggestions = complete(
      "SELECT na| FROM customers Customer JOIN orders O ON O.customer_id=Customer.id",
      undefined,
      "postgresql",
    );
    expect(
      suggestions.find((item) => item.filterText === "name")?.insertText,
    ).toBe('"customer"."name"');
  });
  it("sostituisce l'intero token e gli apici già chiusi senza duplicare il suffisso", () => {
    const text = 'SELECT c."na|me" FROM customers c';
    const offset = text.indexOf("|");
    const clean = text.replace("|", "");
    const item = complete(text).find((item) => item.label === "name")!;
    expect(
      clean.slice(0, item.replacementStart) +
        item.insertText +
        clean.slice(item.replacementEnd),
    ).toBe('SELECT c."name" FROM customers c');
    expect(item.replacementStart).toBeLessThan(offset);
  });
  it("non completa nei commenti e nelle stringhe in corso", () => {
    expect(complete("SELECT '-- FROM customers")).toEqual([]);
    expect(complete("-- SELECT c.")).toEqual([]);
    expect(complete("/* SELECT c.")).toEqual([]);
  });
  it("non interpreta keyword o separatori dentro identificatori quotati", () => {
    const special: SchemaSnapshot = {
      ...QUERY_DEMO_SCHEMA,
      tables: [
        {
          ...QUERY_DEMO_SCHEMA.tables[0],
          name: "FROM",
          columns: [
            {
              name: "WHERE",
              dataType: "TEXT",
              nullable: true,
              primaryKey: false,
            },
          ],
        },
      ],
    };
    expect(
      complete(
        'SELECT ";", f.| FROM "FROM" f',
        undefined,
        "sqlite",
        special,
      ).map((item) => item.label),
    ).toEqual(["WHERE"]);
    expect(
      explainQuery(
        'SELECT "WHERE", ":fake" FROM "FROM";',
        "sqlite",
        special,
      ).steps.map((step) => step.clause),
    ).toEqual(["SELECT", "FROM"]);
    expect(
      explainQuery('SELECT "WHERE", ":fake" FROM "FROM";', "sqlite", special)
        .parameters,
    ).toEqual([]);
  });
  it("non porta l'alias di una sottoquery fuori dal suo scope", () => {
    const suggestions = complete(
      "SELECT o.| FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id=o.customer_id)",
    );
    expect(suggestions.map((item) => item.label)).toContain("customer_id");
    expect(suggestions.map((item) => item.label)).not.toContain("city");
  });
  it("offre firme delle funzioni con indice argomento sensibile a stringhe e funzioni annidate", () => {
    expect(
      getFunctionSignature("SELECT COALESCE(ROUND(price, 2), ", 33, "sqlite")
        ?.activeParameter,
    ).toBe(1);
    expect(
      getFunctionSignature("SELECT COALESCE('a,b', ", 22, "sqlite")?.fn.name,
    ).toBe("COALESCE");
    expect(
      complete("DATE_T", undefined, "sqlite").map((item) => item.label),
    ).not.toContain("DATE_TRUNC");
    expect(
      complete("DATE_T", undefined, "postgresql").map((item) => item.label),
    ).toContain("DATE_TRUNC");
  });
  it("completa operatori e campi MongoDB reali", () => {
    const suggestions = complete(
      '{"aggregate":"customers","pipeline":[{"$ma|',
      undefined,
      "mongodb",
    );
    expect(suggestions.map((item) => item.label)).toContain("$match");
    expect(suggestions.map((item) => item.label)).not.toContain("$group");
  });
});
describe("didattica locale deterministica", () => {
  it("distingue oggetti inesistenti PostgreSQL invece di suggerire sempre una tabella", () => {
    expect(
      explainQueryError(
        'column "missing" does not exist (42703)',
        "postgresql",
      )[0],
    ).toContain("colonna");
    expect(
      explainQueryError(
        'relation "missing" does not exist (42P01)',
        "postgresql",
      )[0],
    ).toContain("tabella");
    expect(
      explainQueryError(
        "function round(double precision, integer) does not exist (42883)",
        "postgresql",
      )[0],
    ).toContain("argomenti");
  });
  it("distingue WHERE, GROUP BY e HAVING e riporta i parametri", () => {
    const analysis = explainQuery(
      "SELECT city, COUNT(*) FROM customers WHERE name LIKE :name GROUP BY city HAVING COUNT(*) > :minimum ORDER BY city;",
      "sqlite",
      QUERY_DEMO_SCHEMA,
    );
    expect(analysis.steps.map((step) => step.clause)).toEqual([
      "SELECT",
      "FROM",
      "WHERE",
      "GROUP BY",
      "HAVING",
      "ORDER BY",
    ]);
    expect(analysis.parameters).toEqual([":name", ":minimum"]);
    expect(analysis.tables).toEqual(["customers"]);
  });
  it("riconosce il rischio di scritture senza filtro ma non confonde parole in stringhe", () => {
    expect(
      explainQuery("DELETE FROM customers;", "sqlite").warnings.some(
        (warning) => warning.includes("tutte le righe"),
      ),
    ).toBe(true);
    expect(
      explainQuery("SELECT 'DELETE', 'x = NULL' FROM customers;", "sqlite")
        .warnings,
    ).toEqual([]);
    expect(
      explainQuery(
        "SELECT * FROM customers WHERE email = NULL;",
        "sqlite",
      ).warnings.some((warning) => warning.includes("IS NULL")),
    ).toBe(true);
  });
  it("non scambia cast PostgreSQL e stringhe per parametri", () => {
    expect(
      explainQuery("SELECT $1::numeric, ':fake' -- :ignored\n;", "postgresql")
        .parameters,
    ).toEqual(["$1"]);
  });
  it("riconosce anche modifiche in CTE e filtri mancanti in statement successivi", () => {
    expect(
      explainQuery(
        "WITH updated AS (UPDATE customers SET city='Udine' RETURNING *) SELECT * FROM updated;",
        "postgresql",
      ).summary,
    ).toContain("modificano");
    expect(
      explainQuery(
        "UPDATE customers SET city='Udine' WHERE id=1; DELETE FROM customers;",
        "sqlite",
      ).warnings.some((warning) => warning.startsWith("DELETE senza WHERE")),
    ).toBe(true);
    expect(
      explainQuery(
        "SELECT * FROM customers WHERE id=@key OR id=$other;",
        "sqlite",
      ).parameters,
    ).toEqual(["@key", "$other"]);
  });
  it("spiega la pipeline nell'ordine e separa JSON da shell JavaScript", () => {
    const analysis = explainQuery(
      '{"aggregate":"customers","pipeline":[{"$group":{"_id":"$city","total":{"$sum":1}}},{"$match":{"total":{"$gt":1}}}],"cursor":{}}',
      "mongodb",
    );
    expect(analysis.steps.map((step) => step.clause)).toEqual([
      "aggregate",
      "$group",
      "$match",
    ]);
    expect(
      explainQuery("db.customers.find({})", "mongodb").warnings[0],
    ).toContain("Extended JSON");
  });
  it("suggerisce una correzione pertinente per errori di alias, gruppi e parametri", () => {
    expect(
      explainQueryError(
        'column reference "id" is ambiguous (42702)',
        "postgresql",
      )[0],
    ).toContain("alias");
    expect(explainQueryError("ONLY_FULL_GROUP_BY", "mysql")[0]).toContain(
      "GROUP BY",
    );
    expect(
      explainQueryError("Parametro $1 mancante", "postgresql")[0],
    ).toContain('"1"');
  });
});
