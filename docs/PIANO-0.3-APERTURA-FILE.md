# Piano 0.3 — aprire file e database esistenti

Il punto di partenza è il problema d'uso: un file `.db`, uno script `.sql` e un programma contenente istruzioni database devono avere un ingresso riconoscibile nell'app, senza confondere apertura, collegamento ed esecuzione.

Autore del progetto: **Daniele Gabrovec**. Restano valide le condizioni in [LICENSE](../LICENSE) e le informazioni in [PRIVACY.md](../PRIVACY.md).

## Inventario dei divari

| Ambito precedente            | Divario concreto                                                                    | Risposta nella 0.3                                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Profilo SQLite con percorso  | Mancava un ingresso file immediato; l'estensione non prova che il file sia SQLite.  | Centro Apri file e database, selettore e percorso diretto, firma SQLite e metadati verificati prima del collegamento.      |
| Editor query e query salvate | Salva query non equivaleva a salvare il file SQL originale.                         | Anteprima/editor testuale con percorso, codifica e fingerprint; salvataggio esplicito sul file esistente.                  |
| Import/export SQL            | Aprire uno script era confondibile con importarlo o eseguirlo.                      | Anteprima senza esecuzione; azioni separate verso editor query e importazione guidata.                                     |
| File di programma            | Mancava una lettura statica delle istruzioni DB contenute nel sorgente.             | Elenco di query con righe d'origine, lingua, parametri non ricostruiti e distinzione letterale/parziale.                   |
| Navigazione dei file         | Nessun elenco unificato di file recenti e cartella né scelta grafica riconoscibile. | Selettore cartella visibile, Esplora file Windows, recenti persistenti, elenco paginato e ricerca sugli elementi caricati. |
| Apertura dal sistema         | I percorsi non erano collegati a una gestione coerente della bozza.                 | Integrazione Root di Ctrl+O, richieste di avvio, coda di percorsi e trascinamento nativo.                                  |

## Comportamento deciso

1. **SQLite esistente:** controllare esistenza, firma e apertura in lettura; non creare o inizializzare un database perché il percorso manca. La modalità iniziale è sola lettura, modificabile soltanto con una scelta esplicita.
2. **SQL:** leggere come testo, mostrare codifica e anteprima, consentire modifica/salvataggio espliciti. Apri nell'editor prepara una scheda query con il file originale completo; non esegue lo script. I dump con direttive dei client passano al percorso di importazione appropriato.
3. **Sorgente:** leggere e analizzare come testo, senza compilare, importare moduli o eseguire codice. Una query estratta resta una bozza con provenienza; salvare quella bozza non deve sovrascrivere il sorgente originale.
4. **Valori dinamici:** non inventare interpolazioni o binding. Le estrazioni parziali sono etichettate e possono essere aperte solo come bozze da completare.
5. **Scrittura del testo:** inviare la fingerprint del contenuto letto. Se il file cambia esternamente, conservare la bozza e rifiutare la sovrascrittura forzata; proporre copia/ricarica e revisione. **Salva come nel centro file** crea esclusivamente un nuovo file. **Salva con nome nell'editor query** può sostituire un testo esistente solo dopo consenso esplicito e controllo della versione della destinazione appena letta. Una query estratta non ha mai un binding di salvataggio al sorgente originale.
6. **Codifica:** riconoscere BOM/UTF-8 senza sostituzioni silenziose. Per altre codifiche richiedere una scelta. Il file del browser, privo di percorso nativo, resta un'anteprima in memoria con copia UTF-8.
7. **Cartella grafica:** mostrare **Scegli cartella…** accanto al percorso e supportare `Ctrl+Maiusc+O`. Separare il selettore nativo dall'elenco interno e dalle azioni **Apri in Esplora risorse / Mostra file nella cartella**. Nel browser dichiarare l'assenza del selettore Tauri.

## Interfacce e integrazione

`OpenFilesView` usa i comandi backend di ispezione, salvataggio testuale, directory e recenti. Il collegamento SQLite passa da `open_existing_sqlite`, che restituisce profilo, sessione e schema effettivi. La vista trasferisce quel risultato all'app invece di inventare una connessione dal solo nome del file.

