import crypto from "node:crypto";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import {
  applyMinimalHeartbeat,
  applyQuoteCounters,
  authorizeUserForClient,
  createInstallPack,
  createMinimalClientRecord,
  normalizeClientId,
  normalizeEmail,
  parseMinimalCounters,
  parseMinimalHeartbeat,
  type InstallPack,
  type MinimalClientRecord
} from "@quoteops/control-plane";
import {
  createInstallationLicense,
  generateLicenseKeyPair,
  type InstallationLicense,
  type LicenseKeyPair
} from "@quoteops/shared";
import {
  loadApplianceDeployFiles,
  renderInstallerScript
} from "./installerScript.js";
import { createFileControlPlaneStore } from "./stores/fileStore.js";
import { createPostgresControlPlaneStore } from "./stores/postgresStore.js";
import { createDefaultTenantDataStore, type TenantDataStore } from "./tenantData.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string
  ) {
    super(message ?? code);
  }
}

function parseInput<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new ApiError(400, "bad_request", error instanceof Error ? error.message : String(error));
  }
}

export type RegistrationTokenRecord = {
  token: string;
  client_id: string;
  installation_id: string;
  expires_at: string;
  used_at: string | null;
};

type MaybePromise<T> = T | Promise<T>;

export type ControlPlaneStore = {
  listClients(): MaybePromise<MinimalClientRecord[]>;
  getClient(clientId: string): MaybePromise<MinimalClientRecord | null>;
  getClientByInstallation(installationId: string): MaybePromise<MinimalClientRecord | null>;
  findClientByAuthorizedEmail(email: string): MaybePromise<MinimalClientRecord | null>;
  upsertClient(client: MinimalClientRecord): MaybePromise<MinimalClientRecord>;
  saveRegistrationToken(token: RegistrationTokenRecord): MaybePromise<RegistrationTokenRecord>;
  getRegistrationToken(token: string): MaybePromise<RegistrationTokenRecord | null>;
  updateRegistrationToken(token: RegistrationTokenRecord): MaybePromise<RegistrationTokenRecord>;
};

export type AdminTokenVerifier = (token: string) => Promise<string | null>;

export type ControlPlaneApiDependencies = {
  verifyAdminToken?: AdminTokenVerifier | null;
  controlPlaneUrl?: string;
  keyPair?: LicenseKeyPair;
  now?: () => Date;
  store?: ControlPlaneStore;
  tenantData?: TenantDataStore | null;
  tokenGenerator?: () => string;
  tokenTtlMinutes?: number;
};

/**
 * Verifies a Supabase Auth session token by asking Supabase who it belongs to,
 * then checks that email against the admin allowlist. Any Supabase sign-in
 * method (magic link, OAuth, password) produces a session that validates the
 * same way here.
 */
