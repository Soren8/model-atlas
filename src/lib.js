/**
 * Pure data logic for the 3D cost:speed:intelligence chart.
 *
 * Kept free of DOM/Plotly dependencies so it is unit-testable in Node.
 * Conventions:
 *  - cost (USD/task) and time_sec (s/task) are "lower is better".
 *  - tps (tokens/s) is "higher is better".
 *  - intelligence (iq) is "higher is better".
 */

import {
  DEAL_ENTRIES,
  CONTRIBUTOR_RATES,
  CONTRIBUTOR_BLEND,
  GO_SUBSCRIPTION_USD,
  GO_TIERS,
  MIN_NOTABLE_GO_TIER,
} from './deals.js';

export const SPEED_MODES = {
  /** Default: end-to-end seconds per task, lower is better. */
  time: { key: 'time_sec', label: 'Time per task', unit: 's/task', lowerIsBetter: true },
  /** Optional: median output throughput, higher is better. */
  throughput: { key: 'tps', label: 'Throughput', unit: 'tok/s', lowerIsBetter: false },
};

/**
 * A model dominates another when it is no worse on every axis
 * (higher iq, lower cost, better speed) and strictly better on at least one.
 */
export function dominates(a, b, speedKey, lowerIsBetter) {
  const aSpeed = a[speedKey];
  const bSpeed = b[speedKey];
  if (aSpeed == null || bSpeed == null) return false;
  const iqOk = a.iq >= b.iq;
  const costOk = a.cost <= b.cost;
  const speedOk = lowerIsBetter ? aSpeed <= bSpeed : aSpeed >= bSpeed;
  if (!(iqOk && costOk && speedOk)) return false;
  const iqStrict = a.iq > b.iq;
  const costStrict = a.cost < b.cost;
  const speedStrict = lowerIsBetter ? aSpeed < bSpeed : aSpeed > bSpeed;
  return iqStrict || costStrict || speedStrict;
}

/**
 * True 3D Pareto frontier: models not dominated by any other model
 * in (intelligence, cost, speed). Speed direction follows the active metric.
 * Returns frontier models sorted by ascending intelligence (chart path order).
 */
export function paretoFrontier(models, speedMode = 'time') {
  const mode = SPEED_MODES[speedMode] ?? SPEED_MODES.time;
  const pool = models.filter(
    (m) => m.iq > 0 && m.cost > 0 && m[mode.key] != null && m[mode.key] > 0,
  );
  const frontier = pool.filter(
    (m) => !pool.some((o) => o !== m && dominates(o, m, mode.key, mode.lowerIsBetter)),
  );
  // On exact ties (same iq, cost, speed) every tied model survives: none
  // strictly dominates another, so all remain on the frontier together.
  frontier.sort((a, b) => a.iq - b.iq || a.cost - b.cost);
  return frontier;
}

/**
 * Bounds of the most desirable octant of the given point set: low cost,
 * high intelligence, fastest speed. Cost and speed use the geometric
 * midpoint (centered on the log axes); intelligence uses the arithmetic
 * midpoint. The desirable speed side follows the active metric (low time,
 * high throughput). The box top (`z[1]`) extends to `zCeiling` — the layout
 * intelligence ceiling for the selected era — so the box always reaches the
 * axis top even when filters hide the smartest era model; a non-finite
 * ceiling (or one at/below the midpoint) falls back to the plotted max.
 * Callers pass the full era domain (see `eraDomainPoints`) so the box stays
 * fixed across search/provider/open/retired/frontier filters instead of
 * regenerating around the shown subset.
 * Returns `{ x, y, z }` bound pairs, or null when there is no plottable
 * span (empty input or any axis collapsed) so callers show no misleading box.
 */
