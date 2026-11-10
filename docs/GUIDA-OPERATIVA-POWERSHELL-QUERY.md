# Guida operativa: PowerShell, database e query

Database Manager 0.5.0 · Daniele Gabrovec

La stessa guida è inclusa nell’app: pulsante **Guida** nella barra inferiore. Gli esempi usano esclusivamente dati sintetici. I client esterni e i server vanno predisposti separatamente; SQLite è incorporato nell’app.

Questo documento è generato da `src/help/guideContent.ts`; per aggiornarlo: `node scripts/export-operational-guide.mjs`.

## SQLite

### 1 · Prepara client e laboratorio

SQLite è incorporato nell’app; sqlite3.exe serve solo ai comandi esterni. Per PostgreSQL, MySQL, MariaDB e MongoDB serve un server attivo, locale o remoto, e il suo client. I client non vengono installati dal catalogo. Per i server configura TLS e CA come negli script parametrizzati del Catalogo PowerShell. Gli esempi localhost sono per un laboratorio locale già predisposto; non includono password.

```powershell
Get-Command sqlite3.exe
& sqlite3.exe --version
$PSVersionTable.PSVersion
```

### 2 · Crea un database nuovo

Usa nomi dedicati a questa prova. Se il database esiste già, passa all’apertura. Non incollare istruzioni SQL direttamente nel prompt PowerShell: inviale al client o usa l’editor dell’app.

```powershell
New-Item -ItemType Directory -Path 'C:\Dati\DBM-Laboratorio' -ErrorAction Stop
$dbPath = 'C:\Dati\DBM-Laboratorio\tutorial.sqlite'
if (Test-Path -LiteralPath $dbPath) { throw 'Il file esiste già: aprirlo o scegliere un nome nuovo.' }
# Il modello sqlite.create-new del catalogo usa anche una prenotazione esclusiva.
& sqlite3.exe -batch -bail (([System.Uri]$dbPath).AbsoluteUri + '?mode=rwc') 'PRAGMA user_version=0;'
if ($LASTEXITCODE -ne 0) { throw 'Creazione non riuscita' }
```

### 3 · Apri un database esistente nell’app

Apri file e database → scegli il file SQLite → controlla la firma e le tabelle → Apri database in sola lettura. Per modificare, apri esplicitamente una connessione modificabile. Un percorso errato non crea un database vuoto.

### 4 · Definisci le strutture

Esegui il seguente schema una sola volta nel database tutorial vuoto. Il designer permette anche di costruirlo con campi, chiavi e linee fra tabelle.

```sql
CREATE TABLE clienti (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE,
  citta VARCHAR(100)
);

CREATE TABLE ordini (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cliente_id INTEGER NOT NULL,
  totale DECIMAL(12,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (cliente_id) REFERENCES clienti(id)
);
```

### 5 · Inserisci dati sintetici

Usa soltanto il database tutorial. Questi nomi e indirizzi sono dimostrativi. Apri il codice nell’editor e rivedi la connessione prima di eseguire.

```sql
INSERT INTO clienti(id,nome,email,citta) VALUES
  (1,'Ada','ada@example.test','Udine'),
  (2,'Grace','grace@example.test','Trieste');
INSERT INTO ordini(id,cliente_id,totale) VALUES (1,1,25.50),(2,1,40.00),(3,2,18.00);
```

### 6 · Leggi e modifica i record

Dati tabella → seleziona la tabella → modifica celle o aggiungi record → controlla l’anteprima → Applica. Scarta annulla le modifiche preparate. Il sistema richiede una chiave stabile per modificare o eliminare righe. Il Prontuario qui accanto spiega i comandi equivalenti.

### 7 · Cambia la struttura graficamente

Designer database → Carica schema esistente → Campi e vincoli. Per una relazione trascina il punto del campo origine su quello della destinazione; il doppio clic sulla linea la rimuove dal progetto. Vai a Script → Modifiche al database: controlla ogni operazione, destinazione e impatto sui dati. Le ricostruzioni richiedono un backup e una conferma aggiuntiva. I blocchi del piano indicano metadati o operazioni da trattare con una migrazione dedicata.

### 8 · Genera codice per l’applicazione

Generatore codice → seleziona tabella, linguaggio e formato. Lettura/Funzione genera binding separati dai valori. Funzioni CRUD genera execute(list/insert/update/delete, payload). Programma completo aggiunge dipendenze e istruzioni. Funzione di creazione schema produce un modulo con una connessione fornita dall’applicazione, per i quattro motori SQL. Esporta in una cartella nuova e integra il sorgente; la generazione non lo esegue.

### 9 · Crea e verifica il backup

Chiudi o attendi le scritture in corso e scegli una destinazione nuova. La cartella deve esistere e i client devono poterci scrivere. I comandi qui sotto usano un laboratorio localhost; per server diversi adatta autenticazione e TLS. Verifica il ripristino su una copia distinta prima di considerare affidabile il backup.

```powershell
# Backup coerente, anche con WAL: usa .backup, non una copia del solo .db aperto.
& sqlite3.exe -readonly 'C:\Dati\DBM-Laboratorio\tutorial.sqlite' ".backup 'C:/Dati/DBM-Laboratorio/tutorial-backup.sqlite'"
if ($LASTEXITCODE -ne 0) { throw 'Backup non riuscito' }
# Apri la copia in sola lettura nell’app e controlla tabelle e righe.
```

### 10 · Personalizza PowerShell e salva il progetto

Catalogo → Catalogo PowerShell: scegli uno dei 52 modelli, imposta percorsi e parametri e leggi effetti e prerequisiti. Copia o Esporta .ps1. Per le scritture usa prima .\script.ps1 -WhatIf, poi avvialo esplicitamente senza -WhatIf solo quando hai verificato la destinazione. -WhatIf non interroga il database e non certifica che l’operazione riuscirà. Nel designer usa Salva progetto per conservare anche il disegno.

### Prontuario SQLite

Le query seguenti si riferiscono alle strutture e ai dati del tutorial precedente. Le operazioni di scrittura sono indicate espressamente; nel codice applicativo usare binding del driver per i valori.

#### SELECT · scegliere colonne

Restituisce solo i campi necessari. LIMIT limita il numero di righe; ORDER BY rende prevedibile l’ordinamento.

```sql
SELECT id, nome, email FROM clienti ORDER BY id LIMIT 20;
```

#### WHERE · filtrare righe

WHERE si applica prima dei raggruppamenti. Le parentesi rendono chiara la combinazione di AND e OR.

```sql
SELECT * FROM clienti WHERE citta = 'Udine' AND (nome LIKE 'A%' OR email IS NULL) ORDER BY nome;
```

#### DISTINCT e NULL

