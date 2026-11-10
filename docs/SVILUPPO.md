# Sviluppo e build Windows — revisione 0.5.0

Progetto di **Daniele Gabrovec**. Le procedure tecniche non sostituiscono [LICENSE](../LICENSE) e [LEGAL.md](../LEGAL.md).

La piattaforma di distribuzione è **Windows x64**. Non viene dichiarato un pacchetto macOS, Linux o ARM.

## Ambiente utilizzato

| Componente           | Ambiente di sviluppo/collaudo                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------- |
| Node.js              | 24.15.0                                                                                       |
| npm                  | 11.12.1                                                                                       |
| Rust                 | 1.99.0, target `x86_64-pc-windows-msvc`                                                       |
| Frontend             | React 19, TypeScript 5.9, Vite 7, Monaco 0.57; risoluzione in `package-lock.json`.            |
| Desktop              | Tauri 2; risoluzione in `src-tauri/Cargo.lock`.                                               |
| Compilazione Windows | Microsoft C++ Build Tools/Visual Studio con MSVC e Windows SDK; in collaudo MSVC 19.51.36260. |
| Webview              | Microsoft Edge WebView2.                                                                      |

SQLite è incorporato tramite rusqlite. Docker, server SQL/MongoDB, client di backup, VS Code e runtime AI servono solo ai rispettivi flussi. Le toolchain dei programmi esportati sono distinte: non occorrono tutti i dodici ambienti per compilare l'app.

## Ottenere il progetto

```powershell
git clone https://github.com/danielegabrovec/Database-Manager.git
cd Database-Manager
npm ci
rustup target add x86_64-pc-windows-msvc
```

Per ripetere la baseline con la toolchain registrata:

```powershell
rustup toolchain install 1.99.0-x86_64-pc-windows-msvc --profile minimal
rustup override set 1.99.0-x86_64-pc-windows-msvc
```

Installa prima il workload C++ e il Windows SDK delle Build Tools/Visual Studio. Conserva i lockfile: `npm ci` e Cargo con `--locked` evitano aggiornamenti impliciti delle dipendenze risolte.

## Avvio desktop in sviluppo

Chiudi copie già aperte: il plugin di istanza singola può riportare in primo piano un processo esistente.

Per separare i dati di sviluppo:

```powershell
$env:DBM_DATA_DIR = Join-Path (Get-Location) '.dbmanager\desktop-dev'
npm run tauri -- dev
```

`.dbmanager/` è esclusa dal versionamento. `DBM_DATA_DIR` sceglie il workspace, non disabilita l'istanza singola. Tauri avvia Vite sulla porta 1420 e comunica con Rust tramite IPC e Channels. L'app distribuita usa asset incorporati e non richiede un server HTTP.

## Anteprima browser

Da un terminale nella radice:

```powershell
$env:DBM_DATA_DIR = Join-Path (Get-Location) '.dbmanager\browser-dev'
cargo run --manifest-path src-tauri/Cargo.toml --locked --no-default-features --bin dbmanager-bridge
```

In un secondo terminale, sempre nella radice:

```powershell
npm run dev
```

Apri `http://127.0.0.1:1420`. Il bridge ascolta su `127.0.0.1:8787` e Vite vi inoltra `/api`. Porte e origini ammesse sono configurate nel progetto: l'anteprima è un servizio locale da non esporre in rete.

Dopo una modifica ai provider Monaco registrati al montaggio, ricarica la pagina prima del collaudo: il solo hot reload può conservare provider precedenti.

## Test ordinari

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Solo strumenti query:

```powershell
npm exec -- vitest run src/editor/sqlLanguage.test.ts src/editor/queryCatalog.test.ts
npm exec -- vitest run src/views/OpenFilesView.test.ts src/files/queryExtraction.test.ts src/files/queryDocuments.test.ts src/files/sqlScriptAnalysis.test.ts
npm exec -- vitest run src/navigation.test.tsx src/views/QueryLibraryView.test.tsx src/powershell/catalog.test.ts
```

Verifica corrente 0.5: **306 test frontend riusciti**. La suite Rust completa e le prove aggiuntive sui quattro server reali sono registrate in [REPORT-0.5.0-20261110.md](REPORT-0.5.0-20261110.md).

`src/powershell/catalog.test.ts` controlla **52 modelli** e usa i parser Windows PowerShell 5.1 e PowerShell 7: **57 casi per interprete**, 114 analisi sintattiche. `node scripts/verify-powershell-sqlite.mjs` verifica inoltre creazione reale, -WhatIf senza scritture, CRUD, ALTER e indice con entrambi gli interpreti su SQLite QA; richiede sqlite3.exe. `python scripts/verify-schema-functions.py` compila/esegue i dodici nuovi moduli schema usando toolchain già installate e cache. Non installa toolchain automaticamente.

