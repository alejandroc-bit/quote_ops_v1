import { Annotation } from "@langchain/langgraph";
import type { AuditEvent } from "@quoteops/audit";
import type { Rfq } from "@quoteops/contracts";
import type { IntakeEmail } from "../intake/extractRfq.js";
import type {
  AgentApproval,
  AgentChannel,
  AgentQuote,
  AgentRecommendation,
  IntakeKind,
  LaneHistoricalContext,
  ResolvedLane,
  StepEvent
} from "./types.js";

const concat = <T>(left: T[], right: T | T[]) => left.concat(Array.isArray(right) ? right : [right]);
const mergeByLane = <T extends { lane_id: string }>(left: T[], right: T | T[]) => {
  const merged = new Map(left.map((item) => [item.lane_id, item]));
  for (const item of Array.isArray(right) ? right : [right]) merged.set(item.lane_id, item);
  return Array.from(merged.values());
};

export const QuoteAgentAnnotation = Annotation.Root({
  run_id: Annotation<string>,
  channel: Annotation<AgentChannel>,
  message: Annotation<IntakeEmail>,
  intake_kind: Annotation<IntakeKind | null>({ default: () => null, reducer: (_left, right) => right }),
  rfqs: Annotation<Rfq[]>({ default: () => [], reducer: (_left, right) => right }),
  lanes: Annotation<ResolvedLane[]>({ default: () => [], reducer: (_left, right) => right }),
  active_lane: Annotation<ResolvedLane | null>({ default: () => null, reducer: (_left, right) => right }),
  inoperable: Annotation<Array<{ lane: ResolvedLane; reason: string }>>({
    default: () => [],
    reducer: (_left, right) => right
  }),
  quotes: Annotation<AgentQuote[]>({ default: () => [], reducer: mergeByLane }),
  historical: Annotation<LaneHistoricalContext[]>({ default: () => [], reducer: mergeByLane }),
  recommendation: Annotation<AgentRecommendation[]>({ default: () => [], reducer: mergeByLane }),
  approval: Annotation<AgentApproval | null>({ default: () => null, reducer: (_left, right) => right }),
  response_sent: Annotation<boolean>({ default: () => false, reducer: (_left, right) => right }),
  confirmation_prompt_sent: Annotation<boolean>({ default: () => false, reducer: (_left, right) => right }),
  terminal_blocker: Annotation<string | null>({ default: () => null, reducer: (_left, right) => right }),
  steps: Annotation<StepEvent[]>({ default: () => [], reducer: concat }),
  audit_events: Annotation<AuditEvent[]>({ default: () => [], reducer: concat })
});

export type QuoteAgentState = typeof QuoteAgentAnnotation.State;
export type QuoteAgentUpdate = typeof QuoteAgentAnnotation.Update;
