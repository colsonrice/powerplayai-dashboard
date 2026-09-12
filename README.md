# PowerPlayAI · Community Results

The public analytics page at <https://www.squatchcraft.com/powerplayai-dashboard/>.
Static files, published by GitHub Pages from `main` (about a minute after a push).

| File | Purpose |
|---|---|
| `index.html` | Page shell: top bar, filter row, the six chapter mounts |
| `dashboard.css` | Look shared with the picks page (Fraunces / Hanken Grotesk / IBM Plex Mono) |
| `dashboard.js` | Fetches the worker, renders every chapter; Chart.js 4 from jsdelivr |
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
