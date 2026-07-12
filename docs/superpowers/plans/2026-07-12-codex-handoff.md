# Codex handoff — finish quote_ops_v1 wave 1

Repo: `/Users/alejandro/quote_ops_v1` (TypeScript ESM monorepo, Node 22, npm workspaces, zod, vitest). Read `docs/superpowers/plans/2026-07-11-quote-ops-v1.md` (the master plan) first. Everything is committed at HEAD; your diff = your work. Do NOT `git commit/push`. Do NOT touch `/Users/alejandro/quote-system-v2-product` (the old product, reference-only reading is fine).

## Context

Wave 1 ran with 8 parallel agents. 4 finished (tested, committed): **sql-cache** (`packages/connectors/src/cache/SqlKeyValueCache.ts` + `createTieredCache`, exported from connectors index), **pdf** (`apps/agent/src/pdf/quotePdf.ts` — `renderQuotePdf(QuotePdfInput): Promise<Buffer>`, `DEFAULT_PDF_TEMPLATE`, `loadPdfTemplate` reading `QUOTEOPS_PDF_TEMPLATE_PATH`), **playground-ui** (`apps/web/src/pages/runs.tsx`, `src/api/runsApi.ts`, nav wired in `ClientPortalApp.tsx`), **sentinel** (`apps/agent/src/sentinel/{collect,report,submit,index}.ts` + 14 tests).

4 agents were killed MID-EDIT (session limit). Their partial work is committed and must be treated as *possibly incomplete/broken* — finish or fix it:
- **core-graph**: contributed NOTHING. `apps/agent/src/graph/` and `apps/agent/src/llm/` do not exist. This is your biggest task (Task A below).
- **control-plane**: left `supabase/migrations/0001_control_plane.sql` (142 lines), `apps/control-plane-api/src/tenantData.ts` (204 lines), edits to `apps/control-plane-api/src/index.ts`, and possibly an unfinished test file. Finish per Task B.
- **portal-ui**: left `apps/web/src/pages/clientProfile.tsx`, `sentinelReports.tsx`, `lib/portalSettings.ts`, edits to `ControlPlaneApp.tsx`, `api/controlPlaneApi.ts`, `tests/portalUi.test.tsx`. Finish per Task C.
- **onboarding-installer**: left `apps/api/src/onboard/wizardSteps.ts`, edits to `cli.ts`, `onboardConfig.ts`, `deploy/appliance/{install.sh,docker-compose*.yml,upgrade.sh}`, `.github/workflows/{ci.yml,release.yml}`. Finish per Task D.

## Non-negotiable invariants

- The LLM NEVER computes or changes a rate. `packages/quote-core` (`calculateQuote`) is the only rate source. Pricing models already exist there: `formula` (margen fijo) and `profitability` (RB brackets) — do NOT add pricing code; selection is via manifest profile `pricing_model` + cloud settings overlay.
- Client-agnostic product; 'NMX' only in tests/fixtures.
- No new npm dependencies. Preinstalled in `apps/agent`: `@langchain/langgraph`, `@langchain/core`, `@langchain/openai`, `@langchain/langgraph-checkpoint-postgres`, `pg`, `pdfkit`.
- ESM imports with `.js` suffix; zod for external data; match surrounding style.
- Work ADDITIVELY in apps/agent: leave legacy `apps/agent/src/graph.ts` + its tests intact; new orchestration lives in `apps/agent/src/graph/`.

## Shared contracts (already coded against by the finished modules — do not change)

