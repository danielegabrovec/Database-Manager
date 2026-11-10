# Report di completamento — Database Manager 0.5.0

**Aggiornamento successivo:** il controllo Windows, inizialmente sospeso, è stato completato con il consenso dell’utente e ha portato alla correzione 0.5.1. Consulta il [report finale 0.5.1](REPORT-0.5.1-20261110.md) per gli esiti nativi e la distribuzione corrente. Questa pagina conserva la cronologia della 0.5.0.

Data: **10 novembre 2026**. Autore del software: **Daniele Gabrovec**.

## Stato recuperato

Il repository era fermo al commit pubblico `2ceb58e` della 0.2.1. Nella cartella erano presenti modifiche locali 0.3/0.4 non ancora committate: apertura e salvataggio file, schede query, estrazione statica, navigazione e cataloghi. Sono state conservate e verificate prima dell’espansione, senza cancellare o sostituire database personali. Tutte le prove con scritture hanno utilizzato fixture e ambienti app-owned di collaudo.

## Milestone e correzioni

| Milestone | Risultato | Verifica |
|---|---|---|
| Ripresa e baseline | Inventario del lavoro interrotto; 290 test frontend iniziali riusciti. | Suite Rust ripetuta fuori dalla sandbox: gli errori iniziali di HTTP loopback, hard link e sostituzione atomica dipendevano dalle restrizioni dell’ambiente. |
| Recupero bozze | Centro file recuperabile; baseline, codifica e fingerprint mantenute. Scritture ordinate e copia backend anche durante digitazione continua. Errori di autosalvataggio visibili. | Test di recupero, ordinamento/fallimento delle scritture e riapertura del workspace; recupero del testo osservato in una nuova sessione UI. |
| Dialoghi e interfaccia | Conferme interne, gestione del focus e dei dialoghi sovrapposti; menu scorrevole, area connessioni visibile, leggibilità dei file e diagramma espandibile. | Prove UI di conferma, navigazione, diagramma e guida. |
| Modifiche strutturali | Adozione di tabelle esistenti, piano di migrazione, controllo di schema obsoleto, conferme e rilettura dello stato reale. | SQLite reale, rollback, FK, AUTOINCREMENT, vincoli UNIQUE composti; quattro server reali. Rilevato e corretto un deadlock della sessione durante il collaudo server. |
| Guida e PowerShell | 50 passi e 77 esempi, presenti nell’app e nel documento esportato. Catalogo da 37 a 52 modelli. | Esempi SQL SQLite eseguiti; parser PowerShell 5.1/7; nuovi script SQLite eseguiti realmente con entrambi gli interpreti. |
| Codice applicativo | Funzioni CRUD accessibili nel generatore; nuove funzioni schema nei 12 linguaggi per quattro motori SQL. | 48 combinazioni generate; compilazione/esecuzione SQLite dei 12 moduli senza modificarli. Corretto il riferimento Rust richiesto da sqlx 0.9. |

Durante le prove PowerShell è emersa una differenza reale di codepage del client SQLite esterno: un percorso accentato poteva diventare un altro nome di file. Il catalogo passa ora il percorso come URI codificata, con modalità di apertura esplicita. Il collaudo usa spazi, apostrofi e Unicode e verifica il file effettivo. La creazione esplicita usa una prenotazione esclusiva per impedire la sovrascrittura.

## Test automatici correnti

| Controllo | Esito osservato |
|---|---|
| Frontend Vitest | **306 passati**, 32 file, nessun fallimento. |
| Rust completo, senza feature desktop | **98 passati, 0 falliti, 11 ignorati**: 78 unitari e 20 integrazioni. Gli ignorati richiedono ambienti espliciti e non sono conteggiati come riusciti. |
| Migrazioni live, attivate esplicitamente | **4/4 motori**: PostgreSQL, MySQL, MariaDB e MongoDB; un test di integrazione percorre tutti e quattro. |
| Contratto adattatori live, attivato esplicitamente | **4/4 motori** dopo la correzione del blocco sessione. |
| PowerShell sintassi | **57 casi per interprete**, Windows PowerShell 5.1 e PowerShell 7: **114 analisi**. |
| PowerShell runtime SQLite | **2/2 interpreti**: nuovo database, WhatIf senza scritture, CREATE/INSERT/SELECT/UPDATE/DELETE, ALTER e indice. |
| Funzioni schema | **48 combinazioni generate**: quattro motori SQL × dodici linguaggi. |
| Compilazione e runtime delle funzioni schema SQLite | **12/12**: Rust, Python, JavaScript, TypeScript, PHP, Java, C#, C, C++, Go, Kotlin, Ruby. |
| Esempi del prontuario SQLite | Tutti i 17 esempi eseguiti contro lo schema e i dati documentati, isolando le scritture. |
| Build frontend | TypeScript e Vite riusciti. Monaco produce un bundle principale voluminoso; il warning non è soppresso e non è presentato come un benchmark di avvio. |
| Avvisi dipendenze | **599 componenti**, **897 testi legali** verificati, nessun testo installato mancante. Archivio sorgenti MPL delle cinque crate corrispondenti al lockfile. |

I server nativi QA sono stati arrestati e le risorse gestite dal supervisore sono state rimosse a fine collaudo. Non sono stati usati profili personali, database di lavoro o servizi Windows di produzione.

## Prove visive osservate

Nel browser interno, con backend Rust reale e workspace separato, sono stati verificati:

