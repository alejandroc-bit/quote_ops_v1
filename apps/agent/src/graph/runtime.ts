import { Annotation, Command, END, MemorySaver, Send, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { createAuditEvent } from "@quoteops/audit";
import { QuoteAgentAnnotation, type QuoteAgentState } from "./state.js";
import type {
  AgentApproval,
  AgentGraphResult,
  NodeContext,
  QuoteAgentInput,
  QuoteAgentRuntimeOptions,
  StepEvent
} from "./types.js";
import { classifyNode } from "./nodes/classify.js";
import { extractNode } from "./nodes/extract.js";
import { validateOperabilityNode } from "./nodes/validateOperability.js";
import { processLaneNode } from "./nodes/processLane.js";
import { policyGateNode } from "./nodes/policyGate.js";
import { approvalInterruptNode } from "./nodes/approvalInterrupt.js";
import { approvalPromptNode } from "./nodes/approvalPrompt.js";
import { respondNode } from "./nodes/respond.js";
import { writebackNode } from "./nodes/writeback.js";

export interface QuoteAgentRuntime {
  invoke(input: QuoteAgentInput): Promise<AgentGraphResult>;
  resume(
    runId: string,
    decision: AgentApproval,
    options?: { alreadyClaimed?: boolean }
  ): Promise<AgentGraphResult>;
  getState(runId: string): Promise<AgentGraphResult>;
}

export async function createQuoteAgentRuntime(options: QuoteAgentRuntimeOptions): Promise<QuoteAgentRuntime> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const seqByRun = new Map<string, number>();
  const pendingGraphErrors = new Map<string, { steps: StepEvent[]; audit_events: ReturnType<typeof createAuditEvent>[] }>();
  const initializeSequence = async (runId: string) => {
    const steps = await options.store.getSteps(runId);
    seqByRun.set(runId, steps.reduce((max, step) => Math.max(max, step.seq), 0));
  };
  const trace: NodeContext["trace"] = async (runId, node, work) => {
    const events: StepEvent[] = [];
    const append = async (status: StepEvent["status"], summary: string, data?: unknown) => {
      const seq = (seqByRun.get(runId) ?? 0) + 1;
      seqByRun.set(runId, seq);
      const event: StepEvent = {
        run_id: runId,
        seq,
        node,
        status,
        summary,
        ...(data === undefined ? {} : { data }),
        ts: now().toISOString()
      };
      events.push(event);
      await options.store.appendStep(event);
      return event;
    };
    await append("start", `${node} started`);
    try {
      const update = await work();
      await append("end", `${node} completed`);
      return {
        ...update,
        steps: events,
        audit_events: [
          createAuditEvent({ run_id: runId, node_id: node, event_type: "completed", payload: {} })
        ]
      };
    } catch (error) {
      if (isLangGraphInterrupt(error)) throw error;
      const event = await append("error", `${node} failed`, {
        message: error instanceof Error ? error.message : String(error)
      });
      const audit = createAuditEvent({
        run_id: runId,
        node_id: node,
        event_type: "failed",
        payload: { message: error instanceof Error ? error.message : String(error) }
      });
      const pending = pendingGraphErrors.get(runId) ?? { steps: [], audit_events: [] };
      pending.steps.push(event);
      pending.audit_events.push(audit);
      pendingGraphErrors.set(runId, pending);
      throw error;
    }
  };
  const context: NodeContext = { ...options, env, now, trace };
  const checkpointer = options.checkpointer ?? (env.DATABASE_URL
    ? PostgresSaver.fromConnString(env.DATABASE_URL)
    : new MemorySaver());
  if (checkpointer instanceof PostgresSaver) await checkpointer.setup();

  const graph = new StateGraph(QuoteAgentAnnotation)
    .addNode("classify", (state) => classifyNode(state, context))
    .addNode("extract", (state) => extractNode(state, context))
    .addNode("validateOperability", (state) => validateOperabilityNode(state, context))
    .addNode("processLane", (state) => processLaneNode(state, context))
    .addNode("policyGate", (state) => policyGateNode(state, context))
    .addNode("approvalPrompt", (state) => approvalPromptNode(state, context))
    .addNode("approvalInterrupt", (state) => approvalInterruptNode(state, context))
    .addNode("respond", (state) => respondNode(state, context))
    .addNode("writeback", (state) => writebackNode(state, context))
    .addEdge(START, "classify")
    .addEdge("classify", "extract")
    .addEdge("extract", "validateOperability")
    .addConditionalEdges("validateOperability", (state) => {
      const blocked = new Set(state.inoperable.map((item) => item.lane.lane_id));
      const operable = state.lanes.filter((lane) => !blocked.has(lane.lane_id));
      if (operable.length === 0) return "policyGate";
      return operable.map(
        (lane) =>
          new Send("processLane", {
            run_id: state.run_id,
            active_lane: lane,
            quotes: [],
            historical: [],
            recommendation: [],
            steps: [],
            audit_events: []
          })
      );
    })
    .addEdge("processLane", "policyGate")
    .addEdge("policyGate", "approvalPrompt")
    .addEdge("approvalPrompt", "approvalInterrupt")
    .addEdge("approvalInterrupt", "respond")
    .addEdge("respond", "writeback")
    .addEdge("writeback", END)
    .compile({ checkpointer });

  const configFor = (runId: string) => ({ configurable: { thread_id: runId } });
  const persistOutcome = async (runId: string, result: AgentGraphResult) => {
    const interrupted = Array.isArray(result.__interrupt__) && result.__interrupt__.length > 0;
    const terminalBlocker = result.terminal_blocker;
    await options.store.updateRunStatus(
      runId,
      terminalBlocker ? "error" : interrupted ? "waiting_approval" : "done",
      terminalBlocker ?? (interrupted ? "Waiting for approval" : "Quote workflow completed")
    );
  };

  const persistGraphErrors = async (runId: string) => {
    const pending = pendingGraphErrors.get(runId);
    if (!pending) return;
    pendingGraphErrors.delete(runId);
    await graph.updateState(configFor(runId), pending);
  };

  return {
    async invoke(input) {
      await initializeSequence(input.run_id);
      await options.store.createRun({
        run_id: input.run_id,
        channel: input.channel,
        status: "running",
        summary: "Quote workflow started"
      });
      try {
        const result = (await graph.invoke(input, configFor(input.run_id))) as AgentGraphResult;
        await persistOutcome(input.run_id, result);
        return result;
      } catch (error) {
        await persistGraphErrors(input.run_id);
        await options.store.updateRunStatus(input.run_id, "error", error instanceof Error ? error.message : String(error));
        throw error;
      }
    },
    async resume(runId, decision, resumeOptions) {
      const claimed = resumeOptions?.alreadyClaimed || (await options.store.claimRunForResume(runId));
      if (!claimed) {
        throw new Error(`run_not_waiting_approval:${runId}`);
      }
      try {
        await initializeSequence(runId);
        const result = (await graph.invoke(new Command({ resume: decision }), configFor(runId))) as AgentGraphResult;
        await persistOutcome(runId, result);
        return result;
      } catch (error) {
        await persistGraphErrors(runId).catch(() => undefined);
        await options.store.updateRunStatus(
          runId,
          "error",
          error instanceof Error ? error.message : String(error)
        );
        throw error;
      }
    },
    async getState(runId) {
      const snapshot = await graph.getState(configFor(runId));
      return snapshot.values as AgentGraphResult;
    }
  };
}

function isLangGraphInterrupt(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      ((error as { name?: string }).name === "GraphInterrupt" ||
        (error as { name?: string }).name === "NodeInterrupt" ||
        (error as { is_bubble_up?: boolean }).is_bubble_up === true)
  );
}
