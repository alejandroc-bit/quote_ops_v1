export type DataClassification =
  | "LOCAL_ONLY"
  | "CLOUD_SAFE"
  | "SECRET_REF_ONLY"
  | "FORBIDDEN_CLOUD";

const cloudSafeKeys = new Set([
  "client_id",
  "installation_id",
  "version",
  "appliance_url",
  "release_channel",
  "license_status",
  "activation_status",
  "tunnel",
  "mode",
  "state",
  "last_successful_sync_at",
  "connector_health",
  "tms",
  "sakbe",
  "knowledge_base",
  "mapping_health",
  "schema_hash",
  "drift_status",
  "knowledge_health",
  "knowledge_documents_count",
  "knowledge_chunks_count",
  "retriever_health",
  "last_ingested_at",
  "relay_last_seen_at",
  "workflow_progress",
  "status",
  "current_node",
  "review_required",
  "approval_envelope",
  "envelope_id",
  "run_id",
  "rfq_id",
  "lane",
  "origin",
  "destination",
  "equipment",
  "weight_kg",
  "base_rate_mxn",
  "recommended_rate_mxn",
  "review_reasons",
  "evidence_flags",
  "route_source",
  "route_resolved",
  "historical_layer",
  "quote_core_status",
  "decision_status",
  "created_at",
  "updated_at",
  "received_at"
]);

const secretRefKeys = new Set([
  "TMS_API_KEY",
  "TMS_BASIC_AUTH_TOKEN",
  "TMS_SQL_URL",
  "MAILBOX_PASSWORD",
  "MAILBOX_OAUTH_CLIENT_SECRET",
  "MAILBOX_OAUTH_REFRESH_TOKEN",
  "WHATSAPP_TOKEN",
  "SAKBE_API_KEY",
  "INEGI_SAKBE_KEY",
  "QUOTEOPS_MODEL_API_KEY",
  "OPENROUTER_API_KEY",
  "QUOTEOPS_EMBEDDING_API_KEY"
]);

const forbiddenExactKeys = new Set([
  "raw",
  "raw_rfq",
  "raw_email",
  "raw_whatsapp",
  "raw_tms_sample",
  "payload",
  "email_body",
  "attachments",
  "document_text",
  "chunk_text",
  "embedding",
  "embeddings",
  "embedding_vector",
  "historical_context",
  "criteria_nodes",
  "knowledge_documents",
  "knowledge_chunks",
  "workflow_state",
  "full_workflow_state",
  "secret",
  "password"
]);

const forbiddenFragments = [
  "api_key",
  "api_key_value",
  "secret_value",
  "access_token",
  "refresh_token"
];

export function classifyDataKey(key: string): DataClassification {
  if (secretRefKeys.has(key)) return "SECRET_REF_ONLY";

  const normalized = normalizeDataKey(key);
  if (
    forbiddenExactKeys.has(normalized) ||
    forbiddenFragments.some((fragment) => normalized.includes(fragment))
  ) {
    return "FORBIDDEN_CLOUD";
  }
  if (cloudSafeKeys.has(normalized)) return "CLOUD_SAFE";
  return "LOCAL_ONLY";
}

export function assertCloudSafePayload<T>(payload: T): T {
  assertCloudSafeValue(payload);
  return payload;
}

export function assertSecretRef(value: string): string {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(value)) {
    throw new Error("secret reference must be an env var ref");
  }
  return value;
}

function assertCloudSafeValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assertCloudSafeValue(item);
    }
    return;
  }

  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const classification = classifyDataKey(key);
    if (classification === "FORBIDDEN_CLOUD") {
      throw new Error(`forbidden cloud key: ${key}`);
    }
    if (classification === "LOCAL_ONLY") {
      throw new Error(`non cloud-safe key: ${key}`);
    }
    if (classification === "SECRET_REF_ONLY") {
      if (typeof child !== "string") {
        throw new Error("secret reference must be an env var ref");
      }
      assertSecretRef(child);
      continue;
    }
    assertCloudSafeValue(child);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
}
