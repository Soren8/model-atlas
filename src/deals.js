/**
 * Curated, source-reviewed "Deals" configuration.
 *
 * This file is maintained by hand from the official provider docs listed
 * below — it is deliberately separate from the measured snapshot
 * (`public/data/models.json`) and is never rescraped automatically, because
 * neither Artificial Analysis nor the upstream llm-frontier feed publishes
 * these deal prices. Re-check the sources before trusting the estimates:
 * tiers, token prices and promos change.
 *
 * Reviewed: 2026-09-24.
 * Refresh policy: re-review against the official sources below whenever the
 * snapshot is refreshed or a listed tier/promo changes; update
 * DEALS_REVIEWED and the mapping in the same edit.
 *
 * Sources:
 *  - Meta Muse Spark Contributor pricing/terms:
 *    https://dev.meta.ai/docs/pricing-rate-limits (Contributor tier rates,
 *    discounted in exchange for permission to train on prompts/completions)
 *  - Meta reasoning tiers (max effort is Standard-only, hence Contributor
 *    never maps to a `(max)` snapshot row):
 *    https://dev.meta.ai/docs/reasoning
 *  - Meta model catalog: https://dev.meta.ai/docs/models
 *  - OpenCode Go subscription, model list, per-model monthly quotas and
 *    limit windows ($10/mo; per-model monthly tier $15/$30/$60 with rolling
 *    5h 20% / weekly 50% / monthly 100%):
 *    https://opencode.ai/docs/go/ (last updated 2026-09-23 per that page)
 *    Only the notable $30/$60 tiers gain estimate points; the $15 tier is
 *    omitted as not notable (see `buildDealPoints`).
 *
 * Explicit omissions (no fuzzy matches, no stale promos, no $15 tier):
 *  - Every $15-tier Go mapping is omitted as not notable: `glm-5-3-max`,
 *    `kimi-k3-low`/`-max`, `mimo-v2-6-pro`, `mimo-v2-5-pro`, `qwen3-8-max`
 *    (plus its dated `qwen3-8-max-0902` alias), Grok 4.7/4.6 effort rows,
 *    GPT-6/GPT-5.6 Luna effort rows, `deepseek-v4-flash-vision-*`, and the
 *    DeepSeek V4.1 Flash base tier after its $60 promo expires (the promo
 *    point disappears instead of reverting to $15).
 *  - `qwen3-8-flash-next`: not equated with Go "Qwen3.8 Flash" — the alias
 *    is unverified, so the uncertain mapping is skipped entirely.
 *  - Dated DeepSeek rows (`deepseek-v4-flash-0420-*`, `-0731-*`,
 *    `deepseek-v4-pro-0424-*`, `-0813-*`) and `qwen3-8-max-0902`: only dated
 *    snapshot rows exist, and routing to historic versions is unverified, so
 *    no dated alias maps to a generic Go id. (The unversioned `qwen3-8-max`
 *    row would map, but its $15 tier is omitted as not notable.)
 *  - `mimo-v2.6-flash`, `minimax-m2.5`, `hy4-preview`: listed by Go but have
 *    no exact row in the measured snapshot, so no estimate is fabricated.
 *  - `qwen3-6-plus`: listed by Go but only present in the archive era of the
 *    snapshot (no current-era row); estimates never mix eras.
 *  - `space-bunny-free`: a limited-time free promo (cost 0 cannot plot on the
 *    log cost axis; free promos were not requested).
 *  - `muse-spark-1-3-max`: Contributor only supports xhigh effort and below
 *    (max is Standard-only), so it stays measured-only.
 *  - `qwen3-8-2-4t-a95b`, `muse-spark-1-1-xhigh`, `muse-glimmer-high`: present
 *    in the snapshot but not in the Go model list — never mapped.
 *
 * Effort-mapping assumption: Go lists model families (GLM-5.2/5.1) without
 * an effort level, so every current-era snapshot effort row maps explicitly
 * at the family tier on the assumption Go serves those efforts alike. These
 * are estimates, not measured costs. Former $15 families (Grok 4.7/4.6,
 * GPT-6 / GPT-5.6 Luna, Kimi K3) are omitted with the tier.
 */

/** Sources reviewed 2026-09-24 against the docs cited in this file. */
export const DEALS_REVIEWED = '2026-09-24';

export const DEALS_REFRESH_POLICY =
  'Hand-curated from the official docs cited in this file; not auto-refreshed. ' +
  'Re-review when the snapshot refreshes or a tier, price or promo changes.';

/** OpenCode Go subscription price in USD/month (https://opencode.ai/docs/go/). */
export const GO_SUBSCRIPTION_USD = 10;

/**
 * Per-model monthly quota tiers offered by Go (USD of included usage).
 * The pure quota formula supports all three tiers, but deal points only
 * emit the notable $30/$60 tiers — see `buildDealPoints` in lib.js.
 */
export const GO_TIERS = [15, 30, 60];

/** Minimum effective Go tier that gains an estimate point ($15 omitted). */
export const MIN_NOTABLE_GO_TIER = 30;

