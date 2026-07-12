import type { AuditEvent } from "@quoteops/audit";
import type { Rfq } from "@quoteops/contracts";
import type { CriteriaNode, RetrievedCriteria } from "@quoteops/criteria";
import type {
  HistoricalContext,
  QuoteCoreInput,
  QuoteCoreResult,
  QuoteManifest,
  QuoteRfqLaneInput,
  RouteEvidence,
  RfqBatchChild
} from "@quoteops/quote-core";

export type NodeStatus = "pending" | "completed" | "review_required" | "failed";

export type QuoteWorkflowNode =
  | "intakePlanner"
  | "normalizer"
  | "profileResolver"
  | "batchSplitter"
  | "routeEvidence"
  | "quoteCore"
  | "tmsHistorical"
  | "criteriaRetriever"
  | "historicalAnalyst"
  | "pricingRecommendation"
  | "approvalGate"
  | "commsAgent"
  | "writeback"
  | "audit";

export type RecommendationToolResult = {
  recommended_rate_mxn: number;
  reason: string;
};

export type QuoteWorkflowTools = {
  resolveRoute(input: QuoteRfqLaneInput): Promise<RouteEvidence>;
  searchHistorical(input: QuoteCoreInput): Promise<HistoricalContext>;
  recommend(input: {
    base_rate_mxn: number;
    historical_context: HistoricalContext;
    criteria_context: RetrievedCriteria;
  }): Promise<RecommendationToolResult>;
  writeback(input: {
    quote: QuoteCoreResult;
    recommendation: QuoteRecommendationState;
    approval_state: { required: boolean; reasons: string[] } | null;
  }): Promise<QuoteWritebackResult>;
  /** Optional: fresh unit yields from the TMS for the manifest overlay. */
  getUnitPerformance?(): Promise<Array<{ unit_type: string; kpl_yield: number; real_cost_per_km: number }>>;
  /** Optional: retrieve commercial-criteria excerpts from the local vector store. */
  retrieveKnowledge?(
    query: string,
    clientId: string
  ): Promise<Array<{ chunk_id: string; text: string }>>;
};

export type QuoteWorkflowInput = {
  run_id: string;
  client_id: string;
  manifest_version: string;
  criteria_version: string;
  connector_versions: Record<string, string>;
  raw_rfq: Rfq;
  manifest: QuoteManifest;
  criteria_nodes: CriteriaNode[];
  tools: QuoteWorkflowTools;
  /** Review reasons known before the graph runs (e.g. stale TMS performance). */
  seed_review_reasons?: string[];
};

export type QuoteRecommendationState =
  | {
      status: "completed";
      recommended_rate_mxn: number;
      reason: string;
    }
  | {
      status: "failed";
      recommended_rate_mxn: number;
      reason: string;
      error: string;
    };

export type QuoteApprovalState = {
  required: boolean;
  reasons: string[];
};

export type QuoteEmailDraft = {
  subject: string;
  body: string;
};

export type QuoteWritebackResult = {
  status: string;
  quote_id?: string;
  [key: string]: unknown;
};

export type QuoteChildResult = {
  child_rfq_id: string;
  lane_id: string;
  lane: QuoteRfqLaneInput;
  route_evidence: RouteEvidence | null;
  base_quote: QuoteCoreResult | null;
  historical_context: HistoricalContext;
  criteria_context: RetrievedCriteria | null;
  recommendation: QuoteRecommendationState | null;
};

export type QuoteWorkflowState = QuoteWorkflowInput & {
  quote_core_version?: string;
  raw_rfq: Rfq;
  normalized_rfq: Rfq | null;
  batch_queue: RfqBatchChild[];
  active_child_rfq: QuoteRfqLaneInput | null;
  child_results: QuoteChildResult[];
  writeback_results: QuoteWritebackResult[];
  route_evidence: RouteEvidence | null;
  base_quote: QuoteCoreResult | null;
  historical_context: HistoricalContext;
  criteria_context: RetrievedCriteria | null;
  recommendation: QuoteRecommendationState | null;
  approval_state: QuoteApprovalState | null;
  email_draft: QuoteEmailDraft | null;
  writeback_result: QuoteWritebackResult | null;
  audit_events: AuditEvent[];
  node_status: Partial<Record<QuoteWorkflowNode, NodeStatus>>;
  runtime_review_reasons: string[];
};

export function initialWorkflowState(input: QuoteWorkflowInput): QuoteWorkflowState {
  return {
    ...input,
    normalized_rfq: null,
    batch_queue: [],
    active_child_rfq: null,
    child_results: [],
    writeback_results: [],
    route_evidence: null,
    base_quote: null,
    historical_context: null,
    criteria_context: null,
    recommendation: null,
    approval_state: null,
    email_draft: null,
    writeback_result: null,
    audit_events: [],
    node_status: {},
    runtime_review_reasons: [...(input.seed_review_reasons ?? [])]
  };
}
