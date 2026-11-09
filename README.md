# Database Manager

Applicazione desktop in italiano per **SQLite, PostgreSQL, MySQL, MariaDB e MongoDB**, realizzata con **Rust, Tauri 2, React e TypeScript**.

Disegna le strutture, prepara le query, modifica i dati con anteprima e genera codice per dodici linguaggi. Le funzioni principali e la guida didattica funzionano senza AI.

**Autore: Daniele Gabrovec** · **Versione pubblica: 0.2.1** · **Distribuzione: Windows x64**

[**Scarica l'ultima release Windows**](https://github.com/danielegabrovec/Database-Manager/releases/latest) · [Guida utente](docs/GUIDA-UTENTE.md) · [Sviluppo](docs/SVILUPPO.md) · [Licenza](LICENSE)

## Inizia in pochi minuti

1. Scarica l'installer `.exe` dalla pagina delle release e installa l'applicazione. È richiesto **Microsoft Edge WebView2**; il primo setup può richiedere la rete se il runtime manca.
2. Chiudi eventuali versioni precedenti prima di avviare la nuova: il programma mantiene una sola istanza.
3. Apri **Laboratorio → SQLite → Negozio e ordini → Crea e apri laboratorio**. Per SQLite non serve installare un server.
4. Apri una tabella in **Dati tabella**, oppure prova questa query nell'**Editor SQL / MongoDB**:

```sql
SELECT c.name, SUM(i.quantity * i.unit_price) AS totale
FROM customers c
JOIN orders o ON o.customer_id = c.id
JOIN order_items i ON i.order_id = o.id
GROUP BY c.id, c.name
ORDER BY totale DESC;
```

`Ctrl+Invio` esegue la selezione o l'istruzione corrente; `Ctrl+Spazio` completa nomi e funzioni, `Ctrl+S` salva una query e `Ctrl+K` cerca nello spazio di lavoro.

## Dallo schema al codice

**Designer database → Campi e vincoli → Relazioni grafiche → Script e creazione → Codice nel linguaggio**.

Puoi disegnare anche senza connessione, salvare il progetto come JSON e generare sorgenti prima della creazione fisica. Per un database esistente usa **Dati tabella → Genera lettura** e scegli colonne, filtri, JOIN o aggregazioni.

| Strumento                | Funzioni                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Editor e catalogo        | SQL per dialetto, Extended JSON MongoDB, completamento dello schema e degli alias, esempi, parametri, query salvate, cronologia e spiegazioni offline. |
| Dati tabella             | Selezione e modifica celle, copia TSV/CSV, incolla con anteprima, scheda/JSON, controllo tipi e conflitti, **Applica / Scarta**.                       |
| Designer                 | Più tabelle, PK, NULL, UNIQUE, default, indici e relazioni tramite trascinamento o clic origine/destinazione. Script delle sole strutture mancanti.    |
| Generatore               | Lettura, funzione parametrizzata, modello/DTO, repository di lettura, programmi CRUD, API REST e script. Esportazione e apertura in VS Code.           |
| Trasferimento e ambienti | Import/export, backup e ripristino con strumenti del motore; laboratori e istanze locali dedicate Docker o native.                                     |

**Linguaggi:** Rust, Python, JavaScript, TypeScript, PHP, Java, C#, C, C++, Go, Kotlin e Ruby. Le API REST sono per **Rust/Axum, Python/FastAPI e JavaScript/TypeScript/Fastify**.

I sorgenti generati comprendono istruzioni e dipendenze. Le credenziali vengono lette dall'ambiente; l'app non esegue automaticamente i programmi esportati.

## Anteprima

Schermate dell'interfaccia 0.2 sul laboratorio con dati sintetici.

![Editor dati con tabella clienti](docs/images/dati-tabella.png)

<details>
<summary>Designer e generazione del codice</summary>

![Designer delle relazioni fra campi](docs/images/designer-relazioni.png)

![Generazione di una funzione di lettura Python dallo schema](docs/images/generazione-lettura.png)

</details>

## Verifiche e limiti attuali

La baseline funzionale 0.2 ha **101 test frontend superati** e **66 test Rust superati, 0 falliti e 3 ignorati**. Le nuove letture sono state esercitate su SQLite nei dodici linguaggi; i collaudi dei programmi CRUD e delle API sono documentati separatamente.

L'interfaccia 0.2 è stata provata nel browser locale con backend Rust: completamento accettato ed eseguito, selezione colonne, query salvate, creazione di tabelle/FK e modifica dati applicata. La build Windows/NSIS è riuscita. Il tentativo nativo 0.2 è stato fermato dall'istanza precedente ancora aperta: non viene dichiarato un walkthrough desktop 0.2 o un collaudo in VM pulita. La 0.2.1 aggiunge documentazione e informazioni legali alla stessa revisione funzionale.

- L'installer non è firmato digitalmente. La distribuzione qui documentata è **Windows x64**.
- Il designer crea strutture mancanti; le modifiche a tabelle esistenti richiedono **ALTER o migrazioni esplicite**. Per PostgreSQL crea nello schema **public**.
- Le FK singole richiedono una destinazione PK/UNIQUE singola e completa. FK composte e indici parziali non vengono adottati dal designer fingendo di conservarli. Il generatore conserva il supporto alle PK composte.
- I nuovi repository generati sono di lettura. Per scrivere si sceglie il programma CRUD o l'API; tipi non mappabili vengono segnalati.
- Server esterni, configurazioni TLS/SSH e installazione dei servizi Windows richiedono verifiche dedicate. I servizi SCM in VM pulita non sono certificati.

L'assistente facoltativo supporta Ollama o un endpoint HTTPS compatibile. Prima di abilitarlo consulta [Privacy](PRIVACY.md): query, schema e righe sono scelte di condivisione distinte, e le righe sono escluse inizialmente.

## Documentazione

| Documento                                           | Contenuto                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| [Guida utente](docs/GUIDA-UTENTE.md)                | Installazione, dati, editor, designer, codice e flussi quotidiani. |
| [Sviluppo](docs/SVILUPPO.md)                        | Toolchain, avvio locale, test e build Windows.                     |
| [Novità e verifiche 0.2](docs/VERSIONE-0.2.md)      | Cambiamenti, prove osservate e limiti della revisione funzionale.  |
| [Editor e libreria query](docs/QUERY-IDE.md)        | Completamento, catalogo, didattica e parametri.                    |
| [Architettura](docs/ARCHITETTURA.md)                | Backend Rust, frontend e interfacce del progetto.                  |
| [Verifiche storiche 0.1](docs/VERIFICA.md)          | Collaudi precedenti, distinti dalle verifiche 0.2.                 |
| [Verifica dei generatori](docs/CODEGEN-VERIFICA.md) | Matrice CRUD/REST, toolchain e ambito delle prove.                 |

Alcuni rapporti di sviluppo rimandano a registri locali di QA: tali registri, runtime temporanei e workspace non sono inclusi nel repository pubblico. Le istruzioni riproducibili sono nella guida di sviluppo.

## Autore e condizioni d'uso

**Daniele Gabrovec**. Consulta [AUTHORS.md](AUTHORS.md), [LICENSE](LICENSE), [LEGAL.md](LEGAL.md), [PRIVACY.md](PRIVACY.md) e [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). La presenza pubblica del repository non sostituisce le condizioni contenute in questi documenti. Le dipendenze e i motori database mantengono le rispettive licenze.
