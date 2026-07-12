import { describe, expect, it } from "vitest";
import {
  assertCloudSafePayload,
  assertQuoteCoreFieldsPreserved,
  assertSecretRef,
  classifyDataKey
} from "../src/index";

describe("council cloud/local data locks", () => {
  it("rejects forbidden cloud keys recursively", () => {
    expect(() =>
      assertCloudSafePayload({
        client_id: "NMX",
        approval_envelope: { raw_tms_sample: { unidad: "TR-101" } }
      })
    ).toThrow(/forbidden cloud key: raw_tms_sample/);
  });

  it("allows safe metadata and rejects secret values", () => {
    expect(
      assertCloudSafePayload({
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        schema_hash: "sha256:tms-v1",
        drift_status: "ok",
        knowledge_documents_count: 4,
        retriever_health: "ok"
      })
    ).toMatchObject({ client_id: "NMX" });

    expect(() => assertSecretRef("TMS_API_KEY")).not.toThrow();
    expect(() => assertSecretRef("sk-or-v1-secret-value")).toThrow(/must be an env var ref/);
  });

  it("rejects unknown local-only keys in cloud payloads", () => {
    expect(() =>
      assertCloudSafePayload({
        client_id: "NMX",
        operational_note: "local-only diagnostic"
      })
    ).toThrow(/non cloud-safe key: operational_note/);
  });

  it("validates secret refs embedded in cloud payloads", () => {
    expect(
      assertCloudSafePayload({
        client_id: "NMX",
        TMS_API_KEY: "TMS_API_KEY",
        TMS_BASIC_AUTH_TOKEN: "TMS_BASIC_AUTH_TOKEN"
      })
    ).toMatchObject({ TMS_API_KEY: "TMS_API_KEY" });

    expect(() =>
      assertCloudSafePayload({
        client_id: "NMX",
        TMS_API_KEY: "sk-or-v1-secret-value"
      })
    ).toThrow(/must be an env var ref/);
  });

  it("catches forbidden casing variants", () => {
    for (const key of [
      "documentText",
      "emailBody",
      "accessToken",
      "refreshToken",
      "apiKey",
      "tmsApiKey"
    ]) {
      expect(classifyDataKey(key), key).toBe("FORBIDDEN_CLOUD");
      expect(() => assertCloudSafePayload({ client_id: "NMX", [key]: "value" })).toThrow(
        new RegExp(`forbidden cloud key: ${key}`)
      );
    }
  });

  it("classifies known keys explicitly", () => {
    expect(classifyDataKey("raw_tms_sample")).toBe("FORBIDDEN_CLOUD");
    expect(classifyDataKey("document_text")).toBe("FORBIDDEN_CLOUD");
    expect(classifyDataKey("schema_hash")).toBe("CLOUD_SAFE");
    expect(classifyDataKey("TMS_API_KEY")).toBe("SECRET_REF_ONLY");
  });

  it("allows unchanged quote-core fields", () => {
    const before = {
      base_rate_mxn: 40000,
      recommended_rate_mxn: 40000,
      cost_mxn: 32000,
      margin_mxn: 8000,
      margin_pct: 0.2
    };

    expect(assertQuoteCoreFieldsPreserved(before, { ...before })).toEqual(before);
  });

  it("allows omitted optional quote-core fields intentionally", () => {
    const before = {
      base_rate_mxn: 40000,
      recommended_rate_mxn: 40000,
      cost_mxn: 32000,
      margin_mxn: 8000,
      margin_pct: 0.2
    };

    expect(
      assertQuoteCoreFieldsPreserved(before, {
        base_rate_mxn: 40000,
        recommended_rate_mxn: 40000
      })
    ).toEqual(before);
  });

  it("prevents advisory layers from changing quote-core fields", () => {
    const before = {
      base_rate_mxn: 40000,
      recommended_rate_mxn: 40000,
      cost_mxn: 32000,
      margin_mxn: 8000,
      margin_pct: 0.2
    };
    const after = {
      ...before,
      recommended_rate_mxn: 42000
    };

    expect(() => assertQuoteCoreFieldsPreserved(before, after)).toThrow(
      /immutable quote field changed: recommended_rate_mxn/
    );
  });

  it("prevents required quote-core fields from changing", () => {
    const before = {
      base_rate_mxn: 40000,
      recommended_rate_mxn: 40000
    };

    expect(() =>
      assertQuoteCoreFieldsPreserved(before, {
        base_rate_mxn: 41000,
        recommended_rate_mxn: 40000
      })
    ).toThrow(/immutable quote field changed: base_rate_mxn/);
  });
});
