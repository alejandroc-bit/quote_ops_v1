import { Pool } from "pg";
import {
  createInMemoryKnowledgeRepository,
  type KnowledgeChunk,
  type KnowledgeCloudSafeStatus,
  type KnowledgeDocumentRecord,
  type KnowledgeRepository,
  type KnowledgeSearchHit
} from "@quoteops/knowledge";
import { schemaSql } from "./schema.js";

/**
 * Knowledge repository backed by the appliance's local Postgres, using the
 * pre-existing knowledge_documents / knowledge_chunks tables. Embeddings and
 * chunk text stay on the client machine — they are never sent to the cloud.
 * Cosine ranking runs in Node over the client's chunks (the criteria corpus is
 * small); upgrade to pgvector if it ever grows large.
 */
export class PostgresKnowledgeRepository implements KnowledgeRepository {
  private readonly pool: Pool;
  private schemaReady: Promise<void> | null = null;
  private documentsCount = 0;
  private chunksCount = 0;

  constructor(options: { databaseUrl: string }) {
    this.pool = new Pool({ connectionString: options.databaseUrl });
  }

  async upsertDocument(input: KnowledgeDocumentRecord): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `insert into knowledge_documents
         (document_id, client_id, filename, content_type, checksum, created_at)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (document_id) do update set
         filename = excluded.filename,
         content_type = excluded.content_type,
         checksum = excluded.checksum`,
      [
        input.document_id,
        input.client_id,
        input.filename,
        input.content_type,
        input.document_id,
        input.created_at
      ]
    );
  }

  async upsertChunks(chunks: KnowledgeChunk[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.ensureSchema();
    const documentIds = [...new Set(chunks.map((chunk) => chunk.document_id))];
    await this.pool.query("delete from knowledge_chunks where document_id = any($1::text[])", [
      documentIds
    ]);
    for (const chunk of chunks) {
      await this.pool.query(
        `insert into knowledge_chunks
           (chunk_id, document_id, client_id, chunk_index, chunk_text, embedding)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (chunk_id) do update set
           chunk_text = excluded.chunk_text,
           embedding = excluded.embedding`,
        [
          chunk.chunk_id,
          chunk.document_id,
          chunk.client_id,
          chunk.chunk_index,
          chunk.text,
          JSON.stringify(chunk.embedding)
        ]
      );
    }
  }

  async search(input: {
    client_id: string;
    query: string;
    embedding: number[];
    k: number;
  }): Promise<KnowledgeSearchHit[]> {
    await this.ensureSchema();
    const result = await this.pool.query<{
      chunk_id: string;
      document_id: string;
      client_id: string;
      chunk_index: number;
      chunk_text: string;
      embedding: number[];
    }>(
      `select chunk_id, document_id, client_id, chunk_index, chunk_text, embedding
       from knowledge_chunks where client_id = $1`,
      [input.client_id]
    );
    // reuse the shared in-memory ranking so Postgres and tests score identically
    const ranker = createInMemoryKnowledgeRepository();
    await ranker.upsertChunks(
      result.rows.map((row) => ({
        chunk_id: row.chunk_id,
        document_id: row.document_id,
        client_id: row.client_id,
        chunk_index: row.chunk_index,
        text: row.chunk_text,
        embedding: Array.isArray(row.embedding) ? row.embedding : []
      }))
    );
    return ranker.search(input);
  }

  cloudSafeStatus(): KnowledgeCloudSafeStatus {
    return {
      knowledge_documents_count: this.documentsCount,
      knowledge_chunks_count: this.chunksCount,
      retriever_health: this.documentsCount > 0 ? "ok" : "unknown"
    };
  }

  /** Live counts for the GET /api/knowledge/status endpoint. */
  async countStatus(clientId?: string): Promise<KnowledgeCloudSafeStatus> {
    await this.ensureSchema();
    const where = clientId ? "where client_id = $1" : "";
    const params = clientId ? [clientId] : [];
    const docs = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from knowledge_documents ${where}`,
      params
    );
    const chunks = await this.pool.query<{ n: string }>(
      `select count(*)::text as n from knowledge_chunks ${where}`,
      params
    );
    this.documentsCount = Number(docs.rows[0]?.n ?? 0);
    this.chunksCount = Number(chunks.rows[0]?.n ?? 0);
    return this.cloudSafeStatus();
  }

  private async ensureSchema(): Promise<void> {
    this.schemaReady ??= this.pool.query(schemaSql).then(() => undefined);
    return this.schemaReady;
  }
}
