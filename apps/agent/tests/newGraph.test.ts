import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { MemorySaver } from "@langchain/langgraph";
import { Readable } from "node:stream";
import { calculateQuote, type QuoteManifest } from "@quoteops/quote-core";
import { createInstallationLicense, generateLicenseKeyPair } from "@quoteops/shared";
import type { QuoteWorkflowTools } from "../src/state.js";
import type { IntakeEmail } from "../src/intake/extractRfq.js";
import {
  createQuoteAgentRuntime,
  type Channel,
  type StructuredChatModel
} from "../src/graph/index.js";
import { createInMemoryQuoteOpsStore } from "../../api/src/storage/InMemoryQuoteOpsStore.js";
import { createQuoteOpsApi } from "../../api/src/index.js";

class ScriptedChatModel implements StructuredChatModel {
  constructor(private readonly replies: unknown[]) {}

  withStructuredOutput<T>(schema: { parse(value: unknown): T }) {
    return {
      invoke: async () => {
        for (let index = 0; index < this.replies.length; index += 1) {
          try {
            const parsed = schema.parse(this.replies[index]);
            this.replies.splice(index, 1);
            return parsed;
          } catch {
            // Scripted calls may run concurrently after LangGraph Send fan-out.
          }
        }
        return schema.parse(undefined);
      }
    };
  }
}

class CapturingChannel implements Channel {
  readonly sent: Array<Parameters<Channel["send"]>[0]> = [];

  async send(message: Parameters<Channel["send"]>[0]): Promise<void> {
    this.sent.push(message);
  }
}

const manifest: QuoteManifest = {
  client_id: "NMX",
  business_units: [{ business_unit_id: "general", default: true }],
  vehicle_profiles: [
    {
      vehicle_profile_id: "T3S2_53_DRYVAN",
      business_unit_id: "general",
      keywords: ["caja seca"],
      payload_capacity_kg: 25000,
      fuel_loaded_km_per_l: 2.5,
      fuel_empty_km_per_l: 3,
      operator_cost_per_km_mxn: 3,
      pricing_model: "formula",
      diesel_price_mxn_per_liter: 25,
      margin_target_pct: 0.2,
      minimum_margin_pct: 0.1,
      maintenance_per_km_mxn: 1,
      tires_per_km_mxn: 0.5,
      fixed_overhead_per_km_mxn: 0.5,
      depreciation_per_km_mxn: 0.5,
      insurance_rate: 0,
      insurance_min_mxn: 0
    }
  ],
  route_policy: { sakbe_required: true }
};

function email(
  attachments: IntakeEmail["attachments"] = [],
  overrides: Partial<IntakeEmail> = {}
): IntakeEmail {
  return {
    message_id: "msg-1",
    from_name: "Compras",
    from_email: "compras@example.com",
    subject: "Cotizacion caja seca",
    body_text: "Monterrey, Nuevo Leon a Saltillo, Coahuila en caja seca",
    received_at: "2026-07-12T12:00:00.000Z",
    attachments,
    ...overrides
  };
}

function extractionReply() {
  return {
    lanes: [
      {
        origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
        destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
        equipment_text: "caja seca",
        weight_kg: 12000,
        commodity: "acero",
        value_mxn: 100000,
        hazmat: false,
        target_rate_mxn: null
      }
    ]
  };
}

function tools(options: { historical?: "good" | "none"; inoperableCity?: string } = {}) {
  const writebacks: string[] = [];
  const workflowTools: QuoteWorkflowTools = {
    resolveRoute: async () => ({
      status: "resolved",
      source: "sakbe",
      km_loaded: 100,
      estimated_minutes: 90,
      tolls_mxn: 500,
      requires_return_route: false
    }),
    searchHistorical: async (input) =>
      options.historical === "none" || input.rfq.origin.city === options.inoperableCity
        ? {
            selected_layer: "unavailable",
            insufficient_data: true,
            comparables: []
          }
        : {
            selected_layer: "route_unit_cost",
            min_rate_mxn: 1,
            median_rate_mxn: 10000,
            max_rate_mxn: 100000,
            insufficient_data: false,
            comparables: [{ layer: "route_unit_cost", sample_size: 5 }]
          },
    recommend: async ({ base_rate_mxn }) => ({
      recommended_rate_mxn: base_rate_mxn,
      reason: "legacy seam"
    }),
    writeback: async ({ quote }) => {
      writebacks.push(quote.quote_id);
      return { status: "written", quote_id: quote.quote_id };
    },
    getUnits: async () => [
      {
        unit_id: "T3S2_53_DRYVAN",
        current_lat: 25.68,
        current_lng: -100.31,
        status: "Available" as const
      }
    ],
    getAvailabilityZones: async () => [
      {
        zone_id: "zone-mty",
        city: "Monterrey",
        state: "Nuevo Leon",
        country: "MX",
        available_units: 2
      }
    ]
  };
  return { workflowTools, writebacks };
}

