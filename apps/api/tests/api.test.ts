import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex, Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import tar from "tar-stream";
import {
  createApplianceWorkflowTools,
  createInMemoryQuoteOpsStore,
  createQuoteOpsApi,
  startControlPlaneSyncScheduler,
  type QuoteOpsApiDependencies
} from "../src/index";
import { createControlPlaneApi } from "../../control-plane-api/src/index";
import {
  createInMemoryControlPlaneData,
  type ControlPlaneData,
  type ReleaseRecord
} from "../../control-plane-api/src/data/index";
import { quoteLane } from "../../agent/src/graph/nodes/quote";
import { loadPdfTemplate } from "../../agent/src/pdf/quotePdf";
import type { QuoteWorkflowInput } from "@quoteops/agent";
import { createInstallationLicense, generateLicenseKeyPair } from "@quoteops/shared";

const TEST_ADMIN_TOKEN = "test-admin-token";
type TestExpressApp =
  | ReturnType<typeof createQuoteOpsApi>
  | ReturnType<typeof createControlPlaneApi>;
const nativeFetch = globalThis.fetch;
const testApps = new Map<string, TestExpressApp>();
const applianceOrigins = new Set<string>();
const cloudOrigins = new Set<string>();
let nextTestAppId = 0;
let fetchRouterInstalled = false;
const tempDirs: string[] = [];
const testEnvRestores: Array<() => void> = [];
const originalInstallationId = process.env.QUOTEOPS_INSTALLATION_ID;

