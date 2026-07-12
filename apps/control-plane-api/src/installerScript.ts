import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstallPack } from "@quoteops/control-plane";

export const APPLIANCE_DEPLOY_FILES = ["install.sh", "docker-compose.yml", "Caddyfile"] as const;

export type ApplianceDeployFiles = Record<(typeof APPLIANCE_DEPLOY_FILES)[number], string>;

export async function loadApplianceDeployFiles(
  env: NodeJS.ProcessEnv = process.env
): Promise<ApplianceDeployFiles | null> {
  const deployDir =
    env.QUOTEOPS_APPLIANCE_DEPLOY_DIR?.trim() || join(process.cwd(), "deploy", "appliance");
  try {
    const entries = await Promise.all(
      APPLIANCE_DEPLOY_FILES.map(async (name) => [name, await readFile(join(deployDir, name), "utf8")])
    );
    return Object.fromEntries(entries) as ApplianceDeployFiles;
  } catch {
    return null;
  }
}

/**
 * Self-extracting installer: writes the appliance deploy files plus the
 * client's install pack to disk and hands off to install.sh. The registration
 * token is never embedded — the script requires QUOTEOPS_REGISTRATION_TOKEN
 * in the environment, matching the printed install command.
 */
export function renderInstallerScript({
  pack,
  deployFiles
}: {
  pack: InstallPack;
  deployFiles: ApplianceDeployFiles;
}): string {
  const files: Record<string, string> = {
    ...deployFiles,
    ...pack.files
  };

  const writes = Object.entries(files)
    .map(([path, content]) => {
      const encoded = Buffer.from(content, "utf8").toString("base64");
      return [
        `mkdir -p "$(dirname '${path}')"`,
        `printf '%s' '${encoded}' | base64 -d > '${path}'`
      ].join("\n");
    })
    .join("\n");

  return `#!/usr/bin/env bash
set -euo pipefail

# QuoteOps appliance installer
# client: ${pack.client_id}
# installation: ${pack.installation_id}
# pack expires: ${pack.expires_at}

: "\${QUOTEOPS_REGISTRATION_TOKEN:?QUOTEOPS_REGISTRATION_TOKEN is required (paste the token from your install pack)}"

INSTALL_DIR="\${QUOTEOPS_INSTALL_DIR:-\$PWD/quoteops-install-${pack.client_id.toLowerCase()}}"
mkdir -p "\$INSTALL_DIR"
cd "\$INSTALL_DIR"

${writes}

chmod +x install.sh

exec bash install.sh \\
  --client '${pack.client_id}' \\
  --manifest client-manifest.yaml \\
  --connectors connectors \\
  --compose-file docker-compose.yml \\
  --control-plane-url '${pack.control_plane_url}' \\
  --registration-token "\$QUOTEOPS_REGISTRATION_TOKEN" \\
  --installation-id '${pack.installation_id}' \\
  "\$@"
`;
}