describe("new LangGraph quote runtime", () => {
  it("classifies text, completes an auto quote, traces steps, sends a PDF, and writes back", async () => {
    const store = createInMemoryQuoteOpsStore();
    const channel = new CapturingChannel();
    const { workflowTools, writebacks } = tools();
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: ["T3S2_53_DRYVAN"], confidence: 0.98 },
        extractionReply(),
        { quality: "good", relevance_notes: "same route and unit" },
        { suggested_rate_mxn: 999999, reason: "model annotation" }
      ]),
      store,
      channels: { email: channel, whatsapp: channel },
      env: { QUOTEOPS_APPROVER_EMAIL: "approver@example.com" }
    });

    const result = await runtime.invoke({
      run_id: "RUN-AUTO",
      channel: "email",
      message: email([], {
        subject: "Freight quote",
        rfc_message_id: "<rfq-123@example.com>",
        references: ["<older@example.com>"]
      })
    });
    const persisted = await store.getRun("RUN-AUTO");
    const steps = await store.getSteps("RUN-AUTO");

    expect(result.intake_kind).toBe("single");
    expect(result.recommendation[0]).toMatchObject({
      verdict: "auto",
      suggested_rate_mxn: 100000,
      clamped: true
    });
    expect(result.quotes[0].base_rate_mxn).not.toBe(100000);
    expect(result.response_sent).toBe(true);
    expect(writebacks).toEqual([result.quotes[0].quote_id]);
    expect(channel.sent[0].attachments?.[0].content.length).toBeGreaterThan(500);
    expect(channel.sent[0].subject).toBe("Re: Freight quote");
    expect(channel.sent[0].reply_to).toEqual({
      message_id: "<rfq-123@example.com>",
      references: ["<older@example.com>"],
      subject: "Freight quote"
    });
    expect(persisted?.status).toBe("done");
    expect(steps.some((step) => step.node === "quote" && step.status === "end")).toBe(true);
  });

  it("interrupts a review run and resumes approve without letting the model change quote-core", async () => {
    const store = createInMemoryQuoteOpsStore();
    const channel = new CapturingChannel();
    const { workflowTools, writebacks } = tools();
    workflowTools.searchHistorical = async () => ({
      selected_layer: "route_unit_cost",
      min_rate_mxn: 1,
      max_rate_mxn: 100,
      comparables: [{ layer: "route_unit_cost", sample_size: 3 }]
    });
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "good", relevance_notes: "old samples" },
        { suggested_rate_mxn: 50, reason: "model annotation" }
      ]),
      store,
      channels: { email: channel, whatsapp: channel },
      env: { QUOTEOPS_APPROVER_EMAIL: "approver@example.com" }
    });

    const interrupted = await runtime.invoke({
      run_id: "RUN-REVIEW",
      channel: "email",
      message: email()
    });
    expect(interrupted.response_sent).toBe(false);
    expect((await store.getRun("RUN-REVIEW"))?.status).toBe("waiting_approval");
    expect((await store.getSteps("RUN-REVIEW")).some((step) => step.status === "error")).toBe(false);

    const resumed = await runtime.resume("RUN-REVIEW", { action: "approve" });
    expect(resumed.response_sent).toBe(true);
    expect(writebacks).toEqual([resumed.quotes[0].quote_id]);
    expect(channel.sent).toHaveLength(1);
    expect((await store.getRun("RUN-REVIEW"))?.status).toBe("done");
  });

  it("interrupts unknown routes when historical quality is none", async () => {
    const store = createInMemoryQuoteOpsStore();
    const channel = new CapturingChannel();
    const { workflowTools } = tools({ historical: "none" });
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "none", relevance_notes: "no comparables" },
        { suggested_rate_mxn: 10, reason: "weak annotation" }
      ]),
      store,
      channels: { email: channel, whatsapp: channel }
    });

    const result = await runtime.invoke({ run_id: "RUN-UNKNOWN", channel: "email", message: email() });

    expect(result.recommendation[0].verdict).toBe("unknown_route");
    expect((await store.getRun("RUN-UNKNOWN"))?.status).toBe("waiting_approval");
    expect(channel.sent).toHaveLength(0);
  });

  it("classifies xlsx deterministically and quotes four of five rows after operability validation", async () => {
    const rows = ["Monterrey", "Apodaca", "Escobedo", "Guadalupe", "SinHistoria"].map(
      (origin, index) => ({
        origin_city: origin,
        origin_state: "Nuevo Leon",
        destination_city: `Destino ${index + 1}`,
        destination_state: "Coahuila",
        vehicle_profile_id: "T3S2_53_DRYVAN",
        equipment_text: "caja seca",
        commodity: "acero"
      })
    );
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "RFQs");
    const attachment = {
      filename: "rfqs.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))
    };
    const store = createInMemoryQuoteOpsStore();
    const channel = new CapturingChannel();
    const { workflowTools, writebacks } = tools({ inoperableCity: "SinHistoria" });
    workflowTools.getAvailabilityZones = async () => [];
    const modelReplies = Array.from({ length: 4 }, () => [
      { quality: "good", relevance_notes: "comparable" },
      { suggested_rate_mxn: 10000, reason: "annotation" }
    ]).flat();
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: workflowTools,
      model: new ScriptedChatModel(modelReplies),
      store,
      channels: { email: channel, whatsapp: channel }
    });

    const result = await runtime.invoke({
      run_id: "RUN-BULK",
      channel: "email",
      message: email([attachment])
    });

    expect(result.intake_kind).toBe("bulk_file");
    expect(result.lanes).toHaveLength(5);
    expect(result.inoperable).toHaveLength(1);
    expect(result.inoperable[0].lane.origin.city).toBe("SinHistoria");
    expect(result.quotes).toHaveLength(4);
    expect(writebacks).toHaveLength(0);
    expect((await store.getRun("RUN-BULK"))?.status).toBe("waiting_approval");
  });

  it("prompts for confirmation in the central third, then sends the PDF only after resume", async () => {
    const store = createInMemoryQuoteOpsStore();
    const channel = new CapturingChannel();
    const { workflowTools } = tools();
    workflowTools.searchHistorical = async (input) => {
      const rate = calculateQuote(input).base_rate_mxn;
      return {
        selected_layer: "route_unit_cost",
        min_rate_mxn: rate - 300,
        median_rate_mxn: rate,
        max_rate_mxn: rate + 300,
        comparables: [{ layer: "route_unit_cost", sample_size: 8 }]
      };
    };
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "good", relevance_notes: "central band" },
        { suggested_rate_mxn: 2500, reason: "annotation" }
      ]),
      store,
      channels: { email: channel, whatsapp: channel },
      env: { QUOTEOPS_APPROVER_EMAIL: "approver@example.com" }
    });

    const interrupted = await runtime.invoke({ run_id: "RUN-MID", channel: "email", message: email() });
    expect(interrupted.recommendation[0].verdict).toBe("needs_review");
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0].to).toBe("approver@example.com");
    expect(channel.sent[0].body_md.toLowerCase()).toContain("rango medio");
    expect(channel.sent[0].body_md).toContain("RUN-MID");
    expect(channel.sent[0].body_md).toContain("/api/approvals/RUN-MID/decision");
    expect(channel.sent[0].attachments).toBeUndefined();

    const restoreLicense = installTestLicense();
    const app = createQuoteOpsApi({ store, graphRuntime: runtime });
    const decision = await dispatchApi(app, "/api/approvals/RUN-MID/decision", { action: "approve" });
    restoreLicense();
    expect(decision.statusCode).toBe(200);
    expect(JSON.parse(decision.body).response_sent).toBe(true);
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1].to).toBe("compras@example.com");
    expect(channel.sent[1].attachments?.[0].content.length).toBeGreaterThan(500);
  });

  it("applies TMS performance before quote-core and fails review when opted-in performance is stale", async () => {
    const performanceManifest: QuoteManifest = structuredClone(manifest);
    performanceManifest.vehicle_profiles[0].performance_source = "tms";
    performanceManifest.vehicle_profiles[0].fuel_loaded_km_per_l = 1;
    performanceManifest.vehicle_profiles[0].fuel_empty_km_per_l = 1;

    const appliedStore = createInMemoryQuoteOpsStore();
    const appliedChannel = new CapturingChannel();
    const applied = tools();
    applied.workflowTools.getUnitPerformance = async () => [
      { unit_type: "T3S2_53_DRYVAN", kpl_yield: 5, real_cost_per_km: 14 }
    ];
    const appliedRuntime = await createQuoteAgentRuntime({
      manifest: performanceManifest,
      tools: applied.workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "good", relevance_notes: "same route" },
        { suggested_rate_mxn: 10000, reason: "annotation" }
      ]),
      store: appliedStore,
      channels: { email: appliedChannel, whatsapp: appliedChannel }
    });
    const appliedResult = await appliedRuntime.invoke({
      run_id: "RUN-PERFORMANCE",
      channel: "email",
      message: email()
    });
    const staticCost = calculateQuote({
      rfq: appliedResult.lanes[0],
      manifest: performanceManifest,
      route_evidence: {
        status: "resolved",
        source: "sakbe",
        km_loaded: 100,
        estimated_minutes: 90,
        tolls_mxn: 500,
        requires_return_route: false
      }
    }).direct_cost_mxn;
    expect(appliedResult.quotes[0].direct_cost_mxn).toBeLessThan(staticCost);

    const staleStore = createInMemoryQuoteOpsStore();
    const staleChannel = new CapturingChannel();
    const stale = tools();
    stale.workflowTools.getUnitPerformance = async () => [];
    const staleRuntime = await createQuoteAgentRuntime({
      manifest: performanceManifest,
      tools: stale.workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "good", relevance_notes: "same route" },
        { suggested_rate_mxn: 10000, reason: "annotation" }
      ]),
      store: staleStore,
      channels: { email: staleChannel, whatsapp: staleChannel }
    });
    const staleResult = await staleRuntime.invoke({
      run_id: "RUN-PERFORMANCE-STALE",
      channel: "email",
      message: email()
    });
    expect(staleResult.quotes[0].status).toBe("REVIEW_REQUIRED");
    expect(staleResult.quotes[0].review_reasons).toContain("tms_performance_stale");
    expect((await staleStore.getRun("RUN-PERFORMANCE-STALE"))?.status).toBe("waiting_approval");
  });

  it("continues step sequence across a new runtime instance and never overwrites persisted steps", async () => {
    const store = createInMemoryQuoteOpsStore();
    const checkpointer = new MemorySaver();
    const channel = new CapturingChannel();
    const firstTools = tools();
    firstTools.workflowTools.searchHistorical = async () => ({
      selected_layer: "route_unit_cost",
      min_rate_mxn: 1,
      max_rate_mxn: 100,
      comparables: [{ layer: "route_unit_cost", sample_size: 3 }]
    });
    const runtime1 = await createQuoteAgentRuntime({
      manifest,
      tools: firstTools.workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "good", relevance_notes: "review" },
        { suggested_rate_mxn: 50, reason: "annotation" }
      ]),
      store,
      channels: { email: channel, whatsapp: channel },
      checkpointer
    });
    await runtime1.invoke({ run_id: "RUN-RESTART", channel: "email", message: email() });
    const before = await store.getSteps("RUN-RESTART");

    const runtime2 = await createQuoteAgentRuntime({
      manifest,
      tools: firstTools.workflowTools,
      model: new ScriptedChatModel([]),
      store,
      channels: { email: channel, whatsapp: channel },
      checkpointer
    });
    await runtime2.resume("RUN-RESTART", { action: "approve" });
    const after = await store.getSteps("RUN-RESTART");

    expect(after.length).toBeGreaterThan(before.length);
    expect(new Set(after.map((step) => step.seq)).size).toBe(after.length);
    expect(Math.min(...after.slice(before.length).map((step) => step.seq))).toBeGreaterThan(
      Math.max(...before.map((step) => step.seq))
    );
  });

  it("records real node errors in checkpointed state", async () => {
    const store = createInMemoryQuoteOpsStore();
    const channel = new CapturingChannel();
    const broken = tools();
    broken.workflowTools.resolveRoute = async () => { throw new Error("route offline"); };
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: broken.workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply()
      ]),
      store,
      channels: { email: channel, whatsapp: channel }
    });

    await expect(runtime.invoke({ run_id: "RUN-ERROR", channel: "email", message: email() }))
      .rejects.toThrow("route offline");
    const state = await runtime.getState("RUN-ERROR");
    expect(state.steps.some((step) => step.node === "resolve" && step.status === "error")).toBe(true);
    expect((await store.getRun("RUN-ERROR"))?.status).toBe("error");
  });

  it("fails closed after approval when every bulk lane is inoperable", async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          origin_city: "Sin Historia",
          origin_state: "Nuevo Leon",
          destination_city: "Destino",
          destination_state: "Coahuila",
          vehicle_profile_id: "T3S2_53_DRYVAN",
          equipment_text: "caja seca"
        }
      ]),
      "RFQs"
    );
    const attachment = {
      filename: "all-inoperable.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      content: Buffer.from(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))
    };
    const store = createInMemoryQuoteOpsStore();
    const channel = new CapturingChannel();
    const noHistory = tools({ historical: "none" });
    noHistory.workflowTools.getAvailabilityZones = async () => [];
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: noHistory.workflowTools,
      model: new ScriptedChatModel([]),
      store,
      channels: { email: channel, whatsapp: channel }
    });

    await runtime.invoke({ run_id: "RUN-ALL-INOPERABLE", channel: "email", message: email([attachment]) });
    const resumed = await runtime.resume("RUN-ALL-INOPERABLE", { action: "approve" });

    expect(resumed.terminal_blocker).toBe("all_lanes_inoperable");
    expect(resumed.response_sent).toBe(false);
    expect(channel.sent).toHaveLength(0);
    expect((await store.getRun("RUN-ALL-INOPERABLE"))?.status).toBe("error");
  });

  it("marks resume side-effect failures as error and rejects duplicate approval without repeating send", async () => {
    const store = createInMemoryQuoteOpsStore();
    const sent: Array<Parameters<Channel["send"]>[0]> = [];
    const channel: Channel = {
      async send(input) {
        sent.push(input);
        if (input.attachments?.length) throw new Error("smtp unavailable");
      }
    };
    const reviewTools = tools();
    reviewTools.workflowTools.searchHistorical = async (input) => {
      const rate = calculateQuote(input).base_rate_mxn;
      return {
        selected_layer: "route_unit_cost",
        min_rate_mxn: rate - 300,
        max_rate_mxn: rate + 300,
        comparables: [{ layer: "route_unit_cost", sample_size: 8 }]
      };
    };
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: reviewTools.workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "good", relevance_notes: "central" },
        { suggested_rate_mxn: 2500, reason: "annotation" }
      ]),
      store,
      channels: { email: channel, whatsapp: channel },
      env: { QUOTEOPS_APPROVER_EMAIL: "approver@example.com" }
    });
    await runtime.invoke({ run_id: "RUN-SMTP-FAIL", channel: "email", message: email() });

    await expect(runtime.resume("RUN-SMTP-FAIL", { action: "approve" })).rejects.toThrow(
      "smtp unavailable"
    );
    expect((await store.getRun("RUN-SMTP-FAIL"))?.status).toBe("error");
    expect((await runtime.getState("RUN-SMTP-FAIL")).steps)
      .toContainEqual(expect.objectContaining({ node: "respond", status: "error" }));
    await expect(runtime.resume("RUN-SMTP-FAIL", { action: "approve" })).rejects.toThrow(
      "run_not_waiting_approval"
    );
    expect(sent).toHaveLength(2);
  });

  it("persists error when restart-safe sequence loading fails after resume claim", async () => {
    const baseStore = createInMemoryQuoteOpsStore();
    let failStepRead = false;
    const store = {
      ...baseStore,
      async getSteps(runId: string) {
        if (failStepRead) throw new Error("step store unavailable");
        return baseStore.getSteps(runId);
      }
    };
    const channel = new CapturingChannel();
    const review = tools();
    review.workflowTools.searchHistorical = async () => ({
      selected_layer: "route_unit_cost",
      min_rate_mxn: 1,
      max_rate_mxn: 100,
      comparables: [{ layer: "route_unit_cost", sample_size: 3 }]
    });
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools: review.workflowTools,
      model: new ScriptedChatModel([
        { kind: "single", unit_type_hints: [], confidence: 0.9 },
        extractionReply(),
        { quality: "good", relevance_notes: "review" },
        { suggested_rate_mxn: 50, reason: "annotation" }
      ]),
      store,
      channels: { email: channel, whatsapp: channel }
    });
    await runtime.invoke({ run_id: "RUN-STEP-FAIL", channel: "email", message: email() });
    failStepRead = true;

    await expect(runtime.resume("RUN-STEP-FAIL", { action: "approve" })).rejects.toThrow(
      "step store unavailable"
    );
    expect((await baseStore.getRun("RUN-STEP-FAIL"))?.status).toBe("error");
  });
});

