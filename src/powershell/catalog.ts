/** Copyable scripts only: this module performs no I/O, execution or credential lookup. */
export type PowerShellCategory =
  "files" | "diagnostics" | "database" | "docker" | "ollama";
export type PowerShellEngine =
  "sqlite" | "postgresql" | "mysql" | "mariadb" | "mongodb";
export type PowerShellEffect =
  "read" | "write-files" | "modify-database" | "modify-environment";
export type PowerShellValues = Record<string, string | number | boolean>;
export interface PowerShellParameter {
  name: string;
  label: string;
  type: "string" | "path" | "integer" | "boolean" | "choice";
  required: boolean;
  defaultValue: string | number | boolean;
  placeholder?: string;
  help: string;
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
}
export interface PowerShellEntry {
  id: string;
  title: string;
  category: PowerShellCategory;
  engine?: PowerShellEngine;
  level: "base" | "intermedio";
  description: string;
  explanation: string;
  prerequisites: string[];
  effects: PowerShellEffect;
  parameters: PowerShellParameter[];
  docs: { title: string; url: string }[];
}
export interface PowerShellScript {
  name: string;
  content: string;
  warnings: string[];
  prerequisites: string[];
}

const docs = {
  files: {
    title: "Microsoft: FileSystem e LiteralPath",
    url: "https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.management/get-childitem?view=powershell-5.1",
  },
  quote: {
    title: "Microsoft: regole delle stringhe PowerShell",
    url: "https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-5.1",
  },
  whatIf: {
    title: "Microsoft: SupportsShouldProcess e WhatIf",
    url: "https://learn.microsoft.com/en-us/powershell/scripting/learn/deep-dives/everything-about-shouldprocess",
  },
  sqlite: {
    title: "SQLite: shell CLI, readonly, safe e parametri",
    url: "https://www.sqlite.org/cli.html",
  },
  pg: {
    title: "PostgreSQL: psql",
    url: "https://www.postgresql.org/docs/current/app-psql.html",
  },
  pgTls: {
    title: "PostgreSQL: verifica TLS del client",
    url: "https://www.postgresql.org/docs/current/libpq-ssl.html",
  },
  mysql: {
    title: "MySQL: opzioni di connessione e TLS",
    url: "https://dev.mysql.com/doc/refman/8.4/en/connection-options.html",
  },
  maria: {
    title: "MariaDB: client da riga di comando",
    url: "https://mariadb.com/docs/server/clients-and-utilities/mariadb-client/mariadb-command-line-client",
  },
  mongo: {
    title: "MongoDB: opzioni mongosh",
    url: "https://www.mongodb.com/docs/mongodb-shell/reference/options/",
  },
  docker: {
    title: "Docker: riferimento CLI",
    url: "https://docs.docker.com/reference/cli/docker/",
  },
  compose: {
    title: "Docker Compose: config",
    url: "https://docs.docker.com/reference/cli/docker/compose/config/",
  },
  ollama: {
    title: "Ollama: riferimento API",
    url: "https://docs.ollama.com/api",
  },
  net: {
    title: "Microsoft: Test-NetConnection",
    url: "https://learn.microsoft.com/en-us/powershell/module/nettcpip/test-netconnection?view=windowsserver2025-ps",
  },
};

const text = (
  name: string,
  label: string,
  value: string,
  help: string,
  type: "path" | "string" = "string",
): PowerShellParameter => ({
  name,
  label,
  type,
  required: true,
  defaultValue: value,
  help,
});
const integer = (
  name: string,
  label: string,
  value: number,
  min: number,
  max: number,
): PowerShellParameter => ({
  name,
  label,
  type: "integer",
  required: true,
  defaultValue: value,
  min,
  max,
  help: `Numero intero fra ${min} e ${max}.`,
});
const folder = () =>
  text(
    "path",
    "Cartella",
    "C:\\Dati\\Esempi",
    "Percorso dimostrativo: scegliere una cartella reale.",
    "path",
  );
const file = (extension = "sql") =>
  text(
    "path",
    "File esistente",
    `C:\\Dati\\Esempi\\esempio.${extension}`,
    "Il file deve esistere: lo script non lo crea.",
    "path",
  );
const limit = () => integer("limit", "Numero massimo di risultati", 25, 1, 200);
const table = () =>
  text(
    "table",
    "Tabella",
    "people",
    "Nome singolo, trattato come identificatore e mai come SQL.",
  );
const client = (name: string) =>
  text(
    "client",
    "Client nativo",
    name,
    "Eseguibile già installato, nel PATH oppure percorso completo. Non è incluso nello script.",
  );
const serverParams = (engine: PowerShellEngine): PowerShellParameter[] => [
  client(
    engine === "postgresql"
      ? "psql.exe"
      : engine === "mysql"
        ? "mysql.exe"
        : engine === "mariadb"
          ? "mariadb.exe"
          : "mongosh.exe",
  ),
  text(
    "host",
    "Host TLS",
    "db.example.test",
    "Host dimostrativo: sostituirlo con il nome presente nel certificato TLS del proprio server.",
  ),
  integer(
    "port",
    "Porta",
    engine === "postgresql" ? 5432 : engine === "mongodb" ? 27017 : 3306,
    1,
    65535,
  ),
  text(
    "database",
    "Database",
    "laboratory",
    "Database già esistente; nessuna creazione automatica.",
  ),
  text(
    "username",
    "Utente",
    "dbm_reader",
    "Account esistente con i soli permessi necessari. La password viene chiesta dal client.",
  ),
  text(
    "caPath",
    "Certificato CA",
    "C:\\Dati\\certificati\\ca.pem",
    "Certificato CA PEM esistente, usato per verificare il server.",
    "path",
  ),
];

/** A verbatim PowerShell expression. Smart quote characters are explicit chars,
 * because the PowerShell tokenizer also recognizes curly quotation marks. */
export function powerShellLiteral(value: string): string {
  if (value.includes("\0"))
    throw new Error("Il testo contiene un carattere NUL.");
  const parts: string[] = [];
  let chunk = "";
  for (const ch of value) {
    if ("\u2018\u2019\u201a\u201b\u201c\u201d\u201e".includes(ch)) {
      parts.push(
        `'${chunk.replaceAll("'", "''")}'`,
        `[char]0x${ch.charCodeAt(0).toString(16)}`,
      );
      chunk = "";
    } else chunk += ch;
  }
  parts.push(`'${chunk.replaceAll("'", "''")}'`);
  return parts.length > 1 ? `(${parts.join(" + ")})` : parts[0];
}

