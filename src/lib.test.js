import { describe, it, expect } from 'vitest';
import {
  paretoFrontier,
  preferredCornerBounds,
  filterModels,
  resolveDataUrl,
  makeTraceUnpickable,
  disablePreferredBoxPick,
  PROVIDER_COLORS,
  PROVIDER_FALLBACK_COLOR,
  buildProviderColors,
  CONTRIBUTOR_COST_RATIO,
  estimateContributorCost,
  estimateGoCost,
  resolveGoTier,
  buildDealPoints,
  buildContributorPoints,
  buildSubscriptionPoints,
  CONTRIBUTOR_TRACE_NAME,
  SUBSCRIPTION_TRACE_NAME,
  SUBSCRIPTION_TRACE_NAMES,
  GO_TRACE_NAME,
  CLAUDE_MAX_TRACE_NAME,
  CODEX_TRACE_NAME,
  CURSOR_ULTRA_TRACE_NAME,
  DEALS_TRACE_NAME,
  dealLabel,
  dealAssumption,
  parseUtilizationPercent,
  estimateSubscriptionCost,
  logAxisRange,
  eraDomainPoints,
  eraChartDomains,
  computeHoverTooltipPosition,
  resolveHoverAnchor,
  HOVER_TOOLTIP_OFFSET,
} from './lib.js';
import {
  DEAL_ENTRIES,
  GO_TIERS,
  CLAUDE_MAX_MULTIPLIER,
  CODEX_MULTIPLIER,
  CURSOR_ULTRA_MULTIPLIER,
  isClaudeMaxEligible,
  isCodexEligible,
  isGeminiCursorEligible,
  isCursorClaudeEligible,
  isCursorUltraEligible,
} from './deals.js';

function model(overrides = {}) {
  return {
    id: overrides.id ?? overrides.name ?? 'm',
    name: overrides.name ?? 'Model',
    creator: 'Acme',
    release: '2026-01-01',
    iq: 30,
    cost: 1,
    retired: false,
    open: true,
    era: 1,
    time_sec: 10,
    tps: 100,
    ttft: 0.5,
    ...overrides,
  };
}

describe('resolveDataUrl', () => {
  it('resolves under a nested deployment subpath', () => {
    expect(resolveDataUrl('https://user.github.io/llm-chart/')).toBe(
      'https://user.github.io/llm-chart/data/models.json',
    );
  });

  it('resolves relative to the containing page, not the page file', () => {
    expect(resolveDataUrl('https://user.github.io/llm-chart/index.html')).toBe(
      'https://user.github.io/llm-chart/data/models.json',
    );
  });

  it('resolves at the domain root', () => {
    expect(resolveDataUrl('https://example.com/')).toBe(
      'https://example.com/data/models.json',
    );
  });
});

describe('paretoFrontier', () => {
  it('drops a model that is worse on every axis', () => {
    const best = model({ id: 'best', iq: 50, cost: 0.5, time_sec: 5 });
    const worst = model({ id: 'worst', iq: 40, cost: 2, time_sec: 20 });

    const frontier = paretoFrontier([best, worst], 'time');

    expect(frontier.map((m) => m.id)).toEqual(['best']);
  });

  it('keeps both models when cost trades off against speed at equal intelligence', () => {
    const cheapSlow = model({ id: 'cheap-slow', iq: 40, cost: 0.1, time_sec: 60 });
    const priceyFast = model({ id: 'pricey-fast', iq: 40, cost: 1, time_sec: 6 });

    const frontier = paretoFrontier([cheapSlow, priceyFast], 'time');

    expect(frontier.map((m) => m.id).sort()).toEqual(['cheap-slow', 'pricey-fast']);
  });

  it('keeps exact ties on the frontier instead of dropping duplicates', () => {
    const a = model({ id: 'a', iq: 40, cost: 0.5, time_sec: 10 });
    const b = model({ id: 'b', iq: 40, cost: 0.5, time_sec: 10 });

    const frontier = paretoFrontier([a, b], 'time');

    expect(frontier.map((m) => m.id).sort()).toEqual(['a', 'b']);
  });

  it('treats lower time as better in time mode', () => {
    const fast = model({ id: 'fast', iq: 40, cost: 0.5, time_sec: 5, tps: 50 });
    const slow = model({ id: 'slow', iq: 40, cost: 0.5, time_sec: 50, tps: 200 });

    const frontier = paretoFrontier([fast, slow], 'time');

    expect(frontier.map((m) => m.id)).toEqual(['fast']);
  });

  it('treats higher throughput as better in throughput mode', () => {
    const fast = model({ id: 'fast', iq: 40, cost: 0.5, time_sec: 5, tps: 50 });
    const slow = model({ id: 'slow', iq: 40, cost: 0.5, time_sec: 50, tps: 200 });

    const frontier = paretoFrontier([fast, slow], 'throughput');

    expect(frontier.map((m) => m.id)).toEqual(['slow']);
  });

  it('excludes models missing the active speed metric from the frontier', () => {
    const withTime = model({ id: 'with-time', iq: 40, cost: 0.5, time_sec: 10 });
    const withoutTime = model({ id: 'without-time', iq: 99, cost: 0.01, time_sec: null });

    const frontier = paretoFrontier([withTime, withoutTime], 'time');

    expect(frontier.map((m) => m.id)).toEqual(['with-time']);
  });

  it('returns the frontier sorted by ascending intelligence', () => {
    const models = [
      model({ id: 'hi', iq: 60, cost: 5, time_sec: 5 }),
      model({ id: 'lo', iq: 20, cost: 0.05, time_sec: 60 }),
      model({ id: 'mid', iq: 40, cost: 0.5, time_sec: 20 }),
    ];

    const frontier = paretoFrontier(models, 'time');

    expect(frontier.map((m) => m.iq)).toEqual([20, 40, 60]);
  });
});

describe('preferredCornerBounds', () => {
  it('marks the low-cost, fast, smart octant with log midpoints on cost and speed', () => {
    const models = [
      model({ id: 'lo', cost: 1, time_sec: 4, iq: 20 }),
      model({ id: 'hi', cost: 4, time_sec: 16, iq: 60 }),
    ];

    const bounds = preferredCornerBounds(models, 'time');

    expect(bounds.x).toEqual([1, 2]);
    expect(bounds.y).toEqual([4, 8]);
    expect(bounds.z).toEqual([40, 60]);
  });

  it('flips the speed octant to the high side in throughput mode', () => {
    const models = [
      model({ id: 'slow', cost: 1, tps: 9, iq: 20 }),
      model({ id: 'fast', cost: 4, tps: 36, iq: 60 }),
    ];

    const bounds = preferredCornerBounds(models, 'throughput');

    expect(bounds.x).toEqual([1, 2]);
    expect(bounds.y).toEqual([18, 36]);
    expect(bounds.z).toEqual([40, 60]);
  });

  it('returns null when nothing is plottable', () => {
    expect(preferredCornerBounds([], 'time')).toBeNull();
  });

  it('returns null when any plotted axis collapses to a point', () => {
    const solo = [model({ id: 'solo' })];

    expect(preferredCornerBounds(solo, 'time')).toBeNull();

    const sameCost = [
      model({ id: 'a', cost: 0.5, time_sec: 5, iq: 40 }),
      model({ id: 'b', cost: 0.5, time_sec: 10, iq: 50 }),
    ];

    expect(preferredCornerBounds(sameCost, 'time')).toBeNull();
  });

  it('extends the box top to the era ceiling instead of the plotted max', () => {
    // Filtering can hide the smartest era model; the layout ceiling stays at
    // the era max, so the box must reach it too instead of stopping below it.
    const plotted = [
      model({ id: 'lo', cost: 1, time_sec: 4, iq: 20 }),
      model({ id: 'mid', cost: 4, time_sec: 16, iq: 40 }),
    ];

    const bounds = preferredCornerBounds(plotted, 'time', 50);

    expect(bounds.z).toEqual([30, 50]);
  });

  it('ignores a non-finite ceiling and falls back to the plotted max', () => {
    const models = [
      model({ id: 'lo', cost: 1, time_sec: 4, iq: 20 }),
      model({ id: 'hi', cost: 4, time_sec: 16, iq: 60 }),
    ];

    expect(preferredCornerBounds(models, 'time', undefined).z).toEqual([40, 60]);
    expect(preferredCornerBounds(models, 'time', NaN).z).toEqual([40, 60]);
  });
});

