# Copertura del codice applicativo 0.6.0

Ogni cella indica la generazione verificata delle funzioni per elenco, ricerca per chiave, inserimento, aggiornamento ed eliminazione. **G** indica che il pacchetto viene generato e contiene i sorgenti delle operazioni. **E** aggiunge una prova di esecuzione. In presenza di una tabella senza chiave, l’aggiornamento e l’eliminazione per chiave richiedono una destinazione con identità esplicita.

| Linguaggio | SQLite | PostgreSQL | MySQL | MariaDB | MongoDB |
| --- | --- | --- | --- | --- | --- |
| Rust | G + E | G | G | G | G |
| Python | G + E | G | G | G | G |
| JavaScript | G + E | G | G | G | G |
| TypeScript | G + E | G | G | G | G |
| PHP | G + E | G | G | G | G |
| Java | G + E | G | G | G | G |
| C# | G + E | G | G | G | G |
| C | G + E | G | G | G | G |
| C++ | G + E | G | G | G | G |
| Go | G + E | G | G | G | G |
| Kotlin | G + E | G | G | G | G |
| Ruby | G + E | G | G | G | G |

- **Frammenti copiabili.** In SQLite sono stati eseguiti una lettura e un aggiornamento parametrizzati per ognuno dei dodici linguaggi, chiamando i sorgenti generati. Il test Rust usa SQLx 0.9. Per Python sono state eseguite anche le quattro operazioni CRUD su un pacchetto multidatabase.
- **Schema.** Le funzioni di creazione SQL sono disponibili per i dodici linguaggi. Rust, Python, JavaScript e TypeScript dispongono anche della funzione per lo schema MongoDB. Schema e migrazioni sono esportabili come SQL o comandi JSON revisionabili.
- **Dati iniziali.** Il caricatore di seed incluso nel pacchetto è scritto in Python e usa il driver del motore della destinazione. È stato eseguito con dati sintetici su tutti e cinque i motori. Il pacchetto Python con due SQLite ha inizializzato due file vuoti con tabelle correlate e ha eseguito CRUD su destinazioni diverse.
- **Operazioni MongoDB.** I frammenti Python, JavaScript e TypeScript applicano i parametri al comando del progetto. Per gli altri linguaggi la funzione riceve dal chiamante un documento BSON già valorizzato. Usare i tipi nativi del driver quando contano precisione, data, ObjectId o ordine delle chiavi.
- **Migrazioni.** Un progetto con uno schema di origine contiene anche la baseline, la sua impronta, il piano revisionabile e le indicazioni per blocchi o ricostruzioni. Una ricostruzione SQLite con controlli sui vincoli e sulle sequenze si applica dal Designer. Una migrazione SQLite esportata e applicabile è stata eseguita conservando il record iniziale.
- **Prove precedenti.** Il [collaudo dei progetti CLI e REST](CODEGEN-VERIFICA.md) e il [rapporto del workbench](REPORT-WORKBENCH-20261117.md) descrivono verifiche eseguite sui template da cui derivano i moduli. Il [rapporto 0.6.0](REPORT-0.6.0.md) riporta le prove della versione attuale.