const nativeHelper = String.raw`
# Argomenti separati, codificati per le CLI Windows anche in PowerShell 5.1.
# Nessuna shell, password o comando di download.
function ConvertTo-NativeArgument {
    param([AllowEmptyString()][string]$Value)
    $result = New-Object System.Text.StringBuilder
    [void]$result.Append('"')
    $slashes = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') { $slashes++; continue }
        if ($character -eq '"') {
            [void]$result.Append(('\' * ($slashes * 2 + 1)))
            [void]$result.Append('"')
        } else {
            [void]$result.Append(('\' * $slashes))
            [void]$result.Append($character)
        }
        $slashes = 0
    }
    [void]$result.Append(('\' * ($slashes * 2)))
    [void]$result.Append('"')
    $result.ToString()
}
function Invoke-NativeClient {
    param([string]$Executable, [string[]]$Arguments, [hashtable]$Environment = @{})
    if ([System.IO.Path]::IsPathRooted($Executable) -or $Executable.Contains('\') -or $Executable.Contains('/')) {
        $clientFile = Get-Item -LiteralPath $Executable -Force -ErrorAction Stop
        if ($clientFile.PSIsContainer) { throw 'Il client deve essere un file eseguibile.' }
        $clientPath = $clientFile.FullName
    } else {
        $resolvedClient = @(Get-Command -Name $Executable -CommandType Application -ErrorAction Stop)
        if ($resolvedClient.Count -ne 1) { throw 'Specificare un solo eseguibile client.' }
        $clientPath = $resolvedClient[0].Source
    }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $clientPath
    $info.UseShellExecute = $false
    $info.Arguments = (($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join ' ')
    # Non prelevare password dall'ambiente: autenticazione interattiva del client.
    [void]$info.EnvironmentVariables.Remove('PGPASSWORD')
    [void]$info.EnvironmentVariables.Remove('MYSQL_PWD')
    foreach ($key in $Environment.Keys) { $info.EnvironmentVariables[$key] = [string]$Environment[$key] }
    $process = [System.Diagnostics.Process]::Start($info)
    try {
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw ('Client terminato con codice ' + $process.ExitCode) }
    } finally { $process.Dispose() }
}
`;

type Definition = PowerShellEntry & { body: string; native?: boolean };
const definitions: Definition[] = [];
function add(
  id: string,
  title: string,
  category: PowerShellCategory,
  parameters: PowerShellParameter[],
  body: string,
  options: Partial<
    Omit<Definition, "id" | "title" | "category" | "parameters" | "body">
  > = {},
) {
  definitions.push({
    id,
    title,
    category,
    parameters,
    body,
    level: "base",
    effects: "read",
    description: title,
    explanation:
      "Esempio deterministico da leggere e adattare prima di eseguirlo nel proprio terminale. Non viene eseguito dall’app.",
    prerequisites: [
      "Windows e PowerShell 5.1 o successivo; funziona anche con PowerShell 7 su Windows.",
    ],
    docs: [docs.files, docs.quote],
    ...options,
  });
}

add(
  "files.list",
  "Elencare una cartella",
  "files",
  [folder(), limit()],
  String.raw`
Get-ChildItem -LiteralPath $path -Force | Select-Object -First $limit Name, Mode, Length, LastWriteTime
`,
  {
    explanation:
      "Legge solo il primo livello. -LiteralPath evita che parentesi quadre o altri caratteri del percorso siano interpretati come wildcard.",
  },
);
add(
  "files.find-sources",
  "Trovare SQL e sorgenti in una cartella",
  "files",
  [folder(), limit()],
  String.raw`
Get-ChildItem -LiteralPath $path -File | Where-Object { $_.Extension -in '.sql', '.ps1', '.rs', '.py', '.js', '.ts', '.cs', '.java', '.go', '.php', '.rb', '.cpp' } | Select-Object -First $limit Name, FullName, Length
`,
  {
    explanation:
      "Filtra per estensione senza leggere o eseguire i file. La ricerca è nel livello selezionato e non percorre tutte le sottocartelle.",
  },
);
add(
  "files.metadata",
  "Controllare metadati e attributi di un file",
  "files",
  [file()],
  String.raw`
Get-Item -LiteralPath $path -Force | Select-Object FullName, Length, Extension, Attributes, CreationTimeUtc, LastWriteTimeUtc
`,
);
add(
  "files.preview-utf8",
  "Leggere le prime righe di un file UTF-8",
  "files",
  [file(), integer("lines", "Righe", 40, 1, 200)],
  String.raw`
Get-Content -LiteralPath $path -Encoding UTF8 -TotalCount $lines
`,
  {
    explanation:
      "Anteprima testuale, senza esecuzione SQL o sorgente. Usare solo per file noti come UTF-8: non rileva automaticamente Windows-1252 o UTF-16.",
  },
);
add(
  "files.sha256",
  "Calcolare SHA-256 di un file",
  "files",
  [file("db")],
  String.raw`
Get-FileHash -LiteralPath $path -Algorithm SHA256 | Select-Object Path, Algorithm, Hash
`,
  {
    explanation:
      "Calcola l’hash dei byte leggendo il file in streaming. Il valore cambia se cambia anche un solo byte.",
  },
);
add(
  "files.sqlite-header",
  "Verificare l’intestazione SQLite senza aprire il DB",
  "files",
  [file("db")],
  String.raw`
$stream = [System.IO.File]::OpenRead($path)
try {
    $header = New-Object byte[] 16
    $count = $stream.Read($header, 0, 16)
    $isSqlite = $count -eq 16 -and [System.Text.Encoding]::ASCII.GetString($header) -ceq ("SQLite format 3" + [char]0)
    [pscustomobject]@{ Path = $path; HasSQLiteHeader = $isSqlite }
} finally { $stream.Dispose() }
`,
  {
    explanation:
      "Legge solo 16 byte. Un’intestazione valida identifica il formato, ma non dimostra l’integrità del database; non crea un file se il percorso è errato.",
  },
);
add(
  "files.copy-new",
  "Copiare un file senza sovrascrivere",
  "files",
  [
    file(),
    text(
      "destination",
      "Nuovo file destinazione",
      "C:\\Dati\\Esempi\\copia.sql",
      "Deve essere un file nuovo, in una cartella già esistente.",
      "path",
    ),
  ],
  String.raw`
if ($PSCmdlet.ShouldProcess($destination, 'Creare copia senza sovrascrivere')) {
    $inputStream = [System.IO.File]::OpenRead($path)
    try {
        $outputStream = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
}
`,
  {
    effects: "write-files",
    level: "intermedio",
    docs: [docs.files, docs.whatIf],
    explanation:
      "Usa CreateNew: se la destinazione esiste, fallisce. Supporta -WhatIf. Non è un backup coerente di un database aperto: per SQLite usare il backup dell’app o la CLI .backup.",
  },
);
add(
  "files.create-sql",
  "Creare un nuovo esempio SQL UTF-8",
  "files",
  [
    text(
      "path",
      "Nuovo file SQL",
      "C:\\Dati\\Esempi\\lettura.sql",
      "Nuovo file in una cartella esistente; non sovrascrive.",
      "path",
    ),
  ],
  String.raw`
if ($PSCmdlet.ShouldProcess($path, 'Creare esempio SQL UTF-8 senza sovrascrivere')) {
    $content = "-- Esempio sintetico: nessun dato personale." + [Environment]::NewLine + "SELECT 1 AS example_value;" + [Environment]::NewLine
    $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($content)
    $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
}
`,
  {
    effects: "write-files",
    docs: [docs.files, docs.whatIf],
    explanation:
      "Crea solo un file nuovo, in UTF-8 senza BOM; non esegue il SELECT. Per simulare aggiungere -WhatIf all’esecuzione dello script.",
  },
);
add(
  "files.create-folder",
  "Creare una cartella nuova con anteprima WhatIf",
  "files",
  [folder()],
  String.raw`
if (Test-Path -LiteralPath $path) { throw 'Il percorso esiste già: nessuna modifica.' }
if ($PSCmdlet.ShouldProcess($path, 'Creare cartella')) { [void][System.IO.Directory]::CreateDirectory($path) }
`,
  {
    effects: "write-files",
    docs: [docs.files, docs.whatIf],
    explanation:
      "Rifiuta un percorso già esistente e supporta -WhatIf. CreateDirectory può creare anche eventuali cartelle superiori mancanti; non sposta né cancella dati.",
  },
);

