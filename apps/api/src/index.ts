import { access, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import {
  initialWorkflowState,
  runQuoteWorkflow,
  type QuoteWorkflowInput,
  type QuoteWorkflowState,
  type QuoteWorkflowTools,
  type QuoteAgentRuntime,
  type AgentGraphResult,
  mailboxCredentialsPresent
} from "@quoteops/agent";
import type { Rfq } from "@quoteops/contracts";
import {
  verifyInstallationLicense,
  type InstallationLicense
} from "@quoteops/shared";
import {
  loadAgentRuntimeConfig,
  createTmsAdapterFromConfig,
  loadTmsAdapterConfig,
  tmsMappingConfigSchema,
  type AgentRuntimeConfig
} from "@quoteops/connectors";
import { ingestKnowledgeDocument } from "@quoteops/knowledge";
import { applyApprovalDecision } from "./approval/applyApprovalDecision.js";
import {
  createApplianceWorkflowTools,
  loadApplianceManifest,
  resolveOverlaidManifest
} from "./runtimeTools.js";
import { loadCriteriaNodes } from "./knowledge/criteriaLoader.js";
import { getKnowledgeService } from "./knowledge/knowledgeService.js";
import type { QuoteManifest } from "@quoteops/quote-core";
import { createInMemoryQuoteOpsStore } from "./storage/InMemoryQuoteOpsStore.js";
import { createQuoteOpsStore } from "./storage/createQuoteOpsStore.js";
import {
  assertApplianceLicensed,
  applianceLockedResponse,
  type ApplianceLicenseState
} from "./activation/applianceLicense.js";
import type {
  ApplianceHeartbeat,
  ApprovalDecision,
  QuoteOpsStore,
  WorkflowRunSummary
} from "./storage/QuoteOpsStore.js";

export { createApplianceWorkflowTools, loadApplianceManifest } from "./runtimeTools.js";
export { createInMemoryQuoteOpsStore } from "./storage/InMemoryQuoteOpsStore.js";
export { createQuoteOpsStore } from "./storage/createQuoteOpsStore.js";
export { PostgresQuoteOpsStore } from "./storage/PostgresQuoteOpsStore.js";
export type {
  ApplianceHeartbeat,
  ApprovalDecision,
  QuoteOpsStore
} from "./storage/QuoteOpsStore.js";

export type QuoteOpsApiDependencies = {
  workflowRunner: (input: QuoteWorkflowInput) => Promise<QuoteWorkflowState>;
  defaultTools: QuoteWorkflowTools;
  defaultManifest: Promise<QuoteManifest | null>;
  store: QuoteOpsStore;
  graphRuntime: Pick<QuoteAgentRuntime, "resume">;
};

export type SetupStepId =
  | "activate_license"
  | "configure_secrets"
  | "connect_tms"
  | "map_tms"
  | "connect_knowledge_base"
  | "connect_mailbox"
  | "connect_sakbe"
  | "run_test_rfq";

export type LocalSetupState = {
  activation: {
    required: boolean;
    status: "locked" | "unlocked";
    client_id: string | null;
    installation_id: string | null;
  };
  required_steps: SetupStepId[];
};

const DEFAULT_AGENT_CONFIG_PATH = "/opt/quoteops-v1/connectors/agent/agent-config.yaml";

export function createQuoteOpsApi(
  dependencies: Partial<QuoteOpsApiDependencies> = {}
): Express {
  const app = express();
  const store = dependencies.store ?? createQuoteOpsStore();
  const workflowRunner = dependencies.workflowRunner ?? runQuoteWorkflow;
  const graphRuntime = dependencies.graphRuntime;
  const defaultTools = dependencies.defaultTools ?? createApplianceWorkflowTools();
  // a function, not a cached promise, so the mtime-aware loader re-reads the
  // manifest after the onboarding CLI adds a vehicle profile (no restart needed)
  const resolveManifest = (): Promise<QuoteManifest | null> =>
    dependencies.defaultManifest ?? loadApplianceManifest(process.env.QUOTEOPS_MANIFEST_PATH);

  app.use(cors());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/setup-state", asyncRoute(async (_req, res) => {
    const [manifest, workflowRuns] = await Promise.all([
      resolveManifest(),
      store.listWorkflowRuns()
    ]);
    const testRfqReady = await hasPassingTestRfq(workflowRuns, store);

    res.json(
      await buildLocalSetupState({
        env: process.env,
        manifest,
        testRfqReady
      })
    );
  }));

  app.post("/api/onboarding/activate", asyncRoute(async (req, res) => {
    const manifest = await resolveManifest();
    const email = requiredText((req.body as Record<string, unknown>).email, "email");
    const clientId = manifest?.client_id ?? optionalEnv(process.env.QUOTEOPS_CLIENT_ID) ?? null;
    const installationId = optionalEnv(process.env.QUOTEOPS_INSTALLATION_ID) ?? null;
    const controlPlaneUrl = optionalEnv(process.env.QUOTEOPS_CONTROL_PLANE_URL) ?? null;
    const registrationToken = optionalEnv(process.env.QUOTEOPS_REGISTRATION_TOKEN) ?? null;

    if (!clientId || !installationId || !controlPlaneUrl || !registrationToken) {
      res.status(400).json({
        error: "activation_not_configured",
        missing: {
          client_id: !clientId,
          installation_id: !installationId,
          control_plane_url: !controlPlaneUrl,
          registration_token: !registrationToken
        }
      });
      return;
    }

    const cloudResponse = await activateAgainstControlPlane({
      controlPlaneUrl,
      email,
      clientId,
      installationId,
      registrationToken
    });

    await persistActivatedLicense({
      env: process.env,
      license: cloudResponse.license,
      publicKeyPem: cloudResponse.public_key_pem
    });

    res.json({
      activated: true,
      client_id: clientId,
      installation_id: installationId
    });
  }));

  app.get("/api/health", asyncRoute(async (_req, res) => {
    const workflowRuns = await store.listWorkflowRuns();
    const heartbeats = await store.listHeartbeats();
    res.json({
      ok: true,
      product_version: await resolveProductVersion(),
      workflow_runs: workflowRuns.length,
      heartbeats: heartbeats.length
    });
  }));

  app.get("/api/rfqs", asyncRoute(async (_req, res) => {
    res.json({ items: await store.listWorkflowRuns() });
  }));

  app.get("/api/runs", asyncRoute(async (req, res) => {
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const parsedLimit = rawLimit === undefined ? 50 : Number(rawLimit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(200, Math.floor(parsedLimit)))
      : 50;
    res.json({ runs: await store.listRuns(limit) });
  }));

  app.get("/api/runs/:runId", asyncRoute(async (req, res) => {
    const runId = getRunIdParam(req, res);
    if (!runId) return;
    const [run, steps] = await Promise.all([store.getRun(runId), store.getSteps(runId)]);
    if (!run) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }
    res.json({ run, steps });
  }));

  app.get("/api/runs/:runId/stream", asyncRoute(async (req, res) => {
    const runId = getRunIdParam(req, res);
    if (!runId) return;
    const initialRun = await store.getRun(runId);
    if (!initialRun) {
      res.status(404).json({ error: "run_not_found" });
      return;
    }

    res.status(200);
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache, no-transform");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
    let lastSeq = 0;
    let closed = false;
    req.on("close", () => { closed = true; });
    while (!closed) {
      const [run, steps] = await Promise.all([store.getRun(runId), store.getSteps(runId)]);
      for (const step of steps.filter((candidate) => candidate.seq > lastSeq)) {
        res.write(`event: step\ndata: ${JSON.stringify(step)}\n\n`);
        lastSeq = Math.max(lastSeq, step.seq);
      }
      if (!run || run.status === "done" || run.status === "error") {
        res.write(`event: done\ndata: ${JSON.stringify({ run_id: runId, status: run?.status ?? "error" })}\n\n`);
        res.end();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!res.writableEnded) res.end();
  }));

  app.get("/api/rfqs/:runId", asyncRoute(async (req, res) => {
    const runId = getRunIdParam(req, res);
    if (!runId) return;

    const run = await store.getWorkflowRun(runId);
    if (!run) {
      res.status(404).json({ error: "workflow_run_not_found" });
      return;
    }
    res.json(run);
  }));

  app.get("/api/approvals", asyncRoute(async (_req, res) => {
    res.json({ items: await store.listApprovalEnvelopes() });
  }));

  app.post("/api/rfqs", asyncRoute(async (req, res) => {
    const requestBody = req.body as Partial<QuoteWorkflowInput>;
    const manifest = requestBody.manifest ?? (await resolveManifest());
    if (
      !(await enforceApplianceLicense({
        env: process.env,
        clientId: requestBody.client_id ?? manifest?.client_id ?? null,
        res
      }))
    ) {
      return;
    }

    const input = await withDefaultTools(requestBody, defaultTools, Promise.resolve(manifest));
    const result = await workflowRunner(input);
    await store.saveWorkflowRun(result);

    res.status(202).json({
      run_id: result.run_id,
      status: playgroundStatus(result),
      approval_required: result.approval_state?.required ?? false
    });
  }));

  app.post("/api/playground/rfqs", asyncRoute(async (req, res) => {
    const manifest = await resolveManifest();
    if (!manifest) {
      throw new Error("playground RFQ requires a loaded client manifest");
    }

    const request = parsePlaygroundRfqRequest(req.body as Record<string, unknown>);
    if (
      !(await enforceApplianceLicense({
        env: process.env,
        clientId: manifest.client_id,
        res
      }))
    ) {
      return;
    }

    const rawRfq = buildPlaygroundRfq(request, manifest);
    const runId = request.run_id ?? createPlaygroundRunId(manifest.client_id);
    const input = await withDefaultTools(
      {
        run_id: runId,
        client_id: manifest.client_id,
        manifest_version: request.manifest_version ?? "manifest-local",
        criteria_version: request.criteria_version ?? "criteria-local",
        connector_versions: {
          tms: "playground.tms-adapter@local",
          route_provider: "sakbe-live@local"
        },
        raw_rfq: rawRfq,
        manifest,
        criteria_nodes: []
      },
      defaultTools,
      Promise.resolve(manifest)
    );
    const queuedRun = initialWorkflowState(input);
    queuedRun.node_status = {
      intakePlanner: "completed",
      normalizer: "pending"
    };
    await store.saveWorkflowRun(queuedRun);
    void workflowRunner(input)
      .then((result) => store.saveWorkflowRun(result))
      .catch((error) => store.saveWorkflowRun(failedPlaygroundRun(queuedRun, error)));

    res.status(202).json({
      run_id: queuedRun.run_id,
      rfq_id: queuedRun.raw_rfq.rfq_id,
      status: "RECEIVED",
      approval_required: false,
      route_source: null,
      base_rate_mxn: null,
      recommended_rate_mxn: null
    });
  }));

  app.get("/api/workflow-state/:runId", asyncRoute(async (req, res) => {
    const runId = getRunIdParam(req, res);
    if (!runId) return;

    const run = await store.getWorkflowRun(runId);
    if (!run) {
      res.status(404).json({ error: "workflow_run_not_found" });
      return;
    }

    res.json(run);
  }));

  app.post("/api/approvals/:runId/decision", asyncRoute(async (req, res) => {
    const runId = getRunIdParam(req, res);
    if (!runId) return;

    const agentRun = await store.getRun(runId);
    if (agentRun) {
      if (agentRun.status !== "waiting_approval") {
        res.status(409).json({ error: "run_not_waiting_approval" });
        return;
      }
      const manifest = await resolveManifest();
      const clientId = manifest?.client_id ?? optionalEnv(process.env.QUOTEOPS_CLIENT_ID) ?? null;
      if (!(await enforceApplianceLicense({ env: process.env, clientId, res }))) return;
      if (!graphRuntime) {
        res.status(409).json({ error: "graph_runtime_unavailable" });
        return;
      }
      const decision = parseApprovalDecision(req.body);
      if (!(await store.claimAgentRunForResume(runId, decision))) {
        res.status(409).json({ error: "run_not_waiting_approval" });
        return;
      }
      const result: AgentGraphResult = await graphRuntime.resume(runId, {
        action: decision.action,
        ...(decision.rate_mxn !== undefined ? { rate_mxn: decision.rate_mxn } : {})
      }, { alreadyClaimed: true });
      res.json({
        run_id: runId,
        approval_decision: decision,
        response_sent: result.response_sent
      });
      return;
    }

    const run = await store.getWorkflowRun(runId);
    if (!run) {
      res.status(404).json({ error: "workflow_run_not_found" });
      return;
    }
    if (
      !(await enforceApplianceLicense({
        env: process.env,
        clientId: run.client_id,
        res
      }))
    ) {
      return;
    }

    const decision = parseApprovalDecision(req.body);
    const updatedRun = await applyApprovalDecision(run, decision, defaultTools);
    await store.saveWorkflowRun(updatedRun);
    await store.saveApprovalDecision(runId, decision);

    res.json({
      run_id: runId,
      approval_decision: decision,
      writeback_result: updatedRun.writeback_result
    });
  }));

  app.post("/api/control-plane/heartbeat", asyncRoute(async (req, res) => {
    const heartbeat = parseHeartbeat(req.body);
    await store.saveHeartbeat(heartbeat);
    res.status(202).json({ accepted: true, heartbeat });
  }));

  app.post("/api/control-plane/sync-minimal", asyncRoute(async (_req, res) => {
    const result = await runControlPlaneMinimalSync({ env: process.env, store, resolveManifest });
    if (!result.synced) {
      res.status(400).json({
        error: "control_plane_sync_not_configured",
        missing: result.missing
      });
      return;
    }
    res.status(202).json(result);
  }));

  app.post("/api/knowledge/ingest", asyncRoute(async (_req, res) => {
    const manifest = await resolveManifest();
    const clientId = manifest?.client_id ?? optionalEnv(process.env.QUOTEOPS_CLIENT_ID) ?? null;
    if (!(await enforceApplianceLicense({ env: process.env, clientId, res }))) return;

    const service = await getKnowledgeService(process.env);
    if (!service?.embed || !service.embeddingsConfig || !clientId) {
      res.status(409).json({ error: "knowledge_disabled", reason: knowledgeDisabledReason(service, clientId) });
      return;
    }

    const dir = knowledgeSourceDir(process.env);
    const files = dir ? await listKnowledgeFiles(dir) : [];
    if (files.length === 0) {
      res.status(400).json({ error: "no_knowledge_documents", knowledge_dir: dir });
      return;
    }

    const ingested: Array<{ filename: string; chunk_count: number }> = [];
    for (const filename of files) {
      const text = await readFile(join(dir!, filename), "utf8");
      const result = await ingestKnowledgeDocument({
        repo: service.repo,
        client_id: clientId,
        filename,
        content_type: knowledgeContentType(filename),
        text,
        embedding_provider: service.embeddingsConfig.provider,
        embedding_model: service.embeddingsConfig.model,
        embedding_api_key_env: service.embeddingsConfig.api_key_env,
        embed: service.embed
      });
      ingested.push({ filename, chunk_count: result.chunk_count });
    }

    res.status(202).json({ ingested, document_count: ingested.length });
  }));

  app.get("/api/knowledge/status", asyncRoute(async (_req, res) => {
    const manifest = await resolveManifest();
    const clientId = manifest?.client_id ?? optionalEnv(process.env.QUOTEOPS_CLIENT_ID) ?? null;
    if (!(await enforceApplianceLicense({ env: process.env, clientId, res }))) return;

    const service = await getKnowledgeService(process.env);
    if (!service) {
      res.json({ enabled: false, reason: "database_url_missing" });
      return;
    }
    const status = await service.repo.countStatus(clientId ?? undefined);
    res.json({
      enabled: Boolean(service.embed),
      embeddings_configured: Boolean(service.embeddingsConfig),
      ...status
    });
  }));

  app.use((error: unknown, req: Request, res: Response, _next: unknown) => {
    console.error(`[quoteops-api] ${req.method} ${req.path} failed:`, error);

    if (error instanceof ControlPlaneRequestError) {
      // cloud 4xx passes through verbatim; cloud 5xx/unreachable surface as bad gateway
      const status = error.status >= 400 && error.status < 500 ? error.status : 502;
      res.status(status).json({ error: error.code, message: error.message });
      return;
    }

    if (isBadRequestError(error)) {
      res.status(400).json({ error: "bad_request", message: error.message });
      return;
    }

    res.status(500).json({ error: "internal_error", message: "Internal server error" });
  });

  return app;
}

