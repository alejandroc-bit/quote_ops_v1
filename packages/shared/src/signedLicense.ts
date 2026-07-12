import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify
} from "node:crypto";

export type InstallationLicensePayload = {
  client_id: string;
  installation_id: string;
  release_channel: string;
  features: string[];
  issued_at: string;
  expires_at: string;
};

export type InstallationLicense = {
  payload: InstallationLicensePayload;
  signature: string;
};

export type LicenseKeyPair = {
  public_key_pem: string;
  private_key_pem: string;
};

export function generateLicenseKeyPair(): LicenseKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  return {
    public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    private_key_pem: privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  };
}

export function createInstallationLicense(
  input: InstallationLicensePayload & { private_key_pem: string }
): InstallationLicense {
  const payload = canonicalizeLicensePayload(input);
  const privateKey = createPrivateKey(input.private_key_pem);
  const signature = sign(
    null,
    Buffer.from(canonicalLicensePayload(payload)),
    privateKey
  ).toString("base64");

  return {
    payload,
    signature: `ed25519:${signature}`
  };
}

export function verifyInstallationLicense(
  license: InstallationLicense,
  options: {
    public_key_pem: string;
    now: string;
    expected_client_id: string;
    expected_installation_id: string;
  }
): boolean {
  if (license.payload.client_id !== options.expected_client_id) {
    throw new Error("license client mismatch");
  }

  if (license.payload.installation_id !== options.expected_installation_id) {
    throw new Error("license installation mismatch");
  }

  const expiresAtMs = Date.parse(license.payload.expires_at);
  const nowMs = Date.parse(options.now);

  if (Number.isNaN(expiresAtMs) || Number.isNaN(nowMs)) {
    throw new Error("license date invalid");
  }

  if (expiresAtMs <= nowMs) {
    throw new Error("license expired");
  }

  if (!license.signature.startsWith("ed25519:")) {
    throw new Error("license signature invalid");
  }

  const publicKey = createPublicKey(options.public_key_pem);
  const signature = license.signature.slice("ed25519:".length);
  const ok = verify(
    null,
    Buffer.from(canonicalLicensePayload(license.payload)),
    publicKey,
    Buffer.from(signature, "base64")
  );

  if (!ok) {
    throw new Error("license signature invalid");
  }

  return true;
}

function canonicalizeLicensePayload(
  payload: InstallationLicensePayload
): InstallationLicensePayload {
  return {
    client_id: payload.client_id,
    installation_id: payload.installation_id,
    release_channel: payload.release_channel,
    features: [...payload.features].sort(),
    issued_at: payload.issued_at,
    expires_at: payload.expires_at
  };
}

function canonicalLicensePayload(payload: InstallationLicensePayload): string {
  return JSON.stringify(canonicalizeLicensePayload(payload));
}
