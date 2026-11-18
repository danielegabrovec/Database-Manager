# Database Manager 0.6.0 — collaudo Windows x64

**18 novembre 2026.** Verifiche effettuate con dati sintetici e workspace di prova separati.

## Dallo schema al codice e ritorno

- Un progetto con `catalogo.clienti`, `catalogo.ordini` e `archivio.clienti` ha generato un pacchetto Python. L’inizializzazione ha creato due file SQLite distinti, con FK e seed. Il programma e le funzioni copiate hanno letto, inserito, aggiornato ed eliminato record nella destinazione attesa.
- Un modello Ollama locale, `qwen2.5-coder:14b`, ha prodotto schema, seed e grafi a partire dall’obiettivo in italiano. Il percorso condiviso con la UI ha convalidato il progetto, eseguito le operazioni nei database temporanei e generato il codice. La modifica di un filtro nel file Python esportato ha cambiato le righe restituite dopo rilettura e prova del grafo. Il manifesto di partenza era identico.
- La modalità **Modifiche reali** è stata provata su un file SQLite sintetico. Il valore precedente è stato letto dopo l’anteprima. La conferma ha aggiornato un record e il backend ha rifiutato il riuso dello stesso token.
- L’integrazione in una cartella applicativa ha superato prove di selezione dei file, diff effettivo, collisioni di percorso Windows, modifiche esterne, seconda integrazione identica e recupero del journal dopo interruzione. Un conflitto manuale blocca il ripristino del file interessato.
- Le prove isolate su PostgreSQL, MySQL, MariaDB e MongoDB hanno creato strutture, caricato esempi e letto i dati sui motori reali. I laboratori temporanei sono stati rimossi. Il caricatore dei seed è stato provato su tutti e cinque i motori con Unicode, valori NULL e interi oltre la precisione di un numero JavaScript.
- Sono stati generati i pacchetti nelle 60 combinazioni fra cinque motori e dodici linguaggi. Le singole funzioni copiate per lettura e aggiornamento sono state eseguite su SQLite in tutti i dodici linguaggi. Il test con SQLx 0.9 ha individuato un errore nella firma Rust, corretto prima del rilascio. Per gli altri motori la copertura dei frammenti è specificata nella [matrice](MATRICE-0.6.0.md).

## Home, chat e interfaccia

- Verificati apertura Home, navigazione da tastiera, menu e ricerca, domanda dalla Home, bozza disponibile con servizio spento, filtro dei modelli, risposta locale in streaming e interruzione. Testati persistenza, ambiti distinti per conversazioni normali e Query rapide e consenso ai dati allegati.
- Un’istanza Ollama privata di prova è stata avviata e arrestata su Windows. I test coprono annullamento durante l’avvio, sospensione degli avvii automatici dopo uno stop manuale, conferma di arresto condiviso e rilevamento di un nuovo listener.
- Verificate le disposizioni a 1480×940, 1251×760 e 1000×680. Il collaudo ha portato a correggere lo spazio del grafo nel progetto e l’accessibilità del campo di scrittura e del comando Ollama nel cassetto stretto.

- Nell’eseguibile nativo corretto sono stati misurati tutti e tre i viewport, aperto il menu File e verificato il ritorno al lavoro con Esc. Il grafo del progetto mostrava due nodi collegati e un canvas di 873 px nella prova larga. Al riavvio erano ancora disponibili i due alias. Su una copia del workspace QA precedente sono stati confrontati il contenuto di due bozze, i parametri, il documento attivo e la modalità di esecuzione. Gli hash dei testi prima e dopo l’aggiornamento coincidevano.

## Build e riproduzione

**351 test frontend e 124 test Rust superati** nella suite standard, con 14 prove opzionali escluse dalla corsa predefinita. TypeScript, Vite e compilazione Rust Windows completati. La suite standard è stata eseguita con `npm test` e `cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features`. I test che richiedono server o Ollama reali sono stati eseguiti separatamente. Vite segnala la dimensione del bundle principale. Il collaudo usa WebView2 sul sistema Windows disponibile. L’installazione in una VM Windows pulita resta non certificata.

Con il bridge QA in ascolto su loopback, `node scripts/verify-project-cycle.mjs` ripete il ciclo Python usando la fixture. `node scripts/verify-project-cycle.mjs --ollama` lo ripete chiedendo la proposta al modello locale configurato. Il pacchetto include avvisi di terzi, manifest e checksum degli asset. L’installer Windows x64 è distribuito senza firma digitale.