I test del catalogo eseguono SQL SQLite con il seed effettivo. I nuovi test di file, codifica e salvataggio usano fixture temporanee e verificano apertura senza creazione implicita, fingerprint, conflitti e scritture testuali. Le integrazioni AI/server richiedono il contesto dedicato indicato nei rispettivi test.

I test server ignorati richiedono attivazione esplicita e risorse dedicate. Non usare profili personali o di produzione per il collaudo. La procedura server e i limiti storici sono in [VERIFICA.md](VERIFICA.md).

Gli harness estesi possono produrre `artifacts/`, `test-results/`, `tests/codegen/generated/`, `tests/codegen/toolchains/` e cache. Queste directory locali sono escluse dal repository; alcuni collaudi richiedono preparazione ulteriore rispetto al normale clone. La generazione di un file non ne dimostra la compilazione o l'esecuzione.

## Eseguibile e installer

```powershell
npm ci
npm run tauri -- build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

Il comando esegue il build frontend configurato. I risultati sono sotto `src-tauri/target/`; specificando il target, il percorso include `x86_64-pc-windows-msvc`. L'installer è nella sottocartella `release/bundle/nsis/` di quel target.

Senza `--target`, da una toolchain Windows x64 il percorso abituale è `src-tauri/target/release/bundle/nsis/`. Una cartella `releases/` presente nel workspace è un risultato di packaging locale, non un prerequisito del clone pubblico.

Per preparare il pacchetto pubblico completo usare `./scripts/Build-Release.ps1`: compila in `artifacts/public-release-target`, rimappa i percorsi privati di compilazione, esegue la scansione degli asset e prepara installer, ZIP portabile con tutti i testi legali e checksum. `-PackageOnly` usa esclusivamente una build già verificata. Prima della build generare/verificare l’inventario con `python scripts/generate-third-party-notices.py --mpl-source-output artifacts/release-v050`. Lo script non pubblica su GitHub.

I lockfile e la toolchain rendono ripetibile la procedura, senza una promessa di identità byte per byte fra installer compilati su macchine diverse. La firma digitale è separata; il pacchetto corrente è dichiarato non firmato.

## Organizzazione

| Percorso                                                      | Responsabilità                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/App.tsx`                                                 | Integrazione e stato dell'interfaccia.                                        |
| `src/navigation.ts`, `src/components/WorkspaceNavigation.tsx` | Destinazioni, gruppi, accordion e navigazione accessibile.                    |
| `src/components/CatalogShell.tsx`, `src/catalog-layout.css`   | Layout condiviso dei cataloghi.                                               |
| `src/powershell/`, `src/views/PowerShellCatalogView.tsx`      | Modelli deterministici, parametri e anteprima PowerShell.                     |
| `src/components/`, `src/views/`                               | Griglia, dialoghi e viste.                                                    |
| `src/editor/`                                                 | Monaco, catalogo e spiegazioni locali.                                        |
| `src/files/`, `src/views/OpenFilesView.tsx`                   | Documenti query, estrazione statica, analisi direttive e centro file.         |
| `src/designer/`                                               | Schema del progetto, piano di creazione, letture.                             |
| `src-tauri/src/database.rs`, `remote.rs`, `sqlite.rs`         | Sessioni e motori.                                                            |
| `src-tauri/src/codegen.rs`, `codegen_workbench.rs`            | Template e generazione.                                                       |
| `src-tauri/src/environment/`, `windows_service/`              | Ambienti gestiti e servizi Windows.                                           |
| `src-tauri/src/store.rs`                                      | Persistenza del workspace.                                                    |
| `src-tauri/src/workspace_files.rs`                            | Lettura/scrittura testuale, firme SQLite, codifiche, fingerprint e directory. |

Approfondimenti: [ARCHITETTURA.md](ARCHITETTURA.md) e [QUERY-IDE.md](QUERY-IDE.md).

## Prima di distribuire modifiche

- Mantieni coerenti versione npm, Cargo, configurazione Tauri e informazioni dell'app.
- Esegui i controlli appropriati e registra motore, toolchain e fixture delle prove reali.
- Prova nell'interfaccia schema, completamento, query e staging/Applica quando cambi quei flussi.
- Escludi workspace, credenziali, `.env`, database personali, runtime temporanei e risultati QA da commit e asset pubblici.
- Distingui build riuscita, avvio del processo, walkthrough nativo e prova dell'installer su Windows pulito.

