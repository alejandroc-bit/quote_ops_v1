import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  createTmsAdapterFromConfig,
  loadTmsAdapterConfig,
  type HistoricalSearchQuery
} from "@quoteops/connectors";
import type { QuoteManifest } from "@quoteops/quote-core";
import type { TmsCanonicalPerformance } from "@quoteops/contracts";
import {
  ansi,
  ask,
  askMasked,
  bootAnimation,
  confirm,
  createSpinner,
  fail,
  info,
  line,
  ok,
  paint,
  renderBanner,
  section,
  select,
  warn
} from "./tronUi.js";
import {
  buildProfileStub,
  buildTmsAdapterYaml,
  createCopilot,
  applyAuthorizationToAgentConfig,
  mergeConfiguredProfileStubs,
  readEnvFileValues,
  readSingleLineSecret,
  validateTmsBaseUrl,
  writeSecret,
  type Copilot,
  type ProfileCommercialLayer
} from "./onboardConfig.js";
import {
  configureLegacyCustomHttp,
  configureTmsHttpV1,
  hasMatchingTmsProbeReceipt,
  readTmsCredentialRevision
} from "./tmsProbe.js";
import {
  applyAuthorization,
  buildSampleQuoteRows,
  parseDomainList,
  parseRbTable,
  renderQuoteTable,
  runSampleValidationLoop,
  validateAuthorization,
  validateMinimumMargin,
  validateMarginParams,
  type OnboardManifest
} from "./wizardSteps.js";
import {
  createFileOnboardingStateStore,
  parseOnboardingSelection,
  readOnboardingAnswersFile,
  runOnboarding,
  OnboardingError,
  type OnboardPaths as FlowOnboardPaths,
  type OnboardingAnswers,
  type OnboardingContext,
  type OnboardingPhase
} from "./onboardingFlow.js";
import { aiProviderPhase } from "./aiProviderStep.js";
import {
  applianceSecretsPhase,
  knowledgePhase,
  runKnowledgeIngestion
} from "./applianceSecretsStep.js";
import { cloudflarePhase } from "./cloudflareStep.js";

type OnboardPaths = {
  secretsFile: string;
  manifestPath: string;
  tmsAdapterConfigPath: string;
  agentConfigPath: string;
  apiBaseUrl: string;
  flow: FlowOnboardPaths;
};

function resolvePaths(env: NodeJS.ProcessEnv): OnboardPaths {
  const secretsFile =
    env.QUOTEOPS_SECRETS_ENV_FILE ??
    "/opt/quoteops-v1/secrets/client.env";
  const home = env.QUOTEOPS_HOME ?? dirname(dirname(secretsFile));
  const settingsDir = env.QUOTEOPS_SETTINGS_DIR ?? join(home, "settings");
  const agentConfigPath =
    env.QUOTEOPS_AGENT_CONFIG_PATH ??
    join(home, "connectors/agent/agent-config.yaml");
  const tmsAdapterConfigPath =
    env.QUOTEOPS_TMS_ADAPTER_CONFIG_PATH ??
    join(home, "connectors/tms-adapter.yaml");
  const apiBaseUrl =
    env.QUOTEOPS_ONBOARD_API_URL ?? "http://quoteops-api:8080";
  return {
    secretsFile,
    manifestPath:
      env.QUOTEOPS_MANIFEST_PATH ??
      join(home, "manifests/client-manifest.yaml"),
    tmsAdapterConfigPath,
    agentConfigPath,
    apiBaseUrl,
    flow: {
      apiBaseUrl,
      agentConfigFile: agentConfigPath,
      clientSecretsFile: secretsFile,
      cloudflareSecretsFile:
        env.QUOTEOPS_CLOUDFLARE_ENV_FILE ??
        join(home, "secrets/cloudflare.env"),
      aiValidationReceiptFile:
        env.QUOTEOPS_AI_VALIDATION_RECEIPT_PATH ??
        join(settingsDir, "ai-provider-validation.json"),
      mailboxProbeReceiptFile:
        env.QUOTEOPS_MAILBOX_PROBE_RECEIPT_PATH ??
        join(settingsDir, "mailbox-probe.json"),
      knowledgeReceiptFile:
        env.QUOTEOPS_KNOWLEDGE_RECEIPT_PATH ??
        join(settingsDir, "knowledge-ingest.json"),
      settingsDir,
      onboardingStateFile:
        env.QUOTEOPS_ONBOARDING_STATE_PATH ??
        join(settingsDir, "onboarding-state.json"),
      tmsAdapterConfigFile: tmsAdapterConfigPath,
      tmsProbeFile:
        env.QUOTEOPS_TMS_PROBE_PATH ?? join(settingsDir, "tms-probe.json"),
      testRfqReceiptFile:
        env.QUOTEOPS_TEST_RFQ_RECEIPT_PATH ??
        join(settingsDir, "test-rfq.json")
    }
  };
}

