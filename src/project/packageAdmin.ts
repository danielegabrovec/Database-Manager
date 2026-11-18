import { quoteIdentifier } from "../components/SchemaBuilders";
import type { Engine, GeneratedProject, ObjectRef } from "../types";

const CONTROL = /\p{Cc}/u;
const MONGO_DATABASE_CHARACTERS = /[ /\\."$*<>:|?]/;

function databaseName(name: string, engine: Engine) {
  if (
    !name.trim() ||
    CONTROL.test(name) ||
    new TextEncoder().encode(name).length > 63
  ) {
    throw new Error("Scrivi il nome fisico del database, entro 63 byte.");
  }
  if (engine === "mongodb" && MONGO_DATABASE_CHARACTERS.test(name)) {
    throw new Error(
      "Il nome del database contiene un carattere non valido per MongoDB.",
    );
  }
  return name;
}

function objectName(name: string, engine: Engine) {
  if (!name.trim() || CONTROL.test(name))
    throw new Error("Seleziona un nome di struttura valido.");
  if (
    engine === "mongodb" &&
    (name.startsWith("system.") ||
      name.includes("$") ||
      new TextEncoder().encode(name).length > 120)
  ) {
    throw new Error(
      "Seleziona una collezione applicativa con un nome MongoDB valido.",
    );
  }
  return name;
}

export function createDatabaseSnippet(
  engine: Engine,
  physicalName: string,
  initialCollection = "",
) {
  if (engine === "sqlite")
    throw new Error(
      "Crea un file SQLite dalla procedura Nuovo e scegli il percorso.",
    );
  const name = databaseName(physicalName, engine);
  if (engine === "mongodb") {
    const collection = objectName(initialCollection, engine);
    return `db.getSiblingDB(${JSON.stringify(name)}).createCollection(${JSON.stringify(collection)});`;
  }
  return `CREATE DATABASE ${quoteIdentifier(name, engine)};`;
}

export function removeStructureSnippet(
  engine: Engine,
  actual: ObjectRef,
  physicalDatabase = "",
) {
  const name = objectName(actual.name, engine);
  if (engine === "mongodb") {
    const database = databaseName(physicalDatabase, engine);
    return `db.getSiblingDB(${JSON.stringify(database)}).getCollection(${JSON.stringify(name)}).drop();`;
  }
  const namespace =
    engine === "sqlite"
      ? "main"
      : engine === "postgresql"
        ? objectName(actual.schema || "public", engine)
        : databaseName(physicalDatabase, engine);
  return `DROP TABLE ${quoteIdentifier(namespace, engine)}.${quoteIdentifier(name, engine)};`;
}

export function packageSchemaFiles(
  bundle: GeneratedProject | null,
  databaseId: string,
) {
  const index = bundle?.files.find(
    (entry) => entry.path === "destinazioni.json",
  );
  if (!index) return undefined;
  try {
    const targets: unknown = JSON.parse(index.content);
    if (!Array.isArray(targets)) return undefined;
    const target = targets.find(
      (item) => item?.id === databaseId && typeof item.schema === "string",
    );
    if (!target) return undefined;
    const schema = bundle?.files.find((file) => file.path === target.schema);
    if (!schema) return undefined;
    const setupDirectory = `${schema.path.slice(0, schema.path.lastIndexOf("/"))}/setup/`;
    const setup = bundle?.files.find(
      (file) =>
        file.path.startsWith(setupDirectory) &&
        /\.(rs|py|mjs|ts|java|cs|c|cpp|go|kt|php|rb)$/.test(file.path),
    );
    return { schema, setup };
  } catch {
    return undefined;
  }
}
