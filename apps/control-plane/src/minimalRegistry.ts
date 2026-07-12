export type MinimalClientStatus = "active" | "onboarding" | "blocked" | "suspended";

export type MinimalLicenseStatus = "active" | "pending" | "suspended" | "expired";

export type MinimalOnboardingStatus =
  | "not_started"
  | "authorized"
  | "licensed"
  | "waiting_local_secrets"
  | "ready"
  | "blocked";

export type AiKeyStatus = "configured" | "missing";

export type AuthorizedUser = {
  email: string;
  role: "owner" | "operator";
  created_at: string;
};

export type QuoteCounters = {
  total: number;
  validated: number;
  rejected: number;
  pending: number;
  failed: number;
};

export type MinimalInstallation = {
  installation_id: string;
  client_id: string;
  license_status: MinimalLicenseStatus;
  onboarding_status: MinimalOnboardingStatus;
  last_heartbeat_at: string | null;
  ai_key_status: AiKeyStatus;
};

export type MinimalClientRecord = {
  client_id: string;
  legal_name: string;
  status: MinimalClientStatus;
  created_at: string;
  authorized_users: AuthorizedUser[];
  installation: MinimalInstallation;
  counters: QuoteCounters;
};

export type MinimalHeartbeatInput = {
  client_id: string;
  installation_id: string;
  onboarding_status?: MinimalOnboardingStatus;
  ai_key_status: AiKeyStatus;
};

export type MinimalCountersInput = QuoteCounters & {
  client_id: string;
  installation_id: string;
};

export const emptyQuoteCounters: QuoteCounters = {
  total: 0,
  validated: 0,
  rejected: 0,
  pending: 0,
  failed: 0
};

const forbiddenCloudFieldPatterns = [
  /api[_-]?key/i,
  /secret/i,
  /token/i,
  /raw/i,
  /rfq/i,
  /email/i,
  /document/i,
  /chunk/i,
  /embedding/i,
  /tms[_-]?row/i,
  /tms[_-]?payload/i,
  /route[_-]?evidence/i,
  /approval[_-]?envelope/i,
  /workflow/i,
  /payload/i,
  /quote[_-]?detail/i
];

const allowedHeartbeatFields = new Set([
  "client_id",
  "installation_id",
  "onboarding_status",
  "ai_key_status"
]);

const allowedCounterFields = new Set([
  "client_id",
  "installation_id",
  "total",
  "validated",
  "rejected",
  "pending",
  "failed"
]);

const onboardingStatuses = new Set<MinimalOnboardingStatus>([
  "not_started",
  "authorized",
  "licensed",
  "waiting_local_secrets",
  "ready",
  "blocked"
]);

export function createMinimalClientRecord(input: {
  client_id: string;
  legal_name: string;
  authorized_email: string;
  created_at: string;
  status?: MinimalClientStatus;
  installation_id?: string;
}): MinimalClientRecord {
  const clientId = normalizeClientId(input.client_id);
  const installationId = input.installation_id ?? `${clientId.toLowerCase()}-prod-001`;

  return {
    client_id: clientId,
    legal_name: nonEmpty(input.legal_name, "legal_name"),
    status: input.status ?? "onboarding",
    created_at: input.created_at,
    authorized_users: [
      {
        email: normalizeEmail(input.authorized_email),
        role: "owner",
        created_at: input.created_at
      }
    ],
    installation: {
      installation_id: installationId,
      client_id: clientId,
      license_status: "pending",
      onboarding_status: "not_started",
      last_heartbeat_at: null,
      ai_key_status: "missing"
    },
    counters: { ...emptyQuoteCounters }
  };
}

export function authorizeUserForClient(
  client: MinimalClientRecord,
  email: string
): boolean {
  const normalizedEmail = normalizeEmail(email);
  return client.authorized_users.some((user) => user.email === normalizedEmail);
}

export function applyMinimalHeartbeat(
  client: MinimalClientRecord,
  heartbeat: MinimalHeartbeatInput,
  receivedAt: string
): MinimalClientRecord {
  assertSameInstallation(client, heartbeat.client_id, heartbeat.installation_id);

  return {
    ...client,
    installation: {
      ...client.installation,
      ai_key_status: heartbeat.ai_key_status,
      onboarding_status:
        heartbeat.onboarding_status ?? client.installation.onboarding_status,
      last_heartbeat_at: receivedAt
    }
  };
}