describe('filterModels', () => {
  const era0 = model({ id: 'old', era: 0, name: 'Old Model' });
  const era1 = model({ id: 'new', era: 1, name: 'New Model' });

  it('never mixes eras: only the selected era passes', () => {
    expect(filterModels([era0, era1], { era: 1 }).map((m) => m.id)).toEqual(['new']);
    expect(filterModels([era0, era1], { era: 0 }).map((m) => m.id)).toEqual(['old']);
  });

  it('excludes models missing time in time mode but keeps them in throughput mode', () => {
    const noTime = model({ id: 'no-time', time_sec: null, tps: 120 });

    expect(filterModels([noTime], { speedMode: 'time' })).toEqual([]);
    expect(filterModels([noTime], { speedMode: 'throughput' }).map((m) => m.id)).toEqual([
      'no-time',
    ]);
  });

  it('excludes models missing throughput in throughput mode but keeps them in time mode', () => {
    const noTps = model({ id: 'no-tps', time_sec: 12, tps: null });

    expect(filterModels([noTps], { speedMode: 'throughput' })).toEqual([]);
    expect(filterModels([noTps], { speedMode: 'time' }).map((m) => m.id)).toEqual(['no-tps']);
  });

  it('table mode keeps rows missing the speed metric (archive eras predate it)', () => {
    const noTime = model({ id: 'no-time', time_sec: null, tps: 120 });

    expect(
      filterModels([noTime], { speedMode: 'time', requireSpeed: false }).map((m) => m.id),
    ).toEqual(['no-time']);
  });

  it('matches the search query against model name and provider', () => {
    const models = [
      model({ id: 'a', name: 'Claude Opus', creator: 'Anthropic' }),
      model({ id: 'b', name: 'GPT-6 Sol', creator: 'OpenAI' }),
    ];

    expect(filterModels(models, { query: 'opus' }).map((m) => m.id)).toEqual(['a']);
    expect(filterModels(models, { query: 'OPENAI' }).map((m) => m.id)).toEqual(['b']);
  });

  it('applies open-weights, retired and provider filters together', () => {
    const models = [
      model({ id: 'open-live', open: true, retired: false, creator: 'Acme' }),
      model({ id: 'closed-live', open: false, retired: false, creator: 'Acme' }),
      model({ id: 'open-retired', open: true, retired: true, creator: 'Other' }),
    ];

    const shown = filterModels(models, {
      openOnly: true,
      includeRetired: false,
      providers: new Set(['Acme', 'Other']),
    });

    expect(shown.map((m) => m.id)).toEqual(['open-live']);
  });

  it('frontier-only mode keeps just the given frontier ids', () => {
    const models = [model({ id: 'a' }), model({ id: 'b' })];

    const shown = filterModels(models, {
      frontierOnly: true,
      frontierIds: new Set(['b']),
    });

    expect(shown.map((m) => m.id)).toEqual(['b']);
  });
});

describe('preferred corner picking', () => {
  function fakeBoxTrace() {
    const mesh = {
      pickId: 7,
      pickSlots: 1,
      drawCalls: 0,
      draw() {},
      drawPick() {
        this.drawCalls += 1;
      },
      pick(result) {
        if (!result || result.id !== this.pickId) return null;
        return { index: 0, dataCoordinate: [1, 2, 3] };
      },
    };
    return {
      data: { name: 'Preferred corner', type: 'mesh3d', hoverinfo: 'skip' },
      mesh,
      handlePick(selection) {
        return selection?.object === this.mesh;
      },
    };
  }

  function fakeScatterTrace() {
    const scatterPlot = {
      highlightCalls: 0,
      highlight() {
        this.highlightCalls += 1;
      },
    };
    return {
      data: { name: 'Models', type: 'scatter3d', hoverinfo: 'text' },
      scatterPlot,
      handlePick(selection) {
        return selection?.object === this.scatterPlot;
      },
    };
  }

  it('makes the highlight box unpickable while scatter points stay hoverable', () => {
    const box = fakeBoxTrace();
    const scatter = fakeScatterTrace();

    // Cursor over a model dot seen through the box volume: the shared
    // gl-plot3d pick buffer reports the frontmost surface (the box), so the
    // scatter handler never matches and the dot loses its hover.
    const occluded = { object: box.mesh, data: { index: 0 } };

    expect(scatter.handlePick(occluded)).toBe(false);
    expect(box.handlePick(occluded)).toBe(true);

    const patched = makeTraceUnpickable(box);

    expect(patched).toBe(true);
    // Not rendered into the pick buffer anymore, so the dot behind shows
    // through; never claims a pick even if handed one.
    box.mesh.drawPick();
    expect(box.mesh.drawCalls).toBe(0);
    expect(box.mesh.pick({ id: 7, value: [0, 0, 0] })).toBeNull();
    expect(box.handlePick({ object: box.mesh })).toBe(false);
    // Model hover still resolves: the scatter object matches its own picks.
    expect(scatter.handlePick({ object: scatter.scatterPlot })).toBe(true);
  });

  it('patches only the preferred-corner mesh and leaves camera and scatter alone', () => {
    const box = fakeBoxTrace();
    const scatter = fakeScatterTrace();
    const camera = { eye: { x: 1.7, y: -1.5, z: 0.9 } };
    const scene = { traces: { uidBox: box, uidScatter: scatter }, camera };
    const chartDiv = { _fullLayout: { scene: { _scene: scene } } };
    const scatterPick = scatter.handlePick;
    const scatterMeshRef = scatter.scatterPlot;

    const count = disablePreferredBoxPick(chartDiv);

    expect(count).toBe(1);
    expect(box.mesh.pickSlots).toBe(0);
    expect(typeof box.mesh.draw).toBe('function');
    expect(scene.camera).toBe(camera);
    expect(scatter.scatterPlot).toBe(scatterMeshRef);
    expect(scatter.handlePick).toBe(scatterPick);
  });

  it('ignores charts without a gl scene instead of throwing', () => {
    expect(disablePreferredBoxPick({})).toBe(0);
    expect(disablePreferredBoxPick(null)).toBe(0);
  });
});

