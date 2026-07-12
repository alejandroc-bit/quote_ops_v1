import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AgentMailboxConfig } from "@quoteops/connectors";
import type { IntakeAttachment, IntakeEmail } from "./extractRfq.js";

export type MailboxOutcome = "processed" | "ignored" | "error";

/**
 * A mail account the client assigns to the agent as an RFQ intake tool. Any
 * provider that speaks IMAP works — Gmail, Outlook/Microsoft 365, or a custom
 * server — so the appliance is not tied to one vendor.
 */
export interface MailboxSource {
  listUnread(): Promise<string[]>;
  fetch(uid: string): Promise<IntakeEmail>;
  finish(uid: string, outcome: MailboxOutcome): Promise<void>;
  close(): Promise<void>;
}

type ImapAuth = { user: string; pass: string } | { user: string; accessToken: string };

const PROVIDER_PRESETS: Record<
  AgentMailboxConfig["provider"],
  { host: string; port: number } | null
> = {
  gmail: { host: "imap.gmail.com", port: 993 },
  outlook: { host: "outlook.office365.com", port: 993 },
  imap: null
};

export function mailboxCredentialsPresent(
  config: AgentMailboxConfig,
  env: NodeJS.ProcessEnv
): boolean {
  if (!optional(env.MAILBOX_USER)) return false;
  if (config.auth === "password") return Boolean(optional(env.MAILBOX_PASSWORD));
  return (
    Boolean(optional(env.MAILBOX_OAUTH_CLIENT_ID)) &&
    Boolean(optional(env.MAILBOX_OAUTH_CLIENT_SECRET)) &&
    Boolean(optional(env.MAILBOX_OAUTH_REFRESH_TOKEN))
  );
}

/**
 * Resolves connection details from the mailbox config plus the appliance
 * secrets env and opens an IMAP session. OAuth2 providers (Gmail, Outlook) get
 * a fresh access token; password auth uses an app password.
 */
export async function openConfiguredMailbox({
  config,
  env,
  fetch: fetchFn = fetch
}: {
  config: AgentMailboxConfig;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}): Promise<MailboxSource> {
  const user = required(env.MAILBOX_USER, "MAILBOX_USER");
  const preset = PROVIDER_PRESETS[config.provider];
  const host = preset?.host ?? required(env.MAILBOX_IMAP_HOST ?? config.imap_host, "MAILBOX_IMAP_HOST");
  const port = preset?.port ?? Number(env.MAILBOX_IMAP_PORT ?? config.imap_port ?? 993);

  const auth: ImapAuth =
    config.auth === "password"
      ? { user, pass: required(env.MAILBOX_PASSWORD, "MAILBOX_PASSWORD") }
      : { user, accessToken: await resolveMailboxOAuthAccessToken(config, env, fetchFn) };

  const client = new ImapFlow({ host, port, secure: port === 993, auth, logger: false });
  await client.connect();
  await client.mailboxOpen("INBOX");
  return new ImapMailbox(client, config.processed_mailbox);
}

class ImapMailbox implements MailboxSource {
  constructor(
    private readonly client: ImapFlow,
    private readonly processedMailbox: string | null
  ) {}

  async listUnread(): Promise<string[]> {
    const uids = await this.client.search({ seen: false }, { uid: true });
    return (uids || []).map((uid) => String(uid));
  }

  async fetch(uid: string): Promise<IntakeEmail> {
    const message = await this.client.fetchOne(uid, { source: true }, { uid: true });
    if (!message || !message.source) {
      throw new Error(`mailbox message ${uid} could not be fetched`);
    }
    return parseIntakeEmailMessage(uid, message.source);
  }

  async finish(uid: string, outcome: MailboxOutcome): Promise<void> {
    // \Seen stops reprocessing; flag errors so they surface for manual review
    await this.client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
    if (outcome === "error") {
      await this.client.messageFlagsAdd(uid, ["\\Flagged"], { uid: true });
    }
    if (outcome === "processed" && this.processedMailbox) {
      await this.client.messageMove(uid, this.processedMailbox, { uid: true }).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.client.logout().catch(() => undefined);
  }
}

export async function parseIntakeEmailMessage(
  uid: string,
  source: Buffer | string
): Promise<IntakeEmail> {
    const parsed = await simpleParser(source);
    const fromAddress = parsed.from?.value?.[0];
    const attachments: IntakeAttachment[] = (parsed.attachments ?? [])
      .filter((attachment) => attachment.content)
      .map((attachment) => ({
        filename: attachment.filename ?? "attachment",
        mimeType: attachment.contentType ?? "application/octet-stream",
        content: attachment.content as Buffer
      }));

    return {
      message_id: uid,
      rfc_message_id: parsed.messageId?.trim() || null,
      references: normalizeReferences(parsed.references),
      from_name: fromAddress?.name?.trim() || fromAddress?.address || "",
      from_email: (fromAddress?.address ?? "").trim().toLowerCase(),
      subject: parsed.subject ?? "",
      body_text: parsed.text ?? "",
      received_at: (parsed.date ?? new Date()).toISOString(),
      attachments
    };
}

function normalizeReferences(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s+/) : [];
  return values.map((item) => String(item).trim()).filter(Boolean);
}

export async function resolveMailboxOAuthAccessToken(
  config: AgentMailboxConfig,
  env: NodeJS.ProcessEnv,
  fetchFn: typeof fetch
): Promise<string> {
  const tokenUrl =
    config.provider === "outlook"
      ? `https://login.microsoftonline.com/${optional(env.MAILBOX_OAUTH_TENANT) ?? "common"}/oauth2/v2.0/token`
      : optional(env.MAILBOX_OAUTH_TOKEN_URL) ?? "https://oauth2.googleapis.com/token";

  const params = new URLSearchParams({
    client_id: required(env.MAILBOX_OAUTH_CLIENT_ID, "MAILBOX_OAUTH_CLIENT_ID"),
    client_secret: required(env.MAILBOX_OAUTH_CLIENT_SECRET, "MAILBOX_OAUTH_CLIENT_SECRET"),
    refresh_token: required(env.MAILBOX_OAUTH_REFRESH_TOKEN, "MAILBOX_OAUTH_REFRESH_TOKEN"),
    grant_type: "refresh_token"
  });
  if (config.provider === "outlook") {
    params.set(
      "scope",
      "https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send offline_access"
    );
  }

  const response = await fetchFn(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  const body = (await response.json()) as { access_token?: string; error?: string };
  if (!response.ok || !body.access_token) {
    throw new Error(`mailbox OAuth token refresh failed: ${body.error ?? response.status}`);
  }
  return body.access_token;
}

function optional(value: string | undefined): string | null {
  return value?.trim() ? value.trim() : null;
}

function required(value: string | undefined | null, name: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new Error(`mailbox intake requires ${name}`);
  }
  return trimmed;
}