afterEach(async () => {
  clearTestApps();
  restoreNativeFetch();
  while (testEnvRestores.length > 0) {
    testEnvRestores.pop()?.();
  }
  if (originalInstallationId === undefined) {
    delete process.env.QUOTEOPS_INSTALLATION_ID;
  } else {
    process.env.QUOTEOPS_INSTALLATION_ID = originalInstallationId;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  readyEnvDir = null;
});

describe("QuoteOps API", () => {
  it("builds appliance tools when no TMS adapter config path is provided", async () => {
    const tools = createApplianceWorkflowTools({
      env: {
        QUOTEOPS_AGENT_CONFIG_PATH: "/tmp/quoteops-missing-agent-config.yaml",
        QUOTEOPS_SAKBE_CACHE_MODE: "cache_first"
      }
    });

    expect(typeof tools.searchHistorical).toBe("function");
    expect(typeof tools.writeback).toBe("function");
  });

  it("submits an RFQ workflow and exposes workflow state", async () => {
    const baseUrl = await startApi();

    const submit = await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workflowInput)
    });
    const submitted = await submit.json();
    const state = await fetch(`${baseUrl}/api/workflow-state/${workflowInput.run_id}`);
    const snapshot = await state.json();
    const detail = await fetch(`${baseUrl}/api/rfqs/${workflowInput.run_id}`);
    const detailSnapshot = await detail.json();

    expect(submit.status).toBe(202);
    expect(submitted).toMatchObject({
      run_id: workflowInput.run_id,
      status: "APPROVED"
    });
    expect(detail.status).toBe(200);
    expect(detailSnapshot.run_id).toBe(workflowInput.run_id);
    expect(detailSnapshot.base_quote.status).toBe("APPROVED");
    expect(snapshot.base_quote.status).toBe("APPROVED");
    expect(snapshot.node_status.audit).toBe("completed");
  });

  it("submits a simplified Playground RFQ using the loaded client manifest", async () => {
    const baseUrl = await startApi({
      defaultManifest: Promise.resolve(workflowInput.manifest)
    });

    const submit = await fetch(`${baseUrl}/api/playground/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        origin_city: "Monterrey",
        origin_state: "Nuevo Leon",
        destination_city: "Saltillo",
        destination_state: "Coahuila",
        equipment_request: "caja seca 53",
        vehicle_profile_id: "T3S2_53_DRYVAN",
        weight_kg: 12000,
        value_mxn: 250000,
        business_unit_id: "general"
      })
    });
    const submitted = await submit.json();
    const detailSnapshot = await waitForWorkflow(baseUrl, submitted.run_id);
    const detail = await fetch(`${baseUrl}/api/rfqs/${submitted.run_id}`);
    const rfqs = await fetch(`${baseUrl}/api/rfqs`);
    const rfqBody = await rfqs.json();

    expect(submit.status).toBe(202);
    expect(submitted).toMatchObject({
      status: "RECEIVED",
      approval_required: false
    });
    expect(detail.status).toBe(200);
    expect(detailSnapshot.base_quote.status).toBe("APPROVED");
    expect(detailSnapshot.raw_rfq.source).toBe("manual");
    expect(detailSnapshot.raw_rfq.parsed.lanes[0].origin.city).toBe("Monterrey");
    expect(rfqBody.items).toContainEqual(
      expect.objectContaining({
        run_id: submitted.run_id,
        client_id: "cliente-demo",
        approval_required: false
      })
    );
  });

  it("lists submitted RFQs and exposes a minimal approval envelope", async () => {
    process.env.QUOTEOPS_INSTALLATION_ID = "cliente-demo-prod-001";
    const baseUrl = await startApi({
      defaultTools: reviewRouteTools()
    });

    const submit = await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reviewWorkflowInput("RUN-API-REVIEW-001"))
    });
    expect(submit.status).toBe(202);

    const rfqs = await fetch(`${baseUrl}/api/rfqs`);
    expect(rfqs.status).toBe(200);
    const rfqBody = await rfqs.json();
    const approvals = await fetch(`${baseUrl}/api/approvals`);
    expect(approvals.status).toBe(200);
    const approvalBody = await approvals.json();

    expect(rfqBody.items).toContainEqual(
      expect.objectContaining({
        run_id: "RUN-API-REVIEW-001",
        client_id: "cliente-demo",
        status: "REVIEW_REQUIRED",
        approval_required: true
      })
    );
    const approvalEnvelope = approvalBody.items.find(
      (item: { run_id?: string }) => item.run_id === "RUN-API-REVIEW-001"
    );
    expect(approvalEnvelope).toEqual(
      expect.objectContaining({
        run_id: "RUN-API-REVIEW-001",
        client_id: "cliente-demo",
        installation_id: "cliente-demo-prod-001",
        lane: {
          origin: "Monterrey, Nuevo Leon",
          destination: "Saltillo, Coahuila"
        },
        equipment: "T3S2_53_DRYVAN",
        weight_kg: null,
        decision_status: "pending"
      })
    );
    expect(approvalEnvelope).not.toHaveProperty("requester");
    expect(approvalEnvelope).not.toHaveProperty("raw_rfq");
    expect(approvalEnvelope).not.toHaveProperty("raw");
    expect(approvalEnvelope).not.toHaveProperty("tools");
    expect(JSON.stringify(approvalBody)).not.toContain("compras@cliente.com");
    expect(JSON.stringify(approvalBody)).not.toContain("raw");
    expect(JSON.stringify(approvalBody)).not.toContain("tools");
  });

  it("blocks RFQ processing without a local installation id", async () => {
    await withEnv(
      {
        QUOTEOPS_INSTALLATION_ID: "",
        QUOTEOPS_LICENSE_JSON: "",
        QUOTEOPS_LICENSE_PATH: "/tmp/quoteops-license-missing.json",
        QUOTEOPS_LICENSE_PUBLIC_KEY_PEM: ""
      },
      async () => {
        const baseUrl = await startApi({
          defaultTools: reviewRouteTools()
        });

        const submit = await fetch(`${baseUrl}/api/rfqs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reviewWorkflowInput("RUN-API-REVIEW-NO-INSTALL-001"))
        });
        const body = await submit.json();
        const approvals = await fetch(`${baseUrl}/api/approvals`);
        const approvalBody = await approvals.json();

        expect(submit.status).toBe(423);
        expect(body).toEqual({
          error: "appliance_locked",
          reason: "installation_id_missing",
          client_id: "cliente-demo",
          installation_id: null
        });
        expect(approvals.status).toBe(200);
        expect(approvalBody.items).toEqual([]);
      }
    );
  });

  it("blocks RFQ processing when the signed license is missing", async () => {
    await withEnv(
      {
        QUOTEOPS_INSTALLATION_ID: "cliente-demo-prod-001",
        QUOTEOPS_LICENSE_JSON: "",
        QUOTEOPS_LICENSE_PATH: "/tmp/quoteops-license-missing.json",
        QUOTEOPS_LICENSE_PUBLIC_KEY_PEM: ""
      },
      async () => {
        const baseUrl = await startApi();

        const response = await fetch(`${baseUrl}/api/rfqs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(workflowInput)
        });
        const body = await response.json();
        const rfqs = await fetch(`${baseUrl}/api/rfqs`);
        const rfqBody = await rfqs.json();

        expect(response.status).toBe(423);
        expect(body).toEqual({
          error: "appliance_locked",
          reason: "license_file_missing",
          client_id: "cliente-demo",
          installation_id: "cliente-demo-prod-001"
        });
        expect(rfqBody.items).toEqual([]);
      }
    );
  });

  it("records approval decisions without sending email by default", async () => {
    const baseUrl = await startApi({
      defaultTools: reviewRouteTools()
    });
    const runId = "RUN-API-DECISION-001";
    await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reviewWorkflowInput(runId))
    });

    const response = await fetch(`${baseUrl}/api/approvals/${runId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "adjust", rate_mxn: 12500, reason: "pricing review" })
    });
    const body = await response.json();
    const state = await fetch(`${baseUrl}/api/workflow-state/${runId}`);
    const snapshot = await state.json();

    expect(response.status).toBe(200);
    expect(body.approval_decision).toMatchObject({
      action: "adjust",
      rate_mxn: 12500,
      email_sent: false
    });
    expect(body.writeback_result).toMatchObject({ status: "written" });
    expect(snapshot.approval_state.required).toBe(false);
    expect(snapshot.node_status.writeback).toBe("completed");
  });

  it("applies an approved review decision and writes back through local tools", async () => {
    let writebackRate = 0;
    const baseUrl = await startApi({
      defaultTools: {
        ...reviewRouteTools(),
        writeback: async ({ recommendation }) => {
          writebackRate = recommendation.recommended_rate_mxn;
          return { status: "written", quote_id: "QUOTE-APPROVED-1" };
        }
      }
    });

    const submit = await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...workflowInput,
        run_id: "RUN-API-APPROVAL-WRITEBACK-001"
      })
    });
    const submitted = await submit.json();
    const preDecisionState = await fetch(`${baseUrl}/api/workflow-state/RUN-API-APPROVAL-WRITEBACK-001`);
    const preDecisionSnapshot = await preDecisionState.json();

    expect(submit.status).toBe(202);
    expect(submitted.status).toBe("REVIEW_REQUIRED");
    expect(submitted.approval_required).toBe(true);
    expect(preDecisionSnapshot.approval_state.required).toBe(true);

    const decision = await fetch(`${baseUrl}/api/approvals/RUN-API-APPROVAL-WRITEBACK-001/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "adjust", rate_mxn: 12500, reason: "approved by portal" })
    });
    const body = await decision.json();
    const state = await fetch(`${baseUrl}/api/workflow-state/RUN-API-APPROVAL-WRITEBACK-001`);
    const snapshot = await state.json();

    expect(decision.status).toBe(200);
    expect(writebackRate).toBe(12500);
    expect(body.writeback_result).toMatchObject({ status: "written" });
    expect(snapshot.approval_state.required).toBe(false);
    expect(snapshot.recommendation.recommended_rate_mxn).toBe(12500);
    expect(snapshot.writeback_result).toMatchObject({ status: "written" });
  });

  it.each(["reject", "request_review"] as const)(
    "clears stale writeback result and skips writeback on %s decision",
    async (action) => {
      let writebackCalls = 0;
      const runId = `RUN-API-${action.toUpperCase()}-STALE-WRITEBACK-001`;
      const baseUrl = await startApi({
        defaultTools: {
          ...reviewRouteTools(),
          writeback: async () => {
            writebackCalls += 1;
            return { status: "written", quote_id: "QUOTE-STALE-WRITEBACK-1" };
          }
        }
      });

      await fetch(`${baseUrl}/api/rfqs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...workflowInput, run_id: runId })
      });
      await fetch(`${baseUrl}/api/approvals/${runId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "adjust", rate_mxn: 12500, reason: "initial approval" })
      });

      const response = await fetch(`${baseUrl}/api/approvals/${runId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, reason: "needs another review" })
      });
      const body = await response.json();
      const state = await fetch(`${baseUrl}/api/workflow-state/${runId}`);
      const snapshot = await state.json();

      expect(response.status).toBe(200);
      expect(writebackCalls).toBe(1);
      expect(body.writeback_result).toBeNull();
      expect(snapshot.writeback_result).toBeNull();
      expect(snapshot.approval_state.required).toBe(true);
      expect(snapshot.approval_state.reasons).toContain(action);
      expect(snapshot.node_status.writeback).toBe("review_required");
    }
  );

  it("marks non-success writeback statuses as failed", async () => {
    const runId = "RUN-API-WRITEBACK-UNKNOWN-STATUS-001";
    const baseUrl = await startApi({
      defaultTools: {
        ...reviewRouteTools(),
        writeback: async () => ({ status: "accepted" })
      }
    });

    await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...workflowInput, run_id: runId })
    });
    const response = await fetch(`${baseUrl}/api/approvals/${runId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "adjust", rate_mxn: 12500, reason: "approved by portal" })
    });
    const body = await response.json();
    const state = await fetch(`${baseUrl}/api/workflow-state/${runId}`);
    const snapshot = await state.json();

    expect(response.status).toBe(200);
    expect(body.writeback_result).toMatchObject({ status: "accepted" });
    expect(snapshot.writeback_result).toMatchObject({ status: "accepted" });
    expect(snapshot.node_status.writeback).toBe("failed");
  });

  it("rejects invalid approval decision rate fields", async () => {
    const runId = "RUN-API-INVALID-DECISION-RATE-001";
    const baseUrl = await startApi({
      defaultTools: reviewRouteTools()
    });

    await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...workflowInput, run_id: runId })
    });

    const missingAdjustRate = await fetch(`${baseUrl}/api/approvals/${runId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "adjust", reason: "missing rate" })
    });
    const negativeAdjustRate = await fetch(`${baseUrl}/api/approvals/${runId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "adjust", rate_mxn: -1, reason: "negative rate" })
    });
    const approveWithRate = await fetch(`${baseUrl}/api/approvals/${runId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "approve", rate_mxn: 12500 })
    });

    expect(missingAdjustRate.status).toBe(400);
    expect(negativeAdjustRate.status).toBe(400);
    expect(approveWithRate.status).toBe(400);
  });

  it("uses appliance manifest when the request omits manifest", async () => {
    const baseUrl = await startApi({
      defaultManifest: Promise.resolve(workflowInput.manifest)
    });
    const { manifest: _manifest, ...payload } = workflowInput;

    const response = await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, run_id: "RUN-API-MANIFEST-001" })
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      run_id: "RUN-API-MANIFEST-001",
      status: "APPROVED"
    });
  });

  it("marks configured OpenRouter missing-key recommendations as review-required", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-openrouter-missing-key-"));
    tempDirs.push(dir);
    const configPath = join(dir, "agent-config.yaml");
    await writeFile(
      configPath,
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "  temperature: 0",
        "  api_key_env: OPENROUTER_API_KEY",
        "authorization:",
        "  tools:",
        "    route.resolve:",
        "      effect: read",
        "      mode: allowed",
        "    tms.searchHistorical:",
        "      effect: read",
        "      mode: allowed",
        "    tms.writeQuoteResult:",
        "      effect: write",
        "      mode: allowed",
        "    email.sendQuote:",
        "      effect: send",
        "      mode: approval_required",
        "    approval.decide:",
        "      effect: approve",
        "      mode: approval_required",
        ""
      ].join("\n"),
      "utf8"
    );
    const applianceTools = createApplianceWorkflowTools({
      env: {
        QUOTEOPS_AGENT_CONFIG_PATH: configPath,
        QUOTEOPS_SECRETS_ENV_FILE: join(dir, "missing-client.env"),
        QUOTEOPS_OPENROUTER_KEYS_PATH: join(dir, "missing-keys.md")
      },
      fetch: async () => {
        throw new Error("OpenRouter should not be called without an API key");
      }
    });
    const runId = "RUN-API-OPENROUTER-MISSING-KEY-001";
    const baseUrl = await startApi({
      defaultTools: {
        ...workflowInput.tools,
        recommend: applianceTools.recommend
      }
    });

    const submit = await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...workflowInput, run_id: runId })
    });
    const submitted = await submit.json();
    const state = await fetch(`${baseUrl}/api/workflow-state/${runId}`);
    const snapshot = await state.json();

    expect(submit.status).toBe(202);
    expect(submitted.status).toBe("REVIEW_REQUIRED");
    expect(submitted.approval_required).toBe(true);
    expect(snapshot.recommendation).toMatchObject({
      status: "failed",
      recommended_rate_mxn: snapshot.base_quote.base_rate_mxn
    });
    expect(snapshot.recommendation.error).toContain("OpenRouter API key is missing");
    expect(snapshot.node_status.pricingRecommendation).toBe("failed");
    expect(snapshot.node_status.approvalGate).toBe("review_required");
    expect(snapshot.node_status.writeback).toBe("review_required");
    expect(snapshot.approval_state.reasons).toContain("ai_recommendation_failed");
  });

  it("ingests control-plane heartbeats", async () => {
    const baseUrl = await startApi();

    const response = await fetch(`${baseUrl}/api/control-plane/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "cliente-demo",
        installation_id: "cliente-demo-prod-001",
        version: "quoteops-v2.0.0",
        connector_health: { tms: "ok" },
        queue_depth: 0,
        pending_approvals: 0,
        last_successful_rfq_at: "2026-06-16T15:00:00-06:00",
        last_backup_at: "2026-06-16T02:00:00-06:00",
        disk_usage: { used_pct: 0.42 },
        error_counts: {}
      })
    });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.heartbeat.client_id).toBe("cliente-demo");
  });

  it("returns health with product and workflow counts", async () => {
    const originalVersion = process.env.QUOTEOPS_VERSION;
    testEnvRestores.push(() => {
      if (originalVersion === undefined) {
        delete process.env.QUOTEOPS_VERSION;
      } else {
        process.env.QUOTEOPS_VERSION = originalVersion;
      }
    });
    delete process.env.QUOTEOPS_VERSION;
    const baseUrl = await startApi();

    const response = await fetch(`${baseUrl}/api/health`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    // no QUOTEOPS_VERSION set → falls back to the package.json version
    expect(body.product_version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(body.workflow_runs).toBe(0);

    process.env.QUOTEOPS_VERSION = "quoteops-v9.9.9";
    const envResponse = await fetch(`${baseUrl}/api/health`);
    expect((await envResponse.json()).product_version).toBe("quoteops-v9.9.9");

    await fetch(`${baseUrl}/api/rfqs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(workflowInput)
    });
    await fetch(`${baseUrl}/api/control-plane/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "cliente-demo",
        installation_id: "cliente-demo-prod-001",
        version: "quoteops-v2.0.0",
        connector_health: { tms: "ok" },
        queue_depth: 0,
        pending_approvals: 0,
        last_successful_rfq_at: "2026-06-16T15:00:00-06:00",
        last_backup_at: "2026-06-16T02:00:00-06:00",
        disk_usage: { used_pct: 0.42 },
        error_counts: {}
      })
    });
    const updatedResponse = await fetch(`${baseUrl}/api/health`);
    const updatedBody = await updatedResponse.json();

    expect(updatedResponse.status).toBe(200);
    expect(updatedBody.workflow_runs).toBe(1);
    expect(updatedBody.heartbeats).toBe(1);
  });

  it("syncs only minimal heartbeat and aggregate counters to the control plane", async () => {
    const data = createInMemoryControlPlaneData();
    await data.upsertRelease(await createApiTestRelease("v1.1.0", "Stable"));
    const cloudBaseUrl = await startCloudTestServer("unused-token", data);
    await fetch(`${cloudBaseUrl}/api/admin/clients`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({
        client_id: "cliente-demo",
        legal_name: "Cliente Demo SA de CV",
        authorized_email: "ops@cliente.com"
      })
    });
    await fetch(`${cloudBaseUrl}/api/admin/clients/cliente-demo/install-pack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: "{}"
    });
    await fetch(`${cloudBaseUrl}/api/onboarding/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "cliente-demo",
        installation_id: "cliente-demo-prod-001",
        email: "ops@cliente.com",
        registration_token: "unused-token"
      })
    });
    data.installations.get("cliente-demo-prod-001")!.settings = {
      pricing_model: "profitability",
      pdf_template: { title: "Plantilla sincronizada", show_breakdown: false }
    };
    const syncDir = await mkdtemp(join(tmpdir(), "quoteops-settings-sync-"));
    tempDirs.push(syncDir);
    const settingsPath = join(syncDir, "runtime-settings.json");
    const pdfTemplatePath = join(syncDir, "pdf-template.json");

    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_CONTROL_PLANE_URL: cloudBaseUrl,
        QUOTEOPS_REGISTRATION_TOKEN: "unused-token",
        QUOTEOPS_VERSION: "v1.0.0",
        QUOTEOPS_SETTINGS_PATH: settingsPath,
        QUOTEOPS_PDF_TEMPLATE_PATH: pdfTemplatePath
      }),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        await fetch(`${baseUrl}/api/rfqs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...workflowInput, run_id: "RUN-SYNC-MINIMAL-001" })
        });

        const sync = await fetch(`${baseUrl}/api/control-plane/sync-minimal`, {
          method: "POST"
        });
        const syncBody = await sync.json();
        const serialized = JSON.stringify(syncBody);

        expect(sync.status).toBe(202);
        expect(syncBody.heartbeat).toEqual({
          client_id: "cliente-demo",
          ai_key_status: "configured",
          onboarding_status: "licensed",
          version: "v1.0.0"
        });
        expect(syncBody.counters).toEqual({
          client_id: "cliente-demo",
          total: 1,
          validated: 1,
          rejected: 0,
          pending: 0,
          failed: 0
        });
        expect(serialized).not.toContain("raw_rfq");
        expect(serialized).not.toContain("compras@cliente.com");
        expect(serialized).not.toContain("route_evidence");
        expect(serialized).not.toContain("TMS_API_KEY");

        const cloudClients = await fetch(`${cloudBaseUrl}/api/admin/clients`, {
          headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
        });
        const cloudBody = await cloudClients.json();
        expect(cloudBody.items[0].installation.ai_key_status).toBe("configured");
        expect(cloudBody.items[0].installation.onboarding_status).toBe("licensed");
        expect(cloudBody.items[0].counters).toEqual({
          total: 1,
          validated: 1,
          rejected: 0,
          pending: 0,
          failed: 0
        });
        expect(JSON.parse(await readFile(settingsPath, "utf8"))).toEqual({
          pricing_model: "profitability",
          pdf_template: { title: "Plantilla sincronizada", show_breakdown: false }
        });
        expect(await loadPdfTemplate(pdfTemplatePath)).toMatchObject({
          title: "Plantilla sincronizada",
          show_breakdown: false
        });

        const lane = workflowInput.raw_rfq.parsed.lanes[0]!;
        const graphQuote = await quoteLane(
          lane,
          await workflowInput.tools.resolveRoute(lane),
          {
            manifest: workflowInput.manifest,
            tools: workflowInput.tools,
            env: { QUOTEOPS_SETTINGS_PATH: settingsPath },
            now: () => new Date("2026-07-12T00:00:00.000Z")
          } as never
        );
        expect(graphQuote.manifest.vehicle_profiles[0]?.pricing_model).toBe("profitability");
      }
    );
  });

  it("pushes the minimal heartbeat to the control plane from the periodic scheduler", async () => {
    const cloudBaseUrl = await startCloudTestServer("unused-token");
    await fetch(`${cloudBaseUrl}/api/admin/clients`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({
        client_id: "cliente-demo",
        legal_name: "Cliente Demo SA de CV",
        authorized_email: "ops@cliente.com"
      })
    });
    await fetch(`${cloudBaseUrl}/api/admin/clients/cliente-demo/install-pack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: "{}"
    });
    await fetch(`${cloudBaseUrl}/api/onboarding/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "cliente-demo",
        installation_id: "cliente-demo-prod-001",
        email: "ops@cliente.com",
        registration_token: "unused-token"
      })
    });

    let timer: NodeJS.Timeout | null = null;
    try {
      await withEnv(
        await setupReadyEnv({
          QUOTEOPS_CONTROL_PLANE_URL: cloudBaseUrl,
          QUOTEOPS_REGISTRATION_TOKEN: "unused-token",
          QUOTEOPS_VERSION: "v1.0.0",
          QUOTEOPS_SYNC_INTERVAL_MS: "3600000"
        }),
        async () => {
          timer = startControlPlaneSyncScheduler({
            store: createInMemoryQuoteOpsStore(),
            resolveManifest: () => Promise.resolve(workflowInput.manifest)
          });
          expect(timer).not.toBeNull();

          const installation = await waitForCloudHeartbeat(cloudBaseUrl);
          expect(installation.ai_key_status).toBe("configured");
          // empty store: no passing test RFQ yet, so the freshly booted
          // appliance reports "licensed" (not "ready")
          expect(installation.onboarding_status).toBe("licensed");
        }
      );
    } finally {
      if (timer) clearInterval(timer);
    }
  });

  it("does not start the periodic control plane sync when disabled or unconfigured", () => {
    const store = createInMemoryQuoteOpsStore();
    const configured = {
      QUOTEOPS_CONTROL_PLANE_URL: "http://127.0.0.1:9",
      QUOTEOPS_INSTALLATION_ID: "cliente-demo-prod-001",
      QUOTEOPS_REGISTRATION_TOKEN: "test-token",
      QUOTEOPS_VERSION: "v1.0.0"
    };

    expect(
      startControlPlaneSyncScheduler({ env: { ...configured, QUOTEOPS_SYNC_INTERVAL_MS: "0" }, store })
    ).toBeNull();
    expect(
      startControlPlaneSyncScheduler({ env: { ...configured, QUOTEOPS_SYNC_INTERVAL_MS: "" }, store })
    ).toBeNull();
    expect(
      startControlPlaneSyncScheduler({
        env: { QUOTEOPS_INSTALLATION_ID: configured.QUOTEOPS_INSTALLATION_ID },
        store
      })
    ).toBeNull();
    expect(
      startControlPlaneSyncScheduler({
        env: { QUOTEOPS_CONTROL_PLANE_URL: configured.QUOTEOPS_CONTROL_PLANE_URL },
        store
      })
    ).toBeNull();
  });

  it("exposes cloud-safe local setup state without raw data or secret values", async () => {
    await withEnv(
      {
        QUOTEOPS_ACTIVATION_REQUIRED: "false",
        QUOTEOPS_ACTIVATION_STATUS: "unlocked",
        QUOTEOPS_INSTALLATION_ID: "cliente-demo-prod-001",
        QUOTEOPS_LICENSE_PATH: "/tmp/quoteops-license-present-but-not-valid.json",
        QUOTEOPS_SECRETS_ENV_FILE: "",
        INEGI_SAKBE_KEY: "",
        QUOTEOPS_SAKBE_API_KEY: "",
        OPENROUTER_API_KEY: "",
        GEMINI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        QUOTEOPS_EMBEDDING_API_KEY: "",
        TMS_API_KEY: "",
        QUOTEOPS_TMS_API_KEY: "",
        TMS_AUTH_TOKEN: "",
        MAILBOX_USER: "",
        MAILBOX_PASSWORD: "",
        MAILBOX_OAUTH_REFRESH_TOKEN: "",
        QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: "",
        QUOTEOPS_TMS_RFQS_PATH: "",
        QUOTEOPS_TMS_HISTORICAL_QUOTES_PATH: "",
        QUOTEOPS_TMS_HISTORICAL_SHIPMENTS_PATH: "",
        QUOTEOPS_TMS_QUOTE_WRITEBACKS_PATH: "",
        TMS_BASE_URL: "",
        QUOTEOPS_TMS_MAPPING_CONFIG_PATH: "",
        QUOTEOPS_KNOWLEDGE_DIR: "",
        QUOTEOPS_CONNECTORS_DIR: ""
      },
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });

        const response = await fetch(`${baseUrl}/api/setup-state`);
        const body = await response.json();
        const serialized = JSON.stringify(body);

        expect(response.status).toBe(200);
        expect(body.activation).toEqual({
          required: true,
          status: "locked",
          client_id: "cliente-demo",
          installation_id: "cliente-demo-prod-001"
        });
        expect(body.required_steps).toEqual(
          expect.arrayContaining([
            "activate_license",
            "configure_secrets",
            "connect_tms",
            "map_tms",
            "connect_knowledge_base",
            "connect_mailbox",
            "connect_sakbe",
            "run_test_rfq"
          ])
        );
        expect(serialized).not.toContain("compras@cliente.com");
        expect(serialized).not.toContain("raw_rfq");
        expect(serialized).not.toContain("TMS_API_KEY");
        expect(serialized).not.toContain("secret_value");
      }
    );
  });

  it("unlocks setup only when the signed license verifies for the local installation", async () => {
    const keyPair = generateLicenseKeyPair();
    const license = createInstallationLicense({
      client_id: "cliente-demo",
      installation_id: "cliente-demo-prod-001",
      release_channel: "stable",
      features: ["rfq_processing"],
      issued_at: "2026-06-01T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
      private_key_pem: keyPair.private_key_pem
    });

    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_ACTIVATION_REQUIRED: "true",
        QUOTEOPS_INSTALLATION_ID: "cliente-demo-prod-001",
        QUOTEOPS_LICENSE_JSON: JSON.stringify(license),
        QUOTEOPS_LICENSE_PUBLIC_KEY_PEM: keyPair.public_key_pem
      }),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.activation).toMatchObject({
          required: true,
          status: "unlocked",
          client_id: "cliente-demo",
          installation_id: "cliente-demo-prod-001"
        });
        expect(body.required_steps).not.toContain("activate_license");
      }
    );
  });

  it("activates against the control plane and stores the signed license locally", async () => {
    const cloudBaseUrl = await startCloudTestServer("registration-token-local");
    await fetch(`${cloudBaseUrl}/api/admin/clients`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({
        client_id: "cliente-demo",
        legal_name: "Cliente Demo SA de CV",
        authorized_email: "ops@cliente.com"
      })
    });
    await fetch(`${cloudBaseUrl}/api/admin/clients/cliente-demo/install-pack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: "{}"
    });
    const home = await mkdtemp(join(tmpdir(), "quoteops-activation-"));
    tempDirs.push(home);

    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_HOME: home,
        QUOTEOPS_CONTROL_PLANE_URL: cloudBaseUrl,
        QUOTEOPS_REGISTRATION_TOKEN: "registration-token-local",
        QUOTEOPS_LICENSE_JSON: "",
        QUOTEOPS_LICENSE_PUBLIC_KEY_PEM: "",
        QUOTEOPS_LICENSE_PATH: join(home, "license.json"),
        QUOTEOPS_LICENSE_PUBLIC_KEY_PATH: join(home, "license-public-key.pem")
      }),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const locked = await fetch(`${baseUrl}/api/setup-state`);
        const lockedBody = await locked.json();
        expect(lockedBody.required_steps).toContain("activate_license");

        const activated = await fetch(`${baseUrl}/api/onboarding/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "ops@cliente.com" })
        });
        const activatedBody = await activated.json();
        expect(activated.status).toBe(200);
        expect(activatedBody).toMatchObject({
          activated: true,
          client_id: "cliente-demo",
          installation_id: "cliente-demo-prod-001"
        });

        const unlocked = await fetch(`${baseUrl}/api/setup-state`);
        const unlockedBody = await unlocked.json();
        expect(unlockedBody.activation.status).toBe("unlocked");
        expect(unlockedBody.required_steps).not.toContain("activate_license");
      }
    );
  });

  it("propagates the control plane rejection code instead of an opaque 500", async () => {
    const cloudBaseUrl = await startCloudTestServer("registration-token-reused");
    await fetch(`${cloudBaseUrl}/api/admin/clients`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({
        client_id: "cliente-demo",
        legal_name: "Cliente Demo SA de CV",
        authorized_email: "ops@cliente.com"
      })
    });
    await fetch(`${cloudBaseUrl}/api/admin/clients/cliente-demo/install-pack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: "{}"
    });
    const home = await mkdtemp(join(tmpdir(), "quoteops-activation-"));
    tempDirs.push(home);

    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_HOME: home,
        QUOTEOPS_CONTROL_PLANE_URL: cloudBaseUrl,
        QUOTEOPS_REGISTRATION_TOKEN: "registration-token-reused",
        QUOTEOPS_LICENSE_JSON: "",
        QUOTEOPS_LICENSE_PUBLIC_KEY_PEM: "",
        QUOTEOPS_LICENSE_PATH: join(home, "license.json"),
        QUOTEOPS_LICENSE_PUBLIC_KEY_PATH: join(home, "license-public-key.pem")
      }),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const first = await fetch(`${baseUrl}/api/onboarding/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "ops@cliente.com" })
        });
        expect(first.status).toBe(200);

        // the token was consumed by the first activation: the cloud answers
        // 403 registration_token_used and the appliance must not mask it
        const reused = await fetch(`${baseUrl}/api/onboarding/activate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: "ops@cliente.com" })
        });
        const reusedBody = await reused.json();

        expect(reused.status).toBe(403);
        expect(reusedBody.error).toBe("registration_token_used");
        expect(reusedBody.message).toContain("Generate install pack");
      }
    );
  });

  it("requires every local secret group before marking secrets configured", async () => {
    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_SECRETS_ENV_FILE: join(tmpdir(), "quoteops-missing-client.env"),
        INEGI_SAKBE_KEY: "sakbe-present",
        QUOTEOPS_SAKBE_API_KEY: "",
        OPENROUTER_API_KEY: "",
        GEMINI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        QUOTEOPS_EMBEDDING_API_KEY: "",
        TMS_API_KEY: "",
        QUOTEOPS_TMS_API_KEY: "",
        TMS_AUTH_TOKEN: "",
        MAILBOX_USER: "",
        MAILBOX_PASSWORD: "",
        MAILBOX_OAUTH_REFRESH_TOKEN: ""
      }),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.required_steps).toContain("configure_secrets");
      }
    );

    clearApplianceTestApps();

    await withEnv(
      await setupReadyEnv(),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.required_steps).not.toContain("configure_secrets");
      }
    );
  });

  it("derives setup and heartbeat readiness from the configured NVIDIA NIM and Resend providers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-provider-readiness-"));
    tempDirs.push(dir);
    const agentConfigPath = join(dir, "agent-config.yaml");
    const malformedAgentConfigPath = join(dir, "malformed-agent-config.yaml");
    await writeFile(
      agentConfigPath,
      [
        "model:",
        "  provider: openai",
        "  model_name: nvidia/llama-3.3-nemotron-super-49b-v1",
        "  temperature: 0",
        "  api_key_env: NVIDIA_NIM_API_KEY",
        "authorization:",
        "  tools: {}",
        "mailbox:",
        "  provider: resend",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(malformedAgentConfigPath, "model: not-an-object\n", "utf8");
    const providerMailboxReceiptPath = join(dir, "mailbox-probe.json");
    const providerCredentialRevisionPath = join(
      dir,
      "appliance-secrets-credential.json"
    );
    await writeFile(
      providerCredentialRevisionPath,
      JSON.stringify({ schema_version: 1, credential_revision: 1 })
    );
    await writeFile(
      providerMailboxReceiptPath,
      JSON.stringify({
        schema_version: 1,
        provider: "resend",
        status: "ok",
        agent_config_sha256: createHash("sha256")
          .update(await readFile(agentConfigPath))
          .digest("hex"),
        credential_revision: 1,
        validated_at: "2026-07-01T00:00:00.000Z",
        code: "message_accepted"
      })
    );
    const cloudBaseUrl = await startCloudTestServer("provider-ready-token");
    await fetch(`${cloudBaseUrl}/api/admin/clients`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: JSON.stringify({
        client_id: "cliente-demo",
        legal_name: "Cliente Demo SA de CV",
        authorized_email: "ops@cliente.com"
      })
    });
    await fetch(`${cloudBaseUrl}/api/admin/clients/cliente-demo/install-pack`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TEST_ADMIN_TOKEN}` },
      body: "{}"
    });
    await fetch(`${cloudBaseUrl}/api/onboarding/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: "cliente-demo",
        installation_id: "cliente-demo-prod-001",
        email: "ops@cliente.com",
        registration_token: "provider-ready-token"
      })
    });

    const providerReadyEnv = await setupReadyEnv({
      QUOTEOPS_AGENT_CONFIG_PATH: agentConfigPath,
      QUOTEOPS_CONTROL_PLANE_URL: cloudBaseUrl,
      QUOTEOPS_REGISTRATION_TOKEN: "provider-ready-token",
      QUOTEOPS_VERSION: "v1.0.0",
      NVIDIA_NIM_API_KEY: "nim-present",
      RESEND_API_KEY: "resend-present",
      MAILBOX_FROM: "quotes@example.com",
      MAILBOX_PASSWORD: "",
      MAILBOX_OAUTH_CLIENT_ID: "",
      MAILBOX_OAUTH_CLIENT_SECRET: "",
      MAILBOX_OAUTH_REFRESH_TOKEN: "",
      OPENROUTER_API_KEY: "",
      QUOTEOPS_EMBEDDING_API_KEY: "",
      TMS_API_KEY: "",
      QUOTEOPS_MAILBOX_PROBE_RECEIPT_PATH: providerMailboxReceiptPath,
      QUOTEOPS_APPLIANCE_CREDENTIAL_REVISION_PATH:
        providerCredentialRevisionPath
    });

    await withEnv(providerReadyEnv, async () => {
      const baseUrl = await startApi({
        defaultManifest: Promise.resolve(workflowInput.manifest)
      });
      const setupResponse = await fetch(`${baseUrl}/api/setup-state`);
      const setup = await setupResponse.json();

      expect(setupResponse.status).toBe(200);
      expect(setup.required_steps).not.toContain("configure_secrets");
      expect(setup.required_steps).not.toContain("connect_mailbox");

      const syncResponse = await fetch(`${baseUrl}/api/control-plane/sync-minimal`, {
        method: "POST"
      });
      const sync = await syncResponse.json();
      expect(syncResponse.status).toBe(202);
      expect(sync.heartbeat.ai_key_status).toBe("configured");
    });

    clearApplianceTestApps();

    await withEnv(
      { ...providerReadyEnv, NVIDIA_NIM_API_KEY: "" },
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const setup = await response.json();

        expect(response.status).toBe(200);
        expect(setup.required_steps).toContain("configure_secrets");
      }
    );

    clearApplianceTestApps();

    await withEnv(
      { ...providerReadyEnv, RESEND_API_KEY: "" },
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const setup = await response.json();

        expect(response.status).toBe(200);
        expect(setup.required_steps).not.toContain("configure_secrets");
        expect(setup.required_steps).toContain("connect_mailbox");
      }
    );

    clearApplianceTestApps();

    await withEnv(
      { ...providerReadyEnv, QUOTEOPS_AGENT_CONFIG_PATH: join(dir, "missing-agent-config.yaml") },
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const setup = await response.json();

        expect(response.status).toBe(200);
        expect(setup.required_steps).toContain("configure_secrets");
        expect(setup.required_steps).toContain("connect_mailbox");
      }
    );

    clearApplianceTestApps();

    await withEnv(
      { ...providerReadyEnv, QUOTEOPS_AGENT_CONFIG_PATH: malformedAgentConfigPath },
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const setup = await response.json();

        expect(response.status).toBe(200);
        expect(setup.required_steps).toContain("configure_secrets");
        expect(setup.required_steps).toContain("connect_mailbox");
      }
    );
  });

  it("keeps the TMS connection step pending until the configured adapter and its environment resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-tms-connection-readiness-"));
    tempDirs.push(dir);
    const malformedAdapterPath = join(dir, "malformed-tms-adapter.yaml");
    const httpAdapterPath = join(dir, "http-tms-adapter.yaml");
    const fileImportAdapterPath = join(dir, "file-import-tms-adapter.yaml");
    const usableRfqPath = join(dir, "rfqs.csv");
    const usableWritebackPath = join(dir, "writebacks", "quotes.ndjson");
    const notADirectoryPath = join(dir, "not-a-directory");
    await writeFile(malformedAdapterPath, "provider: unsupported\n", "utf8");
    await writeFile(
      fileImportAdapterPath,
      [
        "provider: file_import",
        "rfqs_path_env: CLIENT_RFQS_PATH",
        "quote_writebacks_path_env: CLIENT_QUOTE_WRITEBACKS_PATH",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(usableRfqPath, "rfq_id,lane_id\n", "utf8");
    await mkdir(join(dir, "writebacks"), { recursive: true });
    await writeFile(notADirectoryPath, "not a directory\n", "utf8");
    await writeFile(
      httpAdapterPath,
      [
        "provider: http",
        "base_url_env: TMS_HTTP_BASE_URL",
        "headers:",
        "  Authorization: Bearer \${TMS_HTTP_TOKEN}",
        ""
      ].join("\n"),
      "utf8"
    );

    const expectPendingConnection = async (overrides: Record<string, string>) => {
      await withEnv(await setupReadyEnv(overrides), async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const setup = await response.json();

        expect(response.status).toBe(200);
        expect(setup.required_steps).toContain("connect_tms");
      });
      clearApplianceTestApps();
    };

    await expectPendingConnection({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: join(dir, "missing-tms-adapter.yaml")
    });
    await expectPendingConnection({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: malformedAdapterPath
    });
    await expectPendingConnection({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: fileImportAdapterPath,
      CLIENT_RFQS_PATH: "",
      CLIENT_QUOTE_WRITEBACKS_PATH: usableWritebackPath
    });
    await expectPendingConnection({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: fileImportAdapterPath,
      CLIENT_RFQS_PATH: join(dir, "missing-rfqs.csv"),
      CLIENT_QUOTE_WRITEBACKS_PATH: usableWritebackPath
    });
    // A file used as a would-be parent is deterministically unusable on both
    // root and unprivileged test runs; chmod alone is not reliable for root.
    await expectPendingConnection({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: fileImportAdapterPath,
      CLIENT_RFQS_PATH: usableRfqPath,
      CLIENT_QUOTE_WRITEBACKS_PATH: join(notADirectoryPath, "quotes.ndjson")
    });
    await expectPendingConnection({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: httpAdapterPath,
      TMS_HTTP_BASE_URL: "",
      TMS_HTTP_TOKEN: ""
    });
    await expectPendingConnection({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: httpAdapterPath,
      TMS_HTTP_BASE_URL: "https://tms.example.test",
      TMS_HTTP_TOKEN: ""
    });

    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: fileImportAdapterPath,
        CLIENT_RFQS_PATH: usableRfqPath,
        CLIENT_QUOTE_WRITEBACKS_PATH: usableWritebackPath
      }),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const setup = await response.json();

        expect(response.status).toBe(200);
        expect(setup.required_steps).not.toContain("connect_tms");
      }
    );
  });

  it("requires an exact live receipt for canonical and legacy HTTP readiness", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-tms-receipt-readiness-"));
    tempDirs.push(dir);
    const adapterPath = join(dir, "tms-adapter.yaml");
    const receiptPath = join(dir, "tms-probe.json");
    const revisionPath = join(dir, "tms-credential-revision");
    const canonicalConfig = [
      "provider: http",
      "contract: quoteops-tms-http-v1",
      "base_url_env: TMS_HTTP_BASE_URL",
      "headers:",
      "  authorization: Bearer ${TMS_API_KEY}",
      "health_endpoint_path: /quoteops/v1/health",
      "search_historical_quotes_endpoint_path: /quoteops/v1/historical-quotes/search",
      "get_units_endpoint_path: /quoteops/v1/units",
      "get_unit_performance_endpoint_path: /quoteops/v1/unit-performance",
      "get_availability_zones_endpoint_path: /quoteops/v1/availability-zones",
      "write_quote_endpoint_path: /quoteops/v1/quotes",
      ""
    ].join("\n");
    await writeFile(adapterPath, canonicalConfig);
    await writeFile(
      revisionPath,
      JSON.stringify({ schema_version: 1, credential_revision: 2 })
    );
    const env = await setupReadyEnv({
      QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: adapterPath,
      QUOTEOPS_TMS_PROBE_PATH: receiptPath,
      QUOTEOPS_TMS_CREDENTIAL_REVISION_PATH: revisionPath,
      TMS_HTTP_BASE_URL: "https://tms.client.example",
      TMS_API_KEY: "configured"
    });

    const readRequiredSteps = async (): Promise<string[]> => {
      let requiredSteps: string[] = [];
      await withEnv(env, async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        requiredSteps = (await response.json()).required_steps;
      });
      clearApplianceTestApps();
      return requiredSteps;
    };

    expect(await readRequiredSteps()).toContain("connect_tms");
    expect(await readRequiredSteps()).not.toContain("map_tms");

    const canonicalHash = createHash("sha256")
      .update(await readFile(adapterPath))
      .digest("hex");
    await writeFile(
      receiptPath,
      JSON.stringify({
        contract: "quoteops-tms-http-v1",
        adapter_config_sha256: canonicalHash,
        credential_revision: 2,
        base_url_origin: "https://tms.client.example",
        validated_at: "2026-07-29T18:00:00.000Z",
        checks: {
          health: "ok",
          historical_quotes: "ok",
          units: "ok",
          unit_performance: "ok",
          availability_zones: "ok",
          write_quote_declared: "ok"
        }
      })
    );
    expect(await readRequiredSteps()).not.toContain("connect_tms");
    expect(await readRequiredSteps()).not.toContain("map_tms");

    const legacyConfig = canonicalConfig
      .replace("contract: quoteops-tms-http-v1\n", "")
      .replace("/quoteops/v1/health", "/health")
      .replace(
        "/quoteops/v1/historical-quotes/search",
        "/historical-quotes/search"
      )
      .replace("/quoteops/v1/units", "/units")
      .replace("/quoteops/v1/unit-performance", "/unit-performance")
      .replace("/quoteops/v1/availability-zones", "/availability-zones")
      .replace("/quoteops/v1/quotes", "/quotes");
    await writeFile(adapterPath, legacyConfig);
    expect(await readRequiredSteps()).not.toContain("connect_tms");
    expect(await readRequiredSteps()).toContain("map_tms");

    await writeFile(
      receiptPath,
      JSON.stringify({
        contract: "legacy-custom-http-canonical-output-v1",
        adapter_config_sha256: createHash("sha256")
          .update(await readFile(adapterPath))
          .digest("hex"),
        credential_revision: 2,
        base_url_origin: "https://tms.client.example",
        validated_at: "2026-07-29T18:00:00.000Z",
        checks: {
          health: "ok",
          historical_quotes: "ok",
          units: "ok",
          unit_performance: "ok",
          availability_zones: "ok",
          write_quote_configured: "ok"
        }
      })
    );
    expect(await readRequiredSteps()).not.toContain("connect_tms");
    expect(await readRequiredSteps()).not.toContain("map_tms");
  });

  it("does not treat staged knowledge or mailbox env keys as completed receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "quoteops-receipt-gates-"));
    tempDirs.push(dir);
    await mkdir(join(dir, "knowledge"), { recursive: true });
    await writeFile(join(dir, "knowledge", "staged.md"), "# staged only\n");

    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_KNOWLEDGE_DIR: join(dir, "knowledge"),
        QUOTEOPS_KNOWLEDGE_RECEIPT_PATH: join(
          dir,
          "missing-knowledge-receipt.json"
        ),
        QUOTEOPS_MAILBOX_PROBE_RECEIPT_PATH: join(
          dir,
          "missing-mailbox-receipt.json"
        )
      }),
      async () => {
        const baseUrl = await startApi({
          defaultManifest: Promise.resolve(workflowInput.manifest)
        });
        const response = await fetch(`${baseUrl}/api/setup-state`);
        const setup = await response.json();

        expect(response.status).toBe(200);
        expect(setup.required_steps).toContain("connect_knowledge_base");
        expect(setup.required_steps).toContain("connect_mailbox");
      }
    );
  });

  it("keeps the test RFQ step required until an approved run has route and writeback evidence", async () => {
    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_ACTIVATION_REQUIRED: "false",
        QUOTEOPS_TEST_RFQ_PASSED: "true",
        QUOTEOPS_TEST_RFQ_STATUS: "passed"
      }),
      async () => {
        const reviewBaseUrl = await startApi({
          defaultTools: reviewRouteTools()
        });
        await fetch(`${reviewBaseUrl}/api/rfqs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reviewWorkflowInput("RUN-SETUP-REVIEW-001"))
        });
        const reviewSetup = await fetch(`${reviewBaseUrl}/api/setup-state`);
        const reviewBody = await reviewSetup.json();

        expect(reviewBody.required_steps).toContain("run_test_rfq");
      }
    );

    clearApplianceTestApps();

    await withEnv(
      await setupReadyEnv({
        QUOTEOPS_ACTIVATION_REQUIRED: "false",
        QUOTEOPS_TEST_RFQ_PASSED: "true",
        QUOTEOPS_TEST_RFQ_STATUS: "passed"
      }),
      async () => {
        const approvedBaseUrl = await startApi();
        await fetch(`${approvedBaseUrl}/api/rfqs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...workflowInput, run_id: "RUN-SETUP-APPROVED-001" })
        });
        const approvedSetup = await fetch(`${approvedBaseUrl}/api/setup-state`);
        const approvedBody = await approvedSetup.json();

        expect(approvedBody.required_steps).not.toContain("run_test_rfq");
      }
    );
  });
});

async function startApi(dependencies: Partial<QuoteOpsApiDependencies> = {}): Promise<string> {
  ensureDefaultLicensedEnvForApiTest();
  const app = createQuoteOpsApi({ defaultTools: workflowInput.tools, ...dependencies });
  return registerTestApp("appliance", app);
}

async function startCloudTestServer(
  registrationToken: string,
  data: ControlPlaneData = createInMemoryControlPlaneData()
): Promise<string> {
  if (!(await data.latestRelease())) {
    await data.upsertRelease(
      await createApiTestRelease("v1.0.0", "API integration test release")
    );
  }
  installFetchRouter();
  const baseUrl = `https://quoteops-cloud-${++nextTestAppId}.test`;
  const app = createControlPlaneApi({
    verifyAdminToken: async (token) => (token === TEST_ADMIN_TOKEN ? "ops@e2e.example" : null),
    tokenGenerator: () => registrationToken,
    now: () => new Date("2026-06-25T12:00:00.000Z"),
    data,
    controlPlaneUrl: baseUrl
  });
  testApps.set(baseUrl, app);
  cloudOrigins.add(baseUrl);
  return baseUrl;
}

async function createApiTestRelease(
  version: string,
  notes: string
): Promise<ReleaseRecord> {
  const digest = (digit: string) => digit.repeat(64);
  const images = {
    agent: `quoteops-agent:${version}@sha256:${digest("1")}`,
    api: `quoteops-api:${version}@sha256:${digest("2")}`,
    web: `quoteops-web:${version}@sha256:${digest("3")}`,
    postgres: `postgres:16@sha256:${digest("4")}`,
    redis: `redis:7@sha256:${digest("5")}`,
    caddy: `caddy:2@sha256:${digest("6")}`,
    cloudflared: `cloudflare/cloudflared:2025.7.0@sha256:${digest("7")}`
  };
  const releaseEnv = [
    `QUOTEOPS_VERSION=${version}`,
    "QUOTEOPS_PLATFORM=linux/amd64",
    `QUOTEOPS_AGENT_IMAGE=${images.agent}`,
    `QUOTEOPS_API_IMAGE=${images.api}`,
    `QUOTEOPS_WEB_IMAGE=${images.web}`,
    `QUOTEOPS_POSTGRES_IMAGE=${images.postgres}`,
    `QUOTEOPS_REDIS_IMAGE=${images.redis}`,
    `QUOTEOPS_CADDY_IMAGE=${images.caddy}`,
    `QUOTEOPS_CLOUDFLARED_IMAGE=${images.cloudflared}`,
    ""
  ].join("\n");
  const files = {
    "install.sh": "#!/usr/bin/env bash\nset -euo pipefail\n",
    "release.env": releaseEnv
  };
  const manifest = {
    schema_version: 1 as const,
    version,
    git_sha: "b".repeat(40),
    platform: "linux/amd64" as const,
    images,
    files_sha256: Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [name, sha256(bytes)])
    ),
    created_at: "2026-06-25T12:00:00.000Z"
  };
  const manifestBytes = Buffer.from(
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  const payload = {
    ...files,
    "release.json": manifestBytes
  };
  const payloadSums =
    Object.entries(payload)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, bytes]) => `${sha256(bytes)}  ${name}`)
      .join("\n") + "\n";
  const pack = tar.pack();
  const archivePromise = collectReadable(pack);
  for (const [name, bytes] of Object.entries({
    ...payload,
    PAYLOAD_SHA256SUMS: payloadSums
  }).sort(([left], [right]) => left.localeCompare(right))) {
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name,
          mode: name.endsWith(".sh") ? 0o755 : 0o644,
          uid: 0,
          gid: 0
        },
        bytes,
        (error) => (error ? reject(error) : resolve())
      );
    });
  }
  pack.finalize();
  const archiveBytes = gzipSync(await archivePromise);
  return {
    version,
    notes,
    bundle_sha256: sha256(archiveBytes),
    manifest,
    manifest_bytes: manifestBytes,
    archive_bytes: archiveBytes,
    published_at: "2026-06-25T12:00:00.000Z"
  };
}

