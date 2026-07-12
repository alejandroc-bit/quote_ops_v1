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
import { InlineError, PageSkeleton } from "../UiStates";

const dependencyItems = [
  {
    name: "TMS",
    status: "Configurado",
    detail: "Contrato del adaptador montado en el appliance local",
    icon: Truck
  },
  {
    name: "Mapeo TMS",
    status: "Determinístico",
    detail: "El mapeo canónico permanece dentro del appliance local",
    icon: Database
  },
  {
    name: "SAKBE",
    status: "Modo en vivo",
    detail: "Evidencia de ruta y casetas consultada por API",
    icon: Route
  },
  {
    name: "Correo",
    status: "Solo borrador",
    detail: "El envío queda bloqueado hasta la decisión del cliente",
    icon: MailCheck
  },
  {
    name: "Modelo",
    status: "Modo guía",
    detail: "Explica el riesgo sin modificar Quote-core",
    icon: BrainCircuit
  },
  {
    name: "Conocimiento",
    status: "RAG local",
    detail: "Los criterios usan llaves de embeddings del cliente",
    icon: BookOpen
  },
  {
    name: "Quote-core",
    status: "Operativo",
    detail: "Motor determinístico de precios cargado",
    icon: Cpu
  },
  {
    name: "Plano de control",
    status: "Pulso local",
    detail: "El estado del cliente se refleja en el panel de Inducta",
    icon: Cloud
  },
  {
    name: "Respaldo",
    status: "Configurado",
    detail: "Los scripts del appliance administran el último respaldo",
    icon: ArchiveRestore
  },
  {
    name: "Licencia",
    status: "Controlada",
    detail: "La configuración local valida la activación firmada",
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
          <p className="eyebrow">Disponibilidad del sistema</p>
          <h2 id="health-heading">Estado operativo</h2>
        </div>
        <div className="compact-stats">
          <span className={health?.ok ? "status status-green" : "status status-amber"}>
            {loading ? "Verificando API" : health?.ok ? "API operativa" : "API no disponible"}
          </span>
          <span>Actualización cada 5 s</span>
        </div>
      </div>

      {error ? (
        <InlineError
          message={error.message}
          action={<button className="button button-secondary" onClick={reload} type="button">Reintentar</button>}
        />
      ) : null}

      {loading && !health ? <PageSkeleton rows={4} /> : null}

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
        <h3>Versiones</h3>
        <CheckCircle2 size={18} aria-hidden />
      </div>
      <strong>{health.product_version}</strong>
      <p>
        {health.workflow_runs} corridas / {health.heartbeats} pulsos
      </p>
    </article>
  );
}

export default HealthPage;
