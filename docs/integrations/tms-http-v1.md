# QuoteOps TMS HTTP v1

The canonical customer-facing TMS integration is
`quoteops-tms-http-v1`. It is a small Bearer-authenticated JSON API with six
operations:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/quoteops/v1/health` | Confirm contract version and capabilities |
| `POST` | `/quoteops/v1/historical-quotes/search` | Return canonical historical quote rows |
| `GET` | `/quoteops/v1/units` | Return canonical units |
| `GET` | `/quoteops/v1/unit-performance` | Return canonical unit performance |
| `GET` | `/quoteops/v1/availability-zones` | Return canonical availability zones |
| `POST` | `/quoteops/v1/quotes` | Store a quote result |

The complete field-level contract, examples, response statuses, and strict
object schemas are in
[`tms-http-v1.openapi.yaml`](./tms-http-v1.openapi.yaml).

## Authentication and errors

Send the API key on every operation:

```http
Authorization: Bearer <api-key>
Accept: application/json
```

JSON requests also send `Content-Type: application/json`. Error responses use
the strict `TmsHttpV1Error` shape from the OpenAPI document. QuoteOps treats
unexpected successful response shapes as connector errors and does not include
the URL, headers, request body, or credentials in timeout errors.

## Historical search

The historical endpoint returns a raw JSON array of
`HistoricalQuoteRecord`. QuoteOps applies its existing local comparable
analyzer to those rows, so file, SQL, and HTTP integrations share the same
layer selection and calculations. Legacy integrations that already return an
aggregated `HistoricalAnalysis`, including a legacy `{ "data": ... }` envelope,
remain supported by the adapter but are not part of this public v1 schema.

## Idempotent quote writeback

`quote_id` is the idempotency key for `POST /quoteops/v1/quotes`.

- Repeating a validated body with the same `quote_id` returns the original
  response and does not create a second row.
- JSON object key order, including nested `metadata` objects, does not affect
  equality. Array order remains significant.
- Reusing the ID with a genuinely different body returns `409` with
  `error: quote_id_conflict`.

## Customer implementation sequence

1. Implement health and Bearer authentication.
2. Implement the three unit/context reads.
3. Implement historical search.
4. Implement idempotent quote writeback.
5. Run the provided conformance probe.
6. Provide the base URL and API key to the customer's VM operator.
