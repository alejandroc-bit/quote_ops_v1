import type { AgentEmbeddingsConfig } from "@quoteops/connectors";
import type { EmbedTexts } from "@quoteops/knowledge";

/**
 * Builds an embedding function from the agent-config `embeddings` block plus the
 * appliance secret named by `api_key_env`. Returns null when no config or key is
 * present so knowledge stays fail-closed. Embeddings are computed locally and
 * their vectors never leave the appliance (council-lock).
 */
export function createEmbedder(
  config: AgentEmbeddingsConfig | null,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch = fetch
): EmbedTexts | null {
  if (!config) return null;
  const apiKey = env[config.api_key_env]?.trim();
  if (!apiKey) return null;

  if (config.provider === "gemini") {
    return async (texts) => {
      const { GoogleGenAI } = await import("@google/genai");
      const client = new GoogleGenAI({ apiKey });
      const vectors: number[][] = [];
      for (const text of texts) {
        const response = await client.models.embedContent({
          model: config.model,
          contents: text
        });
        const values = response.embeddings?.[0]?.values;
        if (!values) throw new Error("gemini embedding response had no values");
        vectors.push(values);
      }
      return vectors;
    };
  }

  // openai_compatible: OpenAI, Azure OpenAI, or any /v1/embeddings endpoint
  const baseUrl = (config.base_url ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  return async (texts) => {
    const response = await fetchFn(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: config.model, input: texts })
    });
    if (!response.ok) {
      throw new Error(`embedding provider responded with HTTP ${response.status}`);
    }
    const body = (await response.json()) as { data?: Array<{ embedding?: number[] }> };
    const vectors = (body.data ?? []).map((row) => row.embedding);
    if (vectors.length !== texts.length || vectors.some((v) => !v)) {
      throw new Error("embedding provider returned an unexpected number of vectors");
    }
    return vectors as number[][];
  };
}
