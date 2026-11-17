import type { CellType, Engine, SchemaSnapshot } from "../types";
import { canBrowseData, objectKey } from "../utils";
import {
  initialGraph,
  insertGraphNode,
  type FilterDraft,
  type GraphDraft,
  type GraphNode,
  type GraphOperator,
  type ValueDraft,
} from "./operationGraph";

export type GraphQueryDraft = {
  id?: string;
  query: string;
  parameters?: Record<string, unknown>;
};

const TOKEN =
  /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\$\d+|[:@$][A-Za-z_]\w*|[+-]?\d+(?:\.\d+)?|[A-Za-z_]\w*|>=|<=|<>|!=|[)(*,.;?=><]/gy;
const PLAIN_IDENTIFIER = /^[A-Za-z_]\w*$/;
const DECIMAL = /^[+-]?\d+(?:\.\d+)?$/;
const UNSUPPORTED =
  "Formati disponibili: SELECT semplice, INSERT con VALUES, UPDATE con SET e DELETE con WHERE. Usa campi diretti e filtri uniti da AND.";

export function importGraphQuery(
  draft: GraphQueryDraft,
  schema: SchemaSnapshot | null,
  engine: Engine,
): GraphDraft {
  if (!schema || schema.engine !== engine)
    throw new Error("Apri un database del motore della query e riprova.");
  if (!draft.query.trim() || draft.query.length > 64 * 1024)
    throw new Error("Inserisci una query di massimo 64 KiB.");
  if (engine === "mongodb")
    throw new Error(
      "Per MongoDB puoi costruire il diagramma dalla collezione e rivedere i comandi JSON nell’editor.",
    );
  const parameters = draft.parameters || {};
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  for (let offset = 0; offset < draft.query.length;) {
    const match = TOKEN.exec(draft.query);
    if (!match) throw new Error(UNSUPPORTED);
    const token = match[0];
    if (
      token.startsWith("/*!") ||
      (token.slice(2).includes("/*") && token.startsWith("/*"))
    )
      throw new Error(UNSUPPORTED);
    if (!/^\s|^--|^\/\*/.test(token)) tokens.push(token);
    offset = TOKEN.lastIndex;
  }
  let position = 0;
  let bindPosition = 0;
  const peek = () => tokens[position]?.toUpperCase();
  const take = () => tokens[position++] || "";
  const accept = (expected: string) => peek() === expected && !!take();
  function expect(expected: string) {
    if (!accept(expected)) throw new Error(UNSUPPORTED);
  }
  function identifier() {
    const token = take();
    if (token.startsWith('"') && engine !== "mysql" && engine !== "mariadb")
      return token.slice(1, -1).replaceAll('""', '"');
    if (token.startsWith("`") && engine !== "postgresql")
      return token.slice(1, -1).replaceAll("``", "`");
    if (token.startsWith("[") && engine === "sqlite") return token.slice(1, -1);
    if (!PLAIN_IDENTIFIER.test(token)) throw new Error(UNSUPPORTED);
    return engine === "postgresql" ? token.toLowerCase() : token;
  }
  function list<T>(parseItem: () => T) {
    const result = [parseItem()];
    while (accept(",")) result.push(parseItem());
    return result;
  }
  function value(column: string): ValueDraft {
    const token = take();
    let text: string;
    let type: CellType | "auto" = "auto";
    if (token.startsWith("'")) {
      text = token.slice(1, -1).replaceAll("''", "'");
      if (text.includes("\\"))
        throw new Error(
          "Rappresenta i valori con parametri per conservare le sequenze di escape.",
        );
    } else if (
      DECIMAL.test(token) ||
      ["TRUE", "FALSE"].includes(token.toUpperCase())
    ) {
      text = token;
    } else if (token.toUpperCase() === "NULL") {
      text = "";
      type = "null";
    } else if (/^\$\d+$|^[:@$][A-Za-z_]\w*$|^\?$/.test(token)) {
      const rawKey = token === "?" ? String(++bindPosition) : token.slice(1);
      const key = [rawKey, token, `p${rawKey}`].find((candidate) =>
        Object.hasOwn(parameters, candidate),
      );
      if (!key)
        throw new Error(
          `Parametro ${token} senza valore. Inseriscilo nell’editor prima di importare.`,
        );
      const raw = parameters[key];
      if (raw === null) {
        text = "";
        type = "null";
      } else if (["string", "boolean", "number"].includes(typeof raw)) {
        text = String(raw);
      } else if (
        raw &&
        typeof raw === "object" &&
        "type" in raw &&
        typeof raw.type === "string" &&
        [
          "text",
          "integer",
          "decimal",
          "float",
          "boolean",
          "datetime",
          "null",
          "json",
          "binary",
        ].includes(raw.type) &&
        (raw.type === "null" ||
          ("value" in raw &&
            ["string", "boolean", "number"].includes(typeof raw.value)))
      ) {
        text = "value" in raw && raw.type !== "null" ? String(raw.value) : "";
        type = raw.type as CellType;
      } else {
        throw new Error(
          `Il parametro ${token} richiede un valore scalare per il diagramma.`,
        );
      }
    } else throw new Error(UNSUPPORTED);
    return { column, type, text };
  }
  function where() {
    const filters: FilterDraft[] = [];
    if (!accept("WHERE")) return filters;
    do {
      const column = identifier();
      if (accept("IS")) {
        const not = accept("NOT");
        expect("NULL");
        filters.push({
          column,
          operator: not ? "IS NOT NULL" : "IS NULL",
          type: "auto",
          text: "",
        });
      } else {
        const operator = take();
        if (!["=", "!=", "<>", ">", ">=", "<", "<="].includes(operator))
          throw new Error(UNSUPPORTED);
        const input = value(column);
        if (input.type === "null")
          throw new Error(
            "Per un confronto con NULL usa IS NULL oppure IS NOT NULL.",
          );
        filters.push({
          ...input,
          operator: (operator === "<>" ? "!=" : operator) as GraphOperator,
        });
      }
    } while (accept("AND"));
    return filters;
  }
  let graph = initialGraph();
  function add(id: GraphNode["id"], configuration: Partial<GraphNode>) {
    graph = insertGraphNode(graph, id);
    graph.nodes = graph.nodes.map((node) =>
      node.id === id ? { ...node, ...configuration } : node,
    );
  }
  const operation = take().toLowerCase();
  if (!["select", "insert", "update", "delete"].includes(operation))
    throw new Error(UNSUPPORTED);
  const columns =
    operation === "select" && !accept("*") ? list(identifier) : [];
  if (operation === "select" || operation === "delete") expect("FROM");
  if (operation === "insert") expect("INTO");
  const label = identifier();
  const qualified = accept(".");
  const name = qualified ? identifier() : label;
  const matches = schema.tables.filter(
    (table) =>
      canBrowseData(table) &&
      table.name === name &&
      (!qualified || table.schema === label),
  );
  if (matches.length !== 1)
    throw new Error(
      "La tabella non è presente o è ambigua. Specifica schema e nome come indicato nella navigazione.",
    );
  graph.nodes[0].table = objectKey(matches[0]);
  if (operation === "select") {
    const filters = where();
    if (
      filters.some(
        (filter) => filter.type === "binary" || filter.type === "json",
      )
    )
      throw new Error(
        "I filtri di lettura con parametri binari o JSON restano disponibili nell’editor.",
      );
    if (filters.length) add("filter", { filters });
    if (columns.length) add("projection", { options: { columns } });
    if (accept("ORDER")) {
      expect("BY");
      const orderBy = identifier();
      const descending = accept("DESC");
      if (!descending) accept("ASC");
      add("order", { options: { orderBy, descending } });
    }
    if (accept("LIMIT")) {
      const text = take();
      const limit = Number(text);
      if (!/^\d+$/.test(text) || limit < 1 || limit > 10000)
        throw new Error(
          "Il diagramma accetta un limite compreso tra 1 e 10000.",
        );
      add("limit", { options: { limit } });
    }
  } else {
    add("write", { operation: operation as "insert" | "update" | "delete" });
    if (operation === "insert") {
      if (accept("DEFAULT")) {
        expect("VALUES");
      } else {
        expect("(");
        const columns =
          peek() === ")" && (engine === "mysql" || engine === "mariadb")
            ? []
            : list(identifier);
        expect(")");
        expect("VALUES");
        expect("(");
        const values = columns.map((column, index) => {
          if (index) expect(",");
          return value(column);
        });
        expect(")");
        if (values.length) add("values", { values });
      }
    } else {
      const values =
        operation === "update"
          ? (expect("SET"),
            list(() => {
              const column = identifier();
              expect("=");
              return value(column);
            }))
          : [];
      const filters = where();
      if (!filters.length)
        throw new Error(
          "UPDATE e DELETE richiedono un filtro WHERE nel diagramma.",
        );
      add("filter", { filters });
      if (values.length) add("values", { values });
    }
  }
  accept(";");
  if (position !== tokens.length) throw new Error(UNSUPPORTED);
  return graph;
}
