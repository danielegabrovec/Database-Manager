# Catalogo Windows x64: provenienza e verifica

Verificato il 9 novembre 2026. Gli archivi vengono scaricati soltanto su richiesta di creazione di un ambiente nativo; non sono inclusi nel programma distribuito. I dati delle istanze sono separati dai runtime. Il codice non registra servizi Windows e non modifica server già installati.

| Motore | Archivio ufficiale | Byte osservati | SHA-256 |
|---|---|---:|---|
| PostgreSQL 18.6-5 | [ZIP EDB](https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip) | 384620317 | `e2246ba91d22345bc3d017586c09ede52d9df180b1eeb480f050445f1cad84e2` |
| MySQL 8.4.13 | [ZIP MySQL](https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-8.4.13-winx64.zip) | 281154912 | `e9cd98b1d23f122987b1afca26ad942efec5891481103d48ae3cde237fa3ea54` |
| MariaDB 11.8.5 | [ZIP MariaDB](https://archive.mariadb.org/mariadb-11.8.5/winx64-packages/mariadb-11.8.5-winx64.zip) | 95876446 | `75332dc1f437d9ecee253c2d751d02a69628b109ddd031006f8a8d9ba59dbe0d` |
| MongoDB 8.0.16 | [ZIP MongoDB](https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.16.zip) | 792329900 | `34eb6795860e29bdf8e5cc9cb4cbba2c73295a25c60204667029d5f3614fe807` |

Per PostgreSQL, MongoDB e MariaDB, il contenuto scaricato è stato confrontato con SHA-256 pubblicati dal distributore:

- [EDB SHA-256](https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip.sha256), anche [confermato dal distributore](https://github.com/EnterpriseDB/edb-installers/issues/746).
- [MongoDB SHA-256](https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-8.0.16.zip.sha256).
- [MariaDB sha256sums.txt](https://archive.mariadb.org/mariadb-11.8.5/winx64-packages/sha256sums.txt).

MySQL pubblica MD5 e firma GPG nella [pagina ufficiale del download](https://dev.mysql.com/downloads/mysql/8.4.html?os=3). Il file scaricato via HTTPS ha MD5 `7b94489d5524dea9b27097068bea25a8`, identico a quello pubblicato. SHA-256 è stato calcolato sull'intero ZIP scaricato e fissato nel catalogo. La firma GPG non è stata verificata durante questa acquisizione.

Questi controlli dimostrano l'integrità rispetto agli artefatti acquisiti; la prova di avvio e CRUD è separata. La selezione non viene presentata come elenco delle ultimissime patch disponibili. Aggiornare un manifest richiede riacquisizione delle prove e ripetizione del test nativo.

## Cache e verifiche di esecuzione

La cache di acquisizione è `artifacts/cache/` nella radice del progetto, esclusa dal versionamento; occupa circa 1,55 GB. Non viene eseguito codice durante il controllo degli hash e dell'indice ZIP. Il programma calcola nuovamente SHA-256 prima di estrarre; estrazione su disco con limiti dimensionali e rifiuto dei percorsi esterni e dei link simbolici.

`EnvironmentManager::with_archive_cache` consente di riutilizzare la cache esplicita durante i test. In una build di sviluppo, se esiste la cache nella directory corrente, `new` la riutilizza; nella distribuzione finale la cache è sotto l'area dati dell'app.

Test d'integrazione esplicito, seriale:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --no-default-features native_environments_verified_archives_smoke -- --ignored --nocapture --test-threads=1
```

Il test crea quattro istanze sotto `artifacts/qa-native/<UUID>`, usando credenziali dell'archivio OS, porta libera su loopback e ruolo `dbm_lab` nel database `laboratory`. Verifica creazione, autenticazione, scrittura/lettura, arresto e riavvio. MongoDB usa un replica set locale a nodo singolo e autenticazione. I dati delle istanze vengono eliminati dopo la prova; cache e runtime estratti restano riutilizzabili.

L'installazione di runtime Windows mancanti e la registrazione di servizi richiedono un percorso separato: questa versione avvia i database come processi dell'utente corrente. Non attribuire a questi processi l'isolamento di una sandbox per codice ostile.

I processi dei laboratori Windows vengono assegnati a un Job Object con `KILL_ON_JOB_CLOSE`: chiusura o crash del supervisore terminano anche i loro processi figli. Questo gestisce il ciclo di vita di binari database conosciuti; non esegue né isola programmi arbitrari.

## Strumenti MongoDB per backup e ripristino

Il server MongoDB ZIP non contiene `mongodump` e `mongorestore`. Su un'azione esplicita di backup/ripristino, `ensure_client_tool` può acquisire il pacchetto separato [MongoDB Database Tools 100.20.1 Windows x64](https://fastdl.mongodb.org/tools/db/mongodb-database-tools-windows-x86_64-100.20.1.zip), 45744557 byte, SHA-256 `5a1a8aa2c87ca0685ffdcad403601b110d495d44afe579473b8f75ec46621c80`. Hash confrontato con il record `versions[].downloads[name=windows,arch=x86_64].archive` del [manifest ufficiale](https://downloads.mongodb.org/tools/db/release.json) e con l'intero archivio scaricato il 9 novembre 2026. La [tabella di compatibilità](https://www.mongodb.com/docs/database-tools/release-notes/database-tools-changelog/) include MongoDB 8.0 tra le versioni precedenti supportate.

La cache include anche un'acquisizione esplorativa 100.20.0; il codice usa esclusivamente 100.20.1 e il suo hash fissato. Nessun cambiamento del PATH o installazione globale.

`tools::backup_native` produce una ricevuta senza credenziali (motore, database, dimensione, SHA-256). `restore_native` richiede conferma esplicita, file creato dall'app, ricevuta integra e lo stesso database destinazione. PostgreSQL usa `pg_restore` in singola transazione. MySQL/MariaDB usano il client con `--binary-mode` e `--local-infile=0`; MongoDB ripristina esclusivamente il namespace selezionato. Un errore sui motori senza transazione globale può lasciare modifiche parziali e viene riportato come tale. Non viene promesso il ripristino automatico di dump esterni o la rimappatura tra database.

Il test d'integrazione `tests/native_tools.rs`, ignorato finché non eseguito esplicitamente, usa soltanto `artifacts/qa-active.json` del supervisore. Verifica recupero di un record cancellato dopo il backup su tutti i quattro motori e produce `artifacts/qa-native-tools-results.json`, senza credenziali.