add(
  "diagnostics.version",
  "Conoscere versione PowerShell e Windows",
  "diagnostics",
  [],
  String.raw`
$PSVersionTable
[Environment]::OSVersion.VersionString
`,
);
add(
  "diagnostics.clients",
  "Individuare i client già installati",
  "diagnostics",
  [],
  String.raw`
'sqlite3.exe', 'psql.exe', 'mysql.exe', 'mariadb.exe', 'mongosh.exe', 'docker.exe', 'ollama.exe' | ForEach-Object {
    $command = Get-Command -Name $_ -CommandType Application -ErrorAction SilentlyContinue
    [pscustomobject]@{ Name = $_; Found = [bool]$command; Path = ($command.Source -join '; ') }
}
`,
  {
    explanation:
      "Cerca soltanto gli eseguibili nel PATH della sessione corrente. Non installa nulla e non garantisce che un server sia avviato.",
  },
);
add(
  "diagnostics.port",
  "Controllare le connessioni TCP su una porta",
  "diagnostics",
  [integer("port", "Porta locale", 5432, 1, 65535)],
  String.raw`
Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, RemoteAddress, State, OwningProcess
`,
  {
    prerequisites: [
      "Windows con il modulo NetTCPIP; alcune informazioni richiedono permessi aggiuntivi.",
    ],
    docs: [docs.net],
  },
);
add(
  "diagnostics.tcp",
  "Verificare raggiungibilità TCP del server",
  "diagnostics",
  [
    text(
      "host",
      "Host",
      "127.0.0.1",
      "Host da verificare: viene effettuata una connessione TCP di prova.",
    ),
    integer("port", "Porta", 5432, 1, 65535),
  ],
  String.raw`
Test-NetConnection -ComputerName $host -Port $port -InformationLevel Detailed
`,
  {
    explanation:
      "Effettua una prova di rete verso l’host scelto. Non verifica credenziali, protocollo database o validità TLS.",
    prerequisites: [
      "Windows con modulo NetTCPIP e accesso di rete all’host scelto.",
    ],
    docs: [docs.net],
  },
);
add(
  "diagnostics.disks",
  "Controllare lo spazio disponibile",
  "diagnostics",
  [],
  String.raw`
Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, Used, Free
`,
  {
    explanation:
      "Mostra i dischi visibili alla sessione PowerShell e i byte liberi, utile prima di un’esportazione o backup.",
  },
);
add(
  "diagnostics.process",
  "Leggere lo stato di un processo server",
  "diagnostics",
  [
    text(
      "processName",
      "Nome processo senza .exe",
      "postgres",
      "Esempi: postgres, mysqld, mariadbd, mongod. Nessuna terminazione.",
    ),
  ],
  String.raw`
Get-Process -Name $processName -ErrorAction SilentlyContinue | Select-Object Id, ProcessName, CPU, WorkingSet64, StartTime
`,
  {
    explanation:
      "Consulta i processi con quel nome; non avvia, termina o modifica servizi. Alcuni campi possono non essere accessibili senza permessi.",
  },
);

const nativePrerequisite =
  "Client CLI indicato già installato e disponibile nel PATH o tramite percorso completo; non viene distribuito né installato dallo script.";
const sqliteParams = () => [client("sqlite3.exe"), file("db")];
const sqliteRun = (sql: string) =>
  `Invoke-NativeClient -Executable $client -Arguments @('-batch', '-safe', '-readonly', '-json', $path, ${sql})`;
