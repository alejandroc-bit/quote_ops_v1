import type { Pool } from "pg";
import { collectWeeklyStats } from "./collect.js";
import { buildSentinelReport, type SentinelChatModel } from "./report.js";
import { submitSentinelReport } from "./submit.js";

export { collectWeeklyStats, redact, type SentinelStats } from "./collect.js";
export { buildSentinelReport, type SentinelChatModel } from "./report.js";
export { submitSentinelReport } from "./submit.js";

const DAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function nextRunAt(now: Date, day: string, hour: number): Date {
  const target = DAY_INDEX[day.toLowerCase()] ?? 0;
  const next = new Date(now);
  next.setUTCHours(hour, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + ((target - next.getUTCDay() + 7) % 7));
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 7);
  }
  return next;
}

export interface SentinelOptions {
  db: Pool;
  env: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  llm?: SentinelChatModel;
  now?: () => Date;
  log?: (message: string) => void;
}

async function resolveLlm(options: SentinelOptions): Promise<SentinelChatModel> {
  if (options.llm) return options.llm;
  const { env } = options;
  // Contract: shared factory in apps/agent/src/llm/chatModel.ts (built in parallel).
  const { createChatModel } = await import("../llm/chatModel.js");
  return createChatModel(
    {
      provider: env.QUOTEOPS_LLM_PROVIDER ?? "openrouter",
      model_name: env.QUOTEOPS_LLM_MODEL ?? "openai/gpt-4o-mini",
      api_key_env: env.QUOTEOPS_LLM_API_KEY_ENV ?? "OPENROUTER_API_KEY"
    },
    env
  ) as unknown as SentinelChatModel;
}

/** Runs one sentinel cycle. Never throws — the appliance must not crash on report failures. */
export async function runSentinelOnce(options: SentinelOptions): Promise<"sent" | "skipped"> {
  const log = options.log ?? ((m: string) => console.error(m));
  const { env } = options;
  const controlPlaneUrl = env.QUOTEOPS_CONTROL_PLANE_URL;
  const token = env.QUOTEOPS_REGISTRATION_TOKEN;
  if (!controlPlaneUrl || !token) {
    log("sentinel: QUOTEOPS_CONTROL_PLANE_URL or QUOTEOPS_REGISTRATION_TOKEN missing, skipping report");
    return "skipped";
  }
  try {
    const now = (options.now ?? (() => new Date()))();
    const since = new Date(now.getTime() - WEEK_MS);
    const weekStart = since.toISOString().slice(0, 10);
    const installationId = env.QUOTEOPS_INSTALLATION_ID ?? "unknown";
    const stats = await collectWeeklyStats(options.db, since);
    const llm = await resolveLlm(options);
    const bodyMd = await buildSentinelReport({ stats, llm, installationId, weekStart });
    await submitSentinelReport({
      controlPlaneUrl,
      token,
      installationId,
      weekStart,
      bodyMd,
      stats,
      fetchImpl: options.fetchImpl
    });
    return "sent";
  } catch (error) {
    log(`sentinel: run failed: ${error instanceof Error ? error.message : String(error)}`);
    return "skipped";
  }
}

/** Weekly setTimeout chain (no cron dep). Day/hour from QUOTEOPS_SENTINEL_DAY / QUOTEOPS_SENTINEL_HOUR. */
export function startSentinel(options: SentinelOptions): { stop: () => void } {
  const day = options.env.QUOTEOPS_SENTINEL_DAY ?? "sunday";
  const hour = Number(options.env.QUOTEOPS_SENTINEL_HOUR ?? 7);
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;
    const now = (options.now ?? (() => new Date()))();
    const delay = nextRunAt(now, day, hour).getTime() - now.getTime();
    timer = setTimeout(() => {
      void runSentinelOnce(options).finally(schedule);
    }, delay);
    timer.unref?.();
  };
  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  };
}
