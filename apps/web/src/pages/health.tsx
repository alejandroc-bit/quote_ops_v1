import { useCallback } from "react";
import {
  ArchiveRestore,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  Cloud,
  Cpu,
  Database,
  MailCheck,
  Route,
  Server,
  ShieldCheck,
  Truck
} from "lucide-react";
import { getHealth, type HealthSummary } from "../api/quoteOpsApi";
import { useAsyncResource } from "../api/useAsyncResource";

const dependencyItems = [
  {
    name: "TMS",
    status: "Configured",
    detail: "Adapter contract mounted in local appliance",
    icon: Truck
  },
  {
    name: "TMS mapping",
    status: "Deterministic",
    detail: "Canonical mapping status is kept inside the local appliance",
    icon: Database
  },
  {
    name: "SAKBE",
    status: "Live mode",
    detail: "Route and toll evidence requested through API",
    icon: Route
  },
  {
    name: "Email",
    status: "Draft only",
    detail: "Outbound approval is gated by client decision",
    icon: MailCheck
  },
  {
    name: "Model",
    status: "Guide mode",
    detail: "Agent can explain risk without changing quote-core",
    icon: BrainCircuit
  },
  {
    name: "Knowledge",
    status: "Local RAG",
    detail: "Criteria retrieval uses client-owned embedding keys",
    icon: BookOpen
  },
  {
    name: "Quote-core",
    status: "Healthy",
    detail: "Deterministic pricing package loaded",
    icon: Cpu
  },
  {
    name: "Control plane",
    status: "Local heartbeat",
    detail: "Client status can be mirrored to Inducta dashboard",
    icon: Cloud
  },
  {
    name: "Backup",
    status: "Configured",
    detail: "Last backup is managed by appliance scripts",
    icon: ArchiveRestore
  },
  {
    name: "License",
    status: "Setup gated",
    detail: "Signed activation status is surfaced by local setup state",
    icon: ShieldCheck
  }
];

export function HealthPage() {
  const loadHealth = useCallback(() => getHealth(), []);
  const { data, error, loading, reload } = useAsyncResource(loadHealth, [], 5000);
  const health = data ?? null;

  return (
    <section aria-labelledby="health-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">System readiness</p>
          <h2 id="health-heading">Health workspace</h2>
        </div>
        <div className="compact-stats">
          <span className={health?.ok ? "status status-green" : "status status-amber"}>
            {loading ? "Checking API" : health?.ok ? "API reporting" : "API unavailable"}
          </span>
          <span>live every 5s</span>
        </div>
      </div>

      {error ? (
        <div className="panel inline-error">
          <span>{error.message}</span>
          <button className="button button-secondary" onClick={reload} type="button">
            Retry
          </button>
        </div>
      ) : null}

      <div className="health-grid">
        {health ? <ApiHealthCard health={health} /> : null}
        {dependencyItems.map((item) => {
          const Icon = item.icon;

          return (
            <article className="panel health-card" key={item.name}>
              <div className="health-card-heading">
                <Icon size={20} aria-hidden />
                <h3>{item.name}</h3>
                <CheckCircle2 size={18} aria-hidden />
              </div>
              <strong>{item.status}</strong>
              <p>{item.detail}</p>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ApiHealthCard({ health }: { health: HealthSummary }) {
  return (
    <article className="panel health-card">
      <div className="health-card-heading">
        <Server size={20} aria-hidden />
        <h3>Versions</h3>
        <CheckCircle2 size={18} aria-hidden />
      </div>
      <strong>{health.product_version}</strong>
      <p>
        {health.workflow_runs} workflow runs / {health.heartbeats} heartbeats
      </p>
    </article>
  );
}

export default HealthPage;