export function preferredCornerBounds(models, speedMode = 'time', zCeiling = undefined) {
  const mode = SPEED_MODES[speedMode] ?? SPEED_MODES.time;
  const pts = (models ?? []).filter(
    (m) => m.iq > 0 && m.cost > 0 && m[mode.key] != null && m[mode.key] > 0,
  );
  if (!pts.length) return null;
  let minCost = Infinity;
  let maxCost = -Infinity;
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let minIq = Infinity;
  let maxIq = -Infinity;
  for (const m of pts) {
    if (m.cost < minCost) minCost = m.cost;
    if (m.cost > maxCost) maxCost = m.cost;
    const s = m[mode.key];
    if (s < minSpeed) minSpeed = s;
    if (s > maxSpeed) maxSpeed = s;
    if (m.iq < minIq) minIq = m.iq;
    if (m.iq > maxIq) maxIq = m.iq;
  }
  if (!(maxCost > minCost && maxSpeed > minSpeed && maxIq > minIq)) return null;
  const midCost = Math.sqrt(minCost * maxCost);
  const midSpeed = Math.sqrt(minSpeed * maxSpeed);
  const midIq = (minIq + maxIq) / 2;
  if (
    !(midCost > minCost && midCost < maxCost && midSpeed > minSpeed &&
      midSpeed < maxSpeed && midIq > minIq && midIq < maxIq)
  ) {
    return null;
  }
  const topIq = Number.isFinite(zCeiling) && zCeiling > midIq ? zCeiling : maxIq;
  return {
    x: [minCost, midCost],
    y: mode.lowerIsBetter ? [minSpeed, midSpeed] : [midSpeed, maxSpeed],
    z: [midIq, topIq],
  };
}

/**
 * Plotly log-axis range for a positive linear extent, in log10 units.
 *
 * Plotly `type: 'log'` axes interpret `range` as log10 values, so callers
 * must convert. The range pads beyond both endpoints so markers at exactly
 * the minimum/maximum stay inside the grid instead of clipping on the edge;
 * a singleton (`min === max`) expands into a centered span so the axis stays
 * plottable. Returns undefined for missing or non-positive extents so
 * callers fall back to Plotly autorange.
 */
export function logAxisRange(min, max, { padFraction = 0.05, singletonPad = 0.5 } = {}) {
  if (!Number.isFinite(min) || !(min > 0)) return undefined;
  if (!Number.isFinite(max) || !(max > 0)) return undefined;
  let lo = min;
  let hi = max;
  if (lo > hi) [lo, hi] = [hi, lo];
  const logLo = Math.log10(lo);
  const logHi = Math.log10(hi);
  if (!(Number.isFinite(logLo) && Number.isFinite(logHi))) return undefined;
  if (lo === hi) return [logLo - singletonPad, logHi + singletonPad];
  const pad = (logHi - logLo) * padFraction;
  return [logLo - pad, logHi + pad];
}

/**
 * Full era point set for stable axis domains: every measured row of the
 * selected era plus every eligible estimate for that era at the active
 * quota utilization (always-on Contributor repricings plus eligible Go
 * subscription estimates). Filters (search, provider, open, retired,
 * frontier) never narrow this set — the grid stays fixed while the plotted
 * subset changes. Eras never mix. Estimates are always included, even when
 * the subscription toggle is off, so toggling subscription estimates on/off
 * does not rescale; only economics (utilization, promo clock) legitimately
 * move the bounds.
 */
export function eraDomainPoints(models, { era = null, utilization = 1, now = Date.now() } = {}) {
  const measured = (models ?? []).filter((m) => era === null || m.era === era);
  const deals = buildDealPoints(models, { era, utilization, now });
  return measured.concat(deals);
}

/**
 * Stable chart domains for one era/speed combination: log10 x/y ranges
 * spanning the full era population (measured + eligible deals, including
 * retired rows) and the linear intelligence ceiling (highest era score).
 * Speed ranges use only plottable points (valid active speed metric);
 * models missing speed still contribute to cost/intelligence. Missing
 * speed everywhere leaves `yRange`/`yBounds` undefined so callers keep
 * autorange; missing intelligence leaves `zMax` undefined. Switching speed
 * recomputes `y` in the new units; switching eras re-scopes everything.
 */
