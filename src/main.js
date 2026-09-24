import Plotly from 'plotly.js-gl3d-dist';
import {
  SPEED_MODES,
  paretoFrontier,
  preferredCornerBounds,
  filterModels,
  providerSummary,
  buildProviderColors,
  formatUsd,
  formatNum,
  resolveDataUrl,
  PREFERRED_CORNER_NAME,
  buildContributorPoints,
  buildSubscriptionPoints,
  dealLabel,
  dealAssumption,
  parseUtilizationPercent,
  eraDomainPoints,
  eraChartDomains,
  computeHoverTooltipPosition,
  resolveHoverAnchor,
  HOVER_TOOLTIP_OFFSET,
  CONTRIBUTOR_TRACE_NAME,
  GO_TRACE_NAME,
  CLAUDE_MAX_TRACE_NAME,
  CODEX_TRACE_NAME,
  CLAUDE_PRO_TRACE_NAME,
  CODEX_PLUS_TRACE_NAME,
  CURSOR_ULTRA_TRACE_NAME,
} from './lib.js';
import { DEALS_REVIEWED } from './deals.js';

const DEFAULT_CAMERA = { eye: { x: 1.7, y: -1.5, z: 0.9 } };

// Persistent user camera: `uirevision: 'keep-camera'` alone cannot preserve
// gl3d orientation here because every react supplies an explicit partial
// `scene.camera` (eye only). The Plotly `_preGUI` mechanism only restores
// leaf keys present before the drag (eye.*), so pan (center), tilt (up) and
// projection are lost, and recreating the scene for empty views drops even
// the eye. Instead track the full camera from the public `plotly_relayout` /
// `plotly_relayouting` events (full `scene.camera` on mouseup/wheel, partial
// `scene.camera.eye.x`-style keys elsewhere) and replay it on every react
// until explicit Reset. See plotly.js-gl3d-dist `scene.saveLayout` and
// `applyUIRevisions` (`/^(scene\d*)\.camera/`).
let storedCamera = null;
let cameraWired = false;
let renderSeq = 0;

function cloneCamera(cam) {
  return cam ? JSON.parse(JSON.stringify(cam)) : cam;
}

function isPlainCameraObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function camerasEqual(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function cameraForLayout() {
  return cloneCamera(storedCamera ?? DEFAULT_CAMERA);
}

function applyCameraEvent(eventData) {
  if (!eventData || typeof eventData !== 'object') return false;
  let changed = false;
  for (const key of Object.keys(eventData)) {
    if (!/^scene\d*\.camera$/.test(key)) continue;
    const full = eventData[key];
    if (!isPlainCameraObject(full)) continue;
    if (!isPlainCameraObject(storedCamera)) storedCamera = cloneCamera(DEFAULT_CAMERA);
    for (const k of Object.keys(full)) storedCamera[k] = cloneCamera(full[k]);
    changed = true;
  }
  for (const key of Object.keys(eventData)) {
    if (/^scene\d*\.camera$/.test(key)) continue;
    const m = key.match(/^scene\d*\.camera\.(.+)$/);
    if (!m) continue;
    const value = eventData[key];
    if (value === null || value === undefined) continue;
    if (!isPlainCameraObject(storedCamera)) storedCamera = cloneCamera(DEFAULT_CAMERA);
    const parts = m[1].split('.');
    let node = storedCamera;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!isPlainCameraObject(node[parts[i]])) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    if (isPlainCameraObject(value)) node[leaf] = cloneCamera(value);
    else if (['number', 'string', 'boolean'].includes(typeof value)) node[leaf] = value;
    else continue;
    changed = true;
  }
  return changed;
}

function handleCameraEvent(eventData) {
  if (!applyCameraEvent(eventData)) return;
  scheduleBoxCameraSync();
}

function wireCamera() {
  if (cameraWired) return;
  cameraWired = true;
  if (typeof els.chart.on === 'function') {
    els.chart.on('plotly_relayout', handleCameraEvent);
    els.chart.on('plotly_relayouting', handleCameraEvent);
  }
}

const els = {
  chart: document.getElementById('chart'),
  status: document.getElementById('status'),
  counts: document.getElementById('counts'),
  asof: document.getElementById('asof'),
  eraOptions: document.getElementById('era-options'),
  eraNote: document.getElementById('era-note'),
  speedMode: document.getElementById('speed-mode'),
  search: document.getElementById('search'),
  provider: document.getElementById('provider'),
  openOnly: document.getElementById('open-only'),
  hideRetired: document.getElementById('hide-retired'),
  frontierOnly: document.getElementById('frontier-only'),
  logScale: document.getElementById('log-scale'),
  dealsToggle: document.getElementById('deals-toggle'),
  dealsExcludeHigh: document.getElementById('deals-exclude-high'),
  dealsUtil: document.getElementById('deals-util'),
  dealsNote: document.getElementById('deals-note'),
  resetCamera: document.getElementById('reset-camera'),
  tbody: document.getElementById('model-tbody'),
  tableCount: document.getElementById('table-count'),
  thSpeed: document.getElementById('th-speed'),
};

const state = {
  payload: null,
  era: null,
  speedMode: 'time',
  query: '',
  providers: new Set(),
  openOnly: false,
  includeRetired: false,
  frontierOnly: false,
  // Log scale (on by default): cost and the active speed axis switch
  // between log and linear together; intelligence is always linear.
  logScale: true,
  // Subscription toggle only: direct Contributor estimates are always on.
  dealsEnabled: false,
  // High-tier exclusion: checked by default, filters $200+/mo subscription
  // estimates by monthly plan fee (Go stays: $10/mo plan, quota ≠ fee).
  excludeHighTiers: true,
  utilization: 1,
  sortKey: 'iq',
  sortDir: -1,
  webgl: true,
};

// Preferred-corner overlay: the green box lives in its own transparent
// Plotly gl3d layer stacked over the main chart with pointer-events:none,
// so it can never enter the main pick scene or block dot hover. Both layers
// share the exact camera, axis ranges, margins and cube aspect, synced via
// the stored camera (drag/zoom/pan/reset) and every render
// (search/deals/empty/resize). Only public Plotly newPlot/react/relayout/
// resize are used; no private pick-buffer patching.
let boxLayerDiv = null;
let boxRaf = 0;

