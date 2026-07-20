# Clasificación de errores encontrados

## Derivados del repositorio

1. `v0.1.5` introdujo dos propietarios posibles del mailbox poller. La versión `v0.1.6` devolvió la responsabilidad exclusivamente a la API: agent 0, API 1.
2. `v0.1.6` reanudaba el graph y hacía writeback, pero después fallaba al auditar la aprobación contra una FK de la tabla legacy. `v0.1.7` añadió una tabla ligada a `quote_runs` y una operación atómica de claim más auditoría antes de reanudar.

## Externos o aislados

1. El dominio raíz `inducta.io` aparecía verificado en Resend, pero su MX público era Google Workspace. El rebote era de infraestructura de correo, no del parser ni del installer.
2. El VPS no tenía autenticación de lectura para el registro privado GHCR. El 403 era del registro; se construyó desde el tag exacto para completar la prueba sin ampliar credenciales.

## Veredicto

No fue un único error aislado. La simulación separó dos defectos del repositorio, corregidos en `v0.1.7`, de dos condiciones externas de configuración.
