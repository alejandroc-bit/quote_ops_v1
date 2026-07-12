import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowUpCircle, BarChart3, FileJson, Gauge, KeyRound, Settings2 } from "lucide-react";
import {
  getInstallation,
  getLatestRelease,
  listCredentialStatuses,
  listControlPlaneClients,
  listInstallationUsage,
  updateSettings,
  type ControlPlaneInstallationDetail,
  type ControlPlaneCredentialStatus,
  type ControlPlaneRelease,
  type ControlPlaneUsagePoint
} from "../api/controlPlaneApi";
import { useAsyncResource } from "../api/useAsyncResource";
import { isUpdateAvailable, parsePdfTemplate } from "../lib/portalSettings";
import { EmptyState, InlineError, PageSkeleton } from "../UiStates";

const PDF_TEMPLATE_PLACEHOLDER = `{
  "title": "Cotización de flete",
  "footer_note": "Tarifas sujetas a confirmación",
  "accent_color": "#000000",
  "show_breakdown": true
}`;

export function ClientProfilePage({
  tenantInstallations
}: {
  tenantInstallations?: ControlPlaneInstallationDetail[];
} = {}) {
  if (tenantInstallations) {
    return <TenantClientProfile installations={tenantInstallations} />;
  }
  return <VendorClientProfile />;
}

function VendorClientProfile() {
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
          <p className="eyebrow">Portal en nube</p>
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
        <InlineError message={error.message} />
      ) : null}
      {loading ? <PageSkeleton rows={3} /> : null}

      {client ? (
        <InstallationProfile
          installationId={client.installation.installation_id}
          key={client.client_id}
        />
      ) : !loading && !error ? (
        <EmptyState title="Sin clientes registrados" body="Crea un cliente en el registro para consultar su instalación, uso y configuración." />
      ) : null}
    </section>
  );
}

function TenantClientProfile({ installations }: { installations: ControlPlaneInstallationDetail[] }) {
  const [selectedInstallationId, setSelectedInstallationId] = useState(
    installations[0]?.installation_id ?? ""
  );
  const installation =
    installations.find((candidate) => candidate.installation_id === selectedInstallationId) ??
    installations[0] ??
    null;

  return (
    <section aria-labelledby="client-profile-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Portal en nube</p>
          <h2 id="client-profile-heading">Perfil del cliente</h2>
        </div>
        {installations.length > 1 ? (
          <label>
            Instalación{" "}
            <select
              aria-label="Seleccionar instalación"
              onChange={(event) => setSelectedInstallationId(event.target.value)}
              value={installation?.installation_id ?? ""}
            >
              {installations.map((candidate) => (
                <option key={candidate.installation_id} value={candidate.installation_id}>
                  {candidate.installation_id}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {installation ? (
        <InstallationProfile
          installationId={installation.installation_id}
          preloadedInstallation={installation}
        />
      ) : (
        <EmptyState title="Sin instalaciones" body="Tu organización todavía no tiene un appliance vinculado." />
      )}
    </section>
  );
}

function InstallationProfile({
  installationId,
  preloadedInstallation
}: {
  installationId: string;
  preloadedInstallation?: ControlPlaneInstallationDetail;
}) {
  const loadProfile = useCallback(async () => {
    const installation = preloadedInstallation ?? await getInstallation(installationId);
    const [release, usage, credentials] = await Promise.all([
      getLatestRelease(),
      listInstallationUsage(installationId),
      installation?.tenant_id
        ? listCredentialStatuses(installation.tenant_id)
        : Promise.resolve([])
    ]);
    return { installation, release, usage, credentials };
  }, [installationId, preloadedInstallation]);
  const { data, error, loading } = useAsyncResource(loadProfile, [installationId]);

  if (error) {
    return (
      <InlineError message={error.message} />
    );
  }
  if (loading || !data) return <PageSkeleton rows={4} />;

  return (
    <>
      <VersionCard installation={data.installation} release={data.release} />
      <SettingsCard installation={data.installation} installationId={installationId} />
      <CredentialsCard credentials={data.credentials} />
      <UsageCard usage={data.usage} />
    </>
  );
}

function CredentialsCard({ credentials }: { credentials: ControlPlaneCredentialStatus[] }) {
  return (
    <article className="panel">
      <div className="panel-title">
        <KeyRound size={18} aria-hidden />
        <h3>Credenciales conectadas</h3>
      </div>
      {credentials.length === 0 ? (
        <EmptyState title="Sin credenciales registradas" body="El plano de control todavía no recibe estados de credenciales para esta instalación." />
      ) : (
        <div className="registry-table-wrap">
          <table className="registry-table">
            <thead>
              <tr><th>Tipo</th><th>Estado</th><th>Actualizado</th></tr>
            </thead>
            <tbody>
              {credentials.map((credential) => (
                <tr key={credential.kind}>
                  <td>{credential.kind}</td>
                  <td>{credentialStatusLabel(credential.metadata)}</td>
                  <td>{credential.updated_at?.slice(0, 10) ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted">El portal muestra solo estado y metadatos; los secretos permanecen fuera de esta vista.</p>
    </article>
  );
}

function credentialStatusLabel(metadata: Record<string, unknown>): string {
  const status = metadata.status;
  return typeof status === "string" && status.trim() ? status : "Metadatos disponibles";
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
        <EmptyState title="Sin versiones publicadas" body="No hay una versión disponible para comparar con este appliance." />
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
      await updateSettings(installationId, {
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
        Campos soportados: title, footer_note, accent_color, logo_base64 y show_breakdown. Vacío
        = plantilla por defecto.
      </p>

      {saveError ? (
        <InlineError message={saveError} />
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
        <EmptyState title="Sin datos de uso" body="Los conteos agregados aparecerán después del primer pulso del appliance." />
      ) : (
        <div className="registry-table-wrap">
          <table className="registry-table">
            <thead>
              <tr>
                <th>Día</th>
                <th>Canal</th>
                <th>Cotizaciones</th>
                <th>Rutas</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((point) => (
                <tr key={`${point.day}-${point.channel}`}>
                  <td>{point.day}</td>
                  <td>{formatChannel(point.channel)}</td>
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

function formatChannel(channel: string | undefined): string {
  if (channel === "email") return "Correo";
  if (channel === "whatsapp") return "WhatsApp";
  return channel || "Todos";
}

export default ClientProfilePage;
