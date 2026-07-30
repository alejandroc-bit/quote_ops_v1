import crypto from "node:crypto";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import { z } from "zod";
import {
  applyMinimalHeartbeat,
  applyQuoteCounters,
  authorizeUserForClient,
  createInstallPack,
  createMinimalClientRecord,
  normalizeControlPlaneOrigin,
  parseMinimalCounters,
  parseMinimalHeartbeat,
  type InstallPack,
  type MinimalClientRecord
} from "@quoteops/control-plane";
import {
  createInstallationLicense,
  generateLicenseKeyPair,
  parsePublishedApplianceRelease,
  type PublishedApplianceRelease,
  type InstallationLicense,
  type LicenseKeyPair
} from "@quoteops/shared";
import {
  renderInstallerScript,
  validateReleaseArchive
} from "./installerScript.js";
import {
  canonicalizeInstallPack,
  createDefaultControlPlaneData,
  type ControlPlaneData,
  type RegistrationTokenRecord
} from "./data/index.js";

const isoDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date (YYYY-MM-DD)")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "must be a valid date");

const sentinelReportSchema = z
  .object({
    installation_id: z.string().trim().min(1).max(200),
    week_start: isoDateSchema,
    body_md: z.string().trim().min(1).max(250_000),
    stats: z
      .object({
        runs: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        interrupts: z.number().int().nonnegative(),
        avg_node_ms: z.number().finite().nonnegative()
      })
      .strict()
  })
  .strict();

const usageEventSchema = z
  .object({
    day: isoDateSchema,
    channel: z.string().trim().min(1).max(64),
    quotes: z.number().int().nonnegative(),
    routes: z.number().int().nonnegative()
  })
  .strict();

const versionSchema = z.string().trim().regex(/^v\d+\.\d+\.\d+$/);

const heartbeatSettingsSchema = z
  .object({
    pricing_model: z.enum(["formula", "profitability"]).optional().catch(undefined),
    pdf_template: z
      .union([
        z.string().min(1).refine((value) => value.trim().length > 0),
        z.record(z.unknown())
      ])
      .optional()
      .catch(undefined)
  })
  .strip();

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

export type AdminTokenVerifier = (token: string) => Promise<string | null>;
export type AuthenticatedSession = { user_id: string; email: string };
export type SessionTokenVerifier = (token: string) => Promise<AuthenticatedSession | null>;
export type VendorAdminEmailVerifier = (email: string) => boolean;

export type ControlPlaneApiDependencies = {
  verifyAdminToken?: AdminTokenVerifier | null;
  verifySessionToken?: SessionTokenVerifier | null;
  isVendorAdminEmail?: VendorAdminEmailVerifier | null;
  controlPlaneUrl?: string;
  keyPair?: LicenseKeyPair;
  now?: () => Date;
  data?: ControlPlaneData;
  tokenGenerator?: () => string;
  tokenTtlMinutes?: number;
};

/**
 * Verifies a Supabase Auth session token and returns only normalized identity.
 * Role/tenant decisions are deliberately separate from authentication.
 */
function createDefaultSessionTokenVerifier(): SessionTokenVerifier | null {
  const supabaseUrl = process.env.QUOTEOPS_SUPABASE_URL?.trim() || null;
  const anonKey = process.env.QUOTEOPS_SUPABASE_ANON_KEY?.trim() || null;
  if (!supabaseUrl || !anonKey) return null;

  return async (token: string): Promise<AuthenticatedSession | null> => {
    const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: anonKey, authorization: `Bearer ${token}` }
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { id?: unknown; email?: unknown };
    const userId = typeof body.id === "string" ? body.id.trim() : null;
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : null;
    return userId && email ? { user_id: userId, email } : null;
  };
}

