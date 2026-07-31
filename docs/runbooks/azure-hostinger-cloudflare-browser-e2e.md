# Azure, Hostinger y Cloudflare — Aceptación E2E por Chrome

> Runbook de aceptación en vivo. Ejecutar desde el MacBook autenticado, solo a través de las interfaces web de Chrome. Prohibido: in-app browser, Appium, headless Chrome, APIs/CLIs de Azure/Hostinger/Cloudflare, Terraform, SSH local, o conexión directa a bases de datos.

## Previo al run

1. Confirma una sesión Chrome autenticada en [Azure Portal](https://portal.azure.com), el Docker Manager de Hostinger (URL local, fuera de Git), y el Dashboard de Cloudflare.
2. Define un UTC run ID único (p. ej. `20260730T120000Z`) y úsalo en todos los nombres de recursos.
3. Escribe `run.json` (local, `0600`, fuera de `docs/evidence/`):
   ```json
   {
     "run_id": "20260730T120000Z",
     "commit_sha": "(40 hex)",
     "release_version": "v0.2.0",
     "azure_resource_name": "quoteops-e2e-20260730T120000Z",
     "hostinger_project_name": "quoteops-tms-e2e-20260730T120000Z",
     "cloudflare_tunnel_name": "quoteops-e2e-20260730T120000Z",
     "public_hostname": "quoteops-e2e.example.com",
     "retention": "retain_until_user_review"
   }
   ```
4. El reporte puede contener nombres visibles de recursos y el hostname público de prueba. NUNCA: subscription/tenant/account/zone IDs, IPs, nombres de usuario, correos personales, ni credenciales. Esos viven solo en archivos `0600` temporales fuera de `docs/evidence/`.

## Flujo Chrome-only

### 1. Azure Ubuntu VM
- Usa la página de VMs del Portal. Preferir una VM Ubuntu 24.04 x86_64 existente y designada como no-producción. Si se crea una nueva, pausa en la pantalla de revisión final y obtén aprobación antes de Create.
- Mínimo: 4 vCPU, 8 GiB RAM, 80 GiB disco, HTTPS/DNS/NTP saliente, sin puerto de ingress de aplicación.
- Usa Bastion/SSH web de Azure para el trabajo de terminal. No SSH local ni Run Command.
- Captura (recorta a la mínima región que pruebe la aserción):
  - `01-azure-vm-overview.png` — VM Running, solo nombre/region seguros.
  - `02-azure-ubuntu-preflight.png` — Ubuntu 24.04, x86_64, recursos, ausencia/presencia de Docker.

### 2. Mock TMS en Hostinger/Supabase
- Abre la URL del Docker Manager de Hostinger en Chrome. Inventaoria el stack Supabase existente sin tocarlo. Crea un proyecto/stack aislado `quoteops_tms_e2e_<UTC_RUN_ID>` (o schema aislado) con rol de mínimos privilegios.
- Despliega el mock-TMS canónico del repo como contenedor digest-pinned, respaldado por la base/schema aislada. El origen HTTPS público debe implementar los seis endpoints `quoteops/v1`.
- Genera un Bearer de prueba; ingrésalo solo en campos secretos; nunca captures la pantalla de revelación.
- Siembra historial sintético Guadalajara–Monterrey y corre la suite de conformance OpenAPI.
- Captura:
  - `03-hostinger-supabase-stack.png` — proyecto aislado saludable, sin IDs de VPS/cuenta.
  - `04-tms-seed-counts.png` — solo nombres de tablas y conteos sintéticos.
  - `05-tms-contract-pass.png` — resultado de los seis endpoints, sin headers/body secrets.

### 3. Instalación de QuoteOps desde terminal Azure
- En la terminal Chrome de Azure, ejecuta el one-command mostrado por el control plane. Pega el registration token solo en el prompt oculto `/dev/tty`. La VM descarga el release inmutable; no clona ni monta el repo.
- Completa el onboarding AI-first con el proveedor real, la identidad de activación, la base URL HTTPS del TMS, los inputs de Cloudflare, mailbox, SAKBÉ, embeddings, units, pricing y el fixture de conocimiento. Nada de credenciales en comandos, screenshots, history o el reporte.
- Si el prereq de Cloudflare no está listo, permite `onboarding_pending`, configúralo en el paso 4 y luego `sudo quoteops onboard --resume`.
- Captura:
  - `06-azure-install-version.png` — versión del release pinned + client/installation IDs.
  - `07-quoteops-onboarding-ready.png` — UI pública con `required_steps` vacío.

### 4. Cloudflare tunnel y Access
- En el Dashboard de Cloudflare, crea un named tunnel remoto, hostname público con ruta `http://caddy:80`, aplicación Access, política allow de usuario humano, y un Service Auth token/política de corta vida, todos nombrados con el UTC run ID. No pidas ni uses un API token de cuenta de Cloudflare.
- Revela/copia los secrets del tunnel y Service Auth solo en los prompts ocultos del onboarding o archivos `0600` temporales; nunca captures pantalla con un secret visible.
- Verifica: `cloudflared_tunnel_ha_connections > 0`, petición pública anónima denegada/redirigida por Access, `/api/setup-state` pública autenticada devuelve el release/client/installation exactos, sesión Chrome humana llega a la UI a través de Access.
- Captura:
  - `08-cloudflare-tunnel-healthy.png` — tunnel Healthy, hostname seguro.
  - `09-cloudflare-access-policy.png` — nombres/acciones de políticas, sin IDs ni secrets.
  - `10-cloudflare-protected-origin.png` — UI de QuoteOps vía Access.

### 5. Viaje de cotización E2E visible
- Usa la UI web de QuoteOps en Chrome (no solo assertions de API) para:
  1. confirmar onboarding ready y probe TMS verde;
  2. enviar la RFQ controlada Guadalajara→Monterrey caja seca;
  3. observar ruta, precio determinista, estado de aprobación y cotización final;
  4. abrir la UI de Hostinger/Supabase y confirmar exactamente un writeback;
  5. reintentar el mismo writeback y confirmar idempotencia;
  6. reiniciar el stack Compose desde la terminal Azure;
  7. recargar la UI pública vía Cloudflare y confirmar persistencia.
- Captura: `11-quote-request.png`, `12-quote-result.png`, `13-supabase-writeback.png`, `14-post-restart-ready.png`.
- Recorta cada screenshot a la mínima región UI que pruebe la aserción nombrada.

## Reporte y validación
1. Escribe `report.md` desde la plantilla `docs/evidence/templates/browser-e2e-report.md`.
2. Para cada screenshot, incluye caption, timestamp UTC, hostname visible, aserción esperada, resultado real y PASS/FAIL.
3. Crea `screenshots.json` con el esquema exacto (id, file, captured_at, browser, surface, assertion, result, sensitive_ui_excluded).
4. Inspecciona visualmente cada PNG a resolución original antes de publicar. Si uno contiene credenciales, emails, IDs de subscription/tenant/cuenta/zona, IPs, o recursos no relacionados, bórralo y recaptura con un recorte seguro; no lo difuminas ni conserves el original inseguro.
5. Genera `SHA256SUMS` y corre:
   ```bash
   npm run evidence:browser:validate -- "$PWD/docs/evidence/<UTC_RUN_ID>-azure-hostinger-cloudflare-e2e"
   ```
   Esperado: `BROWSER E2E EVIDENCE: PASS`.

## Retención y limpieza
- El reporte debe cerrar con un inventario exacto de: VM/resource group de Azure, proyecto/schema/contenedor de Hostinger, tunnel/hostname/Access app/service token de Cloudflare, con estado `retained_pending_user_review`.
- No elimines ni reutilices esos recursos en otra corrida.
- Recomienda rotar/revocar credenciales desechables tras la revisión.

## Commits
- Commitea solo el runbook, plantilla, validador, tests y el script de `package.json`. El reporte y screenshots de la corrida quedan sin commitear hasta que Alejandro los revise y apruebe publicación/limpieza.
