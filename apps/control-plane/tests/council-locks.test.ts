import { describe, expect, it } from "vitest";
import {
  createInstallationLicense,
  generateLicenseKeyPair,
  verifyInstallationLicense
} from "../src/index";

describe("signed installation license", () => {
  it("signs and verifies a license scoped to client and installation", () => {
    const keys = generateLicenseKeyPair();
    const license = createInstallationLicense({
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      release_channel: "stable",
      features: ["rfq_processing", "tms_writeback", "local_rag"],
      issued_at: "2026-06-24T12:00:00.000Z",
      expires_at: "2026-07-24T12:00:00.000Z",
      private_key_pem: keys.private_key_pem
    });

    expect(license.payload.client_id).toBe("NMX");
    expect(license.signature).toMatch(/^ed25519:/);
    expect(
      verifyInstallationLicense(license, {
        public_key_pem: keys.public_key_pem,
        now: "2026-06-25T12:00:00.000Z",
        expected_client_id: "NMX",
        expected_installation_id: "nmx-prod-001"
      })
    ).toBe(true);
  });

  it("rejects wrong installation scope and expired licenses", () => {
    const keys = generateLicenseKeyPair();
    const license = createInstallationLicense({
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      release_channel: "stable",
      features: ["rfq_processing"],
      issued_at: "2026-06-24T12:00:00.000Z",
      expires_at: "2026-06-25T12:00:00.000Z",
      private_key_pem: keys.private_key_pem
    });

    expect(() =>
      verifyInstallationLicense(license, {
        public_key_pem: keys.public_key_pem,
        now: "2026-06-24T13:00:00.000Z",
        expected_client_id: "NMX",
        expected_installation_id: "other-install"
      })
    ).toThrow(/installation mismatch/);

    expect(() =>
      verifyInstallationLicense(license, {
        public_key_pem: keys.public_key_pem,
        now: "2026-06-26T12:00:00.000Z",
        expected_client_id: "NMX",
        expected_installation_id: "nmx-prod-001"
      })
    ).toThrow(/license expired/);
  });

  it("rejects wrong client scope and tampered signatures", () => {
    const keys = generateLicenseKeyPair();
    const license = createInstallationLicense({
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      release_channel: "stable",
      features: ["tms_writeback", "rfq_processing"],
      issued_at: "2026-06-24T12:00:00.000Z",
      expires_at: "2026-07-24T12:00:00.000Z",
      private_key_pem: keys.private_key_pem
    });

    expect(license.payload.features).toEqual(["rfq_processing", "tms_writeback"]);
    expect(() =>
      verifyInstallationLicense(license, {
        public_key_pem: keys.public_key_pem,
        now: "2026-06-25T12:00:00.000Z",
        expected_client_id: "OTHER",
        expected_installation_id: "nmx-prod-001"
      })
    ).toThrow(/client mismatch/);

    expect(() =>
      verifyInstallationLicense(
        {
          ...license,
          payload: {
            ...license.payload,
            release_channel: "pilot"
          }
        },
        {
          public_key_pem: keys.public_key_pem,
          now: "2026-06-25T12:00:00.000Z",
          expected_client_id: "NMX",
          expected_installation_id: "nmx-prod-001"
        }
      )
    ).toThrow(/signature invalid/);
  });

  it("compares expiration dates by instant instead of string order", () => {
    const keys = generateLicenseKeyPair();
    const license = createInstallationLicense({
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      release_channel: "stable",
      features: ["rfq_processing"],
      issued_at: "2026-06-24T12:00:00.000Z",
      expires_at: "2026-06-25T00:00:00+05:00",
      private_key_pem: keys.private_key_pem
    });

    expect(() =>
      verifyInstallationLicense(license, {
        public_key_pem: keys.public_key_pem,
        now: "2026-06-24T20:00:00.000Z",
        expected_client_id: "NMX",
        expected_installation_id: "nmx-prod-001"
      })
    ).toThrow(/license expired/);
  });

  it("rejects invalid expiration dates", () => {
    const keys = generateLicenseKeyPair();
    const license = createInstallationLicense({
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      release_channel: "stable",
      features: ["rfq_processing"],
      issued_at: "2026-06-24T12:00:00.000Z",
      expires_at: "not-a-date",
      private_key_pem: keys.private_key_pem
    });

    expect(() =>
      verifyInstallationLicense(license, {
        public_key_pem: keys.public_key_pem,
        now: "2026-06-24T20:00:00.000Z",
        expected_client_id: "NMX",
        expected_installation_id: "nmx-prod-001"
      })
    ).toThrow(/license date invalid/);
  });
});
