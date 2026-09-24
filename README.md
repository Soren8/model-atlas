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
  plus every eligible Contributor and subscription estimate at the active
  use, including retired models — computed before
  search/provider/open/retired/frontier/subscription filtering, so the grid
  never rescales while filtering. Toggling subscription estimates on/off does
  not rescale (Contributor plus all eligible subscription estimates are
  always in the domain); only use, promo expiry, speed-metric switches (new units)
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

## Estimates: Contributor (always on) vs subscription (off by default)

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

The **Subscription estimates** toggle (off by default) adds subscription
estimates in separate per-offer traces (same provider colors, distinct marker
per offer), including compounded Contributor-via-Go for the Muse Spark
Contributor rows. Scenario cost is always
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

### Evidence (plotted ratios are full-use empirical saturation, approximate)

| Offer (trace/terms) | Fee | Plotted ratio | Basis | Lower-bound reference | Scope |
| --- | --- | --- | --- | --- | --- |
| Go quota-equiv (`Go $30/$60 quota-equiv est.`) | $10/mo | 3x / 6x ($10 over $30/$60) | [OpenCode Go](https://opencode.ai/docs/go/) quotas (5h 20% / weekly 50% / monthly 100%; $15 omitted; V4.1 Flash uses the active $60 promo until 2026-09-28T00:00Z, then disappears) | — | Curated exact snapshot ids, current era |
| Claude Max $200 (`Claude Max $200 ~40x est.`) | $200 | ~40x | [SemiAnalysis methodology, June 10 2026](https://x.com/SemiAnalysis_/status/2064815044085318040) (weekly caps exhausted); [token-value numbers](https://pasqualepillitteri.it/en/news/4793/semianalysis-token-value-claude-chatgpt-plans); [enterprise pricing](https://quesma.com/blog/claude-code-pricing-for-enterprise/) (Fable at reduced Max limits — omitted here as uncalibrated) | 39.07x — [July 1–20 self-audit](https://atticusli.com/blog/posts/claude-code-subscription-vs-api-cost-audit/) ($7814.13 vs $200) | Live current-era Anthropic Claude Opus/Sonnet/Haiku; Fable omitted (reduced limits), Mythos omitted (enterprise-only) |
| ChatGPT Pro/Codex $200 (`ChatGPT Pro/Codex $200 ~70x est.`) | $200 | ~70x | Same [SemiAnalysis June 10 2026 methodology](https://x.com/SemiAnalysis_/status/2064815044085318040); [token-value numbers](https://pasqualepillitteri.it/en/news/4793/semianalysis-token-value-claude-chatgpt-plans) | 29.81x — [Aug 1–19 Codex audit](https://norml.studio/blog/ai-subscription-vs-api-pricing) ($5961.08 vs $200), reference only | Live current-era OpenAI GPT subscription rows (`gpt-*`, no `gpt-oss`); Mythos omitted if present (enterprise-only) |
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
