# Mock TMS (API HTTP)

TMS simulado que habla el contrato exacto de `HttpTmsAdapter` — para demos e
instalaciones de prueba "como si hubiera un TMS real" sin depender de archivos
CSV. Cero dependencias.

```bash
node deploy/appliance/mock-tms/server.mjs            # puerto 8099
PORT=9000 node deploy/appliance/mock-tms/server.mjs  # puerto custom
# o en Docker, unido a la red del appliance:
docker run -d --name mock-tms --network <proyecto>_default \
  -v "$PWD/deploy/appliance/mock-tms":/srv -w /srv node:22-alpine node server.mjs
```

Qué sirve (endpoints default del adapter + writebacks):

| Recurso | Detalle |
|---|---|
| `GET /units` | Unidades con clave NOM mexicana en el id (`T3S3_53_DRYVAN`, `T3S2_53_DRYVAN`, `T3S2R4_DOUBLE_40_DRYVAN`) — el `SakbeRouteAdapter` las mapea a configuración NOM para que INEGI SAKBE sepa qué unidad cotiza |
| `GET /unit-performance` | `kpl_yield` y `real_cost_per_km` por unidad — lo que consume el overlay `performance_source: tms` |
| `GET /availability-zones`, `GET /unit-positions` | Disponibilidad por zona y posiciones |
| `GET /liquidations` | Liquidaciones (fuente de los históricos): origen-destino + unidad + categoría de carga + costo liquidado (incl. componente operador) + margen |
| `POST /historical-quotes/search` | Análisis por capas idéntico a `historicalAnalysis.ts`: ruta+unidad, categoría, sector, banda de peso, tipo de servicio |
| `POST /quotes`, `POST /status` | Writebacks (en memoria; inspeccionables en `GET /quote-writebacks` / `GET /status-writebacks`) |

Nota sobre costo de operador: el contrato canónico de performance solo lleva
`kpl_yield` + `real_cost_per_km`; el costo de operador por km vive en el
manifest del cliente (`operator_cost_per_km_mxn`) y aquí aparece desglosado
dentro de cada liquidación (`operator_cost_mxn`).

Test de contrato: `tests/regression/mock-tms-http.test.ts` levanta este server
y corre el `HttpTmsAdapter` real contra él (schemas zod incluidos).