async function runControlPlaneMinimalSync({
  env,
  store,
  resolveManifest
}: {
  env: NodeJS.ProcessEnv;
  store: QuoteOpsStore;
  resolveManifest: () => Promise<QuoteManifest | null>;
}) {
  const [manifest, workflowRuns] = await Promise.all([
    resolveManifest(),
    store.listWorkflowRuns()
  ]);
  const clientId = manifest?.client_id ?? optionalEnv(env.QUOTEOPS_CLIENT_ID) ?? null;
  const installationId = optionalEnv(env.QUOTEOPS_INSTALLATION_ID) ?? null;
  const controlPlaneUrl = optionalEnv(env.QUOTEOPS_CONTROL_PLANE_URL) ?? null;
  const registrationToken = optionalEnv(env.QUOTEOPS_REGISTRATION_TOKEN) ?? null;
  const version = optionalEnv(env.QUOTEOPS_VERSION) ?? null;

  if (!clientId || !installationId || !controlPlaneUrl || !registrationToken || !version) {
    return {
      synced: false as const,
      missing: {
        client_id: !clientId,
        installation_id: !installationId,
        control_plane_url: !controlPlaneUrl,
        registration_token: !registrationToken,
        version: !version
      }
    };
  }

  const testRfqReady = await hasPassingTestRfq(workflowRuns, store);
  const providerReadiness = await loadProviderReadiness(env);
  const setup = await buildLocalSetupState({ env, manifest, testRfqReady, providerReadiness });
  const heartbeat = {
    client_id: clientId,
    ai_key_status: hasAiProviderKey(providerReadiness, env) ? "configured" : "missing",
    onboarding_status: minimalOnboardingStatus(setup),
    version
  };
  const counters = {
    client_id: clientId,
    ...quoteCounters(workflowRuns)
  };

  const heartbeatResponse = await postControlPlaneJson(
    controlPlaneUrl,
    `/api/installations/${encodeURIComponent(installationId)}/heartbeat`,
    heartbeat,
    registrationToken
  );
  await postControlPlaneJson(
    controlPlaneUrl,
    `/api/installations/${encodeURIComponent(installationId)}/counters`,
    counters,
    registrationToken
  );
  const syncSettings = parseHeartbeatSyncResponse(heartbeatResponse);
  await persistHeartbeatSettings(syncSettings.settings, env);

  return {
    synced: true as const,
    installation_id: installationId,
    heartbeat,
    counters,
    latest_version: syncSettings.latest_version
  };
}

