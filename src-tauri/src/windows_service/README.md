# Servizi Windows opzionali

Il modulo separa pianificazione in sola lettura, richiesta UAC dall’app desktop e helper elevato. Il bridge browser e i processi di test non possono richiedere elevazione. Nessun installer o servizio reale è stato eseguito durante i test di questo modulo.

## Flusso e proprietà

- `plan(app_root,id)` accetta soltanto UUID canonici presenti nel registro, con provider `native`, `initialized=true`, laboratorio disabilitato e marker `.dbm-owner` corrispondente. URL e SHA provengono esclusivamente da `bundled_distributions()`, mai dai valori modificabili del registro.
- `request_action` verifica il piano prima dell’arresto, ferma pulitamente l’istanza per la sola installazione e ricalcola il piano. L’helper riceve azione enumerata, radice sorgente, UUID, fingerprint e nonce; li rivalida dopo UAC.
- L’helper ricopia l’archivio in `%ProgramData%/DatabaseManager/Services/DBM-UUID`, ne verifica il SHA-256 prima dell’estrazione e non esegue runtime da AppData come amministratore. Gli eseguibili server vengono avviati esclusivamente dal Service Control Manager sotto `NT SERVICE\DBM-UUID`.
- Dati e directory vuote sono copiati a freddo senza eliminare gli originali. La sorgente è mantenuta aperta senza condivisione di scrittura/eliminazione; reparse point, junction, collegamenti simbolici e hard link sono rifiutati. Gli handle aperti sono usati per la copia, senza riaprire i file per nome.
- Runtime, configurazione e manifest hanno proprietario Administrators e DACL protetta; account non amministrativi hanno soltanto lettura/esecuzione. I dati nascono privati ad Administrators/SYSTEM e ricevono Modify soltanto per il SID del servizio. La directory dati non attraversa una fase accessibile a Builtin Users.
- `CreateServiceW` imposta direttamente l’account virtuale e l’avvio manuale. Non viene creato temporaneamente un servizio LocalSystem. Il manifest protetto e la descrizione SCM contengono UUID e hash del catalogo.
- Start, stop e remove verificano account, ImagePath, tipo servizio e marker SCM. Remove ricontrolla l’identità dopo lo stop e conserva runtime e dati. `reservation_exists` blocca il ritorno silenzioso alla vecchia copia AppData anche dopo la rimozione SCM.
- Una directory di migrazione preesistente o parziale non viene sovrascritta né adottata. La reinstallazione sui dati trattenuti richiede ancora una procedura esplicita di recupero; l’interfaccia presenta questo stato e non propone operazioni che ricopierebbero i dati vecchi.

Le sole azioni sono `install`, `start`, `stop`, `remove`. Non esiste un esecutore di comandi arbitrari. `ShellExecuteExW` e `CreateServiceW` richiedono stringhe Windows: il modulo le costruisce da vettori argv con quoting verificato, senza shell, espansione di variabili o ricerca su PATH.

## Configurazione dei motori

PostgreSQL usa l’entrypoint SCM `pg_ctl runservice` e una configurazione separata che punta alla nuova directory dati, con ascolto loopback e SCRAM. MySQL e MariaDB ricevono il file `--defaults-file` gestito e il nome del servizio. MongoDB usa `--service` e una configurazione generata, con autenticazione, keyfile protetto e replica set `dbm`.

La copia non riutilizza file di configurazione locali, `postmaster.pid`, `postmaster.opts` o override persistiti. Impostazioni personalizzate devono essere rivalutate prima della migrazione. Tablespace PostgreSQL e dati che dipendono da link esterni vengono rifiutati anziché copiati attraverso percorsi esterni.

## Verifiche effettuate e limiti

I test coprono piani senza effetti, catalogo statico contro registro alterato, provider/laboratorio/marker invalidi, UUID e azioni non ammesse, hash archivio, quoting, copia con directory vuote, rifiuto hard link e transizioni SCM simulate con verifica dell’identità prima della rimozione. I test SCM simulati non sostituiscono un collaudo Windows elevato.

Prima di certificare il sottosistema serve una VM Windows 11 pulita con consenso UAC: creazione e risoluzione dell’account virtuale, avvio/arresto pulito per ciascuno dei quattro runtime, riavvio del computer, annullamento UAC, stop con connessioni aperte, protezioni ACL viste da un secondo utente e rimozione che conserva i dati. **Questi test reali non sono stati eseguiti**, quindi `liveScmCertified` rimane `false`.

## Fonti primarie consultate

- [Microsoft: CreateServiceW e account virtuali](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-createservicew).
- [Microsoft: ShellExecuteExW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shellexecuteexw).
- [Microsoft: sicurezza dei servizi e diritti di accesso](https://learn.microsoft.com/en-us/windows/win32/services/service-security-and-access-rights).
- [PostgreSQL: pg_ctl su Windows](https://www.postgresql.org/docs/current/app-pg-ctl.html), [sorgente del wrapper SCM PostgreSQL 18](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/bin/pg_ctl/pg_ctl.c).
- [MySQL 8.4: servizi Windows, nomi e file di opzioni](https://dev.mysql.com/doc/refman/8.4/en/windows-start-service.html).
- [MariaDB: opzioni Windows di mariadbd](https://mariadb.com/docs/server/server-management/starting-and-stopping-mariadb/mariadbd-options).
- [MongoDB: entrypoint e costruzione argv del servizio](https://github.com/mongodb/mongo/blob/master/src/mongo/util/ntservice.cpp).
