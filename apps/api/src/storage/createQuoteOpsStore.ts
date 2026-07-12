import { createInMemoryQuoteOpsStore } from "./InMemoryQuoteOpsStore.js";
import { PostgresQuoteOpsStore } from "./PostgresQuoteOpsStore.js";
import type { QuoteOpsStore } from "./QuoteOpsStore.js";

export function createQuoteOpsStore(env: NodeJS.ProcessEnv = process.env): QuoteOpsStore {
  if (env.DATABASE_URL) {
    return new PostgresQuoteOpsStore({ databaseUrl: env.DATABASE_URL });
  }
  return createInMemoryQuoteOpsStore();
}
