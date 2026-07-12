import { rfqSchema, type Rfq, type RfqLane } from "@quoteops/contracts";
import { resolveLanesFromText, type QuoteManifest } from "@quoteops/quote-core";
import { xlsxToDraftLanes, type DraftLane } from "./xlsxToLanes.js";

export type IntakeAttachment = {
  filename: string;
  mimeType: string;
  content: Buffer;
};

export type IntakeEmail = {
  message_id: string;
  rfc_message_id?: string | null;
  references?: string[];
  from_name: string;
  from_email: string;
  subject: string;
  body_text: string;
  received_at: string;
  attachments: IntakeAttachment[];
};

export type IntakeModelPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; dataBase64: string };

export type IntakeModel = (parts: IntakeModelPart[]) => unknown | Promise<unknown>;

export class RfqExtractionError extends Error {}

const XLSX_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel"
]);

export function buildExtractionPrompt(email: IntakeEmail): string {
  return [
    "Extract freight quote request lanes from this email. Return ONLY strict JSON:",
    '{"lanes":[{"origin":{"city":"","state":"","country":"MX"},"destination":{"city":"","state":"","country":"MX"},"equipment_text":null,"weight_kg":null,"commodity":null,"value_mxn":null,"hazmat":false,"target_rate_mxn":null}]}',
    "One lane per origin-destination pair requested. equipment_text is the literal transport type/unit wording used by the requester (e.g. 'plataforma full y sencillo'). Use null when a value is not stated. Never invent values.",
    `Subject: ${email.subject}`,
    `Body:\n${email.body_text}`
  ].join("\n");
}

/**
 * Turns an inbound email (free text, images, or xlsx attachments) into a
 * schema-valid Rfq. xlsx rows are parsed deterministically; text and images go
 * through the injected model callback. Keyword resolution against the client
 * manifest decides business unit and unit types — one lane per matching
 * vehicle profile (e.g. "full y sencillo" -> 2 lanes).
 */
