import {
  Boxes,
  CloudCog,
  FileKey2,
  KeyRound,
  Network,
  ServerCog,
  ShieldCheck,
  TerminalSquare
} from "lucide-react";

const installCommand = `QUOTEOPS_REGISTRATION_TOKEN='<paste-token-here>' \\
  bash -c 'curl -fsSL <control-plane-url>/api/install/$QUOTEOPS_REGISTRATION_TOKEN | bash'`;

const secretsCommand = `printf '%s\\n' "$AI_PROVIDER_API_KEY" | bash deploy/appliance/secrets.sh \\
  --home /opt/quoteops-v1 \\
  set AI_PROVIDER_API_KEY --stdin`;

const composeCommand = `docker compose \\
  --env-file /opt/quoteops-v1/.env \\
  -f docker-compose.yml \\
  up -d`;

const tmsAdapterYaml = `provider: client_tms
base_url: https://tms.cliente.mx/api
auth:
  type: api_key
  api_key_env: TMS_API_KEY
endpoints:
  rfqs: /rfqs/open
  historical_quotes: /quotes/history
  writeback_quote: /quotes/{quote_id}
mapping:
  origin_city: payload.origin.city
  destination_city: payload.destination.city
  vehicle_profile_id: payload.equipment.profile`;

const setupSteps = [
  {
    icon: Boxes,
    title: "1. Client pack",
    body: "Inducta exports one pack per client: manifest, criteria template, TMS adapter template, installation id, and registration token."
  },
  {
    icon: TerminalSquare,
    title: "2. Cloud authorization",
    body: "The client runs install.sh and signs in with the authorized email. Cloud validates the allowlist and emits a signed license."
  },
  {
    icon: FileKey2,
    title: "3. Local secrets",
    body: "AI provider, embeddings, TMS, mailbox and SAKBE keys are entered into the appliance only. Cloud receives only configured or missing status."
  },
  {
    icon: Network,
    title: "4. TMS adapter",
    body: "Every TMS is normalized through a YAML adapter contract: auth, endpoints, mapping, historical pull, and quote writeback."
  },
  {
    icon: CloudCog,
    title: "5. Control plane",
    body: "Inducta receives active status, license state, last heartbeat, AI key status and aggregate quote counters only."
  }
];

export function SetupPage() {
  return (
    <section aria-labelledby="setup-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Client onboarding</p>
          <h2 id="setup-heading">Setup workspace</h2>
        </div>
        <span className="status status-green">Docker installable per client</span>
      </div>

      <div className="setup-layout">
        <article className="panel setup-main">
          <div className="panel-title">
            <ServerCog size={18} aria-hidden />
            <h3>How a new client gets installed</h3>
          </div>
          <div className="setup-steps">
            {setupSteps.map((step) => {
              const Icon = step.icon;
              return (
                <section className="setup-step" key={step.title}>
                  <Icon size={18} aria-hidden />
                  <span>
                    <strong>{step.title}</strong>
                    <small>{step.body}</small>
                  </span>
                </section>
              );
            })}
          </div>
        </article>

        <aside className="panel secret-boundary">
          <div className="panel-title">
            <ShieldCheck size={18} aria-hidden />
            <h3>What stays local</h3>
          </div>
          <ul className="boundary-list">
            <li>AI provider and embedding API keys</li>
            <li>TMS API keys and tokens</li>
            <li>SAKBE and model provider keys</li>
            <li>Raw RFQs and historical quote rows</li>
            <li>Route evidence, approvals and full workflow state</li>
          </ul>
        </aside>
      </div>

      <div className="setup-grid">
        <CommandCard title="Install appliance" command={installCommand} />
        <CommandCard title="Store an AI key locally" command={secretsCommand} />
        <CommandCard title="Run Docker" command={composeCommand} />
      </div>

      <article className="panel adapter-contract">
        <div className="panel-title">
          <KeyRound size={18} aria-hidden />
          <h3>TMS adapter contract</h3>
        </div>
        <p className="muted">
          This file is the replaceable adapter layer. A client with MercuryGate,
          Beetrack, custom SAP, or a homegrown TMS changes this YAML, not the
          quote-core code.
        </p>
        <pre>{tmsAdapterYaml}</pre>
      </article>
    </section>
  );
}

function CommandCard({ command, title }: { command: string; title: string }) {
  return (
    <article className="panel command-card">
      <div className="panel-title">
        <TerminalSquare size={18} aria-hidden />
        <h3>{title}</h3>
      </div>
      <pre>{command}</pre>
    </article>
  );
}

export default SetupPage;
