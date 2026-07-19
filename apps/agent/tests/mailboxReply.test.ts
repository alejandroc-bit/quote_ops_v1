import { describe, expect, it, vi } from "vitest";
import type { AgentMailboxConfig } from "@quoteops/connectors";
import {
  buildMimeMessage,
  createMailboxReplyChannel,
  createResendReplyChannel,
  sendSmtpMessage,
  SmtpResponseQueue,
  type SmtpConnection,
  type SmtpConnector,
  type SmtpSendInput
} from "../src/channels/channelAdapters.js";

const gmail: AgentMailboxConfig = {
  provider: "gmail",
  auth: "password",
  processed_mailbox: null,
  poll_interval_ms: 60000,
  imap_host: null,
  imap_port: null
};

describe("provider-native mailbox reply channel", () => {
  it("uses Gmail SMTP with configured mailbox credentials and a MIME PDF attachment", async () => {
    const sent: unknown[] = [];
    const channel = createMailboxReplyChannel({
      config: gmail,
      env: { MAILBOX_USER: "quotes@example.com", MAILBOX_PASSWORD: "app-password" },
      sendSmtp: async (input) => { sent.push(input); }
    });

    await channel.send({
      to: "buyer@example.com",
      subject: "Quote",
      body_md: "Attached",
      attachments: [{ filename: "quote.pdf", content: Buffer.from("PDF"), content_type: "application/pdf" }]
    });

    expect(sent).toEqual([
      expect.objectContaining({
        connection: { host: "smtp.gmail.com", port: 465, secure: true, startTls: false },
        auth: { type: "password", user: "quotes@example.com", password: "app-password" },
        envelope: { from: "quotes@example.com", to: "buyer@example.com" },
        raw: expect.stringContaining("Content-Type: application/pdf")
      })
    ]);
    expect((sent[0] as { raw: string }).raw).toContain(Buffer.from("PDF").toString("base64"));
  });

  it("refreshes Outlook OAuth and uses STARTTLS SMTP with XOAUTH2", async () => {
    const sent: unknown[] = [];
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: "oauth-access" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    const channel = createMailboxReplyChannel({
      config: { ...gmail, provider: "outlook", auth: "oauth2" },
      env: {
        MAILBOX_USER: "quotes@example.com",
        MAILBOX_OAUTH_CLIENT_ID: "client",
        MAILBOX_OAUTH_CLIENT_SECRET: "secret",
        MAILBOX_OAUTH_REFRESH_TOKEN: "refresh",
        MAILBOX_OAUTH_TENANT: "tenant"
      },
      fetch: fetchImpl as unknown as typeof fetch,
      sendSmtp: async (input) => { sent.push(input); }
    });

    await channel.send({ to: "buyer@example.com", subject: "Quote", body_md: "Approved" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
      expect.objectContaining({ method: "POST" })
    );
    const tokenBody = fetchImpl.mock.calls[0]?.[1]?.body;
    expect(String(tokenBody)).toContain("SMTP.Send");
    expect(sent).toEqual([
      expect.objectContaining({
        connection: { host: "smtp.office365.com", port: 587, secure: false, startTls: true },
        auth: { type: "oauth2", user: "quotes@example.com", accessToken: "oauth-access" }
      })
    ]);
  });

  it("sends via the Resend HTTP API with base64 attachments and threaded headers", async () => {
    const posts: Array<{ url: string; init: RequestInit }> = [];
    const channel = createResendReplyChannel({
      env: { RESEND_API_KEY: "re_test_key", MAILBOX_USER: "cotizaciones@resaux.io" },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        posts.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ id: "sent-1" }), { status: 200 });
      }) as typeof fetch
    });

    await channel.send({
      to: "buyer@example.com",
      subject: "Cotización",
      body_md: "Tarifa: $18,669.44 MXN",
      reply_to: { message_id: "<abc@cliente.mx>", references: ["<root@cliente.mx>"] },
      attachments: [{ filename: "quote.pdf", content: Buffer.from("PDF"), content_type: "application/pdf" }]
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(String(posts[0]!.init.body));
    expect(body).toMatchObject({
      from: "cotizaciones@resaux.io",
      to: ["buyer@example.com"],
      subject: "Cotización",
      text: "Tarifa: $18,669.44 MXN",
      headers: {
        "In-Reply-To": "<abc@cliente.mx>",
        References: "<root@cliente.mx> <abc@cliente.mx>"
      }
    });
    expect(body.attachments).toEqual([
      { filename: "quote.pdf", content: Buffer.from("PDF").toString("base64"), content_type: "application/pdf" }
    ]);
    const headers = posts[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer re_test_key");
  });

  it("fails loudly when the Resend API rejects the send", async () => {
    const channel = createResendReplyChannel({
      env: { RESEND_API_KEY: "re_test_key", MAILBOX_USER: "cotizaciones@resaux.io" },
      fetch: (async () =>
        new Response(JSON.stringify({ message: "domain not verified" }), { status: 403 })) as typeof fetch
    });
    await expect(
      channel.send({ to: "buyer@example.com", subject: "Q", body_md: "x" })
    ).rejects.toThrow(/Resend send failed: HTTP 403/);
  });

  it("routes replies through a relay override (Resend) while the inbox stays on Gmail OAuth", async () => {
    const sent: unknown[] = [];
    const channel = createMailboxReplyChannel({
      config: { ...gmail, auth: "oauth2" },
      env: {
        MAILBOX_USER: "cotizaciones@resaux.io",
        MAILBOX_OAUTH_CLIENT_ID: "id",
        MAILBOX_OAUTH_CLIENT_SECRET: "secret",
        MAILBOX_OAUTH_REFRESH_TOKEN: "refresh",
        MAILBOX_SMTP_HOST: "smtp.resend.com",
        MAILBOX_SMTP_PORT: "465",
        MAILBOX_SMTP_USER: "resend",
        MAILBOX_SMTP_PASSWORD: "re_api_key"
      },
      sendSmtp: async (input) => { sent.push(input); }
    });

    await channel.send({ to: "buyer@example.com", subject: "Quote", body_md: "Hola" });

    expect(sent).toEqual([
      expect.objectContaining({
        connection: { host: "smtp.resend.com", port: 465, secure: true, startTls: false },
        auth: { type: "password", user: "resend", password: "re_api_key" },
        envelope: { from: "cotizaciones@resaux.io", to: "buyer@example.com" }
      })
    ]);
  });

  it("fails explicitly for custom IMAP when SMTP settings are absent", () => {
    expect(() =>
      createMailboxReplyChannel({
        config: { ...gmail, provider: "imap" },
        env: { MAILBOX_USER: "quotes@example.com", MAILBOX_PASSWORD: "password" }
      })
    ).toThrow("mailbox_smtp_unsupported:MAILBOX_SMTP_HOST");
  });

  it("emits sanitized threaded reply headers from intake metadata", () => {
    const raw = buildMimeMessage({
      from: "quotes@example.com",
      to: "buyer@example.com",
      subject: "Re: Freight quote\r\nBcc: attacker@example.com",
      body_md: "Attached",
      reply_to: {
        message_id: "<rfq-123@example.com>\r\nX-Bad: yes",
        references: ["<older@example.com>"],
        subject: "Freight quote"
      },
      attachments: [
        { filename: "quote.pdf", content: Buffer.from("PDF"), content_type: "application/pdf" }
      ]
    });

    expect(raw).toContain("Subject: Re: Freight quote  Bcc: attacker@example.com");
    expect(raw).toContain("In-Reply-To: <rfq-123@example.com>  X-Bad: yes");
    expect(raw).toContain("References: <older@example.com> <rfq-123@example.com>  X-Bad: yes");
    expect(raw).not.toContain("\r\nBcc: attacker@example.com\r\n");
    expect(raw).not.toContain("\r\nX-Bad: yes\r\n");
  });

  it("runs multiline EHLO, AUTH LOGIN, DATA, and attachment completion over a scripted connection", async () => {
    const connection = new ScriptedSmtpConnection([
      "220 smtp ready\r\n",
      "250-smtp.example\r\n250 AUTH LOGIN\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      "235 authenticated\r\n",
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "354 send data\r\n",
      "250 queued\r\n",
      "221 bye\r\n"
    ]);
    const raw = buildMimeMessage({
      from: "quotes@example.com",
      to: "buyer@example.com",
      subject: "Re: Freight quote",
      body_md: "Attached",
      reply_to: {
        message_id: "<rfq-123@example.com>",
        references: ["<older@example.com>"],
        subject: "Freight quote"
      },
      attachments: [{ filename: "quote.pdf", content: Buffer.from("PDF"), content_type: "application/pdf" }]
    });

    await sendSmtpMessage(smtpInput({ raw }), async () => connection);

    expect(connection.writes).toContain("EHLO quoteops.local\r\n");
    expect(connection.writes).toContain("AUTH LOGIN\r\n");
    expect(connection.writes).toContain(`${Buffer.from("quotes@example.com").toString("base64")}\r\n`);
    expect(connection.writes).toContain("DATA\r\n");
    expect(connection.writes.join(""))
      .toContain("In-Reply-To: <rfq-123@example.com>");
    expect(connection.writes.join("")).toContain("Content-Type: application/pdf");
    expect(connection.closed).toBe(true);
  });

  it("runs STARTTLS and XOAUTH2 on a scripted Outlook connection", async () => {
    const plain = new ScriptedSmtpConnection([
      "220 smtp ready\r\n",
      "250-smtp.office365.com\r\n250 STARTTLS\r\n",
      "220 begin tls\r\n"
    ]);
    const secured = new ScriptedSmtpConnection([
      "250-smtp.office365.com\r\n250 AUTH XOAUTH2\r\n",
      "235 authenticated\r\n",
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "354 send data\r\n",
      "250 queued\r\n",
      "221 bye\r\n"
    ]);
    plain.secured = secured;
    const input = smtpInput({
      connection: { host: "smtp.office365.com", port: 587, secure: false, startTls: true },
      auth: { type: "oauth2", user: "quotes@example.com", accessToken: "token" }
    });

    await sendSmtpMessage(input, async () => plain);

    expect(plain.writes).toContain("STARTTLS\r\n");
    expect(secured.writes[0]).toBe("EHLO quoteops.local\r\n");
    expect(secured.writes.some((write) => write.startsWith("AUTH XOAUTH2 "))).toBe(true);
    expect(plain.closed).toBe(true);
    expect(secured.closed).toBe(true);
  });

  it("closes a failed scripted connection", async () => {
    const connection = new ScriptedSmtpConnection([new Error("socket failed")]);
    await expect(sendSmtpMessage(smtpInput(), async () => connection)).rejects.toThrow("socket failed");
    expect(connection.closed).toBe(true);
  });

  it("completes when SMTP responses arrive eagerly before reads are armed", async () => {
    const connection = new EagerBufferedConnection([
      "220 smtp ready\r\n",
      "250-smtp.example\r\n250 AUTH LOGIN\r\n",
      "334 username\r\n",
      "334 password\r\n",
      "235 authenticated\r\n",
      "250 sender ok\r\n",
      "250 recipient ok\r\n",
      "354 send data\r\n",
      "250 queued\r\n",
      "221 bye\r\n"
    ]);

    await sendSmtpMessage(smtpInput(), async () => connection);

    expect(connection.writes).toContain("DATA\r\n");
    expect(connection.closed).toBe(true);
  });
});

