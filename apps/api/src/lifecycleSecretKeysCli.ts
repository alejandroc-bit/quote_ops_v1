import { pathToFileURL } from "node:url";
import {
  deriveLifecycleRequiredSecretKeys,
  MissingActiveSecretKeyError,
  parseLifecycleBoolean
} from "./lifecycleSecretKeys.js";

type CliArguments = {
  agentConfigPath: string;
  tmsConfigPath: string;
  cloudflareSettingsPath?: string;
  sakbeLive: boolean;
  availableKeys: string[];
};

export async function runLifecycleSecretKeysCli(args: readonly string[]): Promise<void> {
  const parsed = parseArguments(args);
  const keys = await deriveLifecycleRequiredSecretKeys(parsed);
  process.stdout.write(`${keys.join("\n")}\n`);
}

export async function runLifecycleSecretKeysCliSafely(args: readonly string[]): Promise<number> {
  try {
    await runLifecycleSecretKeysCli(args);
    return 0;
  } catch (error: unknown) {
    console.error(
      error instanceof MissingActiveSecretKeyError
        ? error.message
        : "lifecycle secret key derivation failed"
    );
    return 1;
  }
}

function parseArguments(args: readonly string[]): CliArguments {
  let agentConfigPath = "";
  let tmsConfigPath = "";
  let cloudflareSettingsPath: string | undefined;
  let sakbeLive: boolean | undefined;
  const availableKeys: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag ?? "argument"} requires a value`);
    }
    switch (flag) {
      case "--agent-config":
        if (agentConfigPath) throw new Error("--agent-config may be passed only once");
        agentConfigPath = value;
        break;
      case "--tms-config":
        if (tmsConfigPath) throw new Error("--tms-config may be passed only once");
        tmsConfigPath = value;
        break;
      case "--cloudflare-settings":
        if (cloudflareSettingsPath) {
          throw new Error("--cloudflare-settings may be passed only once");
        }
        cloudflareSettingsPath = value;
        break;
      case "--sakbe-live":
        if (sakbeLive !== undefined) throw new Error("--sakbe-live may be passed only once");
        sakbeLive = parseLifecycleBoolean(value);
        break;
      case "--available-key":
        availableKeys.push(value);
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
    index += 1;
  }

  if (!agentConfigPath) throw new Error("--agent-config is required");
  if (!tmsConfigPath) throw new Error("--tms-config is required");
  if (sakbeLive === undefined) throw new Error("--sakbe-live is required");
  return {
    agentConfigPath,
    tmsConfigPath,
    ...(cloudflareSettingsPath ? { cloudflareSettingsPath } : {}),
    sakbeLive,
    availableKeys
  };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runLifecycleSecretKeysCliSafely(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
