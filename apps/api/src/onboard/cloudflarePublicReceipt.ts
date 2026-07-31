export type CloudflarePublicReceiptIdentity = {
  public_hostname: string;
  version: string;
  client_id: string;
  installation_id: string;
};

const CLOUDFLARE_PUBLIC_RECEIPT_KEYS = [
  "authenticated_origin",
  "client_id",
  "installation_id",
  "public_hostname",
  "version"
] as const;

export function matchesCloudflarePublicReceipt(
  value: unknown,
  expected: CloudflarePublicReceiptIdentity
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  const keys = Object.keys(receipt).sort();
  return (
    keys.length === CLOUDFLARE_PUBLIC_RECEIPT_KEYS.length &&
    keys.every((key, index) => key === CLOUDFLARE_PUBLIC_RECEIPT_KEYS[index]) &&
    receipt.public_hostname === expected.public_hostname &&
    receipt.version === expected.version &&
    receipt.client_id === expected.client_id &&
    receipt.installation_id === expected.installation_id &&
    receipt.authenticated_origin === true
  );
}
