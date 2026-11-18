# Database Manager — workbench grafico e codice

Questa guida descrive il workbench grafico. Il percorso con progetti multidatabase, funzioni da copiare, integrazione e assistente locale è nella [guida alla 0.6.0](WORKBENCH-0.6.0.md).

## Aprire e creare un lavoro

1. Apri **Inizio**. Scegli **Apri file o database** o **Apri cartella di lavoro**. La cartella resta nell’esploratore a sinistra, dove puoi espandere sottocartelle e aprire file.
2. Con **Nuovo**, scegli un file SQLite, un progetto grafico, l’importazione di uno script o una connessione. Per **Crea un database su server** seleziona una connessione con permessi di creazione. In MongoDB indica anche il nome della prima collezione.
3. Nel riquadro **Connessioni**, apri i dati di una tabella o usa il pulsante **Struttura** sulla sua riga. Le schede al centro tengono accessibili file, query, dati e strumenti. **Riprendi** torna al lavoro salvato localmente.

I file SQLite nuovi usano creazione esclusiva. Per un SQLite già esistente, l’apertura parte in sola lettura. **Test connessione** verifica un file esistente o un server. L’anteprima di file, script e sorgenti legge il contenuto.

## Designer, grafo e codice

- **Struttura e Designer.** Apri uno schema esistente o disegna tabelle, campi, indici e relazioni. Le posizioni delle schede restano nel progetto. **Script e creazione** mostra il DDL o JSON e la destinazione. Usa **Solo strutture mancanti** per creare nuovi oggetti oppure **Modifiche al database** per un piano di migrazione. Le altre bozze restano nel progetto.
- **Schema da codice.** In **Designer → Importa schema da codice**, scegli SQL, JSON MongoDB o codice sorgente. Il risultato indica oggetti recuperati, istruzioni escluse e righe di origine. Puoi anche aprire un progetto grafico JSON esistente tramite **Apri progetto**. I sorgenti sono analizzati staticamente. Concatenazioni dinamiche, ORM e riferimenti risolti a runtime possono richiedere di completare la bozza a mano.
- **Grafo operazioni.** Seleziona una tabella o collezione. Aggiungi nodi per filtro, colonne, join, aggregazione, ordinamento e limite, quindi collega l’uscita. Il grafo corrente permette un join oppure un’aggregazione. Per scrivere aggiungi **Scrivi nel database**, indica l’operazione e controlla destinazione e parametri nell’anteprima. Aggiornamento ed eliminazione richiedono almeno un filtro. Ogni scrittura richiede la conferma e un’anteprima nuova se cambiano schema o operazione.
- **Grafo da query.** Usa **Apri nel grafo** dall’editor o da un’istruzione estratta. La conversione accetta letture semplici a tabella singola, inserimenti di una riga, aggiornamenti ed eliminazioni con filtri confrontabili. Per join, espressioni arbitrarie, `OR` e comandi MongoDB liberi, resta disponibile l’editor. Il grafo produce SQL o Extended JSON e può aprire lo script preparato nell’editor.
- **Esportazione.** Scegli tra query, schema, migrazione revisionata e codice applicativo. Il pacchetto generato include istruzioni e prerequisiti per la libreria selezionata. La ricostruzione SQLite con vincoli e sequenze si applica nel Designer, che controlla le chiavi esterne in transazione. Per ottenere il dump nativo completo di un database remoto usa **Import / Export**.

## Copertura per motore

| Motore | Struttura visuale | Grafo e codice |
| --- | --- | --- |
| SQLite | File, tabelle, colonne, indici, relazioni e migrazioni compatibili. La ricostruzione verifica integrità e chiavi prima del commit. | Lettura e scrittura, schema SQL e codice applicativo. |
| PostgreSQL | Schemi qualificati, tabelle omonime, FK semplici tra schemi. Le FK composte sono inventariate in ordine. | Lettura e scrittura qualificate, schema SQL e codice applicativo. |
| MySQL e MariaDB | Creazione, rinomina e aggiunta compatibile di colonne, indici e relazioni. Il server può confermare DDL in passi distinti. | Lettura e scrittura, schema SQL e codice applicativo. |
| MongoDB | Collezioni vuote, campi dinamici e annidati, validatori e indici ordinari. Le opzioni avanzate rilevate restano visibili. | Lettura e scrittura, Extended JSON, CRUD e funzioni di schema in Rust, Python, JavaScript e TypeScript. |

Le funzioni schema SQL sono disponibili in Rust, Python, JavaScript, TypeScript, PHP, Java, C#, C, C++, Go, Kotlin e Ruby. Gli oggetti avanzati che il progetto grafico perderebbe durante una modifica sono bloccati e richiedono uno script nativo dedicato. La matrice dettagliata delle verifiche è nel [rapporto del workbench](REPORT-WORKBENCH-20261117.md).

## Ollama nell’editor

Apri **Impostazioni → Intelligenza artificiale**, scegli **Ollama locale** e seleziona un modello già disponibile. Il pannello **Assistente** conserva la conversazione mentre apri o chiudi il riquadro. I blocchi di codice si possono inserire al cursore o aprire in una nuova scheda. La selezione di query, schema e righe è distinta, con le righe escluse inizialmente.

Il completamento Ollama parte disattivato. Attiva **Su richiesta** per usare **Suggerisci con Ollama** o `Ctrl+Alt+Spazio`. La modalità automatica attende una pausa nella digitazione. Accetta il completamento proposto con `Tab`. `Ctrl+Spazio` continua a usare il completamento deterministico di Monaco.

## Query rapide in simulazione

Apri **Query rapide** dal menu principale. In alto c’è l’editor, sotto ci sono i risultati. A sinistra trovi le tabelle della simulazione e la cronologia delle ultime 50 prove della sessione. Aprire una tabella mostra un’anteprima senza sostituire la query. Selezionare una prova nella cronologia ripristina testo e parametri.

**Esegui** o `Ctrl+Invio` invia lo script al database SQLite temporaneo in memoria. Puoi esercitarti con letture, inserimenti e modifiche strutturali sui dati sintetici. Per lavorare su una replica usa **Usa copia SQLite** dopo aver collegato un database SQLite di dimensioni fino a 128 MiB. La copia include lo stato confermato del database al momento della creazione. **Ripristina** torna ai dati sintetici iniziali o alla copia di partenza. La simulazione e la sua cronologia finiscono alla chiusura dell’app.

L’assistente a destra usa Ollama locale, con una conversazione distinta dall’editor principale. Attiva il completamento nelle impostazioni per ottenere suggerimenti al cursore. Il simulatore esegue il dialetto SQLite. Per PostgreSQL, MySQL, MariaDB e MongoDB usa i rispettivi laboratori isolati e l’editor principale.
