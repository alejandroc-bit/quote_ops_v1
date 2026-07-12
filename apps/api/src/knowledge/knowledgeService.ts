import { loadAgentRuntimeConfig, type AgentEmbeddingsConfig } from "@quoteops/connectors";
import type { EmbedTexts, KnowledgeRepository } from "@quoteops/knowledge";
import { PostgresKnowledgeRepository } from "../storage/PostgresKnowledgeRepository.js";
import { createEmbedder } from "./embedder.js";

export type KnowledgeService = {
  repo: PostgresKnowledgeRepository;
  embed: EmbedTexts | null;
  embeddingsConfig: AgentEmbeddingsConfig | null;
};

/**
 * Builds the local knowledge service (Postgres vector store + embedder) from
 * the appliance env + agent-config. Returns null without a DATABASE_URL. The
 * embedder is null when no embeddings block/key is configured, in which case
 * ingestion and retrieval stay disabled (fail-closed) but the appliance still
 * runs. A single instance is reused so the Postgres pool isn't rebuilt.
 */
let cached: { key: string; service: KnowledgeService } | null = null;

export async function getKnowledgeService(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch
): Promise<KnowledgeService | null> {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  if (cached && cached.key === databaseUrl) {
    return cached.service;
  }

  const agentConfig = await loadAgentRuntimeConfig(env.QUOTEOPS_AGENT_CONFIG_PATH).catch(() => null);
  const embeddingsConfig = agentConfig?.embeddings ?? null;
  const service: KnowledgeService = {
    repo: new PostgresKnowledgeRepository({ databaseUrl }),
    embed: createEmbedder(embeddingsConfig, env, fetchFn),
    embeddingsConfig
  };
  cached = { key: databaseUrl, service };
  return service;
}

export function resetKnowledgeServiceCache(): void {
  cached = null;
}

export type { KnowledgeRepository };