export function applyQuoteCounters(
  client: MinimalClientRecord,
  counters: MinimalCountersInput
): MinimalClientRecord {
  assertSameInstallation(client, counters.client_id, counters.installation_id);

  return {
    ...client,
    counters: {
      total: normalizeCounter(counters.total, "total"),
      validated: normalizeCounter(counters.validated, "validated"),
      rejected: normalizeCounter(counters.rejected, "rejected"),
      pending: normalizeCounter(counters.pending, "pending"),
      failed: normalizeCounter(counters.failed, "failed")
    }
  };
}

export function parseMinimalHeartbeat(body: unknown): MinimalHeartbeatInput {
  const record = assertRecord(body);
  assertNoForbiddenCloudFields(record, allowedHeartbeatFields);

  const onboardingStatus =
    typeof record.onboarding_status === "string"
      ? parseOnboardingStatus(record.onboarding_status)
      : undefined;

  return {
    client_id: nonEmpty(record.client_id, "client_id"),
    installation_id: nonEmpty(record.installation_id, "installation_id"),
    ...(onboardingStatus ? { onboarding_status: onboardingStatus } : {}),
    ai_key_status: parseAiKeyStatus(record.ai_key_status)
  };
}

export function parseMinimalCounters(body: unknown): MinimalCountersInput {
  const record = assertRecord(body);
  assertNoForbiddenCloudFields(record, allowedCounterFields);

  return {
    client_id: nonEmpty(record.client_id, "client_id"),
    installation_id: nonEmpty(record.installation_id, "installation_id"),
    total: normalizeCounter(record.total, "total"),
    validated: normalizeCounter(record.validated, "validated"),
    rejected: normalizeCounter(record.rejected, "rejected"),
    pending: normalizeCounter(record.pending, "pending"),
    failed: normalizeCounter(record.failed, "failed")
  };
}

export function assertNoForbiddenCloudFields(
  value: unknown,
  allowedTopLevelFields: Set<string>
): void {
  assertNoForbiddenCloudFieldsAtPath(value, allowedTopLevelFields, []);
}

export function normalizeClientId(value: unknown): string {
  return nonEmpty(value, "client_id").replace(/[^A-Za-z0-9_-]/g, "_");
}

export function normalizeEmail(value: unknown): string {
  const email = nonEmpty(value, "email").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("invalid email");
  }
  return email;
}

export function assertSameInstallation(
  client: MinimalClientRecord,
  clientId: string,
  installationId: string
): void {
  if (client.client_id !== normalizeClientId(clientId)) {
    throw new Error("client_id mismatch");
  }
  if (client.installation.installation_id !== installationId) {
    throw new Error("installation_id mismatch");
  }
}

function assertNoForbiddenCloudFieldsAtPath(
  value: unknown,
  allowedTopLevelFields: Set<string>,
  path: string[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertNoForbiddenCloudFieldsAtPath(item, allowedTopLevelFields, [...path, String(index)])
    );
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (path.length === 0 && !allowedTopLevelFields.has(key)) {
      throw new Error(`cloud field not allowed: ${key}`);
    }

    if (forbiddenCloudFieldPatterns.some((pattern) => pattern.test(key))) {
      throw new Error(`cloud field not allowed: ${[...path, key].join(".")}`);
    }

    assertNoForbiddenCloudFieldsAtPath(child, allowedTopLevelFields, [...path, key]);
  }
}

function parseAiKeyStatus(value: unknown): AiKeyStatus {
  if (value === "configured" || value === "missing") {
    return value;
  }
  throw new Error("ai_key_status must be configured or missing");
}

function parseOnboardingStatus(value: string): MinimalOnboardingStatus {
  if (onboardingStatuses.has(value as MinimalOnboardingStatus)) {
    return value as MinimalOnboardingStatus;
  }
  throw new Error("invalid onboarding_status");
}

function normalizeCounter(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${field} must be a nonnegative integer`);
  }
  return value as number;
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request body must be an object");
  }
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}