describe('provider colors', () => {
  it('uses the verified Artificial Analysis brand fills exactly', () => {
    expect(PROVIDER_COLORS.OpenAI).toBe('#1f1f1f');
    expect(PROVIDER_COLORS.Meta).toBe('#0089f4');
    expect(PROVIDER_COLORS.Google).toBe('#34A853');
    expect(PROVIDER_COLORS.Anthropic).toBe('#cc785c');
    expect(PROVIDER_COLORS.DeepSeek).toBe('#2243e6');
    expect(PROVIDER_COLORS.Alibaba).toBe('#ff7018');
    expect(PROVIDER_COLORS.Inception).toBe('#021B30');
    expect(PROVIDER_COLORS.NVIDIA).toBe('#76b900');
    expect(PROVIDER_COLORS.Mistral).toBe('#fd6f00');
    expect(PROVIDER_COLORS['Z AI']).toBe('#1c7ff8');
    expect(Object.keys(PROVIDER_COLORS)).toHaveLength(26);
  });

  it('keeps a creator color stable as the provider set changes', () => {
    const few = buildProviderColors(['Meta', 'OpenAI']);
    const many = buildProviderColors(['Alibaba', 'Meta', 'OpenAI', 'Z AI', 'Google']);

    expect(few.get('Meta')).toBe('#0089f4');
    expect(many.get('Meta')).toBe(few.get('Meta'));
    expect(many.get('OpenAI')).toBe('#1f1f1f');
  });

  it('falls back to neutral gray for unknown future creators', () => {
    expect(buildProviderColors(['Brand New Lab']).get('Brand New Lab')).toBe(
      PROVIDER_FALLBACK_COLOR,
    );
    expect(PROVIDER_FALLBACK_COLOR).toMatch(/^#[0-9a-f]{3}([0-9a-f]{3})?$/i);
  });
});

describe('deal cost math', () => {
  it('reprices Standard cost at the 7:2:1 contributor blend ratio (.0414/.78)', () => {
    expect(CONTRIBUTOR_COST_RATIO).toBeCloseTo(0.0414 / 0.78, 10);
    // Muse Spark 1.3 (xhigh) measured $1.367794/task reprices to ~$0.0726.
    expect(estimateContributorCost(1.367794)).toBeCloseTo(1.367794 * 0.0414 / 0.78, 10);
  });

  it('rejects non-positive or non-finite standard costs', () => {
    expect(estimateContributorCost(0)).toBeNull();
    expect(estimateContributorCost(-1)).toBeNull();
    expect(estimateContributorCost(NaN)).toBeNull();
    expect(estimateContributorCost(null)).toBeNull();
  });

  it('scales base cost by subscription over tier quota at full utilization', () => {
    // $10/mo over a $60 tier: one sixth of the metered cost.
    expect(estimateGoCost(0.6, 60)).toBeCloseTo(0.1, 10);
    expect(estimateGoCost(0.6, 30)).toBeCloseTo(0.2, 10);
    expect(estimateGoCost(0.6, 15)).toBeCloseTo(0.4, 10);
  });

  it('raises the effective cost when only part of the quota is used', () => {
    expect(estimateGoCost(0.6, 60, { utilization: 0.5 })).toBeCloseTo(0.2, 10);
  });

  it('rejects unknown tiers and invalid base cost, subscription or utilization', () => {
    expect(estimateGoCost(0.6, 45)).toBeNull();
    expect(estimateGoCost(0, 60)).toBeNull();
    expect(estimateGoCost(-0.5, 60)).toBeNull();
    expect(estimateGoCost(0.6, 60, { utilization: 0 })).toBeNull();
    expect(estimateGoCost(0.6, 60, { utilization: -0.5 })).toBeNull();
    expect(estimateGoCost(0.6, 60, { utilization: NaN })).toBeNull();
    expect(estimateGoCost(0.6, 60, { subscription: 0 })).toBeNull();
  });

  it('only offers the documented Go tier quotas', () => {
    expect([...GO_TIERS].sort((a, b) => a - b)).toEqual([15, 30, 60]);
  });
});

describe('buildDealPoints', () => {
  function measured(overrides = {}) {
    return {
      id: 'glm-5-3-flash',
      name: 'GLM 5.3 Flash',
      creator: 'Z AI',
      release: '2026-09-01',
      iq: 41.8,
      cost: 0.25326,
      retired: false,
      open: false,
      era: 1,
      time_sec: 992.84,
      tps: 50.9,
      ttft: 0.4,
      ...overrides,
    };
  }

  function muse13xhigh(overrides = {}) {
    return measured({
      id: 'muse-spark-1-3-xhigh',
      name: 'Muse Spark 1.3 (xhigh)',
      creator: 'Meta',
      iq: 45.1,
      cost: 1.367794,
      time_sec: 227.56,
      tps: 237.4,
      ...overrides,
    });
  }

  it('derives a quota-equivalent Go point that inherits benchmark iq and speed', () => {
    const [point] = buildDealPoints([measured()], { era: 1 });

    expect(point.id).toBe('deal:glm-5-3-flash:go60');
    expect(point.name).toContain('Go $60');
    expect(point.cost).toBeCloseTo(0.25326 / 6, 10);
    expect(point.iq).toBe(41.8);
    expect(point.time_sec).toBe(992.84);
    expect(point.tps).toBe(50.9);
    expect(point.creator).toBe('Z AI');
    expect(point.era).toBe(1);
    expect(point.deal).toMatchObject({ kind: 'go', tier: 60, baseCost: 0.25326 });
  });

  it('derives both Contributor and compounded Contributor-Go points for Muse Spark 1.3 xhigh', () => {
    const points = buildDealPoints([muse13xhigh()], { era: 1 });
    const kinds = points.map((p) => p.deal.kind).sort();

    expect(kinds).toEqual(['contributor', 'contributor-go']);
    const direct = points.find((p) => p.deal.kind === 'contributor');
    const viaGo = points.find((p) => p.deal.kind === 'contributor-go');
    expect(direct.cost).toBeCloseTo(1.367794 * 0.0414 / 0.78, 10);
    expect(viaGo.cost).toBeCloseTo(direct.cost / 6, 10);
    expect(viaGo.deal).toMatchObject({ tier: 60, contributorCost: direct.cost });
  });

  it('never derives a Contributor point for the unsupported Muse Spark 1.3 max row', () => {
    const max = muse13xhigh({ id: 'muse-spark-1-3-max', name: 'Muse Spark 1.3 (max)' });

    expect(buildDealPoints([max], { era: 1 })).toEqual([]);
  });

  it('maps each notable tier quota from the curated config without fuzzy matching', () => {
    const models = [
      measured({ id: 'qwen3-7-max', cost: 1.147296 }),
      measured({ id: 'glm-5-3-flash', cost: 0.25326 }),
    ];

    const tiers = Object.fromEntries(
      buildDealPoints(models, { era: 1 }).map((p) => [p.deal.goId, p.deal.tier]),
    );

    expect(tiers['qwen3.7-max']).toBe(30);
    expect(tiers['glm-5.3-flash']).toBe(60);
    // $15 tier omitted as not notable: no point even for exact id matches.
    expect(buildDealPoints([measured({ id: 'qwen3-8-max', cost: 2.669985 })], { era: 1 })).toEqual([]);
  });

  it('matches the selected era only and never mixes eras', () => {
    expect(buildDealPoints([measured({ era: 0 })], { era: 1 })).toEqual([]);
    expect(buildDealPoints([measured({ era: 0 })], { era: 0 })).toHaveLength(1);
  });

  it('applies the quota-utilization fraction to Go estimates', () => {
    const [half] = buildDealPoints([measured()], { era: 1, utilization: 0.5 });
    const [full] = buildDealPoints([measured()], { era: 1, utilization: 1 });

    expect(half.cost).toBeCloseTo(full.cost * 2, 10);
    expect(half.deal.utilization).toBe(0.5);
  });

  it('returns no points for invalid utilization instead of inventing costs', () => {
    expect(buildDealPoints([measured()], { era: 1, utilization: 0 })).toEqual([]);
    expect(buildDealPoints([measured()], { era: 1, utilization: NaN })).toEqual([]);
  });

  it('skips config entries with no matching snapshot row', () => {
    // None of the curated ids are present: no fabricated points.
    expect(buildDealPoints([measured({ id: 'unrelated-model' })], { era: 1 })).toEqual([]);
  });

  it('does not mutate the measured snapshot rows', () => {
    const rows = Object.freeze([Object.freeze(measured()), Object.freeze(muse13xhigh())]);
    const before = JSON.stringify(rows);

    const points = buildDealPoints(rows, { era: 1 });

    expect(JSON.stringify(rows)).toBe(before);
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => !Object.isFrozen(p))).toBe(true);
  });

  it('labels deal kinds for the table and flags assumptions honestly', () => {
    expect(dealLabel(undefined)).toBe('Measured');
    expect(dealLabel({ kind: 'contributor' })).toBe('Contributor est.');
    expect(dealLabel({ kind: 'go', tier: 30 })).toBe('Go $30 quota-equiv est.');
    expect(dealLabel({ kind: 'contributor-go', tier: 60 })).toContain('compounded');

    expect(dealAssumption(undefined)).toMatch(/measured/i);
    expect(dealAssumption({ kind: 'contributor', utilization: 1 })).toMatch(
      /not an AA measured cost.*inherited from the benchmark/i,
    );
    expect(dealAssumption({ kind: 'go', tier: 60, utilization: 1 })).toMatch(
      /assumes benchmark cost at Go rates.*full budget/i,
    );
    expect(dealAssumption({ kind: 'contributor-go', tier: 60, utilization: 1 })).toMatch(
      /compounded/i,
    );
  });
  it('keeps every curated entry on a notable tier with a snapshot id', () => {
    for (const entry of DEAL_ENTRIES) {
      expect(typeof entry.snapshotId).toBe('string');
      if (entry.kind === 'contributor') {
        expect(entry.tier).toBeUndefined();
      } else if (entry.promo) {
        expect(entry.promo.tier).toBe(60);
        expect(entry.promo.baseTier).toBe(15);
        expect(Date.parse(entry.promo.expiresAt)).toBe(
          Date.parse('2026-09-28T00:00:00Z'),
        );
      } else {
        expect(GO_TIERS).toContain(entry.tier);
        // Direct $15 mappings are omitted as not notable; only $30/$60 remain.
        expect(entry.tier).toBeGreaterThanOrEqual(30);
        if (entry.kind === 'contributor-go') expect(entry.tier).toBe(60);
      }
    }
    // No direct $15 tier entries remain (promo baseTier 15 excepted).
    expect(DEAL_ENTRIES.some((e) => !e.promo && e.tier === 15)).toBe(false);
    // The priority Contributor rows must exist; max must never be mapped.
    expect(DEAL_ENTRIES.filter((e) => e.snapshotId === 'muse-spark-1-3-xhigh').map((e) => e.kind).sort())
      .toEqual(['contributor', 'contributor-go']);
    expect(DEAL_ENTRIES.some((e) => e.snapshotId === 'muse-spark-1-3-max')).toBe(false);
  });

  it('uses the promo tier while active and disappears after expiry (no $15 fallback)', () => {
    const v41 = {
      id: 'deepseek-v4-1-flash-reasoning-max-effort',
      name: 'DeepSeek V4.1 Flash (Reasoning, Max Effort)',
      creator: 'DeepSeek',
      release: '2026-09-01',
      iq: 39.5,
      cost: 0.265225,
      retired: false,
      open: true,
      era: 1,
      time_sec: 282.36,
      tps: 232.3,
      ttft: 0.5,
    };
    const before = Date.parse('2026-09-24T00:00:00Z');
    const after = Date.parse('2026-09-28T00:00:00Z');

    const [promoPoint] = buildDealPoints([v41], { era: 1, now: before });
    expect(promoPoint.deal.tier).toBe(60);
    expect(promoPoint.deal.promoActive).toBe(true);
    expect(promoPoint.cost).toBeCloseTo(0.265225 * 10 / 60, 10);
    expect(dealLabel(promoPoint.deal)).toContain('(promo)');
    expect(dealAssumption(promoPoint.deal)).toContain('2026-09-28');

    // Expired promo reverts to the $15 base tier, which is not notable:
    // the point disappears instead of falling back.
    expect(buildDealPoints([v41], { era: 1, now: after })).toEqual([]);

    // An invalid clock never assumes the promo (and also disappears).
    expect(buildDealPoints([v41], { era: 1, now: NaN })).toEqual([]);
  });

  it('omits uncertain aliases, unverified dated versions and the $15 tier', () => {
    const rows = [
      model({ id: 'qwen3-8-flash-next' }),
      model({ id: 'deepseek-v4-flash-0731-reasoning-max-effort' }),
      model({ id: 'deepseek-v4-flash-0420-reasoning-max-effort' }),
      model({ id: 'deepseek-v4-pro-0813-reasoning-max-effort' }),
      model({ id: 'qwen3-8-max-0902' }),
    ];

    expect(buildDealPoints(rows, { era: 1 })).toEqual([]);
    // The unversioned Qwen Max row is exact but its $15 tier is not notable.
    expect(buildDealPoints([model({ id: 'qwen3-8-max' })], { era: 1 })).toEqual([]);
  });
  it('flows through the same filters and frontier as measured points', () => {
    const rows = [
      model({ id: 'glm-5-3-flash', creator: 'Z AI', era: 1, iq: 41.8, cost: 0.25326, time_sec: 992.84 }),
      model({ id: 'muse-spark-1-3-xhigh', creator: 'Meta', era: 1, iq: 45.1, cost: 1.367794, time_sec: 227.56 }),
    ];
    const combined = rows.concat(buildDealPoints(rows, { era: 1 }));

    const filtered = filterModels(combined, { era: 1, speedMode: 'time' });
    expect(filtered.length).toBe(combined.length);

    const byProvider = filterModels(combined, {
      era: 1, speedMode: 'time', providers: new Set(['Meta']),
    });
    expect(byProvider.every((m) => m.creator === 'Meta')).toBe(true);
    expect(byProvider.some((m) => m.deal)).toBe(true);

    const frontier = paretoFrontier(filtered, 'time');
    expect(frontier.length).toBeGreaterThan(0);
  });

  it('omits $15 tier Go estimates: only effective $30/$60 produce deal points', () => {
    // $15 tier rows must not gain estimate points: the tier is not notable.
    const cheap15 = [
      model({ id: 'qwen3-8-max', cost: 2.669985 }),
      model({ id: 'kimi-k3-low', cost: 0.5 }),
      model({ id: 'grok-4-7-high', cost: 1.0 }),
    ];

    expect(buildDealPoints(cheap15, { era: 1 })).toEqual([]);

    // Effective $30/$60 tiers still produce points.
    const notable = [
      model({ id: 'qwen3-7-max', cost: 1.147296 }),
      model({ id: 'glm-5-3-flash', cost: 0.25326 }),
    ];
    const points = buildDealPoints(notable, { era: 1 });
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.deal.tier >= 30)).toBe(true);
  });

  it('promo reverting to $15 after expiry disappears instead of falling back to a point', () => {
    const v41 = {
      id: 'deepseek-v4-1-flash-reasoning-max-effort',
      name: 'DeepSeek V4.1 Flash (Reasoning, Max Effort)',
      creator: 'DeepSeek',
      release: '2026-09-01',
      iq: 39.5,
      cost: 0.265225,
      retired: false,
      open: true,
      era: 1,
      time_sec: 282.36,
      tps: 232.3,
      ttft: 0.5,
    };
    const before = Date.parse('2026-09-24T00:00:00Z');
    const after = Date.parse('2026-09-28T00:00:00Z');

    // Active promo ($60) still produces a labeled point.
    const [promoPoint] = buildDealPoints([v41], { era: 1, now: before });
    expect(promoPoint.deal.tier).toBe(60);
    expect(promoPoint.deal.promoActive).toBe(true);

    // Expired promo reverts to the $15 base tier, which is not notable:
    // no estimate point remains.
    expect(buildDealPoints([v41], { era: 1, now: after })).toEqual([]);
    expect(buildDealPoints([v41], { era: 1, now: NaN })).toEqual([]);
  });

  it('excludes $15 estimates from era domain points and chart domains', () => {
    const rows = [model({ id: 'qwen3-8-max', era: 1, cost: 2.669985, time_sec: 10, iq: 40 })];

    const points = eraDomainPoints(rows, { era: 1, utilization: 1 });
    expect(points.map((p) => p.id)).toEqual(['qwen3-8-max']);
    expect(points.some((p) => p.deal)).toBe(false);

    const domains = eraChartDomains(rows, { era: 1, speedMode: 'time', utilization: 1 });
    expect(domains.xBounds).toEqual([2.669985, 2.669985]);

    // Expired promo leaves no domain trace either.
    const v41 = {
      id: 'deepseek-v4-1-flash-reasoning-max-effort',
      name: 'DeepSeek V4.1 Flash',
      creator: 'DeepSeek',
      release: '2026-09-01',
      iq: 39.5,
      cost: 0.265225,
      retired: false,
      open: true,
      era: 1,
      time_sec: 282.36,
      tps: 232.3,
      ttft: 0.5,
    };
    const after = Date.parse('2026-09-28T00:00:00Z');
    expect(eraDomainPoints([v41], { era: 1, now: after }).some((p) => p.deal)).toBe(false);
  });

  it('pure Go formula still supports $15 math even though deal points skip it', () => {
    expect(estimateGoCost(0.6, 15)).toBeCloseTo(0.4, 10);
  });
});

