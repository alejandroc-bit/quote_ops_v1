import { FormEvent, useState } from "react";
import {
  BookOpen,
  Database,
  KeyRound,
  Mail,
  MapPinned,
  PlayCircle,
  ShieldCheck
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { activateAppliance, type SetupState, type SetupStepId } from "../api/quoteOpsApi";

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
    title: "Activate signed license",
    detail: "Validate the Inducta-signed license scoped to this client and installation.",
    icon: ShieldCheck
  },
  {
    id: "configure_secrets",
    title: "Configure secrets",
    detail:
      "Store TMS, mailbox, SAKBE, model, and embedding keys locally. Secret values never go to the cloud.",
    icon: KeyRound
  },
  {
    id: "connect_tms",
    title: "Connect TMS adapter",
    detail: "Connect the customer TMS as the operational source of truth.",
    icon: Database
  },
  {
    id: "map_tms",
    title: "Map TMS data",
    detail: "Generate and validate deterministic canonical mappings. AI is allowed only during setup.",
    icon: Database
  },
  {
    id: "connect_knowledge_base",
    title: "Build local knowledge base",
    detail:
      "Upload commercial criteria and ingest them into local RAG using the client's embedding key.",
    icon: BookOpen
  },
  {
    id: "connect_mailbox",
    title: "Connect agent RFQ mailbox",
    detail:
      "Assign a mail account (Gmail, Outlook, or any IMAP server) to the agent for RFQ intake, configured locally in the appliance.",
    icon: Mail
  },
  {
    id: "connect_sakbe",
    title: "Connect SAKBE route evidence",
    detail: "Validate live route evidence with the client's key or fail closed.",
    icon: MapPinned
  },
  {
    id: "run_test_rfq",
    title: "Run test RFQ",
    detail: "Run a controlled RFQ and inspect the local workflow timeline.",
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
        `License stored locally for ${response.client_id} / ${response.installation_id}`
      );
    } catch (error) {
      setActivationMessage(error instanceof Error ? error.message : "Activation failed");
    } finally {
      setActivating(false);
    }
  }

  return (
    <section className="workspace" aria-labelledby="setup-wizard-heading">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">Local appliance onboarding</p>
          <h2 id="setup-wizard-heading">Finish setup before processing RFQs</h2>
        </div>
        <div className="compact-stats">
          <span>{setup.activation.client_id ?? "client pending"}</span>
          <span>{setup.activation.installation_id ?? "installation pending"}</span>
          <span>{setup.activation.status}</span>
        </div>
      </div>

      <article className="panel setup-boundary-note">
        <ShieldCheck size={20} aria-hidden />
        <div>
          <strong>Secret values never go to the cloud</strong>
          <p>
            This portal is the local appliance view. Keys, raw RFQs, TMS rows, documents,
            chunks, and embeddings stay on the client machine.
          </p>
        </div>
      </article>

      {licenseRequired ? (
        <form className="panel activation-form" onSubmit={submitActivation}>
          <div className="panel-title">
            <ShieldCheck size={18} aria-hidden />
            <h3>Cloud activation</h3>
          </div>
          <label>
            Authorized email
            <input
              onChange={(event) => setEmail(event.target.value)}
              type="email"
              value={email}
            />
          </label>
          <button className="button button-primary" disabled={activating} type="submit">
            {activating ? "Activating" : "Activate appliance"}
          </button>
          {activationMessage ? <p className="muted">{activationMessage}</p> : null}
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
              <span className={required ? "status status-amber" : "status status-green"}>
                {required ? "required" : "ready"}
              </span>
            </section>
          );
        })}
      </div>
    </section>
  );
}

export default ClientSetupWizard;
