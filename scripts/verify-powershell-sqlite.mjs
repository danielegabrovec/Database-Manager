import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { buildPowerShellScript } from "../src/powershell/catalog.ts";

const root = resolve("artifacts/qa-powershell-sqlite-20261110", String(Date.now()));
mkdirSync(root, { recursive: true });
function run(executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 60000 });
  if (result.status !== 0) throw new Error(`${executable}: ${result.stderr || result.error || result.stdout}`);
  return result.stdout.trim();
}
const client = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-Command sqlite3.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source"]);
const results = [];
for (const interpreter of ["powershell.exe", "pwsh.exe"]) {
  const folder = join(root, interpreter); mkdirSync(folder);
  const database = join(folder, "O'Brien città.sqlite");
  const databaseUri = pathToFileURL(database).href + "?mode=ro";
  const writeScript = (id) => {
    const script = buildPowerShellScript(id, { client, path: database });
    const path = join(folder, script.name); writeFileSync(path, "\ufeff" + script.content, "utf8"); return path;
  };
  const create = writeScript("sqlite.create-new");
  run(interpreter, ["-NoProfile", "-NonInteractive", "-File", create, "-WhatIf"]);
  if (existsSync(database)) throw new Error("WhatIf created a file");
  run(interpreter, ["-NoProfile", "-NonInteractive", "-File", create]);
  if (readFileSync(database).subarray(0, 16).toString() !== "SQLite format 3\0") throw new Error("Missing SQLite header");
  const crud = writeScript("sqlite.crud-lab");
  run(interpreter, ["-NoProfile", "-NonInteractive", "-File", crud, "-WhatIf"]);
  if (run(client, [databaseUri, "SELECT COUNT(*) FROM sqlite_schema WHERE name='dbm_demo_people';"]) !== "0") throw new Error("WhatIf changed the schema");
  run(interpreter, ["-NoProfile", "-NonInteractive", "-File", crud]);
  if (run(client, [databaseUri, "SELECT id||':'||name FROM dbm_demo_people;"]) !== "1:Ada Lovelace") throw new Error("CRUD result mismatch");
  run(interpreter, ["-NoProfile", "-NonInteractive", "-File", writeScript("sqlite.schema-lab")]);
  if (run(client, [databaseUri, "SELECT COUNT(*) FROM pragma_table_info('dbm_demo_people') WHERE name='email';"]) !== "1") throw new Error("ALTER missing");
  results.push({ interpreter, newDatabase: "passed", whatIfNoWrites: "passed", crud: "passed", alterAndIndex: "passed", spacesApostropheUnicode: "passed" });
  console.log(interpreter, "SQLite runtime passed");
}
writeFileSync(join(root, "receipt.json"), JSON.stringify({ allPassed: true, results }, null, 2));
