# Database Manager 0.3.0 — apertura file e documenti

Autore: **Daniele Gabrovec**. Condizioni in [LICENSE](../LICENSE); nessuna modifica alle condizioni legali è implicata da questa revisione funzionale.

## Problema affrontato

La connessione tramite profilo e l'importazione SQL non offrivano un ingresso sufficientemente chiaro per file `.db`, script `.sql` e programmi contenenti istruzioni database. La 0.3 distingue apertura, collegamento, modifica del file, esecuzione della query e importazione.

Piano e accettazione: [PIANO-0.3-APERTURA-FILE.md](PIANO-0.3-APERTURA-FILE.md). Uso quotidiano: [GUIDA-UTENTE.md](GUIDA-UTENTE.md).

## Funzioni implementate

- **Apri file e database / Ctrl+O:** selettore, percorso fornito, file recenti, cartella con ricerca e paginazione. Richieste native e trascinamento passano a una coda, senza eseguire i file.
- **Cartella grafica:** **Scegli cartella… / Ctrl+Maiusc+O** usa il selettore nativo nell'app desktop. **Apri in Esplora risorse** e **Mostra file nella cartella** sono azioni separate verso Windows; il browser dichiara l'assenza del selettore Tauri.
- **SQLite esistente:** firma/metadati verificati, sola lettura iniziale nel centro file e modalità modificabile esplicita. Un percorso assente non crea un database vuoto. Nel profilo SQLite la scelta Crea nuovo abilita espressamente un percorso mancante.
- **SQL come documento:** anteprima/editing, schede separate, percorso/codifica/fingerprint, Salva, Salva con nome, Ricarica e guardie sulle bozze. Il file originale è distinto da Salva in libreria.
- **Sorgente con query:** analisi statica di forme comuni dei dodici linguaggi, righe di origine, confidenza letterale/parziale e parametri da fornire. Non vengono eseguiti programmi né inventati valori runtime.
- **Protezione del sorgente:** la query estratta si apre come bozza con provenienza, non come file di programma riscrivibile. Il salvataggio dello script intero usa il contenuto originale come baseline, anche quando viene trasferita una bozza modificata.
- **Concorrenza e codifica:** conflitti esterni conservano la bozza e bloccano l'overwrite non controllato; BOM/UTF-8, UTF-16 e Windows-1252 sono dichiarati. Niente sostituzione silenziosa di caratteri.
- **Salva con nome:** nel centro file crea soltanto un percorso nuovo; nell'editor query un testo esistente richiede consenso esplicito e controllo della fingerprint della destinazione appena letta.
- **Dump:** le direttive psql/COPY e MySQL DELIMITER/SOURCE usano il percorso di importazione compatibile, non il driver dell'editor. Comandi punto SQLite e GO SQL Server richiedono revisione e non aggiungono un nuovo motore supportato.

## Verifiche automatiche correnti

| Ambito                 | Esito registrato                        |
| ---------------------- | --------------------------------------- |
| Frontend completo      | **258 superati**                        |
| Rust unitari (`--lib`) | **76 superati**                         |
| Rust completo          | **93 superati, 0 falliti, 10 ignorati** |

Il totale Rust è composto da **76 unitari e 17 integrazioni**. I test opzionali dipendenti da server/ambienti dedicati rimangono distinti. I conteggi si riferiscono alla suite corrente eseguita durante l'integrazione della 0.3.

I test frontend coprono estrazione statica, scope e forme di stringa, parametri senza binding inventati, documenti/schede, confronto baseline, rilevazione direttive e decodifica del browser. I test Rust e workspace usano file temporanei per apertura, firma, codifiche, creazione esplicita, salvataggio e conflitti. Il successo di un test di generazione non viene trasformato in una certificazione di runtime del programma generato.

