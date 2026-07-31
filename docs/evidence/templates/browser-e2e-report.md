# Aceptación E2E en Azure, Hostinger y Cloudflare

> Plantilla de reporte de aceptación en vivo. Completa cada sección tras ejecutar el flujo Chrome-only. Nunca incluyas credenciales, IDs de suscripción/tenant/cuenta/zona, IPs, correos personales, ni nombres de usuario.

## Resultado ejecutivo
- Resultado global: (pass | fail)
- Commit SHA: (40 hex)
- Release version: (vX.Y.Z)
- UTC run ID: (YYYYMMDDTHHMMSSZ)
- Hostname público de prueba: (hostname sin esquema)

## Release y trazabilidad
- Tag de release: vX.Y.Z
- SHA256 del bundle: (64 hex)
- URL del GitHub Release: (link)
- Estado de retención de recursos: retain_until_user_review

## Entorno Azure
- Nombre del recurso (safe): quoteops-e2e-<UTC_RUN_ID>
- Región: (región, sin IDs)
- Tamaño/OS: (p. ej. Standard_B2s, Ubuntu Server 24.04 LTS x86_64)
- Captura: 01-azure-vm-overview.png PASS
- Captura: 02-azure-ubuntu-preflight.png PASS

## Mock TMS en Hostinger/Supabase
- Nombre del proyecto aislado: quoteops-tms-e2e-<UTC_RUN_ID>
- Origen HTTPS: (hostname, sin IDs de cuenta)
- Captura: 03-hostinger-supabase-stack.png PASS
- Captura: 04-tms-seed-counts.png PASS
- Captura: 05-tms-contract-pass.png PASS

## Cloudflare Tunnel y Access
- Nombre del tunnel: quoteops-e2e-<UTC_RUN_ID>
- Hostname público: (hostname)
- Captura: 08-cloudflare-tunnel-healthy.png PASS
- Captura: 09-cloudflare-access-policy.png PASS
- Captura: 10-cloudflare-protected-origin.png PASS

## Onboarding de QuoteOps
- Cliente/instalación: (client_id / installation_id del install pack)
- Captura: 06-azure-install-version.png PASS
- Captura: 07-quoteops-onboarding-ready.png PASS

## Cotización y writeback
- RFQ controlada: Guadalajara → Monterrey, caja seca 53
- Captura: 11-quote-request.png PASS
- Captura: 12-quote-result.png PASS
- Captura: 13-supabase-writeback.png PASS

## Reinicio y persistencia
- Captura: 14-post-restart-ready.png PASS

## Evidencia visual
- Conteo de screenshots: 14
- SHA256SUMS verificado: (sí/no)

## Hallazgos e incidencias
- (lista cualquier desviación, error o advertencia; "ninguno" si aplica)

## Seguridad y datos omitidos
- Se omite: tokens, API keys, subscription/tenant IDs, IPs, credenciales, correos personales.
- Escaneo de patrones de secreto en texto: PASS

## Recursos retenidos y limpieza pendiente
- Azure VM/resource group: quoteops-e2e-<UTC_RUN_ID> — retain_until_user_review
- Hostinger proyecto/schema/contenedor: quoteops-tms-e2e-<UTC_RUN_ID> — retain_until_user_review
- Cloudflare tunnel/hostname/Access/service token: quoteops-e2e-<UTC_RUN_ID> — retain_until_user_review
- Acción recomendada: revocar/rotar credenciales desechables tras revisión.