function installTestLicense(): () => void {
  const keys = [
    "QUOTEOPS_CLIENT_ID",
    "QUOTEOPS_INSTALLATION_ID",
    "QUOTEOPS_LICENSE_JSON",
    "QUOTEOPS_LICENSE_PUBLIC_KEY_PEM",
    "QUOTEOPS_LICENSE_PATH",
    "QUOTEOPS_LICENSE_PUBLIC_KEY_PATH"
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const pair = generateLicenseKeyPair();
  process.env.QUOTEOPS_CLIENT_ID = "NMX";
  process.env.QUOTEOPS_INSTALLATION_ID = "nmx-test-install";
  process.env.QUOTEOPS_LICENSE_JSON = JSON.stringify(
    createInstallationLicense({
      client_id: "NMX",
      installation_id: "nmx-test-install",
      release_channel: "test",
      features: ["quotes"],
      issued_at: "2026-01-01T00:00:00.000Z",
      expires_at: "2030-01-01T00:00:00.000Z",
      private_key_pem: pair.private_key_pem
    })
  );
  process.env.QUOTEOPS_LICENSE_PUBLIC_KEY_PEM = pair.public_key_pem;
  delete process.env.QUOTEOPS_LICENSE_PATH;
  delete process.env.QUOTEOPS_LICENSE_PUBLIC_KEY_PATH;
  return () => {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function dispatchApi(
  app: ReturnType<typeof createQuoteOpsApi>,
  url: string,
  body: unknown
): Promise<{ statusCode: number; body: string }> {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as Readable & Record<string, unknown>;
  req.method = "POST";
  req.url = url;
  req.headers = { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)) };
  req.connection = {};
  req.socket = {};
  const chunks: Buffer[] = [];
  let done!: () => void;
  const ended = new Promise<void>((resolve) => { done = resolve; });
  const headers = new Map<string, unknown>();
  const res = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    setHeader(name: string, value: unknown) { headers.set(name.toLowerCase(), value); },
    getHeader(name: string) { return headers.get(name.toLowerCase()); },
    getHeaders() { return Object.fromEntries(headers); },
    removeHeader(name: string) { headers.delete(name.toLowerCase()); },
    writeHead(statusCode: number) { this.statusCode = statusCode; this.headersSent = true; return this; },
    write(chunk: unknown) { chunks.push(Buffer.from(String(chunk))); return true; },
    end(chunk?: unknown) {
      if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      this.writableEnded = true;
      done();
      return this;
    },
    on() { return this; },
    once() { return this; },
    emit() { return true; }
  } as unknown as import("node:http").ServerResponse;
  app.handle(req as never, res as never);
  await ended;
  return { statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") };
}
