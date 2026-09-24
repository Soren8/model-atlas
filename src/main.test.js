// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('plotly.js-gl3d-dist', () => ({
  default: {
    newPlot: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    relayout: vi.fn(() => {}),
    Plots: { resize: vi.fn(async () => {}) },
  },
}));

const FIXTURE = `
<div id="status"></div>
<div id="chart"></div>
<div id="counts"></div>
<div id="asof"></div>
<div id="era-options"></div>
<p id="era-note"></p>
<select id="speed-mode">
  <option value="time" selected>Time</option>
  <option value="throughput">Throughput</option>
</select>
<input id="search" type="search" />
<select id="provider" multiple></select>
<input id="open-only" type="checkbox" />
<input id="hide-retired" type="checkbox" checked />
<input id="frontier-only" type="checkbox" />
<button id="reset-camera" type="button"></button>
<span id="table-count"></span>
<table id="model-table">
  <thead><tr>
    <th data-key="name">Model</th>
    <th data-key="creator">Provider</th>
    <th data-key="release">Released</th>
    <th data-key="iq">Intelligence</th>
    <th data-key="cost">Cost</th>
    <th data-key="speed" id="th-speed">Speed</th>
    <th data-key="tps">tok/s</th>
    <th data-key="open">Open</th>
    <th data-key="retired">Status</th>
  </tr></thead>
  <tbody id="model-tbody"></tbody>
</table>`;

const PAYLOAD = {
  source_url: 'https://example.test/upstream.json',
  source_updated: '2026-09-23',
  fetched_at: '2026-09-23T00:00:00+00:00',
  eras: [
    { index: 0, label: 'v4.1 (before 2026-09-05)', note: 'archive note' },
    { index: 1, label: 'v4.3 (current, since 2026-09-05)', note: 'current note' },
  ],
  models: [
    { id: 'a', name: 'Alpha', creator: 'Acme', release: '2026-01-01', iq: 40, cost: 0.5, retired: false, open: true, era: 1, time_sec: 10, tps: 100, ttft: 0.5 },
    { id: 'b', name: 'Beta', creator: 'Acme', release: '2026-02-01', iq: 50, cost: 2, retired: false, open: false, era: 1, time_sec: 5, tps: 200, ttft: 0.3 },
    { id: 'c', name: 'Gamma', creator: 'Other', release: '2025-01-01', iq: 30, cost: 0.2, retired: true, open: true, era: 1, time_sec: null, tps: null, ttft: null },
    { id: 'd', name: 'Delta', creator: 'Acme', release: '2025-06-01', iq: 35, cost: 0.3, retired: false, open: true, era: 0, time_sec: null, tps: null, ttft: null },
  ],
};

let fetchMock;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = FIXTURE;
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => PAYLOAD }));
  vi.stubGlobal('fetch', fetchMock);
});

function rows() {
  return document.querySelectorAll('#model-tbody tr');
}

describe('main initialization', () => {
  it('fetches data relative to the deployed page for nested subpaths', async () => {
    await import('./main.js');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // jsdom url is https://user.github.io/llm-chart/ (see vite.config.js).
    expect(fetchMock).toHaveBeenCalledWith(
      'https://user.github.io/llm-chart/data/models.json',
    );
  });

  it('renders counts and table rows on successful startup', async () => {
    await import('./main.js');
    await vi.waitFor(() => expect(rows().length).toBe(2));

    expect(document.getElementById('counts').textContent).toContain('2 plotted');
    expect(document.getElementById('counts').textContent).toContain('2 frontier');
    expect(document.getElementById('asof').textContent).toContain('2026-09-23');
  });

  it('keeps filters and table working when WebGL initialization fails', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.newPlot.mockRejectedValueOnce(new Error('WebGL unavailable'));

    await import('./main.js');
    await vi.waitFor(() => expect(rows().length).toBe(2));

    expect(document.getElementById('chart').style.display).toBe('none');
    expect(document.getElementById('status').textContent).toMatch(/WebGL/i);
    expect(document.getElementById('counts').textContent).toContain('2 plotted');
  });

  it('highlights the frontier with markers only, no connecting path', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalled());

    const data = Plotly.react.mock.calls.at(-1)[1];
    expect(data.some((t) => t.name === 'Pareto frontier' && t.mode === 'markers')).toBe(true);
    expect(data.every((t) => t.mode !== 'lines')).toBe(true);
    expect(data.some((t) => t.name === 'Frontier path')).toBe(false);
  });

  it('reports malformed JSON instead of failing silently', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    });

    await import('./main.js');
    await vi.waitFor(() =>
      expect(document.getElementById('status').textContent.length).toBeGreaterThan(0),
    );

    expect(document.getElementById('status').textContent).toMatch(/data/i);
    expect(document.getElementById('status').classList.contains('error')).toBe(true);
    expect(rows().length).toBe(0);
  });

  it('reports HTTP failures with an error status', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    await import('./main.js');
    await vi.waitFor(() =>
      expect(document.getElementById('status').textContent).toMatch(/404/),
    );

    expect(document.getElementById('status').classList.contains('error')).toBe(true);
  });
});

