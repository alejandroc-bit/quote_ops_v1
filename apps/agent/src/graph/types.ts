import type { AuditEvent } from "@quoteops/audit";
import type { Rfq } from "@quoteops/contracts";
import type {
  HistoricalContext,
  QuoteCoreResult,
  QuoteManifest,
  QuoteRfqLaneInput,
  RouteEvidence
} from "@quoteops/quote-core";
import type { IntakeEmail } from "../intake/extractRfq.js";
import type { QuoteWorkflowTools } from "../state.js";
import type { QuoteAgentState } from "./state.js";
import type { z } from "zod";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

export type AgentChannel = "email" | "whatsapp";
export type IntakeKind = "single" | "multi_text" | "bulk_file";
export type ApprovalAction = "approve" | "adjust" | "reject" | "request_review";

export type AgentApproval = {
  action: ApprovalAction;
  rate_mxn?: number;
};

export type AgentRecommendation = {
  lane_id: string;
  verdict: "auto" | "needs_review" | "unknown_route";
  reason: string;
  suggested_rate_mxn?: number;
  clamped?: boolean;
};

export type LaneHistoricalContext = {
  lane_id: string;
  context: HistoricalContext;
  quality: "good" | "thin" | "none";
  relevance_notes: string;
  band: { min: number; max: number } | null;
};

export type ResolvedLane = QuoteRfqLaneInput & { route_evidence?: RouteEvidence };
export type AgentQuote = QuoteCoreResult & { lane_id: string };

export type StepEvent = {
  run_id: string;
  seq: number;
  node: string;
  status: "start" | "end" | "error";
  summary: string;
  data?: unknown;
  ts: string;
};

export interface StructuredChatModel {
  withStructuredOutput<T>(schema: z.ZodType<T>): {
    invoke(input: unknown): Promise<T>;
  };
}

export interface Channel {
  send(input: {
    to: string;
    subject?: string;
    body_md: string;
    attachments?: Array<{ filename: string; content: Buffer; content_type?: string }>;
    reply_to?: { message_id: string; references: string[]; subject: string };
  }): Promise<void>;
}

export interface AgentRunStore {
  createRun(run: {
    run_id: string;
    channel: AgentChannel;
    status: "running";
    summary: string;
  }): Promise<void>;
  updateRunStatus(
    runId: string,
    status: "running" | "waiting_approval" | "done" | "error",
    summary: string
  ): Promise<void>;
  appendStep(step: StepEvent): Promise<void>;
  getSteps(runId: string): Promise<StepEvent[]>;
  getRun(runId: string): Promise<{
    run_id: string;
    status: "running" | "waiting_approval" | "done" | "error";
  } | null>;
  claimRunForResume(runId: string): Promise<boolean>;
}

export type QuoteAgentInput = {
  run_id: string;
  channel: AgentChannel;
  message: IntakeEmail;
};

export type QuoteAgentRuntimeOptions = {
  manifest: QuoteManifest;
  tools: QuoteWorkflowTools;
  model: StructuredChatModel;
  store: AgentRunStore;
  channels: Record<AgentChannel, Channel>;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  checkpointer?: BaseCheckpointSaver;
};

export type NodeContext = Omit<QuoteAgentRuntimeOptions, "env" | "now"> & {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  trace<T extends Record<string, unknown>>(
    runId: string,
    node: string,
    work: () => Promise<T>
  ): Promise<T & { steps: StepEvent[]; audit_events: AuditEvent[] }>;
};

export type AgentGraphResult = QuoteAgentState & { __interrupt__?: unknown[] };

export type AgentRfq = Rfq;
