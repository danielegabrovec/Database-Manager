# Database Manager 0.5.0 — database esistenti, migrazioni e guida operativa

Autore: **Daniele Gabrovec**. Revisione del 10 novembre 2026. Condizioni in [LICENSE](../LICENSE), [LEGAL.md](../LEGAL.md), [Privacy](../PRIVACY.md).

Questa versione completa il lavoro locale 0.3/0.4 rimasto fuori dalla cronologia Git e aggiunge gestione delle modifiche strutturali, guida offline e funzioni applicative per la creazione dello schema.

## Database esistenti e designer

- Apertura di SQLite esistenti con firma verificata e modalità iniziale di sola lettura; nessuna creazione implicita da un percorso errato. Connessioni PostgreSQL, MySQL, MariaDB e MongoDB attraverso i rispettivi driver.
- **Designer → Modifica una struttura esistente** oppure **Carica schema esistente**. Campi, indici e relazioni sono modificati prima nella copia di progetto.
- **Script → Modifiche al database** mostra le singole operazioni, lo SQL/JSON e gli eventuali impedimenti. Rimozioni e ricostruzioni richiedono una conferma aggiuntiva del backup.
- Controllo dello schema effettivo prima dell’applicazione; una copia di progetto obsoleta non viene applicata come se fosse corrente. Dopo il piano lo schema viene riletto.
- SQLite: aggiunta/rinomina/rimozione di colonne nei casi compatibili, indici e ricostruzione delle tabelle semplici con una singola PK INTEGER. La ricostruzione conserva il mapping delle colonne, i vincoli supportati, i progressivi AUTOINCREMENT e verifica le FK prima del commit. Transazione con rollback in caso di errore.
- PostgreSQL: rinomina, nuove colonne, indici, nuove FK singole, tipi/default/nullabilità nei casi supportati. Applicazione in una transazione dedicata con timeout per attesa dei lock; rifiuto di una transazione dell’editor ancora aperta.
- MySQL/MariaDB: rinomina, nuove colonne, rimozioni compatibili, indici e nuove FK singole. I DDL possono avere commit impliciti: in caso di errore vengono dichiarati i passi già applicati e riletto lo schema.
- MongoDB: creazione di collezioni/indici e modifica esplicita del validatore. I documenti già presenti non vengono convertiti; non viene promesso un rollback globale.
- Diagramma ingrandibile a schermo intero, collegamenti tramite trascinamento o clic, rimozione dal progetto con doppio clic sulla linea e conferma.

Non viene promessa una migrazione automatica di qualunque schema. PK/identità, vincoli con nomi non disponibili, indici parziali/espressioni, FK composte e ricostruzioni SQLite con viste, trigger o vincoli non rappresentati richiedono una migrazione dedicata. Un blocco viene spiegato e non aggirato eliminando metadati. Per MySQL/MariaDB la ridefinizione di colonne esistenti richiede la definizione completa del server e revisione nell’editor.

## PowerShell e query spiegate

**Guida**, nella barra inferiore: **50 passi**, dieci per ciascuno dei cinque motori, e **77 esempi** complessivi nel prontuario. Include prerequisiti, creazione, apertura, CRUD, modifica della struttura, generazione applicativa, backup e verifica del ripristino. Ricerca per testo e filtro motore; SQL/JSON si possono aprire nell’editor senza esecuzione automatica.

La versione consultabile fuori dall’app è [Guida operativa PowerShell e query](GUIDA-OPERATIVA-POWERSHELL-QUERY.md), generata dallo stesso contenuto con:

```powershell
node scripts/export-operational-guide.mjs
```

Il **Catalogo PowerShell contiene 52 modelli**. Ai 37 precedenti si aggiungono 15 percorsi espliciti: creazione database/collezione, CRUD su tabelle/documenti sintetici e aggiunta di colonne/indici. I modelli che scrivono dichiarano l’effetto e supportano `-WhatIf`. La simulazione non certifica permessi o disponibilità del server. Nessuno script viene eseguito dall’app.

## Codice per applicazioni

- **Funzioni CRUD da integrare:** modulo driver con `execute` e operazioni list/insert/update/delete; payload e chiavi espliciti. Si basa sui template CRUD esistenti dei dodici linguaggi.
- **Funzione di creazione schema:** sorgenti per Rust, Python, JavaScript, TypeScript, PHP, Java, C#, C, C++, Go, Kotlin e Ruby, per SQLite, PostgreSQL, MySQL e MariaDB. Include SQL e istruzioni di integrazione. La connessione è fornita dall’applicazione; le credenziali non sono incorporate.
- Le funzioni schema interrompono al primo errore e non nascondono differenze con `IF NOT EXISTS`. Commit/rollback appartengono al chiamante; i formati che usano pool non promettono una transazione fra istruzioni.
- Per MongoDB lo schema viene esportato come JSON; il nuovo formato di funzione schema è limitato ai quattro motori SQL. Restano disponibili CRUD, modelli, letture e progetti MongoDB precedenti.

## Ripresa dopo interruzioni e interfaccia

Le bozze del centro file sono recuperabili anche dopo un’interruzione. Vengono mantenute baseline, codifica e fingerprint per rilevare modifiche esterne al successivo salvataggio. Le scritture automatiche sono ordinate; un salvataggio lento precedente non può superare quello più recente. Le copie backend proseguono anche durante digitazione continua e la barra indica l’esito. Gli errori non vengono più ignorati silenziosamente.

Le conferme di scarto/ripristino sono dialoghi interni con focus, navigazione da tastiera e gestione delle finestre sovrapposte. Menu scorrevole, area connessioni utilizzabile con gruppi aperti, contrasto migliorato, file leggibili e adattamento allo spazio disponibile. Il diagramma può essere aperto a schermo esteso.

Il recupero resta limitato: 24 schede query, 8 MiB di unità di stringa complessive per testo/baseline query, 64 KiB per i parametri di una scheda e 8 MiB complessivi di testo/baseline per la bozza del centro file. Errori o superamenti vengono indicati; salvare esplicitamente su file. L’autosalvataggio non promette la conservazione dell’ultimo tasto prima di un’interruzione elettrica né recupera le modifiche della griglia non applicate.

## Verifiche

Gli esiti aggiornati, le prove native e il pacchetto sono registrati in [REPORT-0.5.0-20261110.md](REPORT-0.5.0-20261110.md). Le verifiche delle versioni precedenti restano separate e non vengono riattribuite alla 0.5.

Distribuzione Windows x64, installer non firmato digitalmente. Non è dichiarata una nuova installazione in VM Windows pulita né la certificazione delle configurazioni TLS/SSH esterne.