function createDefaultAdminTokenVerifier(): AdminTokenVerifier | null {
  const supabaseUrl = process.env.QUOTEOPS_SUPABASE_URL?.trim() || null;
  const anonKey = process.env.QUOTEOPS_SUPABASE_ANON_KEY?.trim() || null;
  const adminEmails = new Set(
    (process.env.QUOTEOPS_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!supabaseUrl || !anonKey || adminEmails.size === 0) {
    return null;
  }

  return async (token: string): Promise<string | null> => {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
    return email && adminEmails.has(email) ? email : null;
  };
}

export function createInMemoryControlPlaneStore(
  seedClients: MinimalClientRecord[] = []
): ControlPlaneStore {
  const clients = new Map(seedClients.map((client) => [client.client_id, client]));
  const tokens = new Map<string, RegistrationTokenRecord>();

  return {
    listClients() {
      return [...clients.values()].sort((a, b) => a.legal_name.localeCompare(b.legal_name));
    },
    getClient(clientId) {
      return clients.get(normalizeClientId(clientId)) ?? null;
    },
    getClientByInstallation(installationId) {
      return (
        [...clients.values()].find(
          (client) => client.installation.installation_id === installationId
        ) ?? null
      );
    },
    findClientByAuthorizedEmail(email) {
      const normalizedEmail = normalizeEmail(email);
      return (
        [...clients.values()].find((client) =>
          client.authorized_users.some((user) => user.email === normalizedEmail)
        ) ?? null
      );
    },
    upsertClient(client) {
      clients.set(client.client_id, client);
      return client;
    },
    saveRegistrationToken(token) {
      tokens.set(token.token, token);
      return token;
    },
    getRegistrationToken(token) {
      return tokens.get(token) ?? null;
    },
    updateRegistrationToken(token) {
      tokens.set(token.token, token);
      return token;
    }
  };
}

export function createControlPlaneApi(
  dependencies: ControlPlaneApiDependencies = {}
): Express {
  const app = express();
  const store = dependencies.store ?? createDefaultControlPlaneStore();
  const keyPair = dependencies.keyPair ?? loadKeyPairFromEnv() ?? generateLicenseKeyPair();
  const now = dependencies.now ?? (() => new Date());
  const tokenGenerator =
    dependencies.tokenGenerator ?? (() => crypto.randomBytes(24).toString("base64url"));
  const tokenTtlMinutes = dependencies.tokenTtlMinutes ?? 60;
  const tenantData =
    dependencies.tenantData !== undefined
      ? dependencies.tenantData
      : createDefaultTenantDataStore();
  const configuredControlPlaneUrl =
    dependencies.controlPlaneUrl ??
    process.env.QUOTEOPS_CONTROL_PLANE_URL ??
    null;

  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  // fail-closed admin auth: without Supabase Auth configured, admin routes
  // are unavailable instead of open
  const verifyAdminToken =
    dependencies.verifyAdminToken !== undefined
      ? dependencies.verifyAdminToken
      : createDefaultAdminTokenVerifier();
  app.use("/api/admin", asyncMiddleware(async (req, res, next) => {
    if (!verifyAdminToken) {
      res.status(503).json({
        error: "admin_disabled",
        message: "Admin auth is not configured (QUOTEOPS_SUPABASE_URL / QUOTEOPS_SUPABASE_ANON_KEY / QUOTEOPS_ADMIN_EMAILS)"
      });
      return;
    }
    const provided = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    const email = provided ? await verifyAdminToken(provided) : null;
    if (!email) {
      res.status(401).json({ error: "unauthorized_admin" });
      return;
    }
    next();
  }));

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const clients = await store.listClients();
    res.json({
      ok: true,
      service: "quoteops-control-plane-api",
      clients: clients.length
    });
  }));

  app.get("/api/admin/clients", asyncRoute(async (_req, res) => {
    res.json({ items: await store.listClients() });
  }));

  app.post("/api/admin/clients", asyncRoute(async (req, res) => {
    const body = assertRecord(req.body);
    const createdAt = now().toISOString();
    const client = parseInput(() =>
      createMinimalClientRecord({
        client_id: requiredString(body.client_id, "client_id"),
        legal_name: requiredString(body.legal_name, "legal_name"),
        authorized_email: requiredString(body.authorized_email, "authorized_email"),
        created_at: createdAt,
        status: "onboarding"
      })
    );
    await store.upsertClient(client);
    res.status(201).json({ client });
  }));

  app.post("/api/admin/clients/:clientId/install-pack", asyncRoute(async (req, res) => {
    const client = await requireClient(store, req.params.clientId);
    ensureClientCanReceiveLicense(client);

    const token: RegistrationTokenRecord = {
      token: tokenGenerator(),
      client_id: client.client_id,
      installation_id: client.installation.installation_id,
      expires_at: addMinutes(now(), tokenTtlMinutes).toISOString(),
      used_at: null
    };
    await store.saveRegistrationToken(token);

    const pack = createInstallPack({
      client,
      control_plane_url: resolveControlPlaneUrl(req, configuredControlPlaneUrl),
      registration_token: token.token,
      expires_at: token.expires_at
    });
    res.status(201).json({ install_pack: pack });
  }));

  app.get("/api/install/:registrationToken", asyncRoute(async (req, res) => {
    const token = await store.getRegistrationToken(req.params.registrationToken ?? "");
    if (!token) {
      throw new ApiError(404, "not_found", "registration token not found");
    }
    if (token.used_at) {
      throw new ApiError(403, "registration_token_used", "registration token already used");
    }
    if (Date.parse(token.expires_at) <= now().getTime()) {
      throw new ApiError(403, "registration_token_expired", "registration token expired");
    }

    const client = await requireClient(store, token.client_id);
    ensureClientCanReceiveLicense(client);

    const deployFiles = await loadApplianceDeployFiles();
    if (!deployFiles) {
      throw new ApiError(503, "installer_unavailable", "appliance deploy files are not bundled");
    }

    const pack = createInstallPack({
      client,
      control_plane_url: resolveControlPlaneUrl(req, configuredControlPlaneUrl),
      registration_token: token.token,
      expires_at: token.expires_at
    });
    res.setHeader("content-type", "text/x-shellscript; charset=utf-8");
    res.send(renderInstallerScript({ pack, deployFiles }));
  }));

  app.post("/api/admin/clients/:clientId/suspend", asyncRoute(async (req, res) => {
    const client = await requireClient(store, req.params.clientId);
    const updated: MinimalClientRecord = {
      ...client,
      status: "suspended",
      installation: {
        ...client.installation,
        license_status: "suspended",
        onboarding_status: "blocked"
      }
    };
    await store.upsertClient(updated);
    res.json({ client: updated });
  }));

  app.post("/api/admin/clients/:clientId/reactivate", asyncRoute(async (req, res) => {
    const client = await requireClient(store, req.params.clientId);
    const updated: MinimalClientRecord = {
      ...client,
      status: "active",
      installation: {
        ...client.installation,
        license_status:
          client.installation.license_status === "active" ? "active" : "pending",
        onboarding_status:
          client.installation.onboarding_status === "blocked"
            ? "authorized"
            : client.installation.onboarding_status
      }
    };
    await store.upsertClient(updated);
    res.json({ client: updated });
  }));

  app.post("/api/admin/clients/:clientId/reissue-license", asyncRoute(async (req, res) => {
    const client = await requireClient(store, req.params.clientId);
    ensureClientCanReceiveLicense(client);
    const license = issueLicense(client, keyPair.private_key_pem, now().toISOString());
    const updated = markClientLicensed(client);
    await store.upsertClient(updated);
    res.json({
      client: updated,
      license,
      public_key_pem: keyPair.public_key_pem
    });
  }));

  app.post("/api/onboarding/login", asyncRoute(async (req, res) => {
    const body = assertRecord(req.body);
    const email = requiredString(body.email, "email");
    const clientId = optionalString(body.client_id);
    const client = clientId
      ? await requireClient(store, clientId)
      : await store.findClientByAuthorizedEmail(email);

    if (!client || !parseInput(() => authorizeUserForClient(client, email))) {
      res.status(403).json({ error: "unauthorized_user" });
      return;
    }
    ensureClientCanReceiveLicense(client);

    res.json({
      authorized: true,
      client_id: client.client_id,
      installation_id: client.installation.installation_id,
      onboarding_status: client.installation.onboarding_status
    });
  }));

  app.post("/api/onboarding/activate", asyncRoute(async (req, res) => {
    const body = assertRecord(req.body);
    const email = requiredString(body.email, "email");
    const clientId = requiredString(body.client_id, "client_id");
    const installationId = requiredString(body.installation_id, "installation_id");
    const registrationToken = requiredString(body.registration_token, "registration_token");

    const client = await requireClient(store, clientId);
    ensureClientCanReceiveLicense(client);
    if (!parseInput(() => authorizeUserForClient(client, email))) {
      res.status(403).json({ error: "unauthorized_user" });
      return;
    }
    if (client.installation.installation_id !== installationId) {
      res.status(400).json({ error: "installation_id_mismatch" });
      return;
    }

    const token = await store.getRegistrationToken(registrationToken);
    if (!token || token.client_id !== client.client_id || token.installation_id !== installationId) {
      res.status(403).json({ error: "registration_token_invalid" });
      return;
    }
    if (token.used_at) {
      res.status(403).json({ error: "registration_token_used" });
      return;
    }
    if (Date.parse(token.expires_at) <= now().getTime()) {
      res.status(403).json({ error: "registration_token_expired" });
      return;
    }

    const issuedAt = now().toISOString();
    const license = issueLicense(client, keyPair.private_key_pem, issuedAt);
    await store.updateRegistrationToken({ ...token, used_at: issuedAt });
    const updated = markClientLicensed(client);
    await store.upsertClient(updated);

    res.json({
      activated: true,
      client: updated,
      license,
      public_key_pem: keyPair.public_key_pem
    });
  }));

  app.post("/api/installations/:installationId/heartbeat", asyncRoute(async (req, res) => {
    const body = assertRecord(req.body);
    const installationId = req.params.installationId;
    if (!installationId) {
      res.status(400).json({ error: "installation_id_required" });
      return;
    }
    if (body.installation_id && body.installation_id !== installationId) {
      res.status(400).json({ error: "installation_id_mismatch" });
      return;
    }

    // `version` is consumed here for the update channel; the strict minimal
    // heartbeat parser only accepts its own allowlisted fields.
    const { version: reportedVersion, ...heartbeatBody } = body;
    const heartbeat = parseInput(() =>
      parseMinimalHeartbeat({ ...heartbeatBody, installation_id: installationId })
    );
    const client = await requireClientByInstallation(store, installationId);
    const updated = parseInput(() => applyMinimalHeartbeat(client, heartbeat, now().toISOString()));
    await store.upsertClient(updated);

    // Sync channel back to the appliance: newest published release + cloud settings.
    let latestVersion: string | null = null;
    let settings: Record<string, unknown> = {};
    if (tenantData) {
      await tenantData.touchInstallation(
        installationId,
        optionalString(reportedVersion),
        now().toISOString()
      );
      latestVersion = (await tenantData.latestRelease())?.version ?? null;
      settings = await tenantData.getInstallationSettings(installationId);
    }
    res.status(202).json({
      accepted: true,
      client: updated,
      latest_version: latestVersion,
      settings
    });
  }));

  app.post("/api/installations/:installationId/counters", asyncRoute(async (req, res) => {
    const body = assertRecord(req.body);
    const installationId = req.params.installationId;
    if (!installationId) {
      res.status(400).json({ error: "installation_id_required" });
      return;
    }
    if (body.installation_id && body.installation_id !== installationId) {
      res.status(400).json({ error: "installation_id_mismatch" });
      return;
    }

    const counters = parseInput(() =>
      parseMinimalCounters({ ...body, installation_id: installationId })
    );
    const client = await requireClientByInstallation(store, installationId);
    const updated = parseInput(() => applyQuoteCounters(client, counters));
    await store.upsertClient(updated);
    res.status(202).json({ accepted: true, client: updated });
  }));

  // Appliance ingest endpoints: Bearer = installation registration token,
  // resolved to a tenant against the Supabase-backed tenant tables.
  async function requireTenantToken(req: Request): Promise<{ tenant_id: string }> {
    if (!tenantData) {
      throw new ApiError(503, "tenant_data_unavailable", "tenant data store is not configured");
    }
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    const resolved = token ? await tenantData.resolveTenantByToken(token) : null;
    if (!resolved) {
      throw new ApiError(401, "unauthorized_installation", "invalid installation token");
    }
    return resolved;
  }

  app.post("/api/sentinel/reports", asyncRoute(async (req, res) => {
    const { tenant_id } = await requireTenantToken(req);
    const body = assertRecord(req.body);
    await tenantData!.insertSentinelReport({
      tenant_id,
      installation_id: requiredString(body.installation_id, "installation_id"),
      week_start: requiredString(body.week_start, "week_start"),
      body_md: requiredString(body.body_md, "body_md"),
      stats: body.stats && typeof body.stats === "object" ? (body.stats as Record<string, unknown>) : {}
    });
    res.status(201).json({ accepted: true });
  }));

  app.post("/api/usage", asyncRoute(async (req, res) => {
    const { tenant_id } = await requireTenantToken(req);
    const body = assertRecord(req.body);
    await tenantData!.recordUsage({
      tenant_id,
      day: requiredString(body.day, "day"),
      channel: requiredString(body.channel, "channel"),
      quotes: requiredNumber(body.quotes, "quotes"),
      routes: requiredNumber(body.routes, "routes")
    });
    res.status(202).json({ accepted: true });
  }));

  app.get("/api/releases/latest", asyncRoute(async (req, res) => {
    await requireTenantToken(req);
    const release = await tenantData!.latestRelease();
    if (!release) {
      throw new ApiError(404, "not_found", "no releases published");
    }
    res.json({ version: release.version, notes: release.notes });
  }));

  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.code, message: error.message });
      return;
    }

    // surface unexpected errors (e.g. DB connectivity) in server logs without
    // leaking details to the client
    console.error("[control-plane-api] unexpected error:", error);
    res.status(500).json({ error: "internal_error", message: "Internal server error" });
  });

  return app;
}

