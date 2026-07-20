import { describe, expect, it } from "vitest";
import type { AgentRuntimeConfig } from "@quoteops/connectors";
import type { QuoteManifest } from "@quoteops/quote-core";
import { createInMemoryQuoteOpsStore } from "../../api/src/storage/InMemoryQuoteOpsStore.js";
import type { QuoteWorkflowTools } from "../src/state.js";
import type { IntakeEmail } from "../src/intake/extractRfq.js";
import type { MailboxOutcome, MailboxSource } from "../src/intake/mailbox.js";
import {
  createQuoteAgentRuntime,
  type Channel,
  type StructuredChatModel
} from "../src/graph/index.js";
import {
  buildIntakeModel,
  createSerializedMailboxPoll,
  runMailboxIntakeOnce
} from "../src/intake/mailboxPoller.js";

const baseConfig: AgentRuntimeConfig = {
  model: { provider: "deterministic", model_name: "x", temperature: 0, api_key_env: null, base_url: null },
  authorization: { approver_email: null, allowed_domains: [], whatsapp_approver_phone: null, tools: {} },
  mailbox: null,
  embeddings: null
};

describe("buildIntakeModel", () => {
  it("returns a callable model for provider 'openai' with an OpenAI-compatible base_url (e.g. NVIDIA NIM)", () => {
    // Regression: this provider used to fall through to `return null`, which
    // surfaced as "text and image RFQ extraction requires an AI model
    // provider in agent-config" for every mailbox-triggered RFQ.
    const config: AgentRuntimeConfig = {
      ...baseConfig,
      model: {
        provider: "openai",
        model_name: "meta/llama-3.1-70b-instruct",
        temperature: 0,
        api_key_env: "NVIDIA_NIM_API_KEY",
        base_url: "https://integrate.api.nvidia.com/v1"
      }
    };
    const model = buildIntakeModel(config, { NVIDIA_NIM_API_KEY: "nvapi-test" }, fetch);
    expect(typeof model).toBe("function");
  });

  it("returns null for provider 'openai' when the configured api key env var is unset", () => {
    const config: AgentRuntimeConfig = {
      ...baseConfig,
      model: {
        provider: "openai",
        model_name: "meta/llama-3.1-70b-instruct",
        temperature: 0,
        api_key_env: "NVIDIA_NIM_API_KEY",
        base_url: "https://integrate.api.nvidia.com/v1"
      }
    };
    expect(buildIntakeModel(config, {}, fetch)).toBeNull();
  });

  it("returns null for provider 'deterministic' (no LLM configured)", () => {
    expect(buildIntakeModel(baseConfig, {}, fetch)).toBeNull();
  });
});

class ScriptedChatModel implements StructuredChatModel {
  constructor(private readonly replies: unknown[]) {}

  withStructuredOutput<T>(schema: { parse(value: unknown): T }) {
    return {
      invoke: async (input: unknown) => {
        // Mirrors LangChain's coercion contract: invoke() takes role-tagged
        // messages, never raw intake parts (regression for extract.ts).
        if (
          !Array.isArray(input) ||
          input.some((message) => typeof message !== "object" || message === null || !("role" in message))
        ) {
          throw new Error(
            "Unable to coerce message from array: only human, AI, system, developer, or tool message coercion is currently supported."
          );
        }
        return schema.parse(this.replies.shift());
      }
    };
  }
}

class OneMessageMailbox implements MailboxSource {
  readonly finished: Record<string, MailboxOutcome> = {};

  constructor(private readonly message: IntakeEmail) {}

  async listUnread(): Promise<string[]> {
    return [this.message.message_id];
  }

  async fetch(): Promise<IntakeEmail> {
    return this.message;
  }

  async finish(uid: string, outcome: MailboxOutcome): Promise<void> {
    this.finished[uid] = outcome;
  }

  async close(): Promise<void> {}
}

describe("runMailboxIntakeOnce", () => {
  it("keeps a text-only RFQ model-backed when classification incorrectly says bulk_file", async () => {
    const manifest: QuoteManifest = {
      client_id: "resaux",
      business_units: [
        {
          business_unit_id: "general",
          requester_email_domains: ["cliente.mx"],
          default: true
        }
      ],
      vehicle_profiles: [
        {
          vehicle_profile_id: "CAJA_53",
          business_unit_id: "general",
          keywords: ["caja seca"],
          payload_capacity_kg: 25_000,
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
    const message: IntakeEmail = {
      message_id: "ceb26bbe-6dbe-4136-ac09-c7838eb6159e",
      from_name: "Compras",
      from_email: "compras@cliente.mx",
      subject: "Cotizacion caja seca",
      body_text: "Monterrey, Nuevo Leon a Saltillo, Coahuila en caja seca",
      received_at: "2026-07-19T22:30:15.000Z",
      attachments: []
    };
    const mailbox = new OneMessageMailbox(message);
    const channel: Channel = { send: async () => undefined };
    const tools: QuoteWorkflowTools = {
      resolveRoute: async () => {
        throw new Error("reached route resolution after RFQ extraction");
      },
      searchHistorical: async () => ({
        selected_layer: "route_unit_cost",
        insufficient_data: false,
        comparables: [{ layer: "route_unit_cost", sample_size: 1 }]
      }),
      recommend: async ({ base_rate_mxn }) => ({
        recommended_rate_mxn: base_rate_mxn,
        reason: "not reached"
      }),
      writeback: async () => ({ status: "not reached" }),
      getUnits: async () => []
    };
    const runtime = await createQuoteAgentRuntime({
      manifest,
      tools,
      model: new ScriptedChatModel([
        { kind: "bulk_file", unit_type_hints: [], confidence: 0.9 },
        {
          lanes: [
            {
              origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
              destination: { city: "Saltillo", state: "Coahuila", country: "MX" },
              equipment_text: "caja seca",
              weight_kg: null,
              commodity: null,
              value_mxn: null,
              hazmat: false,
              target_rate_mxn: null
            }
          ]
        }
      ]),
      store: createInMemoryQuoteOpsStore(),
      channels: { email: channel, whatsapp: channel }
    });

    await expect(
      runMailboxIntakeOnce({
        env: { QUOTEOPS_CLIENT_ID: "resaux" },
        manifest,
        mailbox,
        graphRuntime: runtime,
        authorizeGraphRun: async () => undefined,
        log: () => undefined
      })
    ).rejects.toThrow("reached route resolution after RFQ extraction");
    expect(mailbox.finished[message.message_id]).toBe("error");
  });
});

describe("createSerializedMailboxPoll", () => {
  it("skips overlapping interval ticks, reports the skip, and resumes after completion", async () => {
    let finishFirstRun: (() => void) | undefined;
    const firstRun = new Promise<void>((resolve) => {
      finishFirstRun = resolve;
    });
    let calls = 0;
    const logs: string[] = [];
    const errors: string[] = [];
    const poll = createSerializedMailboxPoll({
      run: async () => {
        calls += 1;
        if (calls === 1) await firstRun;
      },
      log: (message) => logs.push(message),
      logError: (message) => errors.push(message)
    });

    poll();
    poll();
    expect(calls).toBe(1);
    expect(logs).toEqual(["poll skipped: previous cycle still in flight"]);

    finishFirstRun?.();
    await firstRun;
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    poll();
    await new Promise<void>((resolve) => queueMicrotask(resolve));

    expect(calls).toBe(2);
    expect(errors).toEqual([]);
  });
});
