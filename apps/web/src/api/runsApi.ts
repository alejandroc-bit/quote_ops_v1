export type RunSummary = {
  run_id: string;
  channel: string;
  status: string;
  summary: string | null;
  created_at: string;
  updated_at: string;
};

export type StepEvent = {
  run_id: string;
  seq: number;
  node: string;
  status: "start" | "end" | "error";
  summary: string | null;
  data?: unknown;
  ts: string;
};

export type RunDetail = {
  run: RunSummary;
  steps: StepEvent[];
};

const API_BASE_URL = getApiBaseUrl();

export async function listRuns(limit = 50): Promise<RunSummary[]> {
  const body = await runsRequest(`/api/runs?limit=${limit}`);
  // ponytail: backend built in parallel; 404 = endpoint not deployed yet → empty state
  if (body === null) return [];
  return (body as { runs: RunSummary[] }).runs ?? [];
}

export async function getRun(runId: string): Promise<RunDetail | null> {
  const body = await runsRequest(`/api/runs/${encodeURIComponent(runId)}`);
  return body as RunDetail | null;
}

export function runStreamUrl(runId: string): string {
  return `${API_BASE_URL}/api/runs/${encodeURIComponent(runId)}/stream`;
}

/** Adds `steps[index]` (an incoming step) only if its seq is not already present, keeping seq order. */
export function mergeStep(steps: StepEvent[], incoming: StepEvent): StepEvent[] {
  if (steps.some((step) => step.seq === incoming.seq)) return steps;
  return [...steps, incoming].sort((a, b) => a.seq - b.seq);
}

/** Duration in ms for an 'end'/'error' event, paired with the latest prior 'start' of the same node. */
export function stepDurationMs(steps: StepEvent[], index: number): number | null {
  const step = steps[index];
  if (!step || step.status === "start") return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = steps[i];
    if (candidate.node === step.node && candidate.status === "start") {
      const ms = Date.parse(step.ts) - Date.parse(candidate.ts);
      return Number.isFinite(ms) ? ms : null;
    }
  }
  return null;
}

async function runsRequest(path: string): Promise<unknown | null> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (response.status === 404) return null;
  const body = await response.text();
  const parsed = body ? JSON.parse(body) : null;

  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "message" in parsed
        ? String((parsed as { message: unknown }).message)
        : `QuoteOps API request failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return parsed;
}

function getApiBaseUrl(): string {
  if (typeof window === "undefined") return "";
  const runtimeBase = (window as unknown as { __QUOTEOPS_API_BASE_URL__?: string })
    .__QUOTEOPS_API_BASE_URL__;
  return runtimeBase ? runtimeBase.replace(/\/$/, "") : "";
}