describe('preferred corner trace', () => {
  it('renders a translucent preferred-corner box without replacing markers', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const data = Plotly.react.mock.calls.at(-1)[1];
    const corner = data.find((t) => t.name === 'Preferred corner');

    expect(corner).toMatchObject({
      type: 'mesh3d',
      opacity: 0.15,
      hoverinfo: 'skip',
      flatshading: true,
    });
    expect(data.some((t) => t.name === 'Models' && t.type === 'scatter3d')).toBe(true);
    expect(data.some((t) => t.name === 'Pareto frontier' && t.type === 'scatter3d')).toBe(true);
    expect(Math.min(...corner.x)).toBe(0.5);
    expect(Math.max(...corner.x)).toBeCloseTo(1, 10);
    expect(Math.min(...corner.y)).toBe(5);
    expect(Math.max(...corner.y)).toBeCloseTo(Math.sqrt(50), 10);
    expect(Math.min(...corner.z)).toBe(45);
    expect(Math.max(...corner.z)).toBe(50);
  });

  it('omits the preferred-corner box when the plotted range collapses', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...PAYLOAD,
        models: [
          { id: 'solo', name: 'Solo', creator: 'Acme', release: '2026-01-01', iq: 40, cost: 0.5, retired: false, open: true, era: 1, time_sec: 10, tps: 100, ttft: 0.5 },
        ],
      }),
    });

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const data = Plotly.react.mock.calls.at(-1)[1];

    expect(data.some((t) => t.name === 'Preferred corner')).toBe(false);
    expect(data.some((t) => t.name === 'Models')).toBe(true);
  });

  it('outlines model dots so dark brand fills stay visible without changing the fill', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const data = Plotly.react.mock.calls.at(-1)[1];
    const models = data.find((t) => t.name === 'Models');
    const frontier = data.find((t) => t.name === 'Pareto frontier');

    expect(models.marker.line).toMatchObject({ color: expect.stringContaining('232,236,243') });
    expect(frontier.marker.color).toHaveLength(2);
    expect(frontier.marker.line).toMatchObject({ color: '#ffffff' });
  });

  it('keeps the highlight faint at 15% opacity so dots stay readable', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const data = Plotly.react.mock.calls.at(-1)[1];
    const corner = data.find((t) => t.name === 'Preferred corner');

    expect(corner.opacity).toBe(0.15);
    expect(corner.hoverinfo).toBe('skip');
  });

  it('detaches the highlight box from picking so dots hover through it', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();
    const chart = document.getElementById('chart');
    const boxMesh = {
      pickId: 9,
      pickSlots: 1,
      drawPick() {},
      pick(result) {
        return result && result.id === this.pickId ? { index: 0 } : null;
      },
    };
    const boxTrace = {
      data: { name: 'Preferred corner', type: 'mesh3d', hoverinfo: 'skip' },
      mesh: boxMesh,
      handlePick(selection) {
        return selection?.object === this.mesh;
      },
    };
    const scatterPlot = {};
    const scatterTrace = {
      data: { name: 'Models', type: 'scatter3d' },
      scatterPlot,
      handlePick(selection) {
        return selection?.object === this.scatterPlot;
      },
    };
    chart._fullLayout = {
      scene: { _scene: { traces: { box: boxTrace, scatter: scatterTrace } } },
    };

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(boxTrace.handlePick({ object: boxMesh })).toBe(false));

    expect(boxMesh.pick({ id: 9 })).toBeNull();
    expect(scatterTrace.handlePick({ object: scatterPlot })).toBe(true);
    delete chart._fullLayout;
  });
});