export function eraChartDomains(
  models,
  { era = null, speedMode = 'time', utilization = 1, now = Date.now() } = {},
) {
  const mode = SPEED_MODES[speedMode] ?? SPEED_MODES.time;
  const all = eraDomainPoints(models, { era, utilization, now });
  let minCost = Infinity;
  let maxCost = -Infinity;
  let minSpeed = Infinity;
  let maxSpeed = -Infinity;
  let maxIq = -Infinity;
  let hasCost = false;
  let hasSpeed = false;
  let hasIq = false;
  for (const m of all) {
    if (Number.isFinite(m.cost) && m.cost > 0) {
      hasCost = true;
      if (m.cost < minCost) minCost = m.cost;
      if (m.cost > maxCost) maxCost = m.cost;
    }
    const s = m[mode.key];
    if (Number.isFinite(s) && s > 0) {
      hasSpeed = true;
      if (s < minSpeed) minSpeed = s;
      if (s > maxSpeed) maxSpeed = s;
    }
    if (Number.isFinite(m.iq) && m.iq > 0) {
      hasIq = true;
      if (m.iq > maxIq) maxIq = m.iq;
    }
  }
  const xBounds = hasCost ? [minCost, maxCost] : undefined;
  const yBounds = hasSpeed ? [minSpeed, maxSpeed] : undefined;
  return {
    xBounds,
    yBounds,
    zMax: hasIq ? maxIq : undefined,
    xRange: hasCost ? logAxisRange(minCost, maxCost) : undefined,
    yRange: hasSpeed ? logAxisRange(minSpeed, maxSpeed) : undefined,
  };
}

/**
 * Filter models for one view. Eras never mix: exactly one era is selected.
 * Models missing cost/iq are always excluded. Models missing the active speed
 * metric are excluded when `requireSpeed` is set (chart views); table views
 * pass `requireSpeed: false` so eras that predate speed measurements still
 * list cost and intelligence.
 */
export function filterModels(models, opts = {}) {
  const {
    era = null, // null = all eras (only used when a single era exists)
    query = '',
    providers = null, // null/empty = all providers
    openOnly = false,
    includeRetired = true,
    frontierOnly = false,
    frontierIds = null,
    speedMode = 'time',
    requireSpeed = true,
  } = opts;
  const mode = SPEED_MODES[speedMode] ?? SPEED_MODES.time;
  const q = query.trim().toLowerCase();
  const providerSet = providers && providers.size ? providers : null;

  return models.filter((m) => {
    if (era !== null && m.era !== era) return false;
    if (!(m.iq > 0 && m.cost > 0)) return false;
    if (requireSpeed && (m[mode.key] == null || !(m[mode.key] > 0))) return false;
    if (providerSet && !providerSet.has(m.creator)) return false;
    if (openOnly && !m.open) return false;
    if (!includeRetired && m.retired) return false;
    if (frontierOnly && frontierIds && !frontierIds.has(m.id)) return false;
    if (q && !`${m.name} ${m.creator}`.toLowerCase().includes(q)) return false;
    return true;
  });
}

/** Trace name of the always-on direct Contributor estimate points. */
export const CONTRIBUTOR_TRACE_NAME = 'Contributor (estimates)';

/** Trace name of the opt-in Go subscription estimate points. */
export const SUBSCRIPTION_TRACE_NAME = 'Subscription estimates (Go only)';

/**
 * Legacy alias: subscription estimates were formerly grouped under a generic
 * "Deals" trace. Kept so existing imports keep resolving to the subscription
 * trace; new code should use SUBSCRIPTION_TRACE_NAME / CONTRIBUTOR_TRACE_NAME.
 */
export const DEALS_TRACE_NAME = SUBSCRIPTION_TRACE_NAME;