async function collectReadable(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function registerTestApp(kind: "appliance" | "cloud", app: TestExpressApp): string {
  installFetchRouter();
  const baseUrl = `https://quoteops-${kind}-${++nextTestAppId}.test`;
  testApps.set(baseUrl, app);
  (kind === "appliance" ? applianceOrigins : cloudOrigins).add(baseUrl);
  return baseUrl;
}

function installFetchRouter(): void {
  if (fetchRouterInstalled) return;
  globalThis.fetch = routedFetch;
  fetchRouterInstalled = true;
}

function restoreNativeFetch(): void {
  if (!fetchRouterInstalled) return;
  globalThis.fetch = nativeFetch;
  fetchRouterInstalled = false;
}

const routedFetch: typeof fetch = async (input, init) => {
  const requestUrl = new URL(input instanceof Request ? input.url : String(input));
  const app = testApps.get(requestUrl.origin);
  if (!app) {
    return nativeFetch(input, init);
  }

  return directAppFetch(app, new Request(input, init));
};

async function directAppFetch(app: TestExpressApp, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const payload = Buffer.from(await request.arrayBuffer());
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const req = Readable.from(payload.length > 0 ? [payload] : []) as unknown as IncomingMessage;
  const headers = Object.fromEntries(request.headers.entries());
  if (payload.length > 0 && headers["content-length"] === undefined) {
    headers["content-length"] = String(payload.length);
  }
  Object.assign(req, {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    socket,
    connection: socket,
    httpVersion: "1.1",
    httpVersionMajor: 1,
    httpVersionMinor: 1,
    complete: true,
    headers: {
      host: url.host,
      ...headers
    },
    rawHeaders: Object.entries(headers).flatMap(([name, value]) => [name, value])
  });

  const res = new ServerResponse(req);
  res.assignSocket(socket as never);
  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.write = ((chunk: unknown, ...args: unknown[]) => {
    if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk as never));
    return originalWrite(chunk as never, ...(args as never[]));
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...args: unknown[]) => {
    if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk as never));
    return originalEnd(chunk as never, ...(args as never[]));
  }) as typeof res.end;

  const finished = new Promise<void>((resolve, reject) => {
    res.once("finish", resolve);
    res.once("error", reject);
  });
  app(req, res);
  await finished;

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(res.getHeaders())) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(name, item);
    } else if (value !== undefined) {
      responseHeaders.set(name, String(value));
    }
  }
  const responseBody = Buffer.concat(chunks);
  return new Response(responseBody.length > 0 ? responseBody : null, {
    status: res.statusCode,
    statusText: res.statusMessage,
    headers: responseHeaders
  });
}

