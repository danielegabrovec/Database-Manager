import { INITIAL_DESIGNER } from "../components/SchemaBuilders";
import { analyzeSqlScript } from "../files/sqlScriptAnalysis";
import { extractDatabaseOperations } from "../files/queryExtraction";
import type { Engine, ObjectRef } from "../types";
import {
  buildProjectDdl,
  designObject,
  designObjectKey,
  mongoValidatorColumns,
  type DesignColumn,
  type DesignProject,
  type DesignTable,
} from "./schemaProject";

export interface SchemaImportRequest {
  id: string;
  name: string;
  source: string;
  format: "sql" | "mongodb" | "source";
  engine: Engine;
}

export interface SchemaImportPreview extends DesignProject {
  issues: { line: number; message: string }[];
}

interface Token {
  raw: string;
  kind: "word" | "identifier" | "string" | "symbol";
  line: number;
  offset: number;
}

function sqlTokens(source: string, startLine: number, engine: Engine): Token[] {
  const matcher =
    /\s+|--[^\r\n]*|#[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[(?:[^\]]|\]\])*\]|'(?:[^'\\]|''|\\[\s\S])*'|[\p{L}\p{N}_$]+|./gsu;
  const mysql = engine === "mysql" || engine === "mariadb";
  const tokens: Token[] = [];
  let line = startLine;
  for (const match of source.matchAll(matcher)) {
    const raw = match[0];
    const start = line;
    line += raw.split("\n").length - 1;
    if (
      /^\s/.test(raw) ||
      raw.startsWith("--") ||
      raw.startsWith("/*") ||
      (mysql && raw.startsWith("#"))
    )
      continue;
    const first = raw[0];
    const kind =
      first === "'" && raw.length > 1
        ? "string"
        : '"`['.includes(first) && raw.length > 1
          ? "identifier"
          : /^[\p{L}\p{N}_$]/u.test(raw)
            ? "word"
            : "symbol";
    tokens.push({ raw, kind, line: start, offset: match.index });
  }
  return tokens;
}

function splitBy(tokens: Token[], separator: string): Token[][] {
  const sections: Token[][] = [];
  let section: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.raw === "(") depth++;
    if (token.raw === ")") depth--;
    if (token.raw === separator && depth === 0) {
      sections.push(section);
      section = [];
    } else section.push(token);
  }
  sections.push(section);
  return sections;
}

class SqlReader {
  public index = 0;
  constructor(
    readonly tokens: Token[],
    readonly engine: Engine,
    readonly defaultSchema = engine === "postgresql" ? "public" : undefined,
  ) {}

  peek(): Token | undefined {
    return this.tokens[this.index];
  }
  take(text: string): boolean {
    const token = this.peek();
    if (
      token &&
      (token.kind === "word" || token.kind === "symbol") &&
      token.raw.toUpperCase() === text
    ) {
      this.index++;
      return true;
    }
    return false;
  }
  expect(text: string) {
    if (!this.take(text)) throw new Error(`Era previsto ${text}.`);
  }
  name(): string {
    const token = this.tokens[this.index++];
    if (token?.kind === "identifier") {
      const opening = token.raw[0];
      const closing = opening === "[" ? "]" : opening;
      return token.raw.slice(1, -1).replaceAll(closing + closing, closing);
    }
    if (token?.kind === "word" && /^[\p{L}_]/u.test(token.raw))
      return this.engine === "postgresql" ? token.raw.toLowerCase() : token.raw;
    throw new Error("Era previsto un identificatore.");
  }
  objectName(): ObjectRef {
    const name = this.name();
    if (!this.take(".")) return { name, schema: this.defaultSchema };
    if (this.engine === "postgresql")
      return { schema: name, name: this.name() };
    if (this.engine === "sqlite" && name === "main")
      return { name: this.name() };
    throw new Error(
      `Lo schema ${name} richiede una destinazione esplicita nell’editor SQL.`,
    );
  }
  enclosed(): Token[] {
    this.expect("(");
    const begin = this.index;
    let depth = 1;
    while (this.peek()) {
      if (this.take("(")) depth++;
      else if (this.take(")")) {
        depth--;
        if (!depth) return this.tokens.slice(begin, this.index - 1);
      } else this.index++;
    }
    throw new Error("Parentesi non chiusa.");
  }
  names(): string[] {
    return splitBy(this.enclosed(), ",").map((tokens) => {
      const reader = new SqlReader(tokens, this.engine);
      const name = reader.name();
      reader.finish();
      return name;
    });
  }
  finish() {
    if (this.peek())
      throw new Error(
        `Clausola non rappresentabile vicino a ${this.peek()!.raw}.`,
      );
  }
}

