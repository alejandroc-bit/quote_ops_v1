import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IntakeAttachment, IntakeEmail } from "./extractRfq.js";
import type { MailboxOutcome, MailboxSource } from "./mailbox.js";

const DEFAULT_BASE_URL = "https://api.resend.com";
// ponytail: processed-id ledger capped in memory+disk; a real cursor API when Resend ships one
const MAX_TRACKED_IDS = 1000;

export type ResendMailboxOptions = {
  apiKey: string;
  /** JSON file that records already-processed inbound email ids across polls. */
  statePath: string;
  /** When set, only inbound emails addressed to this mailbox are picked up. */
  intakeAddress?: string | null;
  baseUrl?: string;
  fetch?: typeof fetch;
};

type ResendListItem = {
  id: string;
  to?: string[];
  from?: string;
  subject?: string;
};

type ResendReceivedEmail = {
  id: string;
  from?: string;
  subject?: string;
  text?: string | null;
  html?: string | null;
  created_at?: string;
  message_id?: string | null;
  headers?: Record<string, string>;
  attachments?: Array<{ id: string; filename?: string; content_type?: string }>;
};

type ProcessedState = { processed: Record<string, MailboxOutcome> };

/**
 * Inbound mail via the Resend Receiving API (client registers their domain in
 * Resend and points MX there). Polls GET /emails/receiving — same MailboxSource
 * contract as the IMAP adapters, so the appliance needs no public webhook URL.
 */
export class ResendMailbox implements MailboxSource {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly options: ResendMailboxOptions) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = options.fetch ?? fetch;
  }

  async listUnread(): Promise<string[]> {
    const body = (await this.request("/emails/receiving")) as { data?: ResendListItem[] };
    const state = await this.loadState();
    const intake = this.options.intakeAddress?.trim().toLowerCase() || null;
    return (body.data ?? [])
      .filter((item) => item.id && !(item.id in state.processed))
      .filter(
        (item) =>
          !intake ||
          (item.to ?? []).some((address) => extractAddress(address) === intake)
      )
      .map((item) => item.id);
  }

  async fetch(uid: string): Promise<IntakeEmail> {
    const email = (await this.request(
      `/emails/receiving/${encodeURIComponent(uid)}`
    )) as ResendReceivedEmail;

    const attachments: IntakeAttachment[] = [];
    for (const attachment of email.attachments ?? []) {
      attachments.push(await this.fetchAttachment(uid, attachment));
    }

    const headerFrom = email.headers?.from ?? email.headers?.From ?? "";
    return {
      message_id: uid,
      rfc_message_id: email.message_id?.trim() || null,
      references: [],
      from_name: extractDisplayName(headerFrom) || extractAddress(email.from ?? ""),
      from_email: extractAddress(email.from ?? ""),
      subject: email.subject ?? "",
      body_text: email.text?.trim() ? email.text : stripHtml(email.html ?? ""),
      received_at: email.created_at ?? new Date().toISOString(),
      attachments
    };
  }

  async finish(uid: string, outcome: MailboxOutcome): Promise<void> {
    const state = await this.loadState();
    state.processed[uid] = outcome;
    const ids = Object.keys(state.processed);
    for (const stale of ids.slice(0, Math.max(0, ids.length - MAX_TRACKED_IDS))) {
      delete state.processed[stale];
    }
    await mkdir(dirname(this.options.statePath), { recursive: true });
    await writeFile(this.options.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  async close(): Promise<void> {
    // stateless HTTP client — nothing to close
  }

  private async fetchAttachment(
    emailId: string,
    attachment: { id: string; filename?: string; content_type?: string }
  ): Promise<IntakeAttachment> {
    const detail = (await this.request(
      `/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachment.id)}`
    )) as { download_url?: string; filename?: string; content_type?: string };
    if (!detail.download_url) {
      throw new Error(`Resend attachment ${attachment.id} has no download_url`);
    }
    const response = await this.fetchFn(detail.download_url);
    if (!response.ok) {
      throw new Error(`Resend attachment download failed: HTTP ${response.status}`);
    }
    return {
      filename: detail.filename ?? attachment.filename ?? "attachment",
      mimeType: detail.content_type ?? attachment.content_type ?? "application/octet-stream",
      content: Buffer.from(await response.arrayBuffer())
    };
  }

  private async request(path: string): Promise<unknown> {
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.options.apiKey}` }
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Resend API ${path} responded HTTP ${response.status}: ${raw.slice(0, 200)}`);
    }
    return JSON.parse(raw);
  }

  private async loadState(): Promise<ProcessedState> {
    try {
      const raw = await readFile(this.options.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ProcessedState>;
      return { processed: parsed.processed && typeof parsed.processed === "object" ? parsed.processed : {} };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { processed: {} };
      }
      throw error;
    }
  }
}

/** "Acme <a@b.c>" → "a@b.c"; bare addresses pass through. */
function extractAddress(value: string): string {
  const match = value.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (match?.[1] ?? value).trim().toLowerCase();
}

function extractDisplayName(value: string): string {
  const match = value.match(/^\s*"?([^"<]*?)"?\s*</);
  return match?.[1]?.trim() ?? "";
}

function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
