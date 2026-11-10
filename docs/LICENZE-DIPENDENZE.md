# Licenze delle dipendenze — rilascio Windows 0.5.1

Inventario tecnico iniziale del 9 novembre 2026; metadati del rilascio 0.5.1 e hash dei lockfile aggiornati il 10 novembre 2026, senza variazioni delle dipendenze elencate. Il codice originale di Database Manager è attribuito a **Daniele Gabrovec**; i relativi termini sono nei documenti `LICENSE`, `LEGAL.md` e `AUTHORS.md` del progetto. Le librerie, i dati e gli asset esterni conservano autori e condizioni originali. Questo documento non assegna a Daniele Gabrovec la proprietà dei componenti esterni.

## Fonti e perimetro verificato

Sono stati letti `package-lock.json`, i metadati delle installazioni npm effettive, `src-tauri/Cargo.lock` e `cargo metadata --locked --offline --filter-platform x86_64-pc-windows-msvc` con le funzionalità desktop predefinite. Risultano **184 pacchetti npm** e **415 pacchetti Cargo esterni**; il pacchetto originale dell'app è escluso dal conteggio di terze parti.

Il risultato pubblicabile è `licenses/dependency-inventory.json`. Contiene versioni esatte, licenze dichiarate, classificazione delle dipendenze, URL pubblici e hash dei testi conservati. **Non contiene percorsi privati della macchina di sviluppo.** L'elenco comprende strumenti di compilazione e pacchetti opzionali di altre piattaforme: non prova che ogni voce sia incorporata nel binario Windows.

Sono conservati i testi LICENSE, NOTICE, COPYRIGHT e ThirdPartyNotices disponibili nei package installati, inclusi quelli dei sottocomponenti. In particolare, `Monaco Editor/ThirdPartyNotices.txt` è incluso integralmente, insieme alle attribuzioni degli asset/font/icone lì dichiarati; Lucide mantiene le attribuzioni ISC/Feather. Non sono stati sostituiti i nomi degli autori con quello dell'autore dell'app.

Quando il package pubblicato omette un file di licenza autonomo, il testo mancante è stato recuperato dal repository upstream al commit indicato nel suo `.cargo_vcs_info.json`. URL, commit e SHA-256 sono in `licenses/upstream-supplements.json`. I quattro package npm nativi di esbuild/Rollup/Tauri CLI che omettono i testi usano le licenze del rispettivo package principale della stessa versione; questa provenienza è dichiarata nell'inventario. Per `selectors`, che dichiara MPL-2.0 nei metadati e negli header ma non contiene un file completo autonomo, sono conservati i riferimenti/copyright degli header e un supplemento con il testo standard MPL-2.0.

## Condizioni da preservare in questa distribuzione

