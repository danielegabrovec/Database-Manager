/** Exercise the same model, graph, package and reimport paths as the UI on a QA bridge. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = process.cwd();
const output = path.join(root, "artifacts", "qa-060-agent");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "cycle-"));
const entry = path.join(directory, "cycle.mjs");
await build({
  stdin: {
    contents: [
      "export {interpretProjectGoal} from './src/project/goalPlan';",
      "export {testApplicationProject} from './src/project/projectTest';",
      "export {buildApplicationPackage} from './src/project/packageModel';",
      "export {applySourceChanges,scanProjectChanges} from './src/project/packageSync';",
    ].join("\n"),
    resolveDir: root,
    sourcefile: "cycle.ts",
  },
  platform: "node",
  format: "esm",
  bundle: true,
  packages: "external",
  jsx: "automatic",
  loader: { ".css": "empty" },
  outfile: entry,
});
globalThis.window = {};
const fetchLocal = globalThis.fetch;
globalThis.fetch = (input, options) =>
  fetchLocal(new URL(input, "http://127.0.0.1:8787"), options);
const {
  interpretProjectGoal,
  testApplicationProject,
  buildApplicationPackage,
  scanProjectChanges,
  applySourceChanges,
} = await import(pathToFileURL(entry).href);
const fixture=path.resolve("tests/project-cycle/ordini.json");
let blueprint;
if(process.argv[2]==="--ollama"){
  const response=await fetch("/api/project_ai_plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({
    requestId:crypto.randomUUID(),permission:"simulate",
    goal:"Crea un progetto Python con due SQLite. catalogo contiene clienti(id,nome), ordini(id,cliente_id,totale) con FOREIGN KEY(cliente_id) REFERENCES clienti(id), due clienti con id 1 e 2 e un ordine. archivio contiene clienti(id,nome) con id 1 e un nome diverso. In entrambi inserisci una ricerca SELECT id, nome FROM clienti WHERE id = 1 LIMIT 10. Usa nomi di database, colonne e tabelle come indicati."
  })});
  blueprint=await response.json();
  assert.ok(response.ok,JSON.stringify(blueprint));
  await writeFile(path.join(directory,"proposta.json"),JSON.stringify(blueprint,null,2));
}else{
  blueprint=JSON.parse(await readFile(path.resolve(process.argv[2]||fixture),"utf8"));
}
const { project, language } = interpretProjectGoal(blueprint);
const results = await testApplicationProject(project);
assert.ok(
  results.length === 2 && results.every((r) => r.status === "passed"),
  JSON.stringify(results),
);
const bundle = await buildApplicationPackage(project, language, true);
const generated = path.join(directory, "app");
for (const f of bundle.files) {
  const out = path.resolve(generated, f.path);
  assert.ok(out.startsWith(generated + path.sep));
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, f.content);
}
const targets = JSON.parse(
  await readFile(path.join(generated, "destinazioni.json"), "utf8"),
);
const run = (...args) =>
  execFileSync("python", ["progetto.py", ...args], {
    cwd: generated,
    encoding: "utf8",
  });
for (const target of targets) run("inizializza", target.alias);
const rows = targets.map((t) =>
  JSON.parse(
    run(
      "esegui",
      t.alias,
      t.modules.find((m) => m.table.name === "clienti").id,
      "list",
    ),
  ),
);
assert.notDeepEqual(rows[0], rows[1]);
const catalog = targets.find((t) => t.name === "catalogo");
const clients = catalog.modules.find((m) => m.table.name === "clienti");
const op = (verb, payload) =>
  run("esegui", catalog.alias, clients.id, verb, JSON.stringify(payload));
const insertedName = "Città di prova";
op("insert", { id: 808, nome: insertedName });
assert.ok(run("esegui", catalog.alias, clients.id, "list").includes("808"));
op("update", { id: 808, nome: "Aggiornato" });
assert.ok(
  run("esegui", catalog.alias, clients.id, "list").includes("Aggiornato"),
);
op("delete", { id: 808 });
assert.ok(!run("esegui", catalog.alias, clients.id, "list").includes("808"));
const manifest = JSON.parse(
  await readFile(path.join(generated, "database-manager-project.json"), "utf8"),
);
const database = project.databases.find((db) => db.name === "catalogo");
const mapped = manifest.files.find(
  (f) =>
    f.kind === "source" &&
    f.databaseId === database.id &&
    f.operationId === database.operations[0].id,
);
assert.ok(mapped, "Mappa della funzione generata mancante");
const sourcePath = path.join(generated, mapped.path);
const original = await readFile(sourcePath, "utf8");
const revised = original.replace(" = ?", " > ?");
assert.notEqual(
  revised,
  original,
  "La fixture deve modificare il filtro nella funzione generata: " + original,
);
await writeFile(sourcePath, revised);
const res = await fetch("/api/inspect_project_sources", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ directory: generated }),
});
const scanned = await res.json();
assert.ok(res.ok, JSON.stringify(scanned));
const changes = scanProjectChanges(project, scanned);
assert.equal(changes.length, 1);
assert.ifError(changes[0].error);
const updated = applySourceChanges(project, changes);
const retested = await testApplicationProject(updated);
assert.ok(
  retested.every((r) => r.status === "passed"),
  JSON.stringify(retested),
);
const readRows = (r) => r.steps.at(-1).result.sets[0].rows;
assert.notDeepEqual(readRows(retested[0]), readRows(results[0]));
assert.deepEqual(readRows(retested[1]), readRows(results[1]));
console.log(
  JSON.stringify({
    databaseCount: targets.length,
    applicationCrud: true,
    editedSource: mapped.path,
    roundTrip: true,
    language,
    tests: retested.map((r) => ({ database: r.name, status: r.status })),
    directory,
  }),
);