describe('parseUtilizationPercent', () => {
  it('parses the quota-use control into a fraction defaulting to full use', () => {
    expect(parseUtilizationPercent('100')).toBe(1);
    expect(parseUtilizationPercent('50')).toBe(0.5);
    expect(parseUtilizationPercent(25)).toBe(0.25);
    expect(parseUtilizationPercent('')).toBe(1);
    expect(parseUtilizationPercent('0')).toBe(1);
    expect(parseUtilizationPercent('-5')).toBe(1);
    expect(parseUtilizationPercent('nonsense')).toBe(1);
    expect(parseUtilizationPercent('200')).toBe(1);
  });
});

describe('logAxisRange', () => {
  it('returns Plotly log10 ranges with endpoint padding containing the data', () => {
    const range = logAxisRange(1, 100);

    // Plotly log axes use log10 units: 1 -> 0, 100 -> 2.
    expect(range[0]).toBeLessThan(Math.log10(1));
    expect(range[1]).toBeGreaterThan(Math.log10(100));
    expect(range[0]).toBeGreaterThan(-0.5);
    expect(range[1]).toBeLessThan(2.5);
  });

  it('expands a singleton cost into a plottable span centered on the point', () => {
    const value = 5;
    const range = logAxisRange(value, value);
    const center = Math.log10(value);

    expect(range[0]).toBeLessThan(center);
    expect(range[1]).toBeGreaterThan(center);
    expect(range[1] - range[0]).toBeGreaterThan(0.3);
    expect((range[0] + range[1]) / 2).toBeCloseTo(center, 5);
  });

  it('returns undefined for missing or non-positive extents', () => {
    expect(logAxisRange(null, 10)).toBeUndefined();
    expect(logAxisRange(0, 10)).toBeUndefined();
    expect(logAxisRange(1, null)).toBeUndefined();
    expect(logAxisRange(NaN, 10)).toBeUndefined();
  });
});

