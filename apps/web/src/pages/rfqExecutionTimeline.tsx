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
    label: "RFQ received",
    detail: "The local appliance receives the RFQ from the agent mailbox, WhatsApp, API, or Playground."
  },
  {
    id: "routeEvidence",
    label: "SAKBE route evidence",
    detail: "Route and toll evidence is resolved locally with the client's key."
  },
  {
    id: "quoteCore",
    label: "Quote-core pricing",
    detail: "Deterministic quote-core calculates the base rate. AI cannot override it."
  },
  {
    id: "tmsMapping",
    label: "Apply TMS canonical mapping",
    detail: "Saved canonical mappings normalize raw TMS data without LLM calls in runtime."
  },
  {
    id: "tmsHistorical",
    label: "TMS historical context",
    detail: "The appliance reads comparable quotes, lanes, liquidations, and costs locally."
  },
  {
    id: "criteriaRetriever",
    label: "Retrieve client criteria",
    detail: "Local RAG retrieves company criteria stored inside the client appliance."
  },
  {
    id: "approvalGate",
    label: "Approval gate",
    detail: "Policies decide auto-approval or director review."
  },
  {
    id: "writeback",
    label: "TMS writeback",
    detail: "Approved or queued quote results write back through the configured TMS adapter."
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
        <h3 id="rfq-execution-heading">RFQ execution timeline</h3>
      </div>
      <p className="system-note">
        This execution runs inside the local Docker appliance. The cloud receives only safe
        progress summaries, health, approval envelopes, and decisions.
      </p>
      <div className="timeline-run-id">
        {runId ? <code>{runId}</code> : <small>No RFQ requested yet.</small>}
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
  if (status === "review_required") return "review";
  return status.replace("_", " ");
}

export default RfqExecutionTimeline;
