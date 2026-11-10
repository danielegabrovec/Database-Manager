# Guida utente — Database Manager 0.5.1

**Autore: Daniele Gabrovec.** Condizioni d'uso in [LICENSE](../LICENSE), informazioni sui dati in [PRIVACY.md](../PRIVACY.md).

Database Manager offre editor e strumenti visuali per SQLite, PostgreSQL, MySQL, MariaDB e MongoDB. La distribuzione disponibile è Windows x64. I compilatori e gli interpreti dei programmi esportati si installano separatamente.

Per i comandi passo passo, le operazioni da PowerShell e il prontuario con spiegazioni ed esempi usa **Guida** nella barra inferiore oppure la [guida operativa completa](GUIDA-OPERATIVA-POWERSHELL-QUERY.md): 50 passi e 77 esempi. Le novità sono in [VERSIONE-0.5.md](VERSIONE-0.5.md).

## Installare e aprire

Scarica l'installer dalla [pagina dell'ultima release](https://github.com/danielegabrovec/Database-Manager/releases/latest). Se la release comprende anche l'eseguibile, puoi usare quello senza una procedura di installazione dell'app. È richiesto Microsoft Edge WebView2; il primo setup può richiedere la rete per il runtime.

Chiudi le versioni precedenti prima di aprire la nuova. È consentita una sola istanza: avviare un secondo eseguibile può riportare in primo piano quello già aperto, anche scegliendo un'altra cartella di lavoro.

Tema e modalità si cambiano nell'interfaccia: **Apprendimento personale**, **Studio e lavoro**, **Sviluppatori esperti**. La guida didattica e le funzioni principali non richiedono un account AI.

## Orientarsi nel menu

**Apri file e database**, **Editor SQL / MongoDB** e **Laboratorio** sono accessi diretti. Espandi un gruppo per mostrare le altre aree:

- **Database:** Dati tabella, Struttura e relazioni, Designer database, Compositore query.
- **Catalogo:** **Catalogo PowerShell** e **Catalogo Query**.
- **Strumenti:** Generatore codice, Import / Export, Ambienti locali.

Si apre un gruppo alla volta. All'avvio su Apri file o Editor i gruppi sono chiusi; clicca **Catalogo** per vedere i due cataloghi. Riaprendo una vista interna ricordata, il relativo gruppo si apre automaticamente. Impostazioni resta nella parte inferiore della barra laterale.

Il percorso in alto indica l'area corrente. **Indietro** oppure `Alt+Freccia sinistra` torna alla vista precedente; i cataloghi mantengono ricerca, filtri, selezione e valori inseriti quando ti sposti e torni nella stessa sessione. L'ultima vista viene ricordata fra avvii, ma questo non implica il salvataggio permanente di ogni filtro o parametro dei cataloghi.

## Aprire un file che esiste già

Apri **Apri file e database** oppure premi `Ctrl+O`. Puoi scegliere il file dal selettore, incollare il suo percorso reale, riaprire un recente o esplorare una cartella. L'apertura mostra un'anteprima e non esegue SQL o programmi.

### Cartelle ed Esplora file Windows

Accanto a **Percorso cartella**, premi **Scegli cartella…** oppure `Ctrl+Maiusc+O`: nell'app desktop si apre il selettore grafico delle cartelle. Puoi anche incollare un percorso e caricarne l'elenco interno. **Apri in Esplora risorse** apre la cartella selezionata in Windows; nell'anteprima di un file, **Mostra file nella cartella** permette di ritrovarlo nel sistema.

Il browser non dispone del selettore Tauri: l'interfaccia lo dichiara, senza simulare una scelta di cartella. Un percorso reale può essere usato con il backend locale. L'elenco interno resta paginato, con ricerca sulle voci già caricate. I recenti conservano percorso e metadati locali; rimuovere un recente non elimina il file. Consulta [PRIVACY.md](../PRIVACY.md).

### Database SQLite

Scegli un file `.db`, `.sqlite` o `.sqlite3`, oppure un file con estensione diversa che abbia una firma SQLite valida. Vengono verificati firma e metadati; soltanto dopo puoi collegarlo. L'estensione da sola non dimostra il formato.

Il centro file propone **sola lettura**. Puoi scegliere esplicitamente la modalità modificabile prima di aprire il database; il profilo e il badge riflettono quella scelta. Un percorso mancante o un file non valido non vengono trasformati in un database vuoto. I file fisici di altri motori non sono SQLite: per PostgreSQL, MySQL, MariaDB e MongoDB usa la connessione al server.

### Script SQL e schede

L'anteprima permette di abilitare **Modifica testo**, salvare il file, ricaricarlo o usare **Salva come…**. **Apri script nell'editor query** crea una scheda con percorso, codifica e versione del file; non avvia lo script. La bozza modificata mantiene come riferimento il contenuto originale sul disco.

Le schede dell'editor conservano separatamente testo, parametri e modalità di esecuzione. `Ctrl+S` salva il file collegato; senza percorso apre Salva con nome. `Ctrl+Maiusc+S` sceglie una destinazione e `Ctrl+W` chiude la scheda con il controllo delle modifiche. **Salva in libreria** conserva invece una query personale nel workspace: è un'azione distinta dal salvataggio del file.

Se un altro programma o una scheda modifica il file sul disco, la fingerprint impedisce di sovrascrivere senza accorgersene. La bozza viene conservata: copiala se necessario e usa Ricarica per esaminare la versione esterna. Una scheda non modificata può aggiornarsi dopo una notifica di salvataggio dell'app.

Il centro file crea solo un nuovo percorso con Salva come e rifiuta quelli già esistenti. Nell'editor query l'eventuale sostituzione di un file di testo esistente richiede il consenso previsto dal dialogo e una lettura aggiornata della sua versione. Le query estratte da programmi si salvano come script separati: non riscrivono il programma sorgente.

### File di programma con istruzioni database

Apri il sorgente per vedere codice e istruzioni riconosciute. L'analisi statica copre forme comuni dei dodici linguaggi: Rust, Python, JavaScript, TypeScript, PHP, Java, C#, C, C++, Go, Kotlin e Ruby. Per ogni estrazione mostra righe di origine, lingua, testo, parametri e avvisi. **Mostra origine** porta al punto corrispondente; **Apri nell'editor query** prepara una bozza.

**Letterale** significa testo ricavato dal file, non query già validata dal motore. **Parziale** indica elementi dinamici o incompleti: interpolazioni e valori runtime non vengono inventati. Completa query e parametri e scegli una connessione SQL/MongoDB coerente prima di eseguire. Il file di programma non viene compilato, importato o eseguito dall'apertura.

### Codifica, cartelle e limiti

Il testo è letto con riconoscimento BOM/UTF-8; se la codifica è incerta devi scegliere esplicitamente UTF-16 o Windows-1252. Cambiare la codifica rilegge il file: con una bozza non salvata viene chiesto se scartarla. Non è una transcodifica automatica della sola bozza. Caratteri non rappresentabili producono un errore di salvataggio, senza sostituzioni silenziose.

L'anteprima testuale arriva a **8 MiB**. Nel centro file l'analisi sorgente è limitata a **1.000.000 di caratteri e 200 istruzioni**, con avviso quando una parte non è analizzata. L'elenco di cartella è paginato a 200 elementi e la ricerca riguarda quelli caricati. Le schede query hanno un limite di numero e dimensione complessiva.

Nell'anteprima browser un file scelto dal selettore web non fornisce un percorso OS. Rimane in memoria: puoi aprire una bozza e scaricare una copia UTF-8; per collegare SQLite o salvare sull'originale serve il percorso nativo reale. Non viene inventato usando il solo nome.

### Dump e direttive dei client

Per un dump usa **Importazione guidata nel database**, scegliendo motore, client e destinazione. Se hai modificato l'anteprima, salva prima: l'importazione legge il file sul disco. L'apertura del percorso di importazione non importa automaticamente i dati.

`COPY FROM stdin`, comandi psql con barra inversa e `DELIMITER`/`SOURCE` MySQL non sono normali statement del driver. La porzione scelta per l'esecuzione viene controllata prima di inviarla; script oltre 512 KiB vengono indirizzati all'importazione. Le direttive sqlite3 come `.read` richiedono revisione/rimozione, mentre `GO` appartiene al client SQL Server, motore non supportato dalla versione.

## Il primo laboratorio SQLite

1. Apri **Laboratorio**.
2. Scegli **SQLite** e **Negozio e ordini**.
3. Premi **Crea e apri laboratorio**.
4. Apri un esercizio nell'editor oppure una tabella nell'esploratore.
5. Esegui la query e torna al laboratorio per **Verifica query corrente**.

Il dataset contiene clienti, prodotti, ordini e righe degli ordini. Sono disponibili anche Biblioteca, Azienda e dipendenti, Magazzino e scorte. Il ripristino del laboratorio riporta i dati allo stato iniziale e perde le modifiche di quella prova.

I laboratori degli altri motori usano istanze dedicate native o Docker. Il primo provisioning può scaricare pacchetti o immagini; SQLite permette di iniziare senza un server.

## Collegare un database esistente

Premi **Nuova connessione**, scegli il motore e completa i campi:

- **SQLite:** scegli **Apri un database esistente**, oppure **Crea un nuovo database** per abilitare esplicitamente la creazione di un percorso mancante. Un file già presente deve essere SQLite valido e non viene troncato. `:memory:` indica un database temporaneo.
- **Server SQL o MongoDB:** host, porta, database, utente e password.
- **TLS:** connessione protetta e, quando necessaria, CA personalizzata.
- **SSH:** host intermedio e chiave OpenSSH per il tunnel.

Assegna un nome riconoscibile e l'ambiente Sviluppo, Test o Produzione. Il badge rimane visibile durante il lavoro. Puoi impostare la connessione in sola lettura. Aggiorna lo schema dopo cambiamenti effettuati da altri strumenti.

Le credenziali salvate usano il portachiavi del sistema. Profili, query e impostazioni restano nel workspace locale dell'app: non includerlo in un repository.

## Leggere e modificare dati

Apri una tabella nell'esploratore oppure in **Dati tabella**. Filtro, ordinamento e paginazione richiedono al server le righe necessarie. **Tabella**, **Scheda** e **JSON** offrono letture diverse dello stesso record.

Seleziona una cella e usa **Modifica** o `F2`. `Invio` prepara il valore, `Tab` passa alla cella successiva, `Esc` annulla l'editing. Il comando NULL è esplicito: stringa vuota e NULL non sono equivalenti.

Le modifiche sono **preparate** fino a **Applica**. Controlla l'anteprima con valori precedenti e nuovi, poi conferma. **Scarta** elimina le modifiche non inviate. Il backend controlla chiavi e conflitti prima dell'aggiornamento.

Sono disponibili selezione di più righe, copia TSV/CSV, incolla con anteprima e controllo dei tipi. **Nuovo record** prepara un inserimento. Modifica e cancellazione di record esistenti richiedono una chiave stabile; JOIN e risultati liberi restano di lettura.

## Editor, parametri e scorciatoie

Nell'**Editor SQL / MongoDB** scegli se eseguire selezione, istruzione corrente o intero script.

| Comando                      | Azione                                                          |
| ---------------------------- | --------------------------------------------------------------- |
| `Ctrl+Invio`                 | Esegue la porzione scelta.                                      |
| `Ctrl+Spazio` o **Completa** | Mostra schema, alias, keyword e funzioni.                       |
| `Ctrl+O`                     | Apre il centro file/selettore.                                  |
| `Ctrl+Maiusc+O`              | Apre il centro file e il selettore nativo di cartella.          |
| `Ctrl+S`                     | Salva il file della scheda; senza percorso apre Salva con nome. |
| `Ctrl+Maiusc+S`              | Salva con nome.                                                 |
| `Ctrl+W`                     | Chiude la scheda query con controllo della bozza.               |
| `Ctrl+K`                     | Cerca nello spazio di lavoro.                                   |
| **Interrompi**               | Richiede l'interruzione secondo motore e permessi.              |

Digita `c.` per completare i campi della sua origine. Hover e firme spiegano elementi e argomenti. L'interruzione di una scrittura non equivale automaticamente al rollback: controlla la transazione prima di ripetere l'operazione.

Per SQLite, MySQL e MariaDB:

```sql
SELECT id, name, city
FROM customers
WHERE city = :city
ORDER BY id;
```

Nel pannello **Parametri**:

```json
{ "city": "Udine" }
```

In PostgreSQL usa `WHERE city = $1` con `{ "1": "Udine" }`. I valori rimangono separati dal testo SQL. Per sequenze BEGIN/COMMIT/ROLLBACK scegli **Intero script** o esegui deliberatamente gli statement nell'ordine previsto.

### MongoDB

L'editor accetta comandi Extended JSON:

```json
{
  "find": "customers",
  "filter": { "city": "Udine" },
  "limit": 20
}
```

Le pipeline usano `aggregate`, `pipeline` e `cursor`. Non è una shell JavaScript per chiamate `db.customers.find(...)`. I valori appartengono al documento JSON; il pannello dei parametri SQL non sostituisce automaticamente i suoi campi.

## Catalogo Query ed elementi query

Apri **Catalogo → Catalogo Query**. Le tre schede sono **Esempi**, **Query salvate** e **Cronologia**. Cerca un'operazione o del codice e scegli il motore; **Filtri** espone categoria/livello negli esempi o **Solo preferite** nelle query salvate. L'indicatore sul pulsante segnala filtri attivi; **Azzera** li rimuove.

Seleziona una voce nell'elenco per leggere codice, valori e lezione nel pannello accanto. **Apri nell'editor**, **Inserisci al cursore**, **Spiega** e **Copia** preparano il lavoro senza eseguirlo. Puoi tornare al catalogo conservando selezione e filtri.

Gli esempi usano lo schema disponibile. Senza schema viene dichiarato il dataset dimostrativo e proposto il suo laboratorio; quelle tabelle non sono presentate come esistenti nella connessione.

In **Elementi query** scegli più colonne, una SELECT, clausole con parametri e operatori. Le funzioni avvolgono la selezione. Controlla l'anteprima e premi **Inserisci al cursore**. Le spiegazioni offline e i suggerimenti sugli errori sono deterministici, senza un modello AI.

## Catalogo PowerShell

Apri **Catalogo → Catalogo PowerShell**. I **52 modelli** coprono **File e cartelle**, **Diagnostica**, **Database**, **Docker** e **Ollama**, compresi percorsi espliciti di creazione e modifica su dati sintetici. Usa ricerca, categoria, motore e livello per trovare una voce; il dettaglio indica spiegazione, effetti, prerequisiti e documentazione. I modelli che scrivono supportano `-WhatIf`; l’app non li esegue.

1. Scegli lo script e leggi i prerequisiti.
2. Sostituisci percorsi, host, database e altri valori dimostrativi con quelli necessari. I campi vengono validati prima della generazione.
3. Leggi il codice nell'anteprima. **Copia** trasferisce il testo negli appunti; **Apri anteprima** lo porta al centro file, dove puoi rivederlo e salvarlo.
4. **Esporta .ps1**, oppure `Ctrl+S` nel catalogo, prepara il salvataggio di una copia. L'esportazione usa **UTF-8 con BOM**, necessario per leggere correttamente il testo Unicode in Windows PowerShell 5.1.
5. Se decidi di eseguire lo script, fallo esplicitamente nel terminale dopo aver controllato parametri e destinazione. Il catalogo e il centro file non lo eseguono.

Sono previsti **Windows PowerShell 5.1 o PowerShell 7 su Windows**. I comandi database richiedono la CLI appropriata (`sqlite3`, `psql`, `mysql`, `mariadb` o `mongosh`) e, per i server, una connessione configurata con permessi e certificato CA richiesti dalla voce. Le password vengono richieste dal client: non sono un campo da incorporare nel codice del catalogo.

Gli esempi Docker richiedono Docker e il relativo ambiente avviato; quelli Ollama interrogano il servizio locale configurato. Alcuni controlli diagnostici usano moduli Windows specifici. Il catalogo non installa questi strumenti e non deduce la disponibilità del server dal fatto che lo script sia stato generato. Le voci che creano file/cartelle dichiarano l'effetto e prevedono `-WhatIf` quando indicato; copiare uno script non simula la sua esecuzione.

## Disegnare e creare strutture

Apri **Designer database** e scegli il motore. Il progetto visuale è distinto dal database fisico.

1. **Campi e vincoli:** tabelle, colonne, tipi, PK, NULL, UNIQUE, identità e default.
2. **Relazioni grafiche:** trascina fra campi oppure fai clic prima sul connettore sorgente e poi su quello di destinazione.
3. **Script e creazione:** leggi lo script e controlla la connessione. **Solo strutture mancanti** prepara i nuovi oggetti; **Progetto completo** mostra tutto il progetto.
4. Dopo la revisione crea le strutture mancanti, aggiorna lo schema e apri **Dati tabella** per inserire record.

Il progetto si salva e riapre come JSON anche senza connessione. La presenza di un nome nel progetto non dimostra che l'oggetto esista già sul server.

Una FK singola richiede una destinazione singolarmente PK o UNIQUE completa. Indici parziali e parti non univoche di PK composte non bastano. La copia visuale di FK composte restituisce un errore per non perdere il vincolo: usa la definizione SQL originale.

Per una tabella esistente scegli **Modifica una struttura esistente** oppure **Carica schema esistente**. Modifica campi, indici o relazioni e scegli **Script → Modifiche al database**. Il piano elenca ciò che verrà applicato, controlla la copia di origine e richiede revisione della destinazione; rimozioni e ricostruzioni richiedono una conferma aggiuntiva. In PostgreSQL il designer opera nello schema **public**. Operazioni e metadati non rappresentabili vengono segnalati: non sono migrati perdendo vincoli. Ambito preciso e limiti sono in [VERSIONE-0.5.md](VERSIONE-0.5.md). **Espandi diagramma** apre le linee e i campi a schermo intero; il doppio clic su una linea ne propone la rimozione dal progetto.

## Dal disegno a query e codice

Dal designer passa a **Codice nel linguaggio**, oppure usa **Dati tabella → Genera lettura**.

Oltre a letture, modelli e progetti completi puoi scegliere **Funzioni CRUD da integrare** oppure **Funzione di creazione schema**. Il primo formato espone il modulo driver con operazione e payload espliciti; il secondo riceve la connessione della tua applicazione e contiene il DDL revisionato. Le funzioni schema supportano i dodici linguaggi per SQLite/PostgreSQL/MySQL/MariaDB; per MongoDB si usa lo schema JSON. La generazione non esegue il codice né gestisce credenziali della tua applicazione.

1. Scegli tabella e operazione: campi, chiave, filtri, JOIN, aggregazione o query dell'editor.
2. Configura colonne, valori, ordinamento e limite.
3. Scegli linguaggio e risultato, quindi genera.
4. Leggi i file prodotti. Se cambi una scelta, rigenera prima di copiarli o esportarli.
5. Esporta in una cartella nuova; aprila in VS Code e segui il README generato per dipendenze, ambiente ed esecuzione.

| Risultato               | Utilizzo                                                      |
| ----------------------- | ------------------------------------------------------------- |
| Codice di lettura       | Richiamare una lettura dalla propria applicazione.            |
| Funzione parametrizzata | Ricevere valori senza concatenarli alla query.                |
| Modello / classe / DTO  | Rappresentare dati di una o più tabelle, per tipi supportati. |
| Repository di lettura   | Organizzare le funzioni di accesso in lettura.                |
| Programma completo CRUD | Progetto autonomo con operazioni sui dati.                    |
| API REST CRUD           | Servizio locale nei framework supportati.                     |
| Script SQL / MongoDB    | Testo da revisionare nell'editor o nei propri file.           |

Linguaggi: Rust, Python, JavaScript, TypeScript, PHP, Java, C#, C, C++, Go, Kotlin e Ruby. API: Rust/Axum, Python/FastAPI, JavaScript/TypeScript/Fastify. I repository del nuovo workbench sono di lettura; per scrivere scegli programma CRUD o API.

L'app genera sorgenti e non li esegue automaticamente. Prima di eseguire codice generato da un disegno, crea le strutture e configura il database. Un tipo non supportato produce un errore, evitando conversioni silenziose.

## Import, export e backup

In **Import / Export** scegli ambito, formato e destinazione. Rivedi l'anteprima prima dell'importazione. Uno script SQL può cambiare struttura e dati e richiede la conferma dell'interfaccia.

CSV serve allo scambio tabellare e usa `\N` per NULL. Per conservare i tipi preferisci JSON tipizzato; MongoDB usa Extended JSON canonico. Controlla il limite di record per esportazioni CSV/JSON.

SQLite usa l'Online Backup API; gli altri motori richiedono i rispettivi strumenti nativi. Il ripristino controlla il pacchetto e la ricevuta SHA-256: verifica la destinazione e conserva una copia prima di sostituire dati.

## Ambienti e assistente facoltativo

**Ambienti locali** gestisce risorse registrate come proprie, Docker o native per utente. Arrestare conserva i dati; eliminare è un'altra operazione. I servizi Windows prevedono revisione del piano ed eventuale UAC; il collaudo SCM in VM pulita resta un limite dichiarato.

In **Impostazioni** configura Ollama o un endpoint HTTPS compatibile. Query, schema e righe sono scelte distinte; le righe sono escluse inizialmente. Le bozze si rivedono nell'editor. Consulta [PRIVACY.md](../PRIVACY.md) per contenuti, destinazioni e conservazione.

Le informazioni sul programma e i documenti legali sono consultabili offline nelle impostazioni. Nel repository trovi [autore](../AUTHORS.md), [licenza](../LICENSE), [note legali](../LEGAL.md) e [terze parti](../THIRD-PARTY-NOTICES.md).

## Risolvere problemi comuni

| Situazione                     | Controllo                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| Si apre la vecchia interfaccia | Chiudi le istanze precedenti prima della nuova versione.                                      |
| Connessione fallita            | Motore, host/porta, credenziali, TLS/CA e tunnel.                                             |
| Tabella assente                | Database attivo e aggiornamento dello schema.                                                 |
| Cella non modificabile         | PK, sola lettura e origine: JOIN e risultati liberi non sono righe direttamente aggiornabili. |
| Codice segnato come superato   | Rigenera dopo aver cambiato le scelte.                                                        |
| Tipo o FK non adottabile       | Leggi l'errore e conserva la definizione SQL esplicita del vincolo.                           |
| Esercizio non superato         | Controlla il risultato richiesto, non solo la sintassi.                                       |

[REPORT-0.5.1-20261110.md](REPORT-0.5.1-20261110.md) registra i test correnti, i quattro server reali di collaudo, i dodici linguaggi, le prove visive e il pacchetto. Le verifiche precedenti restano nei documenti 0.1–0.4; non sostituiscono quelle attuali. Il parsing PowerShell resta distinto dall’esecuzione degli script e non è dichiarata un’installazione in VM pulita.

[VERSIONE-0.3.md](VERSIONE-0.3.md) conserva le prove file/SQLite, codifiche, conflitti e importazione. [VERSIONE-0.2.md](VERSIONE-0.2.md) conserva i collaudi precedenti. Nella 0.5.1 sono stati verificati graficamente il selettore nativo di cartella e apertura/salvataggio UTF-16 con BOM; ciò non certifica ogni codifica alternativa o ogni dialogo degli strumenti esterni.
