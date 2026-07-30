# Mock TMS (API HTTP)

TMS simulado que habla tanto el contrato canónico
`quoteops-tms-http-v1` como las rutas legacy de `HttpTmsAdapter`, para demos e
instalaciones de prueba "como si hubiera un TMS real" sin depender de archivos
CSV. Se ejecuta desde el repositorio compilado para reutilizar el schema
autoritativo de writeback.

```bash
install -m 0600 /dev/null /run/quoteops/mock-tms-token
# Escribir el token fuera del historial del shell.
MOCK_TMS_TOKEN_FILE=/run/quoteops/mock-tms-token \
MOCK_TMS_HOST=127.0.0.1 \
node deploy/appliance/mock-tms/server.mjs

# Puerto custom:
PORT=9000 MOCK_TMS_TOKEN_FILE=/run/quoteops/mock-tms-token \
MOCK_TMS_HOST=0.0.0.0 node deploy/appliance/mock-tms/server.mjs
```

`MOCK_TMS_TOKEN_FILE` debe ser un archivo regular, no symlink, modo `0600` y
propiedad del usuario del proceso. El servidor nunca imprime la ruta ni el
contenido. `MOCK_TMS_HOST` selecciona la dirección de escucha; use
`127.0.0.1` para una instalación local o una dirección explícita de red interna
para fixtures Docker.

Las seis rutas `/quoteops/v1/*` y las rutas de inspección
`GET /quote-writebacks` y `GET /status-writebacks` requieren
`Authorization: Bearer <token>`. Las rutas legacy permanecen sin cambios.

Qué sirve:

| Recurso | Detalle |
|---|---|
| `GET /units` | Unidades con clave NOM mexicana en el id (`T3S3_53_DRYVAN`, `T3S2_53_DRYVAN`, `T3S2R4_DOUBLE_40_DRYVAN`) — el `SakbeRouteAdapter` las mapea a configuración NOM para que INEGI SAKBE sepa qué unidad cotiza |
| `GET /unit-performance` | `kpl_yield` y `real_cost_per_km` por unidad — lo que consume el overlay `performance_source: tms` |
| `GET /availability-zones`, `GET /unit-positions` | Disponibilidad por zona y posiciones |
| `GET /liquidations` | Liquidaciones (fuente de los históricos): origen-destino + unidad + categoría de carga + costo liquidado (incl. componente operador) + margen |
| `POST /historical-quotes/search` | Análisis por capas idéntico a `historicalAnalysis.ts`: ruta+unidad, categoría, sector, banda de peso, tipo de servicio |
| `POST /quotes`, `POST /status` | Writebacks (en memoria; inspeccionables en `GET /quote-writebacks` / `GET /status-writebacks`) |
| `GET /quoteops/v1/health` | Health estricto con versión y capabilities del contrato |
| `POST /quoteops/v1/historical-quotes/search` | Filas históricas canónicas para el analizador local |
| `GET /quoteops/v1/units`, `GET /quoteops/v1/unit-performance`, `GET /quoteops/v1/availability-zones` | Lecturas canónicas de contexto |
| `POST /quoteops/v1/quotes` | Writeback estricto e idempotente por `quote_id` |

Nota sobre costo de operador: el contrato canónico de performance solo lleva
`kpl_yield` + `real_cost_per_km`; el costo de operador por km vive en el
manifest del cliente (`operator_cost_per_km_mxn`) y aquí aparece desglosado
dentro de cada liquidación (`operator_cost_mxn`).

Test de contrato: `tests/regression/mock-tms-http.test.ts` levanta este server
y corre el `HttpTmsAdapter` real contra él (schemas zod incluidos).
