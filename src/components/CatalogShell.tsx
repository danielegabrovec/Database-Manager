import { useId } from "react";
import type { ReactNode } from "react";
import "../catalog-layout.css";

export interface CatalogShellProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function CatalogShell({
  title,
  description,
  actions,
  children,
  className = "",
}: CatalogShellProps) {
  const headingId = useId();
  return (
    <section
      className={`view-content catalog-shell ${className}`}
      aria-labelledby={headingId}
    >
      <header className="catalog-heading">
        <div>
          <h1 id={headingId}>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="catalog-heading-actions">{actions}</div>}
      </header>
      <div className="catalog-content">{children}</div>
    </section>
  );
}
