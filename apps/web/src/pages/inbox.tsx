import { useState } from "react";
import {
  Bot,
  CheckCircle2,
  Mail,
  Radio,
  Send,
  ShieldCheck,
  Workflow
} from "lucide-react";
import { submitPlaygroundRfq } from "../api/quoteOpsApi";

type ChannelState = "connected" | "configured" | "needs_secret";

type IntakeEvent = {
  id: string;
  channel: "Mailbox";
  title: string;
  detail: string;
  status: "received" | "parsed" | "queued";
};

const channels: Array<{
  name: "Mailbox";
  status: ChannelState;
  address: string;
  secret: string;
  icon: typeof Mail;
}> = [
  {
    name: "Mailbox",
    status: "configured",
    address: "agente@tu-empresa.com",
    secret: "MAILBOX_USER",
    icon: Mail
  }
];

const aiNodes = [
  {
    name: "Channel watcher",
    owner: "Mailbox connector",
    detail: "Polls the agent mailbox (Gmail, Outlook, or any IMAP) for RFQ emails and attachments."
  },
  {
    name: "Intake agent",
    owner: "AI node",
    detail: "Classifies if the message is an RFQ, follow-up, cancellation, or noise."
  },
  {
    name: "Parser agent",
    owner: "AI node",
    detail: "Extracts origin, destination, unit, weight, customer, and missing fields."
  },
  {
    name: "Evidence agent",
    owner: "SAKBE + TMS",
    detail: "Gets distance, tolls, historical lanes, customer context, and operating profile."
  },
  {
    name: "Pricing guide",
    owner: "OpenRouter guide",
    detail: "Explains risk and context without changing quote-core rate."
  },
  {
    name: "Approval/comms agent",
    owner: "Policy + outbound",
    detail: "Blocks writeback when approval is needed and drafts the client response."
  }
];

export function InboxPage() {
  const [events, setEvents] = useState<IntakeEvent[]>([
    {
      id: "seed-mailbox",
      channel: "Mailbox",
      title: "RFQ email received",
      detail: "compras@tu-empresa.com requested Monterrey to CDMX, dry van 53.",
      status: "queued"
    }
  ]);
  const [submitting, setSubmitting] = useState<"Mailbox" | null>(null);
  const [lastRun, setLastRun] = useState<string | null>(null);

  async function simulate(channel: "Mailbox") {
    setSubmitting(channel);
    const id = `${channel}-${Date.now()}`;
    setEvents((current) => [
      {
        id,
        channel,
        title: `${channel} message received`,
        detail: "Message entered the intake agent and is being normalized.",
        status: "received"
      },
      ...current
    ]);

    try {
      const result = await submitPlaygroundRfq({
        origin_city: "Monterrey",
        origin_state: "Nuevo Leon",
        destination_city: "Ciudad de Mexico",
        destination_state: "Ciudad de Mexico",
        vehicle_profile_id: "T3S3_53_DRYVAN",
        equipment_request: "caja seca 53",
        weight_kg: 29000,
        commodity: "carga general",
        commodity_category: "general",
        sector: "industrial",
        value_mxn: 400000,
        business_unit_id: "general",
        route_policy: "cuota"
      });
      setLastRun(result.run_id);
      setEvents((current) =>
        current.map((event) =>
          event.id === id
            ? {
                ...event,
                title: `${channel} RFQ queued`,
                detail: `${result.run_id} created with status ${result.status}; approval required: ${result.approval_required ? "yes" : "no"}.`,
                status: "queued"
              }
            : event
        )
      );
    } catch (caught) {
      setEvents((current) =>
        current.map((event) =>
          event.id === id
            ? {
                ...event,
                title: `${channel} intake failed closed`,
                detail: caught instanceof Error ? caught.message : String(caught),
                status: "received"
              }
            : event
        )
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <section aria-labelledby="inbox-heading" className="workspace">
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">RFQ communication intake</p>
          <h2 id="inbox-heading">Inbox workspace</h2>
        </div>
        <div className="compact-stats">
          <span>{channels.length} channels</span>
          <span>{events.length} events</span>
          <span>{lastRun ? `last ${lastRun}` : "waiting"}</span>
        </div>
      </div>

      <div className="inbox-layout">
        <article className="panel channel-panel">
          <div className="panel-title">
            <Radio size={18} aria-hidden />
            <h3>Inbound channels</h3>
          </div>
          {channels.map((channel) => {
            const Icon = channel.icon;
            return (
              <section className="channel-row" key={channel.name}>
                <Icon size={18} aria-hidden />
                <span>
                <strong>{channel.name}</strong>
                  <small>{channel.address} / {channel.secret}</small>
                </span>
                <span className={channel.status === "needs_secret" ? "status status-amber" : "status status-green"}>
                  {channel.status === "needs_secret" ? `needs ${channel.secret}` : channel.status}
                </span>
              </section>
            );
          })}
          <div className="action-row">
            <button
              className="button button-primary"
              disabled={submitting !== null}
              onClick={() => simulate("Mailbox")}
              type="button"
            >
              <Send size={16} aria-hidden />
              Simulate mailbox RFQ
            </button>
          </div>
        </article>

        <article className="panel inbox-events">
          <div className="panel-title">
            <Mail size={18} aria-hidden />
            <h3>Live intake events</h3>
          </div>
          {events.map((event) => (
            <section className="inbox-event" key={event.id}>
              <span className={`event-dot event-${event.status}`} />
              <div>
                <strong>{event.title}</strong>
                <small>{event.channel} / {event.detail}</small>
              </div>
            </section>
          ))}
        </article>
      </div>

      <article className="panel ai-flow-panel">
        <div className="panel-title">
          <Workflow size={18} aria-hidden />
          <h3>AI node flow</h3>
        </div>
        <div className="ai-node-grid">
          {aiNodes.map((node) => (
            <section className="ai-node" key={node.name}>
              <Bot size={18} aria-hidden />
              <strong>{node.name}</strong>
              <span>{node.owner}</span>
              <small>{node.detail}</small>
            </section>
          ))}
        </div>
      </article>

      <aside className="panel control-plane-note">
        <ShieldCheck size={18} aria-hidden />
        <p>
          Directors approve and see RFQ statistics in the client portal. Channel
          credentials and connector health are configured during onboarding and
          stored locally in secrets/client.env.
        </p>
        <CheckCircle2 size={18} aria-hidden />
      </aside>
    </section>
  );
}

export default InboxPage;
