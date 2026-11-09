# Database Manager 0.2 — strumenti grafici, query e generazione inversa

La revisione parte dai flussi segnalati come mancanti o difficili da trovare. Il confronto con DBeaver 26.2.2 e pgAdmin 4 9.19 installati è documentato in [CONFRONTO-GESTORI.md](CONFRONTO-GESTORI.md): REA è stata usata sui pacchetti distribuiti e sulle dichiarazioni degli editor, senza accedere a connessioni o database personali. La copertura del confronto è statica e parziale.

## Funzioni aggiunte o rifatte

- **Dati tabella** ha una voce propria: celle selezionabili, Modifica/F2, Invio/Tab/Esc, NULL esplicito, più righe selezionate, copia TSV/CSV, incolla con anteprima atomica, colonne ridimensionabili, viste Tabella/Scheda/JSON e salvataggio preparato. Le righe senza PK restano protette dalle modifiche ambigue, ma consentono nuovi inserimenti.
- **Designer database** contiene più tabelle di progetto, campi, tipi, PK, NULL, UNIQUE, identità, default, indici e relazioni. Nel grafo i collegamenti si creano trascinando fra i campi oppure facendo clic prima sul connettore di origine e poi su quello di destinazione. SQL o validazione MongoDB vengono generati; la creazione fisica richiede la revisione della destinazione. Il progetto si salva e si riapre come JSON, e rimane disponibile anche senza connessione. L'ambito **Solo strutture mancanti** evita di riproporre CREATE per tabelle già rilevate; **Progetto completo** conserva l'anteprima dell'intero progetto. Le modifiche agli oggetti esistenti non diventano ALTER automatici: richiedono uno script o una migrazione esplicita.
- **Generazione inversa**: le strutture disegnate diventano lo schema di input del generatore. Sono disponibili codice di lettura, funzione parametrizzata, modello/classe/DTO, repository di lettura, programma CRUD completo, API REST e script. I modelli possono essere generati per tutte le tabelle del progetto.
- **Lettura visuale**: scelta delle colonne, chiave primaria, filtri tipizzati, JOIN, raggruppamenti, COUNT/SUM/AVG/MIN/MAX, ordinamento e limite. Query, parametri e codice rimangono distinti. Una scelta cambiata rende esplicitamente superato il codice precedente e richiede rigenerazione prima della copia.
- **Catalogo query**: categorie, livelli, motore, ricerca, spiegazione, parametri di esempio, riferimenti, query personali e cronologia. Gli esempi usano lo schema corrente; in assenza di schema viene dichiarata la natura dimostrativa. Aprire o inserire una query non la esegue.
- **Autocompletamento reale Monaco**: tabelle, colonne, alias, CTE, parole chiave e funzioni; attivazione con punto, Ctrl+Spazio e pulsante Completa. Hover, firma delle funzioni e snippet completano l'aiuto contestuale. Sono stati caricati anche il controller dei suggerimenti e quello degli snippet: il solo modulo inline non attivava il menu del componente installato.
- **Elementi query**: selezione di tabelle e più colonne, clausole, funzioni e operatori, anteprima e inserimento al cursore o sulla selezione. Le condizioni aggiungono parametri separati. Le spiegazioni offline mostrano clausole, ordine logico e suggerimenti sugli errori.
- **Correzioni di leggibilità**: il pannello del codice generato mantiene un'altezza reale di 450 pixel; la griglia dei campi non viene compressa a una sola riga. I parametri booleani vengono adattati ai driver che richiedono interi per SQLite.

## Verifiche

### Percorsi osservati nella UI 0.2

Il collaudo grafico corrente è stato svolto nel **browser interno IAB**, con l'interfaccia 0.2 collegata al backend di anteprima e a un laboratorio SQLite. Sono stati osservati direttamente:

- il popup reale di completamento sui campi dell'alias di `customers`, l'accettazione di `c.city` e la successiva esecuzione con **5 righe** restituite;
- la selezione delle colonne `id` e `name` nel pannello Elementi, la preparazione della SELECT e la sua esecuzione con **5 righe**;
- consultazione del catalogo e salvataggio di una query, con **1 voce** visibile nella sezione Salvate durante la sessione di prova;
- creazione fisica dal designer delle tabelle `qa_inverse_people` e `qa_inverse_orders`, e della FK `qa_inverse_orders.customer_id → customers.id`;
- modifica preparata nella griglia: il database manteneva il valore precedente prima di Applica; dopo Applica il nome risultava persistito come `Anna QA v020`;
- il percorso di generazione del codice nell'interfaccia, distinto dalle prove di compilazione/esecuzione dei linguaggi riportate sotto.

