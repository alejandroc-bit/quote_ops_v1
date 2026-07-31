import { describe, expect, it, vi } from "vitest";
import { PostgresQuoteOpsStore } from "../src/storage/PostgresQuoteOpsStore.js";
import { schemaSql } from "../src/storage/schema.js";

describe("PostgresQuoteOpsStore agent approvals", () => {
  it("creates the quote-run audit table after its referenced parent table", () => {
    expect(schemaSql.indexOf("create table if not exists agent_approval_decisions")).toBeGreaterThan(
      schemaSql.indexOf("create table if not exists quote_runs")
    );
  });

  it("writes agent-run decisions to the quote_runs-backed audit table", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const store = new PostgresQuoteOpsStore({
      databaseUrl: "postgres://unused",
      pool: { query } as never
    });

    const claimed = await store.claimAgentRunForResume("run-agent-approval-audit", {
      action: "approve",
      email_sent: false,
      decided_at: "2026-07-20T08:00:00.000Z"
    });

    expect(claimed).toBe(true);
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("with claimed as"),
      [
        "run-agent-approval-audit",
        "approve",
        null,
        null,
        false,
        "2026-07-20T08:00:00.000Z"
      ]
    );
    expect(query.mock.calls[1][0]).toContain("insert into agent_approval_decisions");
    expect(query.mock.calls[1][0]).toContain("update quote_runs");
  });
});