const CONSTRAINTS = new Set([
  "NOT",
  "NULL",
  "PRIMARY",
  "UNIQUE",
  "DEFAULT",
  "REFERENCES",
  "CHECK",
  "CONSTRAINT",
  "COLLATE",
  "GENERATED",
  "AUTOINCREMENT",
  "AUTO_INCREMENT",
]);

function expression(reader: SqlReader, acceptFirstConstraint = false): string {
  const start = reader.index;
  let depth = 0;
  while (reader.peek()) {
    const token = reader.peek()!;
    if (
      depth === 0 &&
      (reader.index !== start || !acceptFirstConstraint) &&
      token.kind === "word" &&
      CONSTRAINTS.has(token.raw.toUpperCase())
    )
      break;
    if (token.raw === "(") depth++;
    if (token.raw === ")") depth--;
    reader.index++;
  }
  const tokens = reader.tokens.slice(start, reader.index);
  return tokens
    .map((token, index) => {
      const previous = tokens[index - 1];
      const space =
        previous && previous.offset + previous.raw.length !== token.offset;
      return (space ? " " : "") + token.raw;
    })
    .join("");
}

function newTable(name: string, schema?: string): DesignTable {
  return {
    name,
    schema,
    id: crypto.randomUUID(),
    columns: [],
    options: structuredClone(INITIAL_DESIGNER),
  };
}

function foreignKey(reader: SqlReader, table: DesignTable, fields: string[]) {
  reader.expect("REFERENCES");
  const target = reader.objectName();
  const targetFields = reader.names();
  if (fields.length !== 1 || targetFields.length !== 1)
    throw new Error("Le chiavi esterne composte richiedono l’editor SQL.");
  table.options.keys.push({
    column: fields[0],
    table: target.name,
    targetColumn: targetFields[0],
    targetSchema: target.schema,
  });
}

function createTable(reader: SqlReader): DesignTable {
  const owner = reader.objectName();
  const table = newTable(owner.name, owner.schema);
  const definitions = splitBy(reader.enclosed(), ",");
  reader.finish();
  let primary: string[] = [];
  for (const definition of definitions) {
    const item = new SqlReader(definition, reader.engine, reader.defaultSchema);
    if (item.take("PRIMARY")) {
      item.expect("KEY");
      primary = item.names();
    } else if (item.take("FOREIGN")) {
      item.expect("KEY");
      foreignKey(item, table, item.names());
    } else if (item.take("UNIQUE")) {
      const fields = item.names();
      if (fields.some((name) => name.includes(",")))
        throw new Error(
          "Un indice con una virgola nell’identificatore richiede l’editor SQL.",
        );
      table.options.indexes.push({
        name: `uq_${table.name}_${table.options.indexes.length + 1}`,
        columns: fields.join(", "),
        unique: true,
      });
    } else {
      if (item.take("CONSTRAINT") || item.take("CHECK") || item.take("KEY"))
        throw new Error(
          "Il vincolo della tabella richiede la definizione SQL originale.",
        );
      const name = item.name();
      const dataType = expression(item);
      if (!dataType) throw new Error(`Tipo assente per ${name}.`);
      const column: DesignColumn = {
        name,
        dataType,
        nullable: true,
        primaryKey: false,
      };
      while (item.peek()) {
        if (item.take("NOT")) {
          item.expect("NULL");
          column.nullable = false;
        } else if (item.take("NULL")) column.nullable = true;
        else if (item.take("PRIMARY")) {
          item.expect("KEY");
          column.primaryKey = true;
        } else if (item.take("UNIQUE")) column.unique = true;
        else if (item.take("DEFAULT")) {
          const value = expression(item, true);
          if (!value)
            throw new Error(`Valore predefinito assente per ${name}.`);
          column.defaultValue = value;
        } else if (item.take("REFERENCES")) {
          item.index--;
          foreignKey(item, table, [name]);
        } else if (
          (reader.engine === "sqlite" && item.take("AUTOINCREMENT")) ||
          ((reader.engine === "mysql" || reader.engine === "mariadb") &&
            item.take("AUTO_INCREMENT"))
        ) {
          column.autoIncrement = true;
        } else if (reader.engine === "postgresql" && item.take("GENERATED")) {
          item.expect("BY");
          item.expect("DEFAULT");
          item.expect("AS");
          item.expect("IDENTITY");
          column.autoIncrement = true;
        } else item.finish();
      }
      table.columns.push(column);
    }
    item.finish();
  }
  for (const name of primary) {
    const column = table.columns.find((column) => column.name === name);
    if (!column) throw new Error(`Campo chiave primaria assente: ${name}.`);
    column.primaryKey = true;
  }
  for (const column of table.columns)
    if (column.primaryKey) column.nullable = false;
  return table;
}

