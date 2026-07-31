export type TmsCapability =
  | "historical_quotes"
  | "units"
  | "unit_performance"
  | "availability_zones"
  | "writeback"
  | "health_check";

export type ClientQuestionnaireInput = {
  legal_data: {
    client_id: string;
    legal_name: string;
    tax_id: string;
    country: string;
  };
  tms: {
    provider: string;
    base_url: string | null;
    auth_type: "api_key" | "none";
    capabilities: TmsCapability[];
    historical_quotes_source: "api" | "csv" | "database" | null;
    writeback_target: "api" | "csv" | "database" | null;
  };
  business_units: Array<{
    business_unit_id: string;
    name: string;
    requester_email_domains: string[];
    default: boolean;
  }>;
  units: Array<{
    unit_id: string;
    business_unit_id: string;
    label: string;
    payload_capacity_kg: number;
    pricing_model: "formula" | "rentability" | "manual";
  }>;
  approvers: Array<{
    approver_id: string;
    name: string;
    email: string;
    role: string;
    approval_scope: string[];
  }>;
  email: {
    inbound_addresses: string[];
    outbound_from: string;
    escalation_addresses: string[];
  };
  sakbe: {
    enabled: boolean;
    api_key_secret_ref: string | null;
    require_route_evidence: boolean;
  };
  model: {
    provider: "deterministic" | "gemini_sdk" | "openai" | "claude_cli";
    model_name: string;
    temperature: number;
  };
  policies: {
    minimum_margin_pct: number;
    target_margin_pct: number;
    require_approval_below_margin: boolean;
    allow_insufficient_historical_with_approval: boolean;
  };
};

export type ClientManifest = ClientQuestionnaireInput & {
  manifest_version: string;
  client_id: string;
  created_at: string;
};

export type CreateClientManifestOptions = {
  manifest_version: string;
  created_at: string;
};

export function createClientManifest(
  questionnaire: ClientQuestionnaireInput,
  options: CreateClientManifestOptions
): ClientManifest {
  return {
    manifest_version: options.manifest_version,
    client_id: questionnaire.legal_data.client_id,
    created_at: options.created_at,
    legal_data: { ...questionnaire.legal_data },
    tms: {
      ...questionnaire.tms,
      capabilities: [...questionnaire.tms.capabilities]
    },
    business_units: questionnaire.business_units.map((unit) => ({
      ...unit,
      requester_email_domains: [...unit.requester_email_domains]
    })),
    units: questionnaire.units.map((unit) => ({ ...unit })),
    approvers: questionnaire.approvers.map((approver) => ({
      ...approver,
      approval_scope: [...approver.approval_scope]
    })),
    email: {
      inbound_addresses: [...questionnaire.email.inbound_addresses],
      outbound_from: questionnaire.email.outbound_from,
      escalation_addresses: [...questionnaire.email.escalation_addresses]
    },
    sakbe: { ...questionnaire.sakbe },
    model: { ...questionnaire.model },
    policies: { ...questionnaire.policies }
  };
}
