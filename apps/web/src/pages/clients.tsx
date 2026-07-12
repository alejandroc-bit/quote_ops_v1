import { FormEvent, useCallback, useMemo, useState } from "react";
import {
  Activity,
  Building2,
  FileKey2,
  KeyRound,
  PackagePlus,
  PauseCircle,
  PlayCircle,
  RefreshCcw,
  ShieldAlert,
  UserCheck
} from "lucide-react";
import {
  createControlPlaneClient,
  generateControlPlaneInstallPack,
  listControlPlaneClients,
  reactivateControlPlaneClient,
  reissueControlPlaneLicense,
  suspendControlPlaneClient,
  type ControlPlaneClient,
  type ControlPlaneInstallPack
} from "../api/controlPlaneApi";
import { useAsyncResource } from "../api/useAsyncResource";
import { EmptyState, InlineError, PageSkeleton } from "../UiStates";

type ClientForm = {
  client_id: string;
  legal_name: string;
  authorized_email: string;
};

const defaultForm: ClientForm = {
  client_id: "CLIENTE4",
  legal_name: "Nueva transportista",
  authorized_email: "owner@cliente4.example"
};

export function ClientsPage() {
  const [form, setForm] = useState(defaultForm);
  const [installPack, setInstallPack] = useState<ControlPlaneInstallPack | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const loadClients = useCallback(() => listControlPlaneClients(), []);
  const {
    data,
    error,
    loading,
    reload
  } = useAsyncResource(loadClients, [], 10000);
  const clients = data ?? [];
  const stats = useMemo(
    () => ({
      active: clients.filter((client) => client.status === "active").length,
      onboarding: clients.filter((client) => client.status === "onboarding").length,
      suspended: clients.filter((client) => client.status === "suspended").length,
      quotes: clients.reduce((total, client) => total + client.counters.total, 0)
    }),
    [clients]
  );

  async function createClient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await runAction("create-client", async () => {
      const client = await createControlPlaneClient({
        client_id: form.client_id.trim(),
        legal_name: form.legal_name.trim(),
        authorized_email: form.authorized_email.trim()
      });
      const pack = await generateControlPlaneInstallPack(client.client_id);
      setInstallPack(pack);
      setActionMessage(`Cliente ${client.client_id} creado; paquete de instalación listo.`);
      reload();
    });
  }

  async function generatePack(client: ControlPlaneClient) {
    await runAction(`pack-${client.client_id}`, async () => {
      const pack = await generateControlPlaneInstallPack(client.client_id);
      setInstallPack(pack);
      setActionMessage(`Paquete de instalación listo para ${client.client_id}.`);
    });
  }

  async function suspendClient(client: ControlPlaneClient) {
    await runAction(`suspend-${client.client_id}`, async () => {
      await suspendControlPlaneClient(client.client_id);
      setActionMessage(`${client.client_id} quedó suspendido.`);
      reload();
    });
  }

  async function reactivateClient(client: ControlPlaneClient) {
    await runAction(`reactivate-${client.client_id}`, async () => {
      await reactivateControlPlaneClient(client.client_id);
      setActionMessage(`${client.client_id} quedó reactivado.`);
      reload();
    });
  }

  async function reissueLicense(client: ControlPlaneClient) {
    await runAction(`reissue-${client.client_id}`, async () => {
      await reissueControlPlaneLicense(client.client_id);
      setActionMessage(`Licencia reemitida para ${client.client_id}.`);
      reload();
    });
  }

  async function runAction(action: string, callback: () => Promise<void>) {
    setBusyAction(action);
    setActionError(null);
    setActionMessage(null);
    try {
      await callback();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section aria-labelledby="clients-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Plano de control Inducta</p>
          <h2 id="clients-heading">Clientes autorizados</h2>
        </div>
        <div className="compact-stats">
          <span>{stats.active} activos</span>
          <span>{stats.onboarding} en onboarding</span>
          <span>{stats.suspended} suspendidos</span>
          <span>{stats.quotes} cotizaciones</span>
        </div>
      </div>

      {error ? (
        <InlineError message={error.message} action={<button className="button button-secondary" onClick={reload} type="button">Reintentar</button>} />
      ) : null}

      {actionError ? (
        <InlineError message={actionError} />
      ) : null}

      {actionMessage ? (
        <div className="panel inline-success">
          <span>{actionMessage}</span>
        </div>
      ) : null}

      <div className="clients-layout">
        <article className="panel clients-list">
          <div className="panel-title">
            <Building2 size={18} aria-hidden />
            <h3>Registro de clientes</h3>
          </div>
          <div className="registry-table-wrap">
            <table className="registry-table">
              <thead>
                <tr>
                  <th>Cliente</th>
                  <th>Usuario autorizado</th>
                  <th>Instalación</th>
                  <th>Último pulso</th>
                  <th>Cotizaciones</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {clients.map((client) => (
                  <tr key={client.client_id}>
                    <td>
                      <strong>{client.legal_name}</strong>
                      <small>{client.client_id}</small>
                      <span className={`registry-status registry-${client.status}`}>
                        {statusLabel(client.status)}
                      </span>
                    </td>
                    <td>
                      <span>{primaryAuthorizedUser(client)}</span>
                      <small>Acceso permitido en nube</small>
                    </td>
                    <td>
                      <span>{client.installation.installation_id}</span>
                      <small>
                        {client.installation.license_status} / llave de IA{" "}
                        {client.installation.ai_key_status}
                      </small>
                    </td>
                    <td>
                      <span>{formatHeartbeat(client.installation.last_heartbeat_at)}</span>
                      <small>{client.installation.onboarding_status}</small>
                    </td>
                    <td>
                      <div className="quote-counters" aria-label={`Conteos de ${client.client_id}`}>
                        <span>{client.counters.total} total</span>
                        <span>{client.counters.validated} validadas</span>
                        <span>{client.counters.rejected} rechazadas</span>
                        <span>{client.counters.pending} pendientes</span>
                        <span>{client.counters.failed} fallidas</span>
                      </div>
                    </td>
                    <td>
                      <div className="client-actions">
                        <button
                          className="icon-button"
                          disabled={Boolean(busyAction)}
                          onClick={() => void generatePack(client)}
                          title="Generar paquete de instalación"
                          type="button"
                        >
                          <PackagePlus size={16} aria-hidden />
                          <span className="sr-only">Generar paquete de instalación {client.client_id}</span>
                        </button>
                        {client.status === "suspended" ? (
                          <button
                            className="icon-button"
                            disabled={Boolean(busyAction)}
                            onClick={() => void reactivateClient(client)}
                            title="Reactivar cliente"
                            type="button"
                          >
                            <PlayCircle size={16} aria-hidden />
                            <span className="sr-only">Reactivar {client.client_id}</span>
                          </button>
                        ) : (
                          <button
                            className="icon-button"
                            disabled={Boolean(busyAction)}
                            onClick={() => void suspendClient(client)}
                            title="Suspender cliente"
                            type="button"
                          >
                            <PauseCircle size={16} aria-hidden />
                            <span className="sr-only">Suspender {client.client_id}</span>
                          </button>
                        )}
                        <button
                          className="icon-button"
                          disabled={Boolean(busyAction)}
                          onClick={() => void reissueLicense(client)}
                          title="Reemitir licencia"
                          type="button"
                        >
                          <RefreshCcw size={16} aria-hidden />
                          <span className="sr-only">Reemitir licencia {client.client_id}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && clients.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <EmptyState title="Sin clientes autorizados" body="Crea el primer cliente para emitir su paquete privado de instalación." />
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {loading ? <PageSkeleton rows={3} /> : null}
        </article>

        <form className="panel onboarding-form" onSubmit={createClient}>
          <div className="panel-title">
            <UserCheck size={18} aria-hidden />
            <h3>Crear cliente</h3>
          </div>
          <label>
            ID del cliente
            <input
              onChange={(event) => setForm({ ...form, client_id: event.target.value })}
              value={form.client_id}
            />
          </label>
          <label>
            Razón social
            <input
              onChange={(event) => setForm({ ...form, legal_name: event.target.value })}
              value={form.legal_name}
            />
          </label>
          <label>
            Correo autorizado
            <input
              onChange={(event) =>
                setForm({ ...form, authorized_email: event.target.value })
              }
              type="email"
              value={form.authorized_email}
            />
          </label>
          <button
            className="button button-primary"
            disabled={Boolean(busyAction)}
            type="submit"
          >
            <PackagePlus size={16} aria-hidden />
            Crear cliente
          </button>
        </form>
      </div>

      <div className="setup-layout">
        <article className="panel install-pack-preview">
          <div className="panel-title">
            <FileKey2 size={18} aria-hidden />
            <h3>Paquete de instalación</h3>
          </div>
          {installPack ? (
            <>
              <div className="install-pack-meta">
                <span>{installPack.client_id}</span>
                <span>{installPack.installation_id}</span>
                <span>Vence {installPack.expires_at}</span>
              </div>
              <p className="muted">
                Incluye client-manifest.yaml, criteria-template.yaml y
                tms-adapter-template.yaml. No contiene valores secretos.
              </p>
              <pre>{installPack.install_command}</pre>
              <small className="token-note">
                Token de registro: {installPack.registration_token}
              </small>
            </>
          ) : (
            <EmptyState title="Sin paquete generado" body="Crea un cliente o genera su paquete para obtener el comando de instalación." />
          )}
        </article>

        <aside className="panel control-plane-note">
          <ShieldAlert size={18} aria-hidden />
          <p>
            La nube conserva usuarios autorizados, licencia, último pulso, estado de la llave de IA
            y conteos agregados. Solicitudes, rutas, filas del TMS, decisiones y secretos permanecen
            dentro del appliance del cliente.
          </p>
          <div className="minimal-flow">
            <span><KeyRound size={16} aria-hidden /> El acceso autoriza la instalación</span>
            <span><Activity size={16} aria-hidden /> Solo se sincronizan totales</span>
          </div>
        </aside>
      </div>
    </section>
  );
}

function primaryAuthorizedUser(client: ControlPlaneClient): string {
  return client.authorized_users[0]?.email ?? "Sin usuario autorizado";
}

function formatHeartbeat(value: string | null): string {
  if (!value) return "Sin instalar";
  return new Intl.DateTimeFormat("es-MX", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function statusLabel(status: ControlPlaneClient["status"]): string {
  if (status === "active") return "Activo";
  if (status === "onboarding") return "Onboarding";
  if (status === "blocked") return "Bloqueado";
  return "Suspendido";
}

export default ClientsPage;
