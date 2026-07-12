import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  buildSentinelReport,
  collectWeeklyStats,
  nextRunAt,
  redact,
  runSentinelOnce,
  startSentinel,
  submitSentinelReport,
  type SentinelChatModel,
  type SentinelStats
} from "../src/sentinel/index.js";

const SINCE = new Date("2026-07-01T00:00:00.000Z");

function fakePool(): Pool {
  const query = vi.fn(async (text: string) => {
    if (text.includes("FROM quote_runs")) {
      return { rows: [{ runs: 10, interrupts: 3 }] };
    }
    if (text.includes("count(*)::int AS errors")) {
      return { rows: [{ errors: 2 }] };
    }
    if (text.includes("DISTINCT summary")) {
      return {
        rows: [
          { summary: "TMS timeout contacting ops@nmx-transportes.mx" },
          { summary: "fallo en origen: Monterrey NL, destino: CDMX" }
        ]
      };
    }
    if (text.includes("ILIKE '%drift%'")) {
      return { rows: [{ drift: 4 }] };
    }
    if (text.includes("status IN ('start', 'end')")) {
      return {
        rows: [
          { run_id: "r1", node: "classify", status: "start", ts: "2026-07-02T10:00:00.000Z" },
          { run_id: "r1", node: "classify", status: "end", ts: "2026-07-02T10:00:01.000Z" },
          { run_id: "r2", node: "classify", status: "start", ts: "2026-07-03T10:00:00.000Z" },
          { run_id: "r2", node: "classify", status: "end", ts: "2026-07-03T10:00:03.000Z" },
          { run_id: "r1", node: "quote", status: "start", ts: "2026-07-02T10:00:01.000Z" },
          { run_id: "r1", node: "quote", status: "end", ts: "2026-07-02T10:00:01.500Z" },
          // start without matching end: must be ignored
          { run_id: "r3", node: "quote", status: "start", ts: "2026-07-04T10:00:00.000Z" }
        ]
      };
    }
    throw new Error(`unexpected query: ${text}`);
  });
  return { query } as unknown as Pool;
}

function stats(overrides: Partial<SentinelStats> = {}): SentinelStats {
  return {
    runs: 10,
    errors: 2,
    error_summaries: [],
    interrupts: 3,
    interrupt_rate: 0.3,
    avg_node_ms: { classify: 2000 },
    avg_node_ms_overall: 1500,
    drift_steps: 4,
    ...overrides
  };
}

describe("redact", () => {
  it("strips email addresses", () => {
    expect(redact("avisar a compras@nmx.mx del error")).toBe("avisar a [EMAIL_REDACTED] del error");
  });

  it("strips anything after origen/destino labels", () => {
    const out = redact("fallo en Origen: Monterrey NL, destino= CDMX Vallejo");
    expect(out).not.toContain("Monterrey");
    expect(out).not.toContain("CDMX");
    expect(out).toContain("Origen: [REDACTED]");
    expect(out).toContain("destino: [REDACTED]");
  });
});

describe("collectWeeklyStats", () => {
  it("aggregates runs, errors, interrupts, node averages and drift", async () => {
    const result = await collectWeeklyStats(fakePool(), SINCE);
    expect(result.runs).toBe(10);
    expect(result.interrupts).toBe(3);
    expect(result.interrupt_rate).toBeCloseTo(0.3);
    expect(result.errors).toBe(2);
    expect(result.drift_steps).toBe(4);
    expect(result.avg_node_ms).toEqual({ classify: 2000, quote: 500 });
    // (1000 + 3000 + 500) / 3
    expect(result.avg_node_ms_overall).toBe(1500);
  });

  it("redacts error summaries", async () => {
    const result = await collectWeeklyStats(fakePool(), SINCE);
    expect(result.error_summaries).toHaveLength(2);
    expect(result.error_summaries[0]).not.toContain("ops@nmx-transportes.mx");
    expect(result.error_summaries[1]).not.toContain("Monterrey");
    expect(result.error_summaries[1]).not.toContain("CDMX");
  });
});