async function main(argv: string[]): Promise<void> {
  const paths = resolvePaths(process.env);
  const flag = argv.find((arg) =>
    ["--sync-units", "--map-tms"].includes(arg)
  );
  const selection = parseOnboardingSelection(argv);

  // subcommands re-run a single step (unit alta / re-mapping / re-ingest anytime)
  if (flag === "--sync-units") return void (await stepSyncUnits(paths, null));
  if (flag === "--map-tms") return void (await stepTms(paths, null));

  await bootAnimation();
  line(renderBanner());
  line(`\n${paint(ansi.cyan + ansi.bold, "Bienvenido.")} Voy a guiarte por la puesta en marcha del appliance.`);

  if (argv.includes("--allow-static-guidance")) {
    await runLegacyOnboarding(paths);
    return;
  }

  const answersFile = argumentValue(argv, "--answers-file");
  if (argv.includes("--answers-file") && !answersFile) {
    throw new OnboardingError("onboarding_answers_invalid", { exitCode: 2 });
  }
  let answers: OnboardingAnswers | null = null;
  if (answersFile) {
    answers = await readOnboardingAnswersFile(resolve(answersFile));
  }
  const context: OnboardingContext = {
    io: {
      ask,
      askMasked,
      confirm,
      select: async <T extends string>(
        prompt: string,
        options: Array<{ value: T; label: string }>
      ) => (await select(prompt, options)) as T,
      info,
      warn
    },
    env: process.env,
    paths: paths.flow,
    guided: answers === null,
    answers,
    fetch,
    stateStore: createFileOnboardingStateStore(
      paths.flow.onboardingStateFile
    ),
    ...(answersFile ? { answersRoot: dirname(resolve(answersFile)) } : {})
  };
  if (argv.includes("--ingest")) {
    await runKnowledgeIngestion(context);
    return;
  }

  const result = await runOnboarding({
    phases: onboardingPhases(paths),
    context,
    selection
  });
  line(section("Onboarding completo"));
  ok(
    `Fases listas: ${result.completed_phases.join(", ") || "ninguna"}.`
  );
  if (result.public_url) info(`URL pública: ${result.public_url}`);
  info(
    "Si capturaste secretos nuevos, reinicia el stack para aplicarlos: docker compose up -d"
  );
}

async function runLegacyOnboarding(paths: OnboardPaths): Promise<void> {
  const copilot = await stepAiKey(paths);
  await stepSecrets(paths, copilot);
  const tmsEnv = await stepTms(paths, copilot);
  const configuredProfileIds = await stepSyncUnits(
    paths,
    copilot,
    tmsEnv
  );
  await stepAuthorization(paths, copilot);
  await stepValidatePricing(paths, copilot, configuredProfileIds);
  await stepIngest(paths, copilot);

  line(section("Onboarding completo"));
  ok("El appliance quedó configurado. Revisa el tablero para ver el estado de readiness.");
  info("Si capturaste secretos nuevos, reinicia el stack para aplicarlos: docker compose up -d");
}

