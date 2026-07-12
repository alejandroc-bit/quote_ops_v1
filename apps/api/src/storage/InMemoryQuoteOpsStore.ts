import type { QuoteWorkflowState } from "@quoteops/agent";
import {
  buildApprovalEnvelope,
  summarizeWorkflowRun,
  type ApplianceHeartbeat,
  type ApprovalDecision,
  type ApprovalEnvelope,
  type QuoteOpsStore,
  type WorkflowRunSummary
} from "./QuoteOpsStore.js";

type StoredWorkflowRun = {
  run: QuoteWorkflowState;
  createdAt: string;
  updatedAt: string;
};

export function createInMemoryQuoteOpsStore(): QuoteOpsStore {
  const workflowRuns = new Map<string, StoredWorkflowRun>();
  const approvalDecisions = new Map<string, ApprovalDecision>();
  const heartbeats: ApplianceHeartbeat[] = [];

  return {
    async saveWorkflowRun(run) {
      const existing = workflowRuns.get(run.run_id);
      const now = new Date().toISOString();
      workflowRuns.set(run.run_id, {
        run,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      });
    },
    async getWorkflowRun(runId) {
      return workflowRuns.get(runId)?.run ?? null;
    },
    async listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
      return Array.from(workflowRuns.values()).map((record) =>
        summarizeWorkflowRun(record.run, {
          createdAt: record.createdAt,
          updatedAt: record.updatedAt
        })
      );
    },
    async listApprovalEnvelopes(): Promise<ApprovalEnvelope[]> {
      return Array.from(workflowRuns.values())
        .map((record) =>
          buildApprovalEnvelope(record.run, {
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            installationId: process.env.QUOTEOPS_INSTALLATION_ID ?? null
          })
        )
        .filter((envelope): envelope is ApprovalEnvelope => envelope !== null)
        .map((envelope) => {
          const decision = approvalDecisions.get(envelope.run_id);
          if (!decision) return envelope;
          return {
            ...envelope,
            decision_status:
              decision.action === "approve"
                ? "approved"
                : decision.action === "adjust"
                  ? "adjusted"
                  : decision.action === "reject"
                    ? "rejected"
                    : "review_requested",
            updated_at: decision.decided_at
          };
        });
    },
    async saveApprovalDecision(runId, decision) {
      approvalDecisions.set(runId, decision);
    },
    async getApprovalDecision(runId) {
      return approvalDecisions.get(runId) ?? null;
    },
    async saveHeartbeat(heartbeat) {
      heartbeats.push(heartbeat);
    },
    async listHeartbeats() {
      return [...heartbeats];
    }
  };
}