/**
 * Contributor repricing ratio derived from the curated per-1M-token rates:
 * blend(contributor) / blend(standard) over the assumed cached:input:output
 * token mix. With the reviewed 7:2:1 mix this is .0414/.78 ≈ 0.0531.
 */
export const CONTRIBUTOR_COST_RATIO = (() => {
  const blend = (rates) =>
    (CONTRIBUTOR_BLEND.cached * rates.cached +
      CONTRIBUTOR_BLEND.input * rates.input +
      CONTRIBUTOR_BLEND.output * rates.output) /
    (CONTRIBUTOR_BLEND.cached + CONTRIBUTOR_BLEND.input + CONTRIBUTOR_BLEND.output);
  return blend(CONTRIBUTOR_RATES.contributor) / blend(CONTRIBUTOR_RATES.standard);
})();

function isPositiveFinite(x) {
  return Number.isFinite(x) && x > 0;
}

/**
 * Reprice a Standard measured per-task cost into a Muse Spark Contributor
 * estimate via the curated token-mix ratio. Returns null for invalid input.
 * This is an estimated token-mix repricing, not an AA measured cost.
 */
export function estimateContributorCost(standardCost) {
  if (!isPositiveFinite(standardCost)) return null;
  return standardCost * CONTRIBUTOR_COST_RATIO;
}

/**
 * Quota-equivalent effective cost per task under the $10/mo Go subscription:
 * `baseCost * subscription / (tierQuota * utilization)`.
 *
 * `utilization` is the fraction of the tier quota actually used (1 = full
 * use). Each estimate assumes the full subscription budget is spent on the
 * modeled tier — per-model quotas are not additive independent buckets.
 * Returns null for an unknown tier, non-positive base cost, or invalid
 * utilization. Utilization above 1 is clamped to 1 (over-use is meaningless).
 *
 * Flagged everywhere it is shown as a quota-equivalent estimate that assumes
 * benchmark cost meters at Go rates — never exact parity.
 */
export function estimateGoCost(baseCost, tierQuota, { subscription = GO_SUBSCRIPTION_USD, utilization = 1 } = {}) {
  if (!isPositiveFinite(baseCost)) return null;
  if (!GO_TIERS.includes(tierQuota)) return null;
  if (!Number.isFinite(subscription) || !(subscription > 0)) return null;
  if (!Number.isFinite(utilization) || !(utilization > 0)) return null;
  return (baseCost * subscription) / (tierQuota * Math.min(utilization, 1));
}

/** Short human label for a deal descriptor (table Terms column, legend). */
export function dealLabel(deal) {
  if (!deal || typeof deal !== 'object') return 'Measured';
  if (deal.kind === 'contributor') return 'Contributor est.';
  if (deal.kind === 'contributor-go') return `Contributor via Go $${deal.tier} (compounded est.)`;
  if (deal.kind === 'go') {
    return deal.promoActive
      ? `Go $${deal.tier} quota-equiv est. (promo)`
      : `Go $${deal.tier} quota-equiv est.`;
  }
  return 'Measured';
}

/**
 * Plain-text pricing/assumption note for a deal descriptor, used for the
 * table tooltip and hover text. Names the source, training/quota terms and
 * the parity assumption so estimates are never mistaken for measurements.
 */
export function dealAssumption(deal) {
  if (!deal || typeof deal !== 'object') {
    return 'Artificial Analysis measured cost per task.';
  }
  const inherited = 'Intelligence/speed inherited from the benchmark row, not provider-measured.';
  if (deal.kind === 'contributor') {
    return 'Estimated token-mix repricing (assumed 7:2:1 cached:input:output) of the AA measured cost ' +
      'at Meta Contributor rates ($0.002/$0.10/$0.20 perM vs Standard $0.15/$1.25/$4.25); ' +
      'not an AA measured cost. Contributor terms allow training use — see Meta pricing docs. ' + inherited;
  }
  const pct = Math.round(deal.utilization * 100);
  if (deal.kind === 'contributor-go') {
    return `Compounded estimate: Contributor repricing first, then the $10/mo Go quota formula ` +
      `over the $${deal.tier} tier at ${pct}% quota use. Quota-equivalent estimate; assumes benchmark ` +
      `cost at Go rates; full budget spent on this tier. ${inherited}`;
  }
  const promo = deal.promoActive
    ? ' Includes the limited-time 4x promo quota (ends 2026-09-28T00:00:00Z); base tier $15.'
    : '';
  return `$10/mo Go quota-equivalent estimate over the $${deal.tier} tier at ${pct}% quota use; ` +
    'assumes benchmark cost at Go rates (never exact parity); full budget spent on this tier.' +
    promo + ' ' + inherited;
}