describe('era chart domains keep the grid static', () => {
  function measuredDealBase(overrides = {}) {
    return {
      id: 'glm-5-3-flash',
      name: 'GLM 5.3 Flash',
      creator: 'Z AI',
      release: '2026-09-01',
      iq: 41.8,
      cost: 0.25326,
      retired: false,
      open: false,
      era: 1,
      time_sec: 992.84,
      tps: 50.9,
      ttft: 0.4,
      ...overrides,
    };
  }

  it('contains all era costs with log10 ranges, including retired rows', () => {
    const models = [
      model({ id: 'a', era: 1, cost: 0.5, time_sec: 10, iq: 40, retired: false }),
      model({ id: 'b', era: 1, cost: 2, time_sec: 5, iq: 50, retired: false }),
      // Retired extreme: cheaper than any live model, must still widen the domain.
      model({ id: 'old-cheap', era: 1, cost: 0.05, time_sec: 8, iq: 30, retired: true }),
    ];

    const domains = eraChartDomains(models, { era: 1, speedMode: 'time', utilization: 1 });

    expect(domains.xBounds[0]).toBeCloseTo(0.05, 10);
    expect(domains.xRange[0]).toBeLessThan(Math.log10(0.05));
    expect(domains.xRange[1]).toBeGreaterThan(Math.log10(2));
    expect(domains.zMax).toBe(50);
  });

  it('includes Contributor and eligible Go estimates in the domain even when the subscription toggle is off', () => {
    const rows = [
      measuredDealBase(),
      {
        id: 'muse-spark-1-3-xhigh',
        name: 'Muse Spark 1.3 (xhigh)',
        creator: 'Meta',
        release: '2026-08-01',
        iq: 45.1,
        cost: 1.367794,
        retired: false,
        open: false,
        era: 1,
        time_sec: 227.56,
        tps: 237.4,
        ttft: 0.5,
      },
    ];

    const domains = eraChartDomains(rows, { era: 1, speedMode: 'time', utilization: 1 });
    const deals = buildDealPoints(rows, { era: 1, utilization: 1 });
    const cheapestDeal = Math.min(...deals.map((d) => d.cost));

    // The Contributor repricing (~$0.07) is cheaper than any measured cost
    // and must widen the cost domain even though the subscription toggle is off.
    expect(deals.length).toBeGreaterThan(0);
    expect(cheapestDeal).toBeLessThan(0.25326);
    expect(domains.xBounds[0]).toBeCloseTo(cheapestDeal, 10);
    expect(domains.xRange[0]).toBeLessThan(Math.log10(cheapestDeal));
  });

  it('updates the domain when active utilization changes deal economics', () => {
    const rows = [measuredDealBase()];

    const full = eraChartDomains(rows, { era: 1, speedMode: 'time', utilization: 1 });
    const half = eraChartDomains(rows, { era: 1, speedMode: 'time', utilization: 0.5 });

    // Halving quota use doubles the Go effective cost, so the domain minimum moves.
    expect(half.xBounds[0]).toBeCloseTo(full.xBounds[0] * 2, 10);
  });

  it('scopes domains to the selected era and never mixes eras', () => {
    const models = [
      model({ id: 'era0-cheap', era: 0, cost: 0.001, time_sec: 1, iq: 10 }),
      model({ id: 'era1-a', era: 1, cost: 0.5, time_sec: 10, iq: 40 }),
      model({ id: 'era1-b', era: 1, cost: 2, time_sec: 5, iq: 50 }),
    ];

    const current = eraChartDomains(models, { era: 1, speedMode: 'time', utilization: 1 });

    expect(current.xBounds).toEqual([0.5, 2]);
    expect(current.zMax).toBe(50);
  });

  it('derives the speed range from plottable points only and reports empty speed as undefined', () => {
    const models = [
      model({ id: 'no-speed', era: 1, cost: 0.5, time_sec: null, tps: null, iq: 40 }),
      model({ id: 'with-speed', era: 1, cost: 2, time_sec: 5, iq: 50 }),
    ];

    const domains = eraChartDomains(models, { era: 1, speedMode: 'time', utilization: 1 });

    // Cost still spans both rows, but speed only spans the plottable row.
    // A singleton speed still expands into a plottable log span.
    expect(domains.xBounds).toEqual([0.5, 2]);
    expect(domains.yBounds[0]).toBeCloseTo(5, 10);
    expect(domains.yBounds[1]).toBeCloseTo(5, 10);
    expect(domains.yRange[0]).toBeLessThan(Math.log10(5));
    expect(domains.yRange[1]).toBeGreaterThan(Math.log10(5));

    const nonePlottable = eraChartDomains(
      [model({ id: 'archive', era: 0, cost: 0.3, time_sec: null, tps: null, iq: 35 })],
      { era: 0, speedMode: 'time', utilization: 1 },
    );

    expect(nonePlottable.yRange).toBeUndefined();
    expect(nonePlottable.yBounds).toBeUndefined();
    expect(nonePlottable.xBounds).toEqual([0.3, 0.3]);
    expect(nonePlottable.zMax).toBe(35);
  });

  it('exposes the full era point set for a static preferred-corner box', () => {
    const models = [
      model({ id: 'a', era: 1, cost: 0.5, time_sec: 10, iq: 40 }),
      model({ id: 'b', era: 1, cost: 2, time_sec: 5, iq: 50 }),
    ];

    const points = eraDomainPoints(models, { era: 1, utilization: 1 });
    const domains = eraChartDomains(models, { era: 1, speedMode: 'time', utilization: 1 });
    const box = preferredCornerBounds(points, 'time', domains.zMax);

    expect(box.x).toEqual([0.5, 1]);
    expect(box.z[1]).toBe(50);
  });

  it('tops intelligence at the highest era score', () => {
    const models = [
      model({ id: 'a', era: 1, cost: 0.5, time_sec: 10, iq: 40, retired: true }),
      model({ id: 'b', era: 1, cost: 2, time_sec: 5, iq: 50, retired: false }),
    ];

    expect(eraChartDomains(models, { era: 1, speedMode: 'time' }).zMax).toBe(50);
    expect(
      eraChartDomains(
        [model({ id: 'noint', era: 1, cost: 0.5, time_sec: 10, iq: null })],
        { era: 1, speedMode: 'time' },
      ).zMax,
    ).toBeUndefined();
  });
});