1. Recupero di una bozza PowerShell modificata con testo Unicode; codifica UTF-8 con BOM mantenuta.
2. Conferma di scarto con focus iniziale su Annulla e conservazione della bozza annullando.
3. Guida offline, cambio sezione e ricerca nel prontuario.
4. Creazione del laboratorio SQLite e caricamento delle sue tabelle nel designer.
5. Aggiunta grafica di una colonna a una tabella esistente, revisione del piano, applicazione e passaggio a zero modifiche residue.
6. Diagramma con relazioni effettive e apertura a schermo esteso.
7. Generazione della funzione Python di creazione schema con file SQL e README.
8. Lettura della nuova colonna nella griglia, modifica di una cella, anteprima prima/dopo e applicazione riuscita.

L’eseguibile Windows 0.5.0 è stato avviato con un workspace QA separato e la sua finestra è stata rilevata. L’accesso alla cattura/automazione della finestra nativa non si è completato perché la richiesta di autorizzazione è scaduta: non viene dichiarato un walkthrough nativo completo. Le prove visive elencate sono quelle osservate nel browser interno con il backend Rust reale. Non vengono equiparate a un collaudo dell’installer in una macchina pulita.

## Limiti espliciti

- Windows x64; installer non firmato. Nessuna nuova certificazione su VM pulita, macOS, Linux o ARM.
- Il piano blocca modifiche che non può rappresentare integralmente. In particolare: PK/identità, alcuni vincoli senza nomi originali, indici parziali/espressioni, FK composte e ricostruzioni SQLite con viste, trigger o vincoli avanzati richiedono migrazioni dedicate. Per MySQL/MariaDB le ridefinizioni di colonne richiedono la definizione completa del server e revisione SQL.
- MySQL/MariaDB e MongoDB non hanno una promessa di rollback globale per i DDL del piano. In caso di errore lo stato viene riletto prima di riprovare.
- Le nuove funzioni schema riguardano i quattro motori SQL; MongoDB conserva schema JSON e i generatori CRUD/lettura/modelli precedenti.
- La prova dei 12 moduli schema è runtime su SQLite. La generazione delle altre 36 combinazioni non è descritta come compilazione/runtime di quei moduli su ogni server.
- I 52 script PowerShell sono tutti analizzati sintatticamente; la prova runtime nuova riguarda i tre percorsi SQLite, non l’esecuzione di tutti i modelli su ogni server. TLS/CA/SSH esterni richiedono il proprio ambiente di verifica.
- Il recupero automatico ha limiti di dimensione e intervalli di salvataggio. Non promette l’ultimo tasto prima di un’interruzione e non recupera modifiche di griglia non applicate.

## Riproducibilità e ricevute

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
node scripts/verify-powershell-sqlite.mjs
python scripts/verify-schema-functions.py
node scripts/export-operational-guide.mjs
python scripts/generate-third-party-notices.py --verify --mpl-source-output artifacts/release-v050
npm run tauri -- build --ci --bundles nsis -- --locked
```

Le prove server richiedono il supervisore QA esplicito descritto in [VERIFICA.md](VERIFICA.md); poi si eseguono i target `schema_changes_live` e `live_contract` con `--ignored --nocapture`. Non usare server o profili personali.

Le ricevute locali sono in `artifacts/qa-schema-live-20261110.json`, `artifacts/qa-schema-functions-runtime-20261110/receipt.json`, `artifacts/qa-powershell-sqlite-20261110/` e `artifacts/release-v050/`. Runtime, database sintetici, cache e credenziali QA non sono inclusi nel repository pubblico.

## Distribuzione

Il pacchetto 0.5.0 è stato pubblicato su GitHub: installer NSIS Windows x64, ZIP portabile con eseguibile e testi legali completi, documentazione, checksum e sorgenti MPL corrispondenti. Commit del codice: `7de59886012221347c9429ff4a18beb91b0fd62a`, tag `v0.5.0`.

La distribuzione di riferimento è [Database Manager v0.5.0](https://github.com/danielegabrovec/Database-Manager/releases/tag/v0.5.0), impostata come ultima release pubblica. I sette asset sono stati riscaricati da GitHub e confrontati byte per byte. L’installer è stato scaricato anche senza autenticazione: HTTP 200, 15.357.890 byte e SHA-256 corrispondente. Lo ZIP portabile supera il controllo CRC, contiene l’eseguibile atteso e tutti gli 897 testi legali verificati per hash.

La distribuzione precedente `v0.2.1` è stata rimossa da GitHub dopo questi controlli e dopo un backup locale in `artifacts/release-v050/previous-distribution-backup/`. Restano conservati cronologia Git e tag sorgente `v0.2.1`. La lista delle release pubbliche contiene la 0.5.0.

| File verificato | Dimensione | SHA-256 |
|---|---:|---|
| Installer Windows x64 | 15.357.890 byte | `5f5b9f65272442e8bbf3f5678fe701eca96f0a3eb634e96790c5ae0ae0a9817b` |
| Eseguibile nel pacchetto portabile | 33.335.296 byte | `c9f7b9c1e5783cebbd45f74087d4abcbd141286d1da5ebd4bfa0821a5e86ce70` |
| ZIP portabile completo | 14.941.078 byte | `867485fdb1803adcb50beada2e69e48278a30944254bd05c46fc1981b23dbb15` |
| Sorgenti MPL | 175.931 byte | `d01e4f510daf2ed43aad44770c86dfec752970f00a940fbf02f08a791f8de635` |

Il controllo finale di sorgenti e asset non ha rilevato pattern di credenziali, percorsi home privati o metadati di compilazione personali nel binario pubblico. Il primo build era stato respinto da questo controllo: è stato sostituito con il build rimappato, escludendo anche la cache di sviluppo dal codice release. La scansione di stringhe non è un audit di sicurezza completo e non ispeziona da sola il payload compresso NSIS. Il portabile contiene i testi legali completi; i database e le toolchain di collaudo non vengono distribuiti.