DISTINCT elimina duplicati nel risultato. Per valori mancanti usa IS NULL / IS NOT NULL, non = NULL.

```sql
SELECT DISTINCT citta FROM clienti WHERE citta IS NOT NULL ORDER BY citta;
```

#### INNER JOIN · collegare dati

Restituisce gli ordini con il loro cliente. Gli alias c e o distinguono campi con lo stesso nome.

```sql
SELECT c.nome, o.id AS ordine_id, o.totale
FROM clienti AS c
INNER JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY o.id;
```

#### LEFT JOIN · includere chi non ha ordini

Mantiene tutti i clienti anche se non ci sono righe corrispondenti in ordini. Le colonne dell’ordine mancante risultano NULL.

```sql
SELECT c.nome, o.id AS ordine_id
FROM clienti AS c
LEFT JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY c.id, o.id;
```

#### GROUP BY e HAVING

GROUP BY riunisce gli ordini per cliente. COUNT conta e SUM somma. HAVING filtra i gruppi dopo i calcoli.

```sql
SELECT c.id, c.nome, COUNT(o.id) AS numero_ordini, SUM(o.totale) AS spesa
FROM clienti c JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome
HAVING SUM(o.totale) > 30
ORDER BY spesa DESC;
```

#### EXISTS · verificare una relazione

La sottoquery verifica l’esistenza di almeno un ordine per il cliente. Non produce duplicati dovuti a ordini multipli.

```sql
SELECT c.id, c.nome FROM clienti c
WHERE EXISTS (SELECT 1 FROM ordini o WHERE o.cliente_id = c.id);
```

#### WITH · organizzare una query

Una CTE assegna un nome a un risultato intermedio e rende leggibile una query composta. Non crea una tabella permanente.

```sql
WITH spese AS (
  SELECT cliente_id, SUM(totale) AS spesa FROM ordini GROUP BY cliente_id
)
SELECT c.nome, s.spesa FROM clienti c JOIN spese s ON s.cliente_id = c.id;
```

#### Funzioni finestra · progressivi

SUM OVER calcola un totale progressivo mantenendo ogni singola riga. ROWS specifica esattamente l’intervallo del calcolo.

```sql
SELECT id, cliente_id, totale,
SUM(totale) OVER (PARTITION BY cliente_id ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS progressivo
FROM ordini ORDER BY cliente_id, id;
```

#### INSERT · aggiungere una riga

Dichiara sempre le colonne. L’ID è fornito qui per avere un esempio riproducibile; nelle applicazioni usa parametri e l’identità del motore. **Modifica struttura o dati.**

```sql
INSERT INTO clienti(id, nome, email, citta) VALUES (3, 'Katherine', 'katherine@example.test', 'Udine');
```

#### UPDATE · modificare per chiave

Prima controlla la riga con SELECT. Il WHERE identifica la chiave primaria; ometterlo modificherebbe tutte le righe. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 1;
UPDATE clienti SET citta = 'Udine' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
```

#### DELETE · eliminare per chiave

Controlla prima SELECT con lo stesso filtro. La cancellazione può essere impedita da relazioni; non disabilitare le chiavi esterne per aggirarla. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 3;
DELETE FROM clienti WHERE id = 3;
```

#### Transazioni · prova con rollback

BEGIN avvia il gruppo di operazioni. ROLLBACK annulla la prova. Usa COMMIT soltanto quando vuoi conservare le scritture. MySQL/MariaDB confermano molti DDL implicitamente. **Modifica struttura o dati.**

```sql
BEGIN;
UPDATE clienti SET citta = 'Città di prova' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
ROLLBACK;
```

#### ALTER TABLE · aggiungere una colonna

Aggiunge un campo senza eliminare righe. Si applica una sola volta. Per rinomina, tipi, vincoli o rimozioni usa il piano del designer e rivedi l’impatto sui dati. **Modifica struttura o dati.**

```sql
ALTER TABLE clienti ADD COLUMN telefono VARCHAR(30);
```

#### CREATE INDEX · migliorare le ricerche

L’indice può accelerare WHERE e JOIN, ma richiede spazio e manutenzione a ogni scrittura. Non aggiungere indici soltanto per abitudine. **Modifica struttura o dati.**

```sql
CREATE INDEX idx_clienti_citta ON clienti(citta);
```

#### EXPLAIN · leggere il piano

Mostra come il motore intende eseguire la query. L’esempio non usa ANALYZE, che in alcuni motori esegue davvero la query.

```sql
EXPLAIN QUERY PLAN SELECT * FROM clienti WHERE citta = 'Udine';
```

#### Vista · riusare una lettura

Una vista conserva una definizione di query. Le righe provengono dalle tabelle sottostanti; non è un backup. **Modifica struttura o dati.**

```sql
CREATE VIEW riepilogo_clienti AS
SELECT c.id, c.nome, COUNT(o.id) AS ordini
FROM clienti c LEFT JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome;
```

## PostgreSQL

### 1 · Prepara client e laboratorio

SQLite è incorporato nell’app; sqlite3.exe serve solo ai comandi esterni. Per PostgreSQL, MySQL, MariaDB e MongoDB serve un server attivo, locale o remoto, e il suo client. I client non vengono installati dal catalogo. Per i server configura TLS e CA come negli script parametrizzati del Catalogo PowerShell. Gli esempi localhost sono per un laboratorio locale già predisposto; non includono password.

```powershell
$PSVersionTable.PSVersion
# Controlla i client nel passo successivo.
```

### 2 · Crea un database nuovo

Usa nomi dedicati a questa prova. Se il database esiste già, passa all’apertura. Non incollare istruzioni SQL direttamente nel prompt PowerShell: inviale al client o usa l’editor dell’app.

```powershell
Get-Command psql.exe, pg_dump.exe, pg_restore.exe
& psql.exe -X -h localhost -U postgres -d postgres -W -v ON_ERROR_STOP=1 -c 'CREATE DATABASE dbm_tutorial;'
if ($LASTEXITCODE -ne 0) { throw 'Creazione non riuscita' }
& psql.exe -X -h localhost -U postgres -d dbm_tutorial -W
```

### 3 · Apri un database esistente nell’app

Nuova connessione → scegli il motore → host, porta, database e utente → configura TLS/CA e la password → Verifica connessione → Salva → Connetti. I file interni dei server non si aprono come se fossero file SQLite.

### 4 · Definisci le strutture

Esegui il seguente schema una sola volta nel database tutorial vuoto. Il designer permette anche di costruirlo con campi, chiavi e linee fra tabelle.

```sql
CREATE TABLE clienti (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE,
  citta VARCHAR(100)
);

CREATE TABLE ordini (
  id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cliente_id INTEGER NOT NULL,
  totale DECIMAL(12,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (cliente_id) REFERENCES clienti(id)
);
```

