import type { QuoteWorkflowState } from "@quoteops/agent";
import {
  buildApprovalEnvelope,
  summarizeWorkflowRun,
  type ApplianceHeartbeat,
  type AgentRun,
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
  const agentApprovalDecisions = new Map<string, ApprovalDecision>();
  const heartbeats: ApplianceHeartbeat[] = [];
  const agentRuns = new Map<string, AgentRun>();
  const agentSteps = new Map<string, import("./QuoteOpsStore.js").StepEvent[]>();

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
    },
    async createRun(run) {
      const now = new Date().toISOString();
      agentRuns.set(run.run_id, { ...run, created_at: now, updated_at: now });
    },
    async updateRunStatus(runId, status, summary) {
      const current = agentRuns.get(runId);
      if (!current) throw new Error(`agent run not found: ${runId}`);
      agentRuns.set(runId, {
        ...current,
        status,
        summary,
        updated_at: new Date().toISOString()
      });
    },
    async appendStep(step) {
      const steps = agentSteps.get(step.run_id) ?? [];
      if (steps.some((candidate) => candidate.seq === step.seq)) {
        throw new Error(`duplicate quote step sequence: ${step.run_id}:${step.seq}`);
      }
      agentSteps.set(step.run_id, [...steps, structuredClone(step)]);
    },
    async listRuns(limit = 50) {
      return Array.from(agentRuns.values())
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, Math.max(1, Math.min(200, Math.floor(limit))));
    },
    async getRun(runId) {
      return agentRuns.get(runId) ?? null;
    },
    async getSteps(runId) {
      return [...(agentSteps.get(runId) ?? [])].sort((left, right) => left.seq - right.seq);
    },
    async claimRunForResume(runId) {
      const current = agentRuns.get(runId);
      if (!current || current.status !== "waiting_approval") return false;
      agentRuns.set(runId, {
        ...current,
        status: "running",
        summary: "Approval resume claimed",
        updated_at: new Date().toISOString()
      });
      return true;
    },
    async claimAgentRunForResume(runId, decision) {
      const current = agentRuns.get(runId);
      if (!current || current.status !== "waiting_approval") return false;
      agentApprovalDecisions.set(runId, decision);
      agentRuns.set(runId, {
        ...current,
        status: "running",
        summary: "Approval resume claimed",
        updated_at: new Date().toISOString()
      });
      return true;
    }
  };
}