function chartWrap() {
  if (els.chart.parentElement?.dataset?.chartWrap === '1') return els.chart.parentElement;
  return els.chart;
}

function ensureChartWrap() {
  const parent = els.chart.parentElement;
  if (parent?.dataset?.chartWrap === '1') return parent;
  const wrap = document.createElement('div');
  wrap.className = 'chart-wrap';
  wrap.dataset.chartWrap = '1';
  parent.insertBefore(wrap, els.chart);
  wrap.appendChild(els.chart);
  return wrap;
}

function ensureBoxLayer() {
  if (boxLayerDiv?.isConnected) return boxLayerDiv;
  const wrap = ensureChartWrap();
  let box = wrap.querySelector('#chart-box');
  if (!box) {
    box = document.createElement('div');
    box.id = 'chart-box';
    box.className = 'chart-box-overlay';
    box.setAttribute('aria-hidden', 'true');
    // Non-interactive layer: never tab-focusable, never announces.
    // `inert` removes the whole subtree from tab order/focus; tabindex -1
    // covers runtimes without inert support. Plotly children can set
    // pointer-events:auto, so CSS forces `.chart-box-overlay *` off too.
    try {
      box.setAttribute('inert', '');
    } catch {}
    try {
      box.tabIndex = -1;
    } catch {}
    box.style.pointerEvents = 'none';
    wrap.appendChild(box);
  } else {
    box.classList.add('chart-box-overlay');
    box.setAttribute('aria-hidden', 'true');
    try {
      box.setAttribute('inert', '');
    } catch {}
    try {
      box.tabIndex = -1;
    } catch {}
    box.style.pointerEvents = 'none';
  }
  boxLayerDiv = box;
  return box;
}

function hardenBoxLayer(box) {
  if (!box) return;
  try {
    box.setAttribute('aria-hidden', 'true');
  } catch {}
  try {
    box.setAttribute('inert', '');
  } catch {}
  try {
    box.tabIndex = -1;
  } catch {}
  try {
    box.style.pointerEvents = 'none';
  } catch {}
  // Plotly may inject modebar links/buttons even when disabled; keep them
  // unfocusable and hidden so the overlay never takes tab focus.
  try {
    for (const el of box.querySelectorAll('a, button, [tabindex], .modebar')) {
      try {
        el.setAttribute('aria-hidden', 'true');
      } catch {}
      try {
        el.tabIndex = -1;
      } catch {}
      if (el.classList?.contains('modebar')) {
        try {
          el.style.display = 'none';
        } catch {}
      }
    }
  } catch {}
}

function boxLayout(zMax, xRange, yRange, camera, logScale = true) {
  const axisType = logScale ? 'log' : 'linear';
  return {
    autosize: true,
    margin: { l: 0, r: 0, t: 30, b: 0 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    showlegend: false,
    hovermode: false,
    uirevision: 'keep-camera',
    scene: {
      camera: camera ?? cameraForLayout(),
      // Explicit cube + 1:1:1 ratio on both layers so the overlay box
      // aligns pixel-exact with the main scatter projection even if Plotly
      // auto aspect would otherwise depend on trace data.
      aspectmode: 'cube',
      aspectratio: { x: 1, y: 1, z: 1 },
      bgcolor: 'rgba(0,0,0,0)',
      dragmode: false,
      xaxis: {
        title: { text: '' },
        type: axisType,
        visible: false,
        showgrid: false,
        zeroline: false,
        showticklabels: false,
        ticks: '',
        showline: false,
        ...(xRange === undefined ? {} : { range: xRange }),
      },
      yaxis: {
        title: { text: '' },
        type: axisType,
        visible: false,
        showgrid: false,
        zeroline: false,
        showticklabels: false,
        ticks: '',
        showline: false,
        ...(yRange === undefined ? {} : { range: yRange }),
      },
      zaxis: {
        title: { text: '' },
        visible: false,
        showgrid: false,
        zeroline: false,
        showticklabels: false,
        ticks: '',
        showline: false,
        ...(zMax === undefined ? {} : { range: [0, zMax] }),
      },
    },
  };
}

function boxTraceFor(domainPoints, speedMode, zCeiling, logScale = true) {
  const trace = preferredCornerTrace(domainPoints, speedMode, zCeiling, logScale);
  if (!trace) return null;
  trace.showlegend = false;
  return trace;
}

async function renderBoxOverlay(domainPoints, speedMode, zMax, xRange, yRange, cameraSnapshot, hasPoints, logScale = true) {
  if (!state.webgl) return;
  let boxDiv;
  try {
    boxDiv = ensureBoxLayer();
  } catch {
    return;
  }
  // Empty views show no misleading box; collapsed era ranges also yield no
  // trace via preferredCornerBounds null. Ranges/camera still match main.
  const trace = hasPoints ? boxTraceFor(domainPoints, speedMode, zMax, logScale) : null;
  const data = trace ? [trace] : [];
  const boxConfig = { responsive: true, displaylogo: false, displayModeBar: false };
  try {
    await Plotly.react(boxDiv, data, boxLayout(zMax, xRange, yRange, cameraSnapshot, logScale), boxConfig);
    boxDiv.style.display = '';
    hardenBoxLayer(boxDiv);
  } catch {
    // Overlay failure (e.g. no WebGL) must never disable primary hover:
    // hide the layer and keep the main scatter interactive.
    try {
      boxDiv.style.display = 'none';
    } catch {}
  }
}

function syncBoxCameraNow() {
  boxRaf = 0;
  if (!state.webgl || !boxLayerDiv?.isConnected) return;
  try {
    const p = Plotly.relayout(boxLayerDiv, { 'scene.camera': cameraForLayout() });
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {}
}

function scheduleBoxCameraSync() {
  if (!state.webgl || !boxLayerDiv?.isConnected) return;
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    if (boxRaf) return;
    boxRaf = window.requestAnimationFrame(syncBoxCameraNow);
    return;
  }
  syncBoxCameraNow();
}

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}

