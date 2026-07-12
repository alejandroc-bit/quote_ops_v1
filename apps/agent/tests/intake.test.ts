import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import type { QuoteManifest } from "@quoteops/quote-core";
import {
  buildRfqFromEmail,
  RfqExtractionError,
  runMailboxIntakeOnce,
  parseIntakeEmailMessage,
  xlsxToDraftLanes,
  type IntakeEmail,
  type MailboxOutcome,
  type MailboxSource
} from "../src/index";

it("preserves RFC Message-ID and References separately from the mailbox UID", async () => {
  const parsed = await parseIntakeEmailMessage(
    "uid-77",
    Buffer.from([
      "From: Buyer <buyer@example.com>",
      "To: quotes@example.com",
      "Subject: Freight quote",
      "Message-ID: <rfq-123@example.com>",
      "References: <older@example.com>",
      "Date: Sun, 12 Jul 2026 12:00:00 +0000",
      "",
      "Please quote this lane"
    ].join("\r\n"))
  );

  expect(parsed.message_id).toBe("uid-77");
  expect(parsed.rfc_message_id).toBe("<rfq-123@example.com>");
  expect(parsed.references).toEqual(["<older@example.com>"]);
});

const baseProfile = {
  payload_capacity_kg: 24000,
  fuel_loaded_km_per_l: 3,
  fuel_empty_km_per_l: 3.4,
  operator_cost_per_km_mxn: 2.5,
  pricing_model: "formula" as const,
  diesel_price_mxn_per_liter: 24,
  margin_target_pct: 0.25,
  minimum_margin_pct: 0.18
};

const manifest: QuoteManifest = {
  client_id: "cliente-demo",
  business_units: [
    {
      business_unit_id: "cajas",
      requester_email_domains: ["cliente.com"],
      keywords: ["caja seca"],
      default: true
    },
    {
      business_unit_id: "plataformas",
      requester_email_domains: [],
      keywords: ["plataforma"]
    }
  ],
  vehicle_profiles: [
    { ...baseProfile, vehicle_profile_id: "PLAT_SENCILLO", business_unit_id: "plataformas", keywords: ["sencillo"] },
    { ...baseProfile, vehicle_profile_id: "PLAT_FULL", business_unit_id: "plataformas", keywords: ["full"] },
    { ...baseProfile, vehicle_profile_id: "CAJA_53", business_unit_id: "cajas", keywords: ["caja seca", "53"] }
  ],
  route_policy: { sakbe_required: true }
};

function email(overrides: Partial<IntakeEmail> = {}): IntakeEmail {
  return {
    message_id: "msg-1",
    from_name: "Compras Cliente",
    from_email: "compras@cliente.com",
    subject: "Cotizacion",
    body_text: "Cotizame en full y sencillo un Monterrey - Mexico en plataformas",
    received_at: "2026-07-01T10:00:00.000Z",
    attachments: [],
    ...overrides
  };
}

const textModel = async () =>
  JSON.stringify({
    lanes: [
      {
        origin: { city: "Monterrey", state: "Nuevo Leon", country: "MX" },
        destination: { city: "Ciudad de Mexico", state: "CDMX", country: "MX" },
        equipment_text: "plataforma full y sencillo",
        weight_kg: 20000
      }
    ]
  });