export async function buildRfqFromEmail({
  email,
  manifest,
  model,
  rfqId
}: {
  email: IntakeEmail;
  manifest: QuoteManifest;
  model: IntakeModel | null;
  rfqId: string;
}): Promise<Rfq> {
  const xlsxAttachments = email.attachments.filter(
    (attachment) =>
      XLSX_MIME_TYPES.has(attachment.mimeType) || /\.xlsx?$/i.test(attachment.filename)
  );
  const imageAttachments = email.attachments.filter((attachment) =>
    attachment.mimeType.startsWith("image/")
  );

  let draftLanes: DraftLane[];
  if (xlsxAttachments.length > 0) {
    draftLanes = xlsxAttachments.flatMap((attachment) => xlsxToDraftLanes(attachment.content));
  } else {
    if (!model) {
      throw new RfqExtractionError(
        "text and image RFQ extraction requires an AI model provider in agent-config"
      );
    }
    const parts: IntakeModelPart[] = [{ type: "text", text: buildExtractionPrompt(email) }];
    for (const image of imageAttachments) {
      parts.push({
        type: "image",
        mimeType: image.mimeType,
        dataBase64: image.content.toString("base64")
      });
    }
    draftLanes = parseModelLanes(await model(parts));
  }

  const lanes = draftLanes.flatMap((draft) =>
    expandDraftLane({ draft, email, manifest })
  );
  if (lanes.length === 0) {
    throw new RfqExtractionError("no lanes could be extracted from the email");
  }

  const rfq: Rfq = {
    rfq_id: rfqId,
    source: "email",
    received_at: email.received_at,
    requester: {
      name: email.from_name || email.from_email,
      email: email.from_email,
      company_alias: email.from_email.split("@")[1] ?? email.from_email
    },
    raw: {
      subject: email.subject,
      body: email.body_text,
      attachments: email.attachments.map((attachment) => attachment.filename)
    },
    parsed: {
      lanes: lanes.map((lane, index) => ({
        ...lane,
        lane_id: `${rfqId}-L${String(index + 1).padStart(2, "0")}`
      }))
    }
  };

  try {
    return rfqSchema.parse(rfq);
  } catch (error) {
    throw new RfqExtractionError(
      `extracted RFQ failed schema validation: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function expandDraftLane({
  draft,
  email,
  manifest
}: {
  draft: DraftLane;
  email: IntakeEmail;
  manifest: QuoteManifest;
}): Omit<RfqLane, "lane_id">[] {
  const keywordText = [draft.equipment_text ?? "", email.subject, email.body_text].join("\n");
  const resolution = resolveLanesFromText({
    text: keywordText,
    requester_email: email.from_email,
    manifest
  });

  const explicitProfile = draft.vehicle_profile_id?.trim() || null;
  const profileIds = explicitProfile
    ? [explicitProfile]
    : resolution.vehicle_profile_ids.length > 0
      ? resolution.vehicle_profile_ids
      : [null];

  return profileIds.map((profileId) => ({
    origin: withCountry(draft.origin),
    destination: withCountry(draft.destination),
    equipment_request: draft.equipment_text?.trim() || profileId || "sin especificar",
    vehicle_profile_id: profileId,
    cargo: {
      commodity: draft.commodity ?? null,
      commodity_category: draft.commodity_category ?? null,
      sector: draft.sector ?? null,
      weight_kg: draft.weight_kg ?? null,
      value_mxn: draft.value_mxn ?? null,
      hazmat: draft.hazmat ?? false,
      temperature_controlled: false
    },
    service: {
      return_policy: "sin_retorno",
      route_policy: "cuota",
      requested_pickup_at: null
    },
    commercial: {
      target_rate_mxn: draft.target_rate_mxn ?? null,
      customer_id: draft.customer_id ?? null,
      customer_type: draft.customer_type ?? null,
      business_unit_id: draft.business_unit_id ?? resolution.business_unit_id ?? null
    },
    confidence: {
      overall: profileId ? 0.8 : 0.5,
      missing_fields: profileId ? [] : ["vehicle_profile_id"],
      review_reasons: []
    }
  }));
}

function withCountry(location: { city: string; state: string; country?: string }): {
  city: string;
  state: string;
  country: string;
} {
  return {
    city: location.city,
    state: location.state,
    country: (location.country ?? "MX").slice(0, 2).toUpperCase()
  };
}

function parseModelLanes(result: unknown): DraftLane[] {
  const parsed = typeof result === "string" ? parseJsonBlock(result) : result;
  const lanes = (parsed as { lanes?: unknown })?.lanes;
  if (!Array.isArray(lanes) || lanes.length === 0) {
    throw new RfqExtractionError("model extraction returned no lanes");
  }
  return lanes.map((lane, index) => {
    const record = lane as Record<string, unknown>;
    const origin = record.origin as DraftLane["origin"] | undefined;
    const destination = record.destination as DraftLane["destination"] | undefined;
    if (!origin?.city || !origin?.state || !destination?.city || !destination?.state) {
      throw new RfqExtractionError(`model lane ${index + 1} is missing origin or destination`);
    }
    return {
      origin,
      destination,
      equipment_text: typeof record.equipment_text === "string" ? record.equipment_text : null,
      weight_kg: typeof record.weight_kg === "number" ? record.weight_kg : null,
      commodity: typeof record.commodity === "string" ? record.commodity : null,
      value_mxn: typeof record.value_mxn === "number" ? record.value_mxn : null,
      hazmat: record.hazmat === true,
      target_rate_mxn: typeof record.target_rate_mxn === "number" ? record.target_rate_mxn : null
    };
  });
}

function parseJsonBlock(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new RfqExtractionError("model extraction returned no JSON");
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new RfqExtractionError("model extraction returned invalid JSON");
  }
}
