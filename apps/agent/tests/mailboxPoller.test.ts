import { describe, expect, it } from "vitest";
import type { AgentRuntimeConfig } from "@quoteops/connectors";
import { buildIntakeModel } from "../src/intake/mailboxPoller.js";

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