function onboardingPhases(paths: OnboardPaths): OnboardingPhase[] {
  const tmsPhase: OnboardingPhase = {
    id: "tms",
    async isComplete(context) {
      return isTmsPhaseComplete(context);
    },
    async run(context) {
      const tmsEnv = await stepTms(
        paths,
        context.copilot ?? null,
        context
      );
      context.env = tmsEnv as NodeJS.ProcessEnv;
    }
  };
  const unitsPhase: OnboardingPhase = {
    id: "units",
    async isComplete() {
      const manifest = await readManifest(paths.manifestPath);
      return Boolean(
        manifest?.vehicle_profiles?.some(
          (profile) => profile.performance_source === "tms"
        )
      );
    },
    async run(context) {
      if (!context.guided) {
        throw new OnboardingError("onboarding_pending", { phase: "units" });
      }
      await stepSyncUnits(
        paths,
        context.copilot ?? null,
        context.env
      );
    }
  };
  const authorizationPhase: OnboardingPhase = {
    id: "authorization",
    async isComplete() {
      try {
        const config = parseYaml(
          await readFile(paths.agentConfigPath, "utf8")
        ) as {
          authorization?: {
            approver_email?: unknown;
            allowed_domains?: unknown;
          };
        };
        return (
          typeof config.authorization?.approver_email === "string" &&
          Array.isArray(config.authorization.allowed_domains)
        );
      } catch {
        return false;
      }
    },
    async run(context) {
      if (!context.guided) {
        throw new OnboardingError("onboarding_pending", {
          phase: "authorization"
        });
      }
      await stepAuthorization(paths, context.copilot ?? null);
    }
  };
  const pricingPhase: OnboardingPhase = {
    id: "pricing",
    async isComplete() {
      const manifest = await readManifest(paths.manifestPath);
      return Boolean(
        manifest?.vehicle_profiles?.length &&
          manifest.vehicle_profiles.every(
            (profile) =>
              Number.isFinite(profile.margin_target_pct) &&
              Number.isFinite(profile.minimum_margin_pct)
          )
      );
    },
    async run(context) {
      if (!context.guided) {
        throw new OnboardingError("onboarding_pending", { phase: "pricing" });
      }
      await stepValidatePricing(
        paths,
        context.copilot ?? null,
        (await readManifest(paths.manifestPath))?.vehicle_profiles?.map(
          (profile) => profile.vehicle_profile_id
        ) ?? []
      );
    }
  };
  return [
    aiProviderPhase,
    cloudflarePhase,
    applianceSecretsPhase,
    tmsPhase,
    unitsPhase,
    authorizationPhase,
    pricingPhase,
    knowledgePhase
  ];
}

async function stepAiKey(paths: OnboardPaths): Promise<Copilot | null> {
  line(section("Paso 1 · Inteligencia Artificial"));
  info("Tu clave de IA enciende el copiloto que guía este onboarding.");
  info(
    "Se guarda localmente en un archivo accesible sólo por root (`0600`); el copiloto nunca ve tus otros secretos."
  );

  const provider = (await select("¿Qué proveedor de IA usarás?", [
    { value: "openrouter", label: "OpenRouter (recomendado)" },
    { value: "gemini", label: "Google Gemini" }
  ])) as "openrouter" | "gemini";
  const apiKey = await askMasked("Pega tu API key");
  if (!apiKey) {
    warn("Sin clave de IA el copiloto queda deshabilitado; continúo con texto estático.");
    return null;
  }

  const envKey = provider === "gemini" ? "GEMINI_API_KEY" : "OPENROUTER_API_KEY";
  await writeSecret(paths.secretsFile, envKey, apiKey);
  ok(`Clave guardada en ${envKey}.`);

  const model = provider === "gemini" ? "gemini-1.5-flash" : "openai/gpt-4o-mini";
  const copilot = createCopilot({ provider, apiKey, model });
  const spin = createSpinner("Validando clave con el copiloto…");
  const greeting = await copilot.explain(
    "Copiloto listo. Te acompaño en cada paso.",
    "Preséntate en una frase como copiloto de onboarding."
  );
  spin.stop("Copiloto en línea.");
  info(paint(ansi.magenta, `⟩ ${greeting}`));
  return copilot;
}

async function stepSecrets(paths: OnboardPaths, copilot: Copilot | null): Promise<void> {
  line(section("Paso 2 · Secretos del appliance"));
  await guide(copilot, "Capturamos las credenciales de correo, rutas y embeddings.", "Explica por qué el appliance necesita las credenciales de buzón de correo, SAKBE (rutas) y embeddings.");

  const captures: Array<{ key: string; prompt: string; optional?: boolean }> = [
    { key: "MAILBOX_USER", prompt: "Correo del buzón del agente (IMAP/Gmail/Outlook)", optional: true },
    { key: "MAILBOX_PASSWORD", prompt: "Contraseña de aplicación del buzón", optional: true },
    { key: "INEGI_SAKBE_KEY", prompt: "API key de SAKBE (rutas INEGI)", optional: true },
    { key: "QUOTEOPS_EMBEDDING_API_KEY", prompt: "API key de embeddings (cerebro vectorial)", optional: true }
  ];
  for (const capture of captures) {
    const value = await askMasked(`${capture.prompt}${capture.optional ? " (enter para omitir)" : ""}`);
    if (!value) {
      info(`${capture.key}: omitido.`);
      continue;
    }
    await writeSecret(paths.secretsFile, capture.key, value);
    ok(`${capture.key} guardado.`);
  }
}

