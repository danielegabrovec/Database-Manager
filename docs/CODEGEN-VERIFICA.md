# Verifica dei generatori — 9 novembre 2026

La matrice finale comprende **60 progetti CLI e 20 API REST: 80 prove di esecuzione riuscite, 0 prove limitate alla compilazione, 0 combinazioni saltate, 0 errori aperti nella fixture**. Il dettaglio per linguaggio, motore e output è in `artifacts/qa-codegen-final.json`.

Sono stati compilati effettivamente 50 output Rust, TypeScript, Java, Kotlin, C#, C, C++ e Go. Gli altri 30 output Python, JavaScript, PHP e Ruby sono stati analizzati/eseguiti dai rispettivi interpreti. Il conteggio non deriva dalla sola riuscita del generatore.

## Prove eseguite

| Motore | CLI CRUD | API HTTP CRUD |
|---|---:|---:|
| SQLite | 12/12 | 4/4 |
| PostgreSQL 18.6 | 12/12 | 4/4 |
| MySQL 8.4.13 | 12/12 | 4/4 |
| MariaDB 11.8.5 | 12/12 | 4/4 |
| MongoDB 8.0.16 | 12/12 | 4/4 |
| Totale | **60/60** | **20/20** |

La fixture SQL è `people(id BIGINT PRIMARY KEY, name TEXT NOT NULL)`; SQLite usa `INTEGER PRIMARY KEY`. MongoDB usa documenti con `_id` e `name`. Ogni programma ha inserito, letto, aggiornato e cancellato un record, verificando il ritorno di testo Unicode e di un valore contenente apici e testo simile a SQL. Il valore è rimasto un dato, senza alterare la tabella. Le API hanno ricevuto richieste HTTP reali GET/POST/PUT/DELETE su loopback; Rust usa Axum, Python FastAPI, JavaScript e TypeScript Fastify.

Un test aggiuntivo Python/SQLite ha verificato un intero a 64 bit prossimo al limite, la conservazione Unicode e il rifiuto della cancellazione priva della chiave. I cinque test unitari del modulo verificano catalogo, identificatori/espansione dei template, tipi/duplicati/filtro Mongo, assenza di credenziali incorporate e tipi BSON campionati `Int32`, `Int64`, `EmbeddedDocument`, `Null`.

Gli account dei server temporanei sono quelli limitati dei laboratori. Le password sono state lette dal portachiavi Windows e passate ai processi tramite ambiente; il rapporto finale non contiene password, URI autenticati o riferimenti ai segreti.

## Toolchain e dipendenze effettive

Windows x64; Rust 1.99.0, Go 1.27.0, Python 3.11.15, Node 24.15.0, compilatore TypeScript 6.0.3, SDK .NET 10.0.401 con target net10.0, Java runtime 25.0.4.101 e toolchain 21.0.12.101, Gradle 9.7.1, plugin Kotlin 2.1.10, PHP 8.4.27 NTS, Ruby 4.0.9. I programmi SQLite C/C++ sono stati compilati con GCC 16.2.0; gli altri C/C++ con MSVC 19.51.36260 e librerie native coerenti con quell'ABI. MongoDB C Driver 2.5.8 è stato compilato dai sorgenti ufficiali con TLS Secure Channel.

- Rust: SQLx 0.9.0 e driver MongoDB 3.10.0.
- Python: psycopg 3.3.8, PyMySQL 1.2.4, pymongo 4.19.0, FastAPI 0.162.2, Uvicorn 0.54.0.
- Node: better-sqlite3 12.11.1, pg 8.23.1, mariadb 3.5.5, mongodb 6.22.0, Fastify 5.12.8. I tipi sono stati verificati contro le dichiarazioni reali dei pacchetti.
- .NET: Microsoft.Data.Sqlite 10.0.13, Npgsql 10.0.3, MySqlConnector **2.6.2**, MongoDB.Driver **3.13.0**.
- PHP: estensione mongodb 2.5.7 e libreria Composer mongodb/mongodb 2.5.1; PDO SQLite/PostgreSQL/MySQL.
- Ruby: sqlite3 2.10.2, pg 1.7.0, mysql2 0.5.7, bson 5.2.0, mongo 2.26.1, logger 1.7.0.

PHP e Ruby e le dipendenze di verifica sono portabili e confinati nella cartella QA. Non è stata effettuata un'installazione globale di questi runtime.

## Correzioni ricavate dalle prove