Comandi riproducibili:

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features --lib
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
```

## Collaudo grafico 0.3 osservato

Il collaudo usa il browser integrato locale con **backend Rust reale e fixture SQLite dedicate**. Le azioni seguenti sono state osservate nell'interfaccia; non equivalgono a un walkthrough dell'intera app Tauri o dell'installer.

| Percorso                 | Esito osservato                                                                                                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite esistente         | Firma valida, **2 tabelle e 1 vista** effettive; apertura in sola lettura e query con **3 righe**. Un falso `.db` è stato rifiutato; un percorso assente non è stato creato.                                                                                              |
| SQL come documento       | Apertura in una nuova scheda; esecuzione esplicita con **3 righe**. Modificare il testo non ha salvato automaticamente il file; **Salva** ha scritto la modifica richiesta.                                                                                               |
| Conflitto esterno        | Dopo una modifica del file da fuori dell'app, **Salva** è stato bloccato conservando la bozza. **Salva con nome** ha creato una copia con la bozza senza cambiare l'originale aggiornato esternamente.                                                                    |
| Sorgente Python          | Riconosciuta **1 query SQL alla riga 4**. I valori dei parametri erano inizialmente vuoti; dopo l'inserimento esplicito di `Udine`, la query ha restituito **1 riga**. Salvata una copia SQL separata; hash del programma originale invariato.                            |
| Sorgente dinamico        | Un'interpolazione TypeScript `${city}` è rimasta marcata **parziale**, senza inventarne il valore.                                                                                                                                                                        |
| Lettura delle codifiche  | UTF-16 con BOM riconosciuto automaticamente e testo `città — €` corretto. Windows-1252 ha richiesto una scelta esplicita e poi mostrato correttamente `città €`. **Scrittura GUI in queste codifiche non provata.**                                                       |
| Cartella ed Esplora file | Elenco interno di **13 file**. Il pulsante **Apri in Esplora risorse** ha aperto una nuova finestra reale di **Esplora file Windows**, osservata tra le finestre del sistema.                                                                                             |
| Importazione SQL         | Un file cambiato dopo l'anteprima è stato rifiutato prima del DDL, senza creare la tabella. Dopo una nuova anteprima e conferma nel dialogo dell'app, l'importazione ha inserito **1 riga** e aggiornato automaticamente la sidebar a **4 oggetti: 3 tabelle e 1 vista**. |

Il controllo API e la compilazione del **selettore nativo di cartella** sono riusciti; il dialogo non è stato provato graficamente. L'apertura osservata di Esplora file dal backend locale è una prova distinta. Il walkthrough non copre automaticamente ogni shortcut, il salvataggio di tutte le codifiche, la modalità SQLite modificabile o tutte le forme sorgente dei dodici linguaggi; per questi aspetti va rispettato l'ambito dei test automatici e dei collaudi successivi.

Le prove grafiche della 0.2 sono conservate in [VERSIONE-0.2.md](VERSIONE-0.2.md); non vengono usate come prova dell'interfaccia 0.3.

## Eseguibile e limiti

Dopo la chiusura normale della precedente 0.2.1 è stato avviato l'eseguibile desktop **0.3.0**, con finestra **Database Manager** rispondente. Sono stati verificati due percorsi nativi:

- Un file SQL con spazi nel percorso è stato passato come argomento al primo avvio. Il nuovo recente corrispondente conferma che il frontend Tauri ha consumato la richiesta e ispezionato il file.
- Un sorgente Python è stato passato a una seconda invocazione. Il processo secondario è terminato, quello principale è rimasto attivo e un nuovo recente conferma l'ispezione del sorgente nella stessa istanza.

Queste prove verificano **avvio nativo e inoltro dei file all'istanza singola**. Non costituiscono un walkthrough completo dell'interfaccia nativa, una prova grafica del selettore Tauri di cartella o un'installazione in VM pulita. Build, avvio del processo, ispezione di un file e walkthrough restano esiti diversi.

- Testo in anteprima fino a 8 MiB; analisi del centro file fino a 1.000.000 di caratteri e 200 operazioni. La ricerca di cartella riguarda le voci caricate, non un progetto scansionato ricorsivamente.
- Nel browser non viene inventato un percorso nativo dal nome del file. Senza percorso reale si offrono bozza e copia UTF-8, non collegamento SQLite o overwrite dell'originale.
- L'estrazione non interpreta completamente ogni ORM, query builder, dipendenza fra file o espressione dinamica. Letterale non equivale a semanticamente valido per il motore.
- La sola lettura non sostituisce i permessi del server. Le query vanno eseguite sulla connessione visibile e compatibile con SQL/MongoDB.
- Restano i limiti precedenti di designer PostgreSQL nello schema public, assenza di ALTER automatici e adozione visuale di FK composte, oltre a firma digitale e certificazioni esterne non dichiarate.
