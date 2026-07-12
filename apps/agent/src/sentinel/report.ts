import { redact, type SentinelStats } from "./collect.js";

/**
 * Minimal chat surface of the shared LLM factory product (ChatOpenAI from
 * apps/agent/src/llm/chatModel.ts). Kept structural so tests can script it.
 */
export interface SentinelChatModel {
  invoke(messages: Array<[role: string, content: string]>): Promise<{ content: unknown }>;
}

const SYSTEM_PROMPT = [
  "Eres el centinela de una instalacion del producto de cotizacion.",
  "Escribe un reporte semanal en espanol, en markdown, de UNA pagina maxima,",
  "SOLO sobre la salud del proceso: como fue la semana, posibles bugs,",
  "y mejoras o actualizaciones sugeridas para el proveedor del producto.",
  "PROHIBIDO incluir rutas, origenes, destinos, clientes, correos, montos o tarifas.",
  "Si un dato de entrada contiene esa informacion, ignorala."
].join(" ");

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

export async function buildSentinelReport(args: {
  stats: SentinelStats;
  llm: SentinelChatModel;
  installationId: string;
  weekStart: string;
}): Promise<string> {
  const { stats, llm, installationId, weekStart } = args;
  const human = [
    `Instalacion: ${installationId}`,
    `Semana que inicia: ${weekStart}`,
    `Corridas: ${stats.runs}`,
    `Errores: ${stats.errors}`,
    `Resumenes de error (ya redactados): ${stats.error_summaries.join(" | ") || "ninguno"}`,
    `Interrupciones (revision humana): ${stats.interrupts} (tasa ${(stats.interrupt_rate * 100).toFixed(1)}%)`,
    `Duracion promedio por nodo (ms): ${JSON.stringify(stats.avg_node_ms)}`,
    `Pasos con deriva de esquema: ${stats.drift_steps}`
  ].join("\n");

  const result = await llm.invoke([
    ["system", SYSTEM_PROMPT],
    ["human", human]
  ]);
  const raw = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  const safe = redact(raw);
  if (EMAIL_RE.test(safe)) {
    throw new Error("Sentinel report still contains an email address after redaction");
  }
  return safe;
}
