import { describe, expect, it } from "vitest";
import {
  applyMinimalHeartbeat,
  applyQuoteCounters,
  createInstallPack,
  createMinimalClientRecord,
  parseMinimalCounters,
  parseMinimalHeartbeat
} from "../src/index";

const client = createMinimalClientRecord({
  client_id: "NMX",
  legal_name: "Autolineas NuevoMex",
  authorized_email: "ops@nmx.example",
  created_at: "2026-06-25T12:00:00.000Z"
});

describe("minimal control-plane registry", () => {
  it("tracks only activation state, AI key status and aggregate counters", () => {
    const heartbeating = applyMinimalHeartbeat(
      client,
      parseMinimalHeartbeat({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        onboarding_status: "waiting_local_secrets",
        ai_key_status: "configured"
      }),
      "2026-06-25T12:05:00.000Z"
    );
    const counted = applyQuoteCounters(
      heartbeating,
      parseMinimalCounters({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        total: 10,
        validated: 7,
        rejected: 1,
        pending: 1,
        failed: 1
      })
    );

    expect(counted.installation.last_heartbeat_at).toBe("2026-06-25T12:05:00.000Z");
    expect(counted.installation.ai_key_status).toBe("configured");
    expect(counted.counters).toEqual({
      total: 10,
      validated: 7,
      rejected: 1,
      pending: 1,
      failed: 1
    });
  });

  it("rejects secret, raw RFQ and route evidence fields", () => {
    expect(() =>
      parseMinimalHeartbeat({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        ai_key_status: "configured",
        ai_api_key: "sk-test"
      })
    ).toThrow(/not allowed/);
    expect(() =>
      parseMinimalCounters({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        total: 1,
        validated: 1,
        rejected: 0,
        pending: 0,
        failed: 0,
        raw_rfq: { requester: "cliente@example.com" }
      })
    ).toThrow(/not allowed/);
    expect(() =>
      parseMinimalCounters({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        total: 1,
        validated: 1,
        rejected: 0,
        pending: 0,
        failed: 0,
        route_evidence: { provider: "sakbe" }
      })
    ).toThrow(/not allowed/);
  });

  it("rejects knowledge embeddings and chunks from cloud-bound payloads", () => {
    // council-lock: the vector brain lives only on the appliance; embeddings and
    // chunk text must never reach the control plane, even nested.
    expect(() =>
      parseMinimalHeartbeat({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        ai_key_status: "configured",
        embedding: [0.1, 0.2, 0.3]
      })
    ).toThrow(/not allowed/);
    expect(() =>
      parseMinimalCounters({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        total: 1,
        validated: 1,
        rejected: 0,
        pending: 0,
        failed: 0,
        knowledge_chunks: [{ chunk_text: "márgenes internos confidenciales" }]
      })
    ).toThrow(/not allowed/);
  });

  it("generates an install pack without embedding secret values in files or command", () => {
    const pack = createInstallPack({
      client,
      control_plane_url: "https://quoteops-control-plane-staging.vercel.app/",
      registration_token: "registration-token-secret",
      expires_at: "2026-06-25T13:00:00.000Z"
    });

    expect(pack.registration_token).toBe("registration-token-secret");
    expect(pack.control_plane_url).toBe("https://quoteops-control-plane-staging.vercel.app");
    expect(pack.install_command).toContain(
      "curl -fsSL https://quoteops-control-plane-staging.vercel.app/api/install/$QUOTEOPS_REGISTRATION_TOKEN | bash"
    );
    expect(pack.install_command).not.toContain("registration-token-secret");
    expect(Object.values(pack.files).join("\n")).not.toContain("registration-token-secret");
    expect(pack.files["client-manifest.yaml"]).toContain("quote_counters");
    expect(pack.files["client-manifest.yaml"]).toContain("ai_key_status");
    expect(pack.files["client-manifest.yaml"]).toContain("vehicle_profiles");
    expect(pack.files["connectors/agent/agent-config.yaml"]).toContain("api_key_env: OPENROUTER_API_KEY");
    expect(pack.files["connectors/tms-adapter.yaml"]).toContain("provider: file_import");
    expect(pack.files["connectors/tms/rfqs.csv"]).toContain("rfq_id,lane_id");
  });
});