### 5 · Inserisci dati sintetici

Usa soltanto il database tutorial. Questi nomi e indirizzi sono dimostrativi. Apri il codice nell’editor e rivedi la connessione prima di eseguire.

```sql
INSERT INTO clienti(id,nome,email,citta) VALUES
  (1,'Ada','ada@example.test','Udine'),
  (2,'Grace','grace@example.test','Trieste');
INSERT INTO ordini(id,cliente_id,totale) VALUES (1,1,25.50),(2,1,40.00),(3,2,18.00);
SELECT setval(pg_get_serial_sequence('clienti','id'), (SELECT MAX(id) FROM clienti));
SELECT setval(pg_get_serial_sequence('ordini','id'), (SELECT MAX(id) FROM ordini));
```

### 6 · Leggi e modifica i record

Dati tabella → seleziona la tabella → modifica celle o aggiungi record → controlla l’anteprima → Applica. Scarta annulla le modifiche preparate. Il sistema richiede una chiave stabile per modificare o eliminare righe. Il Prontuario qui accanto spiega i comandi equivalenti.

### 7 · Cambia la struttura graficamente

Designer database → Carica schema esistente → Campi e vincoli. Per una relazione trascina il punto del campo origine su quello della destinazione; il doppio clic sulla linea la rimuove dal progetto. Vai a Script → Modifiche al database: controlla ogni operazione, destinazione e impatto sui dati. Le ricostruzioni richiedono un backup e una conferma aggiuntiva. I blocchi del piano indicano metadati o operazioni da trattare con una migrazione dedicata.

### 8 · Genera codice per l’applicazione

Generatore codice → seleziona tabella, linguaggio e formato. Lettura/Funzione genera binding separati dai valori. Funzioni CRUD genera execute(list/insert/update/delete, payload). Programma completo aggiunge dipendenze e istruzioni. Funzione di creazione schema produce un modulo con una connessione fornita dall’applicazione, per i quattro motori SQL. Esporta in una cartella nuova e integra il sorgente; la generazione non lo esegue.

### 9 · Crea e verifica il backup

Chiudi o attendi le scritture in corso e scegli una destinazione nuova. La cartella deve esistere e i client devono poterci scrivere. I comandi qui sotto usano un laboratorio localhost; per server diversi adatta autenticazione e TLS. Verifica il ripristino su una copia distinta prima di considerare affidabile il backup.

```powershell
& pg_dump.exe -h localhost -U postgres -W -d dbm_tutorial --format=custom --file='C:\Dati\dbm-tutorial.dump'
if ($LASTEXITCODE -ne 0) { throw 'Backup non riuscito' }
# Ripristina in un database VUOTO e distinto, già creato:
& pg_restore.exe -h localhost -U postgres -W -d dbm_tutorial_copia --exit-on-error 'C:\Dati\dbm-tutorial.dump'
```

### 10 · Personalizza PowerShell e salva il progetto

Catalogo → Catalogo PowerShell: scegli uno dei 52 modelli, imposta percorsi e parametri e leggi effetti e prerequisiti. Copia o Esporta .ps1. Per le scritture usa prima .\script.ps1 -WhatIf, poi avvialo esplicitamente senza -WhatIf solo quando hai verificato la destinazione. -WhatIf non interroga il database e non certifica che l’operazione riuscirà. Nel designer usa Salva progetto per conservare anche il disegno.

### Prontuario PostgreSQL

Le query seguenti si riferiscono alle strutture e ai dati del tutorial precedente. Le operazioni di scrittura sono indicate espressamente; nel codice applicativo usare binding del driver per i valori.

#### SELECT · scegliere colonne

Restituisce solo i campi necessari. LIMIT limita il numero di righe; ORDER BY rende prevedibile l’ordinamento.

```sql
SELECT id, nome, email FROM clienti ORDER BY id LIMIT 20;
```

#### WHERE · filtrare righe

WHERE si applica prima dei raggruppamenti. Le parentesi rendono chiara la combinazione di AND e OR.

```sql
SELECT * FROM clienti WHERE citta = 'Udine' AND (nome LIKE 'A%' OR email IS NULL) ORDER BY nome;
```

#### DISTINCT e NULL

DISTINCT elimina duplicati nel risultato. Per valori mancanti usa IS NULL / IS NOT NULL, non = NULL.

```sql
SELECT DISTINCT citta FROM clienti WHERE citta IS NOT NULL ORDER BY citta;
```

#### INNER JOIN · collegare dati

Restituisce gli ordini con il loro cliente. Gli alias c e o distinguono campi con lo stesso nome.

```sql
SELECT c.nome, o.id AS ordine_id, o.totale
FROM clienti AS c
INNER JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY o.id;
```

#### LEFT JOIN · includere chi non ha ordini

Mantiene tutti i clienti anche se non ci sono righe corrispondenti in ordini. Le colonne dell’ordine mancante risultano NULL.

```sql
SELECT c.nome, o.id AS ordine_id
FROM clienti AS c
LEFT JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY c.id, o.id;
```

#### GROUP BY e HAVING

GROUP BY riunisce gli ordini per cliente. COUNT conta e SUM somma. HAVING filtra i gruppi dopo i calcoli.

```sql
SELECT c.id, c.nome, COUNT(o.id) AS numero_ordini, SUM(o.totale) AS spesa
FROM clienti c JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome
HAVING SUM(o.totale) > 30
ORDER BY spesa DESC;
```

#### EXISTS · verificare una relazione

La sottoquery verifica l’esistenza di almeno un ordine per il cliente. Non produce duplicati dovuti a ordini multipli.

```sql
SELECT c.id, c.nome FROM clienti c
WHERE EXISTS (SELECT 1 FROM ordini o WHERE o.cliente_id = c.id);
```

#### WITH · organizzare una query

Una CTE assegna un nome a un risultato intermedio e rende leggibile una query composta. Non crea una tabella permanente.

```sql
WITH spese AS (
  SELECT cliente_id, SUM(totale) AS spesa FROM ordini GROUP BY cliente_id
)
SELECT c.nome, s.spesa FROM clienti c JOIN spese s ON s.cliente_id = c.id;
```

#### Funzioni finestra · progressivi

SUM OVER calcola un totale progressivo mantenendo ogni singola riga. ROWS specifica esattamente l’intervallo del calcolo.

```sql
SELECT id, cliente_id, totale,
SUM(totale) OVER (PARTITION BY cliente_id ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS progressivo
FROM ordini ORDER BY cliente_id, id;
```

#### INSERT · aggiungere una riga

Dichiara sempre le colonne. L’ID è fornito qui per avere un esempio riproducibile; nelle applicazioni usa parametri e l’identità del motore. **Modifica struttura o dati.**