async function stepTms(
  paths: OnboardPaths,
  copilot: Copilot | null,
  context?: OnboardingContext
): Promise<Record<string, string | undefined>> {
  line(section("Paso 3 · Conexión al TMS"));
  await guide(
    copilot,
    "El TMS es la fuente de verdad de rendimientos, unidades, zonas e histórico.",
    "Explica las integraciones TMS: API REST QuoteOps v1, REST avanzada existente, exportaciones CSV y SQL."
  );

  if (context?.answers?.tms) {
    const result = await configureTmsHttpV1(
      {
        baseUrl: context.answers.tms.base_url,
        apiKey: context.answers.tms.api_key,
        sampleQuery: context.answers.tms.sample_query
      },
      context
    );
    ok("Contrato REST QuoteOps v1 validado en vivo.");
    return result.env;
  }
  if (context && !context.guided) {
    throw new OnboardingError("onboarding_pending", { phase: "tms" });
  }

  const choose =
    context?.io.select.bind(context.io) ??
    (async <T extends string>(
      prompt: string,
      options: Array<{ value: T; label: string }>
    ) => (await select(prompt, options)) as T);
  const provider = await choose(
    "¿Cómo conecta el TMS del cliente?",
    [
      {
        value: "http_v1",
        label: "API REST QuoteOps v1 (recomendado)"
      },
      {
        value: "http_legacy",
        label: "Configuración REST avanzada existente"
      },
      { value: "file_import", label: "Exportaciones CSV" },
      { value: "sql", label: "SQL" }
    ]
  );
  const askText = context?.io.ask.bind(context.io) ?? ask;
  const askSecret = context?.io.askMasked.bind(context.io) ?? askMasked;
  const runtimeContext = context ?? {
    env: process.env,
    fetch,
    paths: paths.flow
  };

  let yaml: string;
  if (provider === "file_import") {
    yaml = buildTmsAdapterYaml({ provider: "file_import" });
    info("Deja los CSV canónicos en el directorio de connectors/tms.");
  } else if (provider === "http_v1" || provider === "http_legacy") {
    const baseUrl = await askText(
      "URL base HTTPS del TMS (sólo origen, sin ruta)"
    );
    const apiKey = await askSecret("Bearer token del TMS");
    const sampleQuery = await captureHistoricalProbeQuery(askText);
    const result =
      provider === "http_v1"
        ? await configureTmsHttpV1(
            { baseUrl, apiKey, sampleQuery },
            runtimeContext
          )
        : await configureLegacyCustomHttp(
            {
              baseUrl,
              apiKey,
              sampleQuery,
              endpoints: {
                health_endpoint_path: await askText(
                  "Ruta de health",
                  "/health"
                ),
                search_historical_quotes_endpoint_path: await askText(
                  "Ruta de histórico de cotizaciones",
                  "/historical-quotes/search"
                ),
                get_units_endpoint_path: await askText(
                  "Ruta de unidades",
                  "/units"
                ),
                get_unit_performance_endpoint_path: await askText(
                  "Ruta de rendimientos",
                  "/unit-performance"
                ),
                get_availability_zones_endpoint_path: await askText(
                  "Ruta de zonas de disponibilidad",
                  "/availability-zones"
                ),
                write_quote_endpoint_path: await askText(
                  "Ruta de escritura de cotizaciones",
                  "/quotes"
                )
              }
            },
            runtimeContext
          );
    ok("TMS validado en vivo sin ejecutar writeback.");
    return result.env;
  } else {
    const dialect = (await select("¿Motor de la base SQL?", [
      { value: "postgres", label: "PostgreSQL (Google Cloud SQL / otra)" },
      { value: "mysql", label: "MySQL (Google Cloud SQL / otra)" },
      { value: "mssql", label: "SQL Server (Azure SQL / otra)" }
    ])) as "postgres" | "mysql" | "mssql";
    const url = await askSecret("Cadena de conexión de la base SQL (usuario read-only)");
    if (url) await writeSecret(paths.secretsFile, "TMS_SQL_URL", url);
    await guide(
      copilot,
      "Cada SELECT alias-a las columnas canónicas. Los valores del RFQ siempre van como parámetros :nombre.",
      "Explica que en el adaptador SQL cada consulta debe aliasar sus columnas a los nombres canónicos y usar parámetros con dos puntos, nunca interpolación."
    );
    info("Consulta connectors/tms-sql-contract.md para las columnas canónicas de cada entidad.");
    const queries = await captureSqlQueries();
    yaml = buildTmsAdapterYaml({
      provider: "sql",
      dialect,
      connection_url_env: "TMS_SQL_URL",
      queries
    });
  }

  await writeFile(paths.tmsAdapterConfigPath, yaml, "utf8");
  ok(`Configuración del TMS escrita en ${paths.tmsAdapterConfigPath}.`);
  return context?.env ?? process.env;
}

