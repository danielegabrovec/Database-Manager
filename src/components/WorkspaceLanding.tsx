import { FilePlus2, FolderOpen, History, Plus } from "lucide-react";
import "./workspace-start.css";

export interface WorkspaceLandingProps {
  onOpen: () => void;
  onFolder: () => void;
  onWizard: () => void;
  onResume: () => void;
  canResume: boolean;
}

export function WorkspaceLanding({
  onOpen,
  onFolder,
  onWizard,
  onResume,
  canResume,
}: WorkspaceLandingProps) {
  return (
    <section
      className="workspace-landing"
      aria-labelledby="workspace-start-title"
    >
      <div>
        <h1 id="workspace-start-title">Inizia a lavorare</h1>
        <p className="muted">
          Apri un file, scegli una cartella oppure crea un database.
        </p>
      </div>
      <div className="workspace-landing-actions">
        <button type="button" onClick={onOpen}>
          <FilePlus2 size={20} aria-hidden="true" />
          <span>
            <strong>Apri file o database</strong>
            <small>SQLite, script SQL o codice sorgente</small>
          </span>
        </button>
        <button type="button" onClick={onFolder}>
          <FolderOpen size={20} aria-hidden="true" />
          <span>
            <strong>Apri cartella di lavoro</strong>
            <small>Sfoglia e apri i file dalla barra laterale</small>
          </span>
        </button>
        <button type="button" onClick={onWizard}>
          <Plus size={21} aria-hidden="true" />
          <span>
            <strong>Crea o collega un database</strong>
            <small>Segui la procedura guidata</small>
          </span>
        </button>
        {canResume && (
          <button type="button" onClick={onResume}>
            <History size={20} aria-hidden="true" />
            <span>
              <strong>Riprendi il lavoro</strong>
              <small>Ritrova le bozze e le schede già aperte</small>
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
