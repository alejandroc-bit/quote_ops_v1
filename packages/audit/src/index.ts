import { createHash, randomUUID } from "node:crypto";

export const AUDIT_VERSION = "audit-v2.0.0";

export type AuditEventInput = {
  run_id: string;
  node_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at?: string;
};

export type AuditEvent = AuditEventInput & {
  audit_version: typeof AUDIT_VERSION;
  event_id: string;
  occurred_at: string;
  payload_hash: string;
};

export function createAuditEvent(input: AuditEventInput): AuditEvent {
  const occurredAt = input.occurred_at || new Date().toISOString();
  return {
    ...input,
    audit_version: AUDIT_VERSION,
    event_id: `evt_${randomUUID()}`,
    occurred_at: occurredAt,
    payload_hash: hashPayload(input.payload)
  };
}

export function appendAuditEvent(timeline: AuditEvent[], event: AuditEvent): AuditEvent[] {
  return [...timeline, event];
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
