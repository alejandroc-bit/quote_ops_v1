import {
  validateCriteriaNode,
  type CriteriaNode,
  type CriteriaPhase
} from "./criteriaNode.js";

export type CriteriaContext = Record<string, string | string[] | null | undefined>;

export type RetrieveCriteriaInput = {
  criteria_version: string;
  client_id: string;
  phase: CriteriaPhase;
  context: CriteriaContext;
  nodes: CriteriaNode[];
};

export type KnowledgeHit = {
  chunk_id: string;
  text: string;
};

export type RetrievedCriteria = {
  criteria_version: string;
  client_id: string;
  retrieved_for: CriteriaPhase;
  nodes: CriteriaNode[];
  /** Vector-retrieved commercial-criteria excerpts (the agent's brain). */
  knowledge_hits?: KnowledgeHit[];
};

export function retrieveCriteria(input: RetrieveCriteriaInput): RetrievedCriteria {
  const nodes = input.nodes
    .map((node) => validateCriteriaNode(node))
    .filter((node) => node.phases.includes(input.phase))
    .filter((node) => nodeApplies(node, input.context))
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  return {
    criteria_version: input.criteria_version,
    client_id: input.client_id,
    retrieved_for: input.phase,
    nodes
  };
}

function nodeApplies(node: CriteriaNode, context: CriteriaContext): boolean {
  for (const [key, acceptedValues] of Object.entries(node.applies_when)) {
    const rawValue = context[key];
    const contextValues = Array.isArray(rawValue) ? rawValue : rawValue ? [rawValue] : [];
    if (!contextValues.length) return false;
    const normalizedAccepted = acceptedValues.map(normalize);
    const hasMatch = contextValues.some((value) => normalizedAccepted.includes(normalize(value)));
    if (!hasMatch) return false;
  }
  return true;
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