function speedValue(m) {
  return m[SPEED_MODES[state.speedMode].key];
}

/**
 * Measured rows plus estimates: direct Contributor repricings are always on
 * (distinct token tariff, separate trace, never excluded); subscription
 * estimates (Go quota-equiv including compounded Contributor-via-Go, plus
 * the Claude Max / Codex / Cursor Ultra scenarios) join only when the
 * subscription toggle is on, minus $200+/mo plans while the exclusion is
 * checked (generic monthly-fee filter; Go stays at $10/mo). Estimates flow
 * through the same search/provider/era/retired/frontier filters; measured
 * rows are never mutated. Domains keep all tiers so this filter never
 * rescales the grid/camera.
 */
function combinedModels() {
  if (!state.payload) return [];
  const opts = { era: state.era, utilization: state.utilization };
  const contributor = buildContributorPoints(state.payload.models, opts);
  if (!state.dealsEnabled) return state.payload.models.concat(contributor);
  return state.payload.models.concat(
    contributor,
    buildSubscriptionPoints(state.payload.models, { ...opts, excludeHighTiers: state.excludeHighTiers }),
  );
}

function currentFilters() {
  return {
    era: state.era,
    query: state.query,
    providers: state.providers,
    openOnly: state.openOnly,
    includeRetired: state.includeRetired,
    frontierOnly: false,
    speedMode: state.speedMode,
  };
}

function hoverText(m) {
  if (m.deal) return dealHoverText(m);
  const timeLine = m.time_sec == null
    ? 'Time/task: n/a'
    : `Time/task: ${formatNum(m.time_sec)} s` +
      (m.time_observed ? ` (archived measurement ${escapeHtml(m.time_observed)})` : '');
  const lines = [
    `<b>${escapeHtml(m.name)}</b>`,
    `${escapeHtml(m.creator)} · released ${escapeHtml(m.release)}`,
    `Intelligence: ${formatNum(m.iq)}`,
    `Cost/task: ${formatUsd(m.cost)}`,
    timeLine,
    `Throughput: ${m.tps == null ? 'n/a' : `${formatNum(m.tps)} tok/s`}`,
    `TTFT: ${m.ttft == null ? 'n/a' : `${formatNum(m.ttft, 2)} s`}`,
    `${m.open ? 'Open weights' : 'Closed'} · ${m.retired ? 'retired' : 'live'}`,
  ];
  return lines.join('<br>');
}

/**
 * Hover text for a derived deal-estimate point. Labels the estimate kind,
 * the base measured cost, the pricing assumption and the inherited
 * intelligence/speed so it is never mistaken for an AA measurement.
 */
function dealHoverText(m) {
  const d = m.deal;
  const lines = [
    `<b>${escapeHtml(m.name)}</b>`,
    'Estimate — not an Artificial Analysis measurement',
    `Intelligence: ${formatNum(m.iq)} (inherited benchmark, not provider-measured)`,
    `Effective cost/task: ${formatUsd(m.cost)}`,
  ];
  if (d.kind === 'contributor') {
    lines.push(`Repriced from measured ${formatUsd(d.baseCost)} at Contributor token rates`);
    lines.push('Assumed 7:2:1 cached:input:output mix (no per-task token counts published)');
  } else if (d.kind === 'contributor-go') {
    const pct = Math.round(d.utilization * 100);
    lines.push(`Compounded: Contributor ${formatUsd(d.contributorCost)} × $10 / ($${d.tier} tier × ${pct}% use)`);
    lines.push('Two stacked estimates; assumes benchmark cost at Go rates');
  } else if (d.kind === 'claude-max') {
    const pct = Math.round(d.utilization * 100);
    lines.push(`Claude Max $${d.fee} lab-wide workload proxy: measured ${formatUsd(d.baseCost)} / (~${d.multiplier}x × ${pct}% use)`);
    lines.push('Full-use empirical saturation (SemiAnalysis June 2026, weekly caps exhausted; July audit ≥39x lower bound)');
    lines.push('Not the plan-official 5x/20x labels; scenario workload, no guaranteed current capacity');
  } else if (d.kind === 'codex') {
    const pct = Math.round(d.utilization * 100);
    lines.push(`ChatGPT Pro/Codex $${d.fee} lab-wide workload proxy: measured ${formatUsd(d.baseCost)} / (~${d.multiplier}x × ${pct}% use)`);
    lines.push('Full-use empirical saturation (SemiAnalysis June 2026; Aug audit 29.81x is a lower bound, not plotted)');
    lines.push('Not the plan-official 5x/20x labels; scenario workload, no guaranteed current capacity');
  } else if (d.kind === 'claude-pro' || d.kind === 'codex-plus') {
    const pct = Math.round(d.utilization * 100);
    const plan = d.kind === 'claude-pro' ? 'Claude Pro' : 'ChatGPT Plus/Codex';
    const parent = d.kind === 'claude-pro' ? 'Claude Max' : 'ChatGPT Pro/Codex';
    lines.push(`${plan} $${d.fee} est.: measured ${formatUsd(d.baseCost)} / (~${d.multiplier}x × ${pct}% use)`);
    lines.push(`User-assumed half efficiency per dollar of the $200 ${parent} proxy; no new audit or measured ratio`);
    lines.push('Scenario workload, no guaranteed current capacity');
  } else if (d.kind === 'cursor-ultra') {
    const pct = Math.round(d.utilization * 100);
    lines.push(`Cursor Ultra $${d.fee} third-party allowance est.: measured ${formatUsd(d.baseCost)} / (~${d.multiplier}x × ${pct}% use)`);
    lines.push('Last-published $400 pool basis thru Aug 2026; current pool size unverified (docs only say “Included”)');
    lines.push('Claude/GPT/Gemini pool rows only (Fable via this pool); Meta/Grok/Composer pools excluded');
  } else {
    const pct = Math.round(d.utilization * 100);
    lines.push(`Quota-equiv: measured ${formatUsd(d.baseCost)} × $10 / ($${d.tier} tier × ${pct}% use)`);
    lines.push('Assumes benchmark cost meters at Go rates; full budget on this tier');
    if (d.promoActive) lines.push('Includes limited-time 4x promo quota (ends 2026-09-28 UTC)');
  }
  lines.push(`Time/task: ${m.time_sec == null ? 'n/a' : `${formatNum(m.time_sec)} s`} (inherited)`);
  lines.push(`Throughput: ${m.tps == null ? 'n/a' : `${formatNum(m.tps)} tok/s`} (inherited)`);
  lines.push(`${m.open ? 'Open weights' : 'Closed'} · ${m.retired ? 'retired' : 'live'}`);
  return lines.join('<br>');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
  );
}