add(
  "sqlite.tables",
  "SQLite: elencare tabelle e viste",
  "database",
  sqliteParams(),
  sqliteRun(
    powerShellLiteral(
      "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name;",
    ),
  ),
  {
    engine: "sqlite",
    native: true,
    prerequisites: [
      nativePrerequisite,
      "sqlite3 CLI 3.37 o successivo e file SQLite già esistente.",
    ],
    docs: [docs.sqlite],
    explanation:
      "Apre solo in lettura con -safe e restituisce metadati JSON. La presenza del file viene controllata prima di lanciare il client.",
  },
);
add(
  "sqlite.preview",
  "SQLite: leggere un numero limitato di righe",
  "database",
  [...sqliteParams(), table(), limit()],
  String.raw`
$quotedTable = '"' + $table.Replace('"', '""') + '"'
$sql = 'SELECT * FROM ' + $quotedTable + ' LIMIT ' + $limit + ';'
` + sqliteRun("$sql"),
  {
    engine: "sqlite",
    native: true,
    prerequisites: [
      nativePrerequisite,
      "sqlite3 CLI 3.37+, file e tabella esistenti.",
    ],
    docs: [docs.sqlite],
    explanation:
      "Il nome della tabella è quotato come un singolo identificatore SQLite; il limite è un intero validato. Non esegue SQL scritto dall’utente.",
  },
);
add(
  "sqlite.quick-check",
  "SQLite: controllare l’integrità con quick_check",
  "database",
  sqliteParams(),
  sqliteRun(powerShellLiteral("PRAGMA quick_check;")),
  {
    engine: "sqlite",
    native: true,
    level: "intermedio",
    prerequisites: [
      nativePrerequisite,
      "sqlite3 CLI 3.37+ e database esistente; il controllo può richiedere tempo.",
    ],
    docs: [docs.sqlite],
    explanation:
      "Esegue un controllo di integrità in sola lettura. L’esito ok non sostituisce un backup e non dimostra correttezza logica dei dati.",
  },
);
add(
  "sqlite.bind-id",
  "SQLite: SELECT con parametro numerico associato",
  "database",
  [
    ...sqliteParams(),
    table(),
    integer("id", "ID di esempio", 1, -2147483648, 2147483647),
  ],
  String.raw`
$quotedTable = '"' + $table.Replace('"', '""') + '"'
$sql = 'SELECT * FROM ' + $quotedTable + ' WHERE "id" = @lookup_id LIMIT 1;'
# .parameter conserva il parametro separato dal SELECT. L'esempio assume una colonna id.
Invoke-NativeClient -Executable $client -Arguments @('-batch', '-safe', '-readonly', '-json', '-cmd', '.parameter init', '-cmd', ('.parameter set @lookup_id ' + $id), $path, $sql)
`,
  {
    engine: "sqlite",
    native: true,
    level: "intermedio",
    prerequisites: [
      nativePrerequisite,
      "sqlite3 CLI 3.37+, tabella esistente con colonna id numerica.",
    ],
    docs: [docs.sqlite],
    explanation:
      "Il valore intero viene associato al parametro @lookup_id tramite la CLI SQLite; non viene concatenato nel SELECT. I parametri non sostituiscono nomi di tabelle o colonne.",
  },
);

const pgRun = (sql: string) =>
  `Invoke-NativeClient -Executable $client -Arguments @('-X', '--password', '--host', $host, '--port', [string]$port, '--username', $username, '--dbname', $database, '--set', 'ON_ERROR_STOP=1', '--command', ${sql}) -Environment @{ PGSSLMODE = 'verify-full'; PGSSLROOTCERT = $caPath; PGCLIENTENCODING = 'UTF8' }`;
const pgOptions = {
  engine: "postgresql" as const,
  native: true,
  docs: [docs.pg, docs.pgTls],
  prerequisites: [
    nativePrerequisite,
    "Server PostgreSQL con TLS, certificato che corrisponde all’host e CA PEM scelta; account con permessi di lettura. Password chiesta da psql.",
  ],
};
add(
  "postgresql.ping",
  "PostgreSQL: verificare connessione e versione",
  "database",
  serverParams("postgresql"),
  pgRun(
    powerShellLiteral("SELECT current_database(), current_user, version();"),
  ),
  {
    ...pgOptions,
    explanation:
      "Disabilita psqlrc con -X e richiede TLS verify-full. La password è richiesta dal client e non compare nello script né negli argomenti.",
  },
);
add(
  "postgresql.tables",
  "PostgreSQL: elencare tabelle e schemi",
  "database",
  serverParams("postgresql"),
  pgRun(
    powerShellLiteral(
      "SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name;",
    ),
  ),
  pgOptions,
);
add(
  "postgresql.preview",
  "PostgreSQL: leggere una tabella qualificata",
  "database",
  [
    ...serverParams("postgresql"),
    text(
      "schema",
      "Schema",
      "public",
      "Schema esistente, separato dal nome della tabella.",
    ),
    table(),
    limit(),
  ],
  String.raw`
$qualifiedTable = '"' + $schema.Replace('"', '""') + '"."' + $table.Replace('"', '""') + '"'
$sql = 'SELECT * FROM ' + $qualifiedTable + ' LIMIT ' + $limit + ';'
` + pgRun("$sql"),
  {
    ...pgOptions,
    level: "intermedio",
    explanation:
      "Quota schema e tabella separatamente: analytics.orders non viene trasformato accidentalmente in public.orders. Il limite viene validato come intero.",
  },
);

for (const engine of ["mysql", "mariadb"] as const) {
  const label = engine === "mysql" ? "MySQL" : "MariaDB";
  const tls =
    engine === "mysql"
      ? "'--ssl-mode=VERIFY_IDENTITY'"
      : "'--ssl', '--ssl-verify-server-cert'";
  const run = (sql: string) =>
    `Invoke-NativeClient -Executable $client -Arguments @('--no-defaults', '--protocol=TCP', ('--host=' + $host), ('--port=' + $port), ('--user=' + $username), '--password', ('--database=' + $database), ${tls}, ('--ssl-ca=' + $caPath), '--local-infile=0', '--batch', '--execute', ${sql})`;
  const options = {
    engine,
    native: true,
    prerequisites: [
      nativePrerequisite,
      `${label} con TLS e certificato valido per l'host; CA PEM e account con permessi di lettura. Password chiesta dal client.`,
    ],
    docs: [engine === "mysql" ? docs.mysql : docs.maria],
  };
  add(
    `${engine}.tables`,
    `${label}: elencare le tabelle`,
    "database",
    serverParams(engine),
    run(powerShellLiteral("SHOW FULL TABLES;")),
    {
      ...options,
      explanation:
        "Ignora i normali file di opzioni con --no-defaults, richiede verifica TLS e autenticazione interattiva. Non crea né modifica database.",
    },
  );
  add(
    `${engine}.preview`,
    `${label}: leggere righe di una tabella`,
    "database",
    [...serverParams(engine), table(), limit()],
    String.raw`
$quotedTable = '` +
      "`" +
      String.raw`' + $table.Replace('` +
      "`" +
      String.raw`', '` +
      "``" +
      String.raw`') + '` +
      "`" +
      String.raw`'
$sql = 'SELECT * FROM ' + $quotedTable + ' LIMIT ' + $limit + ';'
` +
      run("$sql"),
    {
      ...options,
      level: "intermedio",
      explanation:
        "I backtick nel nome sono raddoppiati per costruire un singolo identificatore SQL. Il limite è un intero validato; il contenuto non diventa un comando PowerShell.",
    },
  );
}