const DEFAULT_CONTROL_PLANE_SYNC_INTERVAL_MS = 10 * 60 * 1000;

// Pushes the minimal heartbeat + counters on an interval so the cloud portal
// reflects the appliance without a manual curl. Runs pre-activation too (the
// heartbeat then reports onboarding progress). Sync failures only log — the
// appliance must keep quoting when the cloud is unreachable.
export function startControlPlaneSyncScheduler({
  env = process.env,
  store,
  resolveManifest
}: {
  env?: NodeJS.ProcessEnv;
  store: QuoteOpsStore;
  resolveManifest?: () => Promise<QuoteManifest | null>;
}): NodeJS.Timeout | null {
  if (
    !optionalEnv(env.QUOTEOPS_CONTROL_PLANE_URL) ||
    !optionalEnv(env.QUOTEOPS_INSTALLATION_ID) ||
    !optionalEnv(env.QUOTEOPS_REGISTRATION_TOKEN) ||
    !optionalEnv(env.QUOTEOPS_VERSION)
  ) {
    return null;
  }
  const rawInterval = env.QUOTEOPS_SYNC_INTERVAL_MS;
  const intervalMs =
    rawInterval === undefined ? DEFAULT_CONTROL_PLANE_SYNC_INTERVAL_MS : Number(rawInterval);
  // QUOTEOPS_SYNC_INTERVAL_MS=0 (or empty/garbage) disables the scheduler
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return null;
  }

  const loadManifest =
    resolveManifest ?? (() => loadApplianceManifest(env.QUOTEOPS_MANIFEST_PATH));
  const tick = async () => {
    try {
      const result = await runControlPlaneMinimalSync({ env, store, resolveManifest: loadManifest });
      if (!result.synced) {
        console.error("[quoteops-api] control plane sync skipped, missing:", result.missing);
      }
    } catch (error) {
      console.error("[quoteops-api] control plane sync failed:", error);
    }
  };

  // first sync at boot so the portal reflects the install right away
  void tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return timer;
}