/**
 * Meta per-1M-token list prices in USD: Standard vs Contributor.
 * Contributor is heavily discounted in exchange for permission to train on
 * prompts/completions (see Meta pricing/rate-limits docs). Training terms
 * apply — check the official docs before use.
 */
export const CONTRIBUTOR_RATES = {
  standard: { cached: 0.15, input: 1.25, output: 4.25 },
  contributor: { cached: 0.002, input: 0.1, output: 0.2 },
};

/**
 * Assumed per-task token mix (cached:input:output) used to reprice Standard
 * measured cost into a Contributor estimate. The benchmark publishes no
 * per-task token counts, so this is an explicitly estimated token-mix
 * repricing — not an Artificial Analysis measured cost.
 * Blend: standard (7*.15 + 2*1.25 + 1*4.25)/10 = .78;
 * contributor (7*.002 + 2*.10 + 1*.20)/10 = .0414.
 */
export const CONTRIBUTOR_BLEND = { cached: 7, input: 2, output: 1 };

/**
 * Exact snapshot-id mapping. `snapshotId` must equal a row id in
 * `public/data/models.json` (same version AND effort); `goId` is the Go
 * model id from https://opencode.ai/docs/go/ for traceability. Kinds:
 *  - `contributor`: direct token-mix repricing of the Standard measured cost.
 *  - `go`: quota-equivalent estimate from the measured base cost at the
 *    tier quota (assumes benchmark cost meters at Go rates — flagged on
 *    every surface, never claimed as exact parity).
 *  - `contributor-go`: compounded estimate — Contributor repricing first,
 *    then the Go quota formula on top (used for the Muse Spark Contributor
 *    models that Go serves from its $60 tier).
 */
export const DEAL_ENTRIES = [
  // ---- $60 tier ----
  { snapshotId: 'glm-5-3-flash', goId: 'glm-5.3-flash', kind: 'go', tier: 60 },
  // Go lists "GLM-5.2" without effort; the snapshot's only 5.2 row is (max).
  { snapshotId: 'glm-5-2-max', goId: 'glm-5.2', kind: 'go', tier: 60 },
  // Go lists "GLM-5.1"; the snapshot's only 5.1 row is (Reasoning).
  { snapshotId: 'glm-5-1-reasoning', goId: 'glm-5.1', kind: 'go', tier: 60 },
  { snapshotId: 'kimi-k2-7-code', goId: 'kimi-k2.7-code', kind: 'go', tier: 60 },
  { snapshotId: 'kimi-k2-6', goId: 'kimi-k2.6', kind: 'go', tier: 60 },
  // No speed measurements in the snapshot: table-only when deals are on.
  { snapshotId: 'longcat-2-0', goId: 'longcat-2.0', kind: 'go', tier: 60 },
  { snapshotId: 'mimo-v2-5', goId: 'mimo-v2.5', kind: 'go', tier: 60 },
  { snapshotId: 'minimax-m3', goId: 'minimax-m3', kind: 'go', tier: 60 },
  { snapshotId: 'minimax-m2-7', goId: 'minimax-m2.7', kind: 'go', tier: 60 },
  // Muse Spark 1.3 (xhigh): direct Contributor repricing + compounded Go.
  { snapshotId: 'muse-spark-1-3-xhigh', goId: 'muse-spark-1.3-contributor', kind: 'contributor' },
  { snapshotId: 'muse-spark-1-3-xhigh', goId: 'muse-spark-1.3-contributor', kind: 'contributor-go', tier: 60 },
  // Muse Spark 1.2 (xhigh): direct Contributor repricing + compounded Go.
  { snapshotId: 'muse-spark-1-2-xhigh', goId: 'muse-spark-1.2-contributor', kind: 'contributor' },
  { snapshotId: 'muse-spark-1-2-xhigh', goId: 'muse-spark-1.2-contributor', kind: 'contributor-go', tier: 60 },
  { snapshotId: 'qwen3-7-plus', goId: 'qwen3.7-plus', kind: 'go', tier: 60 },
  { snapshotId: 'hy3', goId: 'hy3', kind: 'go', tier: 60 },
  // ---- $30 tier ----
  { snapshotId: 'qwen3-7-max', goId: 'qwen3.7-max', kind: 'go', tier: 30 },
  // $15 tier omitted entirely as not notable (no estimate points, no domain
  // widening). The pure `estimateGoCost` formula still accepts $15 for
  // general use, but `buildDealPoints` skips any effective tier below $30.
  // DeepSeek V4.1 Flash carries the active 4x promo ($60 tier, ends Sep 27,
  // i.e. expires 2026-09-28T00:00:00Z) over the $15 base tier; the tier is
  // resolved against the review clock, and after expiry the point disappears
  // (no $15 fallback) while the promo is labeled on every surface while
  // active.
  {
    snapshotId: 'deepseek-v4-1-flash-reasoning-max-effort',
    goId: 'deepseek-v4.1-flash',
    kind: 'go',
    promo: { tier: 60, baseTier: 15, expiresAt: '2026-09-28T00:00:00Z' },
  },
];
