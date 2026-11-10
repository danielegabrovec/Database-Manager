# Dati locali e servizi esterni

Database Manager funziona senza un account dell'applicazione. Non contiene un servizio di telemetria o analisi dell'utilizzo configurato dall'autore.

## Dati conservati sul computer

Profili di connessione, preferenze, query salvate, cronologia e metadati del workspace sono conservati nel database locale dell'applicazione. Le bozze e il progetto del designer utilizzano anche la memoria locale della WebView. Su Windows la directory predefinita del workspace è `%LOCALAPPDATA%\DatabaseManager`; un avvio di sviluppo può configurare `DBM_DATA_DIR`.

Password e chiavi dell'assistente sono conservate tramite il gestore credenziali del sistema dove previsto dall'applicazione. Query, cronologia, bozze, file esportati e altri contenuti locali possono comunque contenere dati riservati: il programma non promette la cifratura di tutti i file del workspace. Proteggere l'account Windows e le copie di sicurezza del computer.

Il centro file legge e analizza i documenti localmente, senza eseguire i programmi aperti. I recenti conservano percorso, nome, tipo, codifica e data di apertura; non una copia completa del sorgente. Gli script e i frammenti portati nelle schede query possono essere conservati come bozze nel workspace, insieme ai parametri e ai riferimenti al file. La scrittura sull'originale richiede un salvataggio esplicito e verifica la versione letta. I comandi Esplora risorse affidano al sistema operativo il percorso scelto per aprire una cartella o mostrare un file.

Dalla 0.5 anche il testo modificato nel centro file e gli script generati non ancora salvati hanno una copia di recupero locale. Questa copia può comprendere il testo originale e la bozza, percorso, codifica e fingerprint; viene conservata nel workspace e nella memoria della WebView entro i limiti dichiarati. Non viene inviata all’autore. Il salvataggio automatico della bozza non modifica il file originale. Le modifiche preparate nella griglia dei record richiedono invece Applica e non vengono recuperate dopo una chiusura.

## Connessioni e trasferimenti

- Quando ci si collega a un database, query e dati vengono scambiati con il server selezionato dall'utente. TLS e tunnel dipendono dal profilo e dagli strumenti configurati.
- L'assistente è facoltativo. Un modello Ollama locale riceve il contesto selezionato; un endpoint cloud riceve quel contesto via rete. Query, schema e righe sono controlli distinti; le righe sono inizialmente escluse. L'utente deve scegliere un servizio appropriato ai dati trattati e verificarne le condizioni.
- Il provisioning nativo scarica archivi dei motori dai fornitori indicati nel catalogo. Docker, gli strumenti di backup, VS Code e i programmi generati sono prodotti esterni, con propri comportamenti e condizioni.
- L'autore non riceve automaticamente database, cronologia o credenziali. La pubblicazione manuale di un allegato in un'issue GitHub rende l'allegato accessibile secondo la visibilità del repository.

## Gestione e rimozione

È possibile modificare i profili, scartare modifiche non inviate ed eliminare gli ambienti registrati come appartenenti all'applicazione. File esportati, backup, dati su server esterni e archivi del sistema operativo hanno cicli di vita propri. La disinstallazione non deve essere interpretata come cancellazione certificata di tutte queste copie.

Questa descrizione riguarda il funzionamento del programma; non sostituisce le informative del titolare dei database o dei servizi esterni usati dall'utente.

Ultimo aggiornamento: 10 novembre 2026.