describe('hover tooltip stays off the dot', () => {
  it('offsets below-right of the cursor by default instead of centering on the dot', () => {
    const pos = computeHoverTooltipPosition({
      cursorX: 100,
      cursorY: 100,
      containerWidth: 600,
      containerHeight: 400,
      tooltipWidth: 200,
      tooltipHeight: 120,
    });

    expect(HOVER_TOOLTIP_OFFSET).toBeGreaterThanOrEqual(10);
    expect(pos.left).toBe(100 + HOVER_TOOLTIP_OFFSET);
    expect(pos.top).toBe(100 + HOVER_TOOLTIP_OFFSET);
    expect(pos.placement).toBe('bottom-right');
  });

  it('flips left/up near the chart edges and clamps inside the container', () => {
    const nearRight = computeHoverTooltipPosition({
      cursorX: 550,
      cursorY: 100,
      containerWidth: 600,
      containerHeight: 400,
      tooltipWidth: 200,
      tooltipHeight: 120,
    });
    // Tooltip would overflow right: sits left of the cursor with right arrow.
    expect(nearRight.left).toBeLessThan(550);
    expect(nearRight.placement).toBe('bottom-left');

    const nearBottom = computeHoverTooltipPosition({
      cursorX: 100,
      cursorY: 350,
      containerWidth: 600,
      containerHeight: 400,
      tooltipWidth: 200,
      tooltipHeight: 120,
    });
    expect(nearBottom.top).toBeLessThan(350);
    expect(nearBottom.placement).toBe('top-right');

    const corner = computeHoverTooltipPosition({
      cursorX: 595,
      cursorY: 395,
      containerWidth: 600,
      containerHeight: 400,
      tooltipWidth: 200,
      tooltipHeight: 120,
    });
    expect(corner.left).toBeGreaterThanOrEqual(0);
    expect(corner.top).toBeGreaterThanOrEqual(0);
    expect(corner.left + 200).toBeLessThanOrEqual(600);
    expect(corner.top + 120).toBeLessThanOrEqual(400);
    expect(corner.placement).toBe('top-left');
  });

  it('keeps the offset card off the anchor even near edges', () => {
    // Anchor near the bottom-right corner: card flips top-left but the
    // diagonal offset keeps the anchor outside the card rect.
    const anchor = { x: 590, y: 390 };
    const pos = computeHoverTooltipPosition({
      cursorX: anchor.x,
      cursorY: anchor.y,
      containerWidth: 600,
      containerHeight: 400,
      tooltipWidth: 200,
      tooltipHeight: 120,
    });
    const outside =
      anchor.x < pos.left || anchor.x > pos.left + 200 ||
      anchor.y < pos.top || anchor.y > pos.top + 120;
    expect(outside).toBe(true);
    expect(pos.placement).toBe('top-left');
  });
});

describe('resolveHoverAnchor', () => {
  const rect = { left: 0, top: 0, width: 600, height: 400 };

  it('prefers the event bbox dot anchor over the cursor', () => {
    const anchor = resolveHoverAnchor(
      { bbox: { x0: 95, x1: 105, y0: 95, y1: 105 } },
      rect,
      { x: 300, y: 200 },
    );

    expect(anchor).toMatchObject({ x: 100, y: 100, source: 'bbox' });
  });

  it('converts viewport-absolute bbox via the chart rect', () => {
    const anchor = resolveHoverAnchor(
      { bbox: { x0: 195, x1: 205, y0: 145, y1: 155 } },
      { left: 100, top: 50, width: 600, height: 400 },
      { x: 300, y: 200 },
    );

    expect(anchor).toMatchObject({ x: 100, y: 100, source: 'bbox' });
  });

  it('falls back to cursor without bbox and null when nothing usable', () => {
    expect(resolveHoverAnchor({ curveNumber: 0, pointNumber: 0 }, rect, { x: 300, y: 200 }))
      .toMatchObject({ x: 300, y: 200, source: 'cursor' });
    expect(resolveHoverAnchor({}, rect, null)).toBeNull();
  });
});