/**
 * Custom hover card: Plotly gl3d has no public hover-card offset, so traces
 * use `hoverinfo: 'none'` (still fires hover events) and this HTML tooltip
 * renders the same escaped hover HTML offset from the anchor with a CSS
 * corner pointer at the corner nearest the dot.
 */
let hoverTip = null;
let lastCursor = null;
let lastTraceData = [];
let hoverWired = false;

function ensureHoverTooltip() {
  if (hoverTip && hoverTip.isConnected) return hoverTip;
  // Host the card in the chart wrap (above the pointer-events:none box
  // overlay) so the overlay never clips it; coordinates still match the
  // chart rect because the wrap tightly contains the chart.
  const host = chartWrap();
  hoverTip = document.getElementById('chart-hover-tooltip');
  if (!hoverTip) {
    hoverTip = document.createElement('div');
    hoverTip.id = 'chart-hover-tooltip';
    hoverTip.className = 'chart-hover-tooltip chart-hover-arrow';
    hoverTip.dataset.placement = 'bottom-right';
    hoverTip.hidden = true;
    hoverTip.setAttribute('aria-hidden', 'true');
    // Never intercepts hover; screen-reader users use the data table.
    hoverTip.style.pointerEvents = 'none';
    host.appendChild(hoverTip);
  } else {
    hoverTip.classList.add('chart-hover-tooltip', 'chart-hover-arrow');
    hoverTip.style.pointerEvents = 'none';
    if (hoverTip.dataset.placement !== undefined && !hoverTip.dataset.placement) hoverTip.dataset.placement = 'bottom-right';
    if (hoverTip.parentElement !== host) host.appendChild(hoverTip);
  }
  return hoverTip;
}

function hideHoverTooltip() {
  if (!hoverTip) return;
  hoverTip.hidden = true;
  hoverTip.setAttribute('aria-hidden', 'true');
}

function hoverHtmlForPoint(point) {
  if (!point) return null;
  const idx = point.pointNumber;
  // Preferred: the trace payload Plotly passes with the event (public
  // `fullData.text[pointNumber]`), preserving the exact escaped hover HTML.
  const viaFull = point.fullData?.text;
  if (Array.isArray(viaFull) && Number.isInteger(idx) && typeof viaFull[idx] === 'string') {
    return viaFull[idx];
  }
  // Fallback for minimal event payloads: the last rendered trace data kept
  // alongside render (same `text` arrays, indexed by public curveNumber).
  const trace = lastTraceData[point.curveNumber];
  const viaLast = trace?.text;
  if (Array.isArray(viaLast) && Number.isInteger(idx) && typeof viaLast[idx] === 'string') {
    return viaLast[idx];
  }
  return null;
}

function showHoverTooltip(eventData) {
  const tip = ensureHoverTooltip();
  const point = eventData?.points?.[0];
  const html = hoverHtmlForPoint(point);
  const rect = els.chart.getBoundingClientRect();
  const cursor = lastCursor
    ? { x: lastCursor.clientX - rect.left, y: lastCursor.clientY - rect.top }
    : null;
  // Prefer the event bbox dot anchor; cursor fallback stays near the dot
  // since hover fires at the cursor (also covers jsdom/tests without bbox).
  const anchor = resolveHoverAnchor(point, rect, cursor);
  if (!html || !anchor) {
    hideHoverTooltip();
    return;
  }
  tip.innerHTML = html;
  tip.hidden = false;
  tip.setAttribute('aria-hidden', 'false');
  const { left, top, placement } = computeHoverTooltipPosition({
    cursorX: anchor.x,
    cursorY: anchor.y,
    containerWidth: rect.width,
    containerHeight: rect.height,
    tooltipWidth: tip.offsetWidth || 0,
    tooltipHeight: tip.offsetHeight || 0,
    offset: HOVER_TOOLTIP_OFFSET,
  });
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.dataset.placement = placement;
}

function wireHoverTooltip() {
  ensureHoverTooltip();
  if (hoverWired) return;
  hoverWired = true;
  els.chart.addEventListener('mousemove', (e) => {
    lastCursor = { clientX: e.clientX, clientY: e.clientY };
  });
  els.chart.addEventListener('mouseleave', hideHoverTooltip);
  // Public Plotly hover events (fired even with hoverinfo 'none').
  if (typeof els.chart.on === 'function') {
    els.chart.on('plotly_hover', showHoverTooltip);
    els.chart.on('plotly_unhover', hideHoverTooltip);
  }
}

