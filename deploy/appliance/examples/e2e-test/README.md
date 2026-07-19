# e2e-test fixture set

Synthetic TMS dataset + client manifest for the end-to-end pilot validation pass
(2026-07-19). Two lanes, calibrated to deterministically trigger the two
approval paths of the **actually-reachable** quote pipeline (`runQuoteWorkflow`
in `apps/agent/src/graph.ts`, driven via `POST /api/playground/rfqs` — the
`apps/agent/src/graph/` LangGraph StateGraph is a separate, parallel
implementation only reachable via real inbound email, so it is not exercised
here).

## Why this pipeline, and how approval actually gets decided here

`apps/agent/src/nodes/approvalGate.ts` does **not** use a historical
rate-band / "central third" check (that logic only exists in the other,
email-only pipeline's `graph/nodes/policyGate.ts`). Instead it unions review
reasons from three sources (`childReviewReasons`):

1. `base_quote.review_reasons` — from `@quoteops/quote-core`'s deterministic
   `calculateQuote` (payload exceeded, margin below minimum, missing route
   evidence, etc.)
2. `"ai_recommendation_failed"` if the LLM guide call throws
3. `"historical_context_insufficient"` if `historical.insufficient_data` is
   non-empty (i.e. the historical search found no matching comparable for
   at least one of its 5 layers)

Any non-empty reason list ⇒ `approval_state.required = true` ⇒ needs review.

## Lane A — Guadalajara → Monterrey (auto-approve)

- Route: seeded in `connectors/sakbe/route-cache.json`, 540 km, $950 tolls.
- Vehicle profile `T3S3_53_DRYVAN` (copied from the `examples/nmx` profile).
- `calculateQuote` result (verified against the real `@quoteops/quote-core`
  code, not hand-computed): `base_rate_mxn = 18669.44`, `status: APPROVED`,
  `review_reasons: []`.
- `connectors/tms/historical-quotes.csv` has 5 rows for this exact route +
  unit + commodity/sector/weight-band/service_type combination
  (`carga general` / `general` / `industrial`, 18000 kg, `cuota`), rates
  18100–21400. Verified live against `FileImportTmsAdapter.searchHistoricalQuotes`:
  `route_unit_cost` comparable found (count 5), `insufficient_data: []`.
- Result: zero review reasons anywhere ⇒ **auto-approved**, no human step.

## Lane B — Querétaro → Puebla (needs human review)

- Route: also seeded in the SAKBE cache, 280 km, $620 tolls, so route
  resolution itself is clean (the only deliberate trigger is missing
  history, not a route failure).
- Same vehicle profile and manifest.
- `calculateQuote` result: `base_rate_mxn = 10725`, `status: APPROVED`,
  `review_reasons: []` — quote-core itself has nothing to flag.
- **`historical-quotes.csv` deliberately has zero rows for this route.**
  Verified live: `route_unit_cost` comparable is `null`,
  `insufficient_data: [{"layer":"route_unit_cost","reason":"exact_route_unit_history_missing"}]`.
- Result: `historical_context_insufficient` ⇒ **needs human review** via
  `POST /api/approvals/:runId/decision`.

## Feeding these into a running appliance

There is no bulk-xlsx or multipart upload route in this pipeline. Each lane
is submitted as a single JSON POST to `/api/playground/rfqs`
(`apps/api/src/index.ts`, `PlaygroundRfqRequest` shape — flat
`origin_city`/`origin_state`/`destination_city`/`destination_state`/
`vehicle_profile_id`/`weight_kg`/`commodity`/`commodity_category`/`sector`/
`value_mxn`/`customer_id`/`customer_type`/`business_unit_id`/`route_policy`
fields, one lane per request). Poll `GET /api/workflow-state/:runId` or
`GET /api/rfqs/:runId` for completion; for Lane B, once
`approval_state.required` is `true`, resolve it with
`POST /api/approvals/:runId/decision` `{"action":"approve"}`.

## LLM provider

`connectors/agent/agent-config.yaml` points `model.provider: openai` at
NVIDIA NIM's OpenAI-compatible endpoint (`base_url`,
`model_name: meta/llama-3.1-70b-instruct`) via `api_key_env:
NVIDIA_NIM_API_KEY`. Two small code changes were required for this to work
at all (see the corresponding commit): `AgentRuntimeConfig`/`chatModel.ts`
needed a `base_url` field (used by the email-only graph pipeline via
`apps/api/src/server.ts`), and `apps/api/src/runtimeTools.ts`'s `recommend`
tool — used by *this* pipeline — only special-cased `deterministic` and
`openrouter` and threw for everything else, including `openai`; it now
builds a `ChatOpenAI` via the same `createChatModel` factory. In both cases
the LLM's output is advisory only (logged as a "reason"/audit note) — the
quoted rate always stays `quote-core`'s deterministic `base_rate_mxn`,
per the project's core invariant.

The actual API key value is never stored in this fixture set — it goes only
into the appliance's `secrets/client.env` via `deploy/appliance/secrets.sh`.