/**
 * Parse the quota-utilization % control into a fraction in (0, 1].
 * Invalid, empty or non-positive input falls back to full use (1);
 * values are clamped to 1–100%.
 */
export function parseUtilizationPercent(value) {
  const text = typeof value === 'string' ? value.trim() : value;
  const n = text === '' ? NaN : Number(text);
  if (!Number.isFinite(n) || !(n > 0)) return 1;
  return Math.min(Math.max(n, 1), 100) / 100;
}

/**
 * Resolve the effective Go tier for a curated entry against a review clock
 * (`nowMs`, injectable for deterministic tests). Entries with a `promo`
 * use the promo tier while the promo is active and fall back to the base
 * tier afterwards (or when the clock is invalid — never assume a promo).
 * Returns `{ tier, promoActive }`.
 */
export function resolveGoTier(entry, nowMs = Date.now()) {
  if (!entry?.promo) return { tier: entry?.tier, promoActive: false };
  const expires = Date.parse(entry.promo.expiresAt);
  const active = Number.isFinite(nowMs) && Number.isFinite(expires) && nowMs < expires;
  return active
    ? { tier: entry.promo.tier, promoActive: true }
    : { tier: entry.promo.baseTier, promoActive: false };
}

/**
 * Pixel offset between the hovered dot/cursor and the custom hover card.
 * Plotly gl3d offers no public hover-card offset (`hoverlabel.align` only
 * changes text alignment, never card position; the centered `middle` anchor
 * covers the dot), so the chart renders its own HTML tooltip at this offset.
 */
export const HOVER_TOOLTIP_OFFSET = 14;

/**
 * Resolve the hover anchor in container-relative pixels. Prefers the public
 * Plotly point `bbox` center (actual dot), then `xPixel`/`yPixel`, else the
 * cursor fallback (hover fires at the cursor, so it stays near the dot).
 * Returns `{ x, y, source }` or null.
 */
export function resolveHoverAnchor(point, rect, fallback) {
  const w = rect?.width ?? 0;
  const h = rect?.height ?? 0;
  const left = rect?.left ?? 0;
  const top = rect?.top ?? 0;
  const inside = (x, y) =>
    Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 &&
    (w <= 0 || x <= w) && (h <= 0 || y <= h);
  const bb = point?.bbox;
  if (bb && [bb.x0, bb.x1, bb.y0, bb.y1].every(Number.isFinite)) {
    const sx = (bb.x0 + bb.x1) / 2 - left;
    const sy = (bb.y0 + bb.y1) / 2 - top;
    if (inside(sx, sy)) return { x: sx, y: sy, source: 'bbox' };
    const rx = (bb.x0 + bb.x1) / 2;
    const ry = (bb.y0 + bb.y1) / 2;
    if (inside(rx, ry)) return { x: rx, y: ry, source: 'bbox' };
  }
  if (Number.isFinite(point?.xPixel) && Number.isFinite(point?.yPixel) && inside(point.xPixel, point.yPixel)) {
    return { x: point.xPixel, y: point.yPixel, source: 'pixel' };
  }
  if (fallback && Number.isFinite(fallback.x) && Number.isFinite(fallback.y)) {
    return { x: fallback.x, y: fallback.y, source: 'cursor' };
  }
  return null;
}