- Appliance Postgres DDL (apps/api storage layer creates it): `quote_runs(run_id text pk, channel text, status text, summary text, created_at, updated_at)`; `quote_run_steps(run_id text, seq int, node text, status text, summary text, data jsonb, ts timestamptz, pk(run_id,seq))`.
- StepEvent JSON: `{run_id, seq, node, status:'start'|'end'|'error', summary, data?, ts}`.
- REST (appliance `apps/api`): `GET /api/runs?limit → {runs:[...]}`; `GET /api/runs/:runId → {run, steps}`; `GET /api/runs/:runId/stream` — SSE with NAMED events `event: step` (data = StepEvent JSON) and `event: done` (the UI at `apps/web/src/api/runsApi.ts` listens for those exact names, falls back to polling). Existing approvals endpoints unchanged: `GET /api/approvals`, `POST /api/approvals/:runId/decision {action: approve|adjust|reject|request_review, rate_mxn?}`.
- Run statuses used by the UI: `running | waiting_approval | done | error`.
- LLM factory: `apps/agent/src/llm/chatModel.ts` exports `createChatModel(modelConfig, env)` returning a LangChain `ChatOpenAI`, where modelConfig is `{provider, model_name, api_key_env}` (subset of `AgentRuntimeConfig['model']`, see `packages/connectors/src/agent/AgentRuntimeConfig.ts`). Providers via OpenAI-compatible baseURL: `openrouter` (default, https://openrouter.ai/api/v1), `openai`, `anthropic` (https://api.anthropic.com/v1/), `gemini` (https://generativelanguage.googleapis.com/v1beta/openai/). Key read from `env[modelConfig.api_key_env]`. NOTE: `apps/agent/src/sentinel/index.ts` dynamically imports this exact path/signature — it will not typecheck until you create it.
- Sentinel→control-plane: `POST {QUOTEOPS_CONTROL_PLANE_URL}/api/sentinel/reports`, `Authorization: Bearer $QUOTEOPS_REGISTRATION_TOKEN`, body `{installation_id, week_start, body_md, stats:{runs, errors, interrupts, avg_node_ms}}` (already implemented client-side in `apps/agent/src/sentinel/submit.ts`; the SERVER endpoint is Task B).
- Heartbeat response gains `{latest_version, settings:{pricing_model?, pdf_template?}}`.

## Task A — LangGraph agent team (apps/agent + apps/api) [biggest]

Per master-plan Tasks 3/4/6/7. Build:
1. `apps/agent/src/llm/chatModel.ts` per contract above.
2. `apps/agent/src/graph/state.ts` — `Annotation.Root`: run_id, channel ('email'|'whatsapp'), message, intake_kind ('single'|'multi_text'|'bulk_file'|null), rfqs, lanes, inoperable[{lane,reason}], quotes, historical, recommendation[{lane_id, verdict:'auto'|'needs_review'|'unknown_route', reason, suggested_rate_mxn?}], approval, response_sent, steps (concat reducer).
3. Nodes in `apps/agent/src/graph/nodes/`:
   - **classify** (AI, NEW): structured output `{kind, unit_type_hints[], confidence}`; prompt includes available unit types via tools.getUnits() (cache-aside TMS). xlsx attachment ⇒ 'bulk_file' deterministically without LLM.
   - **extract**: reuse `apps/agent/src/intake/extractRfq.ts` prompt+zod through the ChatModel; xlsx ⇒ `xlsxToDraftLanes`. Bulk fan-out with LangGraph `Send` per lane.
   - **validateOperability** (bulk): lanes with zero TMS historical comparables AND no availability zone ⇒ `inoperable[]`, excluded from quoting, surfaced for human decision.
   - **resolve**: reuse profileResolver + TMS lookups via the `QuoteWorkflowTools` DI seam (`apps/api/src/runtimeTools.ts` — refactor minimally so the graph receives a tools instance).
   - **quote**: deterministic `calculateQuote` per lane (SAKBE evidence via tools.resolveRoute). Apply settings overlay: optional JSON at `QUOTEOPS_SETTINGS_PATH` may override manifest profile `pricing_model`.
   - **historical**: deterministic tools.searchHistorical keyed route+unit_type+commodity, then ChatModel interpretation `{quality:'good'|'thin'|'none', relevance_notes}` — interpretation only.
   - **recommend**: ChatModel proposes `{suggested_rate_mxn, reason}`; clamp to historical band [min,max] when a band exists; flag clamped.
   - **policyGate** (DETERMINISTIC): in-band + quote-core APPROVED ⇒ 'auto'; out-of-band or REVIEW_REQUIRED ⇒ 'needs_review'; historical quality 'none' ⇒ 'unknown_route'. Non-auto ⇒ `interrupt()` with payload {run_id, lanes, quotes, recommendation, reasons}.
   - **respond**: `import { renderQuotePdf } from '../pdf/quotePdf.js'` (exists, tested). Reply via same channel: minimal `Channel` interface `{send({to, subject?, body_md, attachments?})}` with email impl reusing the existing mailbox reply path + console stub for whatsapp. Mid-band conversational flow: approver message says quote is in-range mid-band, asks confirm; approval resume ⇒ PDF sent.
   - **writeback**: tools.writeback (TMS `writeQuoteResult`) + audit events (`packages/audit`).
4. Checkpointer: `PostgresSaver.fromConnString(process.env.DATABASE_URL)` when set else `MemorySaver`; thread_id = run_id. Extend `POST /api/approvals/:runId/decision` to ALSO resume interrupted new-graph runs via `Command({resume: decision})` (keep legacy path working).
5. Step tracing: every node start/end/error appends StepEvent to state AND persists via storage: extend `apps/api/src/storage/{schema.ts,PostgresQuoteOpsStore.ts,InMemoryQuoteOpsStore.ts}` (+ the `QuoteOpsStore` interface) with quote_runs/quote_run_steps and methods createRun/updateRunStatus/appendStep/listRuns/getRun/getSteps.
6. REST endpoints per contract in `apps/api/src/index.ts` (SSE = poll store ~1s until terminal, named events!).
7. Runner: mailbox poller ⇒ invoke new graph. Keep a dev entry (`dev.ts`) that feeds a fixture message without real Gmail. Wire sentinel in the agent server entry: `import { startSentinel } from './sentinel/index.js'; startSentinel({ db, env: process.env })` (db = pg Pool from DATABASE_URL; skip when absent). Wire cache: `createSqlCacheFromEnv` + optional redis + `createTieredCache` (see `packages/connectors/src/cache/`) into the CachedTmsAdapter wiring in runtimeTools; also cache SAKBE route results through the same cache.
8. Vitest (scripted fake ChatModel, no network): auto path completes with steps+writeback; needs_review interrupts then resumes with approve ⇒ PDF sent; unknown_route interrupts; bulk xlsx 5 rows with 1 inoperable ⇒ 4 quoted; classify text vs xlsx.

## Task B — Control plane API + Supabase (apps/control-plane-api, supabase/)

Review/finish `supabase/migrations/0001_control_plane.sql` per master-plan Task 10 schema (tenants, profiles, installations, registration_tokens, credentials, usage_events, sentinel_reports, releases; RLS on ALL tables: tenant isolation via profiles join on auth.uid(), vendor_admin role full access, releases readable by authenticated, no anon). Finish `tenantData.ts` + `index.ts` endpoints: `POST /api/sentinel/reports` (Bearer registration token ⇒ tenant; insert), `POST /api/usage` (upsert daily counts), heartbeat extended per contract, `GET /api/releases/latest`. Keep installer-serving endpoint + existing tests green. Add vitest coverage for the new endpoints with the existing fake/supabase-stub pattern.

## Task C — Portal UI (apps/web control-plane side)

Finish clientProfile.tsx / sentinelReports.tsx / portalSettings.ts / ControlPlaneApp.tsx / controlPlaneApi.ts per master-plan Task 11: version + 'Actualización disponible' banner (releases.latest vs installations.version), pricing-model radio (formula=Margen fijo / profitability=Rentabilidad RB) via updateSettings, PDF-template JSON editor with client-side validation, usage table, sentinel reports list. Spanish copy. Fix/complete `apps/web/tests/portalUi.test.tsx`. MUST NOT touch appliance-side pages (runs.tsx, runsApi.ts, ClientPortalApp.tsx beyond what already exists).

## Task D — Onboarding wizard + installer + CI (apps/api/src/onboard, deploy/, .github/)

Finish `wizardSteps.ts`/`cli.ts`/`onboardConfig.ts` per master-plan Task 12: pricing-model step (params per model; prefill from TMS getUnitPerformance when configured), authorization step (approver_email, allowed_domains[], whatsapp_approver_phone persisted in manifest/agent-config), validation-test step (3 sample quotes via calculateQuote, table, confirm loop). Finish deploy defaults: /opt/quoteops-v1, COMPOSE_PROJECT_NAME quoteops_v1, images ghcr.io/alejandroc-bit/quote-ops-{agent,api,web}, tags v*. Finish `.github/workflows/ci.yml` (build+vitest) and `release.yml` (tags v* ⇒ GHCR amd64-only). Existing installer/onboard tests must pass (update fixtures for new defaults).

## Definition of done (verify before returning)

1. `npm run build` green (includes both vite builds).
2. `npx vitest run` — FULL suite green (fix any test you broke; legacy tests stay).
3. Print a summary: files touched per task, tests added, anything intentionally left out.
