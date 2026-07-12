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
import { EmptyState, InlineError, PageSkeleton } from "../UiStates";
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
      label: "Listo para cotizar",
      detail: "El appliance local espera una solicitud del playground o del TMS.",
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
        label: "Solicitud capturada",
        detail: `${nextForm.origin_city} a ${nextForm.destination_city} ingresó al playground.`,
        status: "completed"
      },
      {
        id: "api",
        label: "Envío a la API local",
        detail: "POST /api/playground/rfqs convierte el formulario al contrato de cotización.",
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
          label: response.status === "RECEIVED" ? "Flujo en cola" : "Flujo completado",
          detail:
            response.status === "RECEIVED"
              ? `${response.run_id} fue aceptada; el monitor consulta el estado de cada nodo.`
              : `${response.run_id} terminó en ${response.status}; requiere aprobación: ${response.approval_required ? "sí" : "no"}.`,
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
          label: "La solicitud falló de forma segura",
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
          <p className="eyebrow">Cotización en tiempo real</p>
          <h2 id="rfq-heading">Operación de cotizaciones</h2>
        </div>
        <div className="compact-stats" aria-label="RFQ metrics">
          <span>{rfqs.length} almacenadas</span>
          <span>{reviewBlocks} por revisar</span>
          <span>{currentAction}</span>
          <span>Actualización cada 3 s</span>
        </div>
      </div>

      <div className="ops-grid">
        <form className="panel rfq-intake" onSubmit={submitRfq}>
          <div className="panel-title">
            <FileInput size={18} aria-hidden />
            <h3>Crear cotización</h3>
          </div>
          <div className="form-grid">
            <TextField form={form} label="Ciudad de origen" name="origin_city" setForm={setForm} />
            <TextField form={form} label="Estado de origen" name="origin_state" setForm={setForm} />
            <TextField
              form={form}
              label="Ciudad de destino"
              name="destination_city"
              setForm={setForm}
            />
            <TextField
              form={form}
              label="Estado de destino"
              name="destination_state"
              setForm={setForm}
            />
            <TextField
              form={form}
              label="Perfil vehicular"
              name="vehicle_profile_id"
              setForm={setForm}
            />
            <TextField
              form={form}
              label="Equipo"
              name="equipment_request"
              setForm={setForm}
            />
            <TextField form={form} label="Peso en kg" name="weight_kg" setForm={setForm} />
            <TextField form={form} label="Valor de la carga" name="value_mxn" setForm={setForm} />
            <TextField form={form} label="Mercancía" name="commodity" setForm={setForm} />
            <TextField
              form={form}
              label="Unidad de negocio"
              name="business_unit_id"
              setForm={setForm}
            />
          </div>
          <div className="action-row">
            <button className="button button-primary" disabled={submitting} type="submit">
              <Send size={16} aria-hidden />
              {submitting ? "Procesando…" : "Procesar cotización"}
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
              Probar caso sin peso
            </button>
          </div>
        </form>

        <article className="panel live-monitor">
          <div className="panel-title panel-title-action">
            <span>
              <Activity size={18} aria-hidden />
              <h3>Monitor de corrida</h3>
            </span>
            <button aria-label="Actualizar cotizaciones" className="icon-button" onClick={reload} title="Actualizar cotizaciones" type="button">
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
            <EmptyState title="Sin señal activa" body="Procesa la primera solicitud para ver su estado en tiempo real." />
          )}
          <ActivityFeed entries={activityLog} />
        </article>

        <div className="panel rfq-list">
          <div className="panel-title">
            <ListChecks size={18} aria-hidden />
            <h3>Cola de cotizaciones</h3>
          </div>
          {loading ? <PageSkeleton rows={3} /> : null}
          {error ? (
            <InlineError
              message={error.message}
              action={<button className="button button-secondary" onClick={reload} type="button">Reintentar</button>}
            />
          ) : null}
          {!loading && !error && rfqs.length === 0 ? (
            <EmptyState title="Sin cotizaciones aún" body="Las solicitudes recibidas desde el TMS, correo o playground aparecerán aquí." />
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
                {rfq.approval_required ? "Aprobación" : "Escritura TMS"}
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
          {summary.approval_required ? "Requiere aprobación" : "Lista"}
        </span>
      </div>
      <dl className="rfq-detail-grid">
        <div>
          <dt>Recepción</dt>
          <dd>Playground → API local</dd>
        </div>
        <div>
          <dt>Fase actual</dt>
          <dd>{phaseFromSummary(summary)}</dd>
        </div>
        <div>
          <dt>Ruta</dt>
          <dd>
            {lane
                ? `${lane.origin.city} → ${lane.destination.city}`
                : "Cargando ruta"}
          </dd>
        </div>
        <div>
          <dt>Peso</dt>
          <dd>{lane?.cargo.weight_kg ? `${lane.cargo.weight_kg} kg` : "Sin dato"}</dd>
        </div>
        <div>
          <dt>SAKBE</dt>
          <dd>
            {detail?.route_evidence
              ? `${detail.route_evidence.status}, ${detail.route_evidence.km_loaded ?? "?"} km`
              : detailLoading
                ? "Cargando"
                : "Pendiente"}
          </dd>
        </div>
        <div>
          <dt>Quote-core</dt>
          <dd>{formatCurrency(summary.base_rate_mxn)}</dd>
        </div>
      </dl>
      {detail?.recommendation ? (
        <p className="agent-note">
          Guía operativa: {detail.recommendation.reason}
        </p>
      ) : null}
      {detailLoading && !detail ? <PageSkeleton rows={2} /> : null}
      {detailError ? <InlineError message={detailError} /> : null}
    </div>
  );
}

function ActivityFeed({ entries }: { entries: ActivityEntry[] }) {
  return (
    <div className="activity-feed" aria-label="Actividad del proceso">
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
  if (summary.approval_required) return "Aprobación";
  if (summary.route_source) return "Escritura TMS";
  return summary.status;
}

function describeCurrentAction(detail: WorkflowRunDetail | null, submitting: boolean): string {
  if (submitting) return "Procesando solicitud";
  if (!detail) return "En espera";
  if (detail.approval_state?.required) return "Espera aprobación";
  if (detail.writeback_result) return `Escritura ${detail.writeback_result.status}`;
  if (detail.recommendation) return "Recomendación lista";
  if (detail.base_quote) return "Cálculo listo";
  if (detail.route_evidence) return "Ruta resuelta";
  return "En proceso";
}

function formatCurrency(value: number | null): string {
  if (value === null) return "Pendiente";
  return `$${new Intl.NumberFormat("es-MX", { maximumFractionDigits: 0 }).format(value)} MXN`;
}

export default RfqsPage;
