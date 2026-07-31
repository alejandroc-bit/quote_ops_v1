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

export type WorkflowNodeStatus =
  | "pending"
  | "running"
  | "completed"
  | "review_required"
  | "failed";

export type SetupStepId =
  | "activate_license"
  | "configure_secrets"
  | "connect_cloudflare"
  | "connect_tms"
  | "map_tms"
  | "connect_knowledge_base"
  | "connect_mailbox"
  | "connect_sakbe"
  | "run_test_rfq";

export type SetupState = {
  activation: {
    required: boolean;
    status: "locked" | "unlocked" | string;
    client_id: string | null;
    installation_id: string | null;
  };
  tunnel: {
    provider: "cloudflare";
    required: true;
    status:
      | "missing_config"
      | "missing_token"
      | "starting"
      | "ready"
      | "unreachable"
      | "access_unprotected"
      | "pending_manual_public_validation";
    public_hostname: string | null;
    last_checked_at: string;
  };
  required_steps: SetupStepId[];
};

export type ActivateApplianceResponse = {
  activated: boolean;
  client_id: string;
  installation_id: string;
};

export type WorkflowRunDetail = {
  run_id: string;
  client_id: string;
  raw_rfq: {
    rfq_id: string;
    source: string;
    parsed: {
      lanes: Array<{
        lane_id: string;
        origin: { city: string; state: string; country: string };
        destination: { city: string; state: string; country: string };
        equipment_request: string;
        vehicle_profile_id: string | null;
        cargo: {
          weight_kg: number | null;
          commodity: string | null;
          value_mxn: number | null;
        };
        commercial: {
          business_unit_id: string | null;
          customer_id: string | null;
        };
      }>;
    };
  };
  route_evidence: {
    status: string;
    source: string;
    km_loaded: number | null;
    estimated_minutes: number | null;
    tolls_mxn: number | null;
  } | null;
  historical_context: {
    selected_layer?: string;
    median_rate_mxn?: number;
    insufficient_data?: Array<{ layer: string; reason: string }>;
    unavailable?: boolean;
  } | null;
  base_quote: {
    status: string;
    base_rate_mxn: number;
    route_source: string;
    review_reasons: string[];
  } | null;
  recommendation: {
    status: string;
    recommended_rate_mxn: number;
    reason: string;
  } | null;
  approval_state: {
    required: boolean;
    reasons: string[];
  } | null;
  writeback_result: {
    status: string;
    quote_id?: string;
    [key: string]: unknown;
  } | null;
  node_status: Record<string, WorkflowNodeStatus | undefined>;
  runtime_review_reasons: string[];
};

export type PlaygroundRfqRequest = {
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
  vehicle_profile_id?: string;
  equipment_request?: string;
  weight_kg: number | null;
  commodity?: string;
  commodity_category?: string;
  sector?: string;
  value_mxn?: number | null;
  requester_name?: string;
  requester_email?: string;
  company_alias?: string;
  customer_id?: string;
  customer_type?: string;
  business_unit_id?: string;
  route_policy?: string;
};

export type PlaygroundRfqResponse = {
  run_id: string;
  rfq_id: string;
  status: string;
  approval_required: boolean;
  route_source: string | null;
  base_rate_mxn: number | null;
  recommended_rate_mxn: number | null;
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
  decision_status: string;
  created_at: string;
  updated_at: string;
};

export type HealthSummary = {
  ok: boolean;
  product_version: string;
  workflow_runs: number;
  heartbeats: number;
};

export type ApprovalDecisionAction = "approve" | "adjust" | "reject" | "request_review";

export type ApprovalDecisionResponse = {
  run_id: string;
  approval_decision: {
    action: ApprovalDecisionAction;
    rate_mxn?: number;
    reason?: string;
    email_sent: boolean;
    decided_at: string;
  };
  writeback_result: {
    status: string;
    quote_id?: string;
    [key: string]: unknown;
  } | null;
};

type ItemsResponse<T> = {
  items: T[];
};

const API_BASE_URL = getApiBaseUrl();

export async function listRfqs(): Promise<WorkflowRunSummary[]> {
  const response = await apiRequest<ItemsResponse<WorkflowRunSummary>>("/api/rfqs");
  return response.items;
}

export async function getRfq(runId: string): Promise<WorkflowRunDetail> {
  return apiRequest<WorkflowRunDetail>(`/api/rfqs/${encodeURIComponent(runId)}`);
}

export async function submitPlaygroundRfq(
  request: PlaygroundRfqRequest
): Promise<PlaygroundRfqResponse> {
  return apiRequest<PlaygroundRfqResponse>("/api/playground/rfqs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
}

export async function listApprovals(): Promise<ApprovalEnvelope[]> {
  const response = await apiRequest<ItemsResponse<ApprovalEnvelope>>("/api/approvals");
  return response.items;
}

export async function submitDecision(
  runId: string,
  decision: {
    action: ApprovalDecisionAction;
    rate_mxn?: number;
    reason?: string;
  }
): Promise<ApprovalDecisionResponse> {
  return apiRequest<ApprovalDecisionResponse>(`/api/approvals/${encodeURIComponent(runId)}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(decision)
  });
}

export async function getHealth(): Promise<HealthSummary> {
  return apiRequest<HealthSummary>("/api/health");
}

export async function getSetupState(): Promise<SetupState> {
  return apiRequest<SetupState>("/api/setup-state");
}

export async function activateAppliance(email: string): Promise<ActivateApplianceResponse> {
  return apiRequest<ActivateApplianceResponse>("/api/onboarding/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email })
  });
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init);
  const body = await response.text();
  const parsed = body ? JSON.parse(body) : null;

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String(parsed.message)
        : `QuoteOps API request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return parsed as T;
}

function getApiBaseUrl(): string {
  if (typeof window === "undefined") return "";
  const runtimeBase = (window as unknown as { __QUOTEOPS_API_BASE_URL__?: string })
    .__QUOTEOPS_API_BASE_URL__;
  return runtimeBase ? runtimeBase.replace(/\/$/, "") : "";
}