function clearApplianceTestApps(): void {
  for (const origin of applianceOrigins) testApps.delete(origin);
  applianceOrigins.clear();
}

function clearTestApps(): void {
  testApps.clear();
  applianceOrigins.clear();
  cloudOrigins.clear();
}

async function waitForCloudHeartbeat(cloudBaseUrl: string): Promise<Record<string, any>> {
  let installation: Record<string, any> | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await fetch(`${cloudBaseUrl}/api/admin/clients`, {
      headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` }
    });
    const body = await response.json();
    installation = body.items?.[0]?.installation;
    if (installation?.last_heartbeat_at) {
      return installation;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Cloud never received a heartbeat: ${JSON.stringify(installation ?? null)}`);
}

function ensureDefaultLicensedEnvForApiTest(): void {
  if (
    process.env.QUOTEOPS_LICENSE_JSON ||
    process.env.QUOTEOPS_LICENSE_PATH ||
    process.env.QUOTEOPS_SIGNED_LICENSE_PATH ||
    process.env.QUOTEOPS_LICENSE_FILE
  ) {
    return;
  }

  const keys = [
    "QUOTEOPS_INSTALLATION_ID",
    "QUOTEOPS_LICENSE_JSON",
    "QUOTEOPS_LICENSE_PUBLIC_KEY_PEM"
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const installationId = process.env.QUOTEOPS_INSTALLATION_ID ?? "cliente-demo-prod-001";
  const keyPair = generateLicenseKeyPair();
  const license = createInstallationLicense({
    client_id: "cliente-demo",
    installation_id: installationId,
    release_channel: "stable",
    features: ["rfq_processing"],
    issued_at: "2026-06-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    private_key_pem: keyPair.private_key_pem
  });

  process.env.QUOTEOPS_INSTALLATION_ID = installationId;
  process.env.QUOTEOPS_LICENSE_JSON = JSON.stringify(license);
  process.env.QUOTEOPS_LICENSE_PUBLIC_KEY_PEM = keyPair.public_key_pem;

  testEnvRestores.push(() => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

let readyEnvDir: string | null = null;

async function setupReadyEnv(
  overrides: Record<string, string> = {}
): Promise<Record<string, string>> {
  const keyPair = generateLicenseKeyPair();
  const license = createInstallationLicense({
    client_id: "cliente-demo",
    installation_id: "cliente-demo-prod-001",
    release_channel: "stable",
    features: ["rfq_processing"],
    issued_at: "2026-06-01T00:00:00.000Z",
    expires_at: "2099-01-01T00:00:00.000Z",
    private_key_pem: keyPair.private_key_pem
  });

  if (!readyEnvDir) {
    readyEnvDir = await mkdtemp(join(tmpdir(), "quoteops-ready-env-"));
    tempDirs.push(readyEnvDir);
    await writeFile(join(readyEnvDir, "tms-adapter.yaml"), "provider: file_import\n");
    await writeFile(
      join(readyEnvDir, "agent-config.yaml"),
      [
        "model:",
        "  provider: openrouter",
        "  model_name: nvidia/nemotron-3-ultra-550b-a55b:free",
        "  temperature: 0",
        "  api_key_env: OPENROUTER_API_KEY",
        "authorization:",
        "  tools: {}",
        "mailbox:",
        "  provider: imap",
        "  auth: password",
        "  imap_host: imap.cliente.com",
        "embeddings:",
        "  provider: openai_compatible",
        "  model: text-embedding-3-small",
        "  api_key_env: QUOTEOPS_EMBEDDING_API_KEY",
        ""
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(readyEnvDir, "appliance-secrets-credential.json"),
      JSON.stringify({ schema_version: 1, credential_revision: 1 })
    );
    await writeFile(
      join(readyEnvDir, "mailbox-probe.json"),
      JSON.stringify({
        schema_version: 1,
        provider: "imap",
        status: "ok",
        agent_config_sha256: createHash("sha256")
          .update(await readFile(join(readyEnvDir, "agent-config.yaml")))
          .digest("hex"),
        credential_revision: 1,
        validated_at: "2026-07-01T00:00:00.000Z",
        code: "authenticated_read_only"
      })
    );
    await mkdir(join(readyEnvDir, "knowledge"), { recursive: true });
    await writeFile(join(readyEnvDir, "knowledge", "criterios.md"), "# criterios\n");
  }

  return {
    QUOTEOPS_INSTALLATION_ID: "cliente-demo-prod-001",
    QUOTEOPS_LICENSE_JSON: JSON.stringify(license),
    QUOTEOPS_LICENSE_PUBLIC_KEY_PEM: keyPair.public_key_pem,
    QUOTEOPS_SECRETS_ENV_FILE: "/tmp/quoteops-client.env",
    INEGI_SAKBE_KEY: "sakbe-present",
    OPENROUTER_API_KEY: "openrouter-present",
    QUOTEOPS_EMBEDDING_API_KEY: "embedding-present",
    TMS_API_KEY: "tms-present",
    MAILBOX_USER: "agente@cliente.com",
    MAILBOX_PASSWORD: "mailbox-present",
    MAILBOX_FROM: "",
    RESEND_API_KEY: "",
    QUOTEOPS_AGENT_CONFIG_PATH: join(readyEnvDir, "agent-config.yaml"),
    QUOTEOPS_TMS_ADAPTER_CONFIG_PATH: join(readyEnvDir, "tms-adapter.yaml"),
    QUOTEOPS_KNOWLEDGE_DIR: join(readyEnvDir, "knowledge"),
    QUOTEOPS_MAILBOX_PROBE_RECEIPT_PATH: join(
      readyEnvDir,
      "mailbox-probe.json"
    ),
    QUOTEOPS_APPLIANCE_CREDENTIAL_REVISION_PATH: join(
      readyEnvDir,
      "appliance-secrets-credential.json"
    ),
    ...overrides
  };
}

async function withEnv(
  values: Record<string, string>,
  callback: () => Promise<void>
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function waitForWorkflow(baseUrl: string, runId: string): Promise<Record<string, any>> {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/rfqs/${runId}`);
    const snapshot = await response.json();
    if (snapshot.node_status?.audit || snapshot.base_quote || snapshot.approval_state?.required) {
      return snapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`workflow ${runId} did not complete`);
}

function reviewRouteTools(): QuoteWorkflowInput["tools"] {
  return {
    ...workflowInput.tools,
    resolveRoute: async () => ({
      status: "missing",
      source: "sakbe",
      km_loaded: null,
      estimated_minutes: null,
      tolls_mxn: null,
      requires_return_route: false
    })
  };
}

function reviewWorkflowInput(runId: string): QuoteWorkflowInput {
  return {
    ...workflowInput,
    run_id: runId,
    raw_rfq: {
      ...workflowInput.raw_rfq,
      parsed: {
        ...workflowInput.raw_rfq.parsed,
        lanes: [
          {
            ...workflowInput.raw_rfq.parsed.lanes[0]!,
            cargo: {
              ...workflowInput.raw_rfq.parsed.lanes[0]!.cargo,
              weight_kg: null
            },
            confidence: {
              overall: 0.7,
              missing_fields: ["weight_kg"],
              review_reasons: ["weight_kg_missing"]
            }
          }
        ]
      }
    }
  };
}

const workflowInput: QuoteWorkflowInput = {
  run_id: "RUN-API-001",
  client_id: "cliente-demo",
  manifest_version: "manifest-2026.06.16.1",
  criteria_version: "criteria-2026.06.16.1",
  connector_versions: { tms: "cliente-demo.tms.primary@1.0.0" },
  raw_rfq: {
    rfq_id: "RFQ-2026-000001",
    source: "email",
    received_at: "2026-06-16T15:00:00-06:00",
    requester: { name: "Compras", email: "compras@cliente.com", company_alias: "Cliente" },
    raw: { subject: "Cotizacion", body: "Monterrey a Saltillo", attachments: [] },
    parsed: {
      lanes: [
        {
          lane_id: "RFQ-2026-000001-L01",
          origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
          destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
          equipment_request: "caja seca 53",
          vehicle_profile_id: "T3S2_53_DRYVAN",
          cargo: {
            commodity: "autopartes",
            commodity_category: "industrial",
            sector: "manufactura",
            weight_kg: 12000,
            value_mxn: 250000,
            hazmat: false,
            temperature_controlled: false
          },
          service: { return_policy: "sin_retorno", route_policy: "cuota", requested_pickup_at: null },
          commercial: {
            target_rate_mxn: null,
            customer_id: "CUST-1",
            customer_type: "industrial",
            business_unit_id: "general"
          },
          confidence: { overall: 0.9, missing_fields: [], review_reasons: [] }
        }
      ]
    }
  },
  manifest: {
    client_id: "cliente-demo",
    business_units: [{ business_unit_id: "general", requester_email_domains: ["cliente.com"], default: true }],
    vehicle_profiles: [
      {
        vehicle_profile_id: "T3S2_53_DRYVAN",
        business_unit_id: "general",
        payload_capacity_kg: 24000,
        fuel_loaded_km_per_l: 3,
        fuel_empty_km_per_l: 3.4,
        operator_cost_per_km_mxn: 2.5,
        pricing_model: "formula",
        diesel_price_mxn_per_liter: 24,
        margin_target_pct: 0.25,
        minimum_margin_pct: 0.18,
        maintenance_per_km_mxn: 2,
        tires_per_km_mxn: 1.25,
        fixed_overhead_per_km_mxn: 1,
        depreciation_per_km_mxn: 1.5,
        insurance_rate: 0.002,
        insurance_min_mxn: 500
      }
    ],
    route_policy: { sakbe_required: true }
  },
  criteria_nodes: [],
  tools: {
    resolveRoute: async () => ({
      status: "resolved",
      source: "sakbe",
      km_loaded: 80,
      estimated_minutes: 85,
      tolls_mxn: 600,
      requires_return_route: false
    }),
    searchHistorical: async () => ({ selected_layer: "route_unit_cost", median_rate_mxn: 19000 }),
    recommend: async ({ base_rate_mxn }) => ({
      recommended_rate_mxn: base_rate_mxn,
      reason: "Keep quote-core base rate."
    }),
    writeback: async () => ({ status: "written", quote_id: "QUOTE-1" })
  }
};
