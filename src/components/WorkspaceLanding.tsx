import { useState } from "react";
import {
  ArrowRight,
  Database,
  FolderOpen,
  FilePlus2,
  History,
  Layers3,
  Send,
  SquareTerminal,
} from "lucide-react";
import { LocalAiControls, LocalAiRecents } from "./LocalAssistantWorkbench";
import "./workspace-start.css";

export interface WorkspaceLandingProps {
  onOpen: () => void;
  onFolder: () => void;
  onWizard: () => void;
  onResume: () => void;
  canResume: boolean;
  onProject: (id?: string) => void;
  onQuick: () => void;
  onAsk: (question: string) => void;
  onConversation: (id: string) => void;
  projects: { id: string; name: string }[];
}
export function WorkspaceLanding(props: WorkspaceLandingProps) {
  const [question, setQuestion] = useState("");
  return (
    <section className="wb-home" aria-labelledby="workspace-start-title">
      <header>
        <h1 id="workspace-start-title">Database Manager</h1>
      </header>
      <form
        className="wb-ask"
        onSubmit={(event) => {
          event.preventDefault();
          if (question.trim()) {
            props.onAsk(question.trim());
            setQuestion("");
          }
        }}
      >
        <label htmlFor="home-question">Chiedi all’AI locale</label>
        <textarea
          id="home-question"
          value={question}
          maxLength={8192}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Scrivi una domanda o descrivi il progetto che vuoi realizzare…"
          rows={3}
          onKeyDown={(e) => {
            if (
              e.key === "Enter" &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="wb-ask-footer">
          <LocalAiControls variant="home" />
          <button
            type="submit"
            className="button primary"
            disabled={!question.trim()}
          >
            <Send size={16} />
            Invia
          </button>
        </div>
      </form>
      <div className="wb-home-actions">
        {[
          {
            label: "Progetto applicativo",
            icon: Layers3,
            run: () => props.onProject(),
          },
          { label: "Apri file o database", icon: FilePlus2, run: props.onOpen },
          { label: "Apri cartella", icon: FolderOpen, run: props.onFolder },
          { label: "Crea database", icon: Database, run: props.onWizard },
          { label: "Query rapide", icon: SquareTerminal, run: props.onQuick },
          ...(props.canResume
            ? [
                {
                  label: "Riprendi il lavoro",
                  icon: History,
                  run: props.onResume,
                },
              ]
            : []),
        ].map(({ label, icon: Icon, run }) => (
          <button key={label} onClick={run}>
            <Icon size={17} />
            <span>{label}</span>
            <ArrowRight size={14} />
          </button>
        ))}
      </div>
      <div className="wb-home-recents">
        {props.projects.length > 0 && (
          <section>
            <h2>Progetti recenti</h2>
            {props.projects.map((project) => (
              <button
                key={project.id}
                onClick={() => props.onProject(project.id)}
              >
                <Layers3 size={15} />
                {project.name}
              </button>
            ))}
          </section>
        )}
        <LocalAiRecents onSelect={props.onConversation} />
      </div>
    </section>
  );
}