describe('intelligence axis ceiling', () => {
  function lastCall(Plotly) {
    return Plotly.react.mock.calls.at(-1);
  }

  it('caps the intelligence axis at the selected-era max while keeping the top model plotted', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const data = lastCall(Plotly)[1];
    const layout = lastCall(Plotly)[2];
    const frontier = data.find((t) => t.name === 'Pareto frontier');

    // Beta (iq 50) is the smartest plottable model of the selected era: its
    // point must be rendered, not filtered away.
    expect(frontier.z).toContain(50);
    // ...and the axis must reach it instead of stopping below it.
    expect(layout.scene.zaxis.range).toEqual([0, 50]);
  });

  it('keeps the era-max ceiling across filters and scopes it to the selected era', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));
    expect(lastCall(Plotly)[2].scene.zaxis.range).toEqual([0, 50]);

    // Frontier-only narrows the plotted set; the ceiling stays at the era max.
    const frontierOnly = document.getElementById('frontier-only');
    frontierOnly.checked = true;
    frontierOnly.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));
    expect(lastCall(Plotly)[2].scene.zaxis.range).toEqual([0, 50]);

    // Narrowing providers so the top model leaves the plot must not move the ceiling.
    const provider = document.getElementById('provider');
    [...provider.options].forEach((o) => {
      o.selected = o.value === 'Other';
    });
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(3));
    expect(lastCall(Plotly)[2].scene.zaxis.range).toEqual([0, 50]);

    // Switching eras re-scopes the ceiling: era 0 tops out at 35, not the global 50.
    const era0 = document.querySelector('input[name="era"][value="0"]');
    era0.checked = true;
    era0.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(4));
    expect(lastCall(Plotly)[2].scene.zaxis.range).toEqual([0, 35]);
  });

  it('extends the preferred-corner box to the era ceiling when filters hide the top model', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...PAYLOAD,
        models: [
          ...PAYLOAD.models,
          { id: 'a2', name: 'Alpha Plus', creator: 'Acme', release: '2026-03-01', iq: 45, cost: 0.6, retired: false, open: true, era: 1, time_sec: 8, tps: 150, ttft: 0.4 },
        ],
      }),
    });
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    // Narrow the plot to the Alpha pair (iq 40/45) while Beta (iq 50) keeps
    // the era ceiling at 50.
    const search = document.getElementById('search');
    search.value = 'alpha';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));

    const data = lastCall(Plotly)[1];
    const layout = lastCall(Plotly)[2];
    const corner = data.find((t) => t.name === 'Preferred corner');

    expect(layout.scene.zaxis.range).toEqual([0, 50]);
    expect(corner).toBeDefined();
    expect(Math.max(...corner.z)).toBe(50);
  });

