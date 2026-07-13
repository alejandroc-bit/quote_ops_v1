# Unificar los dos modelos de datos del control plane + CLI de alta de clientes

## Context

Al provisionar el cliente piloto hubo que hacer cirugía SQL manual porque el control plane arrastra **dos modelos de datos paralelos** que duplican los mismos conceptos:

1. **Store legacy** (`ControlPlaneStore`, interfaz en `apps/control-plane-api/src/index.ts:109-118`; impls en `src/stores/{fileStore,postgresStore}.ts` con tablas lazy `control_plane_clients` + `control_plane_install_tokens`): guarda el `MinimalClientRecord` completo como blob jsonb.
2. **Store nuevo** (`TenantDataStore`, `apps/control-plane-api/src/tenantData.ts`) sobre las tablas de la migración Supabase con RLS (`tenants`, `installations`, `registration_tokens`, `profiles`, `sentinel_reports`, `usage_events`, `releases`).

Cada operación escribe en ambos (cliente: index.ts:330+331; token de instalación: 352+359; activación: 507-509; heartbeat: 541+547) y las lecturas están partidas (el installer lee el token del legacy:371, la auth del appliance lo lee del nuevo:598; counters solo legacy:583, usage solo nuevo:637). Resultado: alta de clientes frágil y confusa para el vendor. El cliente final nunca ve nada de esto — el fix es 100% del lado del plano de control.

**Objetivo:** una sola fuente de verdad (las tablas Supabase con RLS), un solo módulo de store, y un comando de vendor que reemplaza cualquier SQL manual.

**Ejecución:** siguiendo la división vigente — yo orquesto/verifico/despliego; **Codex GPT 5.6 Sol (xhigh) implementa el código** con un brief derivado de este plan.

## Cambios

### 1. Migración `supabase/migrations/0002_unify_client_store.sql`

- `tenants` + `status text` (check `active|onboarding|blocked|suspended`, default `onboarding`), `authorized_users jsonb default '[]'`.
- `installations` + `license_status`, `onboarding_status`, `ai_key_status` (con checks y defaults `pending|not_started|missing`), `counters jsonb` (default los 5 contadores en 0).
- Backfill condicional desde `control_plane_clients.record` si existe (upsert por `client_id`/`installation_id`, sin pisar `tenants.name`/`authorized_email`), luego **DROP** de `control_plane_clients` y `control_plane_install_tokens`.
- Fixup: tenants con `authorized_users = '[]'` → sembrar `[{email: authorized_email, role: 'owner'}]`.
- Bloque condicional de grants para el rol `quoteops_cp` (existe solo en vivo, creado manualmente — el grant queda versionado; la creación del rol con password sigue siendo paso manual documentado).
- Las columnas nuevas heredan las políticas RLS existentes por tabla.

### 2. Módulo unificado `apps/control-plane-api/src/data/`

- `index.ts`: interfaz `ControlPlaneData` = los 8 métodos legacy (proyectando `MinimalClientRecord` desde `tenants ⋈ installations`) + los métodos tenant que sobreviven. **Se eliminan como redundantes**: `provisionClient` (lo absorbe `upsertClient` transaccional), `issueRegistrationToken` (= `saveRegistrationToken`), `updateRegistrationToken` (= `markRegistrationTokenUsed`). Tipos `RegistrationTokenRecord` etc. se mudan aquí. Incluye `createInMemoryControlPlaneData` y `createDefaultControlPlaneData(env)` (pg si `QUOTEOPS_SUPABASE_DB_URL||DATABASE_URL`, file si `QUOTEOPS_CONTROL_PLANE_STORE_PATH`, else memoria) — reemplaza ambas factories viejas.
- `postgres.ts`: impl sobre las tablas de migración. Tokens en la única tabla `registration_tokens` (`client_id` vía join a tenants). `upsertClient` sincroniza `authorized_email` ↔ `authorized_users[0].email`. Proyección asume 1 instalación por tenant (comentario `ponytail:` con el techo).
- `file.ts`: impl dev que **lee el shape JSON viejo** `{clients, registration_tokens}` para no romper archivos existentes; releases/settings vacíos en modo file.

Mapeo de campos: `legal_name→tenants.name`, `status→tenants.status`, `authorized_users→tenants.authorized_users`, `installation.{license_status,onboarding_status,ai_key_status}→installations.*`, `counters→installations.counters`, `last_heartbeat_at→installations.last_heartbeat_at` (existente).

### 3. `apps/control-plane-api/src/index.ts` — single-write

- Deps: un solo `data?: ControlPlaneData` (fuera `store`/`tenantData`). Borrar `resolveLegacyTenantToken` (:713), el path 503 `tenant_data_unavailable`, `createInMemoryControlPlaneStore` (:182-226) y `createDefaultControlPlaneStore` (:671).
- Crear cliente / install-pack / heartbeat: una sola escritura. Activación conserva el orden retry-safe (cliente durable → token consumido). Counters ahora persisten de verdad en `installations.counters` (arregla el split). `requireTenantToken` siempre lee la tabla única.
- **Los shapes de request/response de TODOS los endpoints no cambian** (el portal `apps/web/src/api/controlPlaneApi.ts` y el appliance dependen de ellos; ni portal ni appliance requieren cambios).

