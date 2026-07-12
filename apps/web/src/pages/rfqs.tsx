import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import {
  Activity,
  CheckCircle2,
  Clock3,
  FileInput,
  ListChecks,
  RefreshCw,
  Send,
  TriangleAlert
} from "lucide-react";
import {
  getRfq,
  listRfqs,
  submitPlaygroundRfq,
  type PlaygroundRfqRequest,
  type WorkflowRunDetail,
  type WorkflowRunSummary
} from "../api/quoteOpsApi";
import { useAsyncResource } from "../api/useAsyncResource";
import { RfqExecutionTimeline } from "./rfqExecutionTimeline";

type RfqFormState = {
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
  vehicle_profile_id: string;
  equipment_request: string;
  weight_kg: string;
  commodity: string;
  value_mxn: string;
  business_unit_id: string;
};

type ActivityEntry = {
  id: string;
  label: string;
  detail: string;
  status: "running" | "completed" | "failed";
};

const initialForm: RfqFormState = {
  origin_city: "Monterrey",
  origin_state: "Nuevo Leon",
  destination_city: "Ciudad de Mexico",
  destination_state: "Ciudad de Mexico",
  vehicle_profile_id: "T3S3_53_DRYVAN",
  equipment_request: "caja seca 53",
  weight_kg: "29000",
  commodity: "carga general",
  value_mxn: "400000",
  business_unit_id: "DV_53_FT"
};