async function buildLocalSetupState({
  env,
  manifest,
  testRfqReady,
  providerReadiness
}: {
  env: NodeJS.ProcessEnv;
  manifest: QuoteManifest | null;
  testRfqReady: boolean;
  providerReadiness?: ProviderReadiness;
}): Promise<LocalSetupState> {
  const resolvedProviderReadiness = providerReadiness ?? (await loadProviderReadiness(env));
  const clientId = manifest?.client_id ?? optionalEnv(env.QUOTEOPS_CLIENT_ID) ?? null;
  const installationId = optionalEnv(env.QUOTEOPS_INSTALLATION_ID) ?? null;
  const activationRequired = true;
  const activationStatus = await deriveActivationStatus({ env, clientId, installationId });
  const requiredSteps: SetupStepId[] = [];

  if (activationStatus !== "unlocked") {
    requiredSteps.push("activate_license");
  }
  if (!(await hasConfiguredSecrets(resolvedProviderReadiness, env))) {
    requiredSteps.push("configure_secrets");
  }
  if (!(await hasTmsConnection(resolvedProviderReadiness, env))) {
    requiredSteps.push("connect_tms");
  }
  if (!(await hasTmsMapping(env))) {
    requiredSteps.push("map_tms");
  }
  if (!(await hasKnowledgeBase(env))) {
    requiredSteps.push("connect_knowledge_base");
  }
  if (!hasAgentMailbox(resolvedProviderReadiness, env)) {
    requiredSteps.push("connect_mailbox");
  }
  if (!hasSakbeRouteEvidence(resolvedProviderReadiness, env)) {
    requiredSteps.push("connect_sakbe");
  }
  if (!testRfqReady) {
    requiredSteps.push("run_test_rfq");
  }

  return {
    activation: {
      required: activationRequired,
      status: activationStatus,
      client_id: clientId,
      installation_id: installationId
    },
    required_steps: [...new Set(requiredSteps)]
  };
}

type CloudActivationResponse = {
  activated: boolean;
  license: InstallationLicense;
  public_key_pem: string;
};

// carries the control plane's status + error code so the middleware can
// propagate them instead of flattening every cloud rejection into a 500
class ControlPlaneRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail?: string
  ) {
    super(detail ?? code);
  }
}

const REGISTRATION_TOKEN_USED_HINT =
  'El registration token ya fue usado. Genera un install pack nuevo en el portal ("Generate install pack") para obtener otro token; "Reissue license" no re-habilita ni emite tokens.';