async function captureHistoricalProbeQuery(
  askText: (prompt: string, initial?: string) => Promise<string>
): Promise<HistoricalSearchQuery> {
  return {
    request_id: `onboarding-tms-${Date.now()}`,
    origin: {
      city: await askText("Ciudad origen de prueba"),
      state: await askText("Estado origen de prueba"),
      country: await askText("País origen ISO-2", "MX")
    },
    destination: {
      city: await askText("Ciudad destino de prueba"),
      state: await askText("Estado destino de prueba"),
      country: await askText("País destino ISO-2", "MX")
    },
    vehicle_profile_id:
      (await askText("ID de unidad/perfil de prueba (opcional)")) ||
      undefined,
    time_window: {
      from: await askText("Ventana histórica desde (YYYY-MM-DD)"),
      to: await askText("Ventana histórica hasta (YYYY-MM-DD)")
    },
    max_results: 20
  };
}

async function captureSqlQueries(): Promise<Record<string, string>> {
  const entities: Array<{ key: string; label: string }> = [
    { key: "historical_quotes", label: "histórico de cotizaciones" },
    { key: "units", label: "unidades" },
    { key: "performance", label: "rendimientos (unit_type, kpl_yield, real_cost_per_km)" },
    { key: "availability_zones", label: "zonas de disponibilidad" }
  ];
  const queries: Record<string, string> = {};
  for (const entity of entities) {
    const sql = await ask(`SELECT para ${entity.label} (enter para omitir)`);
    if (sql) queries[entity.key] = sql;
  }
  return queries;
}

async function stepSyncUnits(
  paths: OnboardPaths,
  copilot: Copilot | null,
  env: Record<string, string | undefined> = process.env
): Promise<string[]> {
  line(section("Paso 4 · Sincronizar unidades desde el TMS"));
  await guide(
    copilot,
    "Leo los tipos de unidad y su rendimiento del TMS y creo un perfil por cada uno.",
    "Explica que este paso consulta los rendimientos del TMS y crea perfiles de vehículo, y que el tipo de unidad se vuelve el id del perfil."
  );

  let performance: TmsCanonicalPerformance[];
  const spin = createSpinner("Consultando rendimientos del TMS…");
  try {
    const adapter = await createTmsAdapterFromConfig(
      paths.tmsAdapterConfigPath,
      { env }
    );
    performance = await adapter.getUnitPerformance();
    spin.stop(`Recibidos ${performance.length} tipos de unidad.`);
  } catch (error) {
    spin.stop();
    warn(`No pude leer rendimientos del TMS: ${(error as Error).message}`);
    performance = [];
  }

  const manifest = await readManifest(paths.manifestPath);
  if (!manifest) {
    fail(`No encontré el manifest en ${paths.manifestPath}.`);
    return [];
  }
  const defaultBu = manifest.business_units.find((unit) => unit.default) ?? manifest.business_units[0];

  if (performance.length === 0) {
    warn("El TMS no devolvió rendimientos; conservaré los datos físicos existentes y capturaré el modelo comercial manualmente.");
    const configured = [];
    for (const profile of manifest.vehicle_profiles) {
      const commercial = await captureCommercialLayer(
        profile.vehicle_profile_id,
        profile.business_unit_id ?? defaultBu?.business_unit_id ?? "general",
        profile
      );
      configured.push(applyCommercialLayer(profile, commercial));
    }
    await writeManifest(paths.manifestPath, { ...manifest, vehicle_profiles: configured });
    ok(`Modelo comercial actualizado para ${configured.length} perfil(es).`);
    return configured.map((profile) => profile.vehicle_profile_id);
  }

  const configurations = [];
  for (const perf of performance) {
    info(
      `Unidad ${paint(ansi.cyan, perf.unit_type)} · TMS: ${perf.kpl_yield} km/l · $${perf.real_cost_per_km}/km`
    );
    const existing = manifest.vehicle_profiles.find(
      (profile) => profile.vehicle_profile_id === perf.unit_type
    );
    const commercial = await captureCommercialLayer(
      perf.unit_type,
      defaultBu?.business_unit_id ?? "general",
      existing
    );
    configurations.push({ stub: buildProfileStub(perf, commercial), commercial });
  }
  const merged = mergeConfiguredProfileStubs(manifest, configurations);
  await writeManifest(paths.manifestPath, merged);
  ok(
    `Manifest actualizado con ${configurations.length} perfil(es). El runtime lo recarga sin reinicio.`
  );
  return configurations.map(({ stub }) => stub.vehicle_profile_id);
}

