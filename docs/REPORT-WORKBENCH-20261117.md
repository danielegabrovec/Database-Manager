# Rapporto di verifica del workbench

**17 novembre 2026 · Database Manager · Windows x64**

## Correzioni e comportamento verificato

| Area | Risultato |
| --- | --- |
| Identità degli oggetti | Una modifica alla tabella PostgreSQL `dbm_graph_z."rows.v1"` aggiorna soltanto quella tabella. L’omonima nello schema `dbm_graph_a` mantiene i propri dati. I riferimenti legacy ambigui sono rifiutati. L’introspezione ricostruisce le coppie della FK composta e le azioni dichiarate. |
| DDL e bozze | I test del Designer verificano la conservazione delle bozze escluse da un piano, la qualificazione PostgreSQL, il ripristino dei progetti, la conversione del sottoinsieme dichiarato e i validatori MongoDB. |
| Grafo | Inserimento, aggiornamento ed eliminazione provati su SQLite e sui quattro server nativi di laboratorio. I test coprono cambio dell’operazione dopo l’anteprima, riutilizzo del token e filtro obbligatorio. |
| Generazione | 48 combinazioni di schema SQL generate. Le funzioni nei 12 linguaggi sono state compilate o interpretate ed eseguite su SQLite. Kotlin è stato verificato con il compilatore e SQLite JDBC a causa del daemon Gradle. Le quattro funzioni MongoDB sono state eseguite su MongoDB reale, con validatore e indice composto verificati. |
| Ollama | Provati il modello locale `qwen2.5-coder:1.5b-base`, la selezione del contesto e la normalizzazione del completamento quando il modello ripete la query. |
| Query rapide | Su SQLite reale in memoria sono passati parametri, aggiornamento dello schema, ripristino e interruzione dopo ripristino. Provata anche la copia di un SQLite con pagine da 8192 byte. L’originale rimane intatto e il simulatore rifiuta accesso ai file e richieste cloud. |

## Prove automatiche e visuali

- **337 test frontend** superati, inclusi navigazione e componenti di **Query rapide**. TypeScript e build Vite completati. Vite segnala la dimensione del bundle principale.
- **110 test Rust** superati nella suite standard, con 12 test di integrazione esclusi per impostazione predefinita. Le prove native pertinenti ai flussi modificati sono state lanciate separatamente.
- Su PostgreSQL, MySQL, MariaDB e MongoDB sono passati gli adattatori, le migrazioni previste dalle fixture e le scritture del grafo. Su MongoDB sono passate anche le verifiche di annullamento e integrità BSON.
- Nel collaudo nativo Windows è stato creato un file SQLite dalla procedura guidata. Il Designer ha generato lo script, creato la tabella e riletto lo schema. Dopo il riavvio sono state osservate le schede del workspace e, dopo la riconnessione, la query del grafo. Una prima build lasciava le schede del grafo invisibili. La build successiva ha mostrato schede, porte e linea di collegamento.
- Nella finestra nativa larga, **Query rapide** ha mostrato menu, tabelle, cronologia, risultati e assistente. Una lettura ha restituito cinque record. `Ctrl+Invio` ha creato `solo_simulazione`, inserito `99` e mostrato il risultato e la nuova voce in cronologia. La tabella era assente dal file SQLite di prova. Il layout stretto ha una regola di apertura a cassetto e resta da osservare in finestra nativa.
- Su Ollama reale, `qwen2.5-coder:14b` ha risposto via chat riconoscendo lo schema sintetico e ha restituito un completamento al cursore. Il test ha trasmesso lo schema di esempio con il consenso della fixture. Le righe sono rimaste escluse.

## Ambito

Le prove utilizzano database e dati sintetici. Il round-trip dello schema riguarda i costrutti rappresentabili. Per query dinamiche, script avanzati e tipi specifici del motore rimangono le limitazioni della [guida](WORKBENCH-GRAFICO.md). Le prove sui generatori riguardano le fixture documentate. La matrice storica completa di tutti i CLI e delle API REST è documentata separatamente. Il collaudo usa l’eseguibile Windows da build. La release pubblicata resta la 0.5.1.