describe('subscription toggle (Contributor always on)', () => {
  const DEALS_FIXTURE = FIXTURE
    .replace(
      '<input id="frontier-only" type="checkbox" />',
      `<input id="frontier-only" type="checkbox" />
<input id="deals-toggle" type="checkbox" />
<input id="deals-util" type="number" value="100" />
<p id="deals-note"></p>`,
    )
    .replace(
      '<th data-key="cost">Cost</th>',
      '<th data-key="cost">Cost</th><th data-key="deal">Terms</th>',
    );

  const DEALS_PAYLOAD = {
    source_url: 'https://example.test/upstream.json',
    source_updated: '2026-09-23',
    fetched_at: '2026-09-23T00:00:00+00:00',
    eras: [{ index: 1, label: 'v4.3 (current)', note: 'current note' }],
    models: [
      { id: 'muse-spark-1-3-xhigh', name: 'Muse Spark 1.3 (xhigh)', creator: 'Meta', release: '2026-08-01', iq: 45.1, cost: 1.367794, retired: false, open: false, era: 1, time_sec: 227.56, tps: 237.4, ttft: 0.5 },
      { id: 'glm-5-3-flash', name: 'GLM 5.3 Flash', creator: 'Z AI', release: '2026-09-01', iq: 41.8, cost: 0.25326, retired: false, open: false, era: 1, time_sec: 992.84, tps: 50.9, ttft: 0.4 },
      { id: 'muse-spark-1-3-max', name: 'Muse Spark 1.3 (max)', creator: 'Meta', release: '2026-08-01', iq: 48.1, cost: 1.604893, retired: false, open: false, era: 1, time_sec: 259.49, tps: 223.0, ttft: 0.6 },
    ],
  };

  function useDealsDom() {
    document.body.innerHTML = DEALS_FIXTURE;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => DEALS_PAYLOAD });
  }

  function contributorTrace(Plotly) {
    return lastCall(Plotly)[1].find((t) => t.name === 'Contributor (estimates)');
  }

  function subscriptionTrace(Plotly) {
    return lastCall(Plotly)[1].find((t) => t.name === 'Subscription estimates (Go only)');
  }

  it('keeps Contributor always on while subscription stays off by default', async () => {
    useDealsDom();
    const Plotly = (await import('plotly.js-gl3d-dist')).default;

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    // Direct Contributor (distinct token tariff) is always plotted in its own
    // trace; Go subscription estimates wait for the toggle.
    const contributor = contributorTrace(Plotly);
    expect(contributor).toBeDefined();
    expect(contributor.type).toBe('scatter3d');
    expect(contributor.marker.symbol).toBe('diamond');
    expect(contributor.x).toHaveLength(1);
    expect(contributor.text.join('\n')).toContain('not an Artificial Analysis measurement');
    expect(contributor.text.join('\n')).toContain('inherited benchmark');
    expect(subscriptionTrace(Plotly)).toBeUndefined();
    expect(lastCall(Plotly)[2].scene.xaxis.title).toMatchObject({
      text: 'Cost per task, USD (log; Contributor estimates)',
    });
    expect(document.getElementById('counts').textContent).toContain('Contributor estimates');
    expect(document.getElementById('counts').textContent).not.toContain('subscription estimates');
    const terms = [...document.querySelectorAll('#model-tbody tr')].map(
      (tr) => tr.cells[5].textContent,
    );
    // 3 measured rows plus the always-on Contributor repricing.
    expect(terms).toHaveLength(4);
    expect(new Set(terms)).toEqual(new Set(['Measured', 'Contributor est.']));
    expect(terms).not.toContain('Go $60 quota-equiv est.');
  });

  it('adds separately labeled subscription estimates when toggled on, keeping max measured-only', async () => {
    useDealsDom();
    const Plotly = (await import('plotly.js-gl3d-dist')).default;

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    document.getElementById('deals-toggle').checked = true;
    document.getElementById('deals-toggle').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));

    const data = lastCall(Plotly)[1];
    const contributor = contributorTrace(Plotly);
    const subscription = subscriptionTrace(Plotly);
    expect(contributor).toBeDefined();
    expect(subscription).toBeDefined();
    expect(subscription.type).toBe('scatter3d');
    expect(subscription.marker.symbol).toBe('diamond');
    // Contributor trace stays at 1 direct point; subscription holds the
    // compounded Contributor-via-Go plus Go $60 for GLM 5.3 Flash.
    expect(contributor.x).toHaveLength(1);
    expect(subscription.x).toHaveLength(2);
    expect([...contributor.text, ...subscription.text].join('\n')).toContain(
      'not an Artificial Analysis measurement',
    );
    expect([...contributor.text, ...subscription.text].join('\n')).toContain('inherited benchmark');
    expect(subscription.text.some((t) => t.includes('(max)'))).toBe(false);
    expect(contributor.text.some((t) => t.includes('(max)'))).toBe(false);
    // Measured traces keep their names; estimates never join them.
    expect(data.find((t) => t.name === 'Models')).toBeDefined();
    expect(lastCall(Plotly)[2].scene.xaxis.title.text).toContain('Go subscription estimates');
    expect(document.getElementById('counts').textContent).toContain('Contributor estimates');
    expect(document.getElementById('counts').textContent).toContain('subscription estimates');

    const bodyText = document.getElementById('model-tbody').textContent;
    expect(bodyText).toContain('Contributor est.');
    expect(bodyText).toContain('Go $60 quota-equiv est.');
    expect(bodyText).toContain('compounded');
    expect(bodyText).toContain('Measured');
    expect(document.getElementById('deals-note').textContent).toContain('2026-09-24');
    expect(document.getElementById('deals-note').textContent).toContain('always on');
  });

  it('halving quota use doubles the Go effective cost', async () => {    useDealsDom();
    document.getElementById('deals-toggle').checked = true;
    document.getElementById('deals-util').value = '50';
    const Plotly = (await import('plotly.js-gl3d-dist')).default;

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const subscription = subscriptionTrace(Plotly);
    const idx = subscription.text.findIndex((t) => t.includes('GLM 5.3 Flash'));
    expect(idx).toBeGreaterThanOrEqual(0);
    // 0.25326 × 10 / (60 × 0.5) at half use.
    expect(subscription.x[idx]).toBeCloseTo(0.25326 / 3, 10);
    // Direct Contributor cost ignores quota use (distinct token tariff).
    const contributor = contributorTrace(Plotly);
    expect(contributor.x).toHaveLength(1);
  });

  it('keeps Contributor rows always on and subscription rows after toggle through re-sorting', async () => {
    useDealsDom();
    const Plotly = (await import('plotly.js-gl3d-dist')).default;

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));
    // Contributor is already in the table before the subscription toggle.
    expect(document.getElementById('model-tbody').textContent).toContain('Contributor est.');

    document.getElementById('deals-toggle').checked = true;
    document.getElementById('deals-toggle').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));
    expect(document.getElementById('model-tbody').textContent).toContain('Contributor est.');

    document.querySelector('#model-table th[data-key="iq"]').dispatchEvent(
      new Event('click', { bubbles: true }),
    );

    expect(document.getElementById('model-tbody').textContent).toContain('Contributor est.');
    expect(document.getElementById('model-tbody').textContent).toContain('Go $60 quota-equiv est.');
  });
});
  it('falls back to autorange when the selected era has no finite intelligence', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...PAYLOAD,
        models: [
          { id: 'noint', name: 'NoInt', creator: 'Acme', release: '2026-01-01', iq: null, cost: 0.5, retired: false, open: true, era: 1, time_sec: 10, tps: 100, ttft: 0.5 },
        ],
      }),
    });
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    // Nothing plottable and no finite intelligence: leave scaling to Plotly.
    expect(lastCall(Plotly)[1]).toEqual([]);
    expect(lastCall(Plotly)[2].scene.zaxis.range).toBeUndefined();
  });
});

