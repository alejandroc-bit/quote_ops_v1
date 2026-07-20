# Manifiesto de evidencia redactada

- Fecha local: 2026-07-20, America/Monterrey
- Cliente de laboratorio: RESAUX
- Instalación canónica: resaux-prod-001
- Versión final: v0.1.7
- Rama de reparación: codex/fix-quoteops-human-simulator
- VPS: 2.25.78.180
- URL de prueba: http://2.25.78.180:8094
- Corrida final: run-rfq-2026-771655
- RFQ final: RFQ-2026-120504
- Quote final: quote-v2-RFQ-2026-120504-L01

## Alcance

La prueba recorrió Gmail, Resend Receiving, NVIDIA NIM, SAKBÉ en vivo, quote-core, aprobación humana, un TMS HTTP ficticio, writeback de cotización, prueba de writeback de estado, respuesta por correo con PDF y sincronización agregada al control plane.

## Límites

El TMS local simula un contrato estilo SAP. No hubo conexión, certificación ni mutación sobre un sistema SAP real. Las capturas y los artefactos omiten todos los secretos y enlaces de un solo uso.