class ScriptedSmtpConnection implements SmtpConnection {
  readonly writes: string[] = [];
  closed = false;
  secured?: ScriptedSmtpConnection;

  constructor(private readonly responses: Array<string | Error>) {}

  async readResponse(): Promise<string> {
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("script exhausted");
    return response;
  }

  async write(value: string): Promise<void> { this.writes.push(value); }
  async startTls(): Promise<SmtpConnection> {
    if (!this.secured) throw new Error("missing scripted TLS connection");
    return this.secured;
  }
  async close(): Promise<void> { this.closed = true; }
}

function smtpInput(overrides: Partial<SmtpSendInput> = {}): SmtpSendInput {
  return {
    connection: { host: "smtp.gmail.com", port: 465, secure: true, startTls: false },
    auth: { type: "password", user: "quotes@example.com", password: "secret" },
    envelope: { from: "quotes@example.com", to: "buyer@example.com" },
    raw: "From: quotes@example.com\r\nTo: buyer@example.com\r\n\r\nBody",
    ...overrides
  };
}

class EagerBufferedConnection implements SmtpConnection {
  readonly writes: string[] = [];
  readonly queue = new SmtpResponseQueue();
  closed = false;

  constructor(responses: string[]) {
    this.queue.push(responses.join(""));
  }

  readResponse(): Promise<string> { return this.queue.read(); }
  async write(value: string): Promise<void> { this.writes.push(value); }
  async startTls(): Promise<SmtpConnection> { throw new Error("unexpected STARTTLS"); }
  async close(): Promise<void> { this.closed = true; this.queue.close(); }
}