```sql
INSERT INTO clienti(id, nome, email, citta) VALUES (3, 'Katherine', 'katherine@example.test', 'Udine');
```

#### UPDATE · modificare per chiave

Prima controlla la riga con SELECT. Il WHERE identifica la chiave primaria; ometterlo modificherebbe tutte le righe. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 1;
UPDATE clienti SET citta = 'Udine' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
```

#### DELETE · eliminare per chiave

Controlla prima SELECT con lo stesso filtro. La cancellazione può essere impedita da relazioni; non disabilitare le chiavi esterne per aggirarla. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 3;
DELETE FROM clienti WHERE id = 3;
```

#### Transazioni · prova con rollback

BEGIN avvia il gruppo di operazioni. ROLLBACK annulla la prova. Usa COMMIT soltanto quando vuoi conservare le scritture. MySQL/MariaDB confermano molti DDL implicitamente. **Modifica struttura o dati.**

```sql
BEGIN;
UPDATE clienti SET citta = 'Città di prova' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
ROLLBACK;
```

#### ALTER TABLE · aggiungere una colonna

Aggiunge un campo senza eliminare righe. Si applica una sola volta. Per rinomina, tipi, vincoli o rimozioni usa il piano del designer e rivedi l’impatto sui dati. **Modifica struttura o dati.**

```sql
ALTER TABLE clienti ADD COLUMN telefono VARCHAR(30);
```

#### CREATE INDEX · migliorare le ricerche

L’indice può accelerare WHERE e JOIN, ma richiede spazio e manutenzione a ogni scrittura. Non aggiungere indici soltanto per abitudine. **Modifica struttura o dati.**

```sql
CREATE INDEX idx_clienti_citta ON clienti(citta);
```

#### EXPLAIN · leggere il piano

Mostra come il motore intende eseguire la query. L’esempio non usa ANALYZE, che in alcuni motori esegue davvero la query.

```sql
EXPLAIN SELECT * FROM clienti WHERE citta = 'Udine';
```

#### Vista · riusare una lettura

Una vista conserva una definizione di query. Le righe provengono dalle tabelle sottostanti; non è un backup. **Modifica struttura o dati.**

```sql
CREATE VIEW riepilogo_clienti AS
SELECT c.id, c.nome, COUNT(o.id) AS ordini
FROM clienti c LEFT JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome;
```

## MySQL

### 1 · Prepara client e laboratorio

SQLite è incorporato nell’app; sqlite3.exe serve solo ai comandi esterni. Per PostgreSQL, MySQL, MariaDB e MongoDB serve un server attivo, locale o remoto, e il suo client. I client non vengono installati dal catalogo. Per i server configura TLS e CA come negli script parametrizzati del Catalogo PowerShell. Gli esempi localhost sono per un laboratorio locale già predisposto; non includono password.

```powershell
$PSVersionTable.PSVersion
# Controlla i client nel passo successivo.
```

### 2 · Crea un database nuovo

Usa nomi dedicati a questa prova. Se il database esiste già, passa all’apertura. Non incollare istruzioni SQL direttamente nel prompt PowerShell: inviale al client o usa l’editor dell’app.

```powershell
Get-Command mysql.exe, mysqldump.exe
& mysql.exe --no-defaults --host=localhost --user=root --password --execute='CREATE DATABASE dbm_tutorial CHARACTER SET utf8mb4;'
if ($LASTEXITCODE -ne 0) { throw 'Creazione non riuscita' }
& mysql.exe --no-defaults --host=localhost --user=root --password --database=dbm_tutorial
```

### 3 · Apri un database esistente nell’app

Nuova connessione → scegli il motore → host, porta, database e utente → configura TLS/CA e la password → Verifica connessione → Salva → Connetti. I file interni dei server non si aprono come se fossero file SQLite.

### 4 · Definisci le strutture

Esegui il seguente schema una sola volta nel database tutorial vuoto. Il designer permette anche di costruirlo con campi, chiavi e linee fra tabelle.

```sql
CREATE TABLE clienti (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE,
  citta VARCHAR(100)
);

CREATE TABLE ordini (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  cliente_id INTEGER NOT NULL,
  totale DECIMAL(12,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (cliente_id) REFERENCES clienti(id)
);
```

### 5 · Inserisci dati sintetici

Usa soltanto il database tutorial. Questi nomi e indirizzi sono dimostrativi. Apri il codice nell’editor e rivedi la connessione prima di eseguire.

```sql
INSERT INTO clienti(id,nome,email,citta) VALUES
  (1,'Ada','ada@example.test','Udine'),
  (2,'Grace','grace@example.test','Trieste');
INSERT INTO ordini(id,cliente_id,totale) VALUES (1,1,25.50),(2,1,40.00),(3,2,18.00);
```

### 6 · Leggi e modifica i record

Dati tabella → seleziona la tabella → modifica celle o aggiungi record → controlla l’anteprima → Applica. Scarta annulla le modifiche preparate. Il sistema richiede una chiave stabile per modificare o eliminare righe. Il Prontuario qui accanto spiega i comandi equivalenti.

### 7 · Cambia la struttura graficamente

Designer database → Carica schema esistente → Campi e vincoli. Per una relazione trascina il punto del campo origine su quello della destinazione; il doppio clic sulla linea la rimuove dal progetto. Vai a Script → Modifiche al database: controlla ogni operazione, destinazione e impatto sui dati. Le ricostruzioni richiedono un backup e una conferma aggiuntiva. I blocchi del piano indicano metadati o operazioni da trattare con una migrazione dedicata.

### 8 · Genera codice per l’applicazione

Generatore codice → seleziona tabella, linguaggio e formato. Lettura/Funzione genera binding separati dai valori. Funzioni CRUD genera execute(list/insert/update/delete, payload). Programma completo aggiunge dipendenze e istruzioni. Funzione di creazione schema produce un modulo con una connessione fornita dall’applicazione, per i quattro motori SQL. Esporta in una cartella nuova e integra il sorgente; la generazione non lo esegue.

### 9 · Crea e verifica il backup

Chiudi o attendi le scritture in corso e scegli una destinazione nuova. La cartella deve esistere e i client devono poterci scrivere. I comandi qui sotto usano un laboratorio localhost; per server diversi adatta autenticazione e TLS. Verifica il ripristino su una copia distinta prima di considerare affidabile il backup.

```powershell
& mysqldump.exe --host=localhost --user=root --password --single-transaction --result-file='C:\Dati\dbm-tutorial.sql' dbm_tutorial
if ($LASTEXITCODE -ne 0) { throw 'Backup non riuscito' }
# Su un database VUOTO già creato, nella shell mysql:
# SOURCE C:/Dati/dbm-tutorial.sql;
# Non usare la redirezione < di cmd.exe come se fosse un comando PowerShell.
```

