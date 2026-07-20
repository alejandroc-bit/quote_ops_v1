# Reset e instalación del VPS

## Alcance destructivo aplicado

Se eliminó únicamente la instalación QuoteOps aislada `quoteops_vpse2e`. Se conservaron en ejecución `hermes-paperclip`, `paperclip-ekqs`, `supabase` y `traefik`.

## Instalación final

- Fuente: `/root/quoteops-source-v017`
- Tag verificado: `v0.1.7`
- Pack: `/root/quoteops-install-resaux`
- Home persistente: `/opt/quoteops-resaux`
- Proyecto Compose: `quoteops_resaux`
- Mock TMS privado: `quoteops-resaux-mock-tms`
- Puerto HTTP: `8094`
- Puerto HTTPS: `8497`

Los archivos `/opt/quoteops-resaux/.env` y `/opt/quoteops-resaux/secrets/client.env` terminaron con modo `600` y propietario `root:root`.

## Estado final

- Postgres: running, healthy
- Redis: running, healthy
- Agent: running, `v0.1.7`
- API: running, `v0.1.7`
- Web: running, `v0.1.7`
- Caddy: running, healthy
- Pollers de correo en agent: 0
- Pollers de correo en API: 1

GHCR respondió 403 desde el VPS. Para no cambiar el alcance de credenciales, las imágenes se construyeron desde el tag exacto y Compose se ejecutó con `--pull never`.
