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
import { InlineError } from "../UiStates";

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
    name: "Señal",
    owner: "Conector de correo",
    detail: "Consulta el buzón operativo por IMAP y recibe solicitudes con sus archivos adjuntos."
  },
  {
    name: "Clasificación",
    owner: "Nodo de IA",
    detail: "Clasifica el mensaje como cotización, seguimiento, cancelación o ruido."
  },
  {
    name: "Normalización",
    owner: "Nodo de IA",
    detail: "Extrae origen, destino, unidad, peso, cliente y datos faltantes."
  },
  {
    name: "Análisis",
    owner: "SAKBE + TMS",
    detail: "Consulta distancia, casetas, rutas históricas, cliente y perfil operativo."
  },
  {
    name: "Recomendación",
    owner: "Guía OpenRouter",
    detail: "Explica riesgo y contexto sin modificar la tarifa de Quote-core."
  },
  {
    name: "Acción",
    owner: "Política y salida",
    detail: "Bloquea la escritura si requiere aprobación y prepara la respuesta al cliente."
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
  const [intakeError, setIntakeError] = useState<string | null>(null);

  async function simulate(channel: "Mailbox") {
    setSubmitting(channel);
    setIntakeError(null);
    const id = `${channel}-${Date.now()}`;
    setEvents((current) => [
      {
        id,
        channel,
        title: "Mensaje recibido",
        detail: "La señal ingresó al flujo y está en normalización.",
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
                title: "Cotización en cola",
                detail: `${result.run_id} quedó en ${result.status}; requiere aprobación: ${result.approval_required ? "sí" : "no"}.`,
                status: "queued"
              }
            : event
        )
      );
    } catch (caught) {
      setIntakeError(caught instanceof Error ? caught.message : String(caught));
      setEvents((current) =>
        current.map((event) =>
          event.id === id
            ? {
                ...event,
                title: "La recepción falló de forma segura",
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
          <p className="eyebrow">Entrada de solicitudes</p>
          <h2 id="inbox-heading">Bandeja operativa</h2>
        </div>
        <div className="compact-stats">
          <span>{channels.length} canal</span>
          <span>{events.length} eventos</span>
          <span>{lastRun ? `Última ${lastRun}` : "En espera"}</span>
        </div>
      </div>

      <div className="inbox-layout">
        <article className="panel channel-panel">
          <div className="panel-title">
            <Radio size={18} aria-hidden />
            <h3>Canales de entrada</h3>
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
                  {channel.status === "needs_secret" ? `Falta ${channel.secret}` : "Configurado"}
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
              {submitting ? "Procesando…" : "Simular correo de cotización"}
            </button>
          </div>
        </article>

        <article className="panel inbox-events">
          <div className="panel-title">
            <Mail size={18} aria-hidden />
            <h3>Eventos de entrada</h3>
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

      {intakeError ? <InlineError message={intakeError} /> : null}

      <article className="panel ai-flow-panel">
        <div className="panel-title">
          <Workflow size={18} aria-hidden />
          <h3>Flujo del sistema</h3>
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
          Los directores aprueban y consultan métricas de cotización. Las credenciales
          y la salud de los conectores se configuran durante el onboarding y permanecen
          en el archivo local secrets/client.env.
        </p>
        <CheckCircle2 size={18} aria-hidden />
      </aside>
    </section>
  );
}

export default InboxPage;