export function RfqsPage() {
  const loadRfqs = useCallback(() => listRfqs(), []);
  const { data, error, loading, reload } = useAsyncResource(loadRfqs, [], 3000);
  const rfqs = data ?? [];
  const reviewBlocks = rfqs.filter((rfq) => rfq.approval_required).length;
  const [form, setForm] = useState<RfqFormState>(initialForm);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activityLog, setActivityLog] = useState<ActivityEntry[]>([
    {
      id: "idle",
      label: "Ready for RFQ",
      detail: "The local appliance is waiting for a Playground request or TMS intake.",
      status: "completed"
    }
  ]);

  useEffect(() => {
    if (!selectedRunId && rfqs[0]) {
      setSelectedRunId(rfqs[0].run_id);
    }
  }, [rfqs, selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    getRfq(selectedRunId)
      .then((run) => {
        if (!cancelled) setDetail(run);
      })
      .catch((caught) => {
        if (!cancelled) {
          setDetail(null);
          setDetailError(caught instanceof Error ? caught.message : String(caught));
        }
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId) return;
    const interval = window.setInterval(() => {
      getRfq(selectedRunId)
        .then((run) => setDetail(run))
        .catch((caught) => {
          setDetailError(caught instanceof Error ? caught.message : String(caught));
        });
    }, 3000);

    return () => {
      window.clearInterval(interval);
    };
  }, [selectedRunId]);

  const activeSummary = useMemo(
    () => rfqs.find((rfq) => rfq.run_id === selectedRunId) ?? rfqs[0] ?? null,
    [rfqs, selectedRunId]
  );
  const currentAction = describeCurrentAction(detail, submitting);

  async function submitRfq(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await submitForm(form);
  }

  async function submitForm(nextForm: RfqFormState) {
    setSubmitting(true);
    setActivityLog([
      {
        id: "form",
        label: "RFQ captured",
        detail: `${nextForm.origin_city} to ${nextForm.destination_city} entered in the Playground.`,
        status: "completed"
      },
      {
        id: "api",
        label: "Sending to local API",
        detail: "POST /api/playground/rfqs is converting the form into the RFQ contract.",
        status: "running"
      }
    ]);

    try {
      const response = await submitPlaygroundRfq(toPlaygroundRequest(nextForm));
      setSelectedRunId(response.run_id);
      setActivityLog((current) => [
        ...current.map((entry) =>
          entry.id === "api" ? { ...entry, status: "completed" as const } : entry
        ),
        {
          id: "workflow",
          label: response.status === "RECEIVED" ? "Workflow queued" : "Workflow completed",
          detail:
            response.status === "RECEIVED"
              ? `${response.run_id} was accepted by the local appliance; monitor is polling for node status.`
              : `${response.run_id} returned ${response.status}; approval required: ${response.approval_required ? "yes" : "no"}.`,
          status: "completed"
        }
      ]);
      setDetail(await getRfq(response.run_id));
      reload();
    } catch (caught) {
      setActivityLog((current) => [
        ...current.map((entry) =>
          entry.id === "api" ? { ...entry, status: "failed" as const } : entry
        ),
        {
          id: "failed",
          label: "RFQ failed closed",
          detail: caught instanceof Error ? caught.message : String(caught),
          status: "failed"
        }
      ]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section aria-labelledby="rfq-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Live RFQ intake</p>
          <h2 id="rfq-heading">Playground operations</h2>
        </div>
        <div className="compact-stats" aria-label="RFQ metrics">
          <span>{rfqs.length} stored</span>
          <span>{reviewBlocks} review block</span>
          <span>{currentAction}</span>
          <span>live every 3s</span>
        </div>
      </div>

      <div className="ops-grid">
        <form className="panel rfq-intake" onSubmit={submitRfq}>
          <div className="panel-title">
            <FileInput size={18} aria-hidden />
            <h3>Request RFQ</h3>
          </div>
          <div className="form-grid">
            <TextField form={form} label="Origin city" name="origin_city" setForm={setForm} />
            <TextField form={form} label="Origin state" name="origin_state" setForm={setForm} />
            <TextField
              form={form}
              label="Destination city"
              name="destination_city"
              setForm={setForm}
            />
            <TextField
              form={form}
              label="Destination state"
              name="destination_state"
              setForm={setForm}
            />
            <TextField
              form={form}
              label="Vehicle profile"
              name="vehicle_profile_id"
              setForm={setForm}
            />
            <TextField
              form={form}
              label="Equipment"
              name="equipment_request"
              setForm={setForm}
            />
            <TextField form={form} label="Weight kg" name="weight_kg" setForm={setForm} />
            <TextField form={form} label="Cargo value" name="value_mxn" setForm={setForm} />
            <TextField form={form} label="Commodity" name="commodity" setForm={setForm} />
            <TextField
              form={form}
              label="Business unit"
              name="business_unit_id"
              setForm={setForm}
            />
          </div>
          <div className="action-row">
            <button className="button button-primary" disabled={submitting} type="submit">
              <Send size={16} aria-hidden />
              {submitting ? "Submitting" : "Submit RFQ"}
            </button>
            <button
              className="button button-secondary"
              disabled={submitting}
              onClick={() => {
                const missingWeightForm = { ...initialForm, weight_kg: "" };
                setForm(missingWeightForm);
                void submitForm(missingWeightForm);
              }}
              type="button"
            >
              Submit missing weight case
            </button>
          </div>
        </form>

        <article className="panel live-monitor">
          <div className="panel-title panel-title-action">
            <span>
              <Activity size={18} aria-hidden />
              <h3>Run monitor</h3>
            </span>
            <button className="icon-button" onClick={reload} title="Refresh RFQs" type="button">
              <RefreshCw size={16} aria-hidden />
            </button>
          </div>
          {activeSummary ? (
            <RunSnapshot
              detail={detail}
              detailError={detailError}
              detailLoading={detailLoading}
              summary={activeSummary}
            />
          ) : (
            <p className="muted">No RFQs have been received by this appliance yet.</p>
          )}
          <ActivityFeed entries={activityLog} />
        </article>

        <div className="panel rfq-list">
          <div className="panel-title">
            <ListChecks size={18} aria-hidden />
            <h3>RFQ queue</h3>
          </div>
          {loading ? <p className="muted">Loading RFQs from API...</p> : null}
          {error ? (
            <div className="inline-error">
              <span>{error.message}</span>
              <button className="button button-secondary" onClick={reload} type="button">
                Retry
              </button>
            </div>
          ) : null}
          {!loading && !error && rfqs.length === 0 ? (
            <p className="muted">No RFQs are currently stored in the local appliance.</p>
          ) : null}
          {rfqs.map((rfq) => (
            <button
              className={rfq.run_id === selectedRunId ? "queue-row queue-row-active" : "queue-row"}
              key={rfq.run_id}
              onClick={() => setSelectedRunId(rfq.run_id)}
              type="button"
            >
              <span>
                <strong>{rfq.rfq_id}</strong>
                <small>{rfq.client_id} / {rfq.run_id}</small>
              </span>
              <span className={rfq.approval_required ? "status status-amber" : "status status-blue"}>
                {rfq.approval_required ? "Approval" : "Writeback"}
              </span>
            </button>
          ))}
        </div>

        <RfqExecutionTimeline
          nodeStatus={detail?.node_status ?? {}}
          runId={activeSummary?.run_id ?? null}
        />
      </div>
    </section>
  );
}

function TextField({
  form,
  label,
  name,
  setForm
}: {
  form: RfqFormState;
  label: string;
  name: keyof RfqFormState;
  setForm: (next: RfqFormState) => void;
}) {
  return (
    <label>
      {label}
      <input
        onChange={(event) => setForm({ ...form, [name]: event.target.value })}
        type={name.includes("kg") || name.includes("value") ? "number" : "text"}
        value={form[name]}
      />
    </label>
  );
}

function RunSnapshot({
  detail,
  detailError,
  detailLoading,
  summary
}: {
  detail: WorkflowRunDetail | null;
  detailError: string | null;
  detailLoading: boolean;
  summary: WorkflowRunSummary;
}) {
  const lane = detail?.raw_rfq.parsed.lanes[0] ?? null;
  return (
    <div className="run-snapshot">
      <div className="run-heading">
        <div>
          <p>{summary.rfq_id}</p>
          <h3>{summary.run_id}</h3>
        </div>
        <span className={summary.approval_required ? "status status-amber" : "status status-green"}>
          {summary.approval_required ? "Needs approval" : "Ready"}
        </span>
      </div>
      <dl className="rfq-detail-grid">
        <div>
          <dt>Receiving</dt>
          <dd>Playground {"->"} local API</dd>
        </div>
        <div>
          <dt>Current phase</dt>
          <dd>{phaseFromSummary(summary)}</dd>
        </div>
        <div>
          <dt>Lane</dt>
          <dd>
            {lane
              ? `${lane.origin.city} -> ${lane.destination.city}`
              : "Loading lane"}
          </dd>
        </div>
        <div>
          <dt>Weight</dt>
          <dd>{lane?.cargo.weight_kg ? `${lane.cargo.weight_kg} kg` : "Missing"}</dd>
        </div>
        <div>
          <dt>SAKBE</dt>
          <dd>
            {detail?.route_evidence
              ? `${detail.route_evidence.status}, ${detail.route_evidence.km_loaded ?? "?"} km`
              : detailLoading
                ? "Loading"
                : "Pending"}
          </dd>
        </div>
        <div>
          <dt>Quote-core</dt>
          <dd>{formatCurrency(summary.base_rate_mxn)}</dd>
        </div>
      </dl>
      {detail?.recommendation ? (
        <p className="agent-note">
          Agent guide: {detail.recommendation.reason}
        </p>
      ) : null}
      {detailError ? <p className="inline-error">{detailError}</p> : null}
    </div>
  );
}

function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="activity-feed" aria-label="Live process activity">
      {entries.map((entry) => (
        <div className={`activity-entry activity-${entry.status}`} key={entry.id}>
          {entry.status === "running" ? (
            <Clock3 size={16} aria-hidden />
          ) : entry.status === "failed" ? (
            <TriangleAlert size={16} aria-hidden />
          ) : (
            <CheckCircle2 size={16} aria-hidden />
          )}
          <span>
            <strong>{entry.label}</strong>
            <small>{entry.detail}</small>
          </span>
        </div>
      ))}
    </div>
  );
}

