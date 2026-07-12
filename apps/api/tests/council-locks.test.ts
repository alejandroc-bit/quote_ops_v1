import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertApplianceLicensed,
  applianceLockedResponse,
  type ApplianceLicenseState
} from "../src/activation/applianceLicense";
import { assertNoForbiddenImports } from "../src/security/architectureGuards";

describe("appliance license guard", () => {
  it("blocks RFQ processing when license is missing", () => {
    const state: ApplianceLicenseState = {
      required: true,
      status: "missing",
      client_id: "NMX",
      installation_id: "nmx-prod-001",
      reason: "license_file_missing"
    };

    expect(() => assertApplianceLicensed(state)).toThrow(/appliance_locked/);
    expect(applianceLockedResponse(state)).toEqual({
      status: 423,
      body: {
        error: "appliance_locked",
        reason: "license_file_missing",
        client_id: "NMX",
        installation_id: "nmx-prod-001"
      }
    });
  });

  it("allows valid or non-required appliance state", () => {
    expect(() =>
      assertApplianceLicensed({
        required: true,
        status: "valid",
        client_id: "NMX",
        installation_id: "nmx-prod-001",
        reason: null
      })
    ).not.toThrow();

    expect(() =>
      assertApplianceLicensed({
        required: false,
        status: "missing",
        client_id: null,
        installation_id: null,
        reason: "not_configured"
      })
    ).not.toThrow();
  });

  it("uses a stable default lock reason", () => {
    const state: ApplianceLicenseState = {
      required: true,
      status: "invalid",
      client_id: null,
      installation_id: null,
      reason: null
    };

    expect(() => assertApplianceLicensed(state)).toThrow(
      /appliance_locked:license_required/
    );
    expect(applianceLockedResponse(state)).toEqual({
      status: 423,
      body: {
        error: "appliance_locked",
        reason: "license_required",
        client_id: null,
        installation_id: null
      }
    });
  });
});

describe("architecture import boundaries", () => {
  it("prevents control-plane code from importing runtime pricing or local data-plane packages", async () => {
    await expect(
      assertNoForbiddenImports({
        rootDir: process.cwd(),
        includeGlobs: ["apps/control-plane/src"],
        forbiddenFragments: [
          "@quoteops/quote-core",
          "@langchain/langgraph",
          "@quoteops/knowledge",
          "DeterministicTmsMapper",
          "applyDeterministicTmsMapping"
        ],
        forbiddenExportsByModule: {
          "@quoteops/connectors": [
            "DeterministicTmsMapper",
            "applyDeterministicTmsMapping"
          ]
        }
      })
    ).resolves.toBe(true);
  });

  it("prevents deterministic TMS runtime from importing onboarding or model clients", async () => {
    await expect(
      assertNoForbiddenImports({
        rootDir: process.cwd(),
        includeGlobs: [
          "packages/connectors/src/tms/DeterministicTmsMapper.ts",
          "packages/connectors/src/tms/FileImportTmsAdapter.ts",
          "packages/connectors/src/tms/HttpTmsAdapter.ts",
          "packages/connectors/src/tms/TmsAdapter.ts",
          "packages/connectors/src/tms/TmsAdapterConfig.ts",
          "packages/connectors/src/tms/TmsSchemaDrift.ts"
        ],
        forbiddenFragments: [
          "TmsMappingOnboarding",
          "proposeTmsMappingFromSample",
          "OpenRouter",
          "openai",
          "anthropic",
          "@google/genai",
          "LangChain",
          "langchain"
        ]
      })
    ).resolves.toBe(true);
  });

  it("ignores forbidden text in comments, strings, and template literals", async () => {
    await withTempSource(
      "safe.ts",
      [
        "// import { DeterministicTmsMapper } from \"@quoteops/connectors\";",
        "const stringLiteral = \"@quoteops/quote-core OpenRouter openai\";",
        "const templateLiteral = `@quoteops/knowledge TmsMappingOnboarding`;"
      ].join("\n"),
      async (rootDir) => {
        await expect(guardTempSource(rootDir)).resolves.toBe(true);
      }
    );
  });

  it("rejects real forbidden import and export fixtures", async () => {
    const cases = [
      {
        fileName: "named-barrel-import.ts",
        code: 'import { DeterministicTmsMapper } from "@quoteops/connectors";'
      },
      {
        fileName: "namespace-barrel-import.ts",
        code: 'import * as connectors from "@quoteops/connectors";'
      },
      {
        fileName: "star-barrel-export.ts",
        code: 'export * from "@quoteops/connectors";'
      },
      {
        fileName: "multiline-import.ts",
        code: [
          "import {",
          "  TmsMappingOnboarding",
          '} from "./TmsMappingOnboarding";'
        ].join("\n")
      },
      {
        fileName: "multiline-export.ts",
        code: [
          "export {",
          "  applyDeterministicTmsMapping",
          '} from "@quoteops/connectors";'
        ].join("\n")
      },
      {
        fileName: "dynamic-import.ts",
        code: 'async function load() { return import("@quoteops/quote-core"); }'
      },
      {
        fileName: "dynamic-template-import.ts",
        code: "async function load() { return import(`@quoteops/quote-core`); }"
      },
      {
        fileName: "require-call.ts",
        code: 'const openai = require("openai");'
      },
      {
        fileName: "require-template-call.ts",
        code: "const openai = require(`openai`);"
      }
    ];

    for (const testCase of cases) {
      await withTempSource(testCase.fileName, testCase.code, async (rootDir) => {
        await expect(guardTempSource(rootDir)).rejects.toThrow(
          /forbidden import fragment/
        );
      });
    }
  });

  it("fails when an include path expands to zero source files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "quoteops-arch-guard-"));
    try {
      await mkdir(join(rootDir, "src"), { recursive: true });
      await expect(
        assertNoForbiddenImports({
          rootDir,
          includeGlobs: ["src/*.ts"],
          forbiddenFragments: ["@quoteops/quote-core"]
        })
      ).rejects.toThrow(/matched no source files/);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

async function withTempSource(
  fileName: string,
  source: string,
  callback: (rootDir: string) => Promise<void>
): Promise<void> {
  const rootDir = await mkdtemp(join(tmpdir(), "quoteops-arch-guard-"));
  try {
    const srcDir = join(rootDir, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(join(srcDir, fileName), `${source}\n`, "utf8");
    await callback(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

function guardTempSource(rootDir: string): Promise<true> {
  return assertNoForbiddenImports({
    rootDir,
    includeGlobs: ["src/*.ts"],
    forbiddenFragments: [
      "@quoteops/quote-core",
      "@langchain/langgraph",
      "@quoteops/knowledge",
      "TmsMappingOnboarding",
      "OpenRouter",
      "openai",
      "anthropic",
      "@google/genai"
    ],
    forbiddenExportsByModule: {
      "@quoteops/connectors": [
        "DeterministicTmsMapper",
        "applyDeterministicTmsMapping"
      ]
    }
  });
}