- URI `mysql:` normalizzato a `mariadb:` per il connector Node, pur mantenendo separati i test dei due server.
- TypeScript rigoroso con tipi Node espliciti; eliminato un confronto impossibile fra tipi letterali di motori diversi.
- Risolti il doppio rilascio dello statement SQLite Ruby e l'uso di `statement.affected_rows` per statement MySQL preparati.
- MongoDB PHP usa le API `MongoDB\BSON\Document` del driver 2; Ruby conserva Extended JSON tramite `as_extended_json` e dichiara `logger`, separato dai componenti predefiniti in Ruby 4.
- Argomenti Unicode Windows convertiti in UTF-8 nei programmi C/C++; output JVM esplicitamente UTF-8. Gli handle C++ hanno deleter RAII specifici.
- MySQL nativo permette di impostare `DB_PLUGIN_DIR` per i plugin di autenticazione, compreso `caching_sha2_password`.
- Gli avvisi NuGet inizialmente osservati sono stati risolti aggiornando i driver .NET. I tre output interessati sono stati ricompilati e hanno superato nuovamente CRUD sui server reali, senza quegli avvisi. L'aggiornamento include MySqlConnector successivo alla correzione [GHSA-473q-m89c-ghf8](https://github.com/advisories/GHSA-473q-m89c-ghf8) e rimuove le vecchie dipendenze transitive segnalate, fra cui [Snappier vulnerabile](https://github.com/advisories/GHSA-pggp-6c3x-2xmx).

## Limiti della verifica

La certificazione riguarda la fixture CRUD descritta; non dimostra compatibilità con ogni tipo specifico dei motori, ogni query SQL/MQL, tutti gli scenari TLS o ogni forma di schema. Non sostituisce una verifica di sicurezza complessiva.

La generazione con colonne SQL binarie è ammessa per Rust, Python, JavaScript e TypeScript; negli altri linguaggi viene rifiutata con un messaggio esplicito, evitando conversioni arbitrarie in testo. Lo script SQL rimane disponibile. Date, decimal e tipi personalizzati non sono stati provati esaustivamente su tutte le combinazioni. I valori C nativi vengono conservati anche come stringhe esatte; per interi JSON oltre 2^53 il template C richiede una stringa.

I template C++ usano le API C ufficiali di SQLite, MariaDB Connector/C, libpq e libmongoc con RAII, scelta motivata dalla riduzione dei componenti e dei problemi ABI su Windows. I test nativi hanno usato le librerie dei runtime QA e un progetto CMake di verifica; l'installazione tramite vcpkg dei manifest esportati non è stata provata da una macchina pulita.

Le API si legano esclusivamente a `127.0.0.1:3000` e non includono autenticazione applicativa. PUT e DELETE identificano il record attraverso le chiavi nel corpo JSON, così da supportare anche chiavi composite. I template non eseguono automaticamente il codice, non installano dipendenze e non inviano dati a servizi AI.

## Riproduzione

`tests/codegen` contiene il piccolo harness Rust, i controlli di sintassi, i build runner e gli esecutori CLI/HTTP. Le cartelle `generated`, `toolchains`, `target` e `node_modules` sono escluse dal versionamento. I server devono essere laboratori effimeri con manifest QA attivo e credenziali nel portachiavi; le prove non vanno puntate verso database personali o di produzione.

`python tests/codegen/write_report.py` consolida esclusivamente gli esiti conclusivi: fallisce se una combinazione attesa manca o se gli esiti letti non sono positivi. I tentativi intermedi non determinano il conteggio finale.

## Prova separata di interruzione MongoDB

Il modulo `src-tauri/src/mongo_cancel.rs` è stato provato con il driver Rust 3.10 sul laboratorio MongoDB 8.0.16 e sul solo account `readWrite`, senza aggiungere privilegi. Due aggregazioni lunghe sulla medesima collezione QA portavano UUID distinti. Per il job richiesto sono state osservate una operazione, una richiesta killOp e la successiva sparizione da `$currentOp`; il future originale ha restituito **11601 Interrupted**. L'altra aggregazione risultava ancora attiva ed è stata interrotta separatamente per pulizia. La collezione temporanea è stata rimossa.

L'evidenza è `artifacts/qa-mongo-cancel.json`. Il modulo filtra sempre `allUsers:false`, namespace del database e commento `dbm-UUID` esatto, con limite complessivo di tre secondi. Non usa cancellazioni di connessioni o sessioni generiche. Su `mongos` restituisce un limite esplicito: secondo la [documentazione di `$currentOp`](https://www.mongodb.com/docs/manual/reference/operator/aggregation/currentop/), lì è richiesto `inprog` anche con `allUsers:false`. Su `mongod` è consentito [interrompere le proprie operazioni senza privilegio killop](https://www.mongodb.com/docs/manual/reference/command/killop/).

Questa prova riguarda il modulo di interruzione; l'integrazione nel ciclo di vita di una query dell'applicazione viene verificata separatamente. L'interruzione di una scrittura non implica automaticamente rollback. Il caso di un job non più osservabile viene segnalato come tale, senza dichiarare un kill riuscito.