| Famiglia | Evidenza trovata e trattamento adottato |
|---|---|
| MIT, ISC, BSD e Zlib | Conservare i testi di licenza, le attribuzioni e gli avvisi di esclusione di garanzia forniti dai componenti. Per MIT il requisito di conservazione è nel [testo ufficiale](https://opensource.org/license/mit). |
| Apache-2.0 | Includere il testo; mantenere gli avvisi applicabili e gli eventuali NOTICE upstream. La raccolta include, ad esempio, `moka/NOTICE`. I requisiti specifici sono nella [sezione 4 di Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0). |
| Espressioni `AND` | Conservare entrambi i gruppi di termini dichiarati. Esempi reali: brotli BSD-3-Clause AND MIT, matchit MIT AND BSD-3-Clause, ring Apache-2.0 AND ISC. Per ring sono presenti anche i testi BoringSSL e altri sottocomponenti. |
| Licenze alternative `OR` | La scelta di una licenza per un componente non modifica quella del progetto originale. Per DOMPurify 3.4.17, duale MPL-2.0/Apache-2.0, la distribuzione documenta l'opzione Apache-2.0 e mantiene i testi upstream. |
| MPL-2.0 | I cinque componenti identificati sotto mantengono la licenza dei loro file e hanno un archivio di sorgenti corrispondenti. La [MPL-2.0, sezioni 3.1–3.3](https://www.mozilla.org/en-US/MPL/2.0/), descrive distribuzione del sorgente, forma eseguibile e larger work; il [chiarimento Mozilla](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) distingue il perimetro dei file coperti. Non viene applicata automaticamente MPL a tutti i file originali separati dell'app. |
| Unicode-3.0 | Conservare gli avvisi Unicode forniti con le librerie/dati. Sono presenti `LICENSE-UNICODE` e COPYRIGHT dove distribuiti. Riferimento: [Unicode License V3](https://www.unicode.org/license.txt). |
| CDLA-Permissive-2.0 | `webpki-roots` 0.26.11 e 1.0.11 dichiarano questa licenza per i dati. Il testo è incluso; la condizione di accompagnare i dati condivisi con l'accordo è nella [sezione 2.1](https://cdla.dev/permissive-2-0/). |
| CC-BY-4.0 | `caniuse-lite` è indicato come dato di sviluppo/build, con testo e provenienza del package preservati; non è classificato come funzionalità runtime separata. La [fonte Creative Commons](https://creativecommons.org/licenses/by/4.0/) descrive attribuzione, collegamento alla licenza e indicazione delle modifiche. |

Queste sono istruzioni di conservazione riferite ai componenti osservati, non un'attestazione generale su qualsiasi futura dipendenza o modalità di distribuzione. Le espressioni originali sono mantenute anche quando usano la vecchia notazione Cargo con `/`.

## Sorgenti MPL corrispondenti

| Crate | Versione | Sorgente pubblico esatto |
|---|---|---|
| cssparser | 0.37.0 | [crate pubblicata](https://static.crates.io/crates/cssparser/cssparser-0.37.0.crate) |
| cssparser-macros | 0.7.1 | [crate pubblicata](https://static.crates.io/crates/cssparser-macros/cssparser-macros-0.7.1.crate) |
| dtoa-short | 0.3.5 | [crate pubblicata](https://static.crates.io/crates/dtoa-short/dtoa-short-0.3.5.crate) |
| option-ext | 0.2.0 | [crate pubblicata](https://static.crates.io/crates/option-ext/option-ext-0.2.0.crate) |
| selectors | 0.38.0 | [crate pubblicata](https://static.crates.io/crates/selectors/selectors-0.38.0.crate) |

`third-party-mpl-sources.zip` contiene tutti i file regolari delle cinque crate pubblicate, senza modifiche. Gli archivi originali della cache Cargo sono stati confrontati con i checksum in `Cargo.lock`; `SOURCES.json` registra ogni file incluso. Non sono inclusi toolchain, runtime dei database o dati di QA. La fonte corrispondente viene offerta nell'[asset del rilascio v0.5.1](https://github.com/danielegabrovec/Database-Manager/releases/download/v0.5.1/third-party-mpl-sources.zip), richiamato anche dagli avvisi inclusi nell'app.

Hash dell'asset 0.5.1 prodotto: `8ef3456f49ad883f38f4913ced80101dc570efb14b5b106d27704b2331bc0daf` (175.931 byte). I metadati sono in `artifacts/release-v051/third-party-mpl-sources-manifest.json`; questi file sono asset di rilascio, non cache da aggiungere indiscriminatamente al repository.

Il precedente asset locale v0.3.0 resta conservato sotto `artifacts/release-v030/`: SHA-256 `af1d4d50dd664166f0a9bab45ff07dea2b893832c205c4ea46003887b2f4eb4c`, 175.931 byte. Il [precedente asset v0.2.1](https://github.com/danielegabrovec/Database-Manager/releases/download/v0.2.1/third-party-mpl-sources.zip) resta il riferimento storico di quel rilascio: SHA-256 `697774fb5e8ba4edb73cb1acc97ef87e906aadd4fbb7c430ee82ccfe7b8f46aa`, 175.933 byte, copia locale originale sotto `artifacts/publication-20261109/`. Le cinque versioni e ogni file upstream sono invariati nei tre asset. Cambiano soltanto i metadati di confezionamento in `SOURCES.json`, incluso il tag del rilascio; il differente hash ZIP non indica modifiche ai sorgenti delle dipendenze.

## Cosa distribuire e cosa escludere

Installer e archivio portabile devono mantenere `THIRD-PARTY-NOTICES.md` e l'intera directory `licenses/`, oltre ai documenti del progetto originale. L'indice rimanda a tutti i testi; non basta pubblicare soltanto il nome della licenza o una tabella di pacchetti. `licenses/` deve essere incluso nelle risorse Tauri del pacchetto finale.

I server PostgreSQL/MySQL/MariaDB/MongoDB scaricati su richiesta, le immagini Docker, i loro client, i linguaggi/SDK e le dipendenze degli esempi generati sono prodotti separati, con proprie licenze. Non sono compresi nel programma soltanto perché il software li gestisce. Le cache native, le toolchain usate per i collaudi, i file di database, `node_modules/`, `target/` e il bundle REA da 44 MB restano esclusi dalla pubblicazione delle fonti dell'app e dai pacchetti Windows.

SQLite dichiara in [prima persona](https://sqlite.org/copyright.html) la destinazione al pubblico dominio del codice della libreria consegnata; il wrapper Rust mantiene la sua licenza. Microsoft WebView2 e i componenti del sistema operativo restano soggetti ai termini Microsoft applicabili. Questo inventario non sostituisce le condizioni dei prerequisiti distribuiti da altri soggetti.

Il confronto con DBeaver e pgAdmin è documentazione analitica: non viene ridistribuito il loro codice, logo o eseguibile, né rivendicata la proprietà dei loro prodotti.

## Rigenerazione e verifica

```powershell
python scripts/generate-third-party-notices.py --mpl-source-output artifacts/release-v051
python scripts/generate-third-party-notices.py --mpl-source-output artifacts/release-v051 --verify
```

La prima operazione usa la cache dei package già installati, conserva i testi e produce l'asset sorgente MPL; non installa dipendenze né esegue codice upstream. Versione, tag e URL del rilascio derivano da `package.json`. La verifica controlla versione, tag del pacchetto sorgente, hash dei due lockfile, presenza/integrità dei testi e ogni file del pacchetto sorgente MPL. Dopo una modifica alle dipendenze o ai lockfile, rigenerare prima di costruire e pubblicare un nuovo installer, scegliendo una cartella di output distinta per conservare gli asset storici.