`onOpenQuery` distingue script intero e testo estratto: lo script nativo ha percorso, codifica e fingerprint; l'estrazione ha `sourceOnly: true`, righe, confidenza e descrizioni dei parametri. Queste descrizioni non sono valori di esecuzione. La scheda della query estratta non è un file sorgente riscrivibile.

Per uno script già modificato nel centro file viene trasferito anche il contenuto originale come baseline: la bozza non deve apparire già salvata. Le notifiche di salvataggio fra schede ricaricano il file se non modificato; se è presente una bozza, la conservano e segnalano la nuova versione sul disco.

La vista conserva la bozza passando ad altre aree dell'app. Gli shortcut agiscono solo quando la vista è attiva; i controlli di chiusura ricevono lo stato dirty. L'editor della vista non contiene un comando di esecuzione.

## Criteri di accettazione

| Caso                                              | Risultato richiesto                                                                                             |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| SQLite valido con estensione `.db` o non standard | Metadati reali; apertura iniziale in sola lettura; nessun nuovo file creato.                                    |
| Percorso mancante, directory o firma non SQLite   | Errore comprensibile; nessun collegamento fittizio e nessuna creazione implicita.                               |
| Script SQL                                        | Anteprima e modifica; apertura nell'editor senza cambiare dati; salvataggio soltanto su azione esplicita.       |
| Modifica esterna dopo la lettura                  | Save rifiutato; bozza conservata; nessun force overwrite.                                                       |
| Salva con nome                                    | Centro file: nuovo percorso esclusivo. Editor query: sostituzione solo esplicita, con fingerprint aggiornata.   |
| UTF-8/BOM/UTF-16 e testo legacy                   | Decodifica dichiarata; scelta esplicita per codifica non riconosciuta; niente caratteri sostituiti in silenzio. |
| Programma con SQL letterale                       | Query, lingua e righe di origine disponibili; programma non eseguito.                                           |
| Programma con stringhe dinamiche                  | Avviso parziale, parametri non inventati e bozza non dichiarata pronta.                                         |
| Comando MongoDB statico                           | Bozza Extended JSON marcata MongoDB, senza esecuzione automatica.                                               |
| File scelto nel browser                           | Nessun percorso OS inventato; SQLite non collegabile senza percorso reale; copia testuale esplicitamente UTF-8. |
| Recenti e directory                               | Riapertura per percorso reale, rimozione del solo recente, ricerca/paginazione dichiarate.                      |
| Scelta cartella e apertura Windows                | Pulsante visibile e Ctrl+Maiusc+O per il selettore nativo; azioni separate per cartella e file in Esplora file. |
| Cambio vista e Ctrl+S                             | Bozza preservata; salvataggio contestuale e protezione contro perdita di modifiche.                             |
| Dump con direttive client                         | Nessuna esecuzione parziale del prefisso come query ordinaria; percorso di importazione separato.               |

## Confini e lavoro successivo

- Il database locale apribile come file è SQLite. File fisici di PostgreSQL/MySQL/MariaDB, Access o altri formati non diventano connessioni solo per l'estensione: per i server serve una connessione.
- L'estrazione è statica e limitata. Non ricostruisce ogni ORM, query builder, dipendenza fra file o valore prodotto a runtime; zero risultati non dimostra assenza di accessi DB nel programma.
- L'anteprima testuale è limitata a 8 MiB e l'analisi sorgente è ulteriormente limitata per dimensione/numero di operazioni. Gli script grandi richiedono il percorso di importazione, non un editor che finga di averli caricati integralmente.
- La ricerca di cartella riguarda gli elementi caricati, senza scansione ricorsiva dell'intero progetto.
- Conflitti testuali a tre vie, un IDE completo per ogni linguaggio, associazioni di sistema predefinite e formati database ulteriori restano lavori distinti. Non vengono dichiarati implementati da questa vista.

Questo documento definisce piano e accettazione. Gli esiti effettivi, compresa l'apertura osservata di Esplora file e la mancata prova grafica del selettore nativo, sono registrati separatamente in [VERSIONE-0.3.md](VERSIONE-0.3.md). Le prove UI 0.2 non certificano la 0.3.
