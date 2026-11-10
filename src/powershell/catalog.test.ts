import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  buildPowerShellScript,
  powerShellCatalog,
  powerShellLiteral,
} from "./catalog";
import type { PowerShellValues } from "./catalog";

const hostile = `C:\\Dati\\O'Brien\\più_日本語\\file’; Remove-Item C:\\important -Recurse; #$(Get-Secret)‘.sql`;
const parserHarness = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DBM_PS_PARSE_INPUT)) | ConvertFrom-Json
$results = @($payload | ForEach-Object {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($_.content, [ref]$tokens, [ref]$parseErrors)
    $commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
    [pscustomobject]@{ name = $_.name; errors = @($parseErrors | ForEach-Object { $_.Message }); commands = $commands }
})
ConvertTo-Json -InputObject $results -Depth 8 -Compress
`;

describe("PowerShell catalogue: copyable, deterministic templates", () => {
  it("covers read workflows and explicit guided write scenarios for all five engines", () => {
    expect(powerShellCatalog).toHaveLength(52);
    expect(new Set(powerShellCatalog.map((e) => e.id)).size).toBe(52);
    expect(new Set(powerShellCatalog.map((e) => e.category))).toEqual(
      new Set(["files", "diagnostics", "database", "docker", "ollama"]),
    );
    expect(
      new Set(powerShellCatalog.map((e) => e.engine).filter(Boolean)),
    ).toEqual(new Set(["sqlite", "postgresql", "mysql", "mariadb", "mongodb"]));
    for (const entry of powerShellCatalog) {
      expect(entry.explanation.length).toBeGreaterThan(20);
      expect(entry.prerequisites.length).toBeGreaterThan(0);
      expect(entry.docs.length).toBeGreaterThan(0);
      expect(entry.docs.every((d) => d.url.startsWith("https://"))).toBe(true);
      expect(
        entry.parameters.every((p) => !/password|secret|token/i.test(p.name)),
      ).toBe(true);
      const generated = buildPowerShellScript(entry.id);
      expect(generated.name.endsWith(".ps1")).toBe(true);
      expect(generated.content).toContain("#requires -Version 5.1");
      expect(generated.content).toContain("UTF-8 con BOM");
      expect(generated).toEqual(buildPowerShellScript(entry.id));
    }
  });

  it("escapes normal apostrophes and PowerShell smart quotes without expanding variables", () => {
    expect(powerShellLiteral("O'Brien")).toBe("'O''Brien'");
    const expression = powerShellLiteral(hostile);
    expect(expression).toContain("O''Brien");
    expect(expression).toContain("[char]0x2019");
    expect(expression).toContain("[char]0x2018");
    expect(expression).toContain("$(Get-Secret)");
    expect(() => powerShellLiteral("bad\0path")).toThrow(/NUL/);
    const script = buildPowerShellScript("files.metadata", { path: hostile });
    expect(script.content).toContain(`$path = ${expression}`);
    expect(script.content).toContain("Get-Item -LiteralPath $path");
  });

  it.each([
    "",
    "1; Remove-Item x",
    "1.5",
    "2e2",
    "Infinity",
    "9007199254740992",
  ])(
    "rejects an invalid integer %j instead of injecting it into a command",
    (value) => {
      expect(() =>
        buildPowerShellScript("sqlite.preview", { limit: value }),
      ).toThrow(/intero/);
    },
  );

  it("validates bounds and field types centrally; permits decimal integer strings only", () => {
    expect(
      buildPowerShellScript("sqlite.preview", { limit: "12" }).content,
    ).toContain("$limit = 12");
    for (const limit of [0, 201, NaN, Infinity, true])
      expect(() =>
        buildPowerShellScript("sqlite.preview", { limit }),
      ).toThrow();
    for (const path of ["", "\nsecond line", "nul\0path", 1, false])
      expect(() => buildPowerShellScript("files.metadata", { path })).toThrow();
    expect(() =>
      buildPowerShellScript("files.metadata", { unexpected: "value" }),
    ).toThrow(/non previsto/);
    expect(() => buildPowerShellScript("not-an-entry")).toThrow(/non trovato/);
  });

  it("advertises file writes honestly and always uses ShouldProcess without overwrite operations", () => {
    const writes = powerShellCatalog.filter((e) => e.effects !== "read");
    expect(
      writes.filter((e) => e.category === "files").map((e) => e.id),
    ).toEqual(["files.copy-new", "files.create-sql", "files.create-folder"]);
    expect(writes.filter((e) => e.effects === "modify-database")).toHaveLength(
      14,
    );
    for (const entry of writes) {
      const generated = buildPowerShellScript(entry.id);
      expect(generated.content).toContain(
        "[CmdletBinding(SupportsShouldProcess = $true",
      );
      expect(generated.content).toContain("$PSCmdlet.ShouldProcess(");
      expect(generated.warnings.join(" ")).toContain("-WhatIf");
      expect(generated.content).not.toMatch(
        /FileMode\]::Create(?!New)|Remove-Item|Set-Content|Out-File/,
      );
    }
    expect(buildPowerShellScript("files.copy-new").content).toContain(
      "[System.IO.FileMode]::CreateNew",
    );
  });

  it("guards SQLite existence, identifier quoting and actual CLI numeric binding", () => {
    const preview = buildPowerShellScript("sqlite.preview", {
      table: 'odd"name; DROP TABLE people',
    }).content;
    expect(preview).toContain("if (-not [System.IO.File]::Exists($path))");
    expect(preview).toContain("(Get-Item -LiteralPath $path -Force).FullName");
    expect(preview).toContain(`$table.Replace('"', '""')`);
    expect(preview).toContain("@('-batch', '-safe', '-readonly'");
    const bound = buildPowerShellScript("sqlite.bind-id", { id: 42 }).content;
    expect(bound).toContain('WHERE "id" = @lookup_id LIMIT 1;');
    expect(bound).toContain("'.parameter set @lookup_id ' + $id");
  });

  it("uses verified TLS, no password values and native argv on every server template", () => {
    for (const entry of powerShellCatalog.filter(
      (e) => e.engine && e.engine !== "sqlite",
    )) {
      const script = buildPowerShellScript(entry.id).content;
      expect(script).toContain("$info.UseShellExecute = $false");
      expect(script).toContain("ConvertTo-NativeArgument");
      expect(script).not.toMatch(
        /Invoke-Expression|cmd\.exe|ExecutionPolicy Bypass|--password=|PGPASSWORD\s*=/i,
      );
      expect(script).not.toMatch(/\$host\s*=/i); // PowerShell's automatic $Host is read-only.
      if (entry.engine === "postgresql")
        expect(script).toContain("PGSSLMODE = 'verify-full'");
      if (entry.engine === "mysql")
        expect(script).toContain("--ssl-mode=VERIFY_IDENTITY");
      if (entry.engine === "mariadb")
        expect(script).toContain("'--ssl', '--ssl-verify-server-cert'");
      if (entry.engine === "mongodb") {
        expect(script).toContain("'--quiet', '--norc'");
        expect(script).toContain("'--tls', '--tlsCAFile'");
        expect(script).toContain(", '--password')");
      }
    }
    expect(buildPowerShellScript("postgresql.preview").content).toContain(
      "$schema.Replace",
    );
    expect(buildPowerShellScript("mysql.preview").content).toContain(
      "$table.Replace('`', '``')",
    );
    expect(buildPowerShellScript("mongodb.preview").content).toContain(
      "ConvertTo-Json -InputObject $collection -Compress",
    );
  });

  it("keeps Docker read-only and Ollama on literal loopback without prompts or model downloads", () => {
    for (const entry of powerShellCatalog.filter(
      (e) => e.category === "docker",
    )) {
      expect(entry.effects).toBe("read");
      expect(buildPowerShellScript(entry.id).content).not.toMatch(
        /'prune'|'pull'|'up'|'down'|'stop'|'rm'/,
      );
    }
    for (const entry of powerShellCatalog.filter(
      (e) => e.category === "ollama",
    )) {
      const script = buildPowerShellScript(entry.id).content;
      expect(script).toContain("http://127.0.0.1:");
      expect(script).toContain("Invoke-RestMethod -Method Get");
      expect(script).not.toMatch(/generate|\/chat|\/pull|ollama\.com/);
    }
  });
});