export function createDefaultControlPlaneStore(env: NodeJS.ProcessEnv = process.env): ControlPlaneStore {
  if (env.DATABASE_URL?.trim()) {
    return createPostgresControlPlaneStore({
      connectionString: env.DATABASE_URL.trim()
    });
  }

  if (env.QUOTEOPS_CONTROL_PLANE_STORE_PATH?.trim()) {
    return createFileControlPlaneStore(env.QUOTEOPS_CONTROL_PLANE_STORE_PATH.trim());
  }

  return createInMemoryControlPlaneStore();
}

export function issueLicense(
  client: MinimalClientRecord,
  privateKeyPem: string,
  issuedAt: string
): InstallationLicense {
  return createInstallationLicense({
    client_id: client.client_id,
    installation_id: client.installation.installation_id,
    release_channel: "stable",
    features: ["local_appliance", "aggregate_control_plane"],
    issued_at: issuedAt,
    expires_at: addDays(new Date(issuedAt), 365).toISOString(),
    private_key_pem: privateKeyPem
  });
}

function markClientLicensed(client: MinimalClientRecord): MinimalClientRecord {
  return {
    ...client,
    status: "active",
    installation: {
      ...client.installation,
      license_status: "active",
      onboarding_status: "licensed"
    }
  };
}