### 10 · Personalizza PowerShell e salva il progetto

Catalogo → Catalogo PowerShell: scegli uno dei 52 modelli, imposta percorsi e parametri e leggi effetti e prerequisiti. Copia o Esporta .ps1. Per le scritture usa prima .\script.ps1 -WhatIf, poi avvialo esplicitamente senza -WhatIf solo quando hai verificato la destinazione. -WhatIf non interroga il database e non certifica che l’operazione riuscirà. Nel designer usa Salva progetto per conservare anche il disegno.

### Prontuario MySQL

Le query seguenti si riferiscono alle strutture e ai dati del tutorial precedente. Le operazioni di scrittura sono indicate espressamente; nel codice applicativo usare binding del driver per i valori.

#### SELECT · scegliere colonne

Restituisce solo i campi necessari. LIMIT limita il numero di righe; ORDER BY rende prevedibile l’ordinamento.

```sql
SELECT id, nome, email FROM clienti ORDER BY id LIMIT 20;
```

#### WHERE · filtrare righe

WHERE si applica prima dei raggruppamenti. Le parentesi rendono chiara la combinazione di AND e OR.

```sql
SELECT * FROM clienti WHERE citta = 'Udine' AND (nome LIKE 'A%' OR email IS NULL) ORDER BY nome;
```

#### DISTINCT e NULL

DISTINCT elimina duplicati nel risultato. Per valori mancanti usa IS NULL / IS NOT NULL, non = NULL.

```sql
SELECT DISTINCT citta FROM clienti WHERE citta IS NOT NULL ORDER BY citta;
```

#### INNER JOIN · collegare dati

Restituisce gli ordini con il loro cliente. Gli alias c e o distinguono campi con lo stesso nome.

```sql
SELECT c.nome, o.id AS ordine_id, o.totale
FROM clienti AS c
INNER JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY o.id;
```

#### LEFT JOIN · includere chi non ha ordini

Mantiene tutti i clienti anche se non ci sono righe corrispondenti in ordini. Le colonne dell’ordine mancante risultano NULL.

```sql
SELECT c.nome, o.id AS ordine_id
FROM clienti AS c
LEFT JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY c.id, o.id;
```

#### GROUP BY e HAVING

GROUP BY riunisce gli ordini per cliente. COUNT conta e SUM somma. HAVING filtra i gruppi dopo i calcoli.

```sql
SELECT c.id, c.nome, COUNT(o.id) AS numero_ordini, SUM(o.totale) AS spesa
FROM clienti c JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome
HAVING SUM(o.totale) > 30
ORDER BY spesa DESC;
```

#### EXISTS · verificare una relazione

La sottoquery verifica l’esistenza di almeno un ordine per il cliente. Non produce duplicati dovuti a ordini multipli.

```sql
SELECT c.id, c.nome FROM clienti c
WHERE EXISTS (SELECT 1 FROM ordini o WHERE o.cliente_id = c.id);
```

#### WITH · organizzare una query

Una CTE assegna un nome a un risultato intermedio e rende leggibile una query composta. Non crea una tabella permanente.

```sql
WITH spese AS (
  SELECT cliente_id, SUM(totale) AS spesa FROM ordini GROUP BY cliente_id
)
SELECT c.nome, s.spesa FROM clienti c JOIN spese s ON s.cliente_id = c.id;
```

#### Funzioni finestra · progressivi

SUM OVER calcola un totale progressivo mantenendo ogni singola riga. ROWS specifica esattamente l’intervallo del calcolo.

```sql
SELECT id, cliente_id, totale,
SUM(totale) OVER (PARTITION BY cliente_id ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS progressivo
FROM ordini ORDER BY cliente_id, id;
```

#### INSERT · aggiungere una riga

Dichiara sempre le colonne. L’ID è fornito qui per avere un esempio riproducibile; nelle applicazioni usa parametri e l’identità del motore. **Modifica struttura o dati.**

```sql
INSERT INTO clienti(id, nome, email, citta) VALUES (3, 'Katherine', 'katherine@example.test', 'Udine');
```

#### UPDATE · modificare per chiave

Prima controlla la riga con SELECT. Il WHERE identifica la chiave primaria; ometterlo modificherebbe tutte le righe. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 1;
UPDATE clienti SET citta = 'Udine' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
```

#### DELETE · eliminare per chiave

Controlla prima SELECT con lo stesso filtro. La cancellazione può essere impedita da relazioni; non disabilitare le chiavi esterne per aggirarla. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 3;
DELETE FROM clienti WHERE id = 3;
```

#### Transazioni · prova con rollback

BEGIN avvia il gruppo di operazioni. ROLLBACK annulla la prova. Usa COMMIT soltanto quando vuoi conservare le scritture. MySQL/MariaDB confermano molti DDL implicitamente. **Modifica struttura o dati.**

```sql
BEGIN;
UPDATE clienti SET citta = 'Città di prova' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
ROLLBACK;
```

#### ALTER TABLE · aggiungere una colonna

Aggiunge un campo senza eliminare righe. Si applica una sola volta. Per rinomina, tipi, vincoli o rimozioni usa il piano del designer e rivedi l’impatto sui dati. **Modifica struttura o dati.**

```sql
ALTER TABLE clienti ADD COLUMN telefono VARCHAR(30);
```

#### CREATE INDEX · migliorare le ricerche

L’indice può accelerare WHERE e JOIN, ma richiede spazio e manutenzione a ogni scrittura. Non aggiungere indici soltanto per abitudine. **Modifica struttura o dati.**

```sql
CREATE INDEX idx_clienti_citta ON clienti(citta);
```

#### EXPLAIN · leggere il piano

Mostra come il motore intende eseguire la query. L’esempio non usa ANALYZE, che in alcuni motori esegue davvero la query.

```sql
EXPLAIN SELECT * FROM clienti WHERE citta = 'Udine';
```

#### Vista · riusare una lettura

Una vista conserva una definizione di query. Le righe provengono dalle tabelle sottostanti; non è un backup. **Modifica struttura o dati.**

```sql
CREATE VIEW riepilogo_clienti AS
SELECT c.id, c.nome, COUNT(o.id) AS ordini
FROM clienti c LEFT JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome;
```

## MariaDB

### 1 · Prepara client e laboratorio

SQLite è incorporato nell’app; sqlite3.exe serve solo ai comandi esterni. Per PostgreSQL, MySQL, MariaDB e MongoDB serve un server attivo, locale o remoto, e il suo client. I client non vengono installati dal catalogo. Per i server configura TLS e CA come negli script parametrizzati del Catalogo PowerShell. Gli esempi localhost sono per un laboratorio locale già predisposto; non includono password.