async function captureCommercialLayer(
  unitType: string,
  defaultBu: string,
  current?: QuoteManifest["vehicle_profiles"][number]
): Promise<ProfileCommercialLayer> {
  const pricingModel = (await select(`Modelo de precio para ${unitType}`, [
    { value: "formula", label: "Fórmula (costo + margen)" },
    { value: "profitability", label: "Rentabilidad (tabla RB)" }
  ])) as "formula" | "profitability";
  let marginTarget = current?.margin_target_pct ?? 0.25;
  let marginMin = current?.minimum_margin_pct ?? 0.18;
  let rbTable = current?.profitability_rb_table;

  if (pricingModel === "formula") {
    while (true) {
      marginTarget = Number(
        await ask("Margen objetivo (ej. 0.25)", String(current?.margin_target_pct ?? 0.25))
      );
      marginMin = Number(
        await ask("Margen mínimo (ej. 0.18)", String(current?.minimum_margin_pct ?? 0.18))
      );
      const errors = validateMarginParams(marginTarget, marginMin);
      if (errors.length === 0) break;
      errors.forEach(warn);
    }
  } else {
    while (true) {
      marginMin = Number(
        await ask(
          "Margen mínimo de control (ej. 0.18)",
          String(current?.minimum_margin_pct ?? 0.18)
        )
      );
      const errors = validateMinimumMargin(marginMin);
      if (errors.length === 0) break;
      errors.forEach(warn);
    }
    while (true) {
      const currentRb = rbTable
        ?.map((bracket) => `${bracket.max_km ?? "*"}:${bracket.rb_pct}`)
        .join(", ");
      const raw = await ask(
        "Tabla RB max_km:rb (ej. 100:0.6, 500:0.6, *:0.5)",
        currentRb ?? "100:0.6, 500:0.6, 1000:0.57, 2000:0.55, 3000:0.52, *:0.5"
      );
      try {
        rbTable = parseRbTable(raw) ?? undefined;
        break;
      } catch (error) {
        warn((error as Error).message);
      }
    }
  }
  const keywordsRaw = await ask("Palabras clave adicionales (separadas por coma)", "");
  return {
    business_unit_id: defaultBu,
    pricing_model: pricingModel,
    margin_target_pct: Number.isFinite(marginTarget) ? marginTarget : 0.25,
    minimum_margin_pct: Number.isFinite(marginMin) ? marginMin : 0.18,
    ...(pricingModel === "profitability" && rbTable
      ? { profitability_rb_table: rbTable }
      : {}),
    keywords: keywordsRaw
      ? keywordsRaw.split(",").map((keyword) => keyword.trim()).filter(Boolean)
      : []
  };
}

function applyCommercialLayer(
  profile: QuoteManifest["vehicle_profiles"][number],
  commercial: ProfileCommercialLayer
): QuoteManifest["vehicle_profiles"][number] {
  return {
    ...profile,
    business_unit_id: commercial.business_unit_id,
    pricing_model: commercial.pricing_model,
    margin_target_pct: commercial.margin_target_pct,
    minimum_margin_pct: commercial.minimum_margin_pct,
    keywords: [...new Set([...(profile.keywords ?? []), ...(commercial.keywords ?? [])])],
    ...(commercial.profitability_rb_table
      ? { profitability_rb_table: commercial.profitability_rb_table }
      : { profitability_rb_table: undefined })
  };
}

