import { useState } from "react";
import packageMetadata from "../../package.json";
import license from "../../LICENSE?raw";
import legal from "../../LEGAL.md?raw";
import privacy from "../../PRIVACY.md?raw";
import notices from "../../THIRD-PARTY-NOTICES.md?raw";
import { Button, Modal } from "./UI";

const DOCUMENTS = [
  { title: "Licenza del progetto", content: license },
  { title: "Note legali", content: legal },
  { title: "Dati e privacy", content: privacy },
  { title: "Componenti di terzi", content: notices },
];

export function AboutPanel() {
  const [selected, setSelected] = useState<number | null>(null);
  const document = selected === null ? null : DOCUMENTS[selected];
  return (
    <section className="panel stack" aria-label="Informazioni e note legali">
      <h2>Informazioni su Database Manager</h2>
      <p>
        <strong>Versione {packageMetadata.version}</strong> · Windows x64
      </p>
      <p>
        Ideazione, sviluppo e titolarità del codice originale:{" "}
        <strong>Daniele Gabrovec</strong>.
      </p>
      <p>Copyright © 2026 Daniele Gabrovec. Tutti i diritti riservati.</p>
      <p className="muted">
        L’uso degli eseguibili ufficiali è gratuito. I componenti di terzi
        mantengono le rispettive licenze e attribuzioni. I permessi sul codice
        prodotto dal generatore sono descritti nella licenza.
      </p>
      <p className="muted">
        Repository ufficiale: github.com/danielegabrovec/Database-Manager
      </p>
      <div className="row" style={{ flexWrap: "wrap" }}>
        {DOCUMENTS.map((item, index) => (
          <Button key={item.title} onClick={() => setSelected(index)}>
            {item.title}
          </Button>
        ))}
      </div>
      {document && (
        <Modal title={document.title} onClose={() => setSelected(null)} wide>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: "65vh",
              overflow: "auto",
              fontFamily: "inherit",
              fontSize: 14,
              lineHeight: 1.7,
              margin: 0,
            }}
            tabIndex={0}
            aria-label={document.title}
          >
            {document.content}
          </pre>
        </Modal>
      )}
    </section>
  );
}
