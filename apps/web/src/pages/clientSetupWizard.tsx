import { FormEvent, useState } from "react";
import {
  BookOpen,
  Cloud,
  Database,
  KeyRound,
  Mail,
  MapPinned,
  PlayCircle,
  ShieldCheck
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { activateAppliance, type SetupState, type SetupStepId } from "../api/quoteOpsApi";
import { InlineError } from "../UiStates";

export type ClientSetupWizardProps = {
  setup: SetupState;
};

const setupSteps: Array<{
  id: SetupStepId;
  title: string;
  detail: string;
  icon: LucideIcon;
}> = [
  {
    id: "activate_license",
    title: "Activar licencia firmada",
    detail: "Valida la licencia de Inducta para este cliente y esta instalación.",
    icon: ShieldCheck
  },
  {
    id: "configure_secrets",
    title: "Configurar secretos",
    detail:
      "Guarda localmente las llaves del TMS, correo, SAKBE, modelo y embeddings.",
    icon: KeyRound
  },
  {
    id: "connect_cloudflare",
    title: "Publicar con Cloudflare",
    detail:
      "Conecta el túnel nombrado del cliente y confirma que Cloudflare Access protege el dominio.",
    icon: Cloud
  },
  {
    id: "connect_tms",
    title: "Conectar adaptador TMS",
    detail: "Conecta el TMS del cliente como fuente operativa de verdad.",
    icon: Database
  },
  {
    id: "map_tms",
    title: "Mapear datos del TMS",
    detail: "Genera y valida mapeos determinísticos. La IA solo interviene durante la configuración.",
    icon: Database
  },
  {
    id: "connect_knowledge_base",
    title: "Crear conocimiento local",
    detail:
      "Carga criterios comerciales al RAG local con la llave de embeddings del cliente.",
    icon: BookOpen
  },
  {
    id: "connect_mailbox",
    title: "Conectar buzón de cotizaciones",
    detail:
      "Asigna una cuenta Gmail, Outlook o IMAP para recibir solicitudes dentro del appliance.",
    icon: Mail
  },
  {
    id: "connect_sakbe",
    title: "Conectar evidencia SAKBE",
    detail: "Valida la evidencia de ruta con la llave del cliente o bloquea de forma segura.",
    icon: MapPinned
  },
  {
    id: "run_test_rfq",
    title: "Ejecutar cotización de prueba",
    detail: "Procesa una solicitud controlada y revisa la línea de tiempo local.",
    icon: PlayCircle
  }
];

export function ClientSetupWizard({ setup }: ClientSetupWizardProps) {
  const [email, setEmail] = useState("");
  const [activationMessage, setActivationMessage] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const licenseRequired = setup.required_steps.includes("activate_license");

  async function submitActivation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setActivating(true);
    setActivationMessage(null);
    try {
      const response = await activateAppliance(email);
      setActivationMessage(
        `Licencia guardada localmente para ${response.client_id} / ${response.installation_id}`
      );
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : "No se pudo activar el appliance.");
    } finally {
      setActivating(false);
    }
  }

  return (
    <section className="workspace" aria-labelledby="setup-wizard-heading">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Onboarding del appliance</p>
          <h2 id="setup-wizard-heading">Completa la configuración para operar</h2>
        </div>
        <div className="compact-stats">
          <span>{setup.activation.client_id ?? "Cliente pendiente"}</span>
          <span>{setup.activation.installation_id ?? "Instalación pendiente"}</span>
          <span>{setup.activation.status}</span>
        </div>
      </div>

      <article className="panel setup-boundary-note">
        <ShieldCheck size={20} aria-hidden />
        <div>
          <strong>Los secretos nunca salen a la nube</strong>
          <p>
            Esta es la vista del appliance. Llaves, solicitudes, filas del TMS, documentos,
            fragmentos y embeddings permanecen en la máquina del cliente.
          </p>
        </div>
      </article>

      {licenseRequired ? (
        <form className="panel activation-form" onSubmit={submitActivation}>
          <div className="panel-title">
            <ShieldCheck size={18} aria-hidden />
            <h3>Activación central</h3>
          </div>
          <label>
            Correo autorizado
            <input
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
          <button className="button button-primary" disabled={activating} type="submit">
            {activating ? "Activando…" : "Activar appliance"}
          </button>
          {activationMessage ? (
            activationMessage.toLowerCase().includes("guardada") ? <p className="inline-success">{activationMessage}</p> : <InlineError message={activationMessage} />
          ) : null}
        </form>
      ) : null}

      <div className="setup-step-grid">
        {setupSteps.map((step) => {
          const Icon = step.icon;
          const required = setup.required_steps.includes(step.id);

          return (
            <section className="onboarding-step setup-wizard-step" key={step.id}>
              <Icon size={18} aria-hidden />
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
              {step.id === "connect_cloudflare" ? (
                <small>
                  <span>{setup.tunnel?.public_hostname ?? "Hostname pendiente"}</span>
                  {" · "}
                  <span>{setup.tunnel?.status ?? "pending_manual_public_validation"}</span>
                </small>
              ) : null}
              <span className={required ? "status status-amber" : "status status-green"}>
                {required ? "Pendiente" : "Listo"}
              </span>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export default ClientSetupWizard;