describe('Contributor always-on split', () => {
  function muse13xhigh(overrides = {}) {
    return model({
      id: 'muse-spark-1-3-xhigh',
      name: 'Muse Spark 1.3 (xhigh)',
      creator: 'Meta',
      iq: 45.1,
      cost: 1.367794,
      time_sec: 227.56,
      tps: 237.4,
      ...overrides,
    });
  }

  function glmFlash(overrides = {}) {
    return model({
      id: 'glm-5-3-flash',
      name: 'GLM 5.3 Flash',
      creator: 'Z AI',
      iq: 41.8,
      cost: 0.25326,
      time_sec: 992.84,
      tps: 50.9,
      ...overrides,
    });
  }

  it('labels Contributor and subscription traces separately, never as measured', () => {
    expect(CONTRIBUTOR_TRACE_NAME).toMatch(/Contributor/i);
    expect(CONTRIBUTOR_TRACE_NAME).toMatch(/estimat/i);
    expect(SUBSCRIPTION_TRACE_NAME).toBe('Subscription estimates');
    expect(SUBSCRIPTION_TRACE_NAME).not.toMatch(/Go only/);
    expect(CONTRIBUTOR_TRACE_NAME).not.toBe(SUBSCRIPTION_TRACE_NAME);
    expect(CONTRIBUTOR_TRACE_NAME).not.toMatch(/measured/i);
    expect(SUBSCRIPTION_TRACE_NAME).not.toMatch(/measured/i);
    // Legacy alias still resolves to the subscription trace.
    expect(DEALS_TRACE_NAME).toBe(SUBSCRIPTION_TRACE_NAME);
  });

  it('names each subscription offer distinctly for hover, table and legend', () => {
    expect(CLAUDE_MAX_TRACE_NAME).toBe('Claude Max $200 ~40x est.');
    expect(CODEX_TRACE_NAME).toBe('ChatGPT Pro/Codex $200 ~70x est.');
    expect(CURSOR_ULTRA_TRACE_NAME).toBe('Cursor Ultra $200 ~2x est.');
    expect(GO_TRACE_NAME).toMatch(/Go/i);
    expect(new Set(SUBSCRIPTION_TRACE_NAMES)).toEqual(
      new Set([GO_TRACE_NAME, CLAUDE_MAX_TRACE_NAME, CODEX_TRACE_NAME, CURSOR_ULTRA_TRACE_NAME]),
    );
    expect(dealLabel({ kind: 'claude-max' })).toBe(CLAUDE_MAX_TRACE_NAME);
    expect(dealLabel({ kind: 'codex' })).toBe(CODEX_TRACE_NAME);
    expect(dealLabel({ kind: 'cursor-ultra' })).toBe(CURSOR_ULTRA_TRACE_NAME);
  });

  it('splits direct Contributor from subscription estimates without mutating rows', () => {
    const rows = Object.freeze([Object.freeze(glmFlash()), Object.freeze(muse13xhigh())]);
    const before = JSON.stringify(rows);

    const contributor = buildContributorPoints(rows, { era: 1 });
    const subscription = buildSubscriptionPoints(rows, { era: 1 });
    const all = buildDealPoints(rows, { era: 1 });

    expect(JSON.stringify(rows)).toBe(before);
    expect(contributor.map((p) => p.deal.kind)).toEqual(['contributor']);
    expect(contributor).toHaveLength(1);
    expect(subscription.every((p) => p.deal.kind !== 'contributor')).toBe(true);
    // 1.3 xhigh compounded Go plus GLM Go $60.
    expect(subscription.map((p) => p.deal.kind).sort()).toEqual(['contributor-go', 'go']);
    expect(contributor.length + subscription.length).toBe(all.length);
    // Direct Contributor inherits benchmark iq/speed and reprices 7:2:1.
    expect(contributor[0].iq).toBe(45.1);
    expect(contributor[0].time_sec).toBe(227.56);
    expect(contributor[0].cost).toBeCloseTo(1.367794 * 0.0414 / 0.78, 10);
    expect(contributor[0].name).toContain('Contributor est.');
    expect(contributor[0].name).not.toMatch(/measured/i);
  });

  it('keeps both 1.3 and 1.2 direct Contributor rows, never max', () => {
    const rows = [
      muse13xhigh(),
      muse13xhigh({ id: 'muse-spark-1-2-xhigh', name: 'Muse Spark 1.2 (xhigh)', cost: 1.1 }),
      muse13xhigh({ id: 'muse-spark-1-3-max', name: 'Muse Spark 1.3 (max)', cost: 1.6 }),
    ];

    const contributor = buildContributorPoints(rows, { era: 1 });

    expect(contributor.map((p) => p.deal.goId).sort()).toEqual([
      'muse-spark-1.2-contributor',
      'muse-spark-1.3-contributor',
    ]);
  });

  it('keeps Contributor and eligible Go in the stable domain together', () => {
    const rows = [glmFlash(), muse13xhigh()];

    const points = eraDomainPoints(rows, { era: 1, utilization: 1 });
    const kinds = points.filter((p) => p.deal).map((p) => p.deal.kind);

    expect(kinds).toContain('contributor');
    expect(kinds).toContain('go');
    expect(kinds).toContain('contributor-go');
    const domains = eraChartDomains(rows, { era: 1, speedMode: 'time', utilization: 1 });
    const cheapest = Math.min(...buildDealPoints(rows, { era: 1 }).map((d) => d.cost));
    expect(domains.xBounds[0]).toBeCloseTo(cheapest, 10);
  });

  it('Contributor estimates respond to era/search/provider/retired filters like measured rows', () => {
    const rows = [glmFlash(), muse13xhigh()];
    const combined = rows.concat(buildDealPoints(rows, { era: 1 }));

    expect(filterModels(combined, { era: 0, speedMode: 'time' }).some((m) => m.deal)).toBe(false);
    expect(
      filterModels(combined, { era: 1, speedMode: 'time', query: 'muse spark' }).some(
        (m) => m.deal?.kind === 'contributor',
      ),
    ).toBe(true);
    expect(
      filterModels(combined, { era: 1, speedMode: 'time', providers: new Set(['Z AI']) }).every(
        (m) => m.creator === 'Z AI',
      ),
    ).toBe(true);
  });
});

describe('subscription scenario cost math', () => {
  it('divides the measured cost by the sourced full-use multiplier', () => {
    expect(estimateSubscriptionCost(8, 40)).toBeCloseTo(0.2, 10);
    expect(estimateSubscriptionCost(7, 70)).toBeCloseTo(0.1, 10);
    expect(estimateSubscriptionCost(1, 2)).toBeCloseTo(0.5, 10);
    expect(CLAUDE_MAX_MULTIPLIER).toBe(40);
    expect(CODEX_MULTIPLIER).toBe(70);
    expect(CURSOR_ULTRA_MULTIPLIER).toBe(2);
  });

  it('raises the effective cost when only part of the saturating workload is used', () => {
    expect(estimateSubscriptionCost(8, 40, { utilization: 0.5 })).toBeCloseTo(0.4, 10);
  });

  it('clamps over-use to full use instead of discounting further', () => {
    expect(estimateSubscriptionCost(8, 40, { utilization: 2 })).toBeCloseTo(0.2, 10);
  });

  it('rejects non-positive costs, multipliers and invalid utilization', () => {
    expect(estimateSubscriptionCost(0, 40)).toBeNull();
    expect(estimateSubscriptionCost(-1, 40)).toBeNull();
    expect(estimateSubscriptionCost(8, 0)).toBeNull();
    expect(estimateSubscriptionCost(8, -40)).toBeNull();
    expect(estimateSubscriptionCost(8, NaN)).toBeNull();
    expect(estimateSubscriptionCost(8, 40, { utilization: 0 })).toBeNull();
    expect(estimateSubscriptionCost(8, 40, { utilization: NaN })).toBeNull();
  });
});

describe('subscription scenario scope', () => {
  it('covers live Claude Opus/Sonnet/Haiku rows for the Claude Max proxy', () => {
    expect(isClaudeMaxEligible(model({ creator: 'Anthropic', id: 'claude-opus-5-xhigh', retired: false }))).toBe(true);
    expect(isClaudeMaxEligible(model({ creator: 'Anthropic', id: 'claude-sonnet-5-low', retired: false }))).toBe(true);
    expect(isClaudeMaxEligible(model({ creator: 'Anthropic', id: 'claude-4-5-haiku-reasoning', retired: false }))).toBe(true);
  });

  it('withholds the Claude Max proxy from Fable reduced-limit rows, retired rows and other labs', () => {
    expect(isClaudeMaxEligible(model({ creator: 'Anthropic', id: 'claude-fable-5-1-max', retired: false }))).toBe(false);
    expect(isClaudeMaxEligible(model({ creator: 'Anthropic', id: 'claude-opus-5-xhigh', retired: true }))).toBe(false);
    expect(isClaudeMaxEligible(model({ creator: 'OpenAI', id: 'claude-opus-5-xhigh', retired: false }))).toBe(false);
    expect(isClaudeMaxEligible(model({ creator: 'Anthropic', id: 'mythos-1', retired: false }))).toBe(false);
  });

  it('includes Fable in the Cursor Claude pool but never in the 40x proxy', () => {
    const fable = model({ creator: 'Anthropic', id: 'claude-fable-5-1-max', retired: false });

    expect(isCursorClaudeEligible(fable)).toBe(true);
    expect(isCursorUltraEligible(fable)).toBe(true);
    expect(isClaudeMaxEligible(fable)).toBe(false);
    expect(isCursorClaudeEligible(model({ creator: 'Anthropic', id: 'claude-opus-5-xhigh', retired: false }))).toBe(true);
    expect(isCursorClaudeEligible(model({ creator: 'Anthropic', id: 'claude-mythos-1', retired: false }))).toBe(false);
    expect(isCursorClaudeEligible(model({ creator: 'Anthropic', id: 'claude-fable-5-1-max', retired: true }))).toBe(false);
    expect(isCursorClaudeEligible(model({ creator: 'OpenAI', id: 'claude-opus-5-xhigh', retired: false }))).toBe(false);
  });

  it('covers live GPT subscription rows but not open-weights builds', () => {
    expect(isCodexEligible(model({ creator: 'OpenAI', id: 'gpt-5-5-high', retired: false }))).toBe(true);
    expect(isCodexEligible(model({ creator: 'OpenAI', id: 'gpt-6-sol-max', retired: false }))).toBe(true);
    expect(isCodexEligible(model({ creator: 'OpenAI', id: 'gpt-oss-120b-high', retired: false }))).toBe(false);
    expect(isCodexEligible(model({ creator: 'OpenAI', id: 'gpt-5-5-high', retired: true }))).toBe(false);
    expect(isCodexEligible(model({ creator: 'Anthropic', id: 'gpt-5-5-high', retired: false }))).toBe(false);
  });

  it('limits the Cursor Ultra pool to Claude, GPT and Gemini rows', () => {
    const claude = model({ creator: 'Anthropic', id: 'claude-sonnet-5-low', retired: false });
    const gpt = model({ creator: 'OpenAI', id: 'gpt-5-5-high', retired: false });
    const gemini = model({ creator: 'Google', id: 'gemini-3-8-flash-high', retired: false });

    expect(isCursorUltraEligible(claude)).toBe(true);
    expect(isCursorUltraEligible(gpt)).toBe(true);
    expect(isCursorUltraEligible(gemini)).toBe(true);
    expect(isGeminiCursorEligible(gemini)).toBe(true);
    expect(isCursorUltraEligible(model({ creator: 'Meta', id: 'muse-spark-1-3-xhigh', retired: false }))).toBe(false);
    expect(isCursorUltraEligible(model({ creator: 'SpaceXAI', id: 'grok-4-7-high', retired: false }))).toBe(false);
    expect(isCursorUltraEligible(model({ creator: 'DeepSeek', id: 'deepseek-v4-1-flash-reasoning-max-effort', retired: false }))).toBe(false);
    expect(isCursorUltraEligible(model({ creator: 'Google', id: 'gemini-3-8-flash-high', retired: true }))).toBe(false);
  });
});

