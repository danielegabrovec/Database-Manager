import { maskSqlNonCode } from "../editor/sqlLanguage";

export interface SqlClientDirective {
  line: number;
  client: "psql" | "mysql" | "sqlite-cli" | "sqlserver";
  command: string;
}
export function analyzeSqlScript(text: string): {
  nativeClientRequired: boolean;
  directives: SqlClientDirective[];
  warnings: string[];
} {
  if (text.length > 512 * 1024)
    return {
      nativeClientRequired: true,
      directives: [],
      warnings: [
        "Lo script supera 512 KiB. Usa l’importazione guidata da file, che evita di trattare un dump grande come una singola query interattiva.",
      ],
    };
  const code = maskSqlNonCode(text);
  const directives: SqlClientDirective[] = [];
  code.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (/^\\[a-z!?.]/i.test(trimmed))
      directives.push({
        line: index + 1,
        client: "psql",
        command: trimmed.split(/\s/)[0],
      });
    else if (/^(DELIMITER|SOURCE)\b/i.test(trimmed))
      directives.push({
        line: index + 1,
        client: "mysql",
        command: trimmed.split(/\s/)[0].toUpperCase(),
      });
    else if (/^\.[a-z]+\b/i.test(trimmed))
      directives.push({
        line: index + 1,
        client: "sqlite-cli",
        command: trimmed.split(/\s/)[0],
      });
    else if (/^GO(?:\s+\d+)?\s*;?$/i.test(trimmed))
      directives.push({ line: index + 1, client: "sqlserver", command: "GO" });
  });
  let statementLine = 1;
  for (const statement of code.split(";")) {
    if (
      /^\s*COPY\b/i.test(statement) &&
      /\b(?:FROM\s+stdin|TO\s+stdout)\b/i.test(statement)
    ) {
      const leading = statement.match(/^\s*/)?.[0] || "";
      directives.push({
        line: statementLine + (leading.match(/\n/g)?.length || 0),
        client: "psql",
        command: /\bFROM\s+stdin\b/i.test(statement)
          ? "COPY FROM stdin"
          : "COPY TO stdout",
      });
    }
    statementLine += statement.match(/\n/g)?.length || 0;
  }
  const clients = [...new Set(directives.map((d) => d.client))];
  const warnings = clients.map((client) =>
    client === "sqlserver"
      ? "Lo script contiene separatori GO del client SQL Server. SQL Server non è fra i motori supportati da questa versione."
      : client === "sqlite-cli"
        ? "Lo script contiene comandi del client sqlite3, non istruzioni SQL. Rimuovili o prepara uno script SQL prima di eseguire/importare."
        : `Lo script contiene direttive ${client}: il driver dell’editor non le interpreta. Usa l’importazione guidata con il motore e il client compatibili.`,
  );
  return {
    nativeClientRequired: directives.length > 0,
    directives: directives.sort((a, b) => a.line - b.line),
    warnings,
  };
}