type Deferred = { line: number; apply: () => void };

function readSql(
  source: string,
  startLine: number,
  result: SchemaImportPreview,
  deferred: Deferred[],
  createdNamespaces: Set<string>,
) {
  const inspection = analyzeSqlScript(source);
  if (inspection.nativeClientRequired) {
    const { directives, warnings } = inspection;
    result.issues.push(
      ...warnings.map((message, index) => ({
        line: startLine + (directives[index]?.line || 1) - 1,
        message,
      })),
    );
    return;
  }
  const find = (object: ObjectRef) => {
    const wanted = designObjectKey(result.engine, object);
    const table = result.tables.find(
      (item) => designObjectKey(result.engine, item) === wanted,
    );
    if (!table)
      throw new Error(
        `La tabella ${object.name} non è presente nel sorgente importato.`,
      );
    return table;
  };
  let defaultSchema = result.engine === "postgresql" ? "public" : undefined;
  for (const tokens of splitBy(
    sqlTokens(source, startLine, result.engine),
    ";",
  )) {
    if (!tokens.length) continue;
    const line = tokens[0].line;
    const reader = new SqlReader(tokens, result.engine, defaultSchema);
    try {
      if (reader.take("CREATE")) {
        if (result.engine === "postgresql" && reader.take("SCHEMA")) {
          if (reader.take("IF")) {
            reader.expect("NOT");
            reader.expect("EXISTS");
          }
          const namespace = reader.name();
          reader.finish();
          createdNamespaces.add(namespace);
          continue;
        }
        if (reader.take("TABLE")) {
          if (reader.take("IF")) {
            reader.expect("NOT");
            reader.expect("EXISTS");
          }
          result.tables.push(createTable(reader));
          continue;
        }
        const unique = reader.take("UNIQUE");
        if (reader.take("INDEX")) {
          const name = reader.name();
          reader.expect("ON");
          const table = reader.objectName();
          const fields = reader.names();
          reader.finish();
          if (fields.some((name) => name.includes(",")))
            throw new Error(
              "Un indice con una virgola nell’identificatore richiede l’editor SQL.",
            );
          deferred.push({
            line,
            apply: () =>
              find(table).options.indexes.push({
                name,
                columns: fields.join(", "),
                unique,
              }),
          });
          continue;
        }
      } else if (reader.take("ALTER")) {
        reader.expect("TABLE");
        const owner = reader.objectName();
        reader.expect("ADD");
        reader.expect("FOREIGN");
        reader.expect("KEY");
        const fields = reader.names();
        const temporary = newTable(owner.name, owner.schema);
        foreignKey(reader, temporary, fields);
        reader.finish();
        deferred.push({
          line,
          apply: () => find(owner).options.keys.push(...temporary.options.keys),
        });
        continue;
      } else if (result.engine === "postgresql" && reader.take("SET")) {
        reader.expect("SEARCH_PATH");
        if (!reader.take("TO")) reader.expect("=");
        const namespace = reader.name();
        reader.finish();
        defaultSchema = namespace;
        continue;
      }
      throw new Error(
        "Istruzione fuori dalle definizioni supportate dal Designer.",
      );
    } catch (error) {
      result.issues.push({
        line,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readMongo(
  source: string,
  line: number,
  result: SchemaImportPreview,
  deferred: Deferred[],
) {
  try {
    const parsed: unknown = JSON.parse(source);
    const commands: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    for (const [position, command] of commands.entries()) {
      try {
        if (!record(command)) throw new Error("Era previsto un comando JSON.");
        if (typeof command.create === "string" || record(command.$jsonSchema)) {
          const table = newTable(
            typeof command.create === "string"
              ? command.create
              : "nuova_collezione",
          );
          if (
            typeof command.create === "string" &&
            Object.keys(command).some(
              (key) =>
                ![
                  "create",
                  "validator",
                  "validationLevel",
                  "validationAction",
                ].includes(key),
            )
          )
            throw new Error(
              "Opzioni di creazione della collezione non rappresentabili.",
            );
          const validator = record(command.$jsonSchema)
            ? command
            : command.validator;
          if (validator !== undefined && !record(validator))
            throw new Error("Il validatore deve essere un oggetto JSON.");
          table.mongo = {
            validate: record(validator),
            validationLevel:
              typeof command.validationLevel === "string"
                ? command.validationLevel
                : undefined,
            validationAction:
              typeof command.validationAction === "string"
                ? command.validationAction
                : undefined,
          };
          if (record(validator)) {
            table.options.customValidator = true;
            table.options.validator = JSON.stringify(validator, null, 2);
            table.columns = mongoValidatorColumns(validator);
          }
          result.tables.push(table);
        } else if (
          typeof command.createIndexes === "string" &&
          Array.isArray(command.indexes)
        ) {
          const name = command.createIndexes;
          const indexes = command.indexes.map((index: unknown) => {
            if (
              !record(index) ||
              typeof index.name !== "string" ||
              !record(index.key) ||
              Object.keys(index).some(
                (key) => !["name", "key", "unique"].includes(key),
              ) ||
              Object.entries(index.key).some(
                ([field, direction]) => field.includes(",") || direction !== 1,
              )
            )
              throw new Error(
                "Il Designer importa indici MongoDB ascendenti semplici o composti.",
              );
            return {
              name: index.name,
              columns: Object.keys(index.key).join(", "),
              unique: index.unique === true,
            };
          });
          deferred.push({
            line,
            apply() {
              const table = result.tables.find((item) => item.name === name);
              if (!table)
                throw new Error(
                  `La collezione ${name} non è presente nel sorgente importato.`,
                );
              table.options.indexes.push(...indexes);
            },
          });
        } else
          throw new Error(
            "Comando MongoDB fuori dalle definizioni supportate dal Designer.",
          );
      } catch (error) {
        result.issues.push({
          line,
          message: `Comando ${position + 1}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } catch (error) {
    result.issues.push({
      line,
      message: `JSON non valido: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

export function previewSchemaImport(
  request: SchemaImportRequest,
): SchemaImportPreview {
  const result: SchemaImportPreview = {
    engine: request.engine,
    tables: [],
    issues: [],
  };
  if (request.source.length > 512 * 1024) {
    result.issues.push({
      line: 1,
      message:
        "Il sorgente supera 512 KiB. Estrai le definizioni dello schema in un file più piccolo.",
    });
    return result;
  }
  const deferred: Deferred[] = [];
  const createdNamespaces = new Set<string>();
  const expected = request.engine === "mongodb" ? "mongodb" : "sql";
  if (request.format === "source") {
    const extracted = extractDatabaseOperations(request.source, request.name);
    if (!extracted.operations.length)
      result.issues.push({
        line: 1,
        message:
          "Nessuna istruzione letterale del database riconosciuta nel sorgente.",
      });
    for (const operation of extracted.operations) {
      if (operation.kind !== expected || operation.confidence === "partial")
        result.issues.push({
          line: operation.startLine,
          message: "Frammento dinamico o di un motore incompatibile.",
        });
      else if (expected === "mongodb")
        readMongo(operation.text, operation.startLine, result, deferred);
      else
        readSql(
          operation.text,
          operation.startLine,
          result,
          deferred,
          createdNamespaces,
        );
    }
  } else if (request.format !== expected) {
    result.issues.push({
      line: 1,
      message: "Scegli il motore corrispondente al formato del sorgente.",
    });
  } else if (expected === "mongodb")
    readMongo(request.source, 1, result, deferred);
  else readSql(request.source, 1, result, deferred, createdNamespaces);

  for (const task of deferred) {
    try {
      task.apply();
    } catch (error) {
      result.issues.push({
        line: task.line,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const table of result.tables) {
    const schema = designObject(request.engine, table).schema;
    if (schema && createdNamespaces.has(schema)) table.createSchema = true;
  }
  if (
    result.tables.length > 100 ||
    result.tables.some((table) => table.columns.length > 500)
  ) {
    result.tables = [];
    result.issues.push({
      line: 1,
      message: "Il progetto supera 100 strutture o 500 campi per struttura.",
    });
  }
  if (result.tables.length) {
    try {
      buildProjectDdl(request.engine, result.tables);
    } catch (error) {
      result.issues.push({
        line: 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.issues.sort((a, b) => a.line - b.line);
  return result;
}
