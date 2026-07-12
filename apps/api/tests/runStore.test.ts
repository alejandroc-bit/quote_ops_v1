import { describe, expect, it } from "vitest";
import { createInMemoryQuoteOpsStore } from "../src/storage/InMemoryQuoteOpsStore.js";

describe("run tracing store", () => {
  it("creates, updates, lists, and reads traced runs and ordered steps", async () => {
    const store = createInMemoryQuoteOpsStore();
    await store.createRun({ run_id: "run-1", channel: "email", status: "running", summary: "start" });
    await store.appendStep({
      run_id: "run-1",
      seq: 2,
      node: "classify",
      status: "end",
      summary: "classified",
      ts: "2026-07-12T12:00:02.000Z"
    });
    await store.appendStep({
      run_id: "run-1",
      seq: 1,
      node: "classify",
      status: "start",
      summary: "classifying",
      ts: "2026-07-12T12:00:01.000Z"
    });
    await store.updateRunStatus("run-1", "done", "complete");

    expect(await store.listRuns(10)).toEqual([
      expect.objectContaining({ run_id: "run-1", channel: "email", status: "done" })
    ]);
    expect(await store.getRun("run-1")).toEqual(
      expect.objectContaining({ run_id: "run-1", summary: "complete" })
    );
    expect((await store.getSteps("run-1")).map((step) => step.seq)).toEqual([1, 2]);
  });

  it("atomically claims a waiting run only once", async () => {
    const store = createInMemoryQuoteOpsStore();
    await store.createRun({
      run_id: "run-claim",
      channel: "email",
      status: "waiting_approval",
      summary: "review"
    });

    expect(await store.claimRunForResume("run-claim")).toBe(true);
    expect(await store.claimRunForResume("run-claim")).toBe(false);
    expect((await store.getRun("run-claim"))?.status).toBe("running");
  });
});
