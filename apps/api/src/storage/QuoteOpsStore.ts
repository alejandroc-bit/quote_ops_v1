import type { QuoteWorkflowState } from "@quoteops/agent";

export type DecisionStatus = "pending" | "approved" | "adjusted" | "rejected" | "review_requested";

export type ApprovalDecision = {
  action: "approve" | "adjust" | "reject" | "request_review";
  rate_mxn?: number;
  reason?: string;
  email_sent: boolean;
  decided_at: string;
};

export type WorkflowRunSummary = {
  run_id: string;
  client_id: string;
  rfq_id: string;
  status: string;
  approval_required: boolean;
  route_source: string | null;
  base_rate_mxn: number | null;
  recommended_rate_mxn: number | null;
  created_at: string;
  updated_at: string;
};

export type ApprovalEnvelope = {
  envelope_id: string;
  run_id: string;
  client_id: string;
  installation_id: string;
  rfq_id: string;
  lane: {
    origin: string;
    destination: string;
  };
  equipment: string | null;
  weight_kg: number | null;
  base_rate_mxn: number | null;
  recommended_rate_mxn: number | null;
  review_reasons: string[];
  evidence_flags: {
    route_source: string | null;
    route_resolved: boolean;
    historical_layer: string | null;
    quote_core_status: string | null;
  };
  decision_status: DecisionStatus;
  created_at: string;
  updated_at: string;
};

export type ApplianceHeartbeat = {
  client_id: string;
  installation_id: string;
  version: string;
  connector_health: Record<string, unknown>;
  queue_depth: number;
  pending_approvals: number;
  last_successful_rfq_at: string | null;
  last_backup_at: string | null;
  disk_usage: Record<string, unknown>;
  error_counts: Record<string, number>;
  received_at: string;
};

export type AgentRunStatus = "running" | "waiting_approval" | "done" | "error";

export type AgentRun = {
  run_id: string;
  channel: "email" | "whatsapp";
  status: AgentRunStatus;
  summary: string;
  created_at: string;
  updated_at: string;
};

export type CreateAgentRun = Pick<AgentRun, "run_id" | "channel" | "status" | "summary">;

export type StepEvent = {
  run_id: string;
  seq: number;
  node: string;
  status: "start" | "end" | "error";
  summary: string;
  data?: unknown;
  ts: string;
};

export type QuoteOpsStore = {
  saveWorkflowRun(run: QuoteWorkflowState): Promise<void>;
  getWorkflowRun(runId: string): Promise<QuoteWorkflowState | null>;
  listWorkflowRuns(): Promise<WorkflowRunSummary[]>;
  listApprovalEnvelopes(): Promise<ApprovalEnvelope[]>;
  saveApprovalDecision(runId: string, decision: ApprovalDecision): Promise<void>;
  getApprovalDecision(runId: string): Promise<ApprovalDecision | null>;
  saveHeartbeat(heartbeat: ApplianceHeartbeat): Promise<void>;
  listHeartbeats(): Promise<ApplianceHeartbeat[]>;
  createRun(run: CreateAgentRun): Promise<void>;
  updateRunStatus(runId: string, status: AgentRunStatus, summary: string): Promise<void>;
  appendStep(step: StepEvent): Promise<void>;
  listRuns(limit?: number): Promise<AgentRun[]>;
  getRun(runId: string): Promise<AgentRun | null>;
  getSteps(runId: string): Promise<StepEvent[]>;
  claimRunForResume(runId: string): Promise<boolean>;
};

export type WorkflowRunProjectionOptions = {
  createdAt?: string;
  updatedAt?: string;
  installationId?: string | null;
};

export function summarizeWorkflowRun(
  run: QuoteWorkflowState,
  options: WorkflowRunProjectionOptions = {}
): WorkflowRunSummary {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const updatedAt = options.updatedAt ?? createdAt;
  const children = run.child_results ?? [];
  const quoted = children.filter((child) => child.base_quote);
  const baseRate =
    quoted.length > 1
      ? quoted.reduce((total, child) => total + (child.base_quote?.base_rate_mxn ?? 0), 0)
      : run.base_quote?.base_rate_mxn ?? null;
  const recommendedRate =
    quoted.length > 1
      ? quoted.reduce(
          (total, child) => total + (child.recommendation?.recommended_rate_mxn ?? 0),
          0
        )
      : run.recommendation?.recommended_rate_mxn ?? null;
  return {
    run_id: run.run_id,
    client_id: run.client_id,
    rfq_id: run.raw_rfq.rfq_id,
    status: run.approval_state?.required
      ? "REVIEW_REQUIRED"
      : run.base_quote?.status ?? "UNKNOWN",
    approval_required: run.approval_state?.required ?? false,
    route_source: run.base_quote?.route_source ?? run.route_evidence?.source ?? null,
    base_rate_mxn: baseRate,
    recommended_rate_mxn: recommendedRate,
    created_at: createdAt,
    updated_at: updatedAt
  };
}

export function buildApprovalEnvelope(
  run: QuoteWorkflowState,
  options: WorkflowRunProjectionOptions = {}
): ApprovalEnvelope | null {
  if (!run.approval_state?.required) return null;

  const lane = run.active_child_rfq ?? run.raw_rfq.parsed.lanes[0] ?? null;
  if (!lane) return null;

  const installationId = options.installationId?.trim();
  if (!installationId) return null;

  const createdAt = options.createdAt ?? new Date().toISOString();
  const updatedAt = options.updatedAt ?? createdAt;
  return {
    envelope_id: `appr-${run.run_id}`,
    run_id: run.run_id,
    client_id: run.client_id,
    installation_id: installationId,
    rfq_id: run.raw_rfq.rfq_id,
    lane: {
      origin: formatLocation(lane.origin),
      destination: formatLocation(lane.destination)
    },
    equipment: getEquipment(lane),
    weight_kg: lane.cargo.weight_kg ?? null,
    base_rate_mxn: run.base_quote?.base_rate_mxn ?? null,
    recommended_rate_mxn: run.recommendation?.recommended_rate_mxn ?? null,
    review_reasons: run.approval_state.reasons,
    evidence_flags: {
      route_source: run.base_quote?.route_source ?? run.route_evidence?.source ?? null,
      route_resolved: run.route_evidence?.status === "resolved",
      historical_layer: run.historical_context?.selected_layer ?? null,
      quote_core_status: run.base_quote?.status ?? null
    },
    decision_status: "pending",
    created_at: createdAt,
    updated_at: updatedAt
  };
}

function formatLocation(location: { city: string; state: string; country?: string }): string {
  return [location.city, location.state].filter(Boolean).join(", ");
}

function getEquipment(lane: { vehicle_profile_id?: string | null; equipment_request?: string | null }): string | null {
  return lane.vehicle_profile_id ?? lane.equipment_request ?? null;
}
