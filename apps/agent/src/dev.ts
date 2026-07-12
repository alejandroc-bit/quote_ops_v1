import type { QuoteManifest } from "@quoteops/quote-core";
import { createQuoteAgentRuntime, type StructuredChatModel } from "./graph/index.js";

const replies: unknown[] = [
  { kind: "single", unit_type_hints: ["DEV_DRYVAN"], confidence: 0.95 },
  {
    lanes: [
      {
        origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
        destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
        equipment_text: "caja seca",
        weight_kg: 10000,
        commodity: "fixture",
        value_mxn: 100000,
        hazmat: false,
        target_rate_mxn: null
      }
    ]
  },
  { quality: "good", relevance_notes: "fixture comparables" },
  { suggested_rate_mxn: 2500, reason: "fixture annotation" }
];

const model: StructuredChatModel = {
  withStructuredOutput: (schema) => ({
    invoke: async () => schema.parse(replies.shift())
  })
};

const manifest: QuoteManifest = {
  client_id: "dev-client",
  business_units: [{ business_unit_id: "general", default: true }],
  vehicle_profiles: [
    {
      vehicle_profile_id: "DEV_DRYVAN",
      business_unit_id: "general",
      keywords: ["caja seca"],
      payload_capacity_kg: 25000,
      fuel_loaded_km_per_l: 2.5,
      fuel_empty_km_per_l: 3,
      operator_cost_per_km_mxn: 3,
      pricing_model: "formula",
      diesel_price_mxn_per_liter: 25,
      margin_target_pct: 0.2,
      minimum_margin_pct: 0.1
    }
  ],
  route_policy: { sakbe_required: true }
};

const runs = new Map<string, { status: string }>();
const devSteps: import("./graph/types.js").StepEvent[] = [];
const runtime = await createQuoteAgentRuntime({
  manifest,
  model,
  store: {
    async createRun(run) { runs.set(run.run_id, { status: run.status }); },
    async updateRunStatus(runId, status) { runs.set(runId, { status }); },
    async appendStep(step) {
      devSteps.push(step);
      console.log(`[dev-step] ${step.seq} ${step.node}:${step.status}`);
    },
    async getSteps(runId) { return devSteps.filter((step) => step.run_id === runId); },
    async getRun(runId) {
      const run = runs.get(runId);
      return run
        ? { run_id: runId, status: run.status as "running" | "waiting_approval" | "done" | "error" }
        : null;
    },
    async claimRunForResume(runId) {
      const run = runs.get(runId);
      if (!run || run.status !== "waiting_approval") return false;
      runs.set(runId, { status: "running" });
      return true;
    }
  },
  tools: {
    async resolveRoute() {
      return {
        status: "resolved",
        source: "sakbe",
        km_loaded: 100,
        estimated_minutes: 90,
        tolls_mxn: 500,
        requires_return_route: false
      };
    },
    async searchHistorical() {
      return {
        selected_layer: "route_unit_cost",
        min_rate_mxn: 1,
        max_rate_mxn: 100000,
        comparables: [{ layer: "route_unit_cost", sample_size: 5 }]
      };
    },
    async recommend({ base_rate_mxn }) {
      return { recommended_rate_mxn: base_rate_mxn, reason: "legacy seam" };
    },
    async writeback({ quote }) {
      console.log(`[dev-writeback] ${quote.quote_id}`);
      return { status: "written", quote_id: quote.quote_id };
    },
    async getUnits() {
      return [{ unit_id: "DEV_DRYVAN", current_lat: 25.68, current_lng: -100.31, status: "Available" }];
    }
  },
  channels: {
    email: { async send(input) { console.log(`[dev-email] ${input.to} ${input.attachments?.[0]?.filename}`); } },
    whatsapp: { async send(input) { console.log(`[dev-whatsapp] ${input.to}`); } }
  },
  env: {},
  now: () => new Date("2026-07-12T12:00:00.000Z")
});

const result = await runtime.invoke({
  run_id: "dev-run-001",
  channel: "email",
  message: {
    message_id: "dev-message-001",
    from_name: "Dev Requester",
    from_email: "requester@example.com",
    subject: "Cotizacion caja seca",
    body_text: "Monterrey a Saltillo en caja seca",
    received_at: "2026-07-12T12:00:00.000Z",
    attachments: []
  }
});

console.log(`[dev-result] run=${result.run_id} status=${runs.get(result.run_id)?.status}`);
