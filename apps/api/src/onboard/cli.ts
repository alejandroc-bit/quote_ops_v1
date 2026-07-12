import { readFile, writeFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createTmsAdapterFromConfig } from "@quoteops/connectors";
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
  mergeProfileStubs,
  writeSecret,
  type Copilot,
  type ProfileCommercialLayer
} from "./onboardConfig.js";
import {
  applyAuthorization,
  buildSampleQuoteRows,
  parseDomainList,
  parseRbTable,
  renderQuoteTable,
  validateAuthorization,
  validateMarginParams,
  type OnboardManifest
} from "./wizardSteps.js";

type OnboardPaths = {
  secretsFile: string;
  manifestPath: string;
  tmsAdapterConfigPath: string;
  apiBaseUrl: string;
};

function resolvePaths(env: NodeJS.ProcessEnv): OnboardPaths {
  return {
    secretsFile: env.QUOTEOPS_SECRETS_ENV_FILE ?? "/opt/quoteops/secrets/client.env",
    manifestPath: env.QUOTEOPS_MANIFEST_PATH ?? "/opt/quoteops/manifests/client-manifest.yaml",
    tmsAdapterConfigPath:
      env.QUOTEOPS_TMS_ADAPTER_CONFIG_PATH ?? "/opt/quoteops/connectors/tms-adapter.yaml",
    apiBaseUrl: env.QUOTEOPS_ONBOARD_API_URL ?? "http://quoteops-api:8080"
  };
}

async function main(argv: string[]): Promise<void> {
  const paths = resolvePaths(process.env);
  const flag = argv.find((arg) => arg.startsWith("--"));

  // subcommands re-run a single step (unit alta / re-mapping / re-ingest anytime)
  if (flag === "--sync-units") return void (await stepSyncUnits(paths, null));
  if (flag === "--map-tms") return void (await stepTms(paths, null));
  if (flag === "--ingest") return void (await stepIngest(paths, null));

  await bootAnimation();
  line(renderBanner());
  line(`\n${paint(ansi.cyan + ansi.bold, "Bienvenido.")} Voy a guiarte por la puesta en marcha del appliance.`);

  const copilot = await stepAiKey(paths);
  await stepSecrets(paths, copilot);
  await stepTms(paths, copilot);
  await stepSyncUnits(paths, copilot);
  await stepIngest(paths, copilot);
  await stepTestRfq(paths, copilot);

  line(section("Onboarding completo"));
  ok("El appliance quedó configurado. Revisa el tablero para ver el estado de readiness.");
  info("Si capturaste secretos nuevos, reinicia el stack para aplicarlos: docker compose up -d");
}

