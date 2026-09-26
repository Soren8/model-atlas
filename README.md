# Model Atlas — Explore the AI Model Pareto Frontier in 3D

Polished, responsive, interactive 3D scatter chart of LLM cost per task (x, log),
speed (y, log) and intelligence (z), with a highlighted 3D Pareto frontier.
Inspired by <https://llm-frontier.catalystneuro.com/>.

Stack: Vite + vanilla JS + Plotly `gl3d` (`plotly.js-gl3d-dist` npm package).
Data: `public/data/models.json` (served "latest" copy), normalized from the
upstream llm-frontier JSON by `scripts/refresh.py` (Python standard library
only). Each update also writes a dated `public/data/models-YYYY-MM-DD.json`
history file (one per UTC day; a same-day re-run overwrites that day's file)
for future time-based views.

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

- **VPS image** (`.github/workflows/docker-build-push.yml`): after tests pass,
  builds `linux/amd64` inside Docker and publishes
  `ghcr.io/soren8/model-atlas:latest` plus a commit tag to GHCR using the
  built-in `GITHUB_TOKEN`. Make the container package public after its first
  publish so the VPS can pull it without credentials. Refresh commits also
  trigger a new image build. After a successful publish, the workflow dispatches
  `managed-repo-push` to `Soren8/iac` with the repository name and exact checked
  out commit SHA, so the sibling repository can deploy it. This requires a
  GitHub App installed on `iac`, with repository
  permissions **Contents: read and write** (write is required for repository
  dispatch). Configure the app's numeric ID as the `IAC_APP_ID` Actions
  repository variable and its private key PEM as the `IAC_APP_PRIVATE_KEY`
  Actions repository secret in `model-atlas`. If either credential or the App
  installation is missing, dispatch fails rather than being silently skipped.

- **Data refresh** (`.github/workflows/refresh.yml`): runs once daily and on
  manual dispatch. It fetches the upstream JSON instead of rescraping
   Artificial Analysis, validates the schema (positive costs, known era range,
   well-formed rows), normalizes into `public/data/models.json` (latest copy,
   what the page renders) plus a dated history snapshot with an atomic
   write, preserves the previous snapshot on any failure, and only commits when
  measurements actually changed (`fetched_at` alone never causes churn).

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
- Axes stay fixed per era/speed/scale view. Cost and the active speed metric
  span the full selected-era population — every measured row
  plus every eligible Contributor and subscription estimate at the active
  use, including retired models — computed before
  search/provider/open/retired/frontier/subscription filtering, so the grid
  never rescales while filtering. Toggling subscription estimates on/off does
  not rescale (Contributor plus all eligible subscription estimates are
  always in the domain); only use, promo expiry, speed-metric switches (new units),
  scale switches (new units) and era switches legitimately recompute. Log ranges use log10 with endpoint padding and
  singleton expansion so all plottable points (including frontier extremes)
  sit inside; linear ranges run zero through the padded max; eras with no speed measurements leave speed to autorange.
- The **Log scale** checkbox (off by default) switches cost and the
  active speed axis between log and linear together; intelligence is always
  linear. Axis titles name the active scale.
- The green “Preferred corner” box marks the cheaper/faster/smarter octant of
  the full era domain (scale midpoint on cost and speed — geometric on log
  axes, arithmetic on linear — mid-range on
  intelligence, top at the fixed era ceiling) — a static guide, not an
  optimum; hidden when the domain collapses or nothing is plottable, so
  empty states stay accurate.
  It renders at 15% opacity in a separate transparent Plotly layer with
  `pointer-events: none` (no axes/grids/labels/modebar); the main plot holds
  scatter points only, so the box can never occlude picks and dots always
  hover. Both layers share the same camera, ranges, margins and cube aspect,
  synced on rotate/pan/zoom, reset, filtering, empty states and resize. Touch
  and animated wheel gestures read Plotly's live gl3d camera because Plotly
  does not emit touch camera events. Two-finger drag pans and pinch zooms
  both layers together; one-finger drag rotates. The box stays outside the
  pick scene.
- Zooming into the scene moves axis names to visible chart corners; reset
  restores Plotly's axis titles.
- The intelligence axis tops out at the highest score in the selected era, holding steady across search, provider, and frontier filters.
- The provider filter opens on **All providers** (no filtering); single-click
  any provider to filter, click again to release it — no ctrl key needed —
  and All clears the filter. Several providers combine freely; switching eras
  keeps valid picks and drops stale ones.
- The archive era (v4.1, before 2026-09-05) plots historical speed: 33 of its
  36 rows carry the latest in-era dated time measurement from the upstream
  history (observation dates in hover; throughput was never recorded
  there, so the throughput metric is disabled and the view falls back to
  time). Those rows read retired today — current status, not historical
  availability — so selecting the archive reveals them instead of hiding them.
  Archived times are sparse and not synchronized to the snapshot date.
- Camera is sticky: rotate/zoom/pan persists across search, provider,
  open/retired, frontier, subscription, utilization, speed, and era,
  resize and empty states; only Reset camera restores the default view.
- The Intelligence Index is one aggregate — models with equal scores can differ
  per task — and the evaluation suite is reasoning-heavy, so chat workloads
  scale differently. See the
  [upstream methodology](https://llm-frontier.catalystneuro.com/methodology/).

- Provider colors are the verified Artificial Analysis brand fills
  (per-model `creator.color`, cross-checked with the models legend; sources
  reviewed 2026-09-24). Unknown future providers fall back to neutral gray;
  dark fills stay readable via a light dot outline.

## Estimates: Contributor (always on) vs subscription (off by default)

Direct **Contributor** repricings use the distinct Meta token tariff and are
always plotted in their own `Contributor (estimates)` trace alongside the
measured rows (same search/provider/era/retired/frontier/ceiling/speed
filtering; upstream measured rows never mutated). Cost is the Standard
measured cost repriced at Contributor rates ($0.15/$1.25/$4.25 perM vs
$0.002/$0.10/$0.20 cached/input/output) under an assumed 7:2:1 mix
(.0414/.78, no per-task token counts published); intelligence/speed are
inherited benchmark values, never provider-measured and never labeled
measured. Hover text identifies the Contributor estimate and its assumption.
Muse Spark 1.3 (xhigh) and 1.2 (xhigh) only — `(max)` is Standard-only and
stays measured-only.

The **Subscription estimates** toggle (off by default) adds subscription
estimates in separate per-offer traces (same provider colors, same round
markers as measured points; trace label + hover carry the offer), including compounded Contributor-via-Go for the Muse Spark
Contributor rows. The adjacent **Exclude $200+ tiers** checkbox (checked by
default) hides $200/mo plans (Claude Max, Codex, Cursor Ultra) by monthly
plan fee while keeping the $10/mo Go estimates (Go $30/$60 are quota
amounts, not fees), and keeps the $20/month Claude Pro and ChatGPT Plus/Codex
scenarios visible; uncheck to show all offers including $200 tiers. These $20
scenarios use transparent user-assumed scaling at half efficiency per dollar
of the corresponding $200 proxy (Claude 40x → 20x; Codex 70x → 35x). They are
not new audits or measured saturation values. Contributor stays always on.
Axes and the green box still span all tiers, so the exclusion never rescales.
Scenario cost is always
`measured ÷ (multiplier × use)` at your quota/workload-use %; scenario
intelligence/speed are inherited benchmark proxies, never provider-measured.
Every scenario is an approximate, user-authorized **lab-wide workload
proxy** — not the measured per-model task, with no guaranteed current
capacity. Mapping: `src/deals.js` — hand-curated from the docs and audits in
the evidence table below; exact Go snapshot-id match; scenarios match
explicit live current-era lab/family scopes (never universal); retired rows,
archive eras and Mythos enterprise-only rows never gain scenario points, and
Fable rows are withheld from the 40x proxy (reduced Max limits, uncalibrated)
while included in the Cursor pool. Source basis June 2026, reviewed
2026-09-24; re-review when tiers/prices/promos change.

### Evidence (full-use estimates; $20 ratios are extrapolated)

| Offer (trace/terms) | Fee | Plotted ratio | Basis | Lower-bound reference | Scope |
| --- | --- | --- | --- | --- | --- |
| Go quota-equiv (`Go $30/$60 quota-equiv est.`) | $10/mo | 3x / 6x ($10 over $30/$60) | [OpenCode Go](https://opencode.ai/docs/go/) quotas (5h 20% / weekly 50% / monthly 100%; $15 omitted; V4.1 Flash uses the active $60 promo until 2026-09-28T00:00Z, then disappears) | — | Curated exact snapshot ids, current era |
| Claude Max $200 (`Claude Max $200 ~40x est.`) | $200 | ~40x | [SemiAnalysis methodology, June 10 2026](https://x.com/SemiAnalysis_/status/2064815044085318040) (weekly caps exhausted); [token-value numbers](https://pasqualepillitteri.it/en/news/4793/semianalysis-token-value-claude-chatgpt-plans); [enterprise pricing](https://quesma.com/blog/claude-code-pricing-for-enterprise/) (Fable at reduced Max limits — omitted here as uncalibrated) | 39.07x — [July 1–20 self-audit](https://atticusli.com/blog/posts/claude-code-subscription-vs-api-cost-audit/) ($7814.13 vs $200) | Live current-era Anthropic Claude Opus/Sonnet/Haiku; Fable omitted (reduced limits), Mythos omitted (enterprise-only) |
| Claude Pro $20 (`Claude Pro $20 ~20x est.`) | $20 | ~20x | Assumed half the per-dollar value of the Claude Max $200 ~40x scenario; **not independently measured** | — | Same Claude scope as above |
| ChatGPT Pro/Codex $200 (`ChatGPT Pro/Codex $200 ~70x est.`) | $200 | ~70x | Same [SemiAnalysis June 10 2026 methodology](https://x.com/SemiAnalysis_/status/2064815044085318040); [token-value numbers](https://pasqualepillitteri.it/en/news/4793/semianalysis-token-value-claude-chatgpt-plans) | 29.81x — [Aug 1–19 Codex audit](https://norml.studio/blog/ai-subscription-vs-api-pricing) ($5961.08 vs $200), reference only | Live current-era OpenAI GPT subscription rows (`gpt-*`, no `gpt-oss`); Mythos omitted if present (enterprise-only) |
| ChatGPT Plus/Codex $20 (`ChatGPT Plus/Codex $20 ~35x est.`) | $20 | ~35x | Assumed half the per-dollar value of the ChatGPT Pro $200 ~70x scenario; **not independently measured** | — | Same GPT scope as above |
| Cursor Ultra $200 (`Cursor Ultra $200 ~2x est.`) | $200 | ~2x | Last-published $400 third-party pool on the $200 tier (basis thru Aug 2026: [forum pools](https://forum.cursor.com/t/156411), [forum pools](https://forum.cursor.com/t/144918), [staff note July 2026](https://forum.cursor.com/t/166360)); current [Cursor pricing](https://cursor.com/docs/models-and-pricing) only says “Included” — current pool size unverified | — (Pro 1x / Pro+ ~1.17x too small, omitted) | Live current-era Claude/GPT/Gemini pool rows only (Fable included — Cursor lists Fable 5 rates); Meta/Grok/Composer and other labs excluded |

The 40x/70x ratios are explicitly **not** the plan-official 5x/20x usage
labels ([Anthropic Max](https://support.claude.com/en/articles/11049741-what-is-the-max-plan),
[OpenAI pro tiers](https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers)
refer to per-5h usage with weekly caps, not an API-dollar ratio).

### Researched but not plotted

Reviewed 2026-09-24. No invented availability: anything outside the table
scope above gains no estimate point.

- Cursor Composer
  ([June 2026 audit](https://codejam.info/2026/06/how-much-is-composer-2-5-subsidized-in-cursor.html)):
  Pro $20 reported ~$208 overall value (163 Auto/Composer, 46 API pool),
  ~10x — Composer-heavy and Composer-only. It is never transferred to Grok
  or other third-party models, and no unsupported Composer row is plotted
  where the benchmark has no measurement.
- Direct Grok / Gemini ratios: no defensible ratio exists (unknown, not 1x),
  so neither is plotted directly. Gemini is still covered via the Cursor
  Ultra third-party pool above, which is a separate, supported estimate.

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
