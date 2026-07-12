import net from "node:net";
import tls from "node:tls";
import type { AgentMailboxConfig } from "@quoteops/connectors";
import type { Channel } from "../graph/types.js";
import { resolveMailboxOAuthAccessToken } from "../intake/mailbox.js";

export type SmtpSendInput = {
  connection: { host: string; port: number; secure: boolean; startTls: boolean };
  auth:
    | { type: "password"; user: string; password: string }
    | { type: "oauth2"; user: string; accessToken: string };
  envelope: { from: string; to: string };
  raw: string;
};

export type SmtpSender = (input: SmtpSendInput) => Promise<void>;

export function createMailboxReplyChannel({
  config,
  env,
  fetch: fetchImpl = fetch,
  sendSmtp = sendSmtpMessage
}: {
  config: AgentMailboxConfig;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sendSmtp?: SmtpSender;
}): Channel {
  const connection = smtpConnection(config, env);
  const user = requiredEnv(env.MAILBOX_USER, "MAILBOX_USER");

  return {
    async send(input) {
      const auth: SmtpSendInput["auth"] =
        config.auth === "password"
          ? {
              type: "password",
              user,
              password: requiredEnv(env.MAILBOX_PASSWORD, "MAILBOX_PASSWORD")
            }
          : {
              type: "oauth2",
              user,
              accessToken: await resolveMailboxOAuthAccessToken(config, env, fetchImpl)
            };
      await sendSmtp({
        connection,
        auth,
        envelope: { from: user, to: input.to },
        raw: buildMimeMessage({ ...input, from: user })
      });
    }
  };
}

export class ConsoleWhatsAppChannel implements Channel {
  async send(input: Parameters<Channel["send"]>[0]): Promise<void> {
    console.log(`[whatsapp-stub] to=${input.to} body=${input.body_md}`);
  }
}

export function buildMimeMessage(
  input: Parameters<Channel["send"]>[0] & { from: string }
): string {
  const boundary = `quoteops-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const headers = [
    `From: ${safeHeader(input.from)}`,
    `To: ${safeHeader(input.to)}`,
    `Subject: ${encodedHeader(input.subject ?? "Cotización")}`,
    "MIME-Version: 1.0"
  ];
  if (input.reply_to) {
    const messageId = safeHeader(input.reply_to.message_id);
    const references = [...input.reply_to.references.map(safeHeader), messageId]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index);
    headers.push(`In-Reply-To: ${messageId}`, `References: ${references.join(" ")}`);
  }
  const attachments = input.attachments ?? [];
  if (attachments.length === 0) {
    return [
      ...headers,
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      normalizeCrlf(input.body_md)
    ].join("\r\n");
  }
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    normalizeCrlf(input.body_md)
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${safeHeader(attachment.content_type ?? "application/octet-stream")}; name="${safeHeader(attachment.filename)}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename="${safeHeader(attachment.filename)}"`,
      "",
      wrapBase64(attachment.content.toString("base64"))
    );
  }
  parts.push(`--${boundary}--`);
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", ...parts].join("\r\n");
}

export interface SmtpConnection {
  readResponse(): Promise<string>;
  write(value: string): Promise<void>;
  startTls(host: string): Promise<SmtpConnection>;
  close(): Promise<void>;
}

export type SmtpConnector = (
  connection: SmtpSendInput["connection"]
) => Promise<SmtpConnection>;

export async function sendSmtpMessage(
  input: SmtpSendInput,
  connect: SmtpConnector = connectSmtp
): Promise<void> {
  const opened: SmtpConnection[] = [];
  let connection = await connect(input.connection);
  opened.push(connection);
  try {
    await expectCode(await connection.readResponse(), [220]);
    await smtpCommand(connection, "EHLO quoteops.local", [250]);
    if (input.connection.startTls) {
      await smtpCommand(connection, "STARTTLS", [220]);
      connection = await connection.startTls(input.connection.host);
      opened.push(connection);
      await smtpCommand(connection, "EHLO quoteops.local", [250]);
    }
    if (input.auth.type === "password") {
      await smtpCommand(connection, "AUTH LOGIN", [334]);
      await smtpCommand(connection, Buffer.from(input.auth.user).toString("base64"), [334]);
      await smtpCommand(connection, Buffer.from(input.auth.password).toString("base64"), [235]);
    } else {
      const xoauth = Buffer.from(
        `user=${input.auth.user}\u0001auth=Bearer ${input.auth.accessToken}\u0001\u0001`
      ).toString("base64");
      await smtpCommand(connection, `AUTH XOAUTH2 ${xoauth}`, [235]);
    }
    await smtpCommand(connection, `MAIL FROM:<${smtpAddress(input.envelope.from)}>`, [250]);
    await smtpCommand(connection, `RCPT TO:<${smtpAddress(input.envelope.to)}>`, [250, 251]);
    await smtpCommand(connection, "DATA", [354]);
    await connection.write(`${dotStuff(normalizeCrlf(input.raw))}\r\n.\r\n`);
    await expectCode(await connection.readResponse(), [250]);
    await smtpCommand(connection, "QUIT", [221]).catch(() => undefined);
  } finally {
    await Promise.allSettled(opened.map((item) => item.close()));
  }
}