async function stepAiKey(paths: OnboardPaths): Promise<Copilot | null> {
  line(section("Paso 1 · Inteligencia Artificial"));
  info("Tu clave de IA enciende el copiloto que guía este onboarding.");
  info("Se guarda cifrada localmente; el copiloto nunca ve tus otros secretos.");

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

async function stepTms(paths: OnboardPaths, copilot: Copilot | null): Promise<void> {
  line(section("Paso 3 · Conexión al TMS"));
  await guide(
    copilot,
    "El TMS es la fuente de verdad de rendimientos, unidades, zonas e histórico.",
    "Explica los tres niveles de integración TMS: file_import (exportaciones CSV), http (API moderna) y sql (base de datos del TMS casero)."
  );

  const provider = (await select("¿Cómo conecta el TMS del cliente?", [
    { value: "file_import", label: "Exportaciones CSV (file_import)" },
    { value: "http", label: "API HTTP moderna" },
    { value: "sql", label: "Base SQL profesional (Cloud SQL / Azure SQL / otra)" }
  ])) as "file_import" | "http" | "sql";

  let yaml: string;
  if (provider === "file_import") {
    yaml = buildTmsAdapterYaml({ provider: "file_import" });
    info("Deja los CSV canónicos en el directorio de connectors/tms.");
  } else if (provider === "http") {
    const baseUrlEnv = "TMS_HTTP_BASE_URL";
    const baseUrl = await ask("URL base de la API del TMS (https://…)");
    if (baseUrl) await writeSecret(paths.secretsFile, baseUrlEnv, baseUrl);
    yaml = buildTmsAdapterYaml({
      provider: "http",
      base_url_env: baseUrlEnv,
      endpoints: {
        search_historical_quotes_endpoint_path: await ask(
          "Ruta de histórico de cotizaciones",
          "/quotes/historical"
        ),
        get_units_endpoint_path: await ask("Ruta de unidades", "/units"),
        get_unit_performance_endpoint_path: await ask("Ruta de rendimientos", "/units/performance"),
        get_availability_zones_endpoint_path: await ask("Ruta de zonas de disponibilidad", "/zones")
      }
    });
  } else {
    const dialect = (await select("¿Motor de la base SQL?", [
      { value: "postgres", label: "PostgreSQL (Google Cloud SQL / otra)" },
      { value: "mysql", label: "MySQL (Google Cloud SQL / otra)" },
      { value: "mssql", label: "SQL Server (Azure SQL / otra)" }
    ])) as "postgres" | "mysql" | "mssql";
    const url = await askMasked("Cadena de conexión de la base SQL (usuario read-only)");
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

async function stepSyncUnits(paths: OnboardPaths, copilot: Copilot | null): Promise<void> {
  line(section("Paso 4 · Sincronizar unidades desde el TMS"));
  await guide(
    copilot,
    "Leo los tipos de unidad y su rendimiento del TMS y creo un perfil por cada uno.",
    "Explica que este paso consulta los rendimientos del TMS y crea perfiles de vehículo, y que el tipo de unidad se vuelve el id del perfil."
  );

  let performance: TmsCanonicalPerformance[];
  const spin = createSpinner("Consultando rendimientos del TMS…");
  try {
    const adapter = await createTmsAdapterFromConfig(paths.tmsAdapterConfigPath, { env: process.env });
    performance = await adapter.getUnitPerformance();
    spin.stop(`Recibidos ${performance.length} tipos de unidad.`);
  } catch (error) {
    spin.stop();
    fail(`No pude leer rendimientos del TMS: ${(error as Error).message}`);
    return;
  }
  if (performance.length === 0) {
    warn("El TMS no devolvió tipos de unidad; nada que sincronizar.");
    return;
  }

  const manifest = await readManifest(paths.manifestPath);
  if (!manifest) {
    fail(`No encontré el manifest en ${paths.manifestPath}.`);
    return;
  }
  const defaultBu = manifest.business_units.find((unit) => unit.default) ?? manifest.business_units[0];

  const stubs = [];
  for (const perf of performance) {
    info(`Unidad ${paint(ansi.cyan, perf.unit_type)} · rendimiento ${perf.kpl_yield} km/l`);
    const commercial = await captureCommercialLayer(perf.unit_type, defaultBu?.business_unit_id ?? "general");
    stubs.push(buildProfileStub(perf, commercial));
  }

  const merged = mergeProfileStubs(manifest, stubs);
  await writeManifest(paths.manifestPath, merged);
  ok(`Manifest actualizado con ${stubs.length} perfil(es). El runtime lo recarga sin reinicio.`);
}

async function captureCommercialLayer(
  unitType: string,
  defaultBu: string
): Promise<ProfileCommercialLayer> {
  const pricingModel = (await select(`Modelo de precio para ${unitType}`, [
    { value: "formula", label: "Fórmula (costo + margen)" },
    { value: "profitability", label: "Rentabilidad (tabla RB)" }
  ])) as "formula" | "profitability";
  const marginTarget = Number(await ask("Margen objetivo (ej. 0.25)", "0.25"));
  const marginMin = Number(await ask("Margen mínimo (ej. 0.18)", "0.18"));
  const keywordsRaw = await ask("Palabras clave adicionales (separadas por coma)", "");
  return {
    business_unit_id: defaultBu,
    pricing_model: pricingModel,
    margin_target_pct: Number.isFinite(marginTarget) ? marginTarget : 0.25,
    minimum_margin_pct: Number.isFinite(marginMin) ? marginMin : 0.18,
    keywords: keywordsRaw
      ? keywordsRaw.split(",").map((keyword) => keyword.trim()).filter(Boolean)
      : []
  };
}

async function stepIngest(paths: OnboardPaths, copilot: Copilot | null): Promise<void> {
  line(section("Paso 5 · Cerebro vectorial (criterio comercial)"));
  await guide(
    copilot,
    "Cargo los documentos de criterio comercial al almacén vectorial local.",
    "Explica que este paso ingiere los documentos de criterio comercial del cliente al cerebro vectorial local y que los embeddings nunca salen del appliance."
  );
  if (!(await confirm("¿Ingerir los documentos de conocimiento ahora?"))) {
    info("Puedes hacerlo luego con: onboard --ingest");
    return;
  }
  const spin = createSpinner("Ingiriendo documentos…");
  const response = await postJson(`${paths.apiBaseUrl}/api/knowledge/ingest`, {});
  spin.stop();
  if (!response.ok) {
    warn(`Ingesta no disponible (${response.status}): ${JSON.stringify(response.body)}`);
    return;
  }
  const body = response.body as { document_count?: number };
  ok(`Ingeridos ${body.document_count ?? 0} documento(s) al cerebro vectorial.`);
}

async function stepTestRfq(paths: OnboardPaths, copilot: Copilot | null): Promise<void> {
  line(section("Paso 6 · RFQ de prueba"));
  await guide(copilot, "Envío un RFQ de prueba para confirmar que el flujo completo responde.", "Explica que enviamos un RFQ de prueba de extremo a extremo para verificar la instalación.");
  if (!(await confirm("¿Enviar un RFQ de prueba?"))) return;

  const origin = await ask("Ciudad origen", "Monterrey");
  const originState = await ask("Estado origen", "Nuevo Leon");
  const destination = await ask("Ciudad destino", "Saltillo");
  const destinationState = await ask("Estado destino", "Coahuila");

  const spin = createSpinner("Procesando RFQ…");
  const response = await postJson(`${paths.apiBaseUrl}/api/playground/rfqs`, {
    origin_city: origin,
    origin_state: originState,
    destination_city: destination,
    destination_state: destinationState,
    weight_kg: 12000
  });
  spin.stop();
  if (!response.ok) {
    fail(`El RFQ de prueba falló (${response.status}): ${JSON.stringify(response.body)}`);
    return;
  }
  const body = response.body as { run_id?: string; status?: string };
  ok(`RFQ de prueba aceptado (run ${body.run_id}). Revisa el tablero para el resultado.`);
}

async function guide(copilot: Copilot | null, fallback: string, context: string): Promise<void> {
  if (!copilot) {
    info(fallback);
    return;
  }
  const text = await copilot.explain(fallback, context);
  info(paint(ansi.magenta, `⟩ ${text}`));
}

async function readManifest(path: string): Promise<QuoteManifest | null> {
  try {
    return parseYaml(await readFile(path, "utf8")) as QuoteManifest;
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

main(process.argv.slice(2)).catch((error) => {
  fail((error as Error).message);
  process.exit(1);
});
