import type { ClientQuestionnaireInput } from "./createClientManifest.js";

export type OnboardingReadiness = {
  ready: boolean;
  blocking_issues: string[];
  warnings: string[];
  capabilities: Record<string, boolean>;
  next_actions: string[];
};

export function validateTms(tms: ClientQuestionnaireInput["tms"]): OnboardingReadiness {
  const blockingIssues: string[] = [];
  const warnings: string[] = [];
  const nextActions: string[] = [];
  const capabilitySet = new Set(tms.capabilities);
  const capabilities = {
    historical_quotes:
      capabilitySet.has("historical_quotes") && tms.historical_quotes_source !== null,
    units: capabilitySet.has("units"),
    unit_performance: capabilitySet.has("unit_performance"),
    availability_zones: capabilitySet.has("availability_zones"),
    writeback: capabilitySet.has("writeback") && tms.writeback_target !== null,
    health_check: capabilitySet.has("health_check")
  };
  const isQuoteOpsHttpV1 = tms.provider === "quoteops-tms-http-v1";

  if (!tms.base_url && tms.provider !== "file-import") {
    blockingIssues.push("tms_base_url_missing");
    nextActions.push("configure_tms_endpoint");
  }

  if (!capabilities.historical_quotes) {
    blockingIssues.push("tms_historical_quotes_missing");
    nextActions.push("configure_tms_historical_quotes");
  }

  if (!capabilities.writeback) {
    blockingIssues.push("tms_writeback_missing");
    nextActions.push("configure_tms_writeback");
  }

  if (!capabilities.health_check) {
    if (isQuoteOpsHttpV1) {
      blockingIssues.push("tms_health_check_missing");
      nextActions.push("configure_tms_health_check");
    } else {
      warnings.push("tms_health_check_missing");
      nextActions.push("add_tms_health_check");
    }
  }

  if (isQuoteOpsHttpV1) {
    for (const capability of [
      "units",
      "unit_performance",
      "availability_zones"
    ] as const) {
      if (!capabilities[capability]) {
        blockingIssues.push(`tms_${capability}_missing`);
        nextActions.push(`configure_tms_${capability}`);
      }
    }
  }

  if (blockingIssues.length === 0) {
    nextActions.push("run_tms_connection_test");
  }

  return {
    ready: blockingIssues.length === 0,
    blocking_issues: blockingIssues,
    warnings,
    capabilities,
    next_actions: nextActions
  };
}
