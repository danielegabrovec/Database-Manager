// Node.js 24 reads the same TypeScript content embedded in the offline app.
import { readFileSync, writeFileSync } from "node:fs";
import { guideSteps, queryRecipes, GUIDE_SOURCES } from "../src/help/guideContent.ts";
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const lines = ["# Guida operativa: PowerShell, database e query", "", `Database Manager ${version} · Daniele Gabrovec`, "", "La stessa guida è inclusa nell’app: pulsante **Guida** nella barra inferiore. Gli esempi usano esclusivamente dati sintetici. I client esterni e i server vanno predisposti separatamente; SQLite è incorporato nell’app.", "", "Questo documento è generato da `src/help/guideContent.ts`; per aggiornarlo: `node scripts/export-operational-guide.mjs`.", ""];
for (const [engine, label] of [["sqlite","SQLite"],["postgresql","PostgreSQL"],["mysql","MySQL"],["mariadb","MariaDB"],["mongodb","MongoDB"]]) {
  lines.push(`## ${label}`, "");
  for (const step of guideSteps(engine)) {
    lines.push(`### ${step.title}`, "", step.explanation, "");
    if (step.code) lines.push("```" + step.language, step.code, "```", "");
  }
  lines.push(`### Prontuario ${label}`, "", "Le query seguenti si riferiscono alle strutture e ai dati del tutorial precedente. Le operazioni di scrittura sono indicate espressamente; nel codice applicativo usare binding del driver per i valori.", "");
  for (const recipe of queryRecipes(engine)) lines.push(`#### ${recipe.title}`, "", recipe.explanation + (recipe.writes ? " **Modifica struttura o dati.**" : ""), "", "```" + (engine === "mongodb" ? "json" : "sql"), recipe.sql, "```", "");
}
lines.push("## Fonti ufficiali", "", ...GUIDE_SOURCES.map(([label,url]) => `- [${label}](${url})`), "");
writeFileSync(new URL("../docs/GUIDA-OPERATIVA-POWERSHELL-QUERY.md", import.meta.url), lines.join("\n"), "utf8");
console.log("Guida esportata: 5 motori, 50 passi e prontuario per ciascun motore.");
