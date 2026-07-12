import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ClipboardCheck,
  HeartPulse,
  LayoutDashboard,
  ListTree,
  Mail,
  RefreshCw,
  ShieldCheck,
  TriangleAlert
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

type ClientPortalPageKey = "inbox" | "runs" | "rfqs" | "knowledge" | "approvals" | "health";

const clientPortalPages: Array<DashboardPage<ClientPortalPageKey>> = [
  {
    key: "inbox",
    label: "Inbox",
    description: "Agent mailbox",
    icon: Mail,
    component: InboxPage
  },
  {
    key: "runs",
    label: "Runs",
    description: "Paso a paso del agente",
    icon: ListTree,
    component: RunsPage
  },
  {
    key: "rfqs",
    label: "RFQs",
    description: "Active quoting",
    icon: LayoutDashboard,
    component: RfqsPage
  },
  {
    key: "knowledge",
    label: "Knowledge",
    description: "Local RAG",
    icon: BookOpen,
    component: KnowledgePage
  },
  {
    key: "approvals",
    label: "Aprobaciones",
    description: "Director decisions",
    icon: ClipboardCheck,
    component: ApprovalsPage
  },
  {
    key: "health",
    label: "Health",
    description: "Local appliance",
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
          error={setupError ?? "Setup state is unavailable"}
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
      ? "Checking setup"
      : setupRequired
        ? "Setup required"
        : setupError
          ? "Setup check unavailable"
          : "Setup ready";
    return ["Local appliance", setupStatus, "Quote-core 2.0.0"];
  }, [setupError, setupLoading, setupRequired]);

  return (
    <AppShell
      activePage={activePage}
      ariaLabel="Client appliance portal"
      contentOverride={setupOverride}
      defaultPage={clientPortalPages[0]!}
      headerTitle="QuoteOps Client Appliance Portal"
      navDisabled={portalLocked}
      pages={clientPortalPages}
      productKicker="Local client product"
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
          <p className="eyebrow">Local appliance setup</p>
          <h2 id="setup-gate-heading">
            {isError ? "Setup check failed closed" : "Checking setup state"}
          </h2>
        </div>
        <div className="compact-stats">
          <span>{isError ? "operational pages blocked" : "setup-state pending"}</span>
        </div>
      </div>

      <article className={isError ? "panel setup-boundary-note setup-error-note" : "panel setup-boundary-note"}>
        {isError ? <TriangleAlert size={20} aria-hidden /> : <ShieldCheck size={20} aria-hidden />}
        <div>
          <strong>
            {isError ? "Cannot verify local setup state" : "Verifying local setup before RFQs"}
          </strong>
          <p>
            {isError
              ? error
              : "Operational pages stay locked until the local appliance reports signed activation and required setup steps."}
          </p>
        </div>
      </article>

      {isError ? (
        <div className="action-row">
          <button className="button button-secondary" onClick={onRetry} type="button">
            <RefreshCw size={16} aria-hidden />
            Retry setup check
          </button>
        </div>
      ) : null}
    </section>
  );
}