function layout(zMax, subscriptionOn = false, xRange, yRange, camera) {
  const mode = SPEED_MODES[state.speedMode];
  const scaleWord = state.logScale ? 'log' : 'linear';
  const axisType = state.logScale ? 'log' : 'linear';
  const yTitle =
    state.speedMode === 'time'
      ? `Time per task, s (${scaleWord}, lower is better)`
      : `Throughput, tok/s (${scaleWord}, higher is better)`;
  // Contributor estimates are always plotted (distinct token tariff); the
  // subscription toggle only adds subscription estimates on top.
  const xTitle = subscriptionOn
    ? `Cost per task, USD (${scaleWord}; Contributor + subscription estimates)`
    : `Cost per task, USD (${scaleWord}; Contributor estimates)`;
  return {
    autosize: true,
    margin: { l: 0, r: 0, t: 30, b: 0 },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: '#e8ecf3', size: 11 },
    showlegend: true,
    legend: { x: 0, y: 1 },
    uirevision: 'keep-camera',
    scene: {
      camera: camera ?? cameraForLayout(),
      // Cube aspect on both layers so the overlay box aligns pixel-exact
      // with the main scatter projection; ranges still carry the grid.
      // Explicit 1:1:1 ratio guards against auto aspect depending on data.
      aspectmode: 'cube',
      aspectratio: { x: 1, y: 1, z: 1 },
      xaxis: {
        // Plotly gl3d scene axes require the object form; a plain string
        // renders the literal axis name ("x"/"z").
        title: { text: xTitle },
        type: axisType,
        color: '#9aa4b5',
        gridcolor: '#263042',
        ...(xRange === undefined ? {} : { range: xRange }),
      },
      yaxis: {
        title: { text: yTitle, font: { color: mode.lowerIsBetter ? '#9aa4b5' : '#80ed99' } },
        type: axisType,
        color: '#9aa4b5',
        gridcolor: '#263042',
        ...(yRange === undefined ? {} : { range: yRange }),
      },
      zaxis: {
        title: { text: 'Intelligence index' },
        color: '#9aa4b5',
        gridcolor: '#263042',
        ...(zMax === undefined ? {} : { range: [0, zMax] }),
      },
    },
  };
}

function preferredCornerTrace(domainPoints, speedMode, zCeiling, logScale = true) {
  const bounds = preferredCornerBounds(domainPoints, speedMode, zCeiling, logScale);
  if (!bounds) return null;
  const [x0, x1] = bounds.x;
  const [y0, y1] = bounds.y;
  const [z0, z1] = bounds.z;
  return {
    name: PREFERRED_CORNER_NAME,
    type: 'mesh3d',
    x: [x0, x1, x1, x0, x0, x1, x1, x0],
    y: [y0, y0, y1, y1, y0, y0, y1, y1],
    z: [z0, z0, z0, z0, z1, z1, z1, z1],
    i: [0, 0, 4, 4, 0, 0, 3, 3, 0, 0, 1, 1],
    j: [1, 2, 5, 6, 1, 5, 2, 6, 3, 7, 2, 6],
    k: [2, 3, 6, 7, 5, 4, 6, 7, 7, 4, 6, 5],
    color: '#22c55e',
    opacity: 0.15,
    flatshading: true,
    hoverinfo: 'skip',
    showlegend: true,
  };
}

function traces(shown, frontier, colors) {
  const frontierIds = new Set(frontier.map((m) => m.id));
  // Estimates stay in their own labeled traces even when they land on the
  // frontier, so measured points and estimates are never mixed. Contributor
  // (distinct token tariff) is separate from the subscription offers, and
  // each subscription offer gets its own trace (same lab colors, same round
  // markers) so billing offers stay distinguishable by label/legend/hover
  // under the single subscription toggle. All markers are round circles:
  // no diamond/square/cross/x glyphs.
  const contributorShown = shown.filter((m) => m.deal?.kind === 'contributor');
  const goShown = shown.filter((m) => m.deal?.kind === 'go' || m.deal?.kind === 'contributor-go');
  const claudeMaxShown = shown.filter((m) => m.deal?.kind === 'claude-max');
  const codexShown = shown.filter((m) => m.deal?.kind === 'codex');
  const claudeProShown = shown.filter((m) => m.deal?.kind === 'claude-pro');
  const codexPlusShown = shown.filter((m) => m.deal?.kind === 'codex-plus');
  const cursorUltraShown = shown.filter((m) => m.deal?.kind === 'cursor-ultra');
  const rest = shown.filter((m) => !m.deal && !frontierIds.has(m.id));
  const front = shown.filter((m) => !m.deal && frontierIds.has(m.id));
  const colorOf = (m) => colors.get(m.creator) ?? '#888';

  // One estimate trace per billing offer: same lab colors and same round
  // size as the Models trace; the trace label + hover carry the meaning.
  function estimateTrace(name, points) {
    return {
      name,
      type: 'scatter3d',
      mode: 'markers',
      x: points.map((m) => m.cost),
      y: points.map((m) => speedValue(m)),
      z: points.map((m) => m.iq),
      text: points.map(hoverText),
      hoverinfo: 'none',
      marker: {
        size: 4,
        opacity: 0.9,
        color: points.map(colorOf),
        line: { color: '#ffffff', width: 1 },
      },
    };
  }

  const data = [
    {
      name: 'Models',
      type: 'scatter3d',
      mode: 'markers',
      x: rest.map((m) => m.cost),
      y: rest.map((m) => speedValue(m)),
      z: rest.map((m) => m.iq),
      text: rest.map(hoverText),
      // Public hide for the centered built-in card (still fires hover events
      // for the offset HTML tooltip). See ensureHoverTooltip above.
      hoverinfo: 'none',
      marker: {
        size: 4,
        opacity: 0.75,
        color: rest.map(colorOf),
        // Light outline keeps dark brand fills (OpenAI, Inception) readable
        // on the dark background without changing the fill itself.
        line: { color: 'rgba(232,236,243,0.9)', width: 0.75 },
      },
    },
    {
      name: 'Pareto frontier',
      type: 'scatter3d',
      mode: 'markers',
      x: front.map((m) => m.cost),
      y: front.map((m) => speedValue(m)),
      z: front.map((m) => m.iq),
      text: front.map(hoverText),
      hoverinfo: 'none',
      marker: {
        size: 7,
        opacity: 1,
        color: front.map(colorOf),
        line: { color: '#ffffff', width: 1 },
      },
    },
  ];
  // Main plot holds scatter only: the green box lives in the separate
  // pointer-events:none overlay so it can never occlude picks.
  if (contributorShown.length) {
    data.push(estimateTrace(CONTRIBUTOR_TRACE_NAME, contributorShown));
  }
  if (goShown.length) {
    data.push(estimateTrace(GO_TRACE_NAME, goShown));
  }
  if (claudeMaxShown.length) {
    data.push(estimateTrace(CLAUDE_MAX_TRACE_NAME, claudeMaxShown));
  }
  if (codexShown.length) {
    data.push(estimateTrace(CODEX_TRACE_NAME, codexShown));
  }
  if (claudeProShown.length) {
    data.push(estimateTrace(CLAUDE_PRO_TRACE_NAME, claudeProShown));
  }
  if (codexPlusShown.length) {
    data.push(estimateTrace(CODEX_PLUS_TRACE_NAME, codexPlusShown));
  }
  if (cursorUltraShown.length) {
    data.push(estimateTrace(CURSOR_ULTRA_TRACE_NAME, cursorUltraShown));
  }
  return data;
}

