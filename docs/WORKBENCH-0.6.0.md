# Database Manager 0.6.0

## Dallo schema al programma

1. Apri **File → Progetto applicativo**. Assegna un nome al progetto e al primo database. Aggiungi un secondo database quando l’applicazione usa più destinazioni. Un alias identifica una connessione anche quando due database contengono una tabella con lo stesso nome.
2. In **Schema** disegna le tabelle e le relazioni con i connettori dei campi. Si possono importare anche un progetto precedente, DDL supportato e schemi esistenti. In **Operazioni** assegna un nome a ciascun grafo e scegli sorgente, filtri e risultato o scrittura.
3. In **Dati di prova** prepara le righe e scegli quelle da includere. **Prova progetto** crea lo schema, inserisce i dati ed esegue i grafi nell’ordine del progetto. Per SQLite la prova usa memoria isolata. Per i motori server serve un laboratorio gestito disponibile. L’esito indica la destinazione e il risultato di ogni passo.
4. In **Codice** scegli il linguaggio e genera il pacchetto. **Copia funzione** copia la funzione selezionata. **Copia SQL / MongoDB** copia il comando associato. Consulta i parametri e gli import del driver prima di chiamare la funzione. Se desideri distribuire dati iniziali, seleziona le righe e abilita la loro inclusione nell’esportazione.
5. **Esporta progetto** produce un pacchetto separato per il progetto, con cartelle per destinazione e tabella. Per integrare in un’app esistente, apri **Integra nell’app**, scegli la cartella, leggi le differenze, seleziona i file e conferma. Il confronto segnala modifiche manuali e nomi in conflitto. Ripetendo l’integrazione con gli stessi contenuti i file identici vengono riconosciuti.
6. Dopo aver modificato una funzione generata, apri **Aggiorna dal codice**. Seleziona la cartella del pacchetto che contiene `database-manager-project.json`, confronta i file e applica le modifiche al grafo. Il manifesto conserva gli identificatori e le impronte iniziali. La rilettura usa il testo presente su disco. In presenza di un sorgente dinamico o ambiguo, rivedi il file e le righe indicate. Per file esterni puoi anche usare l’estrazione statica di singole istruzioni.

### Esempio con due database SQLite

Crea `catalogo.clienti`, `catalogo.ordini` e `archivio.clienti`. Collega ogni ordine alla chiave del cliente. Inserisci nomi diversi nelle due tabelle clienti e crea una lettura filtrata per identificativo. Scegli Python e includi i dati di esempio. Dalla cartella del pacchetto puoi vedere gli alias effettivi e inizializzare ciascuna destinazione.

```powershell
python progetto.py elenco
python progetto.py inizializza 01-catalogo
python progetto.py inizializza 02-archivio
python progetto.py esegui 01-catalogo 01-clienti list
python progetto.py esegui 02-archivio 01-clienti list
```

Gli identificatori numerati dipendono dall’ordine nel progetto. Le variabili d’ambiente per le destinazioni sono in `destinazioni.json`. L’inizializzazione SQLite crea un nuovo file. Modifica il filtro nella funzione generata, rileggi il pacchetto e ripeti la prova del progetto per verificare l’effetto sui dati.

## Usare Ollama

Al primo avvio scegli avvio manuale o automatico. Puoi cambiare questa preferenza in **Impostazioni**. **Avvia/Spegni Ollama** controlla il servizio locale. In modalità automatica, uno spegnimento manuale sospende il riavvio automatico fino alla prossima apertura del programma. Un processo avviato dall’app termina con l’app. Per arrestare un servizio già attivo e condiviso, il controllo identifica il processo e chiede conferma.

La Home consente di scrivere una domanda generale e scegliere un modello locale adatto alla chat. La conversazione continua nel pannello destro. Usa **Interrompi risposta** per fermare la generazione. Le chat sono salvate sul PC e si possono riaprire, rinominare ed eliminare. Query rapide dispone di un contesto dedicato. I controlli accanto al messaggio indicano l’eventuale inclusione di query, schema o righe.

### Obiettivo con AI locale

Apri **AI → Obiettivo con AI locale** e descrivi il risultato in italiano. Puoi includere nomi e tipi del progetto aperto. Con **Solo suggerimenti** ottieni una proposta da esaminare. Con **Lettura e simulazione**, la conduzione assistita attende il comando di prova, mentre la conduzione autonoma convalida lo schema, costruisce il grafo, esegue le prove e prepara il pacchetto. Il resoconto registra i passi completati. Con **Modifiche reali**, seleziona la connessione, esamina la destinazione, il comando e i parametri. La scrittura sui record richiede conferma. Le proposte strutturali passano alla revisione nel Designer.

## Motori e linguaggi

| Funzione | Copertura |
| --- | --- |
| Progettazione e generazione CRUD | SQLite, PostgreSQL, MySQL, MariaDB e MongoDB. |
| Linguaggi del pacchetto | Rust, Python, JavaScript, TypeScript, PHP, Java, C#, C, C++, Go, Kotlin e Ruby. Le funzioni usano i driver indicati nel pacchetto. |
| Schema | SQL per i quattro motori relazionali, Extended JSON per MongoDB. Per MongoDB la funzione schema specifica è disponibile per Rust, Python, JavaScript e TypeScript. |
| Dati iniziali | Esportazione facoltativa con valori tipizzati. Il pacchetto indica come inizializzare ciascuna destinazione. |
| Conversione inversa | Schemi e operazioni rappresentabili. Un filtro o un parametro modificato viene confrontato con il progetto aperto. Costrutti avanzati, ORM e query determinabili solo durante l’esecuzione possono richiedere revisione manuale. |

Il caricatore Python dei dati iniziali è disponibile per tutti i motori anche nei pacchetti destinati ad altri linguaggi. Le dipendenze sono descritte nel pacchetto. Per le migrazioni, controlla la baseline, l’impronta e lo stato di applicabilità prima di copiare lo script revisionato.

Per ogni combinazione la generazione, la compilazione e l’esecuzione sono prove distinte. Consulta la [matrice di copertura](MATRICE-0.6.0.md) e il [rapporto 0.6.0](REPORT-0.6.0.md).
