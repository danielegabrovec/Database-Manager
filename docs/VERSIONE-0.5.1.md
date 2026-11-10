# Database Manager 0.5.1 — codifica coerente dopo annullamento

Autore: **Daniele Gabrovec**. Revisione del 10 novembre 2026.

Questa correzione riguarda il selettore della codifica nel centro **Apri file e database**. Con un file modificato, la scelta di un’altra codifica richiede di confermare lo scarto della bozza. Nella 0.5.0, annullando quel dialogo, il selettore mostrava comunque la nuova scelta mentre il documento conservava la codifica originale. Il problema è stato riprodotto nella finestra Windows reale con un file UTF-16 e una scelta Windows-1252 annullata.

La 0.5.1 aggiorna il selettore soltanto quando la rilettura del documento riesce. Annullamento ed errore di lettura mantengono la codifica effettiva e la bozza. Il salvataggio precedente usava già la codifica del documento: la correzione elimina l’incoerenza visiva, senza dichiarare una corruzione dei byte osservata.

Il collaudo nativo dei flussi file, cartelle, query, codifiche e chiusura è riuscito; la regressione è stata verificata nella build 0.5.1. Gli esiti osservati sono nel [report finale](REPORT-0.5.1-20261110.md). Funzionalità, ambito e limiti generali della serie restano in [VERSIONE-0.5.md](VERSIONE-0.5.md).

Verifiche eseguite sul sorgente 0.5.1: **306 test frontend superati** in 32 file e controllo TypeScript riuscito. L’inventario aggiornato delle dipendenze verifica **599 componenti e 897 testi legali**, senza testi installati mancanti. Questi esiti non certificano da soli l’installer o il completamento del walkthrough Windows.

Lo script di packaging ricava la cartella degli artefatti dalla versione del progetto. Il parametro `-ReportPath` consente di allegare il report condiviso senza creare copie di report per ciascuna patch.
