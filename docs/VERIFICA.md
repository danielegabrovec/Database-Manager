# Verifiche della versione 0.1.0

Questo documento distingue ciò che è stato provato da ciò che richiede ulteriori ambienti di collaudo. I rapporti JSON locali sono in `artifacts/` e `tests/codegen/generated/`, esclusi dal controllo versione perché includono runtime e file generati voluminosi.

## Interfaccia

Build TypeScript/Vite verificata. Suite Vitest: **13 test** su valori tipizzati, generatore visuale, JOIN/GROUP/ORDER, DDL SQLite realmente eseguito, stato del laboratorio e definizioni degli oggetti. Audit npm: zero vulnerabilità alla verifica effettuata durante lo sviluppo.

Nel browser interno sono stati provati un laboratorio SQLite reale, una JOIN con cinque risultati, il confronto positivo dell'esercizio e la riapertura di un laboratorio salvato. Screenshot locale: `artifacts/ui-query.png`.

## Nucleo e server

La suite Rust finale ha **55 test passati e 3 test server ignorati per impostazione predefinita**. Altri 6 test di integrazione SQLite sono passati, incluse cancellazione reale e verifica su un milione di righe.

La suite Rust copre script con stringhe/commenti, parametri mancanti, nomi duplicati delle colonne, precisione dei valori, conflitti, protezioni del laboratorio, seed, persistenza, backup WAL, contesto AI e generazione del catalogo.

Il test con un milione di righe verifica il limite di memoria del risultato interattivo attraverso il numero massimo di righe conservate. Non costituisce un benchmark generale di ogni server o scheda grafica.

Sono state create istanze native app-owned di PostgreSQL, MySQL, MariaDB e MongoDB. Il collaudo ha verificato autenticazione, CRUD, stop/start e teardown. Rapporti e archivi verificati: `src-tauri/src/NATIVE-CATALOG.md` e `artifacts/qa-native/`.

Il test `live_contract` usa esclusivamente il manifest dei server QA e le credenziali nel portachiavi; prova int64 oltre la precisione JavaScript, decimali esatti, valori binari, metadati, aggiornamento e conflitti. Il test `native_tools` ha recuperato un record dopo backup, cancellazione e ripristino su tutti e quattro i motori. Rapporto: `artifacts/qa-native-tools-results.json`.

## Generatori

Il catalogo genera **60 progetti CLI e 20 REST**, tutti eseguiti con CRUD reale sulla fixture: **80/80 riusciti**. Il rapporto definitivo è `docs/CODEGEN-VERIFICA.md` e `artifacts/qa-codegen-final.json`. I test effettivi delle toolchain sono registrati separatamente, con stato e risultato per combinazione. La generazione riuscita di un progetto non viene usata come prova della sua compilazione o esecuzione.

Il riepilogo finale riproducibile è prodotto dai test in `tests/codegen/`; i rapporti comprendono `sqlite-cli-results.json`, `qa-results.json`, `rest-qa-results.json` e i risultati di compilazione per runtime.

## Ripetere i test con server reali

I seguenti test avviano o usano soltanto server creati per il collaudo:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features native_environments_verified_archives_smoke -- --ignored --nocapture --test-threads=1
```

Per mantenere quattro server disponibili durante i test dei generatori:

```powershell
$env:DBM_QA_HOLD = '1'
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features native_qa_supervisor -- --ignored --nocapture --test-threads=1
```

Il supervisore scrive `artifacts/qa-active.json` senza password. Il file `artifacts/qa-stop.flag` richiede l'arresto; esiste anche un limite temporale. Mentre è attivo:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --test live_contract -- --ignored --nocapture
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --test native_tools -- --ignored --nocapture
```

Non eseguire ripristini contemporaneamente ai test dei generatori. Su Windows il binario del supervisore in esecuzione può impedire il rilink dei test lib; usare i target di integrazione o terminare prima il supervisore.

## Verifiche ancora distinte

- Installer in VM Windows pulite, firma del codice e comportamento su hardware differente.
- Docker: **4/4 motori verificati**, con digest fissato, CRUD, arresto/riavvio e persistenza; ricevuta `artifacts/qa-docker-results.json`. Docker Desktop è stato avviato per il collaudo e resta aperto perché ha riattivato automaticamente container preesistenti. Le risorse QA sono state rimosse; ricevuta `artifacts/qa-teardown.json`.
- TLS/CA e tunnel SSH: percorsi implementati, da certificare contro server e chiavi esterni dedicati.
- Servizi Windows/helper UAC: **12 test del sottosistema passati**, nessuna installazione SCM reale/elevazione effettuata. Fonti e limiti in `src-tauri/src/windows_service/README.md`.
- MongoDB: cancellazione propria confermata sul server; due test della Session applicativa passati su cancellazione, rollback batch, Int32 e distinzione NULL/campo assente. Il percorso mongos richiede privilegi che l’app non amplia.
- Prestazioni di esportazione e introspezione su schemi di produzione molto grandi.

## Assistente locale e pacchetto

Ollama locale ha risposto con il modello `qwen2.5-coder:1.5b-base` a una richiesta sintetica in 3.474 ms. I modelli con metadata di inoltro remoto vengono esclusi dalla modalità locale, compresi gli alias senza suffisso cloud. Due test di integrazione verificano questo confine e la richiesta locale; ricevuta `artifacts/qa-ollama.json`.

Il pacchetto comprende un eseguibile Windows e installer NSIS. La firma digitale e il collaudo dell’installer in VM pulita restano da effettuare.

## Trasferimento SQL

Export di tabella e intero database e successiva importazione SQL sono stati verificati con PostgreSQL, MySQL e MariaDB usando i client nativi: **3/3 riusciti**, con testo Unicode e conferma obbligatoria. Ricevuta `artifacts/qa-sql-transfer.json`. SQLite ha una prova completa aggiuntiva su schema, dati, indici, vista, chiavi, BLOB, interi grandi, colonne generate e stato AUTOINCREMENT. Il formato SQL produce uno script reale; CSV/JSON rispettano il limite di record selezionato.

## Eseguibile desktop finale

L’eseguibile in `releases/Database Manager.exe` è stato avviato e verificato nella finestra Windows reale, usando gli asset incorporati. Il laboratorio SQLite è stato creato, un esercizio aperto nell’editor e la query eseguita tramite IPC e Channels Tauri: cinque righe ricevute con Unicode e NULL corretti. Screenshot `releases/anteprima.png`, ricevuta `artifacts/qa-desktop.json` con hash dell’eseguibile.

La finestra di collaudo è stata lasciata aperta dopo rilevamento di interazione dell’utente. Usa il workspace separato `artifacts/native-ui-workspace`; l’avvio ordinario dell’eseguibile/installer utilizza `%LOCALAPPDATA%\DatabaseManager`. Chiudere la finestra di prova prima di avviare il workspace ordinario. Le connessioni eventualmente salvate nella finestra di prova rimangono nel suo file `workspace.sqlite`.