### 4. Borrar código muerto

`src/stores/fileStore.ts`, `src/stores/postgresStore.ts`, `src/tenantData.ts`.

### 5. CLI de vendor `apps/control-plane-api/src/adminCli.ts` + script raíz `"admin"`

```
npm run admin -- create-client PILOTO "Razón Social" ops@cliente.mx
npm run admin -- install-pack PILOTO [--ttl-minutes 60]   # imprime token + comando curl|bash
npm run admin -- list
```
Directo a BD vía `createDefaultControlPlaneData(process.env)` (requiere `DATABASE_URL`; URL del portal desde `QUOTEOPS_CONTROL_PLANE_URL` o `--url`). Reusa `createInstallPack` (`apps/control-plane/src/installPack.ts:13`). Parsing de argv plano estilo `apps/api/src/onboard/cli.ts`. **Sin login de Supabase.**

### 6. Tests (`apps/control-plane-api/tests/`)

- `control-plane-api.test.ts`: `startApi` usa `createInMemoryControlPlaneData()`; los `it.each` de fallas cross-store (:335-395) colapsan a 2 fronteras single-store; test de persistencia file (:844) usa la impl nueva; quitar asserts de 503 `tenant_data_unavailable` (en dev sin BD ahora sirven sentinel/usage/releases — intencional); extender el test de migración (:882-933) para leer también `0002` (columnas/checks/drops).
- Nuevo `tests/data.test.ts`: unit tests del store unificado (proyección, sync authorized_email, tokens) + test del CLI.

## Orden de implementación (suite verde en cada commit)

1. Migración 0002 + extensión del test de migración.
2. `src/data/` completo + `tests/data.test.ts` (nada lo importa aún).
3. Flip de `index.ts` a `data` + adaptación de `control-plane-api.test.ts` (mismo commit).
4. Borrar `stores/`, `tenantData.ts`; limpiar imports.
5. CLI + script + test.

## Rollout en vivo (lo hago yo tras verificar el código)

1. Backup: dump de las 5 tablas involucradas (vía script con `DATABASE_URL`, patrón password-en-archivo ya usado).
2. **Orden crítico**: aplicar la migración 0002 (MCP `apply_migration`) **antes** de que corra tráfico del build viejo prolongadamente — el postgres store viejo recrea las tablas legacy lazy; ventana corta aceptable, verificar tras deploy que no reaparecieron.
3. Deploy Vercel del nuevo build. Portal no cambia shapes; appliance reintenta heartbeats (ventana 5xx breve OK).
4. Smoke en vivo: `npm run admin -- list` muestra PILOTO → `create-client TEST` + `install-pack TEST` → `curl $CP/api/install/$TOKEN` devuelve el installer → heartbeat del VPS sigue 202 → borrar TEST.

## Verificación

- `npm run build` y `npx vitest run` completos en verde (hoy: 348 tests).
- Dry-run de la migración contra una fila `control_plane_clients` sembrada (ejercita backfill+drop).
- Smoke en vivo del paso Rollout-4 + confirmar en BD: PILOTO con `status`/`counters` poblados, tablas legacy ausentes, heartbeat con timestamp fresco.

## Riesgos

- Grants de `quoteops_cp` sobre columnas nuevas → cubierto por el bloque condicional en 0002; verificar en vivo antes del deploy del API.
- Build viejo resucitando tablas legacy (ensureSchema lazy) → orden de rollout + verificación posterior.
- Unicidad de `authorized_email` entre clientes → mismo comportamiento que hoy; `upsertClient` mantiene el sync con `authorized_users[0]`.
- Proyección soporta 1 instalación por tenant → techo documentado, suficiente para el modelo actual (installation_id único por cliente).

---

## Notas de ejecución para Codex (agregadas por el orquestador)

- Repo: /Users/alejandro/quote_ops_v1, baseline HEAD limpio (348 tests verdes). NO `git commit/push` — el orquestador commitea.
- La sección "Rollout en vivo" NO te corresponde: no toques la BD viva, no despliegues, no uses credenciales. Tu entrega es solo código + tests locales.
- Sigue el "Orden de implementación" (5 pasos) verificando la suite tras cada paso.
- No cambies ningún shape de request/response de endpoints; el portal y el appliance dependen de ellos.
- Definition of done: `npm run build` verde (ambos builds vite) Y `npx vitest run` completamente verde. Cierra con resumen: archivos creados/modificados/borrados por paso, tests añadidos/adaptados, y cualquier decisión de diseño que hayas tenido que tomar fuera del plan.
