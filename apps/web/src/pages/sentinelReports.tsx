import { useCallback } from "react";
import { ScrollText } from "lucide-react";
import { listSentinelReports } from "../api/controlPlaneApi";
import { useAsyncResource } from "../api/useAsyncResource";
import { EmptyState, InlineError, PageSkeleton } from "../UiStates";

export function SentinelReportsPage() {
  const loadReports = useCallback(() => listSentinelReports(), []);
  const { data, error, loading, reload } = useAsyncResource(loadReports, []);
  const reports = data ?? [];

  return (
    <section aria-labelledby="sentinel-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Salud del producto</p>
          <h2 id="sentinel-heading">Reportes Sentinel</h2>
        </div>
      </div>

      {error ? (
        <InlineError message={error.message} action={<button className="button button-secondary" onClick={reload} type="button">Reintentar</button>} />
      ) : null}
      {loading ? <PageSkeleton rows={3} /> : null}

      {!loading && reports.length === 0 ? (
        <EmptyState title="Sin reportes semanales" body="Sentinel publicará el primero cuando cierre una semana operativa." />
      ) : null}

      {reports.map((report) => (
        <article className="panel" key={`${report.installation_id ?? ""}-${report.week_start}`}>
          <div className="panel-title">
            <ScrollText size={18} aria-hidden />
            <h3>
              Semana del {report.week_start}
              {report.installation_id ? ` — ${report.installation_id}` : ""}
            </h3>
          </div>
          {report.stats ? (
            <div className="compact-stats">
              <span>{report.stats.runs ?? 0} corridas</span>
              <span>{report.stats.errors ?? 0} errores</span>
              <span>{report.stats.interrupts ?? 0} interrupciones</span>
              <span>{Math.round(report.stats.avg_node_ms ?? 0)} ms/nodo prom.</span>
            </div>
          ) : null}
          <pre>{report.body_md}</pre>
        </article>
      ))}
    </section>
  );
}

export default SentinelReportsPage;