// Only parser APIs run here. Generated scripts are never invoked by this test.
describe.skipIf(process.platform !== "win32")(
  "installed Windows PowerShell parsers",
  () => {
    it.each(["powershell.exe", "pwsh.exe"])(
      "%s parses all defaults and keeps hostile values out of the command AST",
      (executable) => {
        const baseline = powerShellCatalog.map((e) => ({
          name: e.id,
          content: buildPowerShellScript(e.id).content,
        }));
        const ids = [
          "files.metadata",
          "sqlite.preview",
          "postgresql.preview",
          "mysql.preview",
          "mongodb.preview",
        ];
        const hostileCases = ids.map((id) => {
          const entry = powerShellCatalog.find((e) => e.id === id)!;
          const values: PowerShellValues = {};
          for (const p of entry.parameters)
            if (p.type === "path" || p.type === "string")
              values[p.name] = hostile;
          return {
            name: `hostile:${id}`,
            content: buildPowerShellScript(id, values).content,
          };
        });
        const result = spawnSync(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            parserHarness,
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 30_000,
            env: {
              ...process.env,
              DBM_PS_PARSE_INPUT: Buffer.from(
                JSON.stringify([...baseline, ...hostileCases]),
                "utf8",
              ).toString("base64"),
            },
          },
        );
        if (
          result.error &&
          "code" in result.error &&
          result.error.code === "ENOENT"
        )
          return;
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        const parsed = JSON.parse(
          result.stdout.replace(/^\uFEFF/, "").trim(),
        ) as { name: string; errors: string[]; commands: (string | null)[] }[];
        expect(parsed).toHaveLength(57);
        for (const item of parsed) expect(item.errors, item.name).toEqual([]);
        for (const id of ids) {
          const original = parsed.find((e) => e.name === id)!;
          const injected = parsed.find((e) => e.name === `hostile:${id}`)!;
          expect(injected.commands, id).toEqual(original.commands);
          expect(injected.commands).not.toContain("Remove-Item");
          expect(injected.commands).not.toContain("Get-Secret");
        }
      },
      40_000,
    );
  },
);