La ricevuta [qa-v020-live-receipt.json](../artifacts/qa-v020-live-receipt.json) registra lo **stato finale del database**: valore salvato, definizioni delle due tabelle e chiave esterna. Non contiene una registrazione degli eventi del popup o delle selezioni: questi appartengono alle osservazioni grafiche sopra elencate.

La spiegazione offline passo per passo è implementata e coperta dai test automatici; non viene dichiarato un suo walkthrough grafico nella prova UI 0.2 corrente. Questo collaudo IAB non certifica l'avvio dell'applicazione desktop 0.2, l'installazione su una macchina pulita o il comportamento in una VM pulita.

La build dell'eseguibile e del pacchetto NSIS 0.2 è riuscita. Nel tentativo di avvio nativo, però, era ancora attiva la precedente 0.1: la 0.2 ha preparato il workspace isolato e poi è terminata per il vincolo di istanza singola. Non è stata verificata una finestra nativa 0.2. La vecchia applicazione è stata lasciata aperta per preservare il lavoro dell'utente; occorre chiuderla prima di avviare la nuova versione.

### Test automatici e programmi generati

La suite frontend contiene **101 test passati** e il nucleo Rust **66 test passati, 0 falliti e 3 ignorati** su 69 totali, oltre ai test reali separati. I test nuovi comprendono SQL SQLite realmente eseguito per tabelle, vincoli, JOIN, filtri, CTE, finestre, HAVING e parametri; clipboard/paste tipizzato; precisione BIGINT/DECIMAL; NULL e stringa NULL; parsing degli alias e gestione dei segnaposto. È compreso un test dell'introspezione SQLite dei metadati degli indici unici parziali.

Le nuove letture sono state verificate su SQLite nei **dodici linguaggi**. La suite include query con parametri, booleani, NULL ripetuti, interi grandi e testo simile a SQL; i casi effettivamente provati per ciascuna toolchain sono indicati nelle singole ricevute. I modelli sono verificati in generazione nei dodici linguaggi e compilati o esercitati dove indicato dalle singole ricevute; non viene estesa al runtime dei modelli Python/JavaScript una prova che riguarda soltanto la lettura. Ricevute locali:

- `artifacts/qa-workbench-python-js/`
- `artifacts/qa-workbench-otherlanguages/receipt.json`
- `artifacts/qa-workbench-remaining/receipt.json`

Le prove precedenti dei 60 programmi CLI e 20 API REST sono riportate separatamente in `CODEGEN-VERIFICA.md`: non sono usate per fingere un collaudo runtime dei nuovi moduli su tutti i server. Le nuove letture coprono in generazione 60 coppie motore/linguaggio; il nuovo collaudo runtime documentato è su SQLite.

## Limiti dichiarati

- I repository nuovi sono repository di lettura; per CRUD completo si sceglie il programma o l'API.
- I vecchi progetti CRUD completi non ignorano parametri custom o schemi PostgreSQL diversi da `public`: il workbench richiede invece una funzione/repository con query qualificata.
- Tipi personalizzati e array possono essere restituiti nativamente dalle funzioni dinamiche; la generazione di modelli o codec non supportati viene rifiutata esplicitamente.
- Le relazioni MongoDB sono logiche; il programma non promette vincoli FK che il motore non implementa.
- Il designer crea le strutture mancanti, ma non migra automaticamente le tabelle esistenti né applica ALTER impliciti. Il grafo è uno strumento di progetto; controllare sempre lo script prima della creazione fisica.
- Il designer PostgreSQL della 0.2 crea nello schema **public**: lo script rende visibile `SET search_path TO public` e lo schema del progetto generato è `public`. Un oggetto omonimo in un altro schema non viene considerato una tabella `public` già presente. Questo limite riguarda il piano di creazione del designer.
- Le destinazioni delle FK devono esistere nelle strutture ancora da creare oppure nei metadati effettivi del database. Per una FK singola la colonna di destinazione deve essere PK o UNIQUE da sola: una colonna che è soltanto parte di una PK composta non basta. Un indice UNIQUE parziale non è accettato come destinazione. Una destinazione mancante o non adatta blocca il piano di creazione; rimangono i controlli finali del motore.
- La copia visuale di tabelle con FK composte non è supportata: l'adozione restituisce un errore esplicito e richiede di usare la definizione SQL originale per conservare l'intero vincolo. Il generatore mantiene il supporto alle PK composte; non sono la stessa limitazione.
- Restano validi i limiti su firma dell'installer, certificazione UAC/SCM in VM e migrazioni strutturali complesse documentati nella versione precedente.

La versione 0.2 è consegnata in una directory separata. Chiudere la vecchia 0.1 prima di avviare la 0.2: il programma mantiene intenzionalmente una sola istanza con lo stesso identificatore.
