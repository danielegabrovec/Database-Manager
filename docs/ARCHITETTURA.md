# Architettura e contratti

## Componenti

- `src/`: interfaccia React/TypeScript, Monaco locale, TanStack Table/Virtual e React Flow.
- `src-tauri/src/models.rs`: profili, metadati, valori tipizzati e modifiche preparate.
- `database.rs`, `sqlite.rs`, `remote.rs`: sessioni dedicate e adattatori reali dei cinque motori.
- `service.rs`: dispatcher validato condiviso da Tauri e anteprima HTTP.
- `store.rs`: metadati, query, cronologia e preferenze in SQLite; segreti nel gestore credenziali Windows.
- `lab.rs`: seed deterministici ed esercizi. Le verifiche SQLite usano copie indipendenti dei dati iniziali.
- `codegen.rs` e `codegen/`: template deterministici, programmi e API REST.
- `environment.rs`: catalogo, verifica archivi, provisioning, proprietà e ciclo di vita.
- `windows_service.rs` e `windows_service/`: pianificazione, helper UAC, account virtuali e controlli SCM per servizi opzionali.
- `mongo_edit.rs` e `mongo_cancel.rs`: modifiche transazionali e interruzione delle sole operazioni correlate della sessione.
- `assistant.rs`: contesto AI con consensi separati e limiti di dimensione.
- `tools.rs`: backup/ripristino nativi, ricevute e confronto strutturale.

## Interfacce

Il frontend invoca `backend_call({command,args})`. I comandi comprendono profili, sessioni, introspezione, esecuzione, paginazione, modifiche, laboratorio, generatori, trasferimenti, ambienti e assistente. Gli stessi comandi sono esposti dal bridge di sviluppo su `127.0.0.1:8787/api/<command>` con controllo dell'Origin browser.

`execute_query_stream` usa un Channel Tauri con eventi `columns`, `rows` e `complete`. I blocchi IPC contengono al massimo 250 righe; il risultato interattivo è limitato a 10.000 righe. I valori numerici vengono trasmessi come stringhe tipizzate. Le esportazioni non caricano l'intero contenuto nel WebView.

Le sessioni conservano connessioni, transazioni e tunnel. Le modifiche della griglia usano parametri e confronto dei valori originari. MongoDB conserva Int32/Int64 e distingue campo assente e NULL; sui replica set applica i batch in una transazione. Savepoint e transazioni evitano di commettere implicitamente le modifiche già aperte nell'editor. Una disconnessione durante una scrittura non determina retry automatici.

## Ambiente locale e dati

La directory predefinita è `%LOCALAPPDATA%\DatabaseManager`; `DBM_DATA_DIR` permette un percorso alternativo per sviluppo e collaudo. Il registro degli ambienti identifica ogni risorsa tramite UUID e marker di proprietà. Rimozione e reset verificano tale proprietà; i server esterni non vengono arrestati o eliminati.

I server nativi vengono scaricati solo su richiesta da distribuzioni ufficiali ammesse nel catalogo. Il pacchetto è verificato prima dell'estrazione. Runtime e dati sono separati. I processi dei laboratori Windows appartengono a Job Objects; la chiusura del supervisore li termina. L'app desktop consente una sola istanza per evitare scritture concorrenti del registro.

Il normale JSON non conserva tutti i tipi BSON; MongoDB usa Extended JSON canonico. L'introspezione delle collezioni è un campione di massimo 20 documenti e viene indicata come tale. Il laboratorio isola dati e istanze, non esegue programmi arbitrari.

## Scelte di compatibilità

- L'interfaccia MongoDB accetta comandi e pipeline JSON, non JavaScript arbitrario di mongosh.
- C++ riutilizza i driver C nativi con gestione RAII anziché aggiungere libpqxx/mongocxx: riduce le incompatibilità ABI delle toolchain Windows.
- Le API REST generate usano `/records` e chiavi esplicite nel payload, comprese quelle composte; il README di ciascun progetto documenta le richieste. Sono modelli di sviluppo locale con ascolto su loopback.
- Query, script e progetti non richiedono AI. I template dichiarano librerie, versioni e prerequisiti.
- Nessun programma generato viene eseguito automaticamente dall'applicazione.

## Confini attuali

Il confronto strutturale è revisionabile; il generatore di migrazioni emette creazioni e aggiunte, mentre rimozioni e conversioni richiedono revisione manuale. Le funzionalità specifiche dei client `psql`, `mysql` e `mongosh` non sono tutte istruzioni inviabili direttamente ai driver.

Gli strumenti di backup esterni e TLS devono essere disponibili/configurati per il motore. I backup server ripristinabili tramite l'app richiedono ricevuta valida, motore/database corrispondenti e conferma. Non viene promessa atomicità globale per DDL MySQL/MariaDB o ripristini MongoDB.