function createDefaultVendorAdminEmailVerifier(): VendorAdminEmailVerifier | null {
  const adminEmails = new Set(
    (process.env.QUOTEOPS_ADMIN_EMAILS ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
  return adminEmails.size > 0
    ? (email: string) => adminEmails.has(email.trim().toLowerCase())
    : null;
}

function createAdminTokenVerifier(
  verifySessionToken: SessionTokenVerifier | null,
  isVendorAdminEmail: VendorAdminEmailVerifier | null
): AdminTokenVerifier | null {
  if (!verifySessionToken || !isVendorAdminEmail) return null;
  return async (token) => {
    const session = await verifySessionToken(token);
    return session && isVendorAdminEmail(session.email) ? session.email : null;
  };
}

export function createControlPlaneApi(
  dependencies: ControlPlaneApiDependencies = {}
): Express {
  const app = express();
  const data = dependencies.data ?? createDefaultControlPlaneData();
  const keyPair = dependencies.keyPair ?? loadKeyPairFromEnv() ?? generateLicenseKeyPair();
  const now = dependencies.now ?? (() => new Date());
  const tokenGenerator =
    dependencies.tokenGenerator ?? (() => crypto.randomBytes(24).toString("base64url"));
  const tokenTtlMinutes = dependencies.tokenTtlMinutes ?? 60;
  const configuredControlPlaneUrl =
    dependencies.controlPlaneUrl ??
    process.env.QUOTEOPS_CONTROL_PLANE_URL ??
    null;
  const verifySessionToken =
    dependencies.verifySessionToken !== undefined
      ? dependencies.verifySessionToken
      : createDefaultSessionTokenVerifier();
  const isVendorAdminEmail =
    dependencies.isVendorAdminEmail !== undefined
      ? dependencies.isVendorAdminEmail
      : createDefaultVendorAdminEmailVerifier();

  async function requireInstallableRelease(): Promise<PublishedApplianceRelease> {
    const published = await data.latestRelease();
    if (
      !published ||
      !/^[a-f0-9]{64}$/.test(published.bundle_sha256) ||
      sha256(published.archive_bytes) !== published.bundle_sha256
    ) {
      throw new ApiError(
        503,
        "release_unavailable",
        "no verified appliance release is available"
      );
    }
    return parsePublishedApplianceRelease({
      manifest: published.manifest,
      bundle_sha256: published.bundle_sha256
    });
  }

  async function loadRegistrationToken(
    tokenHash: string
  ): Promise<RegistrationTokenRecord | null> {
    try {
      return await data.getRegistrationToken(tokenHash);
    } catch (error) {
      const message = (error as Error).message;
      if (message === "registration_token_reissue_required") {
        throw new ApiError(
          403,
          "registration_token_reissue_required",
          "registration token must be reissued after the release-pin migration"
        );
      }
      if (
        message.startsWith("install_pack_") ||
        message.startsWith("registration_token_release_pin_")
      ) {
        throw new ApiError(
          403,
          "registration_token_invalid",
          "registration token payload failed integrity validation"
        );
      }
      throw error;
    }
  }

  app.use(cors());
  app.use(express.json({ limit: "256kb" }));

  // fail-closed admin auth: without Supabase Auth configured, admin routes
  // are unavailable instead of open
  const verifyAdminToken =
    dependencies.verifyAdminToken !== undefined
      ? dependencies.verifyAdminToken
      : createAdminTokenVerifier(verifySessionToken, isVendorAdminEmail);
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
    const clients = await data.listClients();
    res.json({
      ok: true,
      service: "quoteops-control-plane-api",
      clients: clients.length
    });
  }));

  app.post("/api/portal/profile/claim", asyncRoute(async (req, res) => {
    parseInput(() => z.object({}).strict().parse(req.body));
    if (!verifySessionToken) {
      throw new ApiError(503, "portal_auth_unavailable", "portal session auth is not configured");
    }
    const authorization = String(req.headers.authorization ?? "").trim();
    const token = /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null;
    const session = token ? await verifySessionToken(token) : null;
    if (!session) throw new ApiError(401, "unauthorized_portal", "invalid portal session");
    const profile = await data.claimPortalProfile({
      user_id: session.user_id,
      email: session.email.trim().toLowerCase(),
      vendor_admin: isVendorAdminEmail?.(session.email) ?? false
    });
    if (!profile) {
      throw new ApiError(403, "portal_profile_forbidden", "email is not authorized for a tenant");
    }
    const { email: _claimedEmail, ...publicProfile } = profile;
    res.json({ profile: publicProfile });
  }));

  app.get("/api/admin/clients", asyncRoute(async (_req, res) => {
    res.json({ items: await data.listClients() });
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
    await data.upsertClient(client);
    res.status(201).json({ client });
  }));

  app.post("/api/admin/clients/:clientId/install-pack", asyncRoute(async (req, res) => {
    const client = await requireClient(data, req.params.clientId);
    ensureClientCanReceiveLicense(client);
    const controlPlaneUrl = requireControlPlaneOrigin(configuredControlPlaneUrl);
    const release = await requireInstallableRelease();
    const registrationToken = tokenGenerator();
    const expiresAt = addMinutes(now(), tokenTtlMinutes).toISOString();
    const issuedPack = createInstallPack({
      client,
      control_plane_url: controlPlaneUrl,
      registration_token: registrationToken,
      expires_at: expiresAt,
      release
    });
    const {
      registration_token: _registrationToken,
      ...installPackSnapshot
    } = issuedPack;
    const token: RegistrationTokenRecord = {
      token: sha256(registrationToken),
      client_id: client.client_id,
      installation_id: client.installation.installation_id,
      expires_at: expiresAt,
      used_at: null,
      release_version: release.manifest.version,
      bundle_sha256: release.bundle_sha256,
      install_pack_snapshot: installPackSnapshot,
      pack_sha256: sha256(canonicalizeInstallPack(installPackSnapshot))
    };
    await data.saveRegistrationToken(token);
    res.status(201).json({
      install_pack: {
        ...token.install_pack_snapshot,
        registration_token: registrationToken
      }
    });
  }));

  app.get("/api/install", asyncRoute(async (req, res) => {
    const controlPlaneUrl = requireControlPlaneOrigin(configuredControlPlaneUrl);
    const authorization = String(req.headers.authorization ?? "").trim();
    const registrationToken =
      /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null;
    if (!registrationToken) {
      throw new ApiError(401, "unauthorized_install", "Bearer registration token required");
    }
    const token = await loadRegistrationToken(sha256(registrationToken));
    if (!token) {
      throw new ApiError(404, "not_found", "registration token not found");
    }
    if (token.used_at) {
      throw new ApiError(403, "registration_token_used", "registration token already used");
    }
    if (Date.parse(token.expires_at) <= now().getTime()) {
      throw new ApiError(403, "registration_token_expired", "registration token expired");
    }

    const pack = token.install_pack_snapshot;
    if (pack.control_plane_url !== controlPlaneUrl) {
      throw new ApiError(
        409,
        "install_pack_origin_mismatch",
        "registration token is pinned to another control-plane origin"
      );
    }
    const release = await data.getRelease(token.release_version);
    if (!release || release.bundle_sha256 !== token.bundle_sha256) {
      throw new ApiError(
        503,
        "release_unavailable",
        "pinned appliance release is unavailable"
      );
    }
    try {
      validateReleaseArchive({
        archiveBytes: Buffer.from(release.archive_bytes),
        bundleSha256: release.bundle_sha256,
        manifest: release.manifest,
        manifestBytes: release.manifest_bytes
      });
    } catch {
      throw new ApiError(
        503,
        "release_verification_failed",
        "pinned appliance release failed verification"
      );
    }
    let script: string;
    try {
      script = renderInstallerScript({
        pack,
        archiveBytes: Buffer.from(release.archive_bytes),
        bundleSha256: release.bundle_sha256,
        manifest: release.manifest
      });
    } catch {
      throw new ApiError(
        503,
        "installer_unavailable",
        "pinned installer payload is invalid"
      );
    }
    res.setHeader("content-type", "text/x-shellscript; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");
    res.send(script);
  }));

  app.post("/api/admin/clients/:clientId/suspend", asyncRoute(async (req, res) => {
    const client = await requireClient(data, req.params.clientId);
    const updated: MinimalClientRecord = {
      ...client,
      status: "suspended",
      installation: {
        ...client.installation,
        license_status: "suspended",
        onboarding_status: "blocked"
      }
    };
    await data.upsertClient(updated);
    res.json({ client: updated });
  }));

  app.post("/api/admin/clients/:clientId/reactivate", asyncRoute(async (req, res) => {
    const client = await requireClient(data, req.params.clientId);
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
    await data.upsertClient(updated);
    res.json({ client: updated });
  }));

  app.post("/api/admin/clients/:clientId/reissue-license", asyncRoute(async (req, res) => {
    const client = await requireClient(data, req.params.clientId);
    ensureClientCanReceiveLicense(client);
    const license = issueLicense(client, keyPair.private_key_pem, now().toISOString());
    const updated = markClientLicensed(client);
    await data.upsertClient(updated);
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
      ? await requireClient(data, clientId)
      : await data.findClientByAuthorizedEmail(email);

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

    const client = await requireClient(data, clientId);
    ensureClientCanReceiveLicense(client);
    if (!parseInput(() => authorizeUserForClient(client, email))) {
      res.status(403).json({ error: "unauthorized_user" });
      return;
    }
    if (client.installation.installation_id !== installationId) {
      res.status(400).json({ error: "installation_id_mismatch" });
      return;
    }

    const token = await loadRegistrationToken(sha256(registrationToken));
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
    const updated = markClientLicensed(client);
    // Retry-safe order: persist the licensed client first, then consume the
    // token that becomes the installation's long-lived credential.
    await data.upsertClient(updated);
    await data.markRegistrationTokenUsed(token.token, issuedAt);

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
    await requireInstallationToken(req, installationId);
    if (body.installation_id && body.installation_id !== installationId) {
      res.status(400).json({ error: "installation_id_mismatch" });
      return;
    }

    // `version` is consumed here for the update channel; the strict minimal
    // heartbeat parser only accepts its own allowlisted fields.
    const { version: reportedVersionInput, ...heartbeatBody } = body;
    const reportedVersion = parseInput(() => versionSchema.optional().parse(reportedVersionInput));
    const heartbeat = parseInput(() =>
      parseMinimalHeartbeat({ ...heartbeatBody, installation_id: installationId })
    );
    const client = await requireClientByInstallation(data, installationId);
    const receivedAt = now().toISOString();
    const updated = parseInput(() => applyMinimalHeartbeat(client, heartbeat, receivedAt));
    await data.touchInstallation(
      installationId,
      reportedVersion ?? null,
      receivedAt,
      updated
    );

    // Sync channel back to the appliance: newest published release + cloud settings.
    const latestVersion = (await data.latestRelease())?.version ?? null;
    const settings = heartbeatSettingsSchema.parse(
      await data.getInstallationSettings(installationId)
    );
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
    await requireInstallationToken(req, installationId);
    if (body.installation_id && body.installation_id !== installationId) {
      res.status(400).json({ error: "installation_id_mismatch" });
      return;
    }

    const counters = parseInput(() =>
      parseMinimalCounters({ ...body, installation_id: installationId })
    );
    const client = await requireClientByInstallation(data, installationId);
    const updated = parseInput(() => applyQuoteCounters(client, counters));
    await data.upsertClient(updated);
    res.status(202).json({ accepted: true, client: updated });
  }));

  // Appliance ingest endpoints: Bearer = installation registration token,
  // resolved to a tenant against the Supabase-backed tenant tables.
  async function requireTenantToken(
    req: Request
  ): Promise<{ tenant_id: string; installation_id: string }> {
    const authorization = String(req.headers.authorization ?? "").trim();
    const token = /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] ?? null;
    if (!token) {
      throw new ApiError(401, "unauthorized_installation", "invalid installation token");
    }
    let resolved;
    try {
      resolved = await data.resolveTenantByToken(sha256(token));
    } catch (error) {
      if ((error as Error).message === "registration_token_reissue_required") {
        throw new ApiError(
          403,
          "registration_token_reissue_required",
          "registration token must be reissued after the release-pin migration"
        );
      }
      throw error;
    }
    if (!resolved) {
      throw new ApiError(401, "unauthorized_installation", "invalid installation token");
    }
    return resolved;
  }

  async function requireInstallationToken(req: Request, installationId: string) {
    const resolved = await requireTenantToken(req);
    if (resolved.installation_id !== installationId) {
      throw new ApiError(403, "installation_token_mismatch", "token is bound to another installation");
    }
    return resolved;
  }

  app.post("/api/sentinel/reports", asyncRoute(async (req, res) => {
    const body = parseInput(() => sentinelReportSchema.parse(req.body));
    const { tenant_id } = await requireInstallationToken(req, body.installation_id);
    await data.insertSentinelReport({
      tenant_id,
      installation_id: body.installation_id,
      week_start: body.week_start,
      body_md: body.body_md,
      stats: body.stats
    });
    res.status(201).json({ accepted: true });
  }));

  app.post("/api/usage", asyncRoute(async (req, res) => {
    const { tenant_id } = await requireTenantToken(req);
    const body = parseInput(() => usageEventSchema.parse(req.body));
    await data.recordUsage({
      tenant_id,
      day: body.day,
      channel: body.channel,
      quotes: body.quotes,
      routes: body.routes
    });
    res.status(202).json({ accepted: true });
  }));

  app.get("/api/releases/latest", asyncRoute(async (req, res) => {
    await requireTenantToken(req);
    const release = await data.latestRelease();
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
  data: ControlPlaneData,
  clientId: string | undefined
): Promise<MinimalClientRecord> {
  if (!clientId) {
    throw new ApiError(400, "bad_request", "client_id required");
  }
  const client = await data.getClient(clientId);
  if (!client) {
    throw new ApiError(404, "not_found", "client not found");
  }
  return client;
}

async function requireClientByInstallation(
  data: ControlPlaneData,
  installationId: string
): Promise<MinimalClientRecord> {
  const client = await data.getClientByInstallation(installationId);
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

function requireControlPlaneOrigin(configuredUrl: string | null): string {
  if (!configuredUrl?.trim()) {
    throw new ApiError(
      503,
      "control_plane_origin_missing",
      "QUOTEOPS_CONTROL_PLANE_URL must be a normalized HTTPS origin"
    );
  }
  try {
    return normalizeControlPlaneOrigin(configuredUrl.trim());
  } catch {
    throw new ApiError(
      503,
      "control_plane_origin_missing",
      "QUOTEOPS_CONTROL_PLANE_URL must be a normalized HTTPS origin"
    );
  }
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
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