describe("buildRfqFromEmail", () => {
  it("expands a free-text request into one lane per matching unit type", async () => {
    const rfq = await buildRfqFromEmail({
      email: email(),
      manifest,
      model: textModel,
      rfqId: "RFQ-2026-000101"
    });

    expect(rfq.parsed.lanes).toHaveLength(2);
    expect(rfq.parsed.lanes.map((lane) => lane.vehicle_profile_id).sort()).toEqual([
      "PLAT_FULL",
      "PLAT_SENCILLO"
    ]);
    expect(rfq.parsed.lanes[0].commercial.business_unit_id).toBe("plataformas");
    expect(rfq.parsed.lanes.map((lane) => lane.lane_id)).toEqual([
      "RFQ-2026-000101-L01",
      "RFQ-2026-000101-L02"
    ]);
    expect(rfq.source).toBe("email");
  });

  it("parses xlsx attachments deterministically without a model", async () => {
    const sheet = XLSX.utils.json_to_sheet([
      {
        origin_city: "Monterrey",
        origin_state: "Nuevo Leon",
        destination_city: "Saltillo",
        destination_state: "Coahuila",
        equipment_request: "caja seca 53",
        weight_kg: 12000
      },
      {
        origin_city: "Queretaro",
        origin_state: "Queretaro",
        destination_city: "Puebla",
        destination_state: "Puebla",
        equipment_request: "caja seca 53",
        weight_kg: 8000
      }
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "rfqs");
    const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    const rfq = await buildRfqFromEmail({
      email: email({
        body_text: "Adjunto solicitudes",
        attachments: [
          {
            filename: "solicitudes.xlsx",
            mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            content
          }
        ]
      }),
      manifest,
      model: null,
      rfqId: "RFQ-2026-000102"
    });

    expect(rfq.parsed.lanes).toHaveLength(2);
    expect(rfq.parsed.lanes[0].vehicle_profile_id).toBe("CAJA_53");
    expect(rfq.parsed.lanes[1].origin.city).toBe("Queretaro");
    expect(rfq.parsed.lanes[1].cargo.weight_kg).toBe(8000);
  });

  it("fails loudly for text extraction without a model provider", async () => {
    await expect(
      buildRfqFromEmail({ email: email(), manifest, model: null, rfqId: "RFQ-2026-000103" })
    ).rejects.toBeInstanceOf(RfqExtractionError);
  });
});

describe("xlsxToDraftLanes", () => {
  it("rejects sheets missing required columns", () => {
    const sheet = XLSX.utils.json_to_sheet([{ origin_city: "Monterrey" }]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "rfqs");
    const content = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

    expect(() => xlsxToDraftLanes(content)).toThrow(/missing required column/);
  });
});

class FakeMailbox implements MailboxSource {
  readonly finished: Record<string, MailboxOutcome> = {};
  closed = false;

  constructor(private readonly messages: Record<string, IntakeEmail>) {}

  async listUnread(): Promise<string[]> {
    return Object.keys(this.messages);
  }

  async fetch(uid: string): Promise<IntakeEmail> {
    return this.messages[uid];
  }

  async finish(uid: string, outcome: MailboxOutcome): Promise<void> {
    this.finished[uid] = outcome;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("runMailboxIntakeOnce", () => {
  it("invokes the new graph runtime directly when it is injected", async () => {
    const invoked: unknown[] = [];
    let licenseChecks = 0;
    const mailbox = new FakeMailbox({ "msg-graph": email() });
    const result = await runMailboxIntakeOnce({
      env: { QUOTEOPS_CLIENT_ID: "cliente-demo" } as NodeJS.ProcessEnv,
      fetch: (async () => { throw new Error("network should not be used"); }) as typeof fetch,
      manifest,
      mailbox,
      graphRuntime: {
        invoke: async (input) => {
          invoked.push(input);
          return { run_id: input.run_id } as never;
        }
      },
      authorizeGraphRun: async () => { licenseChecks += 1; },
      log: () => undefined
    });

    expect(result.processed).toEqual(["msg-graph"]);
    expect(invoked).toEqual([
      expect.objectContaining({
        channel: "email",
        message: expect.objectContaining({ message_id: "msg-1" })
      })
    ]);
    expect(mailbox.finished["msg-graph"]).toBe("processed");
    expect(licenseChecks).toBe(1);
  });

  it("fails closed before graph execution when mailbox licensing fails", async () => {
    let invokes = 0;
    const mailbox = new FakeMailbox({ "msg-unlicensed": email() });
    await expect(
      runMailboxIntakeOnce({
        env: { QUOTEOPS_CLIENT_ID: "cliente-demo" } as NodeJS.ProcessEnv,
        manifest,
        mailbox,
        graphRuntime: {
          invoke: async () => { invokes += 1; return {} as never; }
        },
        authorizeGraphRun: async () => { throw new Error("appliance_locked:license_file_missing"); },
        log: () => undefined
      })
    ).rejects.toThrow("appliance_locked:license_file_missing");

    expect(invokes).toBe(0);
    expect(mailbox.finished["msg-unlicensed"]).toBe("error");
  });

  it("processes authorized senders and ignores unauthorized domains", async () => {
    const posted: unknown[] = [];
    const mailbox = new FakeMailbox({
      "msg-ok": email(),
      "msg-bad": email({
        from_name: "Spam",
        from_email: "alguien@otro.com",
        body_text: "cotiza algo"
      })
    });

    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/rfqs")) {
        posted.push(JSON.parse(String(init?.body)));
        return jsonResponse({ run_id: "run-1" }, 202);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    const result = await runMailboxIntakeOnce({
      env: {
        QUOTEOPS_API_URL: "http://localhost:19082",
        QUOTEOPS_CLIENT_ID: "cliente-demo"
      } as NodeJS.ProcessEnv,
      fetch: fakeFetch,
      manifest,
      model: textModel,
      mailbox,
      log: () => undefined
    });

    expect(result.processed).toEqual(["msg-ok"]);
    expect(result.ignored).toEqual(["msg-bad"]);
    expect(result.failed).toEqual([]);
    expect(posted).toHaveLength(1);
    const request = posted[0] as { client_id: string; raw_rfq: { parsed: { lanes: unknown[] } } };
    expect(request.client_id).toBe("cliente-demo");
    expect(request.raw_rfq.parsed.lanes).toHaveLength(2);
    expect(mailbox.finished["msg-ok"]).toBe("processed");
    expect(mailbox.finished["msg-bad"]).toBe("ignored");
    // an injected mailbox is owned by the caller and must not be closed
    expect(mailbox.closed).toBe(false);
  });

  it("flags extraction failures for manual review without dropping them", async () => {
    const mailbox = new FakeMailbox({ "msg-empty": email({ body_text: "", attachments: [] }) });
    const result = await runMailboxIntakeOnce({
      env: { QUOTEOPS_CLIENT_ID: "cliente-demo" } as NodeJS.ProcessEnv,
      fetch: (async () => jsonResponse({ run_id: "run-1" }, 202)) as typeof fetch,
      manifest,
      model: async () => JSON.stringify({ lanes: [] }),
      mailbox,
      log: () => undefined
    });

    expect(result.failed).toEqual(["msg-empty"]);
    expect(mailbox.finished["msg-empty"]).toBe("error");
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
