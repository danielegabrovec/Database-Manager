import { FileCode2, Plus, X } from "lucide-react";
import type { QueryDocument } from "../files/queryDocuments";
import { isQueryDocumentDirty } from "../files/queryDocuments";

export function QueryDocumentTabs({
  documents,
  activeId,
  onSelect,
  onClose,
  onNew,
}: {
  documents: QueryDocument[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div
      className="document-tab-strip"
      role="tablist"
      aria-label="Documenti query aperti"
    >
      {documents.map((doc) => (
        <div
          className={`document-tab ${doc.id === activeId ? "active" : ""}`}
          key={doc.id}
        >
          <button
            role="tab"
            aria-selected={doc.id === activeId}
            tabIndex={doc.id === activeId ? 0 : -1}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const current = documents.findIndex((d) => d.id === doc.id);
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? documents.length - 1
                    : (current +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        documents.length) %
                      documents.length;
              onSelect(documents[next].id);
              const buttons = event.currentTarget
                .closest('[role="tablist"]')
                ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
              buttons?.[next]?.focus();
            }}
            onClick={() => onSelect(doc.id)}
            title={doc.path || doc.sourcePath || doc.title}
          >
            <FileCode2 size={14} />
            <span>{doc.title}</span>
            {isQueryDocumentDirty(doc) && (
              <span
                className="document-dirty"
                aria-label="Modifiche non salvate"
              >
                ●
              </span>
            )}
          </button>
          <button
            className="document-close"
            aria-label={`Chiudi ${doc.title}`}
            onClick={() => onClose(doc.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        className="icon-button"
        aria-label="Nuova scheda query"
        onClick={onNew}
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
