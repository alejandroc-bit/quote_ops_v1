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
  tenant_id?: string;
  client_id?: string;
  version?: string | null;
  settings?: ControlPlaneInstallationSettings | null;
  last_heartbeat_at?: string | null;
};

export type ControlPlaneUsagePoint = {
  day: string;
  channel: string;
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

export type ControlPlanePortalProfile = {
  user_id: string;
  tenant_id: string | null;
  role: "owner" | "member" | "vendor_admin";
};

export type ControlPlaneCredentialStatus = {
  kind: string;
  metadata: Record<string, unknown>;
  updated_at: string | null;
};

type ItemsResponse<T> = {
  items: T[];
};

const API_BASE_URL = getControlPlaneApiBaseUrl();

export async function claimCurrentPortalProfile(): Promise<ControlPlanePortalProfile> {
  const response = await controlPlaneRequest<{ profile: ControlPlanePortalProfile }>(
    "/api/portal/profile/claim",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    }
  );
  return response.profile;
}

export async function getCurrentPortalProfile(
  userId: string
): Promise<ControlPlanePortalProfile> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("profiles")
    .select("user_id, tenant_id, role")
    .eq("user_id", userId)
    .single();
  if (error) throw new Error(`No se pudo cargar el perfil de acceso: ${error.message}`);
  return data as ControlPlanePortalProfile;
}

export async function listTenantInstallations(
  tenantId: string
): Promise<ControlPlaneInstallationDetail[]> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("installations")
    .select("installation_id, tenant_id, version, settings, last_heartbeat_at")
    .eq("tenant_id", tenantId)
    .order("installation_id", { ascending: true });
  if (error) throw new Error(`No se pudieron cargar las instalaciones: ${error.message}`);
  return (data ?? []) as ControlPlaneInstallationDetail[];
}

export async function listCredentialStatuses(
  tenantId: string
): Promise<ControlPlaneCredentialStatus[]> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("credentials")
    .select("kind, metadata, updated_at")
    .eq("tenant_id", tenantId)
    .order("kind", { ascending: true });
  if (error) throw new Error(`No se pudo cargar el estado de credenciales: ${error.message}`);
  return (data ?? []) as ControlPlaneCredentialStatus[];
}

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

export async function getLatestRelease(): Promise<ControlPlaneRelease | null> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("releases")
    .select("version, notes, published_at");
  if (error) throw new Error(`No se pudo cargar la última versión: ${error.message}`);
  return ((data ?? []) as ControlPlaneRelease[])
    .filter((release) => /^v\d+\.\d+\.\d+$/.test(release.version))
    .reduce<ControlPlaneRelease | null>(
      (maximum, release) =>
        !maximum || compareStableVersions(release.version, maximum.version) > 0
          ? release
          : maximum,
      null
    );
}

function compareStableVersions(left: string, right: string): number {
  const a = left.slice(1).split(".").map(Number);
  const b = right.slice(1).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export async function getInstallation(
  installationId: string
): Promise<ControlPlaneInstallationDetail | null> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("installations")
    .select("installation_id, tenant_id, version, settings, last_heartbeat_at")
    .eq("installation_id", installationId)
    .maybeSingle();
  if (error) throw new Error(`No se pudo cargar la instalación: ${error.message}`);
  return data as ControlPlaneInstallationDetail | null;
}

export async function updateSettings(
  installationId: string,
  settings: ControlPlaneInstallationSettings
): Promise<ControlPlaneInstallationDetail | null> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("installations")
    .update({ settings })
    .eq("installation_id", installationId)
    .select("installation_id, tenant_id, version, settings, last_heartbeat_at")
    .single();
  if (error) throw new Error(`No se pudo guardar la configuración: ${error.message}`);
  return data as ControlPlaneInstallationDetail;
}

export async function listInstallationUsage(
  installationId: string
): Promise<ControlPlaneUsagePoint[]> {
  const installation = await getInstallation(installationId);
  if (!installation?.tenant_id) return [];
  const client = requireSupabase();
  const { data, error } = await client
    .from("usage_events")
    .select("day, channel, quotes, routes")
    .eq("tenant_id", installation.tenant_id)
    .order("day", { ascending: false });
  if (error) throw new Error(`No se pudo cargar el uso: ${error.message}`);
  return (data ?? []) as ControlPlaneUsagePoint[];
}

export async function listSentinelReports(
  installationId?: string
): Promise<ControlPlaneSentinelReport[]> {
  const client = requireSupabase();
  let query = client
    .from("sentinel_reports")
    .select("installation_id, week_start, body_md, stats, created_at");
  if (installationId) query = query.eq("installation_id", installationId);
  const { data, error } = await query.order("week_start", { ascending: false });
  if (error) throw new Error(`No se pudieron cargar los reportes Sentinel: ${error.message}`);
  return (data ?? []) as ControlPlaneSentinelReport[];
}

function requireSupabase(): NonNullable<typeof supabase> {
  if (!supabase) {
    throw new Error("Supabase no está configurado para el portal de control.");
  }
  return supabase;
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
