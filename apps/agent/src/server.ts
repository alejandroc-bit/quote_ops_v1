import { createServer, type ServerResponse } from "node:http";
import pg from "pg";
import { startSentinel } from "./sentinel/index.js";

const port = Number(process.env.PORT || 8081);
const startedAt = new Date().toISOString();
let sentinelActive = false;
if (process.env.DATABASE_URL) {
  const { Pool } = pg;
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  startSentinel({ db, env: process.env });
  sentinelActive = true;
}

const server = createServer((req, res) => {
  if (req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "quoteops-agent",
      started_at: startedAt
    });
    return;
  }

  sendJson(res, 200, {
    ok: true,
    service: "quoteops-agent",
    mode: sentinelActive ? "sentinel" : "idle-runtime",
    started_at: startedAt
  });
});

server.listen(port, () => {
  console.log(`QuoteOps agent runtime listening on :${port}`);
});

function sendJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>): void {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}
