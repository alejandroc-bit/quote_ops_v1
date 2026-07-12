import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function PageSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="skeleton-panel" aria-label="Cargando contenido" aria-live="polite" role="status">
      <span className="sr-only">Cargando contenido</span>
      <div className="skeleton-line skeleton-line-title" />
      <div className="skeleton-grid">
        {Array.from({ length: rows }, (_, index) => (
          <div className="skeleton-row" key={index}>
            <div className="skeleton-block" />
            <div className="skeleton-lines">
              <div className="skeleton-line" />
              <div className="skeleton-line skeleton-line-short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({
  body,
  title
}: {
  body: string;
  title: string;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden>
        <Inbox size={20} />
      </span>
      <div>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
    </div>
  );
}

export function InlineError({
  action,
  message
}: {
  action?: ReactNode;
  message: string;
}) {
  return (
    <div className="panel inline-error" role="alert">
      <span className="inline-state-copy">
        <AlertTriangle size={18} aria-hidden />
        <span>{message}</span>
      </span>
      {action}
    </div>
  );
}