function toPlaygroundRequest(form: RfqFormState): PlaygroundRfqRequest {
  return {
    origin_city: form.origin_city,
    origin_state: form.origin_state,
    destination_city: form.destination_city,
    destination_state: form.destination_state,
    vehicle_profile_id: form.vehicle_profile_id,
    equipment_request: form.equipment_request,
    weight_kg: form.weight_kg ? Number(form.weight_kg) : null,
    commodity: form.commodity,
    commodity_category: "general",
    sector: "industrial",
    value_mxn: form.value_mxn ? Number(form.value_mxn) : null,
    business_unit_id: form.business_unit_id,
    route_policy: "cuota"
  };
}

function phaseFromSummary(summary: WorkflowRunSummary): string {
  if (summary.approval_required) return "Approval";
  if (summary.route_source) return "Writeback";
  return summary.status;
}

function describeCurrentAction(detail: WorkflowRunDetail | null, submitting: boolean): string {
  if (submitting) return "Submitting RFQ";
  if (!detail) return "Waiting";
  if (detail.approval_state?.required) return "Waiting approval";
  if (detail.writeback_result) return `Writeback ${detail.writeback_result.status}`;
  if (detail.recommendation) return "Agent guide complete";
  if (detail.base_quote) return "Quote-core complete";
  if (detail.route_evidence) return "Route resolved";
  return "Processing";
}

function formatCurrency(value: number | null): string {
  if (value === null) return "Pending";
  return `$${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} MXN`;
}

export default RfqsPage;