describe('axis titles use the Plotly object form', () => {
  function lastPlot(Plotly) {
    return Plotly.react.mock.calls.at(-1);
  }

  function titles(Plotly) {
    const layout = lastPlot(Plotly)[2];
    return {
      x: layout.scene.xaxis.title,
      y: layout.scene.yaxis.title,
      z: layout.scene.zaxis.title,
    };
  }

  it('labels cost, time and intelligence explicitly instead of literal x/z', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const { x, y, z } = titles(Plotly);

    expect(x).toMatchObject({ text: expect.stringMatching(/cost.*USD.*log/i) });
    expect(y).toMatchObject({ text: expect.stringMatching(/time.*s.*log.*lower/i) });
    expect(z).toMatchObject({ text: expect.stringMatching(/intelligence/i) });
  });

  it('labels throughput explicitly when the speed metric switches', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    document.getElementById('speed-mode').value = 'throughput';
    document.getElementById('speed-mode').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));

    const { x, y, z } = titles(Plotly);

    expect(x).toMatchObject({ text: expect.stringMatching(/cost.*USD/i) });
    expect(y).toMatchObject({ text: expect.stringMatching(/throughput.*tok\/s.*higher/i) });
    expect(z).toMatchObject({ text: expect.stringMatching(/intelligence/i) });
  });
});