async function render() {
  if (!state.payload) return;
  const myRender = ++renderSeq;
  const cameraSnapshot = cameraForLayout();
  // Filtering invalidates any visible hover card for a stale point.
  hideHoverTooltip();
  const eraModels = state.payload.models.filter((m) => m.era === state.era);
  const combined = combinedModels();
  const base = filterModels(combined, currentFilters());
  const tableBase = filterModels(combined, {
    ...currentFilters(),
    requireSpeed: false,
  });
  const frontier = paretoFrontier(base, state.speedMode);
  const frontierIds = new Set(frontier.map((m) => m.id));
  const shown = state.frontierOnly ? base.filter((m) => frontierIds.has(m.id)) : base;
  const tableShown = state.frontierOnly
    ? tableBase.filter((m) => frontierIds.has(m.id))
    : tableBase;
  const colors = buildProviderColors(eraModels.map((m) => m.creator));
  // Fixed grid: domains span the full era population (measured plus eligible
  // Contributor and Go estimates at the active utilization, including
  // retired) before any search/provider/open/retired/frontier filtering, so
  // the axes and the green box stay put while the plotted subset changes.
  // Toggling subscription estimates never rescales (they stay in the
  // domain). Switching speed recomputes y in the new units; switching eras
  // re-scopes everything.
  const now = Date.now();
  const domains = eraChartDomains(state.payload.models, {
    era: state.era,
    speedMode: state.speedMode,
    utilization: state.utilization,
    now,
    logScale: state.logScale,
  });
  const domainForBox = eraDomainPoints(state.payload.models, {
    era: state.era,
    utilization: state.utilization,
    now,
  });
  const zMax = domains.zMax;
  const xRange = domains.xRange;
  const yRange = domains.yRange;

  // Counts and the data table always update, even when WebGL is unavailable.
  const live = eraModels.filter((m) => !m.retired).length;
  const nContributor = shown.filter((m) => m.deal?.kind === 'contributor').length;
  const nSubscription = shown.filter((m) => m.deal && m.deal.kind !== 'contributor').length;
  els.counts.textContent =
    `${shown.length} plotted · ${tableBase.length} in era (${live} live) · ${frontier.length} frontier` +
    ` · ${nContributor} Contributor estimates` +
    (state.dealsEnabled ? ` · ${nSubscription} subscription estimates` : '');
  renderTable(tableShown, frontierIds);
  if (!state.webgl) return;

  if (!shown.length) {
    const modeLabel = SPEED_MODES[state.speedMode]?.label ?? 'Speed';
    setStatus(
      tableShown.length
        ? `No plotted points for ${modeLabel} in this era (no ${modeLabel.toLowerCase()} measurements under the current filters). Cost and intelligence are still listed below.`
        : 'No models match the current filters. Loosen the search or provider selection.',
    );
    // Empty views keep the fixed era grid (no misleading box) so the empty
    // state stays accurate while the axes do not rescale. Camera persists.
    lastTraceData = [];
    await Plotly.react(els.chart, [], layout(zMax, state.dealsEnabled, xRange, yRange, cameraSnapshot), { responsive: true, displaylogo: false });
    await renderBoxOverlay(domainForBox, state.speedMode, zMax, xRange, yRange, cameraSnapshot, false, state.logScale);
  } else {
    setStatus('');
    try {
      // Main plot holds scatter only; the green box is overlay-only so it
      // can never occlude picks. The box still marks the full era domain
      // (measured + eligible deals, including retired) and reaches the
      // fixed intelligence ceiling.
      const traceData = traces(shown, frontier, colors);
      lastTraceData = traceData;
      await Plotly.react(els.chart, traceData, layout(zMax, state.dealsEnabled, xRange, yRange, cameraSnapshot), {
        responsive: true,
        displaylogo: false,
      });
    } catch (e) {
      state.webgl = false;
      els.chart.style.display = 'none';
      setStatus(
        'Interactive 3D is unavailable in this browser (WebGL failed). The full data table below remains available.',
        true,
      );
      return;
    }
    await renderBoxOverlay(domainForBox, state.speedMode, zMax, xRange, yRange, cameraSnapshot, true, state.logScale);
  }
  // A drag/reset during this async react would otherwise be overwritten by
  // the stale snapshot. Re-apply the latest stored camera when this is still
  // the newest render; the relayout echo carries the same value, so the
  // camera handler stays idempotent and no loop occurs. Both layers move
  // together; overlay failure never touches the main camera.
  if (state.webgl && myRender === renderSeq && !camerasEqual(cameraSnapshot, storedCamera ?? DEFAULT_CAMERA)) {
    try {
      const latest = cameraForLayout();
      const p = Plotly.relayout(els.chart, { 'scene.camera': latest });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
    try {
      if (boxLayerDiv?.isConnected) {
        const p2 = Plotly.relayout(boxLayerDiv, { 'scene.camera': cameraForLayout() });
        if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
      }
    } catch {}
  }
}

function renderTable(shown, frontierIds) {
  const key = state.sortKey;
  const dir = state.sortDir;
  const val = (m) => {
    if (key === 'deal') return dealLabel(m.deal);
    if (key === 'speed') return speedValue(m);
    if (key === 'open' || key === 'retired') return m[key] ? 1 : 0;
    return m[key];
  };
  const rows = [...shown].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * (va - vb);
  });
  els.tableCount.textContent = `(${rows.length})`;
  els.thSpeed.textContent = state.speedMode === 'time' ? 'Time / task' : 'Throughput';
  els.tbody.innerHTML = rows
    .map((m) => {
      const speedObserved = state.speedMode === 'time' && m.time_sec != null && m.time_observed
        ? ` (${m.time_observed})`
        : '';
      const speedTitle = speedObserved
        ? `Archived speed measurement observed ${m.time_observed}; archived times are sparse and not synchronized to the snapshot date.`
        : '';
      const speed =
        state.speedMode === 'time'
          ? m.time_sec == null ? 'n/a' : `${formatNum(m.time_sec)} s${speedObserved}`
          : m.tps == null ? 'n/a' : `${formatNum(m.tps)} tok/s`;
      const terms = dealLabel(m.deal);
      return `<tr class="${frontierIds.has(m.id) ? 'frontier-row' : ''}${m.deal ? ' deal-row' : ''}">` +
        `<td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.creator)}</td>` +
        `<td class="num">${escapeHtml(m.release)}</td><td class="num">${formatNum(m.iq)}</td>` +
        `<td class="num">${formatUsd(m.cost)}</td>` +
        `<td title="${escapeHtml(dealAssumption(m.deal))}">${escapeHtml(terms)}</td>` +
        `<td class="num"${speedTitle ? ` title="${escapeHtml(speedTitle)}"` : ''}>${escapeHtml(speed)}</td>` +
        `<td class="num">${m.tps == null ? 'n/a' : formatNum(m.tps)}</td>` +
        `<td>${m.open ? 'yes' : 'no'}</td><td>${m.retired ? 'retired' : 'live'}</td></tr>`;
    })
    .join('');
}

