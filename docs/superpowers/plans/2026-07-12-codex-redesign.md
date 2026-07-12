# Codex handoff — Rediseño Inducta de todas las superficies web + `--no-pull`

Repo: `/Users/alejandro/quote_ops_v1`. Baseline: HEAD (348 tests verdes, builds verdes). No `git commit/push`. No new npm dependencies. Do not migrate frameworks — work with the existing Vite + React + plain CSS setup.

## Scope

1. **Redesign BOTH web apps in `apps/web`** to the Inducta design system below:
   - Appliance playground (`ClientPortalApp.tsx` + its pages: runs, aprobaciones, inbox, rfqs, timeline, setup…)
   - Cloud portal (`ControlPlaneApp.tsx` + its pages: clients, clientProfile, sentinelReports, setup…)
   Keep ALL existing functionality, page keys, nav events, API wiring, and test hooks intact. This is a restyle + UX-state upgrade, not a rewrite.
2. **`deploy/appliance/install.sh`: add `--no-pull` flag** — when set, skip `docker compose pull` but still run `config` validation and `up -d`. Update usage help + any installer tests/snapshots. (Needed for private-GHCR installs where images are pre-loaded with `docker load`.)

## Inducta design system (non-negotiable)

Industrial AI platform for critical operations: white/black/technical-gray monochrome, Attio-like clarity, precise and operational. NO blue/purple gradients, NO decorative colors, NO colorful icons, NO startup-AI visuals.

CSS foundation (put in the shared stylesheet as `:root` variables and use everywhere):
```css
--color-black:#000000; --color-industrial-black:#0B0D10; --color-graphite:#1F2328;
--color-steel:#69707D; --color-muted:#9AA1AE; --color-line:#E4E7EB; --color-grid:#F1F3F5;
--color-white:#FFFFFF; --radius-sm:10px; --radius-md:14px; --radius-lg:20px;
--shadow-soft:0 24px 60px rgba(0,0,0,0.04);
--font-display:"Inter Tight","Geist","Helvetica Neue",sans-serif;
--font-body:"Inter","Geist","Helvetica Neue",sans-serif;
--font-mono:"Geist Mono","IBM Plex Mono",monospace;
```
- White canvas; #000 for headlines/primary CTAs; #69707D secondary text; #E4E7EB thin borders; #F1F3F5 subtle grids; optional premium dark sections only on #0B0D10.
- Buttons: primary = solid black, white text, radius 14px, weight 600; secondary = white with 1px #E4E7EB border. Inputs: 1px #DDE1E6 border, radius 14px.
- Cards: white, 1px #E5E7EB border, radius 20px, shadow-soft. Subtle dotted-grid backgrounds via `radial-gradient(#DDE1E6 1px, transparent 1px); background-size:20px 20px;` where a section needs texture.
- Use system font stacks exactly as above (no external font CDN — the appliance web must stay self-contained; if `index.html` already loads fonts locally keep that, otherwise rely on fallbacks).
- Monospace ONLY for small operational labels, states, IDs, metrics (`font-variant-numeric: tabular-nums` for numeric tables).
- Icons: linear, geometric, monochrome, 1.5–2px stroke (inline SVG; no icon library).
- Tabs/nav: active = black bottom line; inactive = gray text.
- Voice: es-MX, directo, técnico, ejecutivo. Sentence case. Sin "revoluciona", sin "el futuro de la IA", sin signos de exclamación en mensajes de éxito. Vocabulario: operaciones críticas, decisiones en tiempo real, precisión, trazabilidad, control.
- The step-timeline of runs should read like a control-system flow (Señal → Clasificación → Análisis → Recomendación → Acción), monochrome status chips: black=done, steel=running, muted=pending; errors may use a single restrained red ONLY for error states (#B42318), nothing else colored.

## Redesign audit to apply (from the redesign checklist)

- Hover/active/pressed states on ALL interactive elements (200–300ms transitions, `transform`/`opacity` only); visible focus rings.
- Loading = skeletons matching layout shape (not spinners); designed EMPTY states (e.g. runs list empty → "Sin cotizaciones aún" + short guidance); inline error states (no alert()).
- Max-width container 1120–1240px, 24–32px gutters; mobile-first: 24px side padding, full-width cards, no collisions.
- Semantic HTML (nav/main/section); active nav indication; `min-height:100dvh` not 100vh; `text-wrap:balance` on headings.
- Tabular numbers for rates/metrics; sentence case headers; realistic es-MX microcopy.
- No 3-equal-card generic rows; prefer product-panel modules and asymmetric layout where natural.
- Keep a single gray family (the cool grays above); shadows subtle per shadow-soft.

## Verification (definition of done)

1. `npm run build` green (BOTH vite builds: appliance + control).
2. `npx vitest run` fully green (update UI tests' selectors/copy only where the redesign legitimately changed text — keep test intent).
3. End with a summary: pages restyled, states added, install.sh change, tests touched.
