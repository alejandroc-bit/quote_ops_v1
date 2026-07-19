import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResendMailbox } from "../src/intake/resendMailbox.js";

const LIST = {
  data: [
    {
      id: "email-1",
      to: ["cotizaciones@resaux.io"],
      from: "compras@cliente.mx",
      subject: "Cotización GDL-MTY"
    },
    {
      id: "email-2",
      to: ["otro@resaux.io"],
      from: "compras@cliente.mx",
      subject: "No es para el agente"
    }
  ]
};

const EMAIL_1 = {
  id: "email-1",
  from: "compras@cliente.mx",
  subject: "Cotización GDL-MTY",
  text: "Necesito caja seca 53 de Guadalajara a Monterrey, 18 toneladas.",
  html: null,
  created_at: "2026-07-19T10:00:00.000Z",
  message_id: "<abc@cliente.mx>",
  headers: { from: "Compras Cliente <compras@cliente.mx>" },
  attachments: [{ id: "att-1", filename: "rfqs.xlsx", content_type: "application/vnd.ms-excel" }]
};

function fakeResendFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/emails/receiving")) {
      return new Response(JSON.stringify(LIST), { status: 200 });
    }
    if (url.endsWith("/emails/receiving/email-1")) {
      return new Response(JSON.stringify(EMAIL_1), { status: 200 });
    }
    if (url.endsWith("/emails/receiving/email-1/attachments/att-1")) {
      return new Response(
        JSON.stringify({
          download_url: "https://inbound-cdn.resend.example/att-1",
          filename: "rfqs.xlsx",
          content_type: "application/vnd.ms-excel"
        }),
        { status: 200 }
      );
    }
    if (url === "https://inbound-cdn.resend.example/att-1") {
      return new Response(Buffer.from("XLSX-BYTES"), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function makeMailbox(): Promise<{ mailbox: ResendMailbox; statePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "resend-mailbox-"));
  const statePath = join(dir, "processed.json");
  const mailbox = new ResendMailbox({
    apiKey: "re_test",
    statePath,
    intakeAddress: "cotizaciones@resaux.io",
    fetch: fakeResendFetch()
  });
  return { mailbox, statePath };
}

describe("ResendMailbox", () => {
  it("lists only unprocessed emails addressed to the intake mailbox", async () => {
    const { mailbox } = await makeMailbox();
    expect(await mailbox.listUnread()).toEqual(["email-1"]);
  });

  it("maps a received email with downloaded attachments to IntakeEmail", async () => {
    const { mailbox } = await makeMailbox();
    const email = await mailbox.fetch("email-1");
    expect(email).toMatchObject({
      message_id: "email-1",
      rfc_message_id: "<abc@cliente.mx>",
      from_name: "Compras Cliente",
      from_email: "compras@cliente.mx",
      subject: "Cotización GDL-MTY",
      received_at: "2026-07-19T10:00:00.000Z"
    });
    expect(email.body_text).toContain("caja seca 53");
    expect(email.attachments).toHaveLength(1);
    expect(email.attachments[0]).toMatchObject({
      filename: "rfqs.xlsx",
      mimeType: "application/vnd.ms-excel"
    });
    expect(email.attachments[0]!.content.toString()).toBe("XLSX-BYTES");
  });

  it("persists processed ids so later polls (and new instances) skip them", async () => {
    const { mailbox, statePath } = await makeMailbox();
    await mailbox.finish("email-1", "processed");
    expect(await mailbox.listUnread()).toEqual([]);

    const second = new ResendMailbox({
      apiKey: "re_test",
      statePath,
      intakeAddress: "cotizaciones@resaux.io",
      fetch: fakeResendFetch()
    });
    expect(await second.listUnread()).toEqual([]);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    expect(persisted.processed["email-1"]).toBe("processed");
  });

  it("falls back to stripped html when text is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "resend-mailbox-html-"));
    const mailbox = new ResendMailbox({
      apiKey: "re_test",
      statePath: join(dir, "processed.json"),
      fetch: (async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/emails/receiving/email-html")) {
          return new Response(
            JSON.stringify({
              id: "email-html",
              from: "compras@cliente.mx",
              subject: "HTML",
              text: null,
              html: "<p>Necesito <strong>caja seca</strong></p><br>18 toneladas",
              attachments: []
            }),
            { status: 200 }
          );
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch
    });
    const email = await mailbox.fetch("email-html");
    expect(email.body_text).toContain("Necesito caja seca");
    expect(email.body_text).toContain("18 toneladas");
    expect(email.body_text).not.toContain("<");
  });
});