function buildEraOptions() {
  els.eraOptions.innerHTML = '';
  for (const era of state.payload.eras) {
    const id = `era-${era.index}`;
    const label = document.createElement('label');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'era';
    radio.id = id;
    radio.value = String(era.index);
    radio.checked = era.index === state.era;
    radio.addEventListener('change', () => {
      state.era = era.index;
      // Keep valid provider selections across eras; buildProviderOptions
      // prunes providers missing from the new era so none go stale.
      buildProviderOptions();
      syncEraDependentControls();
      updateEraNote();
      render();
    });
    label.append(radio, document.createTextNode(` ${era.label}`));
    els.eraOptions.append(label);
  }
}

function updateEraNote() {
  const era = state.payload.eras.find((e) => e.index === state.era);
  const base = era?.note ?? '';
  // Archive eras read fully retired today; that is current status, not
  // historical availability — the models below were measured live in-era.
  const eraModels = state.payload.models.filter((m) => m.era === state.era);
  const archived = eraModels.length > 0 && eraModels.every((m) => m.retired);
  els.eraNote.textContent = archived && base
    ? `${base} All rows in this era read retired today (current status); they were available historically.`
    : base;
}

/**
 * Era-dependent control sync, run on era selection and startup (camera is
 * untouched: this only flips control state before the next render).
 * Archive eras hold only retired-today rows, so hiding retired would empty
 * them: reveal history by clearing the hide-retired checkbox. The
 * throughput metric is disabled while the selected era has no throughput
 * measurements, falling back to time so the archive stays usable.
 */
function syncEraDependentControls() {
  if (!state.payload) return;
  const eraModels = state.payload.models.filter((m) => m.era === state.era);
  if (eraModels.length > 0 && eraModels.every((m) => m.retired)) {
    state.includeRetired = true;
    if (els.hideRetired) els.hideRetired.checked = false;
  }
  const hasThroughput = eraModels.some((m) => Number.isFinite(m.tps) && m.tps > 0);
  const tpsOption = els.speedMode?.querySelector('option[value="throughput"]');
  if (tpsOption) tpsOption.disabled = !hasThroughput;
  if (!hasThroughput && state.speedMode === 'throughput') {
    state.speedMode = 'time';
    if (els.speedMode) els.speedMode.value = 'time';
  }
}

function syncProviderSelection() {
  if (!els.provider) return;
  for (const opt of els.provider.options) {
    opt.selected = opt.value === '' ? state.providers.size === 0 : state.providers.has(opt.value);
  }
}

function buildProviderOptions() {
  const eraModels = filterModels(state.payload.models, {
    ...currentFilters(),
    providers: new Set(),
    query: '',
    openOnly: false,
    includeRetired: true,
    // List every era provider even without the active speed metric so
    // table-only rows (e.g. archive models missing throughput) stay selectable.
    requireSpeed: false,
  });
  const summary = providerSummary(eraModels);
  const keep = new Set([...state.providers].filter((p) => summary.some((s) => s.creator === p)));
  state.providers = keep;
  els.provider.innerHTML = '';
  // Leading sentinel: selected exactly when no provider filter is active.
  // Native multi-select semantics are kept (arrow keys + Space toggle, full
  // screen-reader listbox behavior); single clicks toggle via mousedown below
  // so no ctrl key is ever needed.
  const all = document.createElement('option');
  all.value = '';
  all.textContent = `All providers (${eraModels.length})`;
  all.selected = keep.size === 0;
  els.provider.append(all);
  for (const { creator, count } of summary) {
    const opt = document.createElement('option');
    opt.value = creator;
    opt.textContent = `${creator} (${count})`;
    opt.selected = keep.has(creator);
    els.provider.append(opt);
  }
}

