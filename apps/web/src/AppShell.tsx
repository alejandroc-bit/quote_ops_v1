import { Activity, Boxes } from "lucide-react";
import type React from "react";
import type { LucideIcon } from "lucide-react";

export type DashboardPage<PageKey extends string> = {
  key: PageKey;
  label: string;
  description: string;
  icon: LucideIcon;
  component: React.ComponentType;
};

export function AppShell<PageKey extends string>({
  activePage,
  ariaLabel,
  defaultPage,
  headerTitle,
  contentOverride,
  navDisabled = false,
  pages,
  productKicker,
  runtimeItems,
  setActivePage
}: {
  activePage: PageKey;
  ariaLabel: string;
  defaultPage: DashboardPage<PageKey>;
  headerTitle: string;
  contentOverride?: React.ReactNode;
  navDisabled?: boolean;
  pages: Array<DashboardPage<PageKey>>;
  productKicker: string;
  runtimeItems: string[];
  setActivePage: (page: PageKey) => void;
}) {
  const page = pages.find((candidate) => candidate.key === activePage) ?? defaultPage;
  const ActiveComponent = page.component;

  return (
    <div className="dashboard-shell">
      <a className="skip-link" href="#main-content">Saltar al contenido</a>
      <header className="dashboard-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden><Boxes size={21} /></span>
          <div>
            <p className="dashboard-kicker">{productKicker}</p>
            <h1>{headerTitle}</h1>
          </div>
        </div>
        <div className="runtime-strip" aria-label="Resumen operativo">
          {runtimeItems.map((item, index) => (
            <span key={item}>
              {index === 0 ? <Activity size={16} aria-hidden /> : null}
              {item}
            </span>
          ))}
        </div>
      </header>

      <div className="dashboard-layout">
        <nav className="dashboard-nav" aria-label={ariaLabel}>
          {pages.map((candidate) => {
            const Icon = candidate.icon;
            const selected = !navDisabled && candidate.key === activePage;

            return (
              <button
                aria-current={selected ? "page" : undefined}
                className={[
                  "nav-item",
                  selected ? "nav-item-active" : "",
                  navDisabled ? "nav-item-disabled" : ""
                ].filter(Boolean).join(" ")}
                disabled={navDisabled}
                key={candidate.key}
                onClick={() => setActivePage(candidate.key)}
                type="button"
              >
                <Icon size={18} aria-hidden />
                <span>
                  <strong>{candidate.label}</strong>
                  <small>{candidate.description}</small>
                </span>
              </button>
            );
          })}
        </nav>

        <main className="dashboard-main" id="main-content" tabIndex={-1}>
          {contentOverride ?? <ActiveComponent />}
        </main>
      </div>
    </div>
  );
}
