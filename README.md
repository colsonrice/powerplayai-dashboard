# PowerPlayAI · Community Results

The public analytics page at <https://www.squatchcraft.com/powerplayai-dashboard/>.
Static files, published by GitHub Pages from `main` (about a minute after a push).

| File | Purpose |
|---|---|
| `index.html` | Page shell: top bar, filter row, the six chapter mounts |
| `dashboard.css` | Look shared with the picks page (Fraunces / Hanken Grotesk / IBM Plex Mono) |
| `dashboard.js` | Fetches the worker, renders every chapter; Chart.js 4 from jsdelivr |
| `stats-math.js` | Pure game/model/date filters and paired drawing/line summaries |
| `neuron-titan.json` | Audited 1,171-drawing historical model decision, with both hit and prize rates |
| `fixture-v3.json` | A dense `/stats` snapshot for local checks (not published) |

## Data

- `GET https://powerplayai-api.colsonrice.workers.dev/stats` — legacy blocks
  (`totals`, `models`, `subscribers`, `events`, `topWins`, `resultsHistory`) plus
  the `v3` block (arms, draws, eventsByDay, devices, retention, activation, health,
  packs, scanResults, growth, reconcile, rejected, build info).
- `GET …/subscription-events` — App Store Server Notification counts per day.

Both are edge-cached for 5 minutes; the page refreshes on the same cadence and
pauses while the tab is hidden. Worker source: `cloudflare-worker/` in the app repo.

## Local checks

```bash
python3 -m http.server 8899 --directory .
```

- `http://localhost:8899/` — live worker (sparse until the 5.1 rollout completes).
- `http://localhost:8899/?api=./fixture-v3.json` — the dense fixture; the Apple
  block shows "not loaded" unless you also pass `?subs=<url>`.
- Optional deep links: `?window=7|30|90`, `?game=powerball|megaMillions|euroMillions`,
  `?event=<name>&dim=<dimension>` for the explorer.

## Publish

```bash
git add -A && git commit -m "..." && git push origin main
```

Bump the `?v=` query on the CSS/JS tags in `index.html` when either file changes so
Pages' 10-minute asset cache does not serve a stale pair.

## Measurement correction (September 17, 2026)

`evidence.json` is a compact, reproducible snapshot of all 107 policies in the
app's `ModelEvidence.json` (version 9.0.0); the source SHA-256 is embedded.
The headline is Powerball-only retrospective development evidence. Live arms
require worker `v3.evidenceScope = pair_tagged_5_1_plus` and never issue a verdict
at a pair-count threshold. Intervals use drawings as the sampling unit.

`/subscription-events` now includes `snapshot` / `history` from Apple's daily
SUBSCRIPTION reports and a separate partial `ledger` from verified notifications.
Device counts must not be labeled subscribers. Report dates and partial coverage
must stay visible. New notification counters have `_unique` names so older
rescheduling attempts cannot contaminate them. Schedules are not deliveries.

## Model comparison upgrade (September 24, 2026)

The headline now shows the separate Neuron–Titan native historical replay, not the
107-policy development search. Neuron leads on white-any; Titan leads on prize
qualification. Both are visible. Powerball single-line scope and historical
limitations remain explicit. Export source: app repo
`backtest/neuron_titan_compare/export_summary.py`, backed by the audited record in
`docs/research/neuron-titan-decision-2026-09-24/`.

The live tab filters `v3.pairedDraws` by game, model and drawing date. It defaults
to equal drawing weights, offers line weighting, and shows exact matched
denominators and each model's own paired random. No-data states never render as
zero hits. Enhanced reports remain labeled mixed/unknown engine versions because
the historical event mapping does not establish which artifact generated them.
Legacy all-time observations have their own tab. The historical test keeps its
fixed period regardless of live filters.

App repo checks: `node scripts/verify_dashboard_comparison.mjs --fixture`,
`node scripts/verify_worker_v3.mjs`, and `node scripts/verify_measurement_fixes.mjs`.
The first creates ignored `fixture-comparison.json` for browser QA. Do not publish
synthetic fixtures. The worker addition exposes aggregate matched counts only;
it adds no database query, migration, or ingestion change.

## Random benchmarks and replacement review

The replay includes a separately audited uniform random supplement: 74,944 lines
on the same 1,171 drawings. Its seed schedule was fixed before generation, after
the original Neuron–Titan result was known. Original model tickets, scores and
registrations remain unchanged. `random_control` in `neuron-titan.json` contains
the complete period/year summaries, exact expectations, and audit hashes.

Headline rates show both observed random replay and exact uniform expectation.
Main hits and prize qualification receive separate review flags. Yearly tables
retain every year and let users choose either outcome. A flag requires the
selected model to fall below the relevant random benchmark while the alternative
meets or exceeds it and has a higher score than the selected model. Both-below,
at-random and missing-data states are distinct. The two benchmark flags may
disagree and remain visible separately.

Live replacement review intersects each alternative's drawing dates with the
selected model's dates, within the chosen game/window. It gives each shared
drawing equal weight in both models even if the main display uses line weights.
It displays both models' own paired controls, exact random expectation, counts,
date ranges and separate flags. A candidate's unshared dates never contribute.
These are descriptive review cues; reporting users differ and the Enhanced
bucket still mixes generating versions. No routing or model switch occurs.