function wireControls() {
  els.speedMode.addEventListener('change', () => {
    state.speedMode = els.speedMode.value;
    render();
  });
  let debounce;
  els.search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = els.search.value;
      render();
    }, 150);
  });
  els.provider.addEventListener('mousedown', (e) => {
    // Single-click toggling without ctrl: prevent the native behavior
    // (which cannot deselect the last selected option with one click) and
    // flip just the clicked option, keeping the native listbox, keyboard
    // (arrows + Space) and screen-reader semantics intact.
    const target = e.target;
    if (!target || target.tagName !== 'OPTION') return;
    e.preventDefault();
    const value = target.value;
    if (value === '') state.providers.clear();
    else if (state.providers.has(value)) state.providers.delete(value);
    else state.providers.add(value);
    syncProviderSelection();
    render();
  });
  els.provider.addEventListener('change', () => {
    // Keyboard/shift selection path (Space toggles natively): translate the
    // native selection into filter state. The All sentinel reflects an empty
    // filter — selected alone it clears, alongside others it yields to them.
    const selected = [...els.provider.selectedOptions].map((o) => o.value);
    if (selected.includes('') && selected.length > 1) {
      state.providers = new Set(selected.filter((v) => v !== ''));
    } else if (selected.length === 1 && selected[0] === '') {
      state.providers.clear();
    } else {
      state.providers = new Set(selected.filter((v) => v !== ''));
    }
    syncProviderSelection();
    render();
  });
  els.openOnly.addEventListener('change', () => {
    state.openOnly = els.openOnly.checked;
    render();
  });
  els.hideRetired.addEventListener('change', () => {
    state.includeRetired = !els.hideRetired.checked;
    render();
  });
  els.frontierOnly.addEventListener('change', () => {
    state.frontierOnly = els.frontierOnly.checked;
    render();
  });
  els.logScale?.addEventListener('change', () => {
    state.logScale = els.logScale.checked;
    render();
  });
  els.dealsToggle?.addEventListener('change', () => {
    state.dealsEnabled = els.dealsToggle.checked;
    render();
  });
  els.dealsExcludeHigh?.addEventListener('change', () => {
    state.excludeHighTiers = els.dealsExcludeHigh.checked;
    render();
  });
  els.dealsUtil?.addEventListener('change', () => {
    state.utilization = parseUtilizationPercent(els.dealsUtil.value);
    els.dealsUtil.value = String(Math.round(state.utilization * 100));
    render();
  });
  els.resetCamera.addEventListener('click', () => {
    storedCamera = cloneCamera(DEFAULT_CAMERA);
    if (state.webgl) {
      try {
        const p = Plotly.relayout(els.chart, { 'scene.camera': cloneCamera(DEFAULT_CAMERA) });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {}
      try {
        if (boxLayerDiv?.isConnected) {
          const p2 = Plotly.relayout(boxLayerDiv, { 'scene.camera': cloneCamera(DEFAULT_CAMERA) });
          if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
        }
      } catch {}
    }
  });
  document.querySelectorAll('#model-table th').forEach((th) => {
    th.tabIndex = 0;
    const activate = () => {
      const k = th.dataset.key;
      if (state.sortKey === k) state.sortDir *= -1;
      else {
        state.sortKey = k;
        state.sortDir = k === 'name' || k === 'creator' ? 1 : -1;
      }
      const tableBase = filterModels(combinedModels(), {
        ...currentFilters(),
        requireSpeed: false,
      });
      const base = filterModels(combinedModels(), currentFilters());
      const frontier = paretoFrontier(base, state.speedMode);
      const frontierIds = new Set(frontier.map((m) => m.id));
      const tableShown = state.frontierOnly
        ? tableBase.filter((m) => frontierIds.has(m.id))
        : tableBase;
      renderTable(tableShown, frontierIds);
    };
    th.addEventListener('click', activate);
    th.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });
  window.addEventListener('resize', () => {
    if (!state.webgl || !state.payload) return;
    try {
      const p = Plotly.Plots.resize(els.chart);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {}
    try {
      if (boxLayerDiv?.isConnected) {
        const p2 = Plotly.Plots.resize(boxLayerDiv);
        if (p2 && typeof p2.catch === 'function') p2.catch(() => {});
      }
    } catch {}
  });
}

async function init() {
  wireControls();
  setStatus('Loading model data…');
  const dataUrl = resolveDataUrl(document.baseURI);
  let res;
  try {
    res = await fetch(dataUrl);
  } catch {
    setStatus(`Could not load ${dataUrl}. Serve the site over HTTP (npm run dev) or check the connection.`, true);
    return;
  }
  if (!res.ok) {
    setStatus(`Could not load model data (HTTP ${res.status}).`, true);
    return;
  }
  try {
    state.payload = await res.json();
  } catch {
    setStatus('Could not parse model data as JSON. The snapshot may be corrupt; try refreshing.', true);
    return;
  }
  if (!state.payload?.models?.length) {
    setStatus('Model data is empty.', true);
    return;
  }
  state.includeRetired = !els.hideRetired.checked;
  state.dealsEnabled = els.dealsToggle?.checked ?? false;
  state.excludeHighTiers = els.dealsExcludeHigh?.checked ?? false;
  state.logScale = els.logScale?.checked ?? true;
  state.utilization = parseUtilizationPercent(els.dealsUtil?.value ?? '100');
  if (els.dealsNote) {
    els.dealsNote.textContent =
      `Contributor always on; subscription estimates off by default. Curated ${DEALS_REVIEWED} from Meta/OpenCode Go docs; scenarios from June 2026 audits.`;
  }
  state.era = Math.max(...state.payload.eras.map((e) => e.index));
  buildEraOptions();
  syncEraDependentControls();
  updateEraNote();
  buildProviderOptions();
  const updated = state.payload.source_updated ?? 'unknown date';
  const fetched = (state.payload.fetched_at ?? '').slice(0, 10);
  els.asof.textContent = `source updated ${updated} · snapshot ${fetched}`;
  setStatus('');
  // Wrap first so the hover card hosts above the pointer-events:none overlay
  // and coordinates still match the chart rect (wrap tightly contains chart).
  try {
    ensureChartWrap();
  } catch {}
  try {
    await Plotly.newPlot(els.chart, [], layout(), { responsive: true, displaylogo: false });
    wireHoverTooltip();
    // Re-ensure the card lives in the wrap (above the overlay) after the
    // wrap exists; coordinates still match the chart rect.
    try {
      ensureHoverTooltip();
    } catch {}
    wireCamera();
  } catch {
    state.webgl = false;
    els.chart.style.display = 'none';
    setStatus(
      'Interactive 3D is unavailable in this browser (WebGL failed). The full data table below remains available.',
      true,
    );
  }
  await render();
}

init();
