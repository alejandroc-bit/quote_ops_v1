import type { SentinelStats } from "./collect.js";

export async function submitSentinelReport(args: {
  controlPlaneUrl: string;
  token: string;
  installationId: string;
  weekStart: string;
  bodyMd: string;
  stats: SentinelStats;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const { controlPlaneUrl, token, installationId, weekStart, bodyMd, stats } = args;
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${controlPlaneUrl.replace(/\/+$/, "")}/api/sentinel/reports`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      installation_id: installationId,
      week_start: weekStart,
      body_md: bodyMd,
      stats: {
        runs: stats.runs,
        errors: stats.errors,
        interrupts: stats.interrupts,
        avg_node_ms: stats.avg_node_ms_overall
      }
    })
  });
  if (!response.ok) {
    throw new Error(`Sentinel report submit failed: HTTP ${response.status}`);
  }
}
