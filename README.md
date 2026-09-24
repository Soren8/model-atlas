# LLM Frontier 3D — cost : speed : intelligence

Polished, responsive, interactive 3D scatter chart of LLM cost per task (x, log),
speed (y, log) and intelligence (z), with a highlighted 3D Pareto frontier.
Inspired by <https://llm-frontier.catalystneuro.com/>.

Stack: Vite + vanilla JS + Plotly `gl3d` (`plotly.js-gl3d-dist` npm package).
Data: `public/data/models.json`, normalized from the upstream llm-frontier JSON
by `scripts/refresh.py` (Python standard library only).

## Setup

Requires Docker with Docker Compose on the host. From this repository, run:

```sh
docker compose up --build -d
```

Open <http://localhost:8081>. Dependency installation, JavaScript tests, and the
production build run inside the Docker build stage. Dependencies come from the
lockfile with npm lifecycle scripts disabled. The runtime contains only nginx
and the built site, runs as a non-root user with a read-only filesystem, and
binds to localhost. No source directories or host credentials are mounted.

After code or snapshot changes, rerun `docker compose up --build -d` on the host.
Stop the server with `docker compose down`; inspect logs with
`docker compose logs -f web`.

To refresh the checked-in data manually and run its Python tests in a container:

```sh
docker run --rm --user "$(id -u):$(id -g)" --read-only --tmpfs /tmp \
  -e PYTHONDONTWRITEBYTECODE=1 \
  --mount "type=bind,src=$(pwd)/scripts,dst=/app/scripts,readonly" \
  --mount "type=bind,src=$(pwd)/public/data,dst=/app/public/data" \
  --workdir /app python:3.12-alpine \
  sh -c 'python scripts/test_refresh.py && python scripts/refresh.py'
```

Only the data directory is writable in that refresh container. Rebuild the web
image afterward to serve the refreshed snapshot.

Snapshots are written with mode `0644`, and the image build makes static assets
readable by the unprivileged nginx process.

## Automation

- **Data refresh** (`.github/workflows/refresh.yml`): runs every 6 hours and on
  manual dispatch. It fetches the upstream JSON instead of rescraping
  Artificial Analysis, validates the schema (positive costs, known era range,
  well-formed rows), normalizes into `public/data/models.json` with an atomic
  write, preserves the previous snapshot on any failure, and only commits when
  measurements actually changed (`fetched_at` alone never causes churn).
- **Pages deploy** (`.github/workflows/pages.yml`, optional): builds with Vite
  inside Docker and deploys `dist/` to GitHub Pages on pushes to `main`, manual dispatch,
  and successful data refreshes. Enable once under
  Settings → Pages → Source: “GitHub Actions”.

## Methodology and limits

- Cost is the **measured billed cost per Intelligence Index task, including**
  input, reasoning and answer tokens — not a per-token list price.
- Speed is the measured **end-to-end time per task** (output speed, time to
  first token, reasoning length, provider queueing combined), plus median
  output throughput and time-to-first-token as supporting facts.
- **Index eras are incomparable.** When the source recomposes the Intelligence
  Index, scores and costs shift basis, so the chart shows one era at a time
  (default: current) and never mixes them.
- The Pareto frontier is computed live in 3D over the filtered view
  (higher intelligence, lower cost, better speed); ties are kept together.
- Axes stay fixed per era/speed view. Cost (log), speed (log) and
  intelligence span the full selected-era population — every measured row
  plus every eligible deal estimate at the active quota use, including
  retired models — computed before search/provider/open/retired/frontier
  filtering, so the grid never rescales while filtering. Toggling Deals
  on/off does not rescale (estimates are always in the domain); only quota
  use, promo expiry, speed-metric switches (new units) and era switches
  legitimately recompute. Log ranges use log10 with endpoint padding and
  singleton expansion so all plottable points (including frontier extremes)
  sit inside; eras with no speed measurements leave speed to autorange.
- The green “Preferred corner” box marks the cheaper/faster/smarter octant of
  the full era domain (log midpoint on cost and speed, mid-range on
  intelligence, top at the fixed era ceiling) — a static guide, not an
  optimum; hidden when the domain collapses or nothing is plottable, so
  empty states stay accurate.
  It renders at 15% opacity and never intercepts model hover (excluded from
  the 3D pick buffer, so dots hover through it).
- The intelligence axis tops out at the highest score in the selected era, holding steady across search, provider, and frontier filters.
- The Intelligence Index is one aggregate — models with equal scores can differ
  per task — and the evaluation suite is reasoning-heavy, so chat workloads
  scale differently. See the
  [upstream methodology](https://llm-frontier.catalystneuro.com/methodology/).

- Provider colors are the verified Artificial Analysis brand fills
  (per-model `creator.color`, cross-checked with the models legend; sources
  reviewed 2026-09-24). Unknown future providers fall back to neutral gray;
  dark fills stay readable via a light dot outline.

## Deals (estimates, off by default)

The **Deals** toggle adds separately labeled estimate points next to the
measured ones; the cost axis title says so while they are shown. Estimates
inherit benchmark intelligence/speed (not provider measurements), flow
through the same filters/frontier/ceiling/speed logic, and carry pricing
terms in hover text and the table Terms column. Each assumes benchmark cost
meters at Go rates (never exact parity) with the full budget on the modeled
tier. Mapping: `src/deals.js` — hand-curated from the
[Meta](https://dev.meta.ai/docs/pricing-rate-limits)
([reasoning](https://dev.meta.ai/docs/reasoning),
[models](https://dev.meta.ai/docs/models)) and
[OpenCode Go](https://opencode.ai/docs/go/) docs, exact snapshot-id match,
current era only, never auto-rescraped. Sources reviewed 2026-09-24;
re-review when tiers/prices/promos change. Priority: Muse Spark 1.3/1.2
(xhigh) Contributor repricing (assumed 7:2:1 mix); Go quota-equivalents at
$15/$30/$60 (V4.1 Flash uses the active $60 promo until 2026-09-28T00:00Z,
then $15). Uncertain aliases, dated versions, free promos and
Standard-only (max) efforts are omitted.

## Source and data terms

- Measurements: [Artificial Analysis](https://artificialanalysis.ai/) (their
  terms govern use of the data).
- Upstream site, updater and history:
  [catalystneuro/llm-frontier](https://github.com/catalystneuro/llm-frontier)
  (code BSD-3-Clause), live data at
  <https://llm-frontier.catalystneuro.com/data/llm-frontier.json>.
