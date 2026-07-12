import { supabase } from "../lib/supabaseAdminClient";

export type ControlPlaneClientStatus = "active" | "onboarding" | "blocked" | "suspended";

export type ControlPlaneLicenseStatus = "active" | "pending" | "suspended" | "expired";

export type ControlPlaneAiKeyStatus = "configured" | "missing";

export type ControlPlaneQuoteCounters = {
  total: number;
  validated: number;
  rejected: number;
  pending: number;
  failed: number;
};

export type ControlPlaneClient = {
  client_id: string;
  legal_name: string;
  status: ControlPlaneClientStatus;
  created_at: string;
  authorized_users: Array<{
    email: string;
    role: string;
    created_at: string;
  }>;
  installation: {
    installation_id: string;
    client_id: string;
    license_status: ControlPlaneLicenseStatus;
    onboarding_status: string;
    last_heartbeat_at: string | null;
    ai_key_status: ControlPlaneAiKeyStatus;
  };
  counters: ControlPlaneQuoteCounters;
};

export type ControlPlaneInstallPack = {
  client_id: string;
  installation_id: string;
  registration_token: string;
  expires_at: string;
  install_command: string;
  files: Record<string, string>;
};

export type ControlPlaneRelease = {
  version: string;
  notes?: string | null;
  published_at?: string | null;
};

export type ControlPlaneInstallationSettings = {
  pricing_model?: "formula" | "profitability";
  pdf_template?: Record<string, unknown>;
  [key: string]: unknown;
};

export type ControlPlaneInstallationDetail = {
  installation_id: string;
  client_id?: string;
  version?: string | null;
  settings?: ControlPlaneInstallationSettings | null;
  last_heartbeat_at?: string | null;
};

export type ControlPlaneUsagePoint = {
  day: string;
  quotes: number;
  routes: number;
};

export type ControlPlaneSentinelReport = {
  installation_id?: string;
  week_start: string;
  body_md: string;
  stats?: {
    runs?: number;
    errors?: number;
    interrupts?: number;
    avg_node_ms?: number;
  } | null;
  created_at?: string | null;
};

type ItemsResponse<T> = {
  items: T[];
};

const API_BASE_URL = getControlPlaneApiBaseUrl();

export async function listControlPlaneClients(): Promise<ControlPlaneClient[]> {
  const response = await controlPlaneRequest<ItemsResponse<ControlPlaneClient>>(
    "/api/admin/clients"
  );
  return response.items;
}

export async function createControlPlaneClient(input: {
  client_id: string;
  legal_name: string;
  authorized_email: string;
}): Promise<ControlPlaneClient> {
  const response = await controlPlaneRequest<{ client: ControlPlaneClient }>(
    "/api/admin/clients",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    }
  );
  return response.client;
}

