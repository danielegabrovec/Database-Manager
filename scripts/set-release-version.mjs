import { readFileSync, writeFileSync } from "node:fs";
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version || "")) throw new Error("Versione semantica richiesta");
for (const path of ["package.json", "package-lock.json", "src-tauri/tauri.conf.json"]) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.version = version;
  if (path === "package-lock.json") value.packages[""].version = version;
  if (path.endsWith("tauri.conf.json")) value.bundle.copyright = "Copyright © 2026 Daniele Gabrovec. Tutti i diritti riservati.";
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
const cargo = "src-tauri/Cargo.toml", lock = "src-tauri/Cargo.lock";
writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = "[^"]+"/m, `version = "${version}"`));
writeFileSync(lock, readFileSync(lock, "utf8").replace(/(name = "database-manager"\r?\nversion = )"[^"]+"/, `$1"${version}"`));
console.log(`Versione impostata: ${version}`);
