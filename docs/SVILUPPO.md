# Sviluppo e build Windows

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
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

Solo strumenti query:

```powershell
npm exec vitest run src/editor/sqlLanguage.test.ts src/editor/queryCatalog.test.ts
```

Baseline funzionale 0.2: **101 test frontend riusciti**; **66 test Rust riusciti, 0 falliti e 3 ignorati**. I test del catalogo eseguono SQL SQLite su database in memoria con il seed effettivo, oltre alle verifiche del testo.

I test server ignorati richiedono attivazione esplicita e risorse dedicate. Non usare profili personali o di produzione per il collaudo. La procedura server e i limiti storici sono in [VERIFICA.md](VERIFICA.md).

Gli harness estesi possono produrre `artifacts/`, `test-results/`, `tests/codegen/generated/`, `tests/codegen/toolchains/` e cache. Queste directory locali sono escluse dal repository; alcuni collaudi richiedono preparazione ulteriore rispetto al normale clone. La generazione di un file non ne dimostra la compilazione o l'esecuzione.

## Eseguibile e installer

```powershell
npm ci
npm run tauri -- build --ci --target x86_64-pc-windows-msvc --bundles nsis -- --locked
```

Il comando esegue il build frontend configurato. I risultati sono sotto `src-tauri/target/`; specificando il target, il percorso include `x86_64-pc-windows-msvc`. L'installer è nella sottocartella `release/bundle/nsis/` di quel target.

Senza `--target`, da una toolchain Windows x64 il percorso abituale è `src-tauri/target/release/bundle/nsis/`. Una cartella `releases/` presente nel workspace è un risultato di packaging locale, non un prerequisito del clone pubblico.

I lockfile e la toolchain rendono ripetibile la procedura, senza una promessa di identità byte per byte fra installer compilati su macchine diverse. La firma digitale è separata; il pacchetto corrente è dichiarato non firmato.

## Organizzazione

| Percorso                                              | Responsabilità                                    |
| ----------------------------------------------------- | ------------------------------------------------- |
| `src/App.tsx`                                         | Integrazione e stato dell'interfaccia.            |
| `src/components/`, `src/views/`                       | Griglia, dialoghi e viste.                        |
| `src/editor/`                                         | Monaco, catalogo e spiegazioni locali.            |
| `src/designer/`                                       | Schema del progetto, piano di creazione, letture. |
| `src-tauri/src/database.rs`, `remote.rs`, `sqlite.rs` | Sessioni e motori.                                |
| `src-tauri/src/codegen.rs`, `codegen_workbench.rs`    | Template e generazione.                           |
| `src-tauri/src/environment/`, `windows_service/`      | Ambienti gestiti e servizi Windows.               |
| `src-tauri/src/store.rs`                              | Persistenza del workspace.                        |

Approfondimenti: [ARCHITETTURA.md](ARCHITETTURA.md) e [QUERY-IDE.md](QUERY-IDE.md).

## Prima di distribuire modifiche

- Mantieni coerenti versione npm, Cargo, configurazione Tauri e informazioni dell'app.
- Esegui i controlli appropriati e registra motore, toolchain e fixture delle prove reali.
- Prova nell'interfaccia schema, completamento, query e staging/Applica quando cambi quei flussi.
- Escludi workspace, credenziali, `.env`, database personali, runtime temporanei e risultati QA da commit e asset pubblici.
- Distingui build riuscita, avvio del processo, walkthrough nativo e prova dell'installer su Windows pulito.

La UI recente è stata provata nel browser locale con backend Rust. La build Windows/NSIS è riuscita, ma il tentativo nativo è stato fermato da una vecchia istanza: non è un collaudo della finestra 0.2.1 o di una VM pulita. TLS/SSH esterni, servizi SCM reali e schemi di produzione molto grandi hanno un ambito di verifica distinto.
