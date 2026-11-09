# Editor e libreria query

La libreria, il completamento e le spiegazioni funzionano localmente. Non richiedono un modello AI né inviano schema, query o risultati a servizi esterni. Apri, Inserisci, Spiega e Copia non eseguono una query: l'esecuzione rimane nei comandi dell'editor.

Sullo schema SHOP di riferimento le factory producono 30 esempi per ciascuno dei quattro motori SQL e 19 per MongoDB. Il numero si adatta allo schema disponibile: non vengono inventate misure numeriche, relazioni o campi mancanti per mantenere un conteggio fisso.

## Funzioni disponibili

- Libreria distinta in Catalogo, Salvate e Cronologia, con ricerca, filtro per motore/categoria/livello, preferiti, anteprima del codice e lezione in italiano. Le query salvate conservano parametri e modalità di esecuzione; la cronologia non inventa valori che non erano stati memorizzati.
- Esempi SQL per lettura, proiezione, DISTINCT, filtri parametrizzati, LIKE, NULL, IN, JOIN/LEFT JOIN, COUNT/SUM/AVG/MIN/MAX, GROUP BY, HAVING, sottoquery/EXISTS, CTE, finestre, CRUD, DDL, viste, indici, EXPLAIN, transazioni e savepoint.
- Comandi Extended JSON e pipeline MongoDB per filtri, proiezioni, raggruppamenti, ordinamenti, conteggi, `$lookup`, finestre e CRUD. La voce sulle transazioni usa `hello` per leggere la topologia e dichiara esplicitamente che non avvia una transazione.
- Completamento Monaco con Ctrl+Spazio e trigger sul punto: tabelle, colonne, alias, keyword, operatori, funzioni e campi/operatori Mongo. Le colonne dopo `c.` sono limitate all'origine dell'alias, anche quando FROM si trova dopo il cursore.
- Hover con tipo, nullabilità e chiave primaria, spiegazione delle clausole e firme dei parametri delle funzioni. Le funzioni sono inserite come snippet con il cursore fra gli argomenti.
- Pannello Elementi query: tabelle reali, scelta multipla di colonne, SELECT completa, clausole con parametri separati, JOIN sulle FK rilevate, raggruppamento, funzioni che avvolgono la selezione e anteprima con spiegazione.
- Analisi locale delle clausole e suggerimenti pertinenti per errori di nomi/alias, raggruppamenti, parametri, vincoli, permessi, timeout e interruzioni. Le stringhe, i commenti e gli identificatori quotati non vengono scambiati per keyword.

## Schema e parametri

Gli esempi usano nomi e colonne di `SchemaSnapshot`. Gli identificatori vengono quotati separatamente: doppi apici SQLite/PostgreSQL, backtick MySQL/MariaDB. Le chiavi composte vengono mantenute nelle condizioni di JOIN e nei filtri CRUD. In assenza di una PK non viene preparata una UPDATE/DELETE incompleta.

Senza schema sono mostrati esempi sul dataset dichiarato «Negozio e ordini», accompagnati dall'invito ad aprirlo. Gli esempi che dipendono da quelle tabelle non sono presentati come pronti sulla connessione. SELECT 1 e ping non richiedono tabelle. Una collezione Mongo vuota è un'origine reale, ma i campi mancanti non vengono inventati.

PostgreSQL usa `$1`, `$2`, … con chiavi JSON `"1"`, `"2"`, …; SQLite/MySQL/MariaDB usano parametri nominati `:nome`. Il pannello sceglie nomi non in conflitto con quelli già presenti. In Mongo i valori sono parte del comando JSON e non vengono sostituiti dal pannello dei parametri SQL.

MongoDB non espone FK: l'esempio `$lookup` ordini/clienti viene proposto solo quando i campi necessari esistono e dichiara che la relazione semantica deve essere verificata. Non viene presentata come un vincolo garantito dal database.

## API pubbliche

`src/editor/sqlLanguage.ts` esporta `installSqlLanguage(monaco, editor, getContext)`, che restituisce un disposable. I provider sono circoscritti al modello dell'editor ricevuto e leggono il contesto aggiornato dal callback. L'integrazione deve disporli alla sostituzione/smontaggio dell'editor. Espone inoltre `getSqlCompletions`, `parseSqlAliases`, `getFunctionSignature`, `explainQuery` ed `explainQueryError`, verificabili senza avviare Monaco nel browser.

`buildQueryCatalog(engine, schema)` produce esempi con disponibilità, motivazione di indisponibilità, livello, categoria, parametri tipizzati, lezione e riferimenti primari. `LibraryEntry` è il payload comune di apertura/inserimento; `executionMode: "script"` accompagna le sequenze di transazione. `savedQueryAction` preserva impostazioni e parametri memorizzati.

`QueryElementsPanel.onInsert(text, parameters?)` passa testo e valori separati. L'integrazione deve usare la selezione/cursore Monaco e unire i parametri al relativo pannello. Le funzioni costruiscono un'espressione che avvolge il testo selezionato. Un cambio di tabella o motore azzera l'anteprima precedente.

## Verifica effettuata

I test in `src/editor/sqlLanguage.test.ts` e `queryCatalog.test.ts` coprono il prefisso keyword senza schema, FROM contestuale, alias dichiarati dopo il cursore, quote e spazi nei nomi, commenti/stringhe/dollar quoting, isolamento degli statement, scope delle sottoquery, CTE con liste di colonne e CTE concatenate, alias PostgreSQL non quotati, firme annidate, campi/operatori Mongo e spiegazioni/errori locali.

Esito conclusivo: **31/31 test superati**, più controllo TypeScript `--noEmit` superato. Gli errori PostgreSQL su colonna, tabella e firma di funzione inesistenti producono suggerimenti distinti.