/**
 * Position a custom hover card offset from the cursor so it never covers
 * the hovered dot. Defaults to below-right of the cursor (arrow at the
 * card's top-left pointing back to the dot); flips left/up when the card
 * would overflow the chart container, then clamps to the edges so the card
 * stays visible near viewport/chart edges. Pure and unit-testable: callers
 * pass cursor position relative to the container plus measured sizes.
 * Returns `{ left, top, placement }` with `placement` naming the card side
 * for the CSS pointer arrow (`bottom-right`, `bottom-left`, `top-right`,
 * `top-left`).
 */
export function computeHoverTooltipPosition({
  cursorX,
  cursorY,
  containerWidth,
  containerHeight,
  tooltipWidth = 0,
  tooltipHeight = 0,
  offset = HOVER_TOOLTIP_OFFSET,
} = {}) {
  const w = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 0;
  const h = Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 0;
  const tw = Number.isFinite(tooltipWidth) && tooltipWidth > 0 ? tooltipWidth : 0;
  const th = Number.isFinite(tooltipHeight) && tooltipHeight > 0 ? tooltipHeight : 0;
  const gap = Number.isFinite(offset) && offset >= 0 ? offset : HOVER_TOOLTIP_OFFSET;
  const cx = Number.isFinite(cursorX) ? cursorX : 0;
  const cy = Number.isFinite(cursorY) ? cursorY : 0;

  let left = cx + gap;
  let top = cy + gap;
  let flipX = false;
  let flipY = false;
  if (tw > 0 && left + tw > w) {
    left = cx - tw - gap;
    flipX = true;
  }
  if (th > 0 && top + th > h) {
    top = cy - th - gap;
    flipY = true;
  }
  const maxLeft = Math.max(0, w - tw);
  const maxTop = Math.max(0, h - th);
  left = Math.min(Math.max(0, left), maxLeft);
  top = Math.min(Math.max(0, top), maxTop);
  const placement = `${flipY ? 'top' : 'bottom'}-${flipX ? 'left' : 'right'}`;
  return { left, top, placement };
}

/**
 * Build derived deal-estimate points from measured snapshot models.
 *
 * Each entry of the curated config matches exactly one snapshot row by id
 * within the given era (eras never mix); intelligence and speed are inherited
 * unchanged from the benchmark row and must be read as benchmark values, not
 * provider measurements. The input array is never mutated; derived points are
 * fresh objects carrying a `deal` descriptor with the base cost, tier,
 * utilization and parity assumption. Entries with no matching era row, or
 * whose repriced cost is invalid, are skipped. Only notable tiers gain
 * points: direct Contributor repricings plus effective Go tiers at or above
 * `MIN_NOTABLE_GO_TIER` ($30/$60). The $15 tier never produces plotted,
 * table or domain points — a promo reverting to $15 disappears — while the
 * pure `estimateGoCost` formula still accepts $15 for general use.
 */
