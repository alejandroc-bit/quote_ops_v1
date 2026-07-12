import {
  Activity,
  CheckCircle2,
  CircleDashed,
  Loader2,
  TriangleAlert,
  XCircle
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { WorkflowNodeStatus } from "../api/quoteOpsApi";

export const rfqExecutionSteps = [
  {
    id: "intakePlanner",
    label: "Señal · Solicitud recibida",
    detail: "El appliance recibe la solicitud desde correo, API o playground."
  },
  {
    id: "routeEvidence",
    label: "Clasificación · Evidencia SAKBE",
    detail: "La ruta y las casetas se resuelven localmente con la llave del cliente."
  },
  {
    id: "quoteCore",
    label: "Análisis · Cálculo Quote-core",
    detail: "Quote-core calcula la tarifa base; la IA no puede modificarla."
  },
  {
    id: "tmsMapping",
    label: "Análisis · Mapeo canónico TMS",
    detail: "Los mapeos guardados normalizan el TMS sin llamadas al modelo en ejecución."
  },
  {
    id: "tmsHistorical",
    label: "Análisis · Contexto histórico TMS",
    detail: "El appliance consulta cotizaciones, rutas, liquidaciones y costos comparables."
  },
  {
    id: "criteriaRetriever",
    label: "Recomendación · Criterios del cliente",
    detail: "El RAG local recupera criterios almacenados dentro del appliance."
  },
  {
    id: "approvalGate",
    label: "Acción · Compuerta de aprobación",
    detail: "Las políticas deciden aprobación automática o revisión directiva."
  },
  {
    id: "writeback",
    label: "Acción · Escritura TMS",
    detail: "El resultado aprobado se escribe mediante el adaptador configurado."
  }
] as const;

export type RfqExecutionTimelineProps = {
  runId: string | null;
  nodeStatus: Record<string, WorkflowNodeStatus | undefined>;
};

export function RfqExecutionTimeline({ runId, nodeStatus }: RfqExecutionTimelineProps) {
  return (
    <article className="panel rfq-execution-timeline" aria-labelledby="rfq-execution-heading">
      <div className="panel-title">
        <Activity size={18} aria-hidden />
        <h3 id="rfq-execution-heading">Flujo de ejecución</h3>
      </div>
      <p className="system-note">
        La ejecución ocurre dentro del appliance Docker. La nube recibe solo resúmenes seguros,
        salud, solicitudes de aprobación y decisiones.
      </p>
      <div className="timeline-run-id">
        {runId ? <code>{runId}</code> : <small>Sin cotización activa.</small>}
      </div>
      <div className="workflow-timeline">
        {rfqExecutionSteps.map((step) => {
          const status = statusForStep(step.id, nodeStatus);
          const Icon = iconForStatus(status);

          return (
            <section className={`workflow-step workflow-step-${status}`} key={step.id}>
              <Icon size={18} aria-hidden />
              <div>
                <strong>{step.label}</strong>
                <small>{step.detail}</small>
              </div>
              <span className={statusClassName(status)}>{statusLabel(status)}</span>
            </section>
          );
        })}
      </div>
    </article>
  );
}

function statusForStep(
  stepId: string,
  nodeStatus: Record<string, WorkflowNodeStatus | undefined>
): WorkflowNodeStatus {
  const explicitStatus = nodeStatus[stepId];
  if (explicitStatus) return explicitStatus;
  if (stepId === "tmsMapping" && nodeStatus.tmsHistorical === "completed") {
    return "completed";
  }
  return "pending";
}

function iconForStatus(status: WorkflowNodeStatus): LucideIcon {
  if (status === "completed") return CheckCircle2;
  if (status === "running") return Loader2;
  if (status === "review_required") return TriangleAlert;
  if (status === "failed") return XCircle;
  return CircleDashed;
}

function statusClassName(status: WorkflowNodeStatus): string {
  if (status === "completed") return "status status-green";
  if (status === "failed" || status === "review_required") return "status status-amber";
  if (status === "running") return "status status-blue";
  return "status";
}

function statusLabel(status: WorkflowNodeStatus): string {
  if (status === "review_required") return "Revisión";
  if (status === "completed") return "Completado";
  if (status === "running") return "En proceso";
  if (status === "failed") return "Error";
  return "Pendiente";
}

export default RfqExecutionTimeline;