const mongoOptions = {
  engine: "mongodb" as const,
  native: true,
  prerequisites: [
    nativePrerequisite,
    "mongosh moderno e MongoDB con TLS verificabile tramite CA PEM; utente con ruolo di lettura nel database indicato.",
  ],
  docs: [docs.mongo],
};
const mongoRun = (js: string) =>
  `Invoke-NativeClient -Executable $client -Arguments @('--quiet', '--norc', '--host', $host, '--port', [string]$port, '--username', $username, '--authenticationDatabase', $database, '--tls', '--tlsCAFile', $caPath, '--eval', ${js}, '--password')`;
add(
  "mongodb.ping",
  "MongoDB: verificare la connessione",
  "database",
  serverParams("mongodb"),
  mongoRun(powerShellLiteral("printjson(db.adminCommand({ ping: 1 }));")),
  {
    ...mongoOptions,
    explanation:
      "Usa TLS e --norc per non caricare script mongosh personali. --password finale fa chiedere la password al client: non è salvata nel catalogo.",
  },
);
add(
  "mongodb.collections",
  "MongoDB: elencare le collezioni",
  "database",
  serverParams("mongodb"),
  String.raw`
$js = 'printjson(db.getSiblingDB(' + (ConvertTo-Json -InputObject $database -Compress) + ').getCollectionNames());'
` + mongoRun("$js"),
  mongoOptions,
);
add(
  "mongodb.preview",
  "MongoDB: leggere un numero limitato di documenti",
  "database",
  [
    ...serverParams("mongodb"),
    text(
      "collection",
      "Collezione",
      "people",
      "Nome della collezione, inserito come stringa JSON e non come JavaScript.",
    ),
    limit(),
  ],
  String.raw`
$js = 'db.getSiblingDB(' + (ConvertTo-Json -InputObject $database -Compress) + ').getCollection(' + (ConvertTo-Json -InputObject $collection -Compress) + ').find({}).limit(' + $limit + ').forEach(function(document) { printjson(document); });'
` + mongoRun("$js"),
  {
    ...mongoOptions,
    level: "intermedio",
    explanation:
      "Database e collezione sono serializzati come stringhe JSON. Il filtro è fisso {}, i documenti sono limitati e stampati da mongosh conservando la rappresentazione BSON della shell.",
  },
);

const dockerOptions = {
  native: true,
  prerequisites: [
    nativePrerequisite,
    "Docker CLI già installata; per container/log/stato serve un engine Docker già attivo e autorizzato.",
  ],
  docs: [docs.docker],
};
add(
  "docker.contexts",
  "Docker: vedere i contesti disponibili",
  "docker",
  [client("docker.exe")],
  "Invoke-NativeClient -Executable $client -Arguments @('context', 'ls')",
  {
    ...dockerOptions,
    explanation:
      "Elenca i contesti senza cambiare quello attivo. Le altre voci Docker usano esplicitamente il contesto richiesto.",
  },
);
const dockerParams = () => [
  client("docker.exe"),
  text(
    "context",
    "Contesto Docker",
    "desktop-linux",
    "Contesto già esistente: non viene selezionato globalmente.",
  ),
];
add(
  "docker.containers",
  "Docker: elencare container e porte",
  "docker",
  dockerParams(),
  "Invoke-NativeClient -Executable $client -Arguments @('--context', $context, 'ps', '--all')",
  dockerOptions,
);
add(
  "docker.logs",
  "Docker: leggere le ultime righe di log",
  "docker",
  [
    ...dockerParams(),
    text(
      "container",
      "Nome o ID container",
      "dbm-example-db-1",
      "Un container esistente scelto dall’utente.",
    ),
    integer("lines", "Righe finali", 50, 1, 200),
  ],
  "Invoke-NativeClient -Executable $client -Arguments @('--context', $context, 'logs', ('--tail=' + $lines), '--', $container)",
  {
    ...dockerOptions,
    explanation:
      "Legge un numero limitato di righe senza follow. I log del server possono contenere dati riservati: valutarli prima di condividerli.",
  },
);
add(
  "docker.inspect",
  "Docker: leggere lo stato di un container",
  "docker",
  [
    ...dockerParams(),
    text(
      "container",
      "Nome o ID container",
      "dbm-example-db-1",
      "Non vengono stampate le variabili d’ambiente o credenziali del container.",
    ),
  ],
  "Invoke-NativeClient -Executable $client -Arguments @('--context', $context, 'inspect', '--type=container', '--format', '{{json .State}}', '--', $container)",
  {
    ...dockerOptions,
    explanation:
      "Mostra solo lo stato del container selezionato. Non esegue docker inspect completo con variabili d’ambiente e configurazioni potenzialmente riservate.",
  },
);
add(
  "docker.compose-services",
  "Docker Compose: verificare i nomi dei servizi",
  "docker",
  [
    client("docker.exe"),
    text(
      "path",
      "File Compose esistente",
      "C:\\Dati\\Esempi\\compose.yaml",
      "Legge il file Compose e la sua configurazione; non avvia servizi.",
      "path",
    ),
  ],
  String.raw`
Invoke-NativeClient -Executable $client -Arguments @('compose', '--file', $path, 'config', '--services')
`,
  {
    ...dockerOptions,
    level: "intermedio",
    docs: [docs.compose],
    explanation:
      "Valida la configurazione ed elenca i nomi dei servizi. Non usa up, pull, down o prune. Compose può leggere .env e file referenziati: usare solo un progetto locale fidato.",
  },
);

for (const [id, title, endpoint, explanation] of [
  [
    "version",
    "Ollama: conoscere la versione locale",
    "version",
    "Legge solo la versione del server locale; nessun prompt, inferenza o download.",
  ],
  [
    "models",
    "Ollama: elencare i modelli locali",
    "tags",
    "Legge i metadati dei modelli presenti; non scarica né carica modelli.",
  ],
  [
    "running",
    "Ollama: vedere i modelli caricati in memoria",
    "ps",
    "Legge lo stato dei modelli caricati; non avvia inferenze e non libera la memoria.",
  ],
]) {
  add(
    `ollama.${id}`,
    title,
    "ollama",
    [integer("port", "Porta locale Ollama", 11434, 1, 65535)],
    `Invoke-RestMethod -Method Get -Uri ('http://127.0.0.1:' + $port + '/api/${endpoint}') -TimeoutSec 10 | ConvertTo-Json -Depth 8`,
    {
      explanation,
      prerequisites: [
        "Ollama già installato e server locale in ascolto sulla porta scelta. Nessuna API cloud.",
      ],
      docs: [docs.ollama],
    },
  );
}

