import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

export const MENU_GROUPS = [
  "File",
  "Modifica",
  "Database",
  "Query",
  "Visualizza",
  "Strumenti",
  "AI",
  "Aiuto",
] as const;
export type MenuGroup = (typeof MENU_GROUPS)[number];
export interface WorkbenchCommand {
  id: string;
  group: MenuGroup;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  run: () => void;
}

export function WorkbenchMenu({ commands }: { commands: WorkbenchCommand[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const nav = useRef<HTMLElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const focusFirst = useRef(false);
  useEffect(() => {
    if (open === null) return;
    if (focusFirst.current)
      nav.current
        ?.querySelector<HTMLButtonElement>(
          "[role=menuitem]:not(:disabled):not([aria-haspopup])",
        )
        ?.focus();
    focusFirst.current = false;
    const outside = (event: PointerEvent) => {
      if (!nav.current?.contains(event.target as Node)) setOpen(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useEffect(() => {
    const focusMenu = (event: globalThis.KeyboardEvent) => {
      if (
        event.key === "F10" &&
        !event.shiftKey &&
        !document.querySelector("[role=dialog]")
      ) {
        event.preventDefault();
        buttons.current[0]?.focus();
      }
    };
    window.addEventListener("keydown", focusMenu);
    return () => window.removeEventListener("keydown", focusMenu);
  }, []);
  function keys(event: KeyboardEvent, index: number) {
    const target = event.target as HTMLElement;
    if (event.key === "Escape") {
      if (open === null) return;
      event.preventDefault();
      setOpen(null);
      buttons.current[index]?.focus();
      return;
    }
    if (["ArrowRight", "ArrowLeft"].includes(event.key)) {
      event.preventDefault();
      const next =
        (index + (event.key === "ArrowRight" ? 1 : -1) + MENU_GROUPS.length) %
        MENU_GROUPS.length;
      buttons.current[next]?.focus();
      if (open !== null) {
        focusFirst.current = true;
        setOpen(next);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (open !== index) {
      focusFirst.current = true;
      setOpen(index);
      return;
    }
    const items = [
      ...nav.current!.querySelectorAll<HTMLButtonElement>(
        '[role="menu"] button:not(:disabled)',
      ),
    ];
    if (!items.length) return;
    const pos = items.indexOf(target as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (pos + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next].focus();
  }
  return (
    <nav
      ref={nav}
      className="wb-menubar"
      aria-label="Menu principale"
      role="menubar"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOpen(null);
      }}
    >
      {MENU_GROUPS.map((group, index) => (
        <div
          key={group}
          className="wb-menu-holder"
          onKeyDown={(e) => keys(e, index)}
        >
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={open === index}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            onClick={() => setOpen(open === index ? null : index)}
          >
            {group}
          </button>
          {open === index && (
            <div role="menu" aria-label={group} className="wb-popup">
              {commands
                .filter((c) => c.group === group)
                .map((c) => (
                  <button
                    key={c.id}
                    role="menuitem"
                    type="button"
                    disabled={c.disabled}
                    onClick={() => {
                      setOpen(null);
                      buttons.current[index]?.focus();
                      c.run();
                    }}
                  >
                    {c.label}
                    {c.shortcut && <kbd>{c.shortcut}</kbd>}
                  </button>
                ))}
            </div>
          )}
        </div>
      ))}
    </nav>
  );
}