describe("buildSentinelReport", () => {
  const scriptedLlm = (content: string): SentinelChatModel => ({
    invoke: vi.fn(async () => ({ content }))
  });

  it("returns the model's markdown", async () => {
    const llm = scriptedLlm("# Reporte semanal\nTodo estable.");
    const out = await buildSentinelReport({
      stats: stats(),
      llm,
      installationId: "inst-1",
      weekStart: "2026-07-01"
    });
    expect(out).toContain("Reporte semanal");
    const messages = (llm.invoke as ReturnType<typeof vi.fn>).mock.calls[0][0] as Array<[string, string]>;
    expect(messages[0][0]).toBe("system");
    expect(messages[0][1].toLowerCase()).toContain("prohibido");
    expect(messages[1][1]).toContain("Corridas: 10");
  });

  it("redacts leaked emails and route labels from model output", async () => {
    const out = await buildSentinelReport({
      stats: stats(),
      llm: scriptedLlm("Error visto por admin@cliente.mx en origen: Monterrey"),
      installationId: "inst-1",
      weekStart: "2026-07-01"
    });
    expect(out).not.toContain("admin@cliente.mx");
    expect(out).not.toContain("Monterrey");
  });
});

describe("submitSentinelReport", () => {
  it("POSTs the contract body with bearer token", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await submitSentinelReport({
      controlPlaneUrl: "https://cloud.example.com/",
      token: "tok-123",
      installationId: "inst-1",
      weekStart: "2026-07-01",
      bodyMd: "# ok",
      stats: stats(),
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.example.com/api/sentinel/reports");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(JSON.parse(init.body as string)).toEqual({
      installation_id: "inst-1",
      week_start: "2026-07-01",
      body_md: "# ok",
      stats: { runs: 10, errors: 2, interrupts: 3, avg_node_ms: 1500 }
    });
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    await expect(
      submitSentinelReport({
        controlPlaneUrl: "https://cloud.example.com",
        token: "tok",
        installationId: "i",
        weekStart: "2026-07-01",
        bodyMd: "x",
        stats: stats(),
        fetchImpl: fetchImpl as unknown as typeof fetch
      })
    ).rejects.toThrow("HTTP 500");
  });
});

describe("nextRunAt", () => {
  it("finds the next sunday 07:00 UTC", () => {
    // 2026-07-11 is a Saturday
    const now = new Date("2026-07-11T12:00:00.000Z");
    expect(nextRunAt(now, "sunday", 7).toISOString()).toBe("2026-07-12T07:00:00.000Z");
  });

  it("rolls a full week when the slot already passed today", () => {
    const now = new Date("2026-07-12T08:00:00.000Z"); // Sunday 08:00 > 07:00
    expect(nextRunAt(now, "sunday", 7).toISOString()).toBe("2026-07-19T07:00:00.000Z");
  });
});

describe("runSentinelOnce", () => {
  it("skips without crashing when control plane env is missing", async () => {
    const log = vi.fn();
    const result = await runSentinelOnce({ db: fakePool(), env: {}, log });
    expect(result).toBe("skipped");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skipping"));
  });

  it("collects, builds and submits end to end", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await runSentinelOnce({
      db: fakePool(),
      env: {
        QUOTEOPS_CONTROL_PLANE_URL: "https://cloud.example.com",
        QUOTEOPS_REGISTRATION_TOKEN: "tok-abc",
        QUOTEOPS_INSTALLATION_ID: "inst-9"
      },
      llm: { invoke: async () => ({ content: "# Semana estable" }) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-07-11T00:00:00.000Z")
    });
    expect(result).toBe("sent");
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.installation_id).toBe("inst-9");
    expect(body.week_start).toBe("2026-07-04");
    expect(body.body_md).toContain("Semana estable");
  });

  it("returns skipped instead of throwing when submit fails", async () => {
    const log = vi.fn();
    const result = await runSentinelOnce({
      db: fakePool(),
      env: {
        QUOTEOPS_CONTROL_PLANE_URL: "https://cloud.example.com",
        QUOTEOPS_REGISTRATION_TOKEN: "tok"
      },
      llm: { invoke: async () => ({ content: "x" }) },
      fetchImpl: (async () => new Response("boom", { status: 503 })) as unknown as typeof fetch,
      log
    });
    expect(result).toBe("skipped");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("run failed"));
  });
});

describe("startSentinel", () => {
  it("schedules on the configured day/hour and runs via timer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T12:00:00.000Z"));
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const handle = startSentinel({
      db: fakePool(),
      env: {
        QUOTEOPS_CONTROL_PLANE_URL: "https://cloud.example.com",
        QUOTEOPS_REGISTRATION_TOKEN: "tok",
        QUOTEOPS_SENTINEL_DAY: "sunday",
        QUOTEOPS_SENTINEL_HOUR: "7"
      },
      llm: { invoke: async () => ({ content: "ok" }) },
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(19 * 60 * 60 * 1000); // to Sunday 07:00
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    handle.stop();
    vi.useRealTimers();
  });
});
