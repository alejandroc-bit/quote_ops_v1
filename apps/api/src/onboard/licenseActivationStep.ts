import { z } from "zod";
import {
  OnboardingError,
  type OnboardingContext,
  type OnboardingPhase
} from "./onboardingFlow.js";

export const ONBOARD_INTERNAL_API_ORIGIN = "http://quoteops-api:8080" as const;

export const activationOnboardingResponseSchema = z
  .object({
    activated: z.literal(true),
    client_id: z.string().min(1),
    installation_id: z.string().min(1)
  })
  .strict();

const activationSetupStateSchema = z
  .object({
    activation: z
      .object({
        required: z.boolean(),
        status: z.enum(["locked", "unlocked"]),
        client_id: z.string().nullable(),
        installation_id: z.string().nullable()
      })
      .strict()
  })
  .passthrough();

class ActivationOnboardingError extends OnboardingError {
  constructor(
    code: string,
    readonly status: number | null,
    cause?: unknown
  ) {
    super(code, { phase: "license_activation", cause });
  }
}

export async function activateLicenseFromOnboarding(input: {
  email: string;
  fetch?: typeof fetch;
}): Promise<{
  activated: true;
  client_id: string;
  installation_id: string;
}> {
  const fetchFn = input.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(
      new URL("/api/onboarding/activate", ONBOARD_INTERNAL_API_ORIGIN),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: input.email }),
        signal: AbortSignal.timeout(10_000)
      }
    );
  } catch (error) {
    throw new ActivationOnboardingError("activation_unreachable", null, error);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw safeActivationError(response.status, body);
  }
  try {
    return activationOnboardingResponseSchema.parse(body);
  } catch (error) {
    throw new ActivationOnboardingError(
      "activation_response_invalid",
      response.status,
      error
    );
  }
}

export const licenseActivationPhase: OnboardingPhase = {
  id: "license_activation",
  async isComplete(context) {
    assertFixedInternalOrigin(context);
    const expectedClientId = requiredIdentity(
      context.env.QUOTEOPS_CLIENT_ID,
      "activation_client_id_missing"
    );
    const expectedInstallationId = requiredIdentity(
      context.env.QUOTEOPS_INSTALLATION_ID,
      "activation_installation_id_missing"
    );
    const state = await fetchActivationSetupState(context.fetch);
    return (
      state.activation.status === "unlocked" &&
      state.activation.client_id === expectedClientId &&
      state.activation.installation_id === expectedInstallationId
    );
  },
  async run(context) {
    assertFixedInternalOrigin(context);
    const email =
      context.answers?.activation?.authorized_email ??
      (context.guided
        ? await context.io.ask("Correo autorizado para activar la licencia")
        : "");
    const parsedEmail = z.string().email().safeParse(email);
    if (!parsedEmail.success) {
      throw new OnboardingError("activation_email_invalid", {
        phase: "license_activation"
      });
    }
    const result = await activateLicenseFromOnboarding({
      email: parsedEmail.data,
      fetch: context.fetch
    });
    const expectedClientId = requiredIdentity(
      context.env.QUOTEOPS_CLIENT_ID,
      "activation_client_id_missing"
    );
    const expectedInstallationId = requiredIdentity(
      context.env.QUOTEOPS_INSTALLATION_ID,
      "activation_installation_id_missing"
    );
    if (
      result.client_id !== expectedClientId ||
      result.installation_id !== expectedInstallationId ||
      !(await licenseActivationPhase.isComplete(context))
    ) {
      throw new OnboardingError("activation_not_current", {
        phase: "license_activation"
      });
    }
  }
};

async function fetchActivationSetupState(fetchFn: typeof fetch) {
  let response: Response;
  try {
    response = await fetchFn(
      new URL("/api/setup-state", ONBOARD_INTERNAL_API_ORIGIN),
      { signal: AbortSignal.timeout(10_000) }
    );
  } catch (error) {
    throw new ActivationOnboardingError("activation_unreachable", null, error);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw safeActivationError(response.status, body);
  }
  try {
    return activationSetupStateSchema.parse(body);
  } catch (error) {
    throw new ActivationOnboardingError(
      "activation_state_invalid",
      response.status,
      error
    );
  }
}

function safeActivationError(
  status: number,
  body: unknown
): ActivationOnboardingError {
  const unsafeCode =
    body &&
    typeof body === "object" &&
    typeof (body as Record<string, unknown>).error === "string"
      ? String((body as Record<string, unknown>).error)
      : "activation_failed";
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(unsafeCode)
    ? unsafeCode
    : "activation_failed";
  return new ActivationOnboardingError(code, status);
}

function assertFixedInternalOrigin(context: OnboardingContext): void {
  const configured = context.env.QUOTEOPS_ONBOARD_API_URL;
  if (configured !== undefined && configured !== ONBOARD_INTERNAL_API_ORIGIN) {
    throw new OnboardingError("onboarding_api_origin_invalid", {
      exitCode: 2,
      phase: "license_activation"
    });
  }
}

function requiredIdentity(value: string | undefined, code: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new OnboardingError(code, { phase: "license_activation" });
  }
  return normalized;
}
