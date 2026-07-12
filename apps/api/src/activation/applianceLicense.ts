export type ApplianceLicenseState = {
  required: boolean;
  status: "valid" | "missing" | "invalid" | "expired";
  client_id: string | null;
  installation_id: string | null;
  reason: string | null;
};

export function assertApplianceLicensed(state: ApplianceLicenseState): void {
  if (state.required && state.status !== "valid") {
    throw new Error(`appliance_locked:${state.reason ?? "license_required"}`);
  }
}

export function applianceLockedResponse(state: ApplianceLicenseState): {
  status: 423;
  body: {
    error: "appliance_locked";
    reason: string;
    client_id: string | null;
    installation_id: string | null;
  };
} {
  return {
    status: 423,
    body: {
      error: "appliance_locked",
      reason: state.reason ?? "license_required",
      client_id: state.client_id,
      installation_id: state.installation_id
    }
  };
}
