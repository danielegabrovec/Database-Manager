import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ChevronDown } from "lucide-react";
import {
  NAV_GROUPS,
  NAV_STANDALONE,
  navigationGroupFor,
  nextExpandedGroup,
} from "../navigation";
import type {
  NavigationGroupId,
  NavigationItem,
  WorkspaceView,
} from "../navigation";
import "../sidebar-navigation.css";

export interface WorkspaceNavigationProps {
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
}

export function WorkspaceNavigation({
  view,
  onNavigate,
}: WorkspaceNavigationProps) {
  const prefix = useId();
  const nav = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState<NavigationGroupId | null>(() =>
    navigationGroupFor(view),
  );
  useEffect(() => {
    setExpanded((current) =>
      nextExpandedGroup(current, { type: "navigate", view }),
    );
  }, [view]);

  function toggle(group: NavigationGroupId) {
    setExpanded((current) =>
      nextExpandedGroup(current, { type: "toggle", group }),
    );
  }

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;
    const buttons = Array.from(
      nav.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    ).filter((button) => !button.closest("[hidden]"));
    const index = buttons.indexOf(target);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = buttons[(index + 1) % buttons.length];
    else if (event.key === "ArrowUp")
      next = buttons[(index - 1 + buttons.length) % buttons.length];
    else if (event.key === "Home") next = buttons[0];
    else if (event.key === "End") next = buttons.at(-1);
    else if (event.key === "ArrowRight" && target.dataset.group) {
      setExpanded(target.dataset.group as NavigationGroupId);
      event.preventDefault();
    } else if (event.key === "ArrowLeft") {
      const group = target.dataset.group ?? target.dataset.parentGroup;
      if (group) {
        setExpanded(null);
        nav.current
          ?.querySelector<HTMLButtonElement>(`[data-group="${group}"]`)
          ?.focus();
        event.preventDefault();
      }
    }
    if (next) {
      event.preventDefault();
      next.focus();
    }
  }

  function itemButton(item: NavigationItem, parent?: NavigationGroupId) {
    return (
      <button
        type="button"
        key={item.id}
        title={item.label}
        className={`workspace-nav-item ${view === item.id ? "active" : ""}`}
        aria-current={view === item.id ? "page" : undefined}
        data-parent-group={parent}
        onClick={() => onNavigate(item.id)}
      >
        <item.icon size={16} aria-hidden="true" />
        <span>{item.label}</span>
        {item.id === "laboratory" && <small>IMPARA</small>}
      </button>
    );
  }

  return (
    <nav
      className="workspace-navigation"
      aria-label="Navigazione del workspace"
      ref={nav}
      onKeyDown={handleKey}
    >
      {NAV_STANDALONE.slice(0, 2).map((item) => itemButton(item))}
      <div className="workspace-nav-groups">
        {NAV_GROUPS.map((group) => {
          const isOpen = expanded === group.id;
          const containsActive = navigationGroupFor(view) === group.id;
          const id = `${prefix}-${group.id}`;
          return (
            <div className="workspace-nav-group" key={group.id}>
              <button
                type="button"
                className={`workspace-nav-heading ${containsActive ? "contains-active" : ""}`}
                aria-expanded={isOpen}
                aria-controls={`${id}-items`}
                id={`${id}-heading`}
                data-group={group.id}
                onClick={() => toggle(group.id)}
              >
                <group.icon size={16} aria-hidden="true" />
                <span>{group.label}</span>
                <ChevronDown
                  size={14}
                  className="workspace-nav-chevron"
                  aria-hidden="true"
                />
              </button>
              <div
                id={`${id}-items`}
                className="workspace-nav-children"
                hidden={!isOpen}
                role="group"
                aria-labelledby={`${id}-heading`}
              >
                {group.items.map((item) => itemButton(item, group.id))}
              </div>
            </div>
          );
        })}
      </div>
      {NAV_STANDALONE.slice(2).map((item) => itemButton(item))}
    </nav>
  );
}
