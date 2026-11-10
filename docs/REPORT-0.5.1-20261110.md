# Report finale — Database Manager 0.5.1

**10 novembre 2026 · Daniele Gabrovec**

La 0.5.1 completa il collaudo nativo che nella prima pubblicazione 0.5.0 era rimasto sospeso per la scadenza del consenso al controllo della finestra. Il consenso successivamente fornito ha consentito di provare l’eseguibile Windows con asset incorporati e workspace QA separato. È stato individuato e corretto un difetto del selettore di codifica.

## Correzione

Con un file modificato, scegliere un’altra codifica richiede la conferma di scarto della bozza. Nella 0.5.0 il selettore cambiava prima della conferma: premendo Annulla rimaneva visualizzata una codifica diversa da quella realmente usata dal documento. Il salvataggio usava già la codifica originale; non è stata osservata corruzione dei byte.

Nella 0.5.1 il selettore cambia soltanto dopo una rilettura riuscita. La prova Windows ha verificato un file UTF-16 LE con BOM, una bozza Unicode, una scelta Windows-1252 e l’annullamento: selettore, documento e bozza restano coerenti. Il successivo salvataggio ha mantenuto il BOM e il testo atteso.

## Prove native osservate

| Flusso | Esito |
|---|---|
| Ctrl+Maiusc+O e selettore Windows di cartella | Cartella QA scelta; file SQL e SQLite con nomi accentati correttamente elencati. |
| Ctrl+O e selettore Windows di file | Script UTF-16 letto senza esecuzione, codifica rilevata correttamente. |
| Salva con nome → Annulla | Dialogo nativo chiuso, bozza mantenuta come non salvata. |
| Salva con nome → nuova copia | Nuovo file UTF-16 con BOM e testo Unicode verificati nei byte; originale invariato durante la prova di copia. |
| Apertura SQLite esistente | Firma e metadati reali; scelta iniziale di sola lettura e lettura della riga sintetica Ada. |
| Modalità modificabile | Apertura scelta esplicitamente e profilo distinto da quello di sola lettura. |
| Editor query e IPC/Channels Tauri | SELECT sul database reale; risultato Ada e `città €`, zero modifiche. |
| Chiusura con bozza → Annulla | Bozza rimasta disponibile. |
| Conserva bozze e chiudi → riavvio | Testo Unicode e codifica UTF-16 recuperati. |
| Cambio di codifica annullato, build 0.5.1 | Difetto non più riproducibile; selettore rimasto UTF-16, bozza preservata. |
| Ctrl+S nella 0.5.1 | File salvato, testo non eseguito; BOM UTF-16 e contenuto atteso verificati. |
| Chiusura finale | Finestra chiusa effettivamente, query conservate. |

Le copie di progetto esistenti sono state mantenute; la sola tabella QA adottata temporaneamente nel designer è stata rimossa dalla copia di progetto, senza eliminare il database. Le prove di migrazione grafica con applicazione e modifica delle celle restano quelle browser con backend reale documentate nel report 0.5.0; non vengono presentate come una nuova prova nativa di ogni funzione.

## Test e build 0.5.1

- **306 test frontend superati** in 32 file; TypeScript riuscito.
- **98 test Rust superati, zero falliti, 11 ignorati** nella suite completa `--locked --no-default-features`: 78 unitari e 20 integrazioni.
- Build desktop Windows x64 e installer NSIS riusciti, con percorsi di compilazione rimappati.
- **599 componenti e 897 testi legali** verificati, nessun testo installato mancante.
- Restano valide le prove della campagna 0.5 su quattro server reali, 114 analisi PowerShell, runtime SQLite con entrambi i PowerShell e funzioni schema compilate/eseguite nei dodici linguaggi. La patch non modifica adattatori, migrazioni o generatori. I dettagli sono nel [report 0.5.0](REPORT-0.5.0-20261110.md).

## Distribuzione e limiti

La distribuzione corrente è [Database Manager v0.5.1](https://github.com/danielegabrovec/Database-Manager/releases/tag/v0.5.1). Il pacchetto comprende installer, portabile con tutti i testi legali, guida, report, checksum, manifest e sorgenti MPL. I controlli e le ricevute di pubblicazione sono in `artifacts/release-v051/`, esclusi dal repository perché contengono prodotti di compilazione e QA.

Il tag della release identifica il codice distribuito; la cronologia sorgente precedente viene conservata. La distribuzione 0.5.0 viene sostituita solo dopo verifica del download della 0.5.1, conservando una copia locale degli asset precedenti.

Installer **non firmato digitalmente**, installazione in VM pulita non certificata. Il walkthrough riguarda i flussi Windows elencati, non ogni combinazione di server, TLS/SSH, strumenti esterni o hardware. Restano i limiti dichiarati delle migrazioni e dei formati generati. Non sono stati usati database personali o di produzione per le scritture.

## Ripetere le verifiche

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features
python scripts/generate-third-party-notices.py --verify --mpl-source-output artifacts/release-v051
./scripts/Build-Release.ps1 -ReportPath docs/REPORT-0.5.1-20261110.md
```

Ricevuta dei flussi Windows: `artifacts/release-v051/native-ui-verification.json`. Il programma è stato chiuso al termine del collaudo, conservando le bozze.
