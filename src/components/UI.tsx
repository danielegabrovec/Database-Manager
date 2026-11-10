import { X, LoaderCircle, Info } from "lucide-react";
import type { ReactNode, ButtonHTMLAttributes } from "react";
import { useEffect, useRef } from "react";
const modalStack: symbol[] = [];

export function Button({
  children,
  variant = "secondary",
  busy = false,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  busy?: boolean;
}) {
  return (
    <button
      {...props}
      className={`button ${variant} ${props.className || ""}`}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
    >
      {busy && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
  fullScreen = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  fullScreen?: boolean;
}) {
  const element = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const token = Symbol("modal");
    modalStack.push(token);
    const previous = document.activeElement as HTMLElement | null;
    const current = element.current;
    const focusable = () =>
      Array.from(
        current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]',
        ) || [],
      ).filter(
        (item) =>
          item.offsetParent !== null && !item.closest("[hidden], [inert]"),
      );
    if (current && !current.contains(document.activeElement))
      (
        current.querySelector<HTMLElement>("[data-autofocus], [autofocus]") ||
        focusable()[0] ||
        current
      ).focus();
    const key = (event: KeyboardEvent) => {
      if (modalStack.at(-1) !== token) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0],
          last = items[items.length - 1];
        if (!items.length) {
          event.preventDefault();
          current?.focus();
        } else if (!current?.contains(document.activeElement)) {
          event.preventDefault();
          first?.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      const wasTop = modalStack.at(-1) === token;
      modalStack.splice(modalStack.indexOf(token), 1);
      document.removeEventListener("keydown", key, true);
      if (wasTop && previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={element}
        className={`modal ${wide ? "wide" : ""} ${fullScreen ? "full-screen" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" aria-label="Chiudi" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warning" | "error" | "success";
}) {
  return (
    <div className={`notice ${tone}`}>
      <Info size={16} />
      <div>{children}</div>
    </div>
  );
}
export function Empty({
  icon,
  title,
  children,
  action,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function SectionHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}