I test del catalogo eseguono le SELECT SQLite sul seed SHOP effettivo estratto da `src-tauri/src/lab.rs`, incluse JOIN con conteggi zero, HAVING, CTE e finestre. Eseguono separatamente CRUD parametrizzato, DDL, transazione e savepoint in database in memoria. Verificano anche uno schema con nomi contenenti apici/spazi e PK oltre la quarta colonna, assenza di PK/default values, differenze di placeholder/dialetto, JSON Mongo valido, collezioni vuote e conservazione dei parametri delle query salvate.

Comandi riproducibili:

```text
npm exec vitest run src/editor/sqlLanguage.test.ts src/editor/queryCatalog.test.ts
npm exec tsc --noEmit
```

La verifica SQL eseguita qui è SQLite. Gli altri dialetti sono verificati nei template/placeholder e confrontati con le fonti primarie; questa verifica non dichiara di aver rieseguito tutti gli esempi su PostgreSQL/MySQL/MariaDB/MongoDB.

### Integrazione grafica osservata nella 0.2

Nella prova corrente nel browser interno **IAB**, con frontend 0.2 e backend di anteprima sul laboratorio SQLite, sono stati osservati il popup effettivo dei suggerimenti per l'alias di `customers`, l'accettazione di `c.city` e l'esecuzione della query con **5 righe**. Nel pannello Elementi sono state selezionate `id` e `name`, preparata la SELECT ed eseguita anch'essa con **5 righe**. Sono stati inoltre consultati il catalogo e la sezione Salvate, nella quale compariva **1 query salvata** durante la sessione di prova.

La spiegazione offline passo per passo è presente nell'implementazione e nei test sopra descritti; non è incluso un suo walkthrough grafico nella ricevuta UI 0.2 corrente. Le prove IAB non equivalgono a una verifica dell'app desktop nativa 0.2 o di una VM/macchina pulita.

Il tentativo nativo finale non ha consentito una verifica della finestra 0.2: la precedente 0.1 era ancora in esecuzione e il vincolo di istanza singola ha fatto terminare la 0.2 dopo la preparazione del workspace isolato. La 0.1 è stata mantenuta aperta per preservare il lavoro dell'utente. Le prove di interfaccia qui dichiarate restano quelle IAB; per avviare la 0.2 occorre prima chiudere la vecchia istanza.

La ricevuta [qa-v020-live-receipt.json](../artifacts/qa-v020-live-receipt.json) conferma lo stato SQLite finale degli altri percorsi provati nella stessa sessione: nome `Anna QA v020` persistito dopo Applica, tabelle `qa_inverse_people` e `qa_inverse_orders` e FK `qa_inverse_orders.customer_id → customers.id`. Il controllo precedente ad Applica aveva verificato che la modifica preparata nella griglia non avesse ancora cambiato il database. Il file JSON è una verifica finale dei dati e dello schema, non una registrazione degli eventi del popup o dei clic.

Nel designer collegato alla libreria/editor, le relazioni si possono creare sia trascinando sia facendo clic sul connettore di origine e poi su quello di destinazione. **Solo strutture mancanti** prepara la creazione degli oggetti non ancora rilevati, evitando di ricreare quelli esistenti; gli oggetti già presenti non vengono convertiti automaticamente in ALTER o migrati dal grafo.

Per il designer PostgreSQL 0.2 il piano di creazione è esplicitamente limitato a **public**, con `SET search_path TO public` visibile nel DDL e `schema: "public"` nello schema generato dal progetto. Tabelle omonime in altri schemi non bloccano una nuova tabella in `public`. Le FK vengono confrontate con le tabelle ancora da creare e con i metadati reali del database; la destinazione di una FK singola deve essere una PK o una colonna UNIQUE singola, non un indice UNIQUE parziale. I riferimenti mancanti e i riferimenti a una sola parte non univoca di una PK composta bloccano il piano. I metadati degli indici parziali sono coperti anche da un test dell'introspezione SQLite. Questi vincoli non sono ulteriori casi dichiarati nel walkthrough IAB sopra elencato.

L'adozione nel designer di una tabella con FK composte restituisce un errore esplicito: per mantenere l'intero vincolo serve la definizione SQL originale. Questo limite del progetto visuale non elimina il supporto alle PK composte del generatore né le condizioni JOIN composte preparate dal catalogo su FK già rilevate.

## Limiti espliciti

Il riconoscimento locale è un analizzatore di token e scope, non un parser SQL completo o un language server del motore. Supporta i casi sopra descritti; procedure complesse, estensioni di dialetto, SQL dinamico e tipi di funzioni personalizzate non hanno una verifica semantica completa. L'analisi non certifica che una query sia priva di effetti collaterali: valgono i permessi e i controlli del backend.

Le funzioni finestra richiedono versioni moderne dei server; `$setWindowFields` richiede MongoDB 5.0 o successivo. I DDL MySQL/MariaDB possono eseguire commit impliciti. L'EXPLAIN del catalogo non usa ANALYZE/executionStats, che possono eseguire la query.

Riferimenti primari inclusi nel catalogo: [SQLite SELECT](https://www.sqlite.org/lang_select.html), [CTE SQLite](https://www.sqlite.org/lang_with.html), [finestre SQLite](https://www.sqlite.org/windowfunctions.html), [PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html), [MySQL 8.4 SELECT](https://dev.mysql.com/doc/refman/8.4/en/select.html), [MariaDB SELECT](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/select), [MongoDB aggregazione](https://www.mongodb.com/docs/manual/aggregation/) e [MongoDB $lookup](https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/). Le API Monaco utilizzate sono le API pubbliche dell'SDK 0.57 installato (`monaco.d.ts`).
