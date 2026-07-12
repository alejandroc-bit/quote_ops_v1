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
import { EmptyState, InlineError, PageSkeleton } from "../UiStates";

type ApprovalStatus =
  | "Pendiente de aprobación"
  | "Aprobada por el cliente"
  | "Rechazada para corrección"
  | "Revisión solicitada"
  | "Ajustada por el cliente";

function formatCurrency(value: number | null) {
  if (value === null) return "Pendiente";
  return `$${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(value)} MXN`;
}

export function ApprovalsPage() {
  const loadApprovals = useCallback(() => listApprovals(), []);
  const { data, error, loading, reload } = useAsyncResource(loadApprovals, [], 3000);
  const approvals = data ?? [];
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const approval =
    approvals.find((candidate) => candidate.run_id === selectedRunId) ?? approvals[0] ?? null;
  const [status, setStatus] = useState<ApprovalStatus>("Pendiente de aprobación");
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
        reason: action === "adjust" ? "Ajuste desde el playground del cliente" : "Decisión desde el playground del cliente"
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
          <p className="eyebrow">Decisiones comerciales</p>
          <h2 id="approvals-heading">Centro de aprobaciones</h2>
        </div>
        <div className="compact-stats">
          <span className="status status-amber">{status}</span>
          <span>Actualización cada 3 s</span>
        </div>
      </div>

      {loading ? <PageSkeleton rows={3} /> : null}
      {error ? (
        <InlineError
          message={error.message}
          action={<button className="button button-secondary" onClick={reload} type="button">Reintentar</button>}
        />
      ) : null}
      {!loading && !error && !approval ? (
        <EmptyState title="Sin decisiones pendientes" body="Las cotizaciones que crucen un umbral de control aparecerán aquí antes de escribir al TMS." />
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
        <h3>Cola de aprobación</h3>
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
          <span className="status status-amber">Revisar</span>
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
            <h3>{approval.lane.origin} → {approval.lane.destination}</h3>
          </div>
          <div className="rate-block">
            <span>Recomendación ajustada</span>
            <strong>{formatCurrency(adjustedRate || approval.recommended_rate_mxn)}</strong>
          </div>
        </div>

        <dl className="approval-facts">
          <div>
            <dt>Tarifa base</dt>
            <dd>{formatCurrency(approval.base_rate_mxn)}</dd>
          </div>
          <div>
            <dt>Recomendación de Quote-core</dt>
            <dd>{formatCurrency(approval.recommended_rate_mxn)}</dd>
          </div>
          <div>
            <dt>Responsable de aprobar</dt>
            <dd>{approval.client_id}</dd>
          </div>
          <div>
            <dt>Estado de decisión</dt>
            <dd>{status}</dd>
          </div>
        </dl>

        <div className="adjustment-row">
          <label htmlFor="adjusted-rate">Tarifa ajustada</label>
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
            Aplicar ajuste
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
            Aprobar
          </button>
          <button
            className="button button-danger"
            disabled={submittingAction !== null}
            onClick={() => onDecision("reject")}
            type="button"
          >
            <XCircle size={16} aria-hidden />
            Rechazar
          </button>
          <button
            className="button button-secondary"
            disabled={submittingAction !== null}
            onClick={() => onDecision("request_review")}
            type="button"
          >
            <RotateCcw size={16} aria-hidden />
            Solicitar revisión
          </button>
        </div>
        {decisionResponse ? (
          <p className="writeback-line">
            <span>Escritura TMS</span>
            <strong>{decisionResponse.writeback_result?.status ?? "omitida"}</strong>
          </p>
        ) : null}
        {decisionError ? <InlineError message={decisionError} /> : null}
      </article>

      <aside className="panel inspector">
        <div className="panel-title">
          <FileSearch size={18} aria-hidden />
          <h3>Inspector de decisión</h3>
        </div>
        <button
          className="inspector-toggle"
          onClick={() => setShowEvidence((current) => !current)}
          type="button"
        >
          <Eye size={16} aria-hidden />
          Ver evidencia
        </button>
        {showEvidence ? (
          <div className="inspector-box">
            <h4>Evidencia de ruta SAKBE</h4>
            <p>
              {approval.evidence_flags.route_source ?? "route"} /{" "}
              {approval.evidence_flags.route_resolved ? "resuelta" : "sin resolver"} /{" "}
              {approval.evidence_flags.historical_layer ?? "sin capa histórica"}
            </p>
          </div>
        ) : null}

        <button
          className="inspector-toggle"
          onClick={() => setShowCriteria((current) => !current)}
          type="button"
        >
          <History size={16} aria-hidden />
          Ver criterios aplicados
        </button>
        {showCriteria ? (
          <div className="inspector-box">
            <h4>Criterios aplicados</h4>
            <ul>
              {approval.review_reasons.length > 0 ? (
                approval.review_reasons.map((reason) => <li key={reason}>{reason}</li>)
              ) : (
                <li>Margen mínimo satisfecho</li>
              )}
            </ul>
          </div>
        ) : null}

        <div className="risk-note">
          <AlertTriangle size={16} aria-hidden />
          La revisión bloquea la escritura al TMS hasta registrar una decisión final.
        </div>
      </aside>
    </>
  );
}

function statusFromEnvelope(approval: ApprovalEnvelope): ApprovalStatus {
  if (approval.decision_status === "approved") return "Aprobada por el cliente";
  if (approval.decision_status === "adjusted") return "Ajustada por el cliente";
  if (approval.decision_status === "rejected") return "Rechazada para corrección";
  if (approval.decision_status === "review_requested") return "Revisión solicitada";
  return "Pendiente de aprobación";
}

function statusFromAction(action: ApprovalDecisionAction): ApprovalStatus {
  if (action === "approve") return "Aprobada por el cliente";
  if (action === "adjust") return "Ajustada por el cliente";
  if (action === "reject") return "Rechazada para corrección";
  return "Revisión solicitada";
}

export default ApprovalsPage;