// Guided write scenarios always use a dedicated synthetic table and explicit ShouldProcess.
const demoSql = (engine: PowerShellEngine) => {
  const id =
    engine === "sqlite"
      ? "INTEGER PRIMARY KEY"
      : engine === "postgresql"
        ? "INTEGER PRIMARY KEY"
        : "INT PRIMARY KEY";
  return `CREATE TABLE dbm_demo_people (id ${id}, name VARCHAR(100) NOT NULL); INSERT INTO dbm_demo_people(id,name) VALUES(1,'Ada'),(2,'Grace'); SELECT * FROM dbm_demo_people ORDER BY id; UPDATE dbm_demo_people SET name='Ada Lovelace' WHERE id=1; SELECT * FROM dbm_demo_people WHERE id=1; DELETE FROM dbm_demo_people WHERE id=2; SELECT * FROM dbm_demo_people ORDER BY id;`;
};
add(
  "sqlite.create-new",
  "SQLite: creare un database nuovo",
  "database",
  [
    client("sqlite3.exe"),
    text(
      "path",
      "Nuovo file SQLite",
      "C:\\Dati\\dbm-laboratorio.sqlite",
      "Percorso nuovo: la cartella deve esistere; nessun file viene sovrascritto.",
      "path",
    ),
  ],
  String.raw`
if ([System.IO.File]::Exists($path)) { throw 'Il file esiste già: sceglierne uno nuovo.' }
if ($PSCmdlet.ShouldProcess($path, 'Crea un nuovo database SQLite')) {
    $command = Get-Command -Name $client -CommandType Application -ErrorAction Stop | Select-Object -First 1
    $reserved = New-Object System.IO.FileStream($path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $reserved.Dispose()
    $path = (Get-Item -LiteralPath $path).FullName
    $path = ([System.Uri]$path).AbsoluteUri + '?mode=rw'
    Invoke-NativeClient -Executable $command.Source -Arguments @('-batch', '-bail', '-safe', $path, 'PRAGMA user_version=0;')
    Write-Output ('Creato: ' + $path)
}
`,
  {
    engine: "sqlite",
    native: true,
    effects: "write-files",
    docs: [docs.sqlite],
    explanation:
      "1. Adatta il percorso. 2. Simula con -WhatIf. 3. Esegui senza -WhatIf per creare esclusivamente un file nuovo. 4. Aprilo in Database Manager. Se il client fallisce dopo la prenotazione, controlla il file prima di riprovare: non viene cancellato automaticamente.",
    prerequisites: [
      nativePrerequisite,
      "sqlite3 CLI installata e cartella destinazione esistente.",
    ],
  },
);
for (const engine of ["sqlite", "postgresql", "mysql", "mariadb"] as const) {
  const label = {
    sqlite: "SQLite",
    postgresql: "PostgreSQL",
    mysql: "MySQL",
    mariadb: "MariaDB",
  }[engine];
  const parameters =
    engine === "sqlite" ? sqliteParams() : serverParams(engine);
  const nativeRun = (value: string, createDatabase = false) => {
    if (engine === "sqlite")
      return `Invoke-NativeClient -Executable $client -Arguments @('-batch', '-bail', '-safe', '-json', $path, ${value})`;
    if (engine === "postgresql")
      return pgRun(value).replace(
        "'--dbname', $database",
        `'--dbname', ${createDatabase ? "'postgres'" : "$database"}`,
      );
    const tls =
      engine === "mysql"
        ? "'--ssl-mode=VERIFY_IDENTITY'"
        : "'--ssl', '--ssl-verify-server-cert'";
    return `Invoke-NativeClient -Executable $client -Arguments @('--no-defaults', '--protocol=TCP', ('--host=' + $host), ('--port=' + $port), ('--user=' + $username), '--password', ${createDatabase ? "" : "('--database=' + $database), "}${tls}, ('--ssl-ca=' + $caPath), '--local-infile=0', '--batch', '--execute', ${value})`;
  };
  const writeOptions = {
    engine,
    native: true,
    effects: "modify-database" as const,
    level: "intermedio" as const,
    docs: [
      engine === "sqlite"
        ? docs.sqlite
        : engine === "postgresql"
          ? docs.pg
          : engine === "mysql"
            ? docs.mysql
            : docs.maria,
    ],
    prerequisites: [
      nativePrerequisite,
      "Database di sviluppo, backup verificato e account con permessi di creazione/modifica. TLS verificabile e CA per i server; password chiesta dal client.",
    ],
  };
  if (engine !== "sqlite") {
    const quote = engine === "postgresql" ? '"' : "`";
    const quotePs = powerShellLiteral(quote);
    add(
      `${engine}.create-db`,
      `${label}: creare un nuovo database`,
      "database",
      parameters,
      `$quotedDatabase = ${quotePs} + $database.Replace(${quotePs}, ${powerShellLiteral(quote + quote)}) + ${quotePs}\n$sql = 'CREATE DATABASE ' + $quotedDatabase + ';'\nif ($PSCmdlet.ShouldProcess($database, 'Crea un database nuovo')) {\n${nativeRun("$sql", true)}\n}`,
      {
        ...writeOptions,
        explanation:
          "1. Scegli un nome nuovo e un account autorizzato. 2. Prova -WhatIf. 3. Esegui esplicitamente. 4. Aggiungi la connessione in Database Manager. CREATE DATABASE fallisce se il nome esiste; non sovrascrive un database. PostgreSQL si collega inizialmente al database postgres.",
      },
    );
  }
  const sql =
    (engine === "sqlite" || engine === "postgresql" ? "BEGIN; " : "") +
    demoSql(engine) +
    (engine === "sqlite" || engine === "postgresql" ? " COMMIT;" : "");
  add(
    `${engine}.crud-lab`,
    `${label}: percorso guidato CREATE, INSERT, SELECT, UPDATE, DELETE`,
    "database",
    parameters,
    `# La tabella dbm_demo_people deve essere assente: una tabella esistente non viene riutilizzata.\nif ($PSCmdlet.ShouldProcess(${engine === "sqlite" ? "$path" : "$database"}, 'Crea e modifica solo la tabella sintetica dbm_demo_people')) {\n${nativeRun(powerShellLiteral(sql))}\n}`,
    {
      ...writeOptions,
      explanation:
        "1. Seleziona un database di sviluppo. 2. Leggi CREATE e i due INSERT sintetici. 3. Osserva SELECT prima e dopo UPDATE. 4. DELETE riguarda solo il record sintetico 2. 5. La tabella rimane per le prove di struttura successive. Se esiste già, CREATE fallisce e il client si ferma. MySQL/MariaDB possono confermare DDL implicitamente.",
    },
  );
  add(
    `${engine}.schema-lab`,
    `${label}: aggiungere una colonna e un indice al laboratorio`,
    "database",
    parameters,
    `if ($PSCmdlet.ShouldProcess(${engine === "sqlite" ? "$path" : "$database"}, 'Aggiungi email e indice a dbm_demo_people')) {\n${nativeRun(powerShellLiteral("ALTER TABLE dbm_demo_people ADD COLUMN email VARCHAR(255); CREATE INDEX dbm_demo_email ON dbm_demo_people(email); SELECT * FROM dbm_demo_people;"))}\n}`,
    {
      ...writeOptions,
      explanation:
        "1. Esegui prima il percorso CRUD sintetico. 2. ALTER TABLE aggiunge email senza rimuovere righe. 3. CREATE INDEX prepara le ricerche per email. 4. Rileggi lo schema nell’app. Questo passo si applica una sola volta: la colonna o l’indice già esistenti producono un errore esplicito.",
    },
  );
}
for (const [suffix, title, js] of [
  [
    "create-lab",
    "creare una collezione di laboratorio",
    "target.createCollection('dbm_demo_people'); printjson(target.getCollectionNames());",
  ],
  [
    "crud-lab",
    "INSERT, lettura, modifica e cancellazione guidati",
    "const c=target.getCollection('dbm_demo_people'); if (!target.getCollectionNames().includes('dbm_demo_people') || c.countDocuments({})!==0) throw new Error('Creare prima una collezione laboratorio vuota'); c.insertMany([{_id:1,name:'Ada'},{_id:2,name:'Grace'}]); printjson(c.find({}).toArray()); c.updateOne({_id:1},{$set:{name:'Ada Lovelace'}}); c.deleteOne({_id:2}); printjson(c.find({}).toArray());",
  ],
  [
    "index-lab",
    "creare un indice nel laboratorio",
    "if (!target.getCollectionNames().includes('dbm_demo_people')) throw new Error('Collezione laboratorio assente'); printjson(target.getCollection('dbm_demo_people').createIndex({name:1},{name:'dbm_demo_name'}));",
  ],
] as const)
  add(
    `mongodb.${suffix}`,
    `MongoDB: ${title}`,
    "database",
    serverParams("mongodb"),
    `$js = 'const target = db.getSiblingDB(' + (ConvertTo-Json -InputObject $database -Compress) + '); ' + ${powerShellLiteral(js)}\nif ($PSCmdlet.ShouldProcess($database, ${powerShellLiteral(title)})) {\n${mongoRun("$js")}\n}`,
    {
      engine: "mongodb",
      native: true,
      effects: "modify-database",
      level: "intermedio",
      docs: [docs.mongo],
      prerequisites: [
        nativePrerequisite,
        "MongoDB di sviluppo con TLS/CA validi e account autorizzato nel database. Password chiesta da mongosh.",
      ],
      explanation:
        "Percorso in tre passi: crea la collezione dedicata dbm_demo_people, prova CRUD su due documenti sintetici e aggiungi l’indice. Leggi tutto prima, simula con -WhatIf ed esegui solo nel laboratorio. Le operazioni MongoDB di questo esempio non promettono una transazione globale.",
    },
  );