export function buildDealPoints(models, { era = null, utilization = 1, now = Date.now() } = {}) {
  const use = Number.isFinite(utilization) && utilization > 0 ? Math.min(utilization, 1) : NaN;
  if (Number.isNaN(use)) return [];
  const byId = new Map();
  for (const m of models ?? []) {
    if (era !== null && m.era !== era) continue;
    if (!(m.iq > 0 && m.cost > 0)) continue;
    if (!byId.has(m.id)) byId.set(m.id, m);
  }
  const points = [];
  for (const entry of DEAL_ENTRIES) {
    const base = byId.get(entry.snapshotId);
    if (!base) continue;
    let cost = null;
    let deal = null;
    if (entry.kind === 'contributor') {
      cost = estimateContributorCost(base.cost);
      if (cost === null) continue;
      deal = {
        kind: 'contributor',
        goId: entry.goId,
        baseCost: base.cost,
        utilization: use,
        parityNote: 'Estimated token-mix repricing of the AA measured cost; not an AA measured cost.',
      };
      points.push({
        ...base,
        id: `deal:${base.id}:contributor`,
        name: `${base.name} (Contributor est.)`,
        cost,
        deal,
      });
    } else if (entry.kind === 'go') {
      const { tier, promoActive } = resolveGoTier(entry, now);
      // Only notable tiers gain points; $15 (including an expired promo
      // reverting to its $15 base) disappears from plotted/table/domain sets.
      if (!(tier >= MIN_NOTABLE_GO_TIER)) continue;
      cost = estimateGoCost(base.cost, tier, { utilization: use });
      if (cost === null) continue;
      deal = {
        kind: 'go',
        goId: entry.goId,
        tier,
        baseCost: base.cost,
        utilization: use,
        promoActive,
        parityNote: 'Quota-equivalent estimate; assumes benchmark cost at Go rates.',
      };
      points.push({
        ...base,
        id: `deal:${base.id}:go${tier}${promoActive ? '-promo' : ''}`,
        name: `${base.name} (Go $${tier} quota-equiv est.${promoActive ? ', promo' : ''})`,
        cost,
        deal,
      });
    } else if (entry.kind === 'contributor-go') {
      if (!(entry.tier >= MIN_NOTABLE_GO_TIER)) continue;
      const contributorCost = estimateContributorCost(base.cost);
      if (contributorCost === null) continue;
      cost = estimateGoCost(contributorCost, entry.tier, { utilization: use });
      if (cost === null) continue;
      deal = {
        kind: 'contributor-go',
        goId: entry.goId,
        tier: entry.tier,
        baseCost: base.cost,
        contributorCost,
        utilization: use,
        parityNote: 'Compounded estimate: Contributor repricing, then Go quota formula; assumes benchmark cost at Go rates.',
      };
      points.push({
        ...base,
        id: `deal:${base.id}:contributor-go${entry.tier}`,
        name: `${base.name} (Contributor via Go $${entry.tier} est.)`,
        cost,
        deal,
      });
    }
    // Unknown kinds are ignored so a config typo can never inject a point.
  }
  return points;
}

/**
 * Direct Contributor repricings only (`kind: 'contributor'`). These use the
 * distinct Meta token tariff (not a subscription quota formula) and are
 * always shown alongside measured rows — never gated behind the subscription
 * toggle, never mutating the upstream measured rows.
 */
export function buildContributorPoints(models, opts = {}) {
  return buildDealPoints(models, opts).filter((p) => p.deal?.kind === 'contributor');
}

/**
 * Subscription estimates only (`kind: 'go'` plus compounded
 * `kind: 'contributor-go'`). Shown only when the subscription toggle is on;
 * the cost axis/domain already contains them while off so enabling the toggle
 * never rescales.
 */
export function buildSubscriptionPoints(models, opts = {}) {
  return buildDealPoints(models, opts).filter(
    (p) => p.deal && p.deal.kind !== 'contributor',
  );
}

/** Sorted provider list with per-provider model counts. */
export function providerSummary(models) {
  const counts = new Map();
  for (const m of models) counts.set(m.creator, (counts.get(m.creator) ?? 0) + 1);
  return [...counts.entries()]
    .map(([creator, count]) => ({ creator, count }))
    .sort((a, b) => b.count - a.count || a.creator.localeCompare(b.creator));
}

/**
 * Stable per-provider colors verified against Artificial Analysis
 * (per-model `creator.color`, cross-checked with the models legend; sources
 * reviewed 2026-09-24). Explicit map — never a rotating palette — so a
 * provider keeps its color as the set changes. Unknown future creators fall
 * back to neutral gray; brand fills are never altered for contrast (dark
 * dots stay readable via the light marker outline in the chart traces).
 */
