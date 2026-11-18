import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { buildProjectDdl } from "../designer/schemaProject";
import type { ApplicationProject } from "../project/applicationProject";
import {
  createDatabaseSnippet,
  packageSchemaFiles,
  removeStructureSnippet,
} from "../project/packageAdmin";
import type { ApplicationPackage } from "../project/packageModel";
import { ENGINE_LABELS } from "../types";
import { errorMessage, objectLabel } from "../utils";
import { Button, Field, Notice } from "./UI";

const MIGRATION_STATUS = {
  ready: "Da revisionare",
  blocked: "Bloccata",
  designer: "Applica dal Designer",
  unchanged: "Nessuna modifica",
};

export function ProjectSchemaAdmin({
  project,
  bundle,
}: {
  project: ApplicationProject;
  bundle: ApplicationPackage | null;
}) {
  const [databaseId, setDatabaseId] = useState("");
  const [createName, setCreateName] = useState("");
  const [firstCollection, setFirstCollection] = useState("");
  const [removeDatabase, setRemoveDatabase] = useState("");
  const [objectId, setObjectId] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [status, setStatus] = useState<{ copied: boolean; text: string }>();
  const database =
    project.databases.find((candidate) => candidate.id === databaseId) ??
    project.databases[0];
  const schema = packageSchemaFiles(bundle, database?.id ?? "");
  const migration = bundle?.migrations?.find(
    (plan) => plan.databaseId === database?.id,
  );
  const guide = bundle?.files.find(
    (file) => file.path === migration?.guidePath,
  );
  const migrationSql = bundle?.files.find(
    (file) => file.path === migration?.scriptPath,
  );
  const candidates = database?.tables.filter(
    (item) => !/view/i.test(item.source?.kind ?? ""),
  );
  const object = candidates?.find((candidate) => candidate.id === objectId);
  const actual = object?.source ?? object;
  const engine = database?.engine;
  const isMongo = engine === "mongodb";
  const needsRemoveDatabase =
    isMongo || engine === "mysql" || engine === "mariadb";

  useEffect(() => {
    setCreateName("");
    setFirstCollection("");
    setRemoveDatabase("");
    setObjectId("");
    setStatus(undefined);
  }, [database?.id]);

  useEffect(
    () => setReviewed(false),
    [database?.id, migration?.baselineSha256, migrationSql?.content],
  );

  async function copy(label: string, serialize: () => string) {
    try {
      const text = serialize();
      await navigator.clipboard.writeText(text);
      setStatus({ copied: true, text: `Copiato ${label}.` });
    } catch (error) {
      setStatus({ copied: false, text: errorMessage(error) });
    }
  }

  if (!database || !engine) return null;

  return (
    <section className="panel stack" aria-label="Schema e amministrazione">
      <h2>Schema e amministrazione</h2>
      <Field label="Database del progetto">
        <select
          value={database.id}
          onChange={(event) => setDatabaseId(event.target.value)}
        >
          {project.databases.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} · {ENGINE_LABELS[item.engine]}
            </option>
          ))}
        </select>
      </Field>
      <div className="row wrap">
        <Button
          onClick={() =>
            void copy(
              isMongo ? "schema JSON" : "schema SQL",
              () =>
                schema?.schema.content ??
                buildProjectDdl(engine, database.tables),
            )
          }
        >
          <Copy size={14} />
          Copia schema {isMongo ? "JSON" : "SQL"}
        </Button>
        <Button
          disabled={!schema?.setup}
          onClick={() =>
            void copy(
              "codice di creazione schema",
              () => schema!.setup!.content,
            )
          }
        >
          <Copy size={14} />
          Copia funzione di creazione schema
        </Button>
      </div>
      {!bundle && (
        <small>
          Genera il pacchetto per ottenere le funzioni di creazione e i piani di
          migrazione.
        </small>
      )}
      {bundle && !schema?.setup && (
        <small>
          Per questo motore e linguaggio è disponibile lo schema come script.
        </small>
      )}
      {isMongo && schema?.setup?.path.endsWith(".rs") && (
        <small>
          La funzione Rust usa anche il file schema.json nella sua cartella.
        </small>
      )}

      {migration && (
        <details>
          <summary>
            Migrazione · {MIGRATION_STATUS[migration.status]}
            {migration.destructive ? " · modifiche distruttive" : ""}
          </summary>
          {guide && (
            <pre
              className="mono"
              style={{ maxHeight: "10rem", overflow: "auto" }}
            >
              {guide.content}
            </pre>
          )}
          {migrationSql && (
            <>
              <pre
                className="mono"
                style={{ maxHeight: "14rem", overflow: "auto" }}
              >
                {migrationSql.content}
              </pre>
              <label className="check">
                <input
                  type="checkbox"
                  checked={reviewed}
                  onChange={(event) => setReviewed(event.target.checked)}
                />
                Ho rivisto il piano e la sua applicabilità
              </label>
              <Button
                disabled={!reviewed}
                onClick={() =>
                  void copy("piano di migrazione", () => migrationSql.content)
                }
              >
                <Copy size={14} />
                Copia migrazione
              </Button>
            </>
          )}
        </details>
      )}

      <details>
        <summary>Crea database sul server</summary>
        {engine === "sqlite" ? (
          <p>Usa Nuovo → Crea file SQLite e scegli il percorso del file.</p>
        ) : (
          <div className="stack">
            <Field label="Nome fisico del nuovo database">
              <input
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
              />
            </Field>
            {isMongo && (
              <Field label="Prima collezione">
                <input
                  value={firstCollection}
                  onChange={(event) => setFirstCollection(event.target.value)}
                />
              </Field>
            )}
            <Button
              disabled={
                !createName.trim() || (isMongo && !firstCollection.trim())
              }
              onClick={() =>
                void copy("comando di creazione database", () =>
                  createDatabaseSnippet(engine, createName, firstCollection),
                )
              }
            >
              <Copy size={14} />
              Copia {isMongo ? "creazione in mongosh" : "CREATE DATABASE"}
            </Button>
          </div>
        )}
      </details>

      <details>
        <summary>Rimuovi una struttura</summary>
        <div className="stack">
          <Notice>
            Il comando elimina {isMongo ? "la collezione" : "la tabella"} con i
            suoi dati quando lo applichi. Per eliminare righe usa Elimina nelle
            operazioni del pacchetto.
          </Notice>
          <Field
            label={isMongo ? "Collezione da rimuovere" : "Tabella da rimuovere"}
          >
            <select
              value={objectId}
              onChange={(event) => setObjectId(event.target.value)}
            >
              <option value="">Scegli una struttura</option>
              {candidates?.map((item) => (
                <option key={item.id} value={item.id}>
                  {objectLabel(item.source ?? item)}
                </option>
              ))}
            </select>
          </Field>
          {needsRemoveDatabase && (
            <Field label="Nome fisico del database che contiene la struttura">
              <input
                value={removeDatabase}
                onChange={(event) => setRemoveDatabase(event.target.value)}
              />
            </Field>
          )}
          <Button
            variant="danger"
            disabled={
              !actual || (needsRemoveDatabase && !removeDatabase.trim())
            }
            onClick={() =>
              actual &&
              void copy("comando di rimozione struttura", () =>
                removeStructureSnippet(engine, actual, removeDatabase),
              )
            }
          >
            <Copy size={14} />
            Copia{" "}
            {isMongo ? "rimozione della collezione in mongosh" : "DROP TABLE"}
          </Button>
        </div>
      </details>
      {status && (
        <Notice tone={status.copied ? "success" : "error"}>
          {status.text}
        </Notice>
      )}
    </section>
  );
}