const summaries: Record<string, string> = {
  "files.list":
    "Nomi, dimensioni e date, senza ricorsione nelle sottocartelle.",
  "files.find-sources":
    "Individua file SQL e sorgenti usando soltanto le estensioni.",
  "files.metadata":
    "Dimensione, attributi e date UTC di un file, senza leggerne il contenuto.",
  "files.preview-utf8":
    "Anteprima limitata delle prime righe di testo noto come UTF-8.",
  "files.sha256": "Impronta crittografica dei byte per confrontare due copie.",
  "files.sqlite-header":
    "Riconoscimento del formato SQLite leggendo soltanto 16 byte.",
  "files.copy-new":
    "Copia un file esistente con CreateNew e simulazione WhatIf.",
  "files.create-sql":
    "Crea un esempio SELECT sintetico senza sovrascrivere altri file.",
  "files.create-folder":
    "Crea una cartella scelta esplicitamente, con modalità WhatIf.",
  "diagnostics.version":
    "Informazioni sul terminale e sulla versione Windows visibile a .NET.",
  "diagnostics.clients":
    "Cerca i client nel PATH senza installarli o avviare server.",
  "diagnostics.port": "Legge stato TCP e PID proprietario su una porta locale.",
  "diagnostics.tcp":
    "Prova soltanto la raggiungibilità TCP, senza autenticazione database.",
  "diagnostics.disks":
    "Byte liberi e occupati sui dischi visibili alla sessione.",
  "diagnostics.process": "PID, memoria e CPU di processi con un nome scelto.",
  "sqlite.tables":
    "Catalogo delle tabelle e viste di un file aperto in sola lettura.",
  "sqlite.preview":
    "SELECT limitato con nome della tabella quotato correttamente.",
  "sqlite.quick-check":
    "Controllo strutturale del database, senza interventi di riparazione.",
  "sqlite.bind-id": "Esempio concreto di binding CLI tramite @lookup_id.",
  "postgresql.ping":
    "Controlla database, utente e versione tramite connessione TLS verificata.",
  "postgresql.tables":
    "Elenca le tabelle accessibili, mantenendo distinto lo schema.",
  "postgresql.preview": "Legge schema e tabella scelti con un limite validato.",
  "mysql.tables":
    "SHOW FULL TABLES con autenticazione interattiva e verifica TLS.",
  "mysql.preview": "SELECT limitato con backtick correttamente raddoppiati.",
  "mariadb.tables":
    "Mostra tabelle e viste con le opzioni TLS proprie di MariaDB.",
  "mariadb.preview":
    "Lettura limitata usando il client MariaDB già installato.",
  "mongodb.ping":
    "Verifica il server MongoDB senza caricare script mongosh personali.",
  "mongodb.collections": "Legge i nomi delle collezioni del database scelto.",
  "mongodb.preview":
    "Visualizza documenti senza perdere la rappresentazione BSON della shell.",
  "docker.contexts":
    "Elenca i contesti senza cambiare la configurazione globale.",
  "docker.containers":
    "Container attivi e fermi del contesto scelto, con relative porte.",
  "docker.logs": "Ultime righe dei log di un solo container, senza follow.",
  "docker.inspect":
    "Stato operativo di un solo container, senza variabili d’ambiente.",
  "docker.compose-services":
    "Valida il file Compose ed elenca i servizi senza avviarli.",
  "ollama.version":
    "GET locale della versione; nessun prompt o modello da scaricare.",
  "ollama.models": "Metadati dei modelli già presenti sul server locale.",
  "ollama.running":
    "Stato dei modelli caricati in memoria, senza avviare inferenze.",
};
for (const entry of definitions) {
  entry.description = summaries[entry.id] || entry.description;
  if (entry.explanation.startsWith("Esempio deterministico")) {
    entry.explanation = `${entry.description} Lo script non crea oggetti né modifica dati; il risultato dipende dai permessi e dalle risorse già disponibili.`;
  }
}