async function activateAgainstControlPlane(input: {
  controlPlaneUrl: string;
  email: string;
  clientId: string;
  installationId: string;
  registrationToken: string;
}): Promise<CloudActivationResponse> {
  const response = await fetch(`${input.controlPlaneUrl.replace(/\/+$/, "")}/api/onboarding/activate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: input.email,
      client_id: input.clientId,
      installation_id: input.installationId,
      registration_token: input.registrationToken
    })
  }).catch((error: unknown) => {
    throw new ControlPlaneRequestError(502, "control_plane_unreachable", (error as Error).message);
  });
  const body = (await response.json().catch(() => ({}))) as Partial<CloudActivationResponse> & {
    error?: string;
    message?: string;
  };

  if (!response.ok) {
    const code = body.error ?? "control_plane_activation_failed";
    throw new ControlPlaneRequestError(
      response.status,
      code,
      code === "registration_token_used" ? REGISTRATION_TOKEN_USED_HINT : body.message
    );
  }
  if (!body.activated || !body.license || !body.public_key_pem) {
    throw new Error("control_plane_activation_response_invalid");
  }

  return {
    activated: true,
    license: body.license,
    public_key_pem: body.public_key_pem
  };
}

async function postControlPlaneJson(
  controlPlaneUrl: string,
  path: string,
  body: Record<string, unknown>,
  registrationToken: string
): Promise<unknown> {
  const response = await fetch(`${controlPlaneUrl.replace(/\/+$/, "")}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${registrationToken}`
    },
    body: JSON.stringify(body)
  });
  if (response.ok) return response.json().catch(() => null);

  const responseText = await response.text();
  throw new ControlPlaneRequestError(
    response.status,
    "control_plane_sync_failed",
    responseText || response.statusText
  );
}

type HeartbeatSyncSettings = {
  pricing_model?: "formula" | "profitability";
  pdf_template?: string | Record<string, unknown>;
};

function parseHeartbeatSyncResponse(value: unknown): {
  latest_version: string | null;
  settings: HeartbeatSyncSettings;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("control_plane_heartbeat_response_invalid");
  }
  const body = value as Record<string, unknown>;
  const latestVersion =
    body.latest_version === null || typeof body.latest_version === "string"
      ? body.latest_version
      : null;
  const rawSettings =
    body.settings && typeof body.settings === "object" && !Array.isArray(body.settings)
      ? body.settings as Record<string, unknown>
      : {};
  const settings: HeartbeatSyncSettings = {};
  if (rawSettings.pricing_model === "formula" || rawSettings.pricing_model === "profitability") {
    settings.pricing_model = rawSettings.pricing_model;
  }
  if (
    typeof rawSettings.pdf_template === "string" && rawSettings.pdf_template.trim() ||
    rawSettings.pdf_template &&
      typeof rawSettings.pdf_template === "object" &&
      !Array.isArray(rawSettings.pdf_template)
  ) {
    settings.pdf_template = rawSettings.pdf_template as string | Record<string, unknown>;
  }
  return { latest_version: latestVersion, settings };
}

async function persistHeartbeatSettings(
  settings: HeartbeatSyncSettings,
  env: NodeJS.ProcessEnv
): Promise<void> {
  const settingsPath = optionalEnv(env.QUOTEOPS_SETTINGS_PATH);
  if (settingsPath) await writeJsonAtomic(settingsPath, settings);

  const pdfTemplatePath = optionalEnv(env.QUOTEOPS_PDF_TEMPLATE_PATH);
  if (!pdfTemplatePath) return;
  if (
    settings.pdf_template &&
    typeof settings.pdf_template === "object" &&
    !Array.isArray(settings.pdf_template)
  ) {
    await writeJsonAtomic(pdfTemplatePath, settings.pdf_template);
    return;
  }
  await unlink(pdfTemplatePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

function quoteCounters(workflowRuns: WorkflowRunSummary[]): {
  total: number;
  validated: number;
  rejected: number;
  pending: number;
  failed: number;
} {
  return workflowRuns.reduce(
    (counters, run) => {
      counters.total += 1;
      if (run.status === "APPROVED") counters.validated += 1;
      else if (run.status === "REJECTED") counters.rejected += 1;
      else if (run.status === "REVIEW_REQUIRED" || run.approval_required) counters.pending += 1;
      else if (run.status.includes("FAILED") || run.status === "UNKNOWN") counters.failed += 1;
      else counters.pending += 1;
      return counters;
    },
    {
      total: 0,
      validated: 0,
      rejected: 0,
      pending: 0,
      failed: 0
    }
  );
}

function minimalOnboardingStatus(setup: LocalSetupState):
  | "not_started"
  | "authorized"
  | "licensed"
  | "waiting_local_secrets"
  | "ready"
  | "blocked" {
  if (setup.activation.status !== "unlocked") {
    return optionalEnv(process.env.QUOTEOPS_REGISTRATION_TOKEN) ? "authorized" : "not_started";
  }
  if (setup.required_steps.includes("configure_secrets")) {
    return "waiting_local_secrets";
  }
  if (setup.required_steps.length === 0) {
    return "ready";
  }
  return "licensed";
}

function hasAiProviderKey(readiness: ProviderReadiness, env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    readiness.agentConfig &&
      hasConfiguredModelKey(readiness.agentConfig, readiness, env)
  );
}

async function persistActivatedLicense({
  env,
  license,
  publicKeyPem
}: {
  env: NodeJS.ProcessEnv;
  license: InstallationLicense;
  publicKeyPem: string;
}): Promise<void> {
  const licenseJson = JSON.stringify(license, null, 2);
  env.QUOTEOPS_LICENSE_JSON = licenseJson;
  env.QUOTEOPS_LICENSE_PUBLIC_KEY_PEM = publicKeyPem;

  const home = optionalEnv(env.QUOTEOPS_HOME);
  const licensePath =
    optionalEnv(env.QUOTEOPS_LICENSE_PATH) ??
    optionalEnv(env.QUOTEOPS_SIGNED_LICENSE_PATH) ??
    (home ? join(home, "license.json") : null);
  const publicKeyPath =
    optionalEnv(env.QUOTEOPS_LICENSE_PUBLIC_KEY_PATH) ??
    optionalEnv(env.QUOTEOPS_SIGNED_LICENSE_PUBLIC_KEY_PATH) ??
    (home ? join(home, "license-public-key.pem") : null);

  if (licensePath) {
    await mkdir(dirname(licensePath), { recursive: true });
    await writeFile(licensePath, licenseJson, { mode: 0o600 });
    env.QUOTEOPS_LICENSE_PATH = licensePath;
  }
  if (publicKeyPath) {
    await mkdir(dirname(publicKeyPath), { recursive: true });
    await writeFile(publicKeyPath, publicKeyPem, { mode: 0o600 });
    env.QUOTEOPS_LICENSE_PUBLIC_KEY_PATH = publicKeyPath;
  }
}

async function deriveActivationStatus({
  env,
  clientId,
  installationId
}: {
  env: NodeJS.ProcessEnv;
  clientId: string | null;
  installationId: string | null;
}): Promise<"locked" | "unlocked"> {
  const state = await buildApplianceLicenseState({ env, clientId, installationId });
  return state.status === "valid" ? "unlocked" : "locked";
}

async function enforceApplianceLicense({
  env,
  clientId,
  res
}: {
  env: NodeJS.ProcessEnv;
  clientId: string | null;
  res: Response;
}): Promise<boolean> {
  const state = await buildApplianceLicenseState({
    env,
    clientId,
    installationId: optionalEnv(env.QUOTEOPS_INSTALLATION_ID) ?? null
  });
  if (!state.required || state.status === "valid") {
    return true;
  }

  const locked = applianceLockedResponse(state);
  res.status(locked.status).json(locked.body);
  return false;
}

async function buildApplianceLicenseState({
  env,
  clientId,
  installationId
}: {
  env: NodeJS.ProcessEnv;
  clientId: string | null;
  installationId: string | null;
}): Promise<ApplianceLicenseState> {
  const required = true;

  if (!clientId) {
    return {
      required,
      status: "missing",
      client_id: null,
      installation_id: installationId,
      reason: "client_id_missing"
    };
  }

  if (!installationId) {
    return {
      required,
      status: "missing",
      client_id: clientId,
      installation_id: null,
      reason: "installation_id_missing"
    };
  }

  const [license, publicKeyPem] = await Promise.all([
    loadSignedLicense(env),
    loadLicensePublicKey(env)
  ]);
  if (!license) {
    return {
      required,
      status: "missing",
      client_id: clientId,
      installation_id: installationId,
      reason: "license_file_missing"
    };
  }
  if (!publicKeyPem) {
    return {
      required,
      status: "missing",
      client_id: clientId,
      installation_id: installationId,
      reason: "license_public_key_missing"
    };
  }

  try {
    verifyInstallationLicense(license, {
      public_key_pem: publicKeyPem,
      now: new Date().toISOString(),
      expected_client_id: clientId,
      expected_installation_id: installationId
    });
    return {
      required,
      status: "valid",
      client_id: clientId,
      installation_id: installationId,
      reason: null
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      required,
      status: message.includes("expired") ? "expired" : "invalid",
      client_id: clientId,
      installation_id: installationId,
      reason: message.includes("expired") ? "license_expired" : "license_invalid"
    };
  }
}

export async function assertApplianceLicenseForClient({
  env,
  clientId
}: {
  env: NodeJS.ProcessEnv;
  clientId: string | null;
}): Promise<void> {
  const state = await buildApplianceLicenseState({
    env,
    clientId,
    installationId: optionalEnv(env.QUOTEOPS_INSTALLATION_ID) ?? null
  });
  assertApplianceLicensed(state);
}

type ProviderReadiness = {
  agentConfig: AgentRuntimeConfig | null;
  secretFileKeys: Set<string>;
};

async function loadProviderReadiness(env: NodeJS.ProcessEnv): Promise<ProviderReadiness> {
  const agentConfigPath = optionalEnv(env.QUOTEOPS_AGENT_CONFIG_PATH) ?? DEFAULT_AGENT_CONFIG_PATH;
  const [agentConfig, secretFileKeys] = await Promise.all([
    loadAgentRuntimeConfig(agentConfigPath).catch(() => null),
    readSecretKeysFromEnvFile(optionalEnv(env.QUOTEOPS_SECRETS_ENV_FILE) ?? "")
  ]);
  return { agentConfig, secretFileKeys };
}

async function hasConfiguredSecrets(
  readiness: ProviderReadiness,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const config = readiness.agentConfig;
  if (!config) return false;

  return (
    hasSakbeRouteEvidence(readiness, env) &&
    hasConfiguredModelKey(config, readiness, env) &&
    hasConfiguredEmbeddingsKey(config, readiness, env) &&
    (await hasTmsConnection(readiness, env))
  );
}

function hasConfiguredModelKey(
  config: AgentRuntimeConfig,
  readiness: ProviderReadiness,
  env: NodeJS.ProcessEnv
): boolean {
  if (config.model.provider === "deterministic" || config.model.provider === "claude_cli") {
    return true;
  }
  return Boolean(
    config.model.api_key_env && hasConfiguredKey(config.model.api_key_env, readiness, env)
  );
}

function hasConfiguredEmbeddingsKey(
  config: AgentRuntimeConfig,
  readiness: ProviderReadiness,
  env: NodeJS.ProcessEnv
): boolean {
  return !config.embeddings || hasConfiguredKey(config.embeddings.api_key_env, readiness, env);
}

async function hasTmsConnection(
  readiness: ProviderReadiness,
  env: NodeJS.ProcessEnv
): Promise<boolean> {
  const adapterPath = optionalEnv(env.QUOTEOPS_TMS_ADAPTER_CONFIG_PATH);
  if (!adapterPath) return false;

  try {
    const config = await loadTmsAdapterConfig(adapterPath);
    if (config.provider === "file_import") {
      const configuredPathEnvKeys = [
        config.rfqs_path_env,
        config.historical_quotes_path_env,
        config.historical_shipments_path_env,
        config.customers_path_env,
        config.agreements_path_env,
        config.unit_positions_path_env,
        config.units_path_env,
        config.performance_path_env,
        config.availability_zones_path_env,
        config.quote_writebacks_path_env,
        config.status_writebacks_path_env
      ].filter((key): key is string => Boolean(key));

      // A file-import adapter cannot be considered connected merely because
      // its env-var names exist. Build the production adapter and check each
      // configured input/writeback path, keeping the legacy empty adapter
      // configuration valid for packs that stage their CSVs later.
      if (!configuredPathEnvKeys.every((key) => Boolean(optionalEnv(env[key])))) {
        return false;
      }
      return (await (await createTmsAdapterFromConfig(adapterPath, { env })).healthCheck()).ok;
    }
    if (config.provider === "sql") {
      return hasConfiguredKey(config.connection_url_env, readiness, env);
    }

    const requiredKeys = new Set<string>([config.base_url_env]);
    for (const value of Object.values(config.headers ?? {})) {
      for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        const key = match[1];
        if (key) requiredKeys.add(key);
      }
    }
    return [...requiredKeys].every((key) => hasConfiguredKey(key, readiness, env));
  } catch {
    return false;
  }
}

function hasConfiguredKey(
  key: string,
  readiness: ProviderReadiness,
  env: NodeJS.ProcessEnv
): boolean {
  return Boolean(optionalEnv(env[key]) || readiness.secretFileKeys.has(key));
}

async function hasTmsMapping(env: NodeJS.ProcessEnv): Promise<boolean> {
  const mappingPath = optionalEnv(env.QUOTEOPS_TMS_MAPPING_CONFIG_PATH);
  if (mappingPath) {
    try {
      tmsMappingConfigSchema.parse(JSON.parse(await readFile(mappingPath, "utf8")));
      return true;
    } catch {
      return false;
    }
  }

  const adapterPath = optionalEnv(env.QUOTEOPS_TMS_ADAPTER_CONFIG_PATH);
  if (adapterPath) {
    try {
      const config = await loadTmsAdapterConfig(adapterPath);
      // file_import maps deterministically through the CSV templates;
      // http providers need an explicit mapping config from onboarding
      return config.provider === "file_import";
    } catch {
      return false;
    }
  }

  const rfqsPath = optionalEnv(env.QUOTEOPS_TMS_RFQS_PATH);
  if (rfqsPath) {
    return fileExists(rfqsPath);
  }
  return false;
}

async function hasKnowledgeBase(env: NodeJS.ProcessEnv): Promise<boolean> {
  // ready if the vector store already has chunks, OR source files are staged
  // for ingestion (the transition window before the first ingest runs)
  try {
    const service = await getKnowledgeService(env);
    if (service && (await service.repo.countStatus()).knowledge_chunks_count > 0) return true;
  } catch {
    // fall through to the file-staging check
  }
  const connectorsDir = optionalEnv(env.QUOTEOPS_CONNECTORS_DIR);
  const knowledgeDir =
    optionalEnv(env.QUOTEOPS_KNOWLEDGE_DIR) ??
    (connectorsDir ? join(connectorsDir, "knowledge") : null);
  if (!knowledgeDir) return false;
  try {
    const entries = await readdir(knowledgeDir);
    return entries.some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

function knowledgeSourceDir(env: NodeJS.ProcessEnv): string | null {
  const connectorsDir = optionalEnv(env.QUOTEOPS_CONNECTORS_DIR);
  return (
    optionalEnv(env.QUOTEOPS_KNOWLEDGE_DIR) ??
    (connectorsDir ? join(connectorsDir, "knowledge") : null)
  );
}

async function listKnowledgeFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((entry) => !entry.startsWith("."));
  } catch {
    return [];
  }
}

function knowledgeContentType(filename: string): string {
  if (filename.endsWith(".md")) return "text/markdown";
  if (filename.endsWith(".json")) return "application/json";
  return "text/plain";
}

function knowledgeDisabledReason(
  service: Awaited<ReturnType<typeof getKnowledgeService>>,
  clientId: string | null
): string {
  if (!service) return "database_url_missing";
  if (!clientId) return "client_id_missing";
  if (!service.embeddingsConfig) return "embeddings_block_missing";
  return "embedding_api_key_missing";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hasAgentMailbox(readiness: ProviderReadiness, env: NodeJS.ProcessEnv): boolean {
  if (!readiness.agentConfig?.mailbox) return false;
  return mailboxCredentialsPresent(
    readiness.agentConfig.mailbox,
    envWithSecretFilePresence(readiness, env)
  );
}

function envWithSecretFilePresence(
  readiness: ProviderReadiness,
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const effectiveEnv = { ...env };
  for (const key of readiness.secretFileKeys) {
    if (!optionalEnv(effectiveEnv[key])) effectiveEnv[key] = "configured";
  }
  return effectiveEnv;
}

function hasSakbeRouteEvidence(readiness: ProviderReadiness, env: NodeJS.ProcessEnv): boolean {
  return (
    hasConfiguredKey("INEGI_SAKBE_KEY", readiness, env) ||
    hasConfiguredKey("QUOTEOPS_SAKBE_API_KEY", readiness, env)
  );
}

async function hasPassingTestRfq(
  workflowRuns: WorkflowRunSummary[],
  store: QuoteOpsStore
): Promise<boolean> {
  const approvedRuns = workflowRuns.filter(
    (run) => run.status === "APPROVED" && !run.approval_required && run.route_source
  );
  for (const run of approvedRuns) {
    const detail = await store.getWorkflowRun(run.run_id);
    if (!detail) continue;
    const routeResolved = detail.route_evidence?.status === "resolved" || Boolean(run.route_source);
    const writebackReady =
      detail.writeback_result?.status === "written" ||
      detail.writeback_result?.status === "skipped" ||
      detail.node_status.writeback === "completed";

    if (routeResolved && writebackReady) {
      return true;
    }
  }

  return false;
}

async function readSecretKeysFromEnvFile(path: string): Promise<Set<string>> {
  try {
    const contents = await readFile(path, "utf8");
    const keys = new Set<string>();
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = /^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed) ??
        /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed);
      if (!match) continue;
      const key = match[1];
      const value = match[2];
      if (key && optionalEnv(normalizeEnvFileValue(value ?? ""))) {
        keys.add(key);
      }
    }
    return keys;
  } catch {
    return new Set();
  }
}

function normalizeEnvFileValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function loadSignedLicense(env: NodeJS.ProcessEnv): Promise<InstallationLicense | null> {
  const inline = optionalEnv(env.QUOTEOPS_LICENSE_JSON);
  const raw = inline ?? (await readFirstConfiguredFile(env, [
    "QUOTEOPS_LICENSE_PATH",
    "QUOTEOPS_SIGNED_LICENSE_PATH",
    "QUOTEOPS_LICENSE_FILE"
  ]));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as InstallationLicense;
    return parsed?.payload && parsed.signature ? parsed : null;
  } catch {
    return null;
  }
}

async function loadLicensePublicKey(env: NodeJS.ProcessEnv): Promise<string | null> {
  return (
    optionalEnv(env.QUOTEOPS_LICENSE_PUBLIC_KEY_PEM) ??
    optionalEnv(env.QUOTEOPS_SIGNED_LICENSE_PUBLIC_KEY_PEM) ??
    optionalEnv(env.QUOTEOPS_CONTROL_PLANE_PUBLIC_KEY_PEM) ??
    optionalEnv(env.QUOTEOPS_LICENSE_PUBLIC_KEY) ??
    (await readFirstConfiguredFile(env, [
      "QUOTEOPS_LICENSE_PUBLIC_KEY_PATH",
      "QUOTEOPS_SIGNED_LICENSE_PUBLIC_KEY_PATH",
      "QUOTEOPS_CONTROL_PLANE_PUBLIC_KEY_PATH"
    ])) ??
    null
  );
}

async function readFirstConfiguredFile(
  env: NodeJS.ProcessEnv,
  keys: string[]
): Promise<string | null> {
  for (const key of keys) {
    const path = optionalEnv(env[key]);
    if (!path) continue;
    try {
      return await readFile(path, "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

function optionalEnv(value: string | undefined): string | undefined {
  return value && value.trim() ? value.trim() : undefined;
}

// Health reports the release the installer stamps into QUOTEOPS_VERSION;
// dev checkouts fall back to the package.json version.
async function resolveProductVersion(): Promise<string> {
  const fromEnv = optionalEnv(process.env.QUOTEOPS_VERSION);
  if (fromEnv) return fromEnv;
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  return `v${(JSON.parse(raw) as { version: string }).version}`;
}

function parseEnvBoolean(value: string | undefined, fallback: boolean): boolean {
  const parsed = optionalEnv(value);
  if (!parsed) return fallback;
  return ["1", "true", "yes", "on", "unlocked", "ready", "valid"].includes(parsed.toLowerCase());
}

function getRunIdParam(req: Request, res: Response): string | null {
  const runId = req.params.runId;
  if (!runId) {
    res.status(400).json({ error: "run_id_required" });
    return null;
  }
  return runId;
}

function playgroundStatus(result: QuoteWorkflowState): string {
  return result.approval_state?.required
    ? "REVIEW_REQUIRED"
    : result.base_quote?.status ?? "UNKNOWN";
}

function failedPlaygroundRun(
  queuedRun: QuoteWorkflowState,
  _error: unknown
): QuoteWorkflowState {
  return {
    ...queuedRun,
    approval_state: {
      required: true,
      reasons: ["workflow_failed"]
    },
    runtime_review_reasons: [...queuedRun.runtime_review_reasons, "workflow_failed"],
    node_status: {
      ...queuedRun.node_status,
      audit: "failed"
    }
  };
}

async function withDefaultTools(
  input: Partial<QuoteWorkflowInput>,
  defaultTools: QuoteWorkflowTools,
  defaultManifest: Promise<QuoteManifest | null>
): Promise<QuoteWorkflowInput> {
  const rawManifest = input.manifest ?? (await defaultManifest);
  if (!input.run_id || !input.client_id || !input.raw_rfq || !rawManifest) {
    throw new Error("run_id, client_id, raw_rfq and manifest are required");
  }

  const tools = isWorkflowTools(input.tools) ? input.tools : defaultTools;
  const { manifest, reviewReasons } = await resolveOverlaidManifest(rawManifest, tools);

  return {
    run_id: input.run_id,
    client_id: input.client_id,
    manifest_version: input.manifest_version ?? "manifest-local",
    criteria_version: input.criteria_version ?? "criteria-local",
    connector_versions: input.connector_versions ?? {},
    raw_rfq: input.raw_rfq,
    manifest,
    criteria_nodes: input.criteria_nodes ?? (await loadCriteriaNodes(process.env.QUOTEOPS_CRITERIA_DIR)),
    tools,
    ...(reviewReasons.length > 0 ? { seed_review_reasons: reviewReasons } : {})
  };
}

function parseApprovalDecision(body: Record<string, unknown>): ApprovalDecision {
  const action = body.action;
  if (!["approve", "adjust", "reject", "request_review"].includes(String(action))) {
    throw new Error("invalid approval action");
  }
  const parsedAction = action as ApprovalDecision["action"];
  const hasRate = Object.prototype.hasOwnProperty.call(body, "rate_mxn");
  if (parsedAction === "adjust" && !isPositiveFiniteNumber(body.rate_mxn)) {
    throw new Error("adjust approval requires positive rate_mxn");
  }
  if (parsedAction !== "adjust" && hasRate) {
    throw new Error("rate_mxn is only allowed for adjust approval");
  }

  return {
    action: parsedAction,
    ...(parsedAction === "adjust" ? { rate_mxn: body.rate_mxn as number } : {}),
    ...(typeof body.reason === "string" ? { reason: body.reason } : {}),
    email_sent: false,
    decided_at: new Date().toISOString()
  };
}

type PlaygroundRfqRequest = {
  run_id?: string;
  manifest_version?: string;
  criteria_version?: string;
  origin_city: string;
  origin_state: string;
  destination_city: string;
  destination_state: string;
  vehicle_profile_id?: string;
  equipment_request?: string;
  weight_kg: number | null;
  commodity?: string;
  commodity_category?: string;
  sector?: string;
  value_mxn?: number | null;
  requester_name?: string;
  requester_email?: string;
  company_alias?: string;
  customer_id?: string;
  customer_type?: string;
  business_unit_id?: string;
  route_policy?: string;
};

function parsePlaygroundRfqRequest(body: Record<string, unknown>): PlaygroundRfqRequest {
  return {
    run_id: optionalText(body.run_id),
    manifest_version: optionalText(body.manifest_version),
    criteria_version: optionalText(body.criteria_version),
    origin_city: requiredText(body.origin_city, "origin_city"),
    origin_state: requiredText(body.origin_state, "origin_state"),
    destination_city: requiredText(body.destination_city, "destination_city"),
    destination_state: requiredText(body.destination_state, "destination_state"),
    vehicle_profile_id: optionalText(body.vehicle_profile_id),
    equipment_request: optionalText(body.equipment_request),
    weight_kg: optionalNumberOrNull(body.weight_kg),
    commodity: optionalText(body.commodity),
    commodity_category: optionalText(body.commodity_category),
    sector: optionalText(body.sector),
    value_mxn: optionalNumberOrNull(body.value_mxn),
    requester_name: optionalText(body.requester_name),
    requester_email: optionalText(body.requester_email),
    company_alias: optionalText(body.company_alias),
    customer_id: optionalText(body.customer_id),
    customer_type: optionalText(body.customer_type),
    business_unit_id: optionalText(body.business_unit_id),
    route_policy: optionalText(body.route_policy)
  };
}

function buildPlaygroundRfq(request: PlaygroundRfqRequest, manifest: QuoteManifest): Rfq {
  const profile =
    manifest.vehicle_profiles.find(
      (candidate) => candidate.vehicle_profile_id === request.vehicle_profile_id
    ) ?? manifest.vehicle_profiles[0];
  if (!profile) {
    throw new Error("playground RFQ requires at least one vehicle profile in manifest");
  }

  const businessUnit =
    manifest.business_units.find(
      (unit) => unit.business_unit_id === (request.business_unit_id ?? profile.business_unit_id)
    ) ??
    manifest.business_units.find((unit) => unit.default) ??
    manifest.business_units[0];
  if (!businessUnit) {
    throw new Error("playground RFQ requires at least one business unit in manifest");
  }

  const now = new Date().toISOString();
  const rfqId = createPlaygroundRfqId(now);
  const missingFields = request.weight_kg === null ? ["weight_kg"] : [];
  const requesterDomain =
    businessUnit.requester_email_domains?.[0] ?? `${manifest.client_id.toLowerCase()}.local`;

  return {
    rfq_id: rfqId,
    source: "manual",
    received_at: now,
    requester: {
      name: request.requester_name ?? "Playground RFQ",
      email: request.requester_email ?? `playground@${requesterDomain}`,
      company_alias: request.company_alias ?? manifest.client_id
    },
    raw: {
      subject: `Playground RFQ ${request.origin_city} to ${request.destination_city}`,
      body: `Solicitar ${request.equipment_request ?? profile.vehicle_profile_id} de ${request.origin_city}, ${request.origin_state} a ${request.destination_city}, ${request.destination_state}.`,
      attachments: []
    },
    parsed: {
      lanes: [
        {
          lane_id: `${rfqId}-L01`,
          origin: { city: request.origin_city, state: request.origin_state, country: "MX" },
          destination: {
            city: request.destination_city,
            state: request.destination_state,
            country: "MX"
          },
          equipment_request: request.equipment_request ?? "caja seca 53",
          vehicle_profile_id: profile.vehicle_profile_id,
          cargo: {
            commodity: request.commodity ?? "carga general",
            commodity_category: request.commodity_category ?? "general",
            sector: request.sector ?? "industrial",
            weight_kg: request.weight_kg,
            value_mxn: request.value_mxn ?? 400000,
            hazmat: false,
            temperature_controlled: false
          },
          service: {
            return_policy: "sin_retorno",
            route_policy: request.route_policy ?? "cuota",
            requested_pickup_at: null
          },
          commercial: {
            target_rate_mxn: null,
            customer_id: request.customer_id ?? `${manifest.client_id}-PLAYGROUND`,
            customer_type: request.customer_type ?? "industrial",
            business_unit_id: businessUnit.business_unit_id
          },
          confidence: {
            overall: missingFields.length > 0 ? 0.72 : 0.92,
            missing_fields: missingFields,
            review_reasons: missingFields.map((field) => `${field}_missing`)
          }
        }
      ]
    }
  };
}

function createPlaygroundRunId(clientId: string): string {
  return `RUN-${clientId}-${Date.now().toString(36).toUpperCase()}`;
}

function createPlaygroundRfqId(isoDate: string): string {
  const year = isoDate.slice(0, 4);
  const sequence = String(Date.now() % 1_000_000).padStart(6, "0");
  return `RFQ-${year}-${sequence}`;
}

function requiredText(value: unknown, field: string): string {
  const parsed = optionalText(value);
  if (!parsed) {
    throw new Error(`playground RFQ ${field} is required`);
  }
  return parsed;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw new Error("playground RFQ numeric fields must be numbers or null");
}

function parseHeartbeat(body: Record<string, unknown>): ApplianceHeartbeat {
  if (!body.client_id || !body.installation_id || !body.version) {
    throw new Error("client_id, installation_id and version are required");
  }

  return {
    client_id: String(body.client_id),
    installation_id: String(body.installation_id),
    version: String(body.version),
    connector_health: recordOrEmpty(body.connector_health),
    queue_depth: numberOrZero(body.queue_depth),
    pending_approvals: numberOrZero(body.pending_approvals),
    last_successful_rfq_at:
      typeof body.last_successful_rfq_at === "string" ? body.last_successful_rfq_at : null,
    last_backup_at: typeof body.last_backup_at === "string" ? body.last_backup_at : null,
    disk_usage: recordOrEmpty(body.disk_usage),
    error_counts: Object.fromEntries(
      Object.entries(recordOrEmpty(body.error_counts)).map(([key, value]) => [
        key,
        numberOrZero(value)
      ])
    ),
    received_at: new Date().toISOString()
  };
}

function isWorkflowTools(value: unknown): value is QuoteWorkflowTools {
  const candidate = value as Partial<QuoteWorkflowTools> | null | undefined;
  return Boolean(
    candidate &&
      typeof candidate.resolveRoute === "function" &&
      typeof candidate.searchHistorical === "function" &&
      typeof candidate.recommend === "function" &&
      typeof candidate.writeback === "function"
  );
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isBadRequestError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return [
    "run_id, client_id, raw_rfq and manifest are required",
    "invalid approval action",
    "adjust approval requires positive rate_mxn",
    "rate_mxn is only allowed for adjust approval",
    "client_id, installation_id and version are required",
    "playground RFQ requires a loaded client manifest",
    "playground RFQ requires at least one vehicle profile in manifest",
    "playground RFQ requires at least one business unit in manifest",
    "playground RFQ numeric fields must be numbers or null"
  ].includes(error.message) || error.message.startsWith("playground RFQ ");
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (error: unknown) => void) => {
    handler(req, res).catch(next);
  };
}
