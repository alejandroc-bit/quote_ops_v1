import type { QuoteWorkflowState, QuoteWorkflowTools } from "@quoteops/agent";
import pg, { type Pool as PgPool } from "pg";
import {
  buildApprovalEnvelope,
  summarizeWorkflowRun,
  type ApplianceHeartbeat,
  type AgentRun,
  type AgentRunStatus,
  type ApprovalDecision,
  type ApprovalEnvelope,
  type DecisionStatus,
  type QuoteOpsStore,
  type WorkflowRunSummary
} from "./QuoteOpsStore.js";
import { schemaSql } from "./schema.js";

const { Pool } = pg;

export type PostgresQuoteOpsStoreOptions = {
  databaseUrl: string;
  pool?: PgPool;
};

type WorkflowRunSummaryRow = {
  run_id: string;
  client_id: string;
  rfq_id: string;
  status: string;
  approval_required: boolean;
  route_source: string | null;
  base_rate_mxn: string | number | null;
  recommended_rate_mxn: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type WorkflowRunPayloadRow = WorkflowRunSummaryRow & {
  payload: unknown;
  decision_action: ApprovalDecision["action"] | null;
  decision_decided_at: Date | string | null;
};

type ApprovalDecisionRow = {
  action: ApprovalDecision["action"];
  rate_mxn: string | number | null;
  reason: string | null;
  email_sent: boolean;
  decided_at: Date | string;
};

type HeartbeatRow = {
  payload: unknown;
  received_at: Date | string;
};

type AgentRunRow = {
  run_id: string;
  channel: AgentRun["channel"];
  status: AgentRunStatus;
  summary: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type StepEventRow = {
  run_id: string;
  seq: number;
  node: string;
  status: import("./QuoteOpsStore.js").StepEvent["status"];
  summary: string;
  data: unknown;
  ts: Date | string;
};

export class PostgresQuoteOpsStore implements QuoteOpsStore {
  private readonly pool: PgPool;
  private readonly ownsPool: boolean;
  private schemaReady: Promise<void> | null = null;

  constructor(options: PostgresQuoteOpsStoreOptions) {
    this.pool = options.pool ?? new Pool({ connectionString: options.databaseUrl });
    this.ownsPool = !options.pool;
  }

  async saveWorkflowRun(run: QuoteWorkflowState): Promise<void> {
    await this.ensureSchema();

    const summary = summarizeWorkflowRun(run);
    const snapshot = serializeWorkflowRun(run);
    await this.pool.query(
      `
      insert into workflow_runs (
        run_id,
        client_id,
        rfq_id,
        status,
        approval_required,
        route_source,
        base_rate_mxn,
        recommended_rate_mxn,
        payload
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      on conflict (run_id) do update set
        client_id = excluded.client_id,
        rfq_id = excluded.rfq_id,
        status = excluded.status,
        approval_required = excluded.approval_required,
        route_source = excluded.route_source,
        base_rate_mxn = excluded.base_rate_mxn,
        recommended_rate_mxn = excluded.recommended_rate_mxn,
        payload = excluded.payload,
        updated_at = now()
      `,
      [
        summary.run_id,
        summary.client_id,
        summary.rfq_id,
        summary.status,
        summary.approval_required,
        summary.route_source,
        summary.base_rate_mxn,
        summary.recommended_rate_mxn,
        JSON.stringify(snapshot)
      ]
    );
  }

  async getWorkflowRun(runId: string): Promise<QuoteWorkflowState | null> {
    await this.ensureSchema();

    const result = await this.pool.query<{ payload: unknown }>(
      "select payload from workflow_runs where run_id = $1",
      [runId]
    );
    const row = result.rows[0];
    return row ? rehydrateStoredWorkflowRun(row.payload) : null;
  }

  async listWorkflowRuns(): Promise<WorkflowRunSummary[]> {
    await this.ensureSchema();

    const result = await this.pool.query<WorkflowRunSummaryRow>(
      `
      select
        run_id,
        client_id,
        rfq_id,
        status,
        approval_required,
        route_source,
        base_rate_mxn,
        recommended_rate_mxn,
        created_at,
        updated_at
      from workflow_runs
      order by updated_at desc
      `
    );
    return result.rows.map(workflowRunSummaryFromRow);
  }

  async listApprovalEnvelopes(): Promise<ApprovalEnvelope[]> {
    await this.ensureSchema();

    const result = await this.pool.query<WorkflowRunPayloadRow>(
      `
      select
        workflow_runs.run_id,
        workflow_runs.client_id,
        workflow_runs.rfq_id,
        workflow_runs.status,
        workflow_runs.approval_required,
        workflow_runs.route_source,
        workflow_runs.base_rate_mxn,
        workflow_runs.recommended_rate_mxn,
        workflow_runs.payload,
        workflow_runs.created_at,
        workflow_runs.updated_at,
        approval_decisions.action as decision_action,
        approval_decisions.decided_at as decision_decided_at
      from workflow_runs
      left join approval_decisions on approval_decisions.run_id = workflow_runs.run_id
      where workflow_runs.approval_required = true
      order by workflow_runs.updated_at desc
      limit 200
      `
    );

    return result.rows
      .map((row) => {
        const envelope = buildApprovalEnvelope(rehydrateStoredWorkflowRun(row.payload), {
          createdAt: isoTimestamp(row.created_at),
          updatedAt: isoTimestamp(row.updated_at),
          installationId: process.env.QUOTEOPS_INSTALLATION_ID ?? null
        });
        if (!envelope) return null;
        if (!row.decision_action) return envelope;
        return {
          ...envelope,
          decision_status: decisionStatus(row.decision_action),
          updated_at: row.decision_decided_at
            ? isoTimestamp(row.decision_decided_at)
            : envelope.updated_at
        };
      })
      .filter((envelope): envelope is ApprovalEnvelope => envelope !== null);
  }

  async saveApprovalDecision(runId: string, decision: ApprovalDecision): Promise<void> {
    await this.ensureSchema();

    await this.pool.query(
      `
      insert into approval_decisions (run_id, action, rate_mxn, reason, email_sent, decided_at)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (run_id) do update set
        action = excluded.action,
        rate_mxn = excluded.rate_mxn,
        reason = excluded.reason,
        email_sent = excluded.email_sent,
        decided_at = excluded.decided_at
      `,
      [
        runId,
        decision.action,
        decision.rate_mxn ?? null,
        decision.reason ?? null,
        decision.email_sent,
        decision.decided_at
      ]
    );
  }

  async claimAgentRunForResume(runId: string, decision: ApprovalDecision): Promise<boolean> {
    await this.ensureSchema();

    const result = await this.pool.query(
      `
      with claimed as (
        update quote_runs
           set status = 'running', summary = 'Approval resume claimed', updated_at = now()
         where run_id = $1 and status = 'waiting_approval'
        returning run_id
      )
      insert into agent_approval_decisions (run_id, action, rate_mxn, reason, email_sent, decided_at)
      select run_id, $2, $3, $4, $5, $6 from claimed
      on conflict (run_id) do update set
        action = excluded.action,
        rate_mxn = excluded.rate_mxn,
        reason = excluded.reason,
        email_sent = excluded.email_sent,
        decided_at = excluded.decided_at
      `,
      [
        runId,
        decision.action,
        decision.rate_mxn ?? null,
        decision.reason ?? null,
        decision.email_sent,
        decision.decided_at
      ]
    );
    return result.rowCount === 1;
  }

  async getApprovalDecision(runId: string): Promise<ApprovalDecision | null> {
    await this.ensureSchema();

    const result = await this.pool.query<ApprovalDecisionRow>(
      `
      select action, rate_mxn, reason, email_sent, decided_at
      from approval_decisions
      where run_id = $1
      `,
      [runId]
    );
    const row = result.rows[0];
    if (!row) return null;

    return {
      action: row.action,
      ...(row.rate_mxn !== null ? { rate_mxn: numberOrNull(row.rate_mxn) ?? undefined } : {}),
      ...(row.reason !== null ? { reason: row.reason } : {}),
      email_sent: row.email_sent,
      decided_at: isoTimestamp(row.decided_at)
    };
  }

  async saveHeartbeat(heartbeat: ApplianceHeartbeat): Promise<void> {
    await this.ensureSchema();

    await this.pool.query(
      `
      insert into heartbeats (client_id, installation_id, version, payload, received_at)
      values ($1, $2, $3, $4::jsonb, $5)
      `,
      [
        heartbeat.client_id,
        heartbeat.installation_id,
        heartbeat.version,
        JSON.stringify(heartbeat),
        heartbeat.received_at
      ]
    );
  }

  async listHeartbeats(): Promise<ApplianceHeartbeat[]> {
    await this.ensureSchema();

    const result = await this.pool.query<HeartbeatRow>(
      `
      select payload, received_at
      from heartbeats
      order by received_at desc
      `
    );
    return result.rows.map((row) => ({
      ...(row.payload as ApplianceHeartbeat),
      received_at: isoTimestamp(row.received_at)
    }));
  }

  async createRun(run: import("./QuoteOpsStore.js").CreateAgentRun): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into quote_runs (run_id, channel, status, summary)
       values ($1, $2, $3, $4)
       on conflict (run_id) do update set
         channel = excluded.channel,
         status = excluded.status,
         summary = excluded.summary,
         updated_at = now()`,
      [run.run_id, run.channel, run.status, run.summary]
    );
  }

  async updateRunStatus(runId: string, status: AgentRunStatus, summary: string): Promise<void> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `update quote_runs set status = $2, summary = $3, updated_at = now() where run_id = $1`,
      [runId, status, summary]
    );
    if (result.rowCount === 0) throw new Error(`agent run not found: ${runId}`);
  }

  async appendStep(step: import("./QuoteOpsStore.js").StepEvent): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into quote_run_steps (run_id, seq, node, status, summary, data, ts)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [
        step.run_id,
        step.seq,
        step.node,
        step.status,
        step.summary,
        step.data === undefined ? null : JSON.stringify(step.data),
        step.ts
      ]
    );
  }

  async listRuns(limit = 50): Promise<AgentRun[]> {
    await this.ensureSchema();
    const result = await this.pool.query<AgentRunRow>(
      `select run_id, channel, status, summary, created_at, updated_at
       from quote_runs order by updated_at desc limit $1`,
      [Math.max(1, Math.min(200, Math.floor(limit)))]
    );
    return result.rows.map(agentRunFromRow);
  }

  async getRun(runId: string): Promise<AgentRun | null> {
    await this.ensureSchema();
    const result = await this.pool.query<AgentRunRow>(
      `select run_id, channel, status, summary, created_at, updated_at
       from quote_runs where run_id = $1`,
      [runId]
    );
    return result.rows[0] ? agentRunFromRow(result.rows[0]) : null;
  }

  async getSteps(runId: string): Promise<import("./QuoteOpsStore.js").StepEvent[]> {
    await this.ensureSchema();
    const result = await this.pool.query<StepEventRow>(
      `select run_id, seq, node, status, summary, data, ts
       from quote_run_steps where run_id = $1 order by seq asc`,
      [runId]
    );
    return result.rows.map((row) => ({
      run_id: row.run_id,
      seq: row.seq,
      node: row.node,
      status: row.status,
      summary: row.summary,
      ...(row.data !== null ? { data: row.data } : {}),
      ts: isoTimestamp(row.ts)
    }));
  }

  async claimRunForResume(runId: string): Promise<boolean> {
    await this.ensureSchema();
    const result = await this.pool.query(
      `update quote_runs
          set status = 'running', summary = 'Approval resume claimed', updated_at = now()
        where run_id = $1 and status = 'waiting_approval'
        returning run_id`,
      [runId]
    );
    return result.rowCount === 1;
  }

  async end(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(schemaSql).then(
      () => undefined,
      (error: unknown) => {
        this.schemaReady = null;
        throw error;
      }
    );
    await this.schemaReady;
  }
}

function serializeWorkflowRun(run: QuoteWorkflowState): Omit<QuoteWorkflowState, "tools"> {
  const { tools: _tools, ...snapshot } = run;
  return JSON.parse(JSON.stringify(snapshot)) as Omit<QuoteWorkflowState, "tools">;
}

function rehydrateStoredWorkflowRun(payload: unknown): QuoteWorkflowState {
  return {
    ...(payload as Omit<QuoteWorkflowState, "tools">),
    tools: storedWorkflowTools()
  };
}

function storedWorkflowTools(): QuoteWorkflowTools {
  const fail = async () => {
    throw new Error("stored workflow tools are not executable");
  };

  return {
    resolveRoute: fail,
    searchHistorical: fail,
    recommend: fail,
    writeback: fail
  };
}

function workflowRunSummaryFromRow(row: WorkflowRunSummaryRow): WorkflowRunSummary {
  return {
    run_id: row.run_id,
    client_id: row.client_id,
    rfq_id: row.rfq_id,
    status: row.status,
    approval_required: row.approval_required,
    route_source: row.route_source,
    base_rate_mxn: numberOrNull(row.base_rate_mxn),
    recommended_rate_mxn: numberOrNull(row.recommended_rate_mxn),
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at)
  };
}

function decisionStatus(action: ApprovalDecision["action"]): DecisionStatus {
  if (action === "approve") return "approved";
  if (action === "adjust") return "adjusted";
  if (action === "reject") return "rejected";
  return "review_requested";
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function agentRunFromRow(row: AgentRunRow): AgentRun {
  return {
    run_id: row.run_id,
    channel: row.channel,
    status: row.status,
    summary: row.summary,
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at)
  };
}
