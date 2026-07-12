# NMX Client Emulation Pack

This pack emulates Autolineas NuevoMex (`NMX`) from the V1 Supabase configuration surface.

## Source Shape

- Client: `NMX`
- Business unit: `DV_53_FT`
- Vehicle profile: `T3S3_53_DRYVAN`
- Pricing model: `profitability`
- Diesel: `29 MXN/l`
- RB table: configured on the operating profile
- Cost profile: maintenance, tires, overhead, depreciation and cargo insurance from V1 cost profile rows

## Route Mode

Live SAKBE route means the route adapter calls SAKBE at runtime with an appliance-local secret such as `INEGI_SAKBE_KEY`:

- `source: "sakbe"`
- `km_loaded`
- `estimated_minutes`
- `tolls_mxn`
- no cache read/write when `QUOTEOPS_SAKBE_CACHE_MODE=live_only`

If the live call fails, QuoteOps must fail closed into review instead of inventing route evidence. The fixture route used in deterministic tests is:

```text
Monterrey, Nuevo Leon -> Ciudad de Mexico, Ciudad de Mexico
T3S3_53_DRYVAN
cuota
```
