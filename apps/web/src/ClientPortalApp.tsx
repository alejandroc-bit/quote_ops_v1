import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ClipboardCheck,
  HeartPulse,
  LayoutDashboard,
  ListTree,
  Mail,
  RefreshCw,
} from "lucide-react";
import { getSetupState, type SetupState } from "./api/quoteOpsApi";
import { AppShell, type DashboardPage } from "./AppShell";
import { ApprovalsPage } from "./pages/approvals";
import { ClientSetupWizard } from "./pages/clientSetupWizard";
import { HealthPage } from "./pages/health";
import { InboxPage } from "./pages/inbox";
import { KnowledgePage } from "./pages/knowledge";
import { RfqsPage } from "./pages/rfqs";
import { NAVIGATE_EVENT, RunsPage } from "./pages/runs";
import { InlineError, PageSkeleton } from "./UiStates";

type ClientPortalPageKey = "inbox" | "runs" | "rfqs" | "knowledge" | "approvals" | "health";

const clientPortalPages: Array<DashboardPage<ClientPortalPageKey>> = [
  {
    key: "inbox",
    label: "Bandeja",
    description: "Entrada de solicitudes",
    icon: Mail,
    component: InboxPage
  },
  {
    key: "runs",
    label: "Corridas",
    description: "Flujo de control",
    icon: ListTree,
    component: RunsPage
  },
  {
    key: "rfqs",
    label: "Cotizaciones",
    description: "Operación activa",
    icon: LayoutDashboard,
    component: RfqsPage
  },
  {
    key: "knowledge",
    label: "Conocimiento",
    description: "Contexto local",
    icon: BookOpen,
    component: KnowledgePage
  },
  {
    key: "approvals",
    label: "Aprobaciones",
    description: "Decisiones humanas",
    icon: ClipboardCheck,
    component: ApprovalsPage
  },
  {
    key: "health",
    label: "Estado",
    description: "Appliance local",
    icon: HeartPulse,
    component: HealthPage
  }
];

export function ClientPortalApp() {
  const [activePage, setActivePage] = useState<ClientPortalPageKey>("inbox");
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLoading, setSetupLoading] = useState(true);

  const loadSetupState = useCallback(() => {
    setSetupLoading(true);
    setSetupError(null);
    getSetupState()
      .then((nextSetup) => {
        setSetup(nextSetup);
        setSetupError(null);
      })
      .catch((caught) => {
        setSetup(null);
        setSetupError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        setSetupLoading(false);
      });
  }, []);

  useEffect(() => {
    loadSetupState();
  }, [loadSetupState]);

  useEffect(() => {
    // in-app navigation requests from pages (e.g. run detail → approvals)
    const onNavigate = (event: Event) => {
      const page = (event as CustomEvent<string>).detail;
      if (clientPortalPages.some((candidate) => candidate.key === page)) {
        setActivePage(page as ClientPortalPageKey);
      }
    };
    window.addEventListener(NAVIGATE_EVENT, onNavigate);
    return () => window.removeEventListener(NAVIGATE_EVENT, onNavigate);
  }, []);

  const setupRequired = Boolean(
    setup &&
      (setup.required_steps.length > 0 ||
        (setup.activation.required && setup.activation.status !== "unlocked"))
  );
  const portalLocked = setupLoading || setupError !== null || !setup || setupRequired;
  const setupOverride = useMemo(() => {
    if (setupLoading) {
      return <SetupGateStatus mode="loading" />;
    }
    if (setupError || !setup) {
      return (
        <SetupGateStatus
          error={setupError ?? "El estado de configuración no está disponible."}
          mode="error"
          onRetry={loadSetupState}
        />
      );
    }
    if (setupRequired) {
      return <ClientSetupWizard setup={setup} />;
    }
    return undefined;
  }, [loadSetupState, setup, setupError, setupLoading, setupRequired]);
  const runtimeItems = useMemo(() => {
    const setupStatus = setupLoading
      ? "Verificando configuración"
      : setupRequired
        ? "Configuración pendiente"
        : setupError
          ? "Verificación no disponible"
          : "Configuración lista";
    return ["Appliance local", setupStatus, "Quote-core 2.0.0"];
  }, [setupError, setupLoading, setupRequired]);

  return (
    <AppShell
      activePage={activePage}
      ariaLabel="Navegación del appliance"
      contentOverride={setupOverride}
      defaultPage={clientPortalPages[0]!}
      headerTitle="QuoteOps · Operación local"
      navDisabled={portalLocked}
      pages={clientPortalPages}
      productKicker="Inducta / operaciones críticas"
      runtimeItems={runtimeItems}
      setActivePage={setActivePage}
    />
  );
}

function SetupGateStatus({
  error,
  mode,
  onRetry
}: {
  error?: string;
  mode: "loading" | "error";
  onRetry?: () => void;
}) {
  const isError = mode === "error";

  return (
    <section className="workspace" aria-labelledby="setup-gate-heading">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Configuración del appliance</p>
          <h2 id="setup-gate-heading">
            {isError ? "No pudimos verificar la configuración" : "Verificando el entorno local"}
          </h2>
        </div>
        <div className="compact-stats">
          <span>{isError ? "Operación bloqueada" : "Validación en curso"}</span>
        </div>
      </div>

      {isError ? (
        <InlineError message={error ?? "No se pudo verificar el entorno local."} />
      ) : (
        <PageSkeleton rows={3} />
      )}

      {isError ? (
        <div className="action-row">
          <button className="button button-secondary" onClick={onRetry} type="button">
            <RefreshCw size={16} aria-hidden />
            Reintentar verificación
          </button>
        </div>
      ) : null}
    </section>
  );
}