Il report corrente della 0.5, incluso il collaudo dell’eseguibile incorporato e il packaging, è [REPORT-0.5.0-20261110.md](REPORT-0.5.0-20261110.md). Le verifiche native delle versioni precedenti restano nei documenti storici.

I collaudi della 0.3 restano storici in [VERSIONE-0.3.md](VERSIONE-0.3.md): browser locale con backend Rust per SQLite/file/salvataggi/importazione, reale apertura di Esplora file e avvio/inoltro dei percorsi alla singola istanza nativa. Non vengono trasformati automaticamente in un walkthrough completo della 0.4. Il selettore Tauri di cartella e la scrittura GUI nelle codifiche alternative restano non provati graficamente. L'installer in VM pulita, TLS/SSH esterni, servizi SCM reali e schemi di produzione molto grandi hanno un ambito distinto.

## Contratti della navigazione e dei cataloghi

- `NAV_FLAT` include le destinazioni per breadcrumb e ricerca; `NAV_GROUPS` separa Database, Catalogo e Strumenti. Apri file, Editor e Laboratorio restano autonomi; Impostazioni rimane nell'area inferiore.
- L'accordion ha un solo gruppo aperto. Dalle viste autonome parte chiuso; una vista interna ripristinata apre il proprio gruppo. Pulsanti nativi, `aria-expanded`/`aria-controls`, pagina corrente e frecce/Home/End restano verificabili senza ricorrere a ruoli menu impropri.
- La cronologia delle viste alimenta Indietro e `Alt+Freccia sinistra`; `lastView` persiste soltanto identificatori conosciuti. I due cataloghi rimangono montati dopo il primo accesso: lo stato locale si conserva durante la sessione, senza prometterne la persistenza completa fra avvii.
- Il catalogo PowerShell genera solo testo. Anteprima ed esportazione lo trasferiscono al centro file come bozza `.ps1`, senza percorso originale da sovrascrivere e con codifica `utf-8-bom`. Il catalogo non compila né invoca i comandi generati.
- I parametri degli script non includono password; i prerequisiti del client/server sono dichiarati per voce. I test di escaping e parsing non sostituiscono un collaudo runtime delle CLI native.

## Contratti e limiti del centro file

- `DBM_DATA_DIR` separa il workspace dell'app, senza aggirare l'istanza singola.
- L'apertura SQLite predefinita non crea file. La creazione di un percorso mancante richiede `createIfMissing` esplicito; dopo l'apertura il profilo non conserva un'autorizzazione permanente a ricrearlo.
- Uno script nativo aperto nell'editor trasferisce testo, contenuto originale, codifica e fingerprint. Una query estratta trasferisce provenienza e `sourceOnly`, senza un binding di salvataggio al programma.
- `save_workspace_text` controlla la versione letta per un file esistente; senza fingerprint permette soltanto la creazione esclusiva di un file nuovo. Una sostituzione esplicita legge prima la destinazione e usa la sua fingerprint.
- **Salva come** nel centro file crea solo un file nuovo. Nell'editor query la sostituzione di un testo esistente richiede consenso esplicito e controllo della fingerprint della destinazione appena letta.
- La notifica `dbm:workspace-file-saved` aggiorna le viste non modificate; una bozza locale resta conservata e segnalata.
- `Ctrl+Maiusc+O` e **Scegli cartella…** richiedono il selettore nativo Tauri; nel browser questa funzione è dichiarata non disponibile. Le RPC `open_workspace_directory` e `reveal_workspace_file` ricevono solo percorsi esistenti verificati per aprire Esplora file, senza costruire comandi shell dal testo dell'utente.
- Limiti: 8 MiB di testo grezzo, 200 voci per pagina di directory, 24 documenti query e un limite complessivo di 8.388.608 unità di stringa JS. Il centro file limita l'estrazione a 1.000.000 di caratteri e 200 operazioni.
- L'esecuzione interattiva analizza la porzione scelta prima di inviarla: direttive client e testi oltre 512 KiB richiedono il flusso di importazione/revisione, senza inviare automaticamente un prefisso del dump.

Dettagli e criteri di accettazione sono in [PIANO-0.3-APERTURA-FILE.md](PIANO-0.3-APERTURA-FILE.md). Gli esiti osservati di UI e l'ambito del packaging sono distinti in [VERSIONE-0.3.md](VERSIONE-0.3.md).
