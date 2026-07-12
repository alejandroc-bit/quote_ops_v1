import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  FileSearch,
  History,
  RotateCcw,
  XCircle
} from "lucide-react";
import {
  listApprovals,
  submitDecision,
  type ApprovalDecisionAction,
  type ApprovalDecisionResponse,
  type ApprovalEnvelope
} from "../api/quoteOpsApi";
import { useAsyncResource } from "../api/useAsyncResource";

type ApprovalStatus =
  | "Pending approval"
  | "Approved by client approver"
  | "Rejected for rework"
  | "Review requested"
  | "Adjusted by client approver";

function formatCurrency(value: number | null) {
  if (value === null) return "Pending";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
    style: "currency",
    currency: "USD"
  })
    .format(value)
    .concat(" MXN");
}

export function ApprovalsPage() {
  const loadApprovals = useCallback(() => listApprovals(), []);
  const { data, error, loading, reload } = useAsyncResource(loadApprovals, [], 3000);
  const approvals = data ?? [];
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const approval =
    approvals.find((candidate) => candidate.run_id === selectedRunId) ?? approvals[0] ?? null;
  const [status, setStatus] = useState<ApprovalStatus>("Pending approval");
  const [decisionResponse, setDecisionResponse] = useState<ApprovalDecisionResponse | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [submittingAction, setSubmittingAction] = useState<ApprovalDecisionAction | null>(null);
  const [draftRate, setDraftRate] = useState("");
  const [showEvidence, setShowEvidence] = useState(false);
  const [showCriteria, setShowCriteria] = useState(false);
  const adjustedRate = useMemo(
    () => Number(draftRate) || approval?.recommended_rate_mxn || approval?.base_rate_mxn || 0,
    [approval?.base_rate_mxn, approval?.recommended_rate_mxn, draftRate]
  );

  useEffect(() => {
    if (!approvals.length) {
      setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !approvals.some((candidate) => candidate.run_id === selectedRunId)) {
      setSelectedRunId(approvals[0].run_id);
    }
  }, [approvals, selectedRunId]);

  useEffect(() => {
    if (!approval) return;
    setStatus(statusFromEnvelope(approval));
    setDecisionResponse(null);
    setDecisionError(null);
    setDraftRate(String(approval.recommended_rate_mxn ?? approval.base_rate_mxn ?? ""));
    setShowEvidence(false);
    setShowCriteria(false);
  }, [approval?.run_id]);

  async function decide(action: ApprovalDecisionAction, rate_mxn?: number) {
    if (!approval) return;
    setDecisionError(null);
    setSubmittingAction(action);
    try {
      const response = await submitDecision(approval.run_id, {
        action,
        ...(rate_mxn ? { rate_mxn } : {}),
        reason: action === "adjust" ? "Adjusted in client playground" : "Decision from client playground"
      });
      setDecisionResponse(response);
      setStatus(statusFromAction(action));
      reload();
    } catch (caught) {
      setDecisionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmittingAction(null);
    }
  }

  return (
    <section aria-labelledby="approvals-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Commercial decisions</p>
          <h2 id="approvals-heading">Approval workspace</h2>
        </div>
        <div className="compact-stats">
          <span className="status status-amber">{status}</span>
          <span>live every 3s</span>
        </div>
      </div>

      {loading ? <p className="panel muted">Loading approvals from API...</p> : null}
      {error ? (
        <div className="panel inline-error">
          <span>{error.message}</span>
          <button className="button button-secondary" onClick={reload} type="button">
            Retry
          </button>
        </div>
      ) : null}
      {!loading && !error && !approval ? (
        <p className="panel muted">No approval envelopes are pending in the local appliance.</p>
      ) : null}
      {approval ? (
        <div className="approval-layout">
          <ApprovalQueue
            approvals={approvals}
            selectedRunId={approval.run_id}
            setSelectedRunId={setSelectedRunId}
          />
          <ApprovalWorkspace
            adjustedRate={adjustedRate}
            approval={approval}
            decisionError={decisionError}
            decisionResponse={decisionResponse}
            draftRate={
              draftRate || String(approval.recommended_rate_mxn ?? approval.base_rate_mxn ?? "")
            }
            onDecision={decide}
            setDraftRate={setDraftRate}
            setShowCriteria={setShowCriteria}
            setShowEvidence={setShowEvidence}
            showCriteria={showCriteria}
            showEvidence={showEvidence}
            status={status}
            submittingAction={submittingAction}
          />
        </div>
      ) : null}
    </section>
  );
}

function ApprovalQueue({
  approvals,
  selectedRunId,
  setSelectedRunId
}: {
  approvals: ApprovalEnvelope[];
  selectedRunId: string;
  setSelectedRunId: (runId: string) => void;
}) {
  return (
    <aside className="panel approval-queue">
      <div className="panel-title">
        <FileSearch size={18} aria-hidden />
        <h3>Approval queue</h3>
      </div>
      {approvals.map((approval) => (
        <button
          className={
            approval.run_id === selectedRunId ? "queue-row queue-row-active" : "queue-row"
          }
          key={approval.run_id}
          onClick={() => setSelectedRunId(approval.run_id)}
          type="button"
        >
          <span>
            <strong>{approval.rfq_id}</strong>
            <small>{approval.client_id} / {approval.run_id}</small>
            <small>{approval.review_reasons.join(", ") || "approval_required"}</small>
          </span>
          <span className="status status-amber">Review</span>
        </button>
      ))}
    </aside>
  );
}

