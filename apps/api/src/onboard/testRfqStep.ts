import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { atomicWriteJson } from "./onboardConfig.js";
import {
  OnboardingError,
  type OnboardingContext,
  type OnboardingPhase
} from "./onboardingFlow.js";
import { ONBOARD_INTERNAL_API_ORIGIN } from "./licenseActivationStep.js";

export const readinessRfqRequest = {
  origin_city: "Guadalajara",
  origin_state: "Jalisco",
  destination_city: "Monterrey",
  destination_state: "Nuevo Leon",
  equipment_request: "caja seca 53",
  vehicle_profile_id: "T3S3_53_DRYVAN",
  weight_kg: 18000,
  commodity: "general",
  sector: "industrial",
  value_mxn: 250000,
  business_unit_id: "general"
} as const;

export type TestRfqReceipt = {
  schema_version: 1;
  run_id: string;
  request_sha256: string;
  state: "submitted" | "complete";
  submitted_at: string;
  completed_at?: string;
  base_quote_status?: "APPROVED";
  approval_required?: false;
};

const testRfqReceiptSchema: z.ZodType<TestRfqReceipt> = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().min(1),
    request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(["submitted", "complete"]),
    submitted_at: z.string().datetime(),
    completed_at: z.string().datetime().optional(),
    base_quote_status: z.literal("APPROVED").optional(),
    approval_required: z.literal(false).optional()
  })
  .strict();

const TEST_RFQ_HASH_VERSION = "quoteops-readiness-rfq-v1";

export function requestSha256ForReadinessRfq(): string {
  return createHash("sha256")
    .update(`${TEST_RFQ_HASH_VERSION}\n${JSON.stringify(readinessRfqRequest)}`)
    .digest("hex");
}

export function deterministicReadinessRunId(installationId: string): string {
  const digest = createHash("sha256")
    .update(
      `${TEST_RFQ_HASH_VERSION}\n${installationId}\n${requestSha256ForReadinessRfq()}`
    )
    .digest("hex")
    .slice(0, 24)
    .toUpperCase();
  return `RUN-READINESS-${digest}`;
}

export async function runTestRfqPhase(
  context: OnboardingContext,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {}
): Promise<TestRfqReceipt> {
  assertFixedInternalOrigin(context);
  const installationId = requiredInstallationId(context);
  const requestSha256 = requestSha256ForReadinessRfq();
  const runId = deterministicReadinessRunId(installationId);
  const now = context.now ?? (() => new Date());
  let receipt = await loadReceipt(context, runId, requestSha256);

  if (!receipt) {
    receipt = {
      schema_version: 1,
      run_id: runId,
      request_sha256: requestSha256,
      state: "submitted",
      submitted_at: now().toISOString()
    };
    await atomicWriteJson(context.paths.testRfqReceiptFile, receipt, {
      mode: 0o600,
      afterRename: () => context.afterAtomicRename?.("test_rfq_submitted")
    });
  }

  let response = await getTestRfq(context.fetch, runId);
  if (response.status === 404) {
    await submitTestRfq(context.fetch, receipt);
    response = await getTestRfq(context.fetch, runId);
  }

  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (response.ok) {
      const run = await response.json().catch(() => null);
      if (hasPassingTestRfq(run)) {
        const complete: TestRfqReceipt = {
          ...receipt,
          state: "complete",
          completed_at: now().toISOString(),
          base_quote_status: "APPROVED",
          approval_required: false
        };
        await atomicWriteJson(context.paths.testRfqReceiptFile, complete, {
          mode: 0o600,
          afterRename: () => context.afterAtomicRename?.("test_rfq_complete")
        });
        return complete;
      }
    } else if (response.status !== 404) {
      throw await safeTestRfqResponseError(response);
    }

    if (Date.now() >= deadline) {
      throw new OnboardingError("test_rfq_pending", { phase: "test_rfq" });
    }
    if (pollIntervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    response = await getTestRfq(context.fetch, runId);
  }
}

export const testRfqPhase: OnboardingPhase = {
  id: "test_rfq",
  async isComplete(context) {
    assertFixedInternalOrigin(context);
    const installationId = requiredInstallationId(context);
    const requestSha256 = requestSha256ForReadinessRfq();
    const runId = deterministicReadinessRunId(installationId);
    const receipt = await loadReceipt(context, runId, requestSha256);
    if (!receipt || receipt.state !== "complete") return false;
    const response = await getTestRfq(context.fetch, runId);
    if (response.status === 404) return false;
    if (!response.ok) throw await safeTestRfqResponseError(response);
    return hasPassingTestRfq(await response.json().catch(() => null));
  },
  async run(context) {
    await runTestRfqPhase(context);
  }
};