```powershell
$PSVersionTable.PSVersion
# Controlla i client nel passo successivo.
```

### 2 · Crea un database nuovo

Usa nomi dedicati a questa prova. Se il database esiste già, passa all’apertura. Non incollare istruzioni SQL direttamente nel prompt PowerShell: inviale al client o usa l’editor dell’app.

```powershell
Get-Command mariadb.exe, mariadb-dump.exe
& mariadb.exe --no-defaults --host=localhost --user=root --password --execute='CREATE DATABASE dbm_tutorial CHARACTER SET utf8mb4;'
if ($LASTEXITCODE -ne 0) { throw 'Creazione non riuscita' }
& mariadb.exe --no-defaults --host=localhost --user=root --password --database=dbm_tutorial
```

### 3 · Apri un database esistente nell’app

Nuova connessione → scegli il motore → host, porta, database e utente → configura TLS/CA e la password → Verifica connessione → Salva → Connetti. I file interni dei server non si aprono come se fossero file SQLite.

### 4 · Definisci le strutture

Esegui il seguente schema una sola volta nel database tutorial vuoto. Il designer permette anche di costruirlo con campi, chiavi e linee fra tabelle.

```sql
CREATE TABLE clienti (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  nome VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE,
  citta VARCHAR(100)
);

CREATE TABLE ordini (
  id INTEGER AUTO_INCREMENT PRIMARY KEY,
  cliente_id INTEGER NOT NULL,
  totale DECIMAL(12,2) NOT NULL DEFAULT 0,
  FOREIGN KEY (cliente_id) REFERENCES clienti(id)
);
```

### 5 · Inserisci dati sintetici

Usa soltanto il database tutorial. Questi nomi e indirizzi sono dimostrativi. Apri il codice nell’editor e rivedi la connessione prima di eseguire.

```sql
INSERT INTO clienti(id,nome,email,citta) VALUES
  (1,'Ada','ada@example.test','Udine'),
  (2,'Grace','grace@example.test','Trieste');
INSERT INTO ordini(id,cliente_id,totale) VALUES (1,1,25.50),(2,1,40.00),(3,2,18.00);
```

### 6 · Leggi e modifica i record

Dati tabella → seleziona la tabella → modifica celle o aggiungi record → controlla l’anteprima → Applica. Scarta annulla le modifiche preparate. Il sistema richiede una chiave stabile per modificare o eliminare righe. Il Prontuario qui accanto spiega i comandi equivalenti.

### 7 · Cambia la struttura graficamente

Designer database → Carica schema esistente → Campi e vincoli. Per una relazione trascina il punto del campo origine su quello della destinazione; il doppio clic sulla linea la rimuove dal progetto. Vai a Script → Modifiche al database: controlla ogni operazione, destinazione e impatto sui dati. Le ricostruzioni richiedono un backup e una conferma aggiuntiva. I blocchi del piano indicano metadati o operazioni da trattare con una migrazione dedicata.

### 8 · Genera codice per l’applicazione

Generatore codice → seleziona tabella, linguaggio e formato. Lettura/Funzione genera binding separati dai valori. Funzioni CRUD genera execute(list/insert/update/delete, payload). Programma completo aggiunge dipendenze e istruzioni. Funzione di creazione schema produce un modulo con una connessione fornita dall’applicazione, per i quattro motori SQL. Esporta in una cartella nuova e integra il sorgente; la generazione non lo esegue.

### 9 · Crea e verifica il backup

Chiudi o attendi le scritture in corso e scegli una destinazione nuova. La cartella deve esistere e i client devono poterci scrivere. I comandi qui sotto usano un laboratorio localhost; per server diversi adatta autenticazione e TLS. Verifica il ripristino su una copia distinta prima di considerare affidabile il backup.

```powershell
& mariadb-dump.exe --host=localhost --user=root --password --single-transaction --result-file='C:\Dati\dbm-tutorial.sql' dbm_tutorial
if ($LASTEXITCODE -ne 0) { throw 'Backup non riuscito' }
# Su un database VUOTO già creato, nella shell mariadb:
# SOURCE C:/Dati/dbm-tutorial.sql;
```

### 10 · Personalizza PowerShell e salva il progetto

Catalogo → Catalogo PowerShell: scegli uno dei 52 modelli, imposta percorsi e parametri e leggi effetti e prerequisiti. Copia o Esporta .ps1. Per le scritture usa prima .\script.ps1 -WhatIf, poi avvialo esplicitamente senza -WhatIf solo quando hai verificato la destinazione. -WhatIf non interroga il database e non certifica che l’operazione riuscirà. Nel designer usa Salva progetto per conservare anche il disegno.

### Prontuario MariaDB

Le query seguenti si riferiscono alle strutture e ai dati del tutorial precedente. Le operazioni di scrittura sono indicate espressamente; nel codice applicativo usare binding del driver per i valori.

#### SELECT · scegliere colonne

Restituisce solo i campi necessari. LIMIT limita il numero di righe; ORDER BY rende prevedibile l’ordinamento.

```sql
SELECT id, nome, email FROM clienti ORDER BY id LIMIT 20;
```

#### WHERE · filtrare righe

WHERE si applica prima dei raggruppamenti. Le parentesi rendono chiara la combinazione di AND e OR.

```sql
SELECT * FROM clienti WHERE citta = 'Udine' AND (nome LIKE 'A%' OR email IS NULL) ORDER BY nome;
```

#### DISTINCT e NULL

DISTINCT elimina duplicati nel risultato. Per valori mancanti usa IS NULL / IS NOT NULL, non = NULL.

```sql
SELECT DISTINCT citta FROM clienti WHERE citta IS NOT NULL ORDER BY citta;
```

#### INNER JOIN · collegare dati

Restituisce gli ordini con il loro cliente. Gli alias c e o distinguono campi con lo stesso nome.

```sql
SELECT c.nome, o.id AS ordine_id, o.totale
FROM clienti AS c
INNER JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY o.id;
```

#### LEFT JOIN · includere chi non ha ordini

Mantiene tutti i clienti anche se non ci sono righe corrispondenti in ordini. Le colonne dell’ordine mancante risultano NULL.

```sql
SELECT c.nome, o.id AS ordine_id
FROM clienti AS c
LEFT JOIN ordini AS o ON o.cliente_id = c.id
ORDER BY c.id, o.id;
```

#### GROUP BY e HAVING

GROUP BY riunisce gli ordini per cliente. COUNT conta e SUM somma. HAVING filtra i gruppi dopo i calcoli.

```sql
SELECT c.id, c.nome, COUNT(o.id) AS numero_ordini, SUM(o.totale) AS spesa
FROM clienti c JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome
HAVING SUM(o.totale) > 30
ORDER BY spesa DESC;
```

#### EXISTS · verificare una relazione

