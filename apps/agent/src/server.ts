import { createServer, type ServerResponse } from "node:http";
import { startMailboxIntake } from "./intake/mailboxPoller.js";

const port = Number(process.env.PORT || 8081);
const startedAt = new Date().toISOString();
let mailboxIntakeActive = false;

void startMailboxIntake()
  .then((timer) => {
    mailboxIntakeActive = timer !== null;
  })
  .catch((error) => {
    console.error(
      `[mailbox-intake] failed to start: ${error instanceof Error ? error.message : error}`
    );
  });

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
    mode: mailboxIntakeActive ? "mailbox-intake" : "idle-runtime",
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