export const powerShellCatalog: PowerShellEntry[] = definitions.map(
  ({ body: _body, native: _native, ...entry }) => entry,
);

function validate(
  entry: PowerShellEntry,
  values: PowerShellValues,
): PowerShellValues {
  for (const name of Object.keys(values))
    if (!entry.parameters.some((p) => p.name === name))
      throw new Error(`Parametro non previsto: ${name}`);
  const normalized: PowerShellValues = {};
  for (const p of entry.parameters) {
    const value = values[p.name] ?? p.defaultValue;
    if (p.type === "integer") {
      const parsed =
        typeof value === "number"
          ? value
          : typeof value === "string" && /^-?\d+$/.test(value)
            ? Number(value)
            : NaN;
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < (p.min ?? Number.MIN_SAFE_INTEGER) ||
        parsed > (p.max ?? Number.MAX_SAFE_INTEGER)
      )
        throw new Error(
          `${p.label}: inserire un intero fra ${p.min} e ${p.max}.`,
        );
      normalized[p.name] = parsed;
    } else if (p.type === "boolean") {
      if (typeof value !== "boolean")
        throw new Error(`${p.label}: scegliere vero o falso.`);
      normalized[p.name] = value;
    } else {
      if (
        typeof value !== "string" ||
        (p.required && !value.trim()) ||
        /[\0\r\n]/.test(value)
      )
        throw new Error(
          `${p.label}: inserire un testo valido su una sola riga.`,
        );
      if (p.type === "choice" && !p.choices?.some((c) => c.value === value))
        throw new Error(`${p.label}: scegliere una delle opzioni previste.`);
      normalized[p.name] = value;
    }
  }
  return normalized;
}

export function buildPowerShellScript(
  entryId: string,
  values: PowerShellValues = {},
): PowerShellScript {
  const entry = definitions.find((e) => e.id === entryId);
  if (!entry) throw new Error("Esempio PowerShell non trovato.");
  const normalized = validate(entry, values);
  const writing = entry.effects !== "read";
  const assignments = entry.parameters.map((p) => {
    const value = normalized[p.name];
    return `$${p.name === "host" ? "serverHost" : p.name} = ${typeof value === "string" ? powerShellLiteral(value) : typeof value === "boolean" ? (value ? "$true" : "$false") : value}`;
  });
  // $Host is a read-only automatic variable in every PowerShell session.
  const body = entry.body.replace(/\$host\b/gi, "$serverHost");
  const guards: string[] = [];
  if (entry.engine === "sqlite" && entry.id !== "sqlite.create-new")
    guards.push(
      "if (-not [System.IO.File]::Exists($path)) { throw 'File SQLite non trovato: non viene creato.' }",
      "$path = (Get-Item -LiteralPath $path -Force).FullName",
      `$path = ([System.Uri]$path).AbsoluteUri + '?mode=${entry.effects === "read" ? "ro" : "rw"}'`,
    );
  if (entry.parameters.some((p) => p.name === "caPath"))
    guards.push(
      "if (-not [System.IO.File]::Exists($caPath)) { throw 'Certificato CA non trovato.' }",
      "$caPath = (Get-Item -LiteralPath $caPath -Force).FullName",
    );
  const content = [
    "#requires -Version 5.1",
    "# Salvare il file .ps1 come UTF-8 con BOM per Windows PowerShell 5.1.",
    `# ${entry.title}`,
    "# Esempio offline dimostrativo: adattare i parametri. Nessuna esecuzione automatica nell’app.",
    ...(writing
      ? [
          "[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]",
          "param()",
        ]
      : []),
    "$ErrorActionPreference = 'Stop'",
    "",
    ...assignments,
    "",
    ...guards,
    ...(entry.native ? [nativeHelper] : []),
    body.trim(),
    "",
  ].join("\n");
  const warnings = [
    "Leggere lo script prima di copiarlo nel terminale. I valori iniziali sono esempi sintetici.",
    "Compatibilità prevista: Windows PowerShell 5.1 e PowerShell 7 su Windows; non implica disponibilità dei client o del server.",
    ...(writing
      ? [
          entry.effects === "write-files"
            ? "Scrive file o cartelle soltanto quando eseguito esplicitamente; usare -WhatIf per simulare. Non sovrascrive file esistenti."
            : "Modifica struttura o dati soltanto quando eseguito esplicitamente. Simula con -WhatIf e usa un database di sviluppo con backup verificato.",
        ]
      : []),
    ...(entry.engine && entry.engine !== "sqlite"
      ? [
          "La password viene chiesta dal client nativo: non inserirla nello script. TLS verificato, senza fallback non cifrato.",
        ]
      : []),
    ...(entry.native
      ? [
          "Le CLI possono gestire propri log, cache o file di configurazione locali; queste letture non modificano i dati del database.",
        ]
      : []),
  ];
  return {
    name: `${entry.id.replaceAll(".", "-")}.ps1`,
    content,
    warnings,
    prerequisites: [...entry.prerequisites],
  };
}
