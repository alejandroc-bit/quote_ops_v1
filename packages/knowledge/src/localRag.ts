import { assertCloudSafePayload, assertSecretRef } from "@quoteops/contracts";

export type EmbeddingVector = number[];

export type EmbedTexts = (texts: string[]) => Promise<EmbeddingVector[]>;

export type KnowledgeChunk = {
  chunk_id: string;
  document_id: string;
  client_id: string;
  chunk_index: number;
  text: string;
  embedding: EmbeddingVector;
};

export type KnowledgeSearchHit = Omit<KnowledgeChunk, "embedding">;

export type KnowledgeDocumentRecord = {
  document_id: string;
  client_id: string;
  filename: string;
  content_type: string;
  chunk_count: number;
  created_at: string;
};

export type KnowledgeCloudSafeStatus = {
  knowledge_documents_count: number;
  knowledge_chunks_count: number;
  retriever_health: "ok" | "unknown";
};

export type KnowledgeRepository = {
  upsertDocument(input: KnowledgeDocumentRecord): Promise<void>;
  upsertChunks(chunks: KnowledgeChunk[]): Promise<void>;
  search(input: {
    client_id: string;
    query: string;
    embedding: EmbeddingVector;
    k: number;
  }): Promise<KnowledgeSearchHit[]>;
  cloudSafeStatus(): KnowledgeCloudSafeStatus;
};

export type IngestKnowledgeDocumentInput = {
  repo: KnowledgeRepository;
  client_id: string;
  filename: string;
  content_type: string;
  text: string;
  embedding_provider: string;
  embedding_model: string;
  embedding_api_key_env: string;
  embed: EmbedTexts;
  now?: () => Date;
};

export type SearchKnowledgeInput = {
  repo: KnowledgeRepository;
  client_id: string;
  query: string;
  embed: EmbedTexts;
  k: number;
};

export function createInMemoryKnowledgeRepository(): KnowledgeRepository {
  const documents = new Map<string, KnowledgeDocumentRecord>();
  let chunks: KnowledgeChunk[] = [];

  return {
    async upsertDocument(input) {
      documents.set(input.document_id, { ...input });
    },

    async upsertChunks(input) {
      const documentIds = new Set(input.map((chunk) => chunk.document_id));
      chunks = chunks.filter((chunk) => !documentIds.has(chunk.document_id));
      chunks.push(...input.map((chunk) => ({ ...chunk, embedding: [...chunk.embedding] })));
    },

    async search(input) {
      const k = Math.max(0, Math.floor(input.k));
      if (k === 0) return [];

      const query = normalizeSearchText(input.query);
      const scored = chunks
        .filter((chunk) => chunk.client_id === input.client_id)
        .map((chunk, index) => ({
          chunk,
          index,
          score: lexicalScore(chunk.text, query) + cosineSimilarity(input.embedding, chunk.embedding)
        }))
        .filter((hit) => hit.score > 0)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          return left.index - right.index;
        });

      return scored.slice(0, k).map((hit) => toSearchHit(hit.chunk));
    },

    cloudSafeStatus() {
      return assertCloudSafePayload({
        knowledge_documents_count: documents.size,
        knowledge_chunks_count: chunks.length,
        retriever_health: documents.size > 0 ? "ok" : "unknown"
      } satisfies KnowledgeCloudSafeStatus);
    }
  };
}

export async function ingestKnowledgeDocument(
  input: IngestKnowledgeDocumentInput
): Promise<{ document_id: string; chunk_count: number }> {
  assertSecretRef(input.embedding_api_key_env);
  assertPresent(input.client_id, "client_id");
  assertPresent(input.filename, "filename");
  assertPresent(input.content_type, "content_type");
  assertPresent(input.embedding_provider, "embedding_provider");
  assertPresent(input.embedding_model, "embedding_model");

  const chunkTexts = chunkText(input.text);
  if (chunkTexts.length === 0) {
    throw new Error("knowledge document has no ingestible text");
  }

  const embeddings = await input.embed(chunkTexts);
  assertEmbeddingVectors(embeddings, chunkTexts.length, "chunks");

  const document_id = `doc_${normalizeId(input.client_id)}_${hashText(
    [input.filename, input.content_type, input.text].join("\0")
  )}`;
  const created_at = (input.now ?? (() => new Date()))().toISOString();

  await input.repo.upsertDocument({
    document_id,
    client_id: input.client_id,
    filename: input.filename,
    content_type: input.content_type,
    chunk_count: chunkTexts.length,
    created_at
  });
  await input.repo.upsertChunks(
    chunkTexts.map((text, index) => {
      const embedding = embeddings[index];
      if (!embedding) {
        throw new Error(`missing embedding for chunk ${index}`);
      }
      return {
        chunk_id: `${document_id}_${index}`,
        document_id,
        client_id: input.client_id,
        chunk_index: index,
        text,
        embedding
      };
    })
  );

  return { document_id, chunk_count: chunkTexts.length };
}

export async function searchKnowledge(input: SearchKnowledgeInput): Promise<KnowledgeSearchHit[]> {
  const embeddings = await input.embed([input.query]);
  assertEmbeddingVectors(embeddings, 1, "search query");
  const embedding = embeddings[0];
  if (!embedding) {
    throw new Error("embedding provider returned no search embedding");
  }
  return input.repo.search({
    client_id: input.client_id,
    query: input.query,
    embedding,
    k: input.k
  });
}

function chunkText(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
}

function normalizeSearchText(text: string): string {
  return text.trim().toLowerCase();
}

function lexicalScore(text: string, query: string): number {
  if (query.length === 0) return 0;
  const normalizedText = normalizeSearchText(text);
  if (normalizedText.includes(query)) return 2;

  const queryTerms = query.split(/\s+/).filter(Boolean);
  if (queryTerms.length === 0) return 0;

  const matchingTerms = queryTerms.filter((term) => normalizedText.includes(term));
  return matchingTerms.length / queryTerms.length;
}

function cosineSimilarity(left: EmbeddingVector, right: EmbeddingVector): number {
  assertCompatibleScoringVectors(left, right);

  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function assertCompatibleScoringVectors(left: EmbeddingVector, right: EmbeddingVector): void {
  assertVector(left, "query embedding");
  assertVector(right, "stored embedding");
  if (left.length !== right.length) {
    throw new Error(`embedding dimension mismatch: query=${left.length} stored=${right.length}`);
  }
}

function assertPresent(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function assertEmbeddingVectors(
  embeddings: EmbeddingVector[],
  expectedCount: number,
  context: string
): void {
  if (embeddings.length !== expectedCount) {
    throw new Error(
      `embedding provider returned ${embeddings.length} embeddings for ${expectedCount} ${context}`
    );
  }

  embeddings.forEach((embedding, index) => {
    assertVector(embedding, `${context} ${index}`);
  });
}

function assertVector(embedding: EmbeddingVector, context: string): void {
  if (!Array.isArray(embedding)) {
    throw new Error(`embedding for ${context} is not a vector`);
  }
  if (embedding.length === 0) {
    throw new Error(`embedding for ${context} is empty`);
  }
  if (!embedding.every((value) => Number.isFinite(value))) {
    throw new Error(`embedding for ${context} contains a non-finite value`);
  }
}

function toSearchHit(chunk: KnowledgeChunk): KnowledgeSearchHit {
  return {
    chunk_id: chunk.chunk_id,
    document_id: chunk.document_id,
    client_id: chunk.client_id,
    chunk_index: chunk.chunk_index,
    text: chunk.text
  };
}

function normalizeId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (const char of text) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