function ApprovalWorkspace({
  approval,
  adjustedRate,
  decisionError,
  decisionResponse,
  draftRate,
  onDecision,
  setDraftRate,
  setShowCriteria,
  setShowEvidence,
  showCriteria,
  showEvidence,
  status,
  submittingAction
}: {
  approval: ApprovalEnvelope;
  adjustedRate: number;
  decisionError: string | null;
  decisionResponse: ApprovalDecisionResponse | null;
  draftRate: string;
  onDecision: (action: ApprovalDecisionAction, rate_mxn?: number) => void;
  setDraftRate: (value: string) => void;
  setShowCriteria: (updater: (current: boolean) => boolean) => void;
  setShowEvidence: (updater: (current: boolean) => boolean) => void;
  showCriteria: boolean;
  showEvidence: boolean;
  status: ApprovalStatus;
  submittingAction: ApprovalDecisionAction | null;
}) {
  return (
    <>
      <article className="panel approval-main">
        <div className="approval-summary">
          <div>
            <p className="muted">{approval.rfq_id} / {approval.run_id}</p>
            <h3>{approval.lane.origin} {"->"} {approval.lane.destination}</h3>
          </div>
          <div className="rate-block">
            <span>Adjusted recommendation</span>
            <strong>{formatCurrency(adjustedRate || approval.recommended_rate_mxn)}</strong>
          </div>
        </div>

        <dl className="approval-facts">
          <div>
            <dt>Base rate</dt>
            <dd>{formatCurrency(approval.base_rate_mxn)}</dd>
          </div>
          <div>
            <dt>Quote-core recommendation</dt>
            <dd>{formatCurrency(approval.recommended_rate_mxn)}</dd>
          </div>
          <div>
            <dt>Approval owner</dt>
            <dd>{approval.client_id}</dd>
          </div>
          <div>
            <dt>Decision state</dt>
            <dd>{status}</dd>
          </div>
        </dl>

        <div className="adjustment-row">
          <label htmlFor="adjusted-rate">Adjusted rate</label>
          <input
            id="adjusted-rate"
            inputMode="numeric"
            onChange={(event) => setDraftRate(event.target.value)}
            type="number"
            value={draftRate}
          />
          <button
            className="button button-secondary"
            disabled={submittingAction !== null}
            onClick={() => onDecision("adjust", adjustedRate)}
            type="button"
          >
            Apply adjustment
          </button>
        </div>

        <div className="action-row">
          <button
            className="button button-primary"
            disabled={submittingAction !== null}
            onClick={() => onDecision("approve")}
            type="button"
          >
            <CheckCircle2 size={16} aria-hidden />
            Approve
          </button>
          <button
            className="button button-danger"
            disabled={submittingAction !== null}
            onClick={() => onDecision("reject")}
            type="button"
          >
            <XCircle size={16} aria-hidden />
            Reject
          </button>
          <button
            className="button button-secondary"
            disabled={submittingAction !== null}
            onClick={() => onDecision("request_review")}
            type="button"
          >
            <RotateCcw size={16} aria-hidden />
            Request review
          </button>
        </div>
        {decisionResponse ? (
          <p className="writeback-line">
            <span>Writeback</span>
            <strong>{decisionResponse.writeback_result?.status ?? "skipped"}</strong>
          </p>
        ) : null}
        {decisionError ? <p className="inline-error">{decisionError}</p> : null}
      </article>

      <aside className="panel inspector">
        <div className="panel-title">
          <FileSearch size={18} aria-hidden />
          <h3>Decision inspector</h3>
        </div>
        <button
          className="inspector-toggle"
          onClick={() => setShowEvidence((current) => !current)}
          type="button"
        >
          <Eye size={16} aria-hidden />
          View evidence
        </button>
        {showEvidence ? (
          <div className="inspector-box">
            <h4>SAKBE route evidence</h4>
            <p>
              {approval.evidence_flags.route_source ?? "route"} /{" "}
              {approval.evidence_flags.route_resolved ? "resolved" : "unresolved"} /{" "}
              {approval.evidence_flags.historical_layer ?? "no historical layer"}
            </p>
          </div>
        ) : null}

        <button
          className="inspector-toggle"
          onClick={() => setShowCriteria((current) => !current)}
          type="button"
        >
          <History size={16} aria-hidden />
          View criteria used
        </button>
        {showCriteria ? (
          <div className="inspector-box">
            <h4>Criteria used</h4>
            <ul>
              {approval.review_reasons.length > 0 ? (
                approval.review_reasons.map((reason) => <li key={reason}>{reason}</li>)
              ) : (
                <li>margin floor satisfied</li>
              )}
            </ul>
          </div>
        ) : null}

        <div className="risk-note">
          <AlertTriangle size={16} aria-hidden />
          Review blocks TMS writeback until a final decision is recorded.
        </div>
      </aside>
    </>
  );
}

function statusFromEnvelope(approval: ApprovalEnvelope): ApprovalStatus {
  if (approval.decision_status === "approved") return "Approved by client approver";
  if (approval.decision_status === "adjusted") return "Adjusted by client approver";
  if (approval.decision_status === "rejected") return "Rejected for rework";
  if (approval.decision_status === "review_requested") return "Review requested";
  return "Pending approval";
}

function statusFromAction(action: ApprovalDecisionAction): ApprovalStatus {
  if (action === "approve") return "Approved by client approver";
  if (action === "adjust") return "Adjusted by client approver";
  if (action === "reject") return "Rejected for rework";
  return "Review requested";
}

export default ApprovalsPage;
