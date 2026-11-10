# Database Manager 0.4.0 — navigazione e cataloghi

Autore: **Daniele Gabrovec**. Condizioni d'uso in [LICENSE](../LICENSE) e [LEGAL.md](../LEGAL.md).

La 0.4 riordina l'accesso alle funzioni e aggiunge un catalogo di script PowerShell. Mantiene le funzioni di apertura file, SQLite, SQL, sorgenti e importazione della 0.3; i relativi risultati storici restano in [VERSIONE-0.3.md](VERSIONE-0.3.md). La pubblicazione della release 0.4 è in preparazione: questa pagina non dichiara già aggiornati gli asset pubblici.

## Navigazione

- Accessi diretti: **Apri file e database**, **Editor SQL / MongoDB**, **Laboratorio**.
- **Database:** Dati tabella, Struttura e relazioni, Designer database, Compositore query.
- **Catalogo:** esattamente **Catalogo PowerShell** e **Catalogo Query**.
- **Strumenti:** Generatore codice, Import / Export, Ambienti locali.

Un solo gruppo si espande alla volta. All'apertura su Apri file o Editor i gruppi sono chiusi; un clic su Catalogo ne espone le due sottovoci. Una vista interna ripristinata apre il gruppo corrispondente. Il menu supporta tastiera e attributi di accessibilità; le connessioni conservano un'area separata.

Il breadcrumb indica gruppo e vista. **Indietro** e `Alt+Freccia sinistra` percorrono la cronologia delle aree; `lastView` ricorda l'ultima vista valida. I cataloghi restano montati dopo il primo accesso, conservando ricerca, filtri, selezione e valori durante i passaggi della sessione. Questo non promette la persistenza completa di quei valori fra riavvii.

## Catalogo Query

Il titolo e le schede distinguono **Esempi**, **Query salvate** e **Cronologia**. Ricerca e motore restano visibili; il pulsante **Filtri** espone categoria/livello o preferiti e mostra il numero di filtri attivi. La vista concentra elenco e dettaglio nello spazio disponibile, con codice leggibile nello stesso pannello della lezione.

Le azioni Apri nell'editor, Inserisci al cursore, Spiega, Copia e gestione dei preferiti restano disponibili. Nessuna azione di consultazione esegue la query. Senza schema reale il dataset didattico è dichiarato come riferimento, senza presentarlo come schema della connessione.

## Catalogo PowerShell

**37 modelli** nelle categorie File e cartelle, Diagnostica, Database, Docker e Ollama, con ricerca e filtri per categoria, motore e livello. Le voci mostrano parametri, effetti, prerequisiti, spiegazioni e riferimenti ufficiali.

**Copia**, **Apri anteprima** ed **Esporta .ps1** preparano testo: il catalogo non invoca una shell e non esegue lo script. L'anteprima passa al centro file come bozza separata; l'esportazione usa **UTF-8 con BOM** per Windows PowerShell 5.1. I modelli prevedono Windows PowerShell 5.1 e PowerShell 7 su Windows; disponibilità delle CLI, certificati, rete e servizi resta un prerequisito distinto.

I comandi database richiedono il client appropriato. Le password vengono richieste dal client, non incorporate nello script. I valori iniziali sono sintetici e devono essere rivisti prima di un'esecuzione esplicita nel terminale. Le voci che creano file o cartelle dichiarano l'effetto e prevedono simulazione con `-WhatIf` dove indicato.

## Verifiche registrate

| Ambito              | Risultato e portata                                                                                                                                                                                            |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend 0.4        | **290 test superati**, inclusi modello di navigazione, cataloghi, parametri e gestione delle bozze.                                                                                                            |
| Sintassi PowerShell | Parser reali **Windows PowerShell 5.1** e **PowerShell 7**: **42 casi ciascuno**, cioè 37 modelli iniziali e 5 casi con valori particolari, **84 analisi sintattiche**. Non esecuzione dei corpi degli script. |
| Rust                | Ultima baseline completa dalla 0.3: **93 superati, 0 falliti, 10 ignorati**, cioè **76 unitari e 17 integrazioni**. Non presentata come nuovo run completo della 0.4.                                          |
| Nativo 0.4          | Eseguibile avviato; prova dedicata di **chiusura normale con workspace senza bozze** riuscita dopo il permesso Tauri di distruzione finestra.                                                                  |

I casi PowerShell verificano anche che valori con spazi, Unicode e caratteri di quoting rimangano dati nel testo generato. Non certificano connessioni o operazioni runtime sui cinque motori. La disponibilità di entrambi gli interpreti deve essere verificata quando si ripete il test su un'altra macchina.

Comandi riproducibili e toolchain sono in [SVILUPPO.md](SVILUPPO.md). L'avvio del processo non viene confuso con un walkthrough completo: il dialogo personalizzato per bozze non salvate, il selettore nativo di cartella e l'installer in VM pulita non sono ancora dichiarati provati graficamente. Le prove browser e native delle versioni precedenti conservano il proprio ambito.

## Limiti e distribuzione

- Distribuzione Windows x64, installer non firmato digitalmente; nessuna certificazione macOS, Linux o ARM.
- I cataloghi preparano codice; non installano CLI, non avviano server e non inventano credenziali o valori runtime.
- Restano i limiti documentati di estrazione statica, dimensioni file, designer senza ALTER automatici e configurazioni server da collaudare separatamente.
- [Guida utente](GUIDA-UTENTE.md), [Privacy](../PRIVACY.md) e condizioni legali restano parte della documentazione del prodotto.