describe('stable axis domains keep the grid fixed', () => {
  function lastPlot(Plotly) {
    return Plotly.react.mock.calls.at(-1);
  }

  function ranges(Plotly) {
    const layout = lastPlot(Plotly)[2];
    return {
      x: layout.scene.xaxis.range,
      y: layout.scene.yaxis.range,
      z: layout.scene.zaxis.range,
    };
  }

  function boxOf(Plotly) {
    return lastPlot(Plotly)[1].find((t) => t.name === 'Preferred corner');
  }

  function plottedPoints(Plotly) {
    const data = lastPlot(Plotly)[1];
    const xs = [];
    const ys = [];
    for (const t of data) {
      if (t.name === 'Preferred corner') continue;
      for (const v of t.x ?? []) xs.push(v);
      for (const v of t.y ?? []) ys.push(v);
    }
    return { xs, ys };
  }

  function expectContains(range, value) {
    expect(Math.log10(value)).toBeGreaterThanOrEqual(range[0] - 1e-9);
    expect(Math.log10(value)).toBeLessThanOrEqual(range[1] + 1e-9);
  }

  it('keeps x/y ranges and the green box fixed across search, provider and frontier filters', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const initialRanges = ranges(Plotly);
    const initialBox = boxOf(Plotly);
    expect(initialRanges.x).toBeDefined();
    expect(initialRanges.y).toBeDefined();
    expect(initialBox).toBeDefined();

    // Text search narrows the plotted set to Alpha only (singleton): the grid
    // and the full-domain box must not regenerate around the search.
    const search = document.getElementById('search');
    search.value = 'alpha';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));

    expect(ranges(Plotly).x).toEqual(initialRanges.x);
    expect(ranges(Plotly).y).toEqual(initialRanges.y);
    expect(ranges(Plotly).z).toEqual(initialRanges.z);
    const searchBox = boxOf(Plotly);
    expect(searchBox).toBeDefined();
    expect(searchBox.x).toEqual(initialBox.x);
    expect(searchBox.y).toEqual(initialBox.y);
    expect(searchBox.z).toEqual(initialBox.z);

    // Frontier-only must not move the grid either.
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(3));
    const beforeFrontier = ranges(Plotly);
    const frontierOnly = document.getElementById('frontier-only');
    frontierOnly.checked = true;
    frontierOnly.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(4));
    expect(ranges(Plotly).x).toEqual(beforeFrontier.x);
    expect(ranges(Plotly).y).toEqual(beforeFrontier.y);
    expect(boxOf(Plotly).x).toEqual(initialBox.x);

    // Provider narrowing to a single provider keeps the same fixed grid.
    frontierOnly.checked = false;
    frontierOnly.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(5));
    const provider = document.getElementById('provider');
    [...provider.options].forEach((o) => {
      o.selected = o.value === 'Acme';
    });
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(6));
    expect(ranges(Plotly).x).toEqual(initialRanges.x);
    expect(ranges(Plotly).y).toEqual(initialRanges.y);
    expect(boxOf(Plotly).x).toEqual(initialBox.x);

    // Open-weights and retired toggles also leave the grid alone.
    [...provider.options].forEach((o) => { o.selected = false; });
    provider.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(7));
    const openOnly = document.getElementById('open-only');
    openOnly.checked = true;
    openOnly.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(8));
    expect(ranges(Plotly).x).toEqual(initialRanges.x);
    expect(ranges(Plotly).y).toEqual(initialRanges.y);
    const hideRetired = document.getElementById('hide-retired');
    hideRetired.checked = false;
    hideRetired.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(9));
    expect(ranges(Plotly).x).toEqual(initialRanges.x);
    expect(ranges(Plotly).y).toEqual(initialRanges.y);
    expect(boxOf(Plotly).x).toEqual(initialBox.x);
  });

  it('contains every plotted frontier extreme, not just the ordinary trace', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const data = lastPlot(Plotly)[1];
    const { x, y } = ranges(Plotly);
    const frontier = data.find((t) => t.name === 'Pareto frontier');
    const models = data.find((t) => t.name === 'Models');

    expect(frontier.x.length).toBeGreaterThan(0);
    for (const v of frontier.x) expectContains(x, v);
    for (const v of frontier.y) expectContains(y, v);
    for (const v of models.x ?? []) expectContains(x, v);
    // The cheapest frontier extreme (Alpha $0.50) and the priciest (Beta
    // $2.00) both sit inside the fixed cost range.
    expectContains(x, 0.5);
    expectContains(x, 2);
  });

  it('contains the full current-era population including retired rows', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...PAYLOAD,
        models: [
          ...PAYLOAD.models,
          { id: 'r', name: 'Retired Cheap', creator: 'Acme', release: '2026-01-02', iq: 38, cost: 0.05, retired: true, open: true, era: 1, time_sec: 12, tps: 80, ttft: 0.5 },
        ],
      }),
    });
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    // hide-retired is checked in the fixture, so the retired row is filtered
    // out of the plot — but the fixed domain still contains its cost.
    const { x } = ranges(Plotly);
    expectContains(x, 0.05);
  });

  it('switching speed recomputes the y domain in the new units without mixing eras', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const timeY = ranges(Plotly).y;
    expect(timeY).toBeDefined();

    document.getElementById('speed-mode').value = 'throughput';
    document.getElementById('speed-mode').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));

    const tpsY = ranges(Plotly).y;
    expect(tpsY).toBeDefined();
    expect(tpsY).not.toEqual(timeY);
    // Throughput 100 and 200 tok/s sit inside the recomputed throughput range.
    expectContains(tpsY, 100);
    expectContains(tpsY, 200);

    // Switching eras re-scopes: era 0 tops out at iq 35 with no speed range.
    const era0 = document.querySelector('input[name="era"][value="0"]');
    era0.checked = true;
    era0.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(3));
    expect(lastPlot(Plotly)[2].scene.zaxis.range).toEqual([0, 35]);
  });

  it('leaves the speed range to Plotly when the era has no speed measurements', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...PAYLOAD,
        eras: [{ index: 0, label: 'v4.1 (archive)', note: 'archive note' }],
        models: PAYLOAD.models.filter((m) => m.era === 0),
      }),
    });
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    // Era 0 predates speed measurements: no plottable points, no box, but the
    // cost range still spans the era and the empty state stays accurate.
    expect(lastPlot(Plotly)[1]).toEqual([]);
    expect(lastPlot(Plotly)[2].scene.xaxis.range).toBeDefined();
    expect(lastPlot(Plotly)[2].scene.yaxis.range).toBeUndefined();
  });

  it('keeps the grid fixed when the subscription toggle adds estimates', async () => {
    document.body.innerHTML = FIXTURE.replace(
      '<input id="frontier-only" type="checkbox" />',
      `<input id="frontier-only" type="checkbox" />
<input id="deals-toggle" type="checkbox" />
<input id="deals-util" type="number" value="100" />
<p id="deals-note"></p>`,
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        source_url: 'https://example.test/upstream.json',
        source_updated: '2026-09-23',
        fetched_at: '2026-09-23T00:00:00+00:00',
        eras: [{ index: 1, label: 'v4.3 (current)', note: 'current note' }],
        models: [
          { id: 'muse-spark-1-3-xhigh', name: 'Muse Spark 1.3 (xhigh)', creator: 'Meta', release: '2026-08-01', iq: 45.1, cost: 1.367794, retired: false, open: false, era: 1, time_sec: 227.56, tps: 237.4, ttft: 0.5 },
          { id: 'glm-5-3-flash', name: 'GLM 5.3 Flash', creator: 'Z AI', release: '2026-09-01', iq: 41.8, cost: 0.25326, retired: false, open: false, era: 1, time_sec: 992.84, tps: 50.9, ttft: 0.4 },
        ],
      }),
    });
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    // Subscription off: the fixed cost range already contains the always-on
    // Contributor (~$0.07) plus eligible Go estimates (compounded Go ~$0.01)
    // so enabling the toggle cannot rescale.
    const offRanges = ranges(Plotly);
    const offBox = boxOf(Plotly);
    expect(offRanges.x).toBeDefined();
    expectContains(offRanges.x, 0.0726);
    expectContains(offRanges.x, 1.367794);
    // Contributor trace is already plotted while subscription waits.
    expect(lastPlot(Plotly)[1].some((t) => t.name === 'Contributor (estimates)')).toBe(true);
    expect(lastPlot(Plotly)[1].some((t) => t.name === 'Subscription estimates (Go only)')).toBe(false);

    document.getElementById('deals-toggle').checked = true;
    document.getElementById('deals-toggle').dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));

    expect(ranges(Plotly).x).toEqual(offRanges.x);
    expect(ranges(Plotly).y).toEqual(offRanges.y);
    expect(ranges(Plotly).z).toEqual(offRanges.z);
    expect(boxOf(Plotly).x).toEqual(offBox.x);
    const contributor = lastPlot(Plotly)[1].find((t) => t.name === 'Contributor (estimates)');
    const subscription = lastPlot(Plotly)[1].find((t) => t.name === 'Subscription estimates (Go only)');
    expect(contributor).toBeDefined();
    expect(subscription).toBeDefined();
    for (const v of [...contributor.x, ...subscription.x]) expectContains(ranges(Plotly).x, v);
    for (const v of [...contributor.y, ...subscription.y]) expectContains(ranges(Plotly).y, v);
  });
});

