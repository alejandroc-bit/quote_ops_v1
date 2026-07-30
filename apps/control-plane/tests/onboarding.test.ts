import { describe, expect, it } from "vitest";
import {
  createClientManifest,
  validateCriteria,
  validateTms,
  type CriteriaQuestionnaireInput,
  type ClientQuestionnaireInput
} from "../src/index";

const questionnaire: ClientQuestionnaireInput = {
  legal_data: {
    client_id: "cliente-demo",
    legal_name: "Cliente Demo SA de CV",
    tax_id: "CDE260618AB1",
    country: "MX"
  },
  tms: {
    provider: "quoteops-tms-http-v1",
    base_url: "https://tms.cliente.example",
    auth_type: "api_key",
    capabilities: [
      "historical_quotes",
      "units",
      "unit_performance",
      "availability_zones",
      "writeback",
      "health_check"
    ],
    historical_quotes_source: "api",
    writeback_target: "api"
  },
  business_units: [
    {
      business_unit_id: "industrial",
      name: "Industrial",
      requester_email_domains: ["cliente.example"],
      default: true
    }
  ],
  units: [
    {
      unit_id: "T3S2_53_DRYVAN",
      business_unit_id: "industrial",
      label: "Caja seca 53",
      payload_capacity_kg: 24000,
      pricing_model: "formula"
    }
  ],
  approvers: [
    {
      approver_id: "pricing-manager",
      name: "Pricing Manager",
      email: "pricing@cliente.example",
      role: "pricing_manager",
      approval_scope: ["margin_exception"]
    }
  ],
  email: {
    inbound_addresses: ["rfq@cliente.example"],
    outbound_from: "cotizaciones@cliente.example",
    escalation_addresses: ["soporte@cliente.example"]
  },
  sakbe: {
    enabled: true,
    api_key_secret_ref: "sakbe/client-demo/api-key",
    require_route_evidence: true
  },
  model: {
    provider: "gemini_sdk",
    model_name: "gemini-2.5-pro",
    temperature: 0
  },
  policies: {
    minimum_margin_pct: 0.18,
    target_margin_pct: 0.25,
    require_approval_below_margin: true,
    allow_insufficient_historical_with_approval: true
  }
};

const criteria: CriteriaQuestionnaireInput = {
  margin: {
    target_margin_pct: 0.25,
    minimum_margin_pct: 0.18
  },
  strategic_customers: {
    customer_ids: ["CUST-001"],
    rules: ["never quote below target margin without director approval"]
  },
  insufficient_historical: {
    minimum_comparables: 3,
    fallback_action: "approval_required"
  },
  approval: {
    approver_roles: ["pricing_manager"],
    escalation_sla_minutes: 30
  },
  communication: {
    tone: "sobrio",
    forbidden_disclosures: ["direct_cost_mxn", "internal_margin_pct"]
  }
};

describe("createClientManifest", () => {
  it("creates a manifest from onboarding questionnaire inputs", () => {
    const manifest = createClientManifest(questionnaire, {
      manifest_version: "manifest-2026.06.18.1",
      created_at: "2026-06-18T15:00:00.000Z"
    });

    expect(manifest).toMatchObject({
      manifest_version: "manifest-2026.06.18.1",
      client_id: "cliente-demo",
      legal_data: questionnaire.legal_data,
      tms: questionnaire.tms,
      business_units: questionnaire.business_units,
      units: questionnaire.units,
      approvers: questionnaire.approvers,
      email: questionnaire.email,
      sakbe: questionnaire.sakbe,
      model: questionnaire.model,
      policies: questionnaire.policies
    });
  });
});

describe("onboarding readiness", () => {
  it("returns ready readiness with capabilities and next actions for a valid TMS", () => {
    const readiness = validateTms(questionnaire.tms);

    expect(readiness.ready).toBe(true);
    expect(readiness.blocking_issues).toEqual([]);
    expect(readiness.capabilities).toMatchObject({
      historical_quotes: true,
      units: true,
      unit_performance: true,
      availability_zones: true,
      writeback: true,
      health_check: true
    });
    expect(readiness.next_actions).toContain("run_tms_connection_test");
  });

  it.each([
    "historical_quotes",
    "units",
    "unit_performance",
    "availability_zones",
    "writeback",
    "health_check"
  ] as const)("requires the %s capability for QuoteOps TMS HTTP v1", (missing) => {
    const readiness = validateTms({
      ...questionnaire.tms,
      capabilities: questionnaire.tms.capabilities.filter(
        (capability) => capability !== missing
      )
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.blocking_issues).toContain(
      `tms_${missing}_missing`
    );
  });

  it("blocks readiness when TMS writeback is missing", () => {
    const readiness = validateTms({
      ...questionnaire.tms,
      capabilities: ["historical_quotes", "health_check"],
      writeback_target: null
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.blocking_issues).toContain("tms_writeback_missing");
    expect(readiness.next_actions).toContain("configure_tms_writeback");
  });

  it("requires margin, strategic customer, historical, approval, and communication criteria", () => {
    const readiness = validateCriteria(criteria);

    expect(readiness.ready).toBe(true);
    expect(readiness.blocking_issues).toEqual([]);

    const incomplete = validateCriteria({
      ...criteria,
      communication: null
    });

    expect(incomplete.ready).toBe(false);
    expect(incomplete.blocking_issues).toContain("communication_criteria_missing");
  });
});