export const PROVIDER_COLORS = {
  Alibaba: '#ff7018',
  Anthropic: '#cc785c',
  Apodex: '#0FD9D2',
  'Arcee AI': '#008c8d',
  Celeris: '#ff8a75',
  DeepSeek: '#2243e6',
  Google: '#34A853',
  IBM: '#0f62fe',
  Inception: '#021B30',
  InclusionAI: '#4fb5ff',
  Kimi: '#047AFE',
  LongCat: '#2adb65',
  Meta: '#0089f4',
  MiniMax: '#EB3568',
  Mistral: '#fd6f00',
  'Multiverse Computing': '#f11338',
  NVIDIA: '#76b900',
  OpenAI: '#1f1f1f',
  'Sapiens AI': '#1521a9',
  SpaceXAI: '#736cd3',
  StepFun: '#00F5E7',
  Tencent: '#5CB9FF',
  'Thinking Machines': '#676767',
  Upstage: '#7c59f5',
  Xiaomi: '#ff6900',
  'Z AI': '#1c7ff8',
};

/** Neutral gray for creators with no verified brand color yet. */
export const PROVIDER_FALLBACK_COLOR = '#888';

export function buildProviderColors(creators) {
  const map = new Map();
  for (const c of new Set(creators)) {
    map.set(c, PROVIDER_COLORS[c] ?? PROVIDER_FALLBACK_COLOR);
  }
  return map;
}

export function formatUsd(x) {
  if (x == null || Number.isNaN(x)) return 'n/a';
  if (x >= 1) return `$${x.toFixed(2)}`;
  if (x >= 0.01) return `$${x.toFixed(3)}`;
  return `$${x.toFixed(4)}`;
}

export function formatNum(x, digits = 1) {
  if (x == null || Number.isNaN(x)) return 'n/a';
  return Number(x).toFixed(digits);
}

/**
 * Resolve the snapshot URL against the deployed page URL so the app works
 * from any base path (domain root or a nested subpath such as a GitHub
 * project page). `new URL` with a relative base like './' throws, so callers
 * must pass an absolute base (e.g. `document.baseURI`).
 */
export function resolveDataUrl(base) {
  return new URL('data/models.json', base).href;
}

/** Trace name of the translucent preferred-corner highlight box. */
export const PREFERRED_CORNER_NAME = 'Preferred corner';

/**
 * Exclude the mesh from Plotly's depth-tested pick buffer without changing
 * its visible rendering. `hoverinfo: 'skip'` suppresses labels but still
 * occludes model picking. Plotly exposes no public pick-disable flag;
 * recheck these private hooks when upgrading plotly.js-gl3d-dist.
 */
export function makeTraceUnpickable(trace) {
  if (!trace || typeof trace !== 'object') return false;
  const mesh = trace.mesh;
  if (!mesh || typeof mesh.drawPick !== 'function' || typeof mesh.pick !== 'function') {
    return false;
  }
  try {
    mesh.drawPick = () => {};
    mesh.pick = () => null;
    mesh.pickSlots = 0;
    mesh.__preferredCornerUnpickable = true;
    trace.handlePick = () => false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the preferred-corner highlight from gl3d picking on a plotted
 * chart div (`gd._fullLayout.scene._scene.traces`, plus any extra
 * `sceneN` subplots). Safe to call when WebGL is unavailable or the box
 * is absent: returns how many box traces were patched (0 or more) and
 * never throws, so camera interactions are unaffected. Call after every
 * `Plotly.react` because traces are recreated when the box appears.
 */
export function disablePreferredBoxPick(chartDiv) {
  try {
    const fullLayout = chartDiv?._fullLayout;
    if (!fullLayout || typeof fullLayout !== 'object') return 0;
    let patched = 0;
    for (const key of Object.keys(fullLayout)) {
      const scene = fullLayout[key]?._scene;
      const traces = scene?.traces;
      if (!traces || typeof traces !== 'object') continue;
      for (const uid of Object.keys(traces)) {
        const trace = traces[uid];
        if (trace?.data?.name !== PREFERRED_CORNER_NAME) continue;
        if (makeTraceUnpickable(trace)) patched += 1;
      }
    }
    return patched;
  } catch {
    return 0;
  }
}