describe('hover tooltip stays off the dot', () => {
  function lastData(Plotly) {
    return Plotly.react.mock.calls.at(-1)[1];
  }

  it('suppresses the centered built-in hover card via public hoverinfo none', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const data = lastData(Plotly);
    const hoverables = data.filter((t) => t.type === 'scatter3d');
    expect(hoverables.length).toBeGreaterThan(0);
    // Plotly scatter3d docs: hoverinfo "none" shows nothing but still fires
    // hover events for a custom tooltip; "text" would render the centered
    // card that covers the dot. Text alignment alone never moves the card.
    for (const t of hoverables) expect(t.hoverinfo).toBe('none');
    for (const t of hoverables) expect(t.hoverlabel?.align).toBeUndefined();
  });

  it('shows an offset custom tooltip with pointer that hides on unhover and filtering', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();
    // Capture Plotly hover handlers: main wires plotly_hover/unhover for the
    // custom offset tooltip (screen coords from the cursor, not the scene).
    // els.chart is captured at main.js import time, so stub .on beforehand.
    const hoverHandlers = {};
    document.getElementById('chart').on = (name, fn) => {
      hoverHandlers[name] = fn;
    };

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const chart = document.getElementById('chart');
    const tip = document.getElementById('chart-hover-tooltip');
    expect(tip).not.toBeNull();
    // Never intercepts hover; visual pointer to the dot via CSS arrow.
    expect(tip.style.pointerEvents).toBe('none');
    expect(tip.className).toMatch(/arrow/i);
    expect(['bottom-right', 'bottom-left', 'top-right', 'top-left']).toContain(tip.dataset.placement);
    expect(tip.hidden || tip.style.display === 'none' || tip.getAttribute('aria-hidden') === 'true').toBe(true);

    // Cursor position drives the offset card (robust across scenes/camera).
    const rectSpy = vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0,
      toJSON: () => {},
    });
    chart.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 200, bubbles: true }));
    const data = lastData(Plotly);
    // Alpha lives on the frontier trace (Models holds only non-frontier
    // points); resolve the public curveNumber dynamically.
    let curveNumber = 0;
    let pointNumber = 0;
    outer: for (let ti = 0; ti < data.length; ti++) {
      for (let pi = 0; pi < (data[ti].text ?? []).length; pi++) {
        if (String(data[ti].text[pi]).includes('Alpha')) {
          curveNumber = ti;
          pointNumber = pi;
          break outer;
        }
      }
    }
    expect(typeof hoverHandlers['plotly_hover']).toBe('function');
    hoverHandlers['plotly_hover']({ points: [{ curveNumber, pointNumber }] });

    expect(tip.hidden).toBe(false);
    expect(tip.innerHTML).toContain('Alpha');
    // Offset from the cursor/dot: never centered on it.
    const left = parseFloat(tip.style.left);
    const top = parseFloat(tip.style.top);
    expect(Number.isFinite(left) && Number.isFinite(top)).toBe(true);
    expect(Math.abs(left - 300) >= 10 && Math.abs(top - 200) >= 10).toBe(true);
    // Clamped inside the chart.
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeLessThanOrEqual(600);
    expect(top).toBeLessThanOrEqual(400);

    hoverHandlers['plotly_unhover']();
    expect(tip.hidden).toBe(true);

    // Filtering hides a stale tooltip.
    chart.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 200, bubbles: true }));
    hoverHandlers['plotly_hover']({ points: [{ curveNumber, pointNumber }] });
    expect(tip.hidden).toBe(false);
    const search = document.getElementById('search');
    search.value = 'beta';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(2));
    expect(tip.hidden).toBe(true);

    rectSpy.mockRestore();
  });

  it('preserves escaped hover details in the custom tooltip', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        ...PAYLOAD,
        models: PAYLOAD.models.map((m) =>
          m.id === 'a' ? { ...m, name: '<b>Alpha & Co</b>', creator: 'Acme <Ltd>' } : m,
        ),
      }),
    });
    const hoverHandlers = {};
    document.getElementById('chart').on = (name, fn) => {
      hoverHandlers[name] = fn;
    };

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const chart = document.getElementById('chart');
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0,
      toJSON: () => {},
    });
    chart.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100, bubbles: true }));
    const PlotlyData = Plotly.react.mock.calls.at(-1)[1];
    let curveNumber = 0;
    let pointNumber = 0;
    outer: for (let ti = 0; ti < PlotlyData.length; ti++) {
      for (let pi = 0; pi < (PlotlyData[ti].text ?? []).length; pi++) {
        if (String(PlotlyData[ti].text[pi]).includes('Alpha')) {
          curveNumber = ti;
          pointNumber = pi;
          break outer;
        }
      }
    }
    hoverHandlers['plotly_hover']({ points: [{ curveNumber, pointNumber }] });

    const tip = document.getElementById('chart-hover-tooltip');
    expect(tip.innerHTML).toContain('&lt;b&gt;Alpha');
    expect(tip.innerHTML).not.toContain('<b>Alpha');
    expect(tip.innerHTML).toContain('Acme &lt;Ltd&gt;');
  });

  it('anchors the card at the event dot bbox and stays off the dot near edges', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();
    const hoverHandlers = {};
    document.getElementById('chart').on = (name, fn) => {
      hoverHandlers[name] = fn;
    };

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const chart = document.getElementById('chart');
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0,
      toJSON: () => {},
    });
    const data = Plotly.react.mock.calls.at(-1)[1];
    let curveNumber = 0;
    let pointNumber = 0;
    outer: for (let ti = 0; ti < data.length; ti++) {
      for (let pi = 0; pi < (data[ti].text ?? []).length; pi++) {
        if (String(data[ti].text[pi]).includes('Alpha')) {
          curveNumber = ti;
          pointNumber = pi;
          break outer;
        }
      }
    }
    const tip = document.getElementById('chart-hover-tooltip');
    Object.defineProperty(tip, 'offsetWidth', { value: 200, configurable: true });
    Object.defineProperty(tip, 'offsetHeight', { value: 120, configurable: true });

    // Cursor elsewhere: the public bbox dot anchor wins over cursor coords.
    chart.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 200, bubbles: true }));
    hoverHandlers['plotly_hover']({
      points: [{ curveNumber, pointNumber, bbox: { x0: 95, x1: 105, y0: 95, y1: 105 } }],
    });
    expect(tip.hidden).toBe(false);
    expect(parseFloat(tip.style.left)).toBe(114);
    expect(parseFloat(tip.style.top)).toBe(114);
    expect(tip.dataset.placement).toBe('bottom-right');

    // Dot near the bottom-right corner: card flips top-left, anchor outside.
    hoverHandlers['plotly_hover']({
      points: [{ curveNumber, pointNumber, bbox: { x0: 585, x1: 595, y0: 385, y1: 395 } }],
    });
    const left = parseFloat(tip.style.left);
    const top = parseFloat(tip.style.top);
    expect(tip.dataset.placement).toBe('top-left');
    const covers = 590 >= left && 590 <= left + 200 && 390 >= top && 390 <= top + 120;
    expect(covers).toBe(false);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + 200).toBeLessThanOrEqual(600);
    expect(top + 120).toBeLessThanOrEqual(400);
  });

  it('recreates the custom card after removal', async () => {
    const Plotly = (await import('plotly.js-gl3d-dist')).default;
    Plotly.react.mockClear();
    const hoverHandlers = {};
    document.getElementById('chart').on = (name, fn) => {
      hoverHandlers[name] = fn;
    };

    await import('./main.js');
    await vi.waitFor(() => expect(Plotly.react).toHaveBeenCalledTimes(1));

    const chart = document.getElementById('chart');
    vi.spyOn(chart, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0,
      toJSON: () => {},
    });
    chart.dispatchEvent(new MouseEvent('mousemove', { clientX: 300, clientY: 200, bubbles: true }));
    const data = Plotly.react.mock.calls.at(-1)[1];
    let curveNumber = 0;
    let pointNumber = 0;
    outer: for (let ti = 0; ti < data.length; ti++) {
      for (let pi = 0; pi < (data[ti].text ?? []).length; pi++) {
        if (String(data[ti].text[pi]).includes('Alpha')) {
          curveNumber = ti;
          pointNumber = pi;
          break outer;
        }
      }
    }
    hoverHandlers['plotly_hover']({ points: [{ curveNumber, pointNumber }] });
    expect(document.getElementById('chart-hover-tooltip').hidden).toBe(false);

    // Plotly.react may clear custom children; hover re-ensures the card.
    document.getElementById('chart-hover-tooltip').remove();
    expect(document.getElementById('chart-hover-tooltip')).toBeNull();
    hoverHandlers['plotly_hover']({ points: [{ curveNumber, pointNumber }] });
    const recreated = document.getElementById('chart-hover-tooltip');
    expect(recreated).not.toBeNull();
    expect(recreated.hidden).toBe(false);
    expect(recreated.innerHTML).toContain('Alpha');
  });
});
