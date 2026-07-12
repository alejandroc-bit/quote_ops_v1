import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  ListTree,
  Loader,
  XCircle
} from "lucide-react";
import {
  getRun,
  listRuns,
  mergeStep,
  runStreamUrl,
  stepDurationMs,
  type RunDetail,
  type RunSummary,
  type StepEvent
} from "../api/runsApi";
import { useAsyncResource } from "../api/useAsyncResource";

export function RunsPage() {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  if (selectedRunId) {
    return <RunDetailView onBack={() => setSelectedRunId(null)} runId={selectedRunId} />;
  }
  return <RunsListView onSelect={setSelectedRunId} />;
}

function RunsListView({ onSelect }: { onSelect: (runId: string) => void }) {
  const loadRuns = useCallback(() => listRuns(), []);
  const { data, error, loading, reload } = useAsyncResource(loadRuns, [], 5000);
  const runs = data ?? [];

  return (
    <section aria-labelledby="runs-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Procesamiento del agente</p>
          <h2 id="runs-heading">Corridas recientes</h2>
        </div>
        <div className="compact-stats">
          <span>actualiza cada 5s</span>
        </div>
      </div>

      {loading && !data ? <p className="panel muted">Cargando corridas...</p> : null}
      {error ? (
        <div className="panel inline-error">
          <span>{error.message}</span>
          <button className="button button-secondary" onClick={reload} type="button">
            Reintentar
          </button>
        </div>
      ) : null}
      {!loading && !error && runs.length === 0 ? (
        <p className="panel muted">
          Aún no hay corridas registradas. Las cotizaciones procesadas por el agente aparecerán aquí.
        </p>
      ) : null}

      {runs.length > 0 ? (
        <div className="registry-table-wrap">
          <table className="registry-table">
            <thead>
              <tr>
                <th>Corrida</th>
                <th>Canal</th>
                <th>Estado</th>
                <th>Resumen</th>
                <th>Creada</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.run_id}
                  onClick={() => onSelect(run.run_id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>
                    <strong>{shortRunId(run.run_id)}</strong>
                    <small>{run.run_id}</small>
                  </td>
                  <td>
                    <span className="status status-blue">{run.channel}</span>
                  </td>
                  <td>
                    <span className={statusChipClass(run.status)}>{statusLabel(run.status)}</span>
                  </td>
                  <td>
                    <small>{run.summary ?? "—"}</small>
                  </td>
                  <td>
                    <small>{formatTimestamp(run.created_at)}</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function RunDetailView({ onBack, runId }: { onBack: () => void; runId: string }) {
  const [run, setRun] = useState<RunSummary | null>(null);
  const [steps, setSteps] = useState<StepEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [liveMode, setLiveMode] = useState<"sse" | "polling">("sse");
  const stepsRef = useRef<StepEvent[]>([]);

  const applyDetail = useCallback((detail: RunDetail | null) => {
    if (!detail) return;
    setRun(detail.run);
    stepsRef.current = detail.steps;
    setSteps(detail.steps);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | null = null;
    let pollTimer: number | null = null;

    const startPolling = () => {
      setLiveMode("polling");
      if (pollTimer !== null) return;
      pollTimer = window.setInterval(() => {
        getRun(runId)
          .then((detail) => {
            if (!cancelled) applyDetail(detail);
          })
          .catch(() => {
            /* keep last known state; next poll retries */
          });
      }, 3000);
    };

    getRun(runId)
      .then((detail) => {
        if (cancelled) return;
        if (!detail) {
          setError("La corrida no está disponible en el appliance local.");
        } else {
          applyDetail(detail);
        }
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    try {
      source = new EventSource(runStreamUrl(runId));
      source.addEventListener("step", (event) => {
        try {
          const incoming = JSON.parse((event as MessageEvent).data) as StepEvent;
          stepsRef.current = mergeStep(stepsRef.current, incoming);
          setSteps(stepsRef.current);
        } catch {
          /* ignore malformed events */
        }
      });
      source.addEventListener("done", () => {
        source?.close();
        // refresh final run status once the stream finishes
        getRun(runId).then((detail) => {
          if (!cancelled) applyDetail(detail);
        }).catch(() => {});
      });
      source.onerror = () => {
        source?.close();
        if (!cancelled) startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      source?.close();
      if (pollTimer !== null) window.clearInterval(pollTimer);
    };
  }, [applyDetail, runId]);

  return (
    <section aria-labelledby="run-detail-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Detalle de corrida</p>
          <h2 id="run-detail-heading">{shortRunId(runId)}</h2>
        </div>
        <div className="compact-stats">
          {run ? <span className={statusChipClass(run.status)}>{statusLabel(run.status)}</span> : null}
          <span>{liveMode === "sse" ? "en vivo (SSE)" : "sondeo cada 3s"}</span>
        </div>
      </div>

      <div className="action-row">
        <button className="button button-secondary" onClick={onBack} type="button">
          <ArrowLeft size={16} aria-hidden />
          Volver a corridas
        </button>
      </div>

      {run?.status === "waiting_approval" ? (
        <div className="panel setup-boundary-note">
          <ClipboardCheck size={20} aria-hidden />
          <div>
            <strong>Esta corrida espera aprobación humana</strong>
            <p>
              La cotización está detenida hasta que un aprobador decida.{" "}
              <button
                className="button button-secondary"
                onClick={() => navigateToPage("approvals")}
                type="button"
              >
                Ir a Aprobaciones
              </button>
            </p>
          </div>
        </div>
      ) : null}

      {loading ? <p className="panel muted">Cargando pasos...</p> : null}
      {error ? <p className="panel inline-error">{error}</p> : null}
      {!loading && !error && steps.length === 0 ? (
        <p className="panel muted">Sin pasos registrados todavía para esta corrida.</p>
      ) : null}

      {steps.length > 0 ? (
        <article className="panel">
          <div className="panel-title">
            <ListTree size={18} aria-hidden />
            <h3>Línea de tiempo de pasos</h3>
          </div>
          <ol className="workflow-timeline">
            {steps.map((step, index) => (
              <StepRow durationMs={stepDurationMs(steps, index)} key={step.seq} step={step} />
            ))}
          </ol>
        </article>
      ) : null}
    </section>
  );
}

function StepRow({ durationMs, step }: { durationMs: number | null; step: StepEvent }) {
  const Icon = step.status === "start" ? Loader : step.status === "error" ? XCircle : CheckCircle2;
  const stepClass =
    step.status === "error"
      ? "workflow-step workflow-step-failed"
      : step.status === "start"
        ? "workflow-step workflow-step-running"
        : "workflow-step workflow-step-completed";

  return (
    <li className={stepClass}>
      <Icon size={18} aria-hidden />
      <span>
        <strong>
          {step.node} · {stepStatusLabel(step.status)}
          {durationMs !== null ? ` · ${formatDuration(durationMs)}` : ""}
        </strong>
        <small>{step.summary ?? "—"}</small>
        <small>{formatTimestamp(step.ts)}</small>
        {step.data !== undefined && step.data !== null ? (
          <details>
            <summary>Ver datos</summary>
            <pre style={{ overflowX: "auto", fontSize: "0.72rem" }}>
              {JSON.stringify(step.data, null, 2)}
            </pre>
          </details>
        ) : null}
      </span>
    </li>
  );
}

export const NAVIGATE_EVENT = "quoteops:navigate";

function navigateToPage(page: string) {
  window.dispatchEvent(new CustomEvent(NAVIGATE_EVENT, { detail: page }));
}

function shortRunId(runId: string): string {
  return runId.length > 12 ? `${runId.slice(0, 12)}…` : runId;
}

function statusChipClass(status: string): string {
  if (status === "completed" || status === "done") return "status status-green";
  if (status === "waiting_approval" || status === "error" || status === "failed") {
    return "status status-amber";
  }
  return "status status-blue";
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    completed: "Completada",
    done: "Completada",
    running: "En proceso",
    waiting_approval: "Espera aprobación",
    error: "Error",
    failed: "Error"
  };
  return labels[status] ?? status;
}

function stepStatusLabel(status: StepEvent["status"]): string {
  if (status === "start") return "inicio";
  if (status === "error") return "error";
  return "fin";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("es-MX");
}

export default RunsPage;
