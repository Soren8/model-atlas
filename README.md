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
  plus every eligible Contributor and Go estimate at the active quota use,
  including retired models — computed before
  search/provider/open/retired/frontier/subscription filtering, so the grid
  never rescales while filtering. Toggling subscription estimates on/off does
  not rescale (Contributor plus eligible Go estimates are always in the
  domain); only quota use, promo expiry, speed-metric switches (new units)
  and era switches legitimately recompute. Log ranges use log10 with endpoint padding and
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

## Estimates: Contributor (always on) vs subscription (Go only, off by default)

Direct **Contributor** repricings use the distinct Meta token tariff and are
always plotted in their own `Contributor (estimates)` trace alongside the
measured rows (same search/provider/era/retired/frontier/ceiling/speed
filtering; upstream measured rows never mutated). Cost is the Standard
measured cost repriced at Contributor rates ($0.15/$1.25/$4.25 perM vs
$0.002/$0.10/$0.20 cached/input/output) under an assumed 7:2:1 mix
(.0414/.78, no per-task token counts published); intelligence/speed are
inherited benchmark values, never provider-measured and never labeled
measured. Hover/table terms say `Contributor est.` with the assumption.
Muse Spark 1.3 (xhigh) and 1.2 (xhigh) only — `(max)` is Standard-only and
stays measured-only.

The **Subscription estimates (Go only)** toggle (off by default) adds Go
quota-equiv estimates in a separate `Subscription estimates (Go only)` trace,
including compounded Contributor-via-Go for the Muse Spark Contributor rows.
Each assumes benchmark cost meters at Go rates (never exact parity) with the
full $10/mo budget on the modeled tier. Mapping: `src/deals.js` —
hand-curated from the
[Meta](https://dev.meta.ai/docs/pricing-rate-limits)
([reasoning](https://dev.meta.ai/docs/reasoning),
[models](https://dev.meta.ai/docs/models)) and
[OpenCode Go](https://opencode.ai/docs/go/) docs, exact snapshot-id match,
current era only, never auto-rescraped. Sources reviewed 2026-09-24;
re-review when tiers/prices/promos change. Go quota-equivalents at the
notable $30/$60 tiers only ($15 omitted; V4.1 Flash uses the active $60
promo until 2026-09-28T00:00Z, then disappears). Uncertain aliases, dated
versions, free promos and Standard-only (max) efforts are omitted.

### Other subscriptions researched (not plotted)

Reviewed 2026-09-24; not plotted — plan-to-API arithmetic without a fixed
included API-dollar pool would be opaque. A comparable per-task ratio would
need actual token usage including caches plus the plan's usage limits.

- GitHub Copilot
  ([billing](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals)):
  Pro $10 includes $15 (1.5x), Pro+ $39 includes $70 (1.79x), Max $100
  includes $200 (2x); totals flex and may change. Credits are
  dollar-denominated but API parity is unverified, so the credit-allowance
  ratio is not an AA-task exact cost.
- Anthropic
  ([Max plan](https://support.claude.com/en/articles/11049741-what-is-the-max-plan)):
  Pro $20, Max $100 5x / $200 20x refers to Pro per-5h usage, not an
  API-dollar ratio; weekly additional caps, no fixed included dollars.
- OpenAI
  ([pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers)):
  Plus $20, Pro $100 5x / $200 20x; Pro $200 new signups paused since
  Sep 10 2026 (existing renew). Quotas depend on tokens/task
  ([codex pricing](https://chatgpt.com/codex/pricing/)), no included API
  dollar pool.
- Cursor ([models and pricing](https://cursor.com/docs/models-and-pricing)):
  plan rates $20/$60/$200, but the current body only says included pools
  with no dollar sizes; unverified indexed $20/$70/$400 figures are not
  published here.

Empirical note (not in UI): a Claude Max $200 self-audit
([subscription vs API cost audit](https://atticusli.com/blog/posts/claude-code-subscription-vs-api-cost-audit/))
via ccusage reports May $237.08 ⇒ 1.19x, Jun $214.91 ⇒ 1.07x, Jul 1–20
$7814.13 ⇒ 39.07x vs the full $200 fee — a partial month, not a monthly
guarantee.

Hover shows an offset HTML card with a pointer to the dot (never centered
over it); Plotly gl3d offers no public hover-card offset, so the built-in
card is suppressed via `hoverinfo: 'none'` and positioned from cursor
screen coords with viewport clamping.

## Source and data terms

- Measurements: [Artificial Analysis](https://artificialanalysis.ai/) (their
  terms govern use of the data).
- Upstream site, updater and history:
  [catalystneuro/llm-frontier](https://github.com/catalystneuro/llm-frontier)
  (code BSD-3-Clause), live data at
  <https://llm-frontier.catalystneuro.com/data/llm-frontier.json>.
