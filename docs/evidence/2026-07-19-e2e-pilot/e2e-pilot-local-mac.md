# Piloto E2E cliente sintético E2ETEST — 2026-07-19 (host: Mac local, fallback)

## Resultado

- Cliente `E2ETEST` dado de alta con `npm run admin` contra el Supabase vivo; el deploy Vercel emite su installer (misma BD — el pendiente `DATABASE_URL` del piloto anterior ya está resuelto).
- Appliance instalado con `install.sh` real: imágenes construidas del código actual (`v0.1.1`), home `~/quoteops-v1-e2e`, puertos 8091/8494, compose project `quoteops_e2e`. Licencia activada contra el control plane vivo (`installation_id: e2etest-prod-001`).
- TMS 100% sintético (`deploy/appliance/examples/e2e-test/`), validado contra los zod reales; rutas SAKBE pre-sembradas en cache.
- LLM real: NVIDIA NIM (`meta/llama-3.1-70b-instruct`, `base_url` OpenAI-compatible) — requirió el cambio de código `model.base_url` + rama `openai` en el tool `recommend` (353/353 tests verdes).
- **Camino auto** (Guadalajara→Monterrey, histórico denso): 14 nodos, sin aprobación, quote-core $18,669.44, writeback TMS.
- **Camino revisión** (Querétaro→Puebla, sin histórico): detenido en compuerta (`historical_context_insufficient`), aprobado en la UI del Centro de aprobaciones, writeback $10,725. Ambas líneas en `quote-writebacks.jsonl`.
- Portal cloud refleja la instalación: versión v0.1.1 por heartbeat, counters 2/2, onboarding `ready`. Sesión del usuario autorizado del tenant.
- Reporte visual completo: `guia-e2e-quote-ops-v1.html` (screenshots embebidos) + JSONs crudos de ambos runs.

## Adaptaciones del piloto

- SSH al VPS bloqueado por el sandbox (`ssh root@2.25.78.180 → Operation not permitted`, verificado vía Codex) → fallback pre-acordado a Mac local. VPS y sus stacks (8090/8493, 8080/8443) intactos.
- `installation_id` del install.sh (`e2etest-local-001`) ≠ el del CLI (`e2etest-prod-001`) → corregido en `.env` (error de operador, no de producto).
- Gate de onboarding de la UI exige grupos de secretos no aplicables a `file_import` (TMS key, mailbox) → valores demo documentados.
- Primera llamada NIM ~3 min (cold start del 70B); siguientes ~7 s.
- Usuario demo `alejandro.c+e2etest@loadlink.mx` creado por SQL (password aleatorio) para la sesión del portal — rotar/borrar tras el piloto.

## Pendiente para producción

- Corrida espejo en srv1807611 con SSH real (llave `alejandro-mac-cockpit` ya adjunta a la VM).
- `usage_events` (gráfica "Uso por día") no se publica desde el appliance — solo counters agregados.
- Vista vendor del portal requiere `QUOTEOPS_ADMIN_EMAILS` en Vercel.
- Onboarding TRON interactivo no ejercitado en esta corrida (cubierto en la guía 2026-07-12).
- Cero bugs de producto en runtime — protocolo codex-rescue (GPT 5.6 Sol xhigh) reservado, no requerido.