describe('subscription scenario points', () => {
  function opusRow(overrides = {}) {
    return model({
      id: 'claude-opus-5-xhigh',
      name: 'Claude Opus 5 (xhigh)',
      creator: 'Anthropic',
      iq: 49.7,
      cost: 4.877844,
      time_sec: 100,
      tps: 60,
      ...overrides,
    });
  }

  function gptRow(overrides = {}) {
    return model({
      id: 'gpt-5-5-high',
      name: 'GPT-5.5 (high)',
      creator: 'OpenAI',
      iq: 37,
      cost: 1.541289,
      time_sec: 50,
      tps: 120,
      ...overrides,
    });
  }

  it('derives a Claude Max point at base ÷ 40 with inherited benchmark values', () => {
    const [point] = buildDealPoints([opusRow()], { era: 1 }).filter(
      (p) => p.deal?.kind === 'claude-max',
    );

    expect(point.id).toBe('sub:claude-opus-5-xhigh:claude-max40x');
    expect(point.name).toBe('Claude Opus 5 (xhigh) (Claude Max $200 ~40x est.)');
    expect(point.cost).toBeCloseTo(4.877844 / 40, 10);
    expect(point.iq).toBe(49.7);
    expect(point.time_sec).toBe(100);
    expect(point.deal).toMatchObject({ fee: 200, multiplier: 40, baseCost: 4.877844, utilization: 1 });
  });

  it('derives Codex and Cursor Ultra points for GPT rows, Cursor only for Gemini rows', () => {
    const gemini = model({
      id: 'gemini-3-8-flash-high',
      name: 'Gemini 3.8 Flash (high)',
      creator: 'Google',
      iq: 40.9,
      cost: 1.242795,
      time_sec: 70,
      tps: 90,
    });
    const points = buildDealPoints([gptRow(), gemini], { era: 1 });
    const kindsFor = (id) => points.filter((p) => p.id.startsWith(`sub:${id}:`)).map((p) => p.deal.kind).sort();

    expect(kindsFor('gpt-5-5-high')).toEqual(['codex', 'cursor-ultra']);
    expect(kindsFor('gemini-3-8-flash-high')).toEqual(['cursor-ultra']);
    const codex = points.find((p) => p.deal?.kind === 'codex');
    expect(codex.cost).toBeCloseTo(1.541289 / 70, 10);
    expect(codex.name).toContain('ChatGPT Pro/Codex $200 ~70x est.');
    const ultra = points.find((p) => p.id === 'sub:gemini-3-8-flash-high:cursor-ultra2x');
    expect(ultra.cost).toBeCloseTo(1.242795 / 2, 10);
  });

  it('grants no scenario points to retired rows, other eras, or out-of-scope labs', () => {
    const rows = [
      opusRow({ retired: true }),
      opusRow({ id: 'other-era-opus', era: 0 }),
      model({ id: 'grok-4-7-high', creator: 'SpaceXAI', iq: 46.3, cost: 2.726107, retired: false }),
      model({ id: 'muse-spark-1-3-xhigh', creator: 'Meta', iq: 45.1, cost: 1.367794, retired: false }),
      model({ id: 'claude-mythos-1', name: 'Mythos', creator: 'Anthropic', iq: 50, cost: 5, retired: false }),
      model({ id: 'gpt-oss-120b-high', creator: 'OpenAI', iq: 11.6, cost: 0.107425, retired: false }),
    ];

    const scenarios = buildDealPoints(rows, { era: 1 }).filter(
      (p) => p.deal?.kind === 'claude-max' || p.deal?.kind === 'codex' || p.deal?.kind === 'cursor-ultra',
    );

    expect(scenarios).toEqual([]);
  });

  it('gives Fable a Cursor pool point only, never the 40x proxy', () => {
    const fable = model({
      id: 'claude-fable-5-1-max',
      name: 'Claude Fable (max)',
      creator: 'Anthropic',
      iq: 50,
      cost: 5,
      time_sec: 90,
      tps: 55,
    });

    const points = buildDealPoints([fable], { era: 1 });
    const kinds = points.map((p) => p.deal.kind);

    expect(kinds).toEqual(['cursor-ultra']);
    expect(points[0].cost).toBeCloseTo(5 / 2, 10);
    expect(points[0].name).toContain('Cursor Ultra $200 ~2x est.');
  });

  it('scales scenario costs with workload use and labels them as proxies, not measurements', () => {
    const [half] = buildDealPoints([opusRow()], { era: 1, utilization: 0.5 }).filter(
      (p) => p.deal?.kind === 'claude-max',
    );
    const [full] = buildDealPoints([opusRow()], { era: 1, utilization: 1 }).filter(
      (p) => p.deal?.kind === 'claude-max',
    );

    expect(half.cost).toBeCloseTo(full.cost * 2, 10);
    expect(dealAssumption(half.deal)).toMatch(/lab-wide workload proxy/i);
    expect(dealAssumption(half.deal)).toMatch(/not the plan-official 5x\/20x/i);
    expect(dealAssumption({ kind: 'codex', fee: 200, multiplier: 70, utilization: 1 })).toMatch(/29\.81x/);
    expect(dealAssumption({ kind: 'cursor-ultra', fee: 200, pool: 400, multiplier: 2, utilization: 1 })).toMatch(/unverified/i);
    expect(half.name).not.toMatch(/measured/i);
  });

  it('keeps every scenario estimate in the stable domain while the toggle is off', () => {
    const rows = [opusRow(), gptRow()];

    const points = eraDomainPoints(rows, { era: 1, utilization: 1 });
    const kinds = points.filter((p) => p.deal).map((p) => p.deal.kind);

    expect(kinds).toEqual(expect.arrayContaining(['claude-max', 'codex', 'cursor-ultra']));
    const domains = eraChartDomains(rows, { era: 1, speedMode: 'time', utilization: 1 });
    const cheapest = Math.min(...buildDealPoints(rows, { era: 1 }).map((d) => d.cost));
    expect(domains.xBounds[0]).toBeCloseTo(cheapest, 10);
  });

  it('splits scenario estimates from Contributor without mutating rows', () => {
    const rows = Object.freeze([Object.freeze(opusRow()), Object.freeze(gptRow())]);
    const before = JSON.stringify(rows);

    const contributor = buildContributorPoints(rows, { era: 1 });
    const subscription = buildSubscriptionPoints(rows, { era: 1 });

    expect(JSON.stringify(rows)).toBe(before);
    expect(contributor).toEqual([]);
    expect(subscription.every((p) => p.deal.kind !== 'contributor')).toBe(true);
    expect(subscription.map((p) => p.deal.kind).sort()).toEqual(
      ['claude-max', 'codex', 'cursor-ultra', 'cursor-ultra'],
    );
  });
});
