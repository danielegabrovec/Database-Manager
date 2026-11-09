# Guida utente — Database Manager 0.2.1

**Autore: Daniele Gabrovec.** Condizioni d'uso in [LICENSE](../LICENSE), informazioni sui dati in [PRIVACY.md](../PRIVACY.md).

Database Manager offre editor e strumenti visuali per SQLite, PostgreSQL, MySQL, MariaDB e MongoDB. La distribuzione disponibile è Windows x64. I compilatori e gli interpreti dei programmi esportati si installano separatamente.

## Installare e aprire

Scarica l'installer dalla [pagina dell'ultima release](https://github.com/danielegabrovec/Database-Manager/releases/latest). Se la release comprende anche l'eseguibile, puoi usare quello senza una procedura di installazione dell'app. È richiesto Microsoft Edge WebView2; il primo setup può richiedere la rete per il runtime.

Chiudi le versioni precedenti prima di aprire la nuova. È consentita una sola istanza: avviare un secondo eseguibile può riportare in primo piano quello già aperto, anche scegliendo un'altra cartella di lavoro.

Tema e modalità si cambiano nell'interfaccia: **Apprendimento personale**, **Studio e lavoro**, **Sviluppatori esperti**. La guida didattica e le funzioni principali non richiedono un account AI.

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

- **SQLite:** file del database.
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

| Comando                      | Azione                                             |
| ---------------------------- | -------------------------------------------------- |
| `Ctrl+Invio`                 | Esegue la porzione scelta.                         |
| `Ctrl+Spazio` o **Completa** | Mostra schema, alias, keyword e funzioni.          |
| `Ctrl+S`                     | Salva la query.                                    |
| `Ctrl+K`                     | Cerca nello spazio di lavoro.                      |
| **Interrompi**               | Richiede l'interruzione secondo motore e permessi. |

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

## Catalogo ed elementi query

**Catalogo query** distingue esempi, Salvate e Cronologia. Cerca per operazione, motore, categoria o livello. L'anteprima mostra codice, valori e lezione. **Apri**, **Inserisci**, **Spiega** e **Copia** preparano il lavoro senza eseguirlo.

Gli esempi usano lo schema disponibile. Senza schema viene dichiarato il dataset dimostrativo e proposto il suo laboratorio; quelle tabelle non sono presentate come esistenti nella connessione.

In **Elementi query** scegli più colonne, una SELECT, clausole con parametri e operatori. Le funzioni avvolgono la selezione. Controlla l'anteprima e premi **Inserisci al cursore**. Le spiegazioni offline e i suggerimenti sugli errori sono deterministici, senza un modello AI.

## Disegnare e creare strutture

Apri **Designer database** e scegli il motore. Il progetto visuale è distinto dal database fisico.

1. **Campi e vincoli:** tabelle, colonne, tipi, PK, NULL, UNIQUE, identità e default.
2. **Relazioni grafiche:** trascina fra campi oppure fai clic prima sul connettore sorgente e poi su quello di destinazione.
3. **Script e creazione:** leggi lo script e controlla la connessione. **Solo strutture mancanti** prepara i nuovi oggetti; **Progetto completo** mostra tutto il progetto.
4. Dopo la revisione crea le strutture mancanti, aggiorna lo schema e apri **Dati tabella** per inserire record.

Il progetto si salva e riapre come JSON anche senza connessione. La presenza di un nome nel progetto non dimostra che l'oggetto esista già sul server.

Una FK singola richiede una destinazione singolarmente PK o UNIQUE completa. Indici parziali e parti non univoche di PK composte non bastano. La copia visuale di FK composte restituisce un errore per non perdere il vincolo: usa la definizione SQL originale.

Il designer non applica ALTER automatici alle tabelle esistenti. In PostgreSQL crea nello schema **public**, dichiarato nel DDL. Per oggetti esistenti o altri schemi prepara una migrazione SQL revisionata nell'editor.

## Dal disegno a query e codice

Dal designer passa a **Codice nel linguaggio**, oppure usa **Dati tabella → Genera lettura**.

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

[VERSIONE-0.2.md](VERSIONE-0.2.md) descrive le verifiche della revisione funzionale. Il walkthrough recente è nel browser locale con backend Rust; non certifica la finestra nativa 0.2.1 su Windows pulito.
