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
    title: "1. Paquete del cliente",
    body: "Inducta genera un paquete por cliente: manifiesto, criterios, adaptador TMS, instalación y token de registro."
  },
  {
    icon: TerminalSquare,
    title: "2. Autorización central",
    body: "El cliente ejecuta install.sh con el correo autorizado. La nube valida el acceso y emite una licencia firmada."
  },
  {
    icon: FileKey2,
    title: "3. Secretos locales",
    body: "Las llaves de IA, embeddings, TMS, correo y SAKBE se guardan solo en el appliance. La nube recibe únicamente su estado."
  },
  {
    icon: Network,
    title: "4. Adaptador TMS",
    body: "Cada TMS se normaliza mediante un contrato YAML: autenticación, endpoints, mapeo, histórico y escritura."
  },
  {
    icon: CloudCog,
    title: "5. Plano de control",
    body: "Inducta recibe estado, licencia, último pulso, estado de la llave de IA y conteos agregados."
  }
];

export function SetupPage() {
  return (
    <section aria-labelledby="setup-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Onboarding del cliente</p>
          <h2 id="setup-heading">Instalación del appliance</h2>
        </div>
        <span className="status status-green">Docker por cliente</span>
      </div>

      <div className="setup-layout">
        <article className="panel setup-main">
          <div className="panel-title">
            <ServerCog size={18} aria-hidden />
            <h3>Secuencia de instalación</h3>
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
            <h3>Datos que permanecen locales</h3>
          </div>
          <ul className="boundary-list">
            <li>Llaves del proveedor de IA y embeddings</li>
            <li>Llaves y tokens del TMS</li>
            <li>Llaves de SAKBE y del modelo</li>
            <li>Solicitudes y filas históricas de cotización</li>
            <li>Evidencia de ruta, aprobaciones y estado completo</li>
          </ul>
        </aside>
      </div>

      <div className="setup-grid">
        <CommandCard title="Instalar appliance" command={installCommand} />
        <CommandCard title="Guardar llave de IA" command={secretsCommand} />
        <CommandCard title="Iniciar Docker" command={composeCommand} />
      </div>

      <article className="panel adapter-contract">
        <div className="panel-title">
          <KeyRound size={18} aria-hidden />
          <h3>Contrato del adaptador TMS</h3>
        </div>
        <p className="muted">
          Este archivo es la capa reemplazable. Un cliente con MercuryGate, Beetrack,
          SAP o un TMS propio modifica este YAML, no el código de Quote-core.
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