function smtpConnection(
  config: AgentMailboxConfig,
  env: NodeJS.ProcessEnv
): SmtpSendInput["connection"] {
  if (config.provider === "gmail") {
    return { host: "smtp.gmail.com", port: 465, secure: true, startTls: false };
  }
  if (config.provider === "outlook") {
    return { host: "smtp.office365.com", port: 587, secure: false, startTls: true };
  }
  const host = env.MAILBOX_SMTP_HOST?.trim();
  if (!host) throw new Error("mailbox_smtp_unsupported:MAILBOX_SMTP_HOST is required for custom IMAP");
  const port = positivePort(env.MAILBOX_SMTP_PORT) ?? 587;
  const secure = parseBoolean(env.MAILBOX_SMTP_SECURE, port === 465);
  return { host, port, secure, startTls: !secure };
}

function connectSmtp(connection: SmtpSendInput["connection"]): Promise<SmtpConnection> {
  return new Promise((resolve, reject) => {
    const socket = connection.secure
      ? tls.connect({ host: connection.host, port: connection.port, servername: connection.host })
      : net.connect({ host: connection.host, port: connection.port });
    const wrapped = new NodeSmtpConnection(socket);
    const event = connection.secure ? "secureConnect" : "connect";
    socket.once(event, () => resolve(wrapped));
    socket.once("error", reject);
    socket.setTimeout(30_000, () => socket.destroy(new Error("SMTP connection timed out")));
  });
}

async function smtpCommand(
  connection: SmtpConnection,
  value: string,
  expected: number[]
): Promise<string> {
  await connection.write(`${value}\r\n`);
  const response = await connection.readResponse();
  await expectCode(response, expected);
  return response;
}

export class SmtpResponseQueue {
  private buffer = "";
  private currentLines: string[] = [];
  private readonly responses: string[] = [];
  private readonly waiters: Array<{
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private terminalError: Error | null = null;

  push(chunk: string | Buffer): void {
    if (this.terminalError) return;
    this.buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.currentLines.push(line);
      if (/^\d{3} /.test(line)) {
        this.deliver(`${this.currentLines.join("\r\n")}\r\n`);
        this.currentLines = [];
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  read(): Promise<string> {
    const queued = this.responses.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.terminalError) return Promise.reject(this.terminalError);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  fail(error: Error): void {
    if (this.terminalError) return;
    this.terminalError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  close(): void {
    this.fail(new Error("SMTP connection closed"));
  }

  private deliver(response: string): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve(response);
    else this.responses.push(response);
  }
}

class NodeSmtpConnection implements SmtpConnection {
  private readonly responses = new SmtpResponseQueue();
  private handedOff = false;
  private readonly onData = (chunk: Buffer) => this.responses.push(chunk);
  private readonly onError = (error: Error) => this.responses.fail(error);
  private readonly onClose = () => this.responses.close();

  constructor(private readonly socket: net.Socket | tls.TLSSocket) {
    socket.on("data", this.onData);
    socket.on("error", this.onError);
    socket.on("close", this.onClose);
  }

  readResponse(): Promise<string> {
    return this.responses.read();
  }

  write(value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.write(value, (error) => (error ? reject(error) : resolve()));
    });
  }

  startTls(host: string): Promise<SmtpConnection> {
    return new Promise((resolve, reject) => {
      this.detach();
      this.handedOff = true;
      const secured = tls.connect({ socket: this.socket, servername: host });
      secured.once("secureConnect", () => resolve(new NodeSmtpConnection(secured)));
      secured.once("error", reject);
    });
  }

  async close(): Promise<void> {
    this.detach();
    this.responses.close();
    if (!this.handedOff && !this.socket.destroyed) this.socket.destroy();
  }

  private detach(): void {
    this.socket.off("data", this.onData);
    this.socket.off("error", this.onError);
    this.socket.off("close", this.onClose);
  }
}

async function expectCode(response: string, expected: number[]): Promise<void> {
  const lines = response.split(/\r?\n/).filter(Boolean);
  let final: string | undefined;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line && /^\d{3} /.test(line)) {
      final = line;
      break;
    }
  }
  if (!final) throw new Error(`SMTP response was incomplete: ${response}`);
  const code = Number(final.slice(0, 3));
  if (!expected.includes(code)) throw new Error(`SMTP responded ${code}: ${final.slice(4)}`);
}

function safeHeader(value: string): string {
  return value.replace(/[\r\n"]/g, " ").trim();
}

function encodedHeader(value: string): string {
  const clean = safeHeader(value);
  return /^[\x20-\x7E]*$/.test(clean)
    ? clean
    : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function normalizeCrlf(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join("\r\n") ?? "";
}

function dotStuff(value: string): string {
  return value.replace(/^\./gm, "..");
}

function smtpAddress(value: string): string {
  const address = value.trim().replace(/[<>\r\n]/g, "");
  if (!address.includes("@")) throw new Error("SMTP address is invalid");
  return address;
}

function requiredEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`mailbox reply requires ${name}`);
  return trimmed;
}

function positivePort(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : null;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