export async function generateControlPlaneInstallPack(
  clientId: string
): Promise<ControlPlaneInstallPack> {
  const response = await controlPlaneRequest<{ install_pack: ControlPlaneInstallPack }>(
    `/api/admin/clients/${encodeURIComponent(clientId)}/install-pack`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  return response.install_pack;
}

export async function suspendControlPlaneClient(clientId: string): Promise<ControlPlaneClient> {
  const response = await controlPlaneRequest<{ client: ControlPlaneClient }>(
    `/api/admin/clients/${encodeURIComponent(clientId)}/suspend`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  return response.client;
}

export async function reactivateControlPlaneClient(clientId: string): Promise<ControlPlaneClient> {
  const response = await controlPlaneRequest<{ client: ControlPlaneClient }>(
    `/api/admin/clients/${encodeURIComponent(clientId)}/reactivate`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  return response.client;
}

export async function reissueControlPlaneLicense(clientId: string): Promise<ControlPlaneClient> {
  const response = await controlPlaneRequest<{ client: ControlPlaneClient }>(
    `/api/admin/clients/${encodeURIComponent(clientId)}/reissue-license`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  return response.client;
}

// ponytail: the endpoints below are being added by a parallel task — every
// getter degrades to null/[] on 404 so the portal renders before the API lands.
export async function getLatestRelease(): Promise<ControlPlaneRelease | null> {
  const parsed = await controlPlaneRequestOptional<
    ControlPlaneRelease | { release: ControlPlaneRelease | null }
  >("/api/releases/latest");
  if (!parsed) return null;
  const release = "release" in parsed ? parsed.release : parsed;
  return release && typeof release.version === "string" ? release : null;
}

export async function getInstallation(
  installationId: string
): Promise<ControlPlaneInstallationDetail | null> {
  const parsed = await controlPlaneRequestOptional<
    ControlPlaneInstallationDetail | { installation: ControlPlaneInstallationDetail }
  >(`/api/admin/installations/${encodeURIComponent(installationId)}`);
  if (!parsed) return null;
  return "installation" in parsed ? parsed.installation : parsed;
}

export async function updateInstallationSettings(
  installationId: string,
  settings: ControlPlaneInstallationSettings
): Promise<ControlPlaneInstallationDetail | null> {
  const parsed = await controlPlaneRequest<
    ControlPlaneInstallationDetail | { installation: ControlPlaneInstallationDetail }
  >(`/api/admin/installations/${encodeURIComponent(installationId)}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings })
  });
  if (!parsed) return null;
  return "installation" in parsed ? parsed.installation : parsed;
}

export async function listInstallationUsage(
  installationId: string
): Promise<ControlPlaneUsagePoint[]> {
  const parsed = await controlPlaneRequestOptional<
    ItemsResponse<ControlPlaneUsagePoint> | { usage: ControlPlaneUsagePoint[] }
  >(`/api/admin/installations/${encodeURIComponent(installationId)}/usage`);
  if (!parsed) return [];
  return "usage" in parsed ? parsed.usage ?? [] : parsed.items ?? [];
}

export async function listSentinelReports(
  installationId?: string
): Promise<ControlPlaneSentinelReport[]> {
  const query = installationId
    ? `?installation_id=${encodeURIComponent(installationId)}`
    : "";
  const parsed = await controlPlaneRequestOptional<
    ItemsResponse<ControlPlaneSentinelReport> | { reports: ControlPlaneSentinelReport[] }
  >(`/api/admin/sentinel-reports${query}`);
  if (!parsed) return [];
  const reports = "reports" in parsed ? parsed.reports ?? [] : parsed.items ?? [];
  return [...reports].sort((a, b) => (a.week_start < b.week_start ? 1 : -1));
}

async function controlPlaneRequestOptional<T>(path: string): Promise<T | null> {
  try {
    return await controlPlaneRequest<T>(path);
  } catch (error) {
    if (error instanceof ControlPlaneHttpError && error.status === 404) return null;
    throw error;
  }
}

export class ControlPlaneHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ControlPlaneHttpError";
  }
}

async function controlPlaneRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const { data } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
  const accessToken = data.session?.access_token;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {})
    }
  });
  const body = await response.text();
  const parsed = body ? JSON.parse(body) : null;

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String(parsed.message)
        : parsed && typeof parsed === "object" && "error" in parsed
          ? String(parsed.error)
          : `Control Plane API request failed with HTTP ${response.status}`;
    throw new ControlPlaneHttpError(message, response.status);
  }

  return parsed as T;
}

function getControlPlaneApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    const runtimeBase = (window as unknown as {
      __QUOTEOPS_CONTROL_PLANE_API_BASE_URL__?: string;
    }).__QUOTEOPS_CONTROL_PLANE_API_BASE_URL__;
    if (runtimeBase) return runtimeBase.replace(/\/$/, "");
  }

  const envBase = import.meta.env.VITE_QUOTEOPS_CONTROL_PLANE_API_BASE_URL as
    | string
    | undefined;
  if (envBase) return envBase.replace(/\/$/, "");

  if (import.meta.env.VITE_QUOTEOPS_APP !== "control-plane") {
    return "";
  }

  if (typeof window !== "undefined") {
    return ["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? "http://127.0.0.1:19083"
      : "";
  }

  return "";
}