async function stepAuthorization(paths: OnboardPaths, copilot: Copilot | null): Promise<void> {
  line(section("Paso 5 · Autorización del cliente"));
  await guide(
    copilot,
    "Definimos quién aprueba y qué dominios pueden solicitar cotizaciones.",
    "Explica que el correo aprobador, los dominios permitidos y el WhatsApp del aprobador forman el límite de autorización del cliente."
  );
  const manifest = await readManifest(paths.manifestPath);
  if (!manifest) {
    fail(`No encontré el manifest en ${paths.manifestPath}.`);
    return;
  }

  while (true) {
    const authorization = {
      approver_email: await ask("Correo del aprobador", manifest.authorization?.approver_email ?? ""),
      allowed_domains: parseDomainList(
        await ask(
          "Dominios permitidos (separados por coma)",
          manifest.authorization?.allowed_domains.join(", ") ?? ""
        )
      ),
      whatsapp_approver_phone: await ask(
        "WhatsApp del aprobador (+52…)",
        manifest.authorization?.whatsapp_approver_phone ?? ""
      )
    };
    const errors = validateAuthorization(authorization);
    if (errors.length > 0) {
      errors.forEach(warn);
      continue;
    }
    const updated = applyAuthorization(manifest, authorization);
    const agentConfig = await readFile(paths.agentConfigPath, "utf8");
    await writeManifest(paths.manifestPath, updated);
    await writeFile(
      paths.agentConfigPath,
      applyAuthorizationToAgentConfig(agentConfig, updated.authorization!),
      "utf8"
    );
    ok("Autorización persistida en manifest y agent-config.");
    return;
  }
}

async function stepValidatePricing(
  paths: OnboardPaths,
  copilot: Copilot | null,
  configuredProfileIds: readonly string[]
): Promise<void> {
  line(section("Paso 6 · Validación de tarifas"));
  await guide(
    copilot,
    "Calculo tres cotizaciones de muestra con quote-core para validar los parámetros.",
    "Explica que quote-core, no la IA, calcula tres cotizaciones de muestra y que los parámetros se pueden ajustar antes de aceptar."
  );
  const manifest = await readManifest(paths.manifestPath);
  if (!manifest) {
    fail(`No encontré el manifest en ${paths.manifestPath}.`);
    return;
  }
  const accepted = await runSampleValidationLoop(manifest, {
    profileIds: configuredProfileIds,
    show(rows) {
      line(`\n${renderQuoteTable(rows)}\n`);
    },
    confirm: () => confirm("¿Confirmas estas tres tarifas de muestra?"),
    adjust: async (current, rows) => {
      const profilesNeedingReview = rows
        .filter((row) => row.status !== "APPROVED")
        .map((row) => row.unit);
      const candidates = [
        ...new Set(profilesNeedingReview.length > 0 ? profilesNeedingReview : rows.map((row) => row.unit))
      ];
      if (profilesNeedingReview.length > 0) {
        warn(
          `No puedes confirmar mientras haya muestras en revisión: ${[
            ...new Set(
              rows
                .filter((row) => row.status !== "APPROVED")
                .flatMap((row) => row.review_reasons)
            )
          ].join(", ")}`
        );
      }
      const profileId =
        candidates.length === 1
          ? candidates[0]!
          : await select(
              "¿Qué perfil quieres ajustar?",
              candidates.map((candidate) => ({ value: candidate, label: candidate }))
            );
      const profile = current.vehicle_profiles.find(
        (candidate) => candidate.vehicle_profile_id === profileId
      );
      if (!profile) throw new Error("el manifest no tiene vehicle_profiles");
      warn(`Ajustemos los parámetros del perfil ${profile.vehicle_profile_id}.`);
      const commercial = await captureCommercialLayer(
        profile.vehicle_profile_id,
        profile.business_unit_id ?? "general",
        profile
      );
      return {
        ...current,
        vehicle_profiles: current.vehicle_profiles.map((entry) =>
          entry.vehicle_profile_id === profile.vehicle_profile_id
            ? applyCommercialLayer(entry, commercial)
            : entry
        )
      };
    }
  });
  await writeManifest(paths.manifestPath, accepted);
  ok("Tarifas de muestra confirmadas.");
}

