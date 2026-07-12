import { afterEach, describe, expect, it, vi } from "vitest";
import { listRuns, mergeStep, stepDurationMs, type StepEvent } from "./runsApi";

function step(partial: Partial<StepEvent> & Pick<StepEvent, "seq" | "node" | "status" | "ts">): StepEvent {
  return { run_id: "run-1", summary: null, ...partial };
}

describe("stepDurationMs", () => {
  const steps: StepEvent[] = [
    step({ seq: 1, node: "classify", status: "start", ts: "2026-07-11T10:00:00.000Z" }),
    step({ seq: 2, node: "classify", status: "end", ts: "2026-07-11T10:00:01.500Z" }),
    step({ seq: 3, node: "quote", status: "start", ts: "2026-07-11T10:00:02.000Z" }),
    step({ seq: 4, node: "quote", status: "error", ts: "2026-07-11T10:00:04.000Z" })
  ];

  it("pairs end with the prior start of the same node", () => {
    expect(stepDurationMs(steps, 1)).toBe(1500);
    expect(stepDurationMs(steps, 3)).toBe(2000);
  });

  it("returns null for start events and unpaired ends", () => {
    expect(stepDurationMs(steps, 0)).toBeNull();
    expect(stepDurationMs([steps[1]], 0)).toBeNull();
  });
});

describe("mergeStep", () => {
  it("appends new steps in seq order and dedupes by seq", () => {
    const base = [step({ seq: 2, node: "a", status: "start", ts: "2026-07-11T10:00:00Z" })];
    const merged = mergeStep(base, step({ seq: 1, node: "b", status: "start", ts: "2026-07-11T09:59:00Z" }));
    expect(merged.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(mergeStep(merged, step({ seq: 2, node: "a", status: "start", ts: "x" }))).toBe(merged);
  });
});

describe("listRuns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns [] when the runs endpoint is not deployed yet (404)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })));
    await expect(listRuns()).resolves.toEqual([]);
  });

  it("returns runs from the envelope", async () => {
    const payload = { runs: [{ run_id: "r1", channel: "email", status: "completed", summary: null, created_at: "", updated_at: "" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 })));
    await expect(listRuns()).resolves.toEqual(payload.runs);
  });
});