function ensureClientCanReceiveLicense(client: MinimalClientRecord): void {
  if (client.status === "suspended" || client.installation.license_status === "suspended") {
    throw new ApiError(403, "client_not_active", "client suspended");
  }
  if (client.status === "blocked" || client.installation.onboarding_status === "blocked") {
    throw new ApiError(403, "client_not_active", "client blocked");
  }
}

async function requireClient(
  store: ControlPlaneStore,
  clientId: string | undefined
): Promise<MinimalClientRecord> {
  if (!clientId) {
    throw new ApiError(400, "bad_request", "client_id required");
  }
  const client = await store.getClient(clientId);
  if (!client) {
    throw new ApiError(404, "not_found", "client not found");
  }
  return client;
}

async function requireClientByInstallation(
  store: ControlPlaneStore,
  installationId: string
): Promise<MinimalClientRecord> {
  const client = await store.getClientByInstallation(installationId);
  if (!client) {
    throw new ApiError(404, "not_found", "installation not found");
  }
  return client;
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "bad_request", "request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "bad_request", `${field} is required`);
  }
  return value.trim();
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ApiError(400, "bad_request", `${field} must be a number`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function loadKeyPairFromEnv(): LicenseKeyPair | null {
  const privateKey =
    process.env.QUOTEOPS_LICENSE_PRIVATE_KEY_PEM?.trim() ??
    decodeBase64Env(process.env.QUOTEOPS_LICENSE_PRIVATE_KEY_PEM_B64);
  const publicKey =
    process.env.QUOTEOPS_LICENSE_PUBLIC_KEY_PEM?.trim() ??
    process.env.QUOTEOPS_CONTROL_PLANE_PUBLIC_KEY_PEM?.trim() ??
    decodeBase64Env(process.env.QUOTEOPS_LICENSE_PUBLIC_KEY_PEM_B64) ??
    decodeBase64Env(process.env.QUOTEOPS_CONTROL_PLANE_PUBLIC_KEY_PEM_B64);

  if (!privateKey || !publicKey) {
    return null;
  }

  return {
    private_key_pem: privateKey,
    public_key_pem: publicKey
  };
}

function decodeBase64Env(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  return Buffer.from(value.trim(), "base64").toString("utf8").trim();
}

function resolveControlPlaneUrl(req: Request, configuredUrl: string | null): string {
  if (configuredUrl?.trim()) {
    return configuredUrl.trim().replace(/\/+$/, "");
  }

  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  const proto = forwardedProto || req.protocol || "https";
  const host = req.headers.host;
  if (!host) {
    return "http://localhost:19083";
  }
  return `${proto}://${host}`.replace(/\/+$/, "");
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: (error: unknown) => void) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function asyncMiddleware(
  handler: (req: Request, res: Response, next: (error?: unknown) => void) => Promise<void>
): (req: Request, res: Response, next: (error?: unknown) => void) => void {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

export type { InstallPack, MinimalClientRecord };