async function stepIngest(paths: OnboardPaths, copilot: Copilot | null): Promise<void> {
  line(section("Paso 7 · Cerebro vectorial (criterio comercial)"));
  await guide(
    copilot,
    "El texto se envía al proveedor de embeddings configurado; los vectores y la base de QuoteOps permanecen locales.",
    "Explica que el texto de los documentos se envía al proveedor de embeddings configurado, mientras los vectores y la base de QuoteOps permanecen locales."
  );
  if (
    !(await confirm(
      "¿Aceptas transferir el texto al proveedor de embeddings e ingerirlo ahora?"
    ))
  ) {
    info("Puedes hacerlo luego con: onboard --ingest");
    return;
  }
  const spin = createSpinner("Ingiriendo documentos…");
  const response = await postJson(`${paths.apiBaseUrl}/api/knowledge/ingest`, {});
  spin.stop();
  if (!response.ok) {
    throw new OnboardingError("knowledge_ingest_failed");
  }
  const body = response.body as {
    document_count?: number;
    ingested?: Array<{ chunk_count?: number }>;
  };
  const chunks = (body.ingested ?? []).reduce(
    (sum, item) => sum + (item.chunk_count ?? 0),
    0
  );
  if ((body.document_count ?? 0) <= 0 || chunks <= 0) {
    throw new OnboardingError("knowledge_ingest_empty");
  }
  ok(`Ingeridos ${body.document_count} documento(s) al cerebro vectorial.`);
}

async function guide(copilot: Copilot | null, fallback: string, context: string): Promise<void> {
  if (!copilot) {
    info(fallback);
    return;
  }
  const text = await copilot.explain(fallback, context);
  info(paint(ansi.magenta, `⟩ ${text}`));
}

async function readManifest(path: string): Promise<OnboardManifest | null> {
  try {
    return parseYaml(await readFile(path, "utf8")) as OnboardManifest;
  } catch {
    return null;
  }
}

async function writeManifest(path: string, manifest: QuoteManifest): Promise<void> {
  await writeFile(path, stringifyYaml(manifest), "utf8");
}

async function postJson(
  url: string,
  payload: unknown
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    const body = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: { error: (error as Error).message } };
  }
}

function argumentValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new OnboardingError("onboarding_argument_missing", {
      exitCode: 2
    });
  }
  return value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

async function isTmsPhaseComplete(
  context: OnboardingContext
): Promise<boolean> {
  try {
    const config = await loadTmsAdapterConfig(
      context.paths.tmsAdapterConfigFile
    );
    if (config.provider !== "http") return true;
    const expectedContract =
      config.contract === "quoteops-tms-http-v1"
        ? "quoteops-tms-http-v1"
        : "legacy-custom-http-canonical-output-v1";
    if (
      context.answers?.tms &&
      expectedContract !== "quoteops-tms-http-v1"
    ) {
      return false;
    }
    if (context.answers?.tms) {
      const configured = await readEnvFileValues(
        context.paths.clientSecretsFile
      );
      const desiredKey = await readSingleLineSecret(
        context.answers.tms.api_key,
        context
      );
      if (
        configured.get("TMS_HTTP_BASE_URL") !==
          validateTmsBaseUrl(
            context.answers.tms.base_url,
            context.env.QUOTEOPS_ACCEPTANCE_MODE
          ) ||
        configured.get("TMS_API_KEY") !== desiredKey
      ) {
        return false;
      }
    }
    const credentialRevision = await readTmsCredentialRevision(
      join(context.paths.settingsDir, "tms-credential-revision")
    );
    return (
      credentialRevision >= 1 &&
      (await hasMatchingTmsProbeReceipt({
        adapterConfigPath: context.paths.tmsAdapterConfigFile,
        receiptPath: context.paths.tmsProbeFile,
        credentialRevision,
        expectedContract
      }))
    );
  } catch {
    return false;
  }
}

main(process.argv.slice(2)).catch((error) => {
  const onboardingError =
    error instanceof OnboardingError ? error : null;
  fail(onboardingError?.code ?? (error as Error).message);
  process.exitCode = onboardingError?.exitCode ?? 1;
});
