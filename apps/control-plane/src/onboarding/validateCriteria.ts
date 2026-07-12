import type { OnboardingReadiness } from "./validateTms.js";

export type CriteriaQuestionnaireInput = {
  margin: {
    target_margin_pct: number;
    minimum_margin_pct: number;
  } | null;
  strategic_customers: {
    customer_ids: string[];
    rules: string[];
  } | null;
  insufficient_historical: {
    minimum_comparables: number;
    fallback_action: "approval_required" | "manual_review" | "block_quote";
  } | null;
  approval: {
    approver_roles: string[];
    escalation_sla_minutes: number;
  } | null;
  communication: {
    tone: string;
    forbidden_disclosures: string[];
  } | null;
};

export function validateCriteria(criteria: CriteriaQuestionnaireInput): OnboardingReadiness {
  const blockingIssues: string[] = [];
  const nextActions: string[] = [];
  const capabilities = {
    margin: hasMarginCriteria(criteria.margin),
    strategic_customers: hasStrategicCustomerCriteria(criteria.strategic_customers),
    insufficient_historical: hasInsufficientHistoricalCriteria(criteria.insufficient_historical),
    approval: hasApprovalCriteria(criteria.approval),
    communication: hasCommunicationCriteria(criteria.communication)
  };

  if (!capabilities.margin) {
    blockingIssues.push("margin_criteria_missing");
    nextActions.push("define_margin_criteria");
  }

  if (!capabilities.strategic_customers) {
    blockingIssues.push("strategic_customer_criteria_missing");
    nextActions.push("define_strategic_customer_criteria");
  }

  if (!capabilities.insufficient_historical) {
    blockingIssues.push("insufficient_historical_criteria_missing");
    nextActions.push("define_insufficient_historical_criteria");
  }

  if (!capabilities.approval) {
    blockingIssues.push("approval_criteria_missing");
    nextActions.push("define_approval_criteria");
  }

  if (!capabilities.communication) {
    blockingIssues.push("communication_criteria_missing");
    nextActions.push("define_communication_criteria");
  }

  if (blockingIssues.length === 0) {
    nextActions.push("review_criteria_with_client");
  }

  return {
    ready: blockingIssues.length === 0,
    blocking_issues: blockingIssues,
    warnings: [],
    capabilities,
    next_actions: nextActions
  };
}

function hasMarginCriteria(criteria: CriteriaQuestionnaireInput["margin"]): boolean {
  return (
    criteria !== null &&
    criteria.target_margin_pct > 0 &&
    criteria.minimum_margin_pct > 0 &&
    criteria.minimum_margin_pct <= criteria.target_margin_pct
  );
}

function hasStrategicCustomerCriteria(
  criteria: CriteriaQuestionnaireInput["strategic_customers"]
): boolean {
  return criteria !== null && criteria.customer_ids.length > 0 && criteria.rules.length > 0;
}

function hasInsufficientHistoricalCriteria(
  criteria: CriteriaQuestionnaireInput["insufficient_historical"]
): boolean {
  return criteria !== null && criteria.minimum_comparables > 0;
}

function hasApprovalCriteria(criteria: CriteriaQuestionnaireInput["approval"]): boolean {
  return (
    criteria !== null &&
    criteria.approver_roles.length > 0 &&
    criteria.escalation_sla_minutes > 0
  );
}

function hasCommunicationCriteria(criteria: CriteriaQuestionnaireInput["communication"]): boolean {
  return (
    criteria !== null &&
    criteria.tone.trim().length > 0 &&
    criteria.forbidden_disclosures.length > 0
  );
}
