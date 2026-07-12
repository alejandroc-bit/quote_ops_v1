import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowUpCircle, BarChart3, FileJson, Gauge, Settings2 } from "lucide-react";
import {
  getInstallation,
  getLatestRelease,
  listControlPlaneClients,
  listInstallationUsage,
  updateInstallationSettings,
  type ControlPlaneInstallationDetail,
  type ControlPlaneRelease,
  type ControlPlaneUsagePoint
} from "../api/controlPlaneApi";
import { useAsyncResource } from "../api/useAsyncResource";
import { isUpdateAvailable, parsePdfTemplate } from "../lib/portalSettings";

const PDF_TEMPLATE_PLACEHOLDER = `{
  "title": "Cotización de flete",
  "footer_note": "Tarifas sujetas a confirmación",
  "accent_color": "#0f766e",
  "show_breakdown": true
}`;

export function ClientProfilePage() {
  const loadClients = useCallback(() => listControlPlaneClients(), []);
  const { data: clients, error, loading } = useAsyncResource(loadClients, []);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const client =
    (clients ?? []).find((candidate) => candidate.client_id === selectedClientId) ??
    (clients ?? [])[0] ??
    null;

  return (
    <section aria-labelledby="client-profile-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Portal cloud</p>
          <h2 id="client-profile-heading">Perfil del cliente</h2>
        </div>
        {clients && clients.length > 0 ? (
          <label>
            Cliente{" "}
            <select
              aria-label="Seleccionar cliente"
              onChange={(event) => setSelectedClientId(event.target.value)}
              value={client?.client_id ?? ""}
            >
              {clients.map((candidate) => (
                <option key={candidate.client_id} value={candidate.client_id}>
                  {candidate.legal_name} ({candidate.client_id})
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      {error ? (
        <div className="panel inline-error">
          <span>{error.message}</span>
        </div>
      ) : null}
      {loading ? <p className="muted">Cargando clientes…</p> : null}

      {client ? (
        <InstallationProfile
          installationId={client.installation.installation_id}
          key={client.client_id}
        />
      ) : !loading && !error ? (
        <p className="muted">Todavía no hay clientes registrados.</p>
      ) : null}
    </section>
  );
}

function InstallationProfile({ installationId }: { installationId: string }) {
  const loadProfile = useCallback(async () => {
    const [installation, release, usage] = await Promise.all([
      getInstallation(installationId),
      getLatestRelease(),
      listInstallationUsage(installationId)
    ]);
    return { installation, release, usage };
  }, [installationId]);
  const { data, error, loading } = useAsyncResource(loadProfile, [installationId]);

  if (error) {
    return (
      <div className="panel inline-error">
        <span>{error.message}</span>
      </div>
    );
  }
  if (loading || !data) return <p className="muted">Cargando instalación…</p>;

  return (
    <>
      <VersionCard installation={data.installation} release={data.release} />
      <SettingsCard installation={data.installation} installationId={installationId} />
      <UsageCard usage={data.usage} />
    </>
  );
}

function VersionCard({
  installation,
  release
}: {
  installation: ControlPlaneInstallationDetail | null;
  release: ControlPlaneRelease | null;
}) {
  const installedVersion = installation?.version ?? null;
  const updateAvailable =
    release && isUpdateAvailable(installedVersion, release.version);

  return (
    <article className="panel">
      <div className="panel-title">
        <Gauge size={18} aria-hidden />
        <h3>Instalación</h3>
      </div>
      <p>
        Versión instalada: <strong>{installedVersion ?? "desconocida"}</strong>
      </p>
      {updateAvailable ? (
        <div className="panel inline-success" role="status">
          <ArrowUpCircle size={16} aria-hidden />
          <span>
            Actualización disponible {formatVersion(release.version)}. Ejecuta{" "}
            <code>upgrade.sh</code> en el appliance para aplicarla.
          </span>
        </div>
      ) : release ? (
        <p className="muted">
          Al día con la última versión publicada ({formatVersion(release.version)}).
        </p>
      ) : (
        <p className="muted">Sin información de versiones publicadas todavía.</p>
      )}
    </article>
  );
}

function SettingsCard({
  installation,
  installationId
}: {
  installation: ControlPlaneInstallationDetail | null;
  installationId: string;
}) {
  const [pricingModel, setPricingModel] = useState<"formula" | "profitability">("formula");
  const [pdfTemplateRaw, setPdfTemplateRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const settings = installation?.settings;
    if (settings?.pricing_model === "profitability") setPricingModel("profitability");
    if (settings?.pdf_template) {
      setPdfTemplateRaw(JSON.stringify(settings.pdf_template, null, 2));
    }
  }, [installation]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    setSaveError(null);
    const template = parsePdfTemplate(pdfTemplateRaw);
    if (!template.ok) {
      setSaveError(template.error);
      return;
    }
    setSaving(true);
    try {
      await updateInstallationSettings(installationId, {
        ...installation?.settings,
        pricing_model: pricingModel,
        pdf_template: template.value
      });
      setMessage("Configuración guardada. El appliance la sincroniza en el siguiente heartbeat.");
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel" onSubmit={saveSettings}>
      <div className="panel-title">
        <Settings2 size={18} aria-hidden />
        <h3>Configuración</h3>
      </div>

      <fieldset>
        <legend>Modelo de cotización</legend>
        <label>
          <input
            checked={pricingModel === "formula"}
            name="pricing-model"
            onChange={() => setPricingModel("formula")}
            type="radio"
            value="formula"
          />{" "}
          Margen fijo
        </label>
        <label>
          <input
            checked={pricingModel === "profitability"}
            name="pricing-model"
            onChange={() => setPricingModel("profitability")}
            type="radio"
            value="profitability"
          />{" "}
          Rentabilidad RB
        </label>
      </fieldset>

      <label htmlFor="pdf-template-json">
        <FileJson size={16} aria-hidden /> Plantilla PDF (JSON)
      </label>
      <textarea
        id="pdf-template-json"
        onChange={(event) => setPdfTemplateRaw(event.target.value)}
        placeholder={PDF_TEMPLATE_PLACEHOLDER}
        rows={8}
        spellCheck={false}
        value={pdfTemplateRaw}
      />
      <p className="muted">
        Campos soportados: title, footer_note, accent_color, show_breakdown. Vacío = plantilla
        por defecto.
      </p>

      {saveError ? (
        <div className="panel inline-error">
          <span>{saveError}</span>
        </div>
      ) : null}
      {message ? (
        <div className="panel inline-success">
          <span>{message}</span>
        </div>
      ) : null}

      <button className="button button-primary" disabled={saving} type="submit">
        {saving ? "Guardando…" : "Guardar configuración"}
      </button>
    </form>
  );
}

function UsageCard({ usage }: { usage: ControlPlaneUsagePoint[] }) {
  return (
    <article className="panel">
      <div className="panel-title">
        <BarChart3 size={18} aria-hidden />
        <h3>Uso por día</h3>
      </div>
      {usage.length === 0 ? (
        <p className="muted">Sin datos de uso todavía.</p>
      ) : (
        <div className="registry-table-wrap">
          <table className="registry-table">
            <thead>
              <tr>
                <th>Día</th>
                <th>Cotizaciones</th>
                <th>Rutas</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((point) => (
                <tr key={point.day}>
                  <td>{point.day}</td>
                  <td>{point.quotes}</td>
                  <td>{point.routes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </article>
  );
}

function formatVersion(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

export default ClientProfilePage;