La sottoquery verifica l’esistenza di almeno un ordine per il cliente. Non produce duplicati dovuti a ordini multipli.

```sql
SELECT c.id, c.nome FROM clienti c
WHERE EXISTS (SELECT 1 FROM ordini o WHERE o.cliente_id = c.id);
```

#### WITH · organizzare una query

Una CTE assegna un nome a un risultato intermedio e rende leggibile una query composta. Non crea una tabella permanente.

```sql
WITH spese AS (
  SELECT cliente_id, SUM(totale) AS spesa FROM ordini GROUP BY cliente_id
)
SELECT c.nome, s.spesa FROM clienti c JOIN spese s ON s.cliente_id = c.id;
```

#### Funzioni finestra · progressivi

SUM OVER calcola un totale progressivo mantenendo ogni singola riga. ROWS specifica esattamente l’intervallo del calcolo.

```sql
SELECT id, cliente_id, totale,
SUM(totale) OVER (PARTITION BY cliente_id ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS progressivo
FROM ordini ORDER BY cliente_id, id;
```

#### INSERT · aggiungere una riga

Dichiara sempre le colonne. L’ID è fornito qui per avere un esempio riproducibile; nelle applicazioni usa parametri e l’identità del motore. **Modifica struttura o dati.**

```sql
INSERT INTO clienti(id, nome, email, citta) VALUES (3, 'Katherine', 'katherine@example.test', 'Udine');
```

#### UPDATE · modificare per chiave