async function loadReceipt(
  context: OnboardingContext,
  expectedRunId: string,
  expectedRequestSha256: string
): Promise<TestRfqReceipt | null> {
  let body: string;
  try {
    body = await readFile(context.paths.testRfqReceiptFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new OnboardingError("test_rfq_receipt_invalid", {
      phase: "test_rfq",
      cause: error
    });
  }
  let receipt: TestRfqReceipt;
  try {
    receipt = testRfqReceiptSchema.parse(JSON.parse(body));
  } catch (error) {
    throw new OnboardingError("test_rfq_receipt_invalid", {
      phase: "test_rfq",
      cause: error
    });
  }
  if (
    receipt.run_id !== expectedRunId ||
    receipt.request_sha256 !== expectedRequestSha256
  ) {
    throw new OnboardingError("test_rfq_receipt_mismatch", {
      phase: "test_rfq"
    });
  }
  return receipt;
}

async function getTestRfq(fetchFn: typeof fetch, runId: string): Promise<Response> {
  try {
    return await fetchFn(
      new URL(`/api/rfqs/${encodeURIComponent(runId)}`, ONBOARD_INTERNAL_API_ORIGIN),
      { signal: AbortSignal.timeout(10_000) }
    );
  } catch (error) {
    throw new OnboardingError("test_rfq_unreachable", {
      phase: "test_rfq",
      cause: error
    });
  }
}

async function submitTestRfq(
  fetchFn: typeof fetch,
  receipt: TestRfqReceipt
): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(
      new URL("/api/playground/rfqs", ONBOARD_INTERNAL_API_ORIGIN),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...readinessRfqRequest,
          run_id: receipt.run_id,
          request_sha256: receipt.request_sha256
        }),
        signal: AbortSignal.timeout(10_000)
      }
    );
  } catch (error) {
    throw new OnboardingError("test_rfq_unreachable", {
      phase: "test_rfq",
      cause: error
    });
  }
  if (!response.ok && response.status !== 409) {
    throw await safeTestRfqResponseError(response);
  }
  if (response.status === 409) {
    throw await safeTestRfqResponseError(response);
  }
}

function hasPassingTestRfq(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  const baseQuote =
    run.base_quote && typeof run.base_quote === "object"
      ? (run.base_quote as Record<string, unknown>)
      : null;
  const routeEvidence =
    run.route_evidence && typeof run.route_evidence === "object"
      ? (run.route_evidence as Record<string, unknown>)
      : null;
  const writeback =
    run.writeback_result && typeof run.writeback_result === "object"
      ? (run.writeback_result as Record<string, unknown>)
      : null;
  const nodeStatus =
    run.node_status && typeof run.node_status === "object"
      ? (run.node_status as Record<string, unknown>)
      : null;
  const priced =
    baseQuote?.status === "APPROVED" &&
    Object.values(baseQuote).some(
      (item) => typeof item === "number" && Number.isFinite(item)
    );
  const routeResolved =
    routeEvidence?.status === "resolved" ||
    (typeof run.route_source === "string" && run.route_source.length > 0);
  const writebackReady =
    writeback?.status === "written" ||
    writeback?.status === "skipped" ||
    nodeStatus?.writeback === "completed";
  return (
    priced &&
    run.approval_required === false &&
    run.status === "APPROVED" &&
    routeResolved &&
    writebackReady
  );
}

async function safeTestRfqResponseError(
  response: Response
): Promise<OnboardingError> {
  const body = await response.json().catch(() => null);
  const unsafeCode =
    body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).error === "string"
      ? String((body as Record<string, unknown>).error)
      : "test_rfq_failed";
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(unsafeCode)
    ? unsafeCode
    : "test_rfq_failed";
  return new OnboardingError(code, { phase: "test_rfq" });
}

function requiredInstallationId(context: OnboardingContext): string {
  const value = context.env.QUOTEOPS_INSTALLATION_ID?.trim();
  if (!value) {
    throw new OnboardingError("test_rfq_installation_id_missing", {
      phase: "test_rfq"
    });
  }
  return value;
}

function assertFixedInternalOrigin(context: OnboardingContext): void {
  const configured = context.env.QUOTEOPS_ONBOARD_API_URL;
  if (configured !== undefined && configured !== ONBOARD_INTERNAL_API_ORIGIN) {
    throw new OnboardingError("onboarding_api_origin_invalid", {
      exitCode: 2,
      phase: "test_rfq"
    });
  }
}
