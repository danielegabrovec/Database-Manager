import {
  BookOpen,
  Braces,
  Database,
  DatabaseBackup,
  FlaskConical,
  FolderOpen,
  GitFork,
  Layers3,
  Plus,
  Settings,
  Table2,
  Terminal,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type WorkspaceView =
  | "files"
  | "editor"
  | "data"
  | "designer"
  | "library"
  | "powershell"
  | "builder"
  | "laboratory"
  | "schema"
  | "codegen"
  | "transfer"
  | "environments"
  | "settings";

export interface NavigationItem {
  id: WorkspaceView;
  label: string;
  icon: LucideIcon;
}

export const NAV_FLAT: readonly NavigationItem[] = [
  { id: "files", label: "Apri file e database", icon: FolderOpen },
  { id: "editor", label: "Editor SQL / MongoDB", icon: Terminal },
  { id: "data", label: "Dati tabella", icon: Table2 },
  { id: "schema", label: "Struttura e relazioni", icon: GitFork },
  { id: "designer", label: "Designer database", icon: Plus },
  { id: "builder", label: "Compositore query", icon: Layers3 },
  { id: "powershell", label: "Catalogo PowerShell", icon: Terminal },
  { id: "library", label: "Catalogo Query", icon: BookOpen },
  { id: "codegen", label: "Generatore codice", icon: Braces },
  { id: "transfer", label: "Import / Export", icon: DatabaseBackup },
  { id: "environments", label: "Ambienti locali", icon: Layers3 },
  { id: "laboratory", label: "Laboratorio", icon: FlaskConical },
  { id: "settings", label: "Impostazioni", icon: Settings },
];

export type NavigationGroupId = "database" | "catalog" | "tools";
export interface NavigationGroup {
  id: NavigationGroupId;
  label: string;
  icon: LucideIcon;
  items: readonly NavigationItem[];
}

function items(...ids: WorkspaceView[]): NavigationItem[] {
  return ids.map((id) => NAV_FLAT.find((item) => item.id === id)!);
}

export const NAV_GROUPS: readonly NavigationGroup[] = [
  {
    id: "database",
    label: "Database",
    icon: Database,
    items: items("data", "schema", "designer", "builder"),
  },
  {
    id: "catalog",
    label: "Catalogo",
    icon: BookOpen,
    items: items("powershell", "library"),
  },
  {
    id: "tools",
    label: "Strumenti",
    icon: Wrench,
    items: items("codegen", "transfer", "environments"),
  },
];

export const NAV_STANDALONE = items("files", "editor", "laboratory");

export function navigationGroupFor(
  view: WorkspaceView,
): NavigationGroupId | null {
  return (
    NAV_GROUPS.find((group) => group.items.some((item) => item.id === view))
      ?.id ?? null
  );
}

export function nextExpandedGroup(
  current: NavigationGroupId | null,
  action:
    | { type: "toggle"; group: NavigationGroupId }
    | { type: "navigate"; view: WorkspaceView },
): NavigationGroupId | null {
  if (action.type === "toggle")
    return current === action.group ? null : action.group;
  return navigationGroupFor(action.view) ?? current;
}