Prima controlla la riga con SELECT. Il WHERE identifica la chiave primaria; ometterlo modificherebbe tutte le righe. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 1;
UPDATE clienti SET citta = 'Udine' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
```

#### DELETE · eliminare per chiave

Controlla prima SELECT con lo stesso filtro. La cancellazione può essere impedita da relazioni; non disabilitare le chiavi esterne per aggirarla. **Modifica struttura o dati.**

```sql
SELECT * FROM clienti WHERE id = 3;
DELETE FROM clienti WHERE id = 3;
```

#### Transazioni · prova con rollback

BEGIN avvia il gruppo di operazioni. ROLLBACK annulla la prova. Usa COMMIT soltanto quando vuoi conservare le scritture. MySQL/MariaDB confermano molti DDL implicitamente. **Modifica struttura o dati.**

```sql
BEGIN;
UPDATE clienti SET citta = 'Città di prova' WHERE id = 1;
SELECT * FROM clienti WHERE id = 1;
ROLLBACK;
```

#### ALTER TABLE · aggiungere una colonna

Aggiunge un campo senza eliminare righe. Si applica una sola volta. Per rinomina, tipi, vincoli o rimozioni usa il piano del designer e rivedi l’impatto sui dati. **Modifica struttura o dati.**

```sql
ALTER TABLE clienti ADD COLUMN telefono VARCHAR(30);
```

#### CREATE INDEX · migliorare le ricerche

L’indice può accelerare WHERE e JOIN, ma richiede spazio e manutenzione a ogni scrittura. Non aggiungere indici soltanto per abitudine. **Modifica struttura o dati.**

```sql
CREATE INDEX idx_clienti_citta ON clienti(citta);
```

#### EXPLAIN · leggere il piano

Mostra come il motore intende eseguire la query. L’esempio non usa ANALYZE, che in alcuni motori esegue davvero la query.

```sql
EXPLAIN SELECT * FROM clienti WHERE citta = 'Udine';
```

#### Vista · riusare una lettura

Una vista conserva una definizione di query. Le righe provengono dalle tabelle sottostanti; non è un backup. **Modifica struttura o dati.**

```sql
CREATE VIEW riepilogo_clienti AS
SELECT c.id, c.nome, COUNT(o.id) AS ordini
FROM clienti c LEFT JOIN ordini o ON o.cliente_id = c.id
GROUP BY c.id, c.nome;
```

## MongoDB

### 1 · Prepara client e laboratorio

SQLite è incorporato nell’app; sqlite3.exe serve solo ai comandi esterni. Per PostgreSQL, MySQL, MariaDB e MongoDB serve un server attivo, locale o remoto, e il suo client. I client non vengono installati dal catalogo. Per i server configura TLS e CA come negli script parametrizzati del Catalogo PowerShell. Gli esempi localhost sono per un laboratorio locale già predisposto; non includono password.

```powershell
$PSVersionTable.PSVersion
# Controlla i client nel passo successivo.
```

### 2 · Crea un database nuovo

Usa nomi dedicati a questa prova. Se il database esiste già, passa all’apertura. Non incollare istruzioni SQL direttamente nel prompt PowerShell: inviale al client o usa l’editor dell’app.

```powershell
Get-Command mongosh.exe, mongodump.exe, mongorestore.exe
& mongosh.exe 'mongodb://localhost:27017/dbm_tutorial'
# Nella shell mongosh, con l’autenticazione prevista dal laboratorio:
# db.createCollection('clienti')
# MongoDB materializza il database quando crei una collezione o scrivi dati.
```

### 3 · Apri un database esistente nell’app

Nuova connessione → scegli il motore → host, porta, database e utente → configura TLS/CA e la password → Verifica connessione → Salva → Connetti. I file interni dei server non si aprono come se fossero file SQLite.

### 4 · Definisci le strutture

Le collezioni conservano documenti. Questo schema dimostrativo usa clienti e ordini; il collegamento cliente_id è logico.

```json
[
  {
    "create": "clienti"
  },
  {
    "create": "ordini"
  }
]
```

### 5 · Inserisci dati sintetici

Usa soltanto il database tutorial. Questi nomi e indirizzi sono dimostrativi. Apri il codice nell’editor e rivedi la connessione prima di eseguire.

```json
[
  {
    "insert": "clienti",
    "documents": [
      {
        "_id": 1,
        "nome": "Ada",
        "email": "ada@example.test",
        "citta": "Udine"
      },
      {
        "_id": 2,
        "nome": "Grace",
        "citta": "Trieste"
      }
    ]
  },
  {
    "insert": "ordini",
    "documents": [
      {
        "_id": 1,
        "cliente_id": 1,
        "totale": 25.5
      },
      {
        "_id": 2,
        "cliente_id": 1,
        "totale": 40
      },
      {
        "_id": 3,
        "cliente_id": 2,
        "totale": 18
      }
    ]
  }
]
```

### 6 · Leggi e modifica i record

Dati tabella → seleziona la tabella → modifica celle o aggiungi record → controlla l’anteprima → Applica. Scarta annulla le modifiche preparate. Il sistema richiede una chiave stabile per modificare o eliminare righe. Il Prontuario qui accanto spiega i comandi equivalenti.

### 7 · Cambia la struttura graficamente

Designer database → Carica schema esistente → Campi e vincoli. Per una relazione trascina il punto del campo origine su quello della destinazione; il doppio clic sulla linea la rimuove dal progetto. Vai a Script → Modifiche al database: controlla ogni operazione, destinazione e impatto sui dati. Le ricostruzioni richiedono un backup e una conferma aggiuntiva. I blocchi del piano indicano metadati o operazioni da trattare con una migrazione dedicata.

### 8 · Genera codice per l’applicazione

Generatore codice → seleziona tabella, linguaggio e formato. Lettura/Funzione genera binding separati dai valori. Funzioni CRUD genera execute(list/insert/update/delete, payload). Programma completo aggiunge dipendenze e istruzioni. Funzione di creazione schema produce un modulo con una connessione fornita dall’applicazione, per i quattro motori SQL. Esporta in una cartella nuova e integra il sorgente; la generazione non lo esegue.

### 9 · Crea e verifica il backup

Chiudi o attendi le scritture in corso e scegli una destinazione nuova. La cartella deve esistere e i client devono poterci scrivere. I comandi qui sotto usano un laboratorio localhost; per server diversi adatta autenticazione e TLS. Verifica il ripristino su una copia distinta prima di considerare affidabile il backup.

```powershell
& mongodump.exe --uri='mongodb://localhost:27017/dbm_tutorial' --archive='C:\Dati\dbm-tutorial.archive' --gzip
if ($LASTEXITCODE -ne 0) { throw 'Backup non riuscito' }
# Ripristino in un namespace distinto; autenticazione secondo il laboratorio:
& mongorestore.exe --uri='mongodb://localhost:27017' --archive='C:\Dati\dbm-tutorial.archive' --gzip --nsFrom='dbm_tutorial.*' --nsTo='dbm_tutorial_copia.*'
```

### 10 · Personalizza PowerShell e salva il progetto

Catalogo → Catalogo PowerShell: scegli uno dei 52 modelli, imposta percorsi e parametri e leggi effetti e prerequisiti. Copia o Esporta .ps1. Per le scritture usa prima .\script.ps1 -WhatIf, poi avvialo esplicitamente senza -WhatIf solo quando hai verificato la destinazione. -WhatIf non interroga il database e non certifica che l’operazione riuscirà. Nel designer usa Salva progetto per conservare anche il disegno.

### Prontuario MongoDB

Le query seguenti si riferiscono alle strutture e ai dati del tutorial precedente. Le operazioni di scrittura sono indicate espressamente; nel codice applicativo usare binding del driver per i valori.

#### Leggere e filtrare

Il comando find seleziona documenti. filter limita i record; projection sceglie i campi. limit evita risultati eccessivi.

```json
{
  "find": "clienti",
  "filter": {
    "citta": "Udine"
  },
  "projection": {
    "nome": 1,
    "citta": 1
  },
  "limit": 20
}
```

#### Ordinare

sort con 1 ordina in modo crescente, con -1 decrescente.

```json
{
  "find": "ordini",
  "filter": {
    "totale": {
      "$gte": 20
    }
  },
  "sort": {
    "totale": -1
  },
  "limit": 20
}
```

#### Inserire un documento

insert crea un nuovo documento. Se _id esiste già l’operazione fallisce; i dati mostrati sono sintetici. **Modifica struttura o dati.**

```json
{
  "insert": "clienti",
  "documents": [
    {
      "_id": 3,
      "nome": "Katherine",
      "citta": "Udine"
    }
  ]
}
```

#### Modificare un documento

q identifica una sola chiave; $set cambia soltanto i campi indicati. multi:false evita aggiornamenti multipli. **Modifica struttura o dati.**

```json
{
  "update": "clienti",
  "updates": [
    {
      "q": {
        "_id": 1
      },
      "u": {
        "$set": {
          "citta": "Udine"
        }
      },
      "multi": false,
      "upsert": false
    }
  ]
}
```

#### Eliminare un documento

Controlla prima find con lo stesso filtro. limit:1 elimina al massimo un documento. **Modifica struttura o dati.**

```json
{
  "delete": "clienti",
  "deletes": [
    {
      "q": {
        "_id": 3
      },
      "limit": 1
    }
  ]
}
```

#### Raggruppare e sommare

$group forma un gruppo per cliente; $sum somma il totale di ciascun ordine. La pipeline non modifica i documenti.

```json
{
  "aggregate": "ordini",
  "pipeline": [
    {
      "$group": {
        "_id": "$cliente_id",
        "totale": {
          "$sum": "$totale"
        }
      }
    },
    {
      "$sort": {
        "totale": -1
      }
    }
  ],
  "cursor": {}
}
```

#### Collegare collezioni

$lookup collega clienti e ordini. Si tratta di una relazione logica: MongoDB non applica una chiave esterna SQL.

```json
{
  "aggregate": "clienti",
  "pipeline": [
    {
      "$lookup": {
        "from": "ordini",
        "localField": "_id",
        "foreignField": "cliente_id",
        "as": "ordini_cliente"
      }
    }
  ],
  "cursor": {}
}
```

#### Creare un indice

L’indice accelera ricerche per città; occupa spazio e incide sulle scritture. Controlla il piano della query prima di aggiungerne altri. **Modifica struttura o dati.**

```json
{
  "createIndexes": "clienti",
  "indexes": [
    {
      "key": {
        "citta": 1
      },
      "name": "idx_clienti_citta"
    }
  ]
}
```

#### Aggiornare un validatore

collMod cambia i requisiti delle scritture future. I documenti già presenti non vengono convertiti automaticamente. **Modifica struttura o dati.**

```json
{
  "collMod": "clienti",
  "validator": {
    "$jsonSchema": {
      "bsonType": "object",
      "required": [
        "nome"
      ],
      "properties": {
        "nome": {
          "bsonType": "string"
        }
      }
    }
  },
  "validationLevel": "strict",
  "validationAction": "error"
}
```

## Fonti ufficiali

- [SQLite · CLI](https://www.sqlite.org/cli.html)
- [SQLite · ALTER TABLE](https://www.sqlite.org/lang_altertable.html)
- [PostgreSQL · psql](https://www.postgresql.org/docs/current/app-psql.html)
- [PostgreSQL · ALTER TABLE](https://www.postgresql.org/docs/current/sql-altertable.html)
- [MySQL · ALTER TABLE](https://dev.mysql.com/doc/refman/8.4/en/alter-table.html)
- [MariaDB · client](https://mariadb.com/docs/server/clients-and-utilities/mariadb-client/mariadb-command-line-client)
- [MongoDB · comandi](https://www.mongodb.com/docs/manual/reference/command/)
- [PowerShell · WhatIf](https://learn.microsoft.com/en-us/powershell/scripting/learn/deep-dives/everything-about-shouldprocess)
