import { assertCloudSafePayload } from "@quoteops/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryKnowledgeRepository,
  ingestKnowledgeDocument,
  searchKnowledge
} from "../src/index";
import type { EmbeddingVector, KnowledgeRepository } from "../src/index";

const fixedClock = () => new Date("2026-06-24T12:00:00.000Z");

describe("local RAG council lock", () => {
  it("calls embed exactly once and stores chunks locally", async () => {
    const repo = createInMemoryKnowledgeRepository();
    const upsertDocument = vi.spyOn(repo, "upsertDocument");
    const embed = vi.fn(async (texts: string[]) =>
      texts.map((_, index) => [1, index + 1, 0.25])
    );

    const result = await ingestKnowledgeDocument({
      repo,
      client_id: "NMX",
      filename: "criterios.md",
      content_type: "text/markdown",
      text: "No aprobar tarifa con margen menor a 12% sin revision directiva.",
      embedding_provider: "client_openai_compatible",
      embedding_model: "text-embedding-3-small",
      embedding_api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
      embed,
      now: fixedClock
    });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith([
      "No aprobar tarifa con margen menor a 12% sin revision directiva."
    ]);
    expect(result.document_id).toMatch(/^doc_nmx_/);
    expect(result.chunk_count).toBe(1);
    expect(upsertDocument).toHaveBeenCalledWith(
      expect.objectContaining({ created_at: "2026-06-24T12:00:00.000Z" })
    );
    expect(repo.cloudSafeStatus()).toMatchObject({
      knowledge_documents_count: 1,
      knowledge_chunks_count: 1,
      retriever_health: "ok"
    });
  });

  it("retrieves local snippets for the same client", async () => {
    const repo = createInMemoryKnowledgeRepository();
    await ingestKnowledgeDocument({
      repo,
      client_id: "NMX",
      filename: "criterios.md",
      content_type: "text/markdown",
      text: "Solicitar revision si la ruta requiere reposicionamiento sin retorno confirmado.",
      embedding_provider: "client_openai_compatible",
      embedding_model: "text-embedding-3-small",
      embedding_api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
      embed: async () => [[0.4, 0.5, 0.6]],
      now: fixedClock
    });

    const hits = await searchKnowledge({
      repo,
      client_id: "NMX",
      query: "reposicionamiento",
      embed: async () => [[0.4, 0.5, 0.6]],
      k: 3
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.text).toContain("reposicionamiento");
    expect(hits[0]?.client_id).toBe("NMX");
    expect(hits[0]).not.toHaveProperty("embedding");
  });

  it("rejects embedded API key values in embedding_api_key_env", async () => {
    const repo = createInMemoryKnowledgeRepository();
    const embed = vi.fn(async () => [[0.1, 0.2, 0.3]]);

    await expect(
      ingestKnowledgeDocument({
        repo,
        client_id: "NMX",
        filename: "criterios.md",
        content_type: "text/markdown",
        text: "Texto local.",
        embedding_provider: "client_openai_compatible",
        embedding_model: "text-embedding-3-small",
        embedding_api_key_env: "sk-live-secret",
        embed,
        now: fixedClock
      })
    ).rejects.toThrow(/secret reference must be an env var ref/);

    expect(embed).not.toHaveBeenCalled();
    expect(repo.cloudSafeStatus()).toEqual({
      knowledge_documents_count: 0,
      knowledge_chunks_count: 0,
      retriever_health: "unknown"
    });
  });

  it("cloudSafeStatus exposes no document text, chunks, embeddings, or secrets", async () => {
    const repo = createInMemoryKnowledgeRepository();
    await ingestKnowledgeDocument({
      repo,
      client_id: "NMX",
      filename: "criterios.md",
      content_type: "text/markdown",
      text: "No exponer este criterio fuera del appliance local.",
      embedding_provider: "client_openai_compatible",
      embedding_model: "text-embedding-3-small",
      embedding_api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
      embed: async () => [[0.1, 0.2, 0.3]],
      now: fixedClock
    });

    const status = repo.cloudSafeStatus();

    expect(() => assertCloudSafePayload(status)).not.toThrow();
    expect(status).toEqual({
      knowledge_documents_count: 1,
      knowledge_chunks_count: 1,
      retriever_health: "ok"
    });
    expect(Object.keys(status)).not.toEqual(
      expect.arrayContaining([
        "document_text",
        "chunk_text",
        "knowledge_documents",
        "knowledge_chunks",
        "embedding",
        "embeddings",
        "secret"
      ])
    );
    expect(JSON.stringify(Object.values(status))).not.toMatch(/criterio|QUOTEOPS_EMBEDDING/i);
  });

  it("isolates client search results", async () => {
    const repo = createInMemoryKnowledgeRepository();
    await ingestKnowledgeDocument({
      repo,
      client_id: "NMX",
      filename: "nmx.md",
      content_type: "text/markdown",
      text: "NMX requiere revision directiva para retornos inciertos.",
      embedding_provider: "client_openai_compatible",
      embedding_model: "text-embedding-3-small",
      embedding_api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
      embed: async () => [[1, 0, 0]],
      now: fixedClock
    });
    await ingestKnowledgeDocument({
      repo,
      client_id: "ACME",
      filename: "acme.md",
      content_type: "text/markdown",
      text: "ACME requiere revision directiva para retornos inciertos.",
      embedding_provider: "client_openai_compatible",
      embedding_model: "text-embedding-3-small",
      embedding_api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
      embed: async () => [[1, 0, 0]],
      now: fixedClock
    });

    const hits = await searchKnowledge({
      repo,
      client_id: "NMX",
      query: "retornos inciertos",
      embed: async () => [[1, 0, 0]],
      k: 5
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.client_id).toBe("NMX");
    expect(hits[0]?.text).toContain("NMX");
    expect(hits[0]?.text).not.toContain("ACME");
    expect(hits[0]).not.toHaveProperty("embedding");
  });

  it.each([
    { name: "missing", embeddings: [] },
    { name: "empty", embeddings: [[]] },
    { name: "non-finite", embeddings: [[Number.NaN]] },
    { name: "wrong-count", embeddings: [[1], [1]] }
  ] satisfies Array<{ name: string; embeddings: EmbeddingVector[] }>)(
    "rejects $name search embeddings before repository search",
    async ({ embeddings }) => {
      const search = vi.fn(async () => []);
      const repo: KnowledgeRepository = {
        upsertDocument: vi.fn(async () => undefined),
        upsertChunks: vi.fn(async () => undefined),
        search,
        cloudSafeStatus: () => ({
          knowledge_documents_count: 0,
          knowledge_chunks_count: 0,
          retriever_health: "unknown"
        })
      };

      await expect(
        searchKnowledge({
          repo,
          client_id: "NMX",
          query: "margen",
          embed: async () => embeddings,
          k: 3
        })
      ).rejects.toThrow(/embedding/);

      expect(search).not.toHaveBeenCalled();
    }
  );

  it("fails closed on query and stored embedding dimension mismatch", async () => {
    const repo = createInMemoryKnowledgeRepository();
    await ingestKnowledgeDocument({
      repo,
      client_id: "NMX",
      filename: "dimension.md",
      content_type: "text/markdown",
      text: "Dimension mismatch must not silently score partial vectors.",
      embedding_provider: "client_openai_compatible",
      embedding_model: "text-embedding-3-small",
      embedding_api_key_env: "QUOTEOPS_EMBEDDING_API_KEY",
      embed: async () => [[1, 0, 0]],
      now: fixedClock
    });

    await expect(
      searchKnowledge({
        repo,
        client_id: "NMX",
        query: "dimension mismatch",
        embed: async () => [[1, 0]],
        k: 3
      })
    ).rejects.toThrow(/embedding dimension mismatch/);
  });
});
