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
      setActionMessage(`Client ${client.client_id} created and install pack generated`);
      reload();
    });
  }

  async function generatePack(client: ControlPlaneClient) {
    await runAction(`pack-${client.client_id}`, async () => {
      const pack = await generateControlPlaneInstallPack(client.client_id);
      setInstallPack(pack);
      setActionMessage(`Install pack generated for ${client.client_id}`);
    });
  }

  async function suspendClient(client: ControlPlaneClient) {
    await runAction(`suspend-${client.client_id}`, async () => {
      await suspendControlPlaneClient(client.client_id);
      setActionMessage(`${client.client_id} suspended`);
      reload();
    });
  }

  async function reactivateClient(client: ControlPlaneClient) {
    await runAction(`reactivate-${client.client_id}`, async () => {
      await reactivateControlPlaneClient(client.client_id);
      setActionMessage(`${client.client_id} reactivated`);
      reload();
    });
  }

  async function reissueLicense(client: ControlPlaneClient) {
    await runAction(`reissue-${client.client_id}`, async () => {
      await reissueControlPlaneLicense(client.client_id);
      setActionMessage(`License reissued for ${client.client_id}`);
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
          <p className="eyebrow">Inducta control plane</p>
          <h2 id="clients-heading">Authorized clients</h2>
        </div>
        <div className="compact-stats">
          <span>{stats.active} active</span>
          <span>{stats.onboarding} onboarding</span>
          <span>{stats.suspended} suspended</span>
          <span>{stats.quotes} quotes</span>
        </div>
      </div>

      {error ? (
        <div className="panel inline-error">
          <span>{error.message}</span>
          <button className="button button-secondary" onClick={reload} type="button">
            Retry
          </button>
        </div>
      ) : null}

      {actionError ? (
        <div className="panel inline-error">
          <span>{actionError}</span>
        </div>
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
            <h3>Client registry</h3>
          </div>
          <div className="registry-table-wrap">
            <table className="registry-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Authorized user</th>
                  <th>Installation</th>
                  <th>Heartbeat</th>
                  <th>Quotes</th>
                  <th>Actions</th>
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
                      <small>cloud login allowlist</small>
                    </td>
                    <td>
                      <span>{client.installation.installation_id}</span>
                      <small>
                        {client.installation.license_status} / AI key{" "}
                        {client.installation.ai_key_status}
                      </small>
                    </td>
                    <td>
                      <span>{formatHeartbeat(client.installation.last_heartbeat_at)}</span>
                      <small>{client.installation.onboarding_status}</small>
                    </td>
                    <td>
                      <div className="quote-counters" aria-label={`${client.client_id} quote counters`}>
                        <span>{client.counters.total} total</span>
                        <span>{client.counters.validated} validated</span>
                        <span>{client.counters.rejected} rejected</span>
                        <span>{client.counters.pending} pending</span>
                        <span>{client.counters.failed} failed</span>
                      </div>
                    </td>
                    <td>
                      <div className="client-actions">
                        <button
                          className="icon-button"
                          disabled={Boolean(busyAction)}
                          onClick={() => void generatePack(client)}
                          title="Generate install pack"
                          type="button"
                        >
                          <PackagePlus size={16} aria-hidden />
                          <span className="sr-only">Generate install pack {client.client_id}</span>
                        </button>
                        {client.status === "suspended" ? (
                          <button
                            className="icon-button"
                            disabled={Boolean(busyAction)}
                            onClick={() => void reactivateClient(client)}
                            title="Reactivate client"
                            type="button"
                          >
                            <PlayCircle size={16} aria-hidden />
                            <span className="sr-only">Reactivate {client.client_id}</span>
                          </button>
                        ) : (
                          <button
                            className="icon-button"
                            disabled={Boolean(busyAction)}
                            onClick={() => void suspendClient(client)}
                            title="Suspend client"
                            type="button"
                          >
                            <PauseCircle size={16} aria-hidden />
                            <span className="sr-only">Suspend {client.client_id}</span>
                          </button>
                        )}
                        <button
                          className="icon-button"
                          disabled={Boolean(busyAction)}
                          onClick={() => void reissueLicense(client)}
                          title="Reissue license"
                          type="button"
                        >
                          <RefreshCcw size={16} aria-hidden />
                          <span className="sr-only">Reissue license {client.client_id}</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && clients.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <span>No authorized clients yet</span>
                      <small>Create the first client to generate an install pack.</small>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {loading ? <p className="muted">Loading control plane registry</p> : null}
        </article>

        <form className="panel onboarding-form" onSubmit={createClient}>
          <div className="panel-title">
            <UserCheck size={18} aria-hidden />
            <h3>Create client</h3>
          </div>
          <label>
            Client id
            <input
              onChange={(event) => setForm({ ...form, client_id: event.target.value })}
              value={form.client_id}
            />
          </label>
          <label>
            Legal name
            <input
              onChange={(event) => setForm({ ...form, legal_name: event.target.value })}
              value={form.legal_name}
            />
          </label>
          <label>
            Authorized email
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
            Create client
          </button>
        </form>
      </div>

      <div className="setup-layout">
        <article className="panel install-pack-preview">
          <div className="panel-title">
            <FileKey2 size={18} aria-hidden />
            <h3>Generated install pack</h3>
          </div>
          {installPack ? (
            <>
              <div className="install-pack-meta">
                <span>{installPack.client_id}</span>
                <span>{installPack.installation_id}</span>
                <span>expires {installPack.expires_at}</span>
              </div>
              <p className="muted">
                Includes client-manifest.yaml, criteria-template.yaml and
                tms-adapter-template.yaml. Secret values are not included.
              </p>
              <pre>{installPack.install_command}</pre>
              <small className="token-note">
                Registration token: {installPack.registration_token}
              </small>
            </>
          ) : (
            <p className="muted">
              Select Generate install pack or create a client to prepare the
              first install command.
            </p>
          )}
        </article>

        <aside className="panel control-plane-note">
          <ShieldAlert size={18} aria-hidden />
          <p>
            Cloud stores only allowlisted users, license state, heartbeat time,
            AI key status and aggregate quote counters. RFQs, routes, TMS rows,
            approvals and secrets stay inside the client appliance.
          </p>
          <div className="minimal-flow">
            <span><KeyRound size={16} aria-hidden /> Login authorizes install</span>
            <span><Activity size={16} aria-hidden /> Counters sync aggregate totals</span>
          </div>
        </aside>
      </div>
    </section>
  );
}

function primaryAuthorizedUser(client: ControlPlaneClient): string {
  return client.authorized_users[0]?.email ?? "No authorized user";
}

function formatHeartbeat(value: string | null): string {
  if (!value) return "not installed";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function statusLabel(status: ControlPlaneClient["status"]): string {
  if (status === "active") return "Active";
  if (status === "onboarding") return "Onboarding";
  if (status === "blocked") return "Blocked";
  return "Suspended";
}

export default ClientsPage;
