/* PowerPlayAI · Community Results — dashboard v3
   Reads GET /stats (legacy shape + v3 block) and GET /subscription-events from
   the Cloudflare worker and renders six chapters. Every section renders inside
   its own try/catch so a malformed block never blanks the page. Strings that
   come from the API only ever reach the DOM through textContent. */
(() => {
'use strict';

// ============================================================================
// Config
// ============================================================================
const WORKER = 'https://powerplayai-api.colsonrice.workers.dev';
const params = new URLSearchParams(location.search);
// Dev override: ?api=./fixture-v3.json loads stats from a fixture. When api is
// overridden and subs is not, the Apple block shows a "not loaded" state instead
// of hitting production.
const API_URL = params.get('api') || `${WORKER}/stats`;
const SUBS_URL = params.get('subs') || (params.get('api') ? null : `${WORKER}/subscription-events`);
const REFRESH_MS = 300000;               // the worker's edge cache is 5 minutes
// Live comparisons remain descriptive; no automatic pair-count verdict.
const V3_SINCE = '2026-09-10';           // first day v3 rows landed in production

const LOTTERIES = ['powerball', 'megaMillions', 'euroMillions'];
const LOTTERY_NAME = { powerball: 'Powerball', megaMillions: 'Mega Millions', euroMillions: 'EuroMillions' };
const LOTTERY_CHIP = { powerball: 'pb', megaMillions: 'mm', euroMillions: 'em' };
const LOTTERY_BRAND = { powerball: '#e4342b', megaMillions: '#f5b301', euroMillions: '#3987e5' };
const POOL = { powerball: 69, megaMillions: 70, euroMillions: 50 };
const SPECIAL_POOL = { powerball: 26, megaMillions: 24 };          // Mega Ball pool is 24 since April 2025
const CURRENCY = { powerball: 'USD', megaMillions: 'USD', euroMillions: 'EUR' };

const MODEL_ORDER = ['enhanced', 'base', 'quantum', 'randomBalanced', 'nexus', 'bayesian', 'adaptiveAI'];
const MODEL_NAME = {
  enhanced: 'Neuron', base: 'Base', quantum: 'Quantum', randomBalanced: 'Random Balanced',
  nexus: 'Nexus', bayesian: 'Bayesian', adaptiveAI: 'Adaptive', control: 'Paired random',
};
const MODEL_HINT = { enhanced: 'Neuron (the Enhanced tier engine)' };

// Colors. Categorical order validated with the dataviz palette validator (dark
// surface #14141f, all checks pass). Models and games are fixed to entities.
const INK = '#f2f1f7', MUTED = '#8b8ba3', FAINT = '#5b5b73', SURFACE = '#14141f', GRID = '#24243a';
const ACCENT = '#8b7bff', GOLD = '#f2c14e';
const CAT = ['#8b7bff', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#3987e5', '#e66767'];
const OTHER = '#5b5b73';
const MODEL_COLOR = { enhanced: '#8b7bff', base: '#d95926', quantum: '#199e70', randomBalanced: '#c98500', nexus: '#d55181', bayesian: '#008300', adaptiveAI: '#3987e5', control: '#8b8ba3' };
const GAME_COLOR = { powerball: '#d55181', megaMillions: '#c98500', euroMillions: '#3987e5' };
const STATUS = { good: '#0ca30c', warn: '#fab219', serious: '#ec835a', crit: '#d03b3b' };
const ORDINAL = (n) => Array.from({ length: n }, (_, i) => `rgba(139,123,255,${(0.28 + 0.72 * (n === 1 ? 1 : i / (n - 1))).toFixed(2)})`);

// The worker's whitelist (EVENT_SPEC), for the coverage block.
const EVENT_CATALOG = [
  'first_open', 'onboarding_done', 'session_start', 'forecast_generated', 'reveal', 'numbers_copied', 'share', 'share_completed',
  'paywall_view', 'paywall_dismiss', 'purchase_started', 'purchase_completed', 'purchase_failed', 'purchase_cancelled', 'purchase_pending',
  'subscribe', 'restore_started', 'restore_completed', 'restore_empty', 'restore_failed', 'model_chooser_opened', 'enhanced_viewed',
  'evidence_opened', 'quantum_details_opened', 'model_selected', 'notif_optin', 'notif_scheduled', 'notif_opened', 'notif_disabled_in_app',
  'notif_enabled_in_app', 'notif_scheduled_unique', 'notif_opened_unique', 'screen_view', 'language_changed', 'favorite_saved', 'pack_generated', 'edge_window_changed', 'widget_open',
  'review_prompt', 'scan', 'scan_result', 'error_shown', 'data_fetch', 'data_staleness', 'data_disagreement', 'jackpot_parse',
  'enhanced_run', 'metrickit',
];
const DEFERRED_EVENTS = new Set(['use_numbers_tapped', 'official_lottery_opened', 'retailer_locator_opened']);

function readPref(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* private mode */ } }

// ============================================================================
// State
// ============================================================================
const state = {
  data: null,           // /stats
  subs: null,           // /subscription-events → { events: { day: { type: n } } }
  subsError: null,
  window: Number(params.get('window')) || 30,
  game: LOTTERIES.includes(params.get('game')) ? params.get('game') : 'all',
  // 'results' = the public proof page (Scoreboard + Proof); 'all' adds the loop, money, ops and explorer chapters.
  view: (params.get('view') === 'all' || params.get('ops') === '1' || params.has('event') || params.has('dim')) ? 'all'
    : (params.get('view') === 'results' ? 'results' : (readPref('ppai.dash.view') || 'results')),
  charts: new Map(),    // mountId → [Chart]
  explore: { event: params.get('event') || 'forecast_generated', dim: params.get('dim') || 'model' },
  leaderboardSort: { col: 'n', dir: 'desc' },
};

// ============================================================================
// Small helpers
// ============================================================================
const $ = (id) => document.getElementById(id);
const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sum = (arr) => arr.reduce((a, b) => a + num(b), 0);
const sumObj = (o) => sum(Object.values(o || {}));

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && isObj(v)) Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;              // static markup only, never API strings
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}
const frag = (...children) => append(document.createDocumentFragment(), children);

const fmt = (n, d = 0) => (n == null || Number.isNaN(Number(n))) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: d });
const compact = (n) => {
  if (n == null || Number.isNaN(Number(n))) return '—';
  const v = Number(n); const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(a >= 1e5 ? 0 : 1) + 'K';
  return fmt(v);
};
const pct = (x, d = 1) => (x == null || Number.isNaN(Number(x))) ? '—' : (Number(x) * 100).toFixed(d) + '%';
const signed = (v, d = 1, unit = '') => (v == null || Number.isNaN(Number(v))) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Number(v)).toFixed(d) + unit;
const money = (v, cur = 'USD', d = 0) => (v == null || Number.isNaN(Number(v))) ? '—' : (cur === 'EUR' ? '€' : cur === 'GBP' ? '£' : '$') + fmt(v, d);
const fmtDay = (s) => s ? new Date(s + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—';
const fmtStamp = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC' : '—';
const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const gameName = (l) => LOTTERY_NAME[l] || String(l);
const modelName = (m) => MODEL_NAME[m] || String(m);
const modelColor = (m) => MODEL_COLOR[m] || OTHER;
const deltaTag = (v) => h('span', { class: 'delta ' + (v > 0 ? 'up' : v < 0 ? 'down' : 'flat') }, (v > 0 ? '+' : '') + fmt(v));
const chip = (lottery) => h('span', { class: 'chip ' + (LOTTERY_CHIP[lottery] || 'neutral') }, gameName(lottery));
const swatch = (color, line) => h('span', { class: 'swatch' + (line ? ' line' : ''), style: { background: color } });
const modelLabel = (m) => h('span', { class: 'model-name', title: MODEL_HINT[m] || '' }, swatch(modelColor(m)), modelName(m));

// Combinatorics for the chance baselines.
function choose(n, k) { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; }
const CHANCE_HIT = {}, EXPECTED_MAIN = {}, CHANCE_HIT2 = {};
for (const l of LOTTERIES) {
  const p0 = choose(POOL[l] - 5, 5) / choose(POOL[l], 5);
  CHANCE_HIT[l] = 1 - p0;
  CHANCE_HIT2[l] = 1 - p0 - (5 * choose(POOL[l] - 5, 4)) / choose(POOL[l], 5);
  EXPECTED_MAIN[l] = 25 / POOL[l];
}
// ============================================================================
// Data access
// ============================================================================
const v3 = () => (state.data && isObj(state.data.v3)) ? state.data.v3 : null;
const today = () => (v3() && isDay(v3().today)) ? v3().today : (state.data && state.data.lastUpdated ? String(state.data.lastUpdated).slice(0, 10) : new Date().toISOString().slice(0, 10));
const gamesInScope = () => (state.game === 'all' ? LOTTERIES : [state.game]);
const windowDays = () => { const t = today(), out = []; for (let i = state.window - 1; i >= 0; i--) out.push(addDays(t, -i)); return out; };
const windowStart = () => addDays(today(), -(state.window - 1));

// eventsByDay[day][event]["k=v|k=v"] = count. `_` means no dims.
function parseDims(key) {
  const out = {};
  if (!key || key === '_') return out;
  for (const part of String(key).split('|')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}
function eventsByDay() { const b = v3() && v3().eventsByDay; return isObj(b) ? b : {}; }
function daysWithEvents() { return Object.keys(eventsByDay()).filter(isDay).sort(); }
// Sum an event over the window, optionally filtered by dims.
function sumEvent(name, filter, days = windowDays()) {
  const b = eventsByDay(); let total = 0;
  for (const d of days) {
    const dims = b[d] && b[d][name];
    if (!isObj(dims)) continue;
    for (const [k, c] of Object.entries(dims)) {
      if (filter && !filter(parseDims(k))) continue;
      total += num(c);
    }
  }
  return total;
}
// { value: total } for one dimension over the window.
function breakdown(name, dim, days = windowDays(), filter) {
  const b = eventsByDay(), out = {};
  for (const d of days) {
    const dims = b[d] && b[d][name];
    if (!isObj(dims)) continue;
    for (const [k, c] of Object.entries(dims)) {
      const p = parseDims(k);
      if (filter && !filter(p)) continue;
      const v = dim ? (p[dim] == null ? '(none)' : p[dim]) : 'total';
      out[v] = (out[v] || 0) + num(c);
    }
  }
  return out;
}
// Per-day series for one dimension: { values: [...], rows: { value: [per day] } }.
function seriesByDim(name, dim, days = windowDays(), opts = {}) {
  const b = eventsByDay(), rows = {};
  for (let i = 0; i < days.length; i++) {
    const dims = b[days[i]] && b[days[i]][name];
    if (!isObj(dims)) continue;
    for (const [k, c] of Object.entries(dims)) {
      const p = parseDims(k);
      if (opts.filter && !opts.filter(p)) continue;
      const v = dim ? (p[dim] == null ? '(none)' : p[dim]) : 'total';
      if (!rows[v]) rows[v] = new Array(days.length).fill(0);
      rows[v][i] += num(c);
    }
  }
  let values = Object.keys(rows).sort((a, b2) => sum(rows[b2]) - sum(rows[a]));
  if (opts.order) values = [...opts.order.filter((o) => values.includes(o)), ...values.filter((v) => !opts.order.includes(v))];
  const max = opts.max || 8;
  if (values.length > max) {
    const keep = values.slice(0, max - 1), other = new Array(days.length).fill(0);
    for (const v of values.slice(max - 1)) for (let i = 0; i < days.length; i++) other[i] += rows[v][i];
    const out = {}; for (const v of keep) out[v] = rows[v]; out.Other = other;
    return { values: [...keep, 'Other'], rows: out };
  }
  return { values, rows };
}
function allTimeEvent(name) { const e = state.data && state.data.events; return (e && isObj(e[name])) ? e[name] : null; }

// ============================================================================
// Chart.js plumbing
// ============================================================================
function setChartDefaults() {
  if (!window.Chart) return;
  const C = window.Chart;
  C.defaults.font.family = "'Hanken Grotesk', system-ui, -apple-system, sans-serif";
  C.defaults.font.size = 11;
  C.defaults.color = MUTED;
  C.defaults.borderColor = GRID;
  C.defaults.animation = { duration: 300 };
  C.defaults.plugins.legend.labels.boxWidth = 10;
  C.defaults.plugins.legend.labels.boxHeight = 10;
  C.defaults.plugins.legend.labels.color = MUTED;
  C.defaults.plugins.legend.position = 'bottom';
  C.defaults.plugins.tooltip.backgroundColor = '#1b1b29';
  C.defaults.plugins.tooltip.borderColor = '#35354a';
  C.defaults.plugins.tooltip.borderWidth = 1;
  C.defaults.plugins.tooltip.titleColor = INK;
  C.defaults.plugins.tooltip.bodyColor = INK;
  C.defaults.plugins.tooltip.padding = 10;
  C.defaults.plugins.tooltip.boxPadding = 4;
  C.defaults.plugins.tooltip.usePointStyle = true;
  C.defaults.elements.bar.borderRadius = 4;
  C.defaults.elements.bar.borderSkipped = 'start';
  C.defaults.elements.line.borderWidth = 2;
  C.defaults.elements.line.tension = 0.3;
  C.defaults.elements.line.borderJoinStyle = 'round';
  C.defaults.elements.line.borderCapStyle = 'round';
  C.defaults.elements.point.radius = 0;
  C.defaults.elements.point.hoverRadius = 5;
  C.defaults.elements.point.hitRadius = 12;
  C.defaults.interaction = { mode: 'index', intersect: false };
}
const axisX = (extra = {}) => ({ ticks: { color: MUTED, maxTicksLimit: 10, maxRotation: 0, autoSkip: true }, grid: { display: false }, border: { color: '#35354a' }, ...extra });
const axisY = (extra = {}) => ({ ticks: { color: MUTED, precision: 0, maxTicksLimit: 6 }, grid: { color: GRID, drawTicks: false }, border: { display: false }, beginAtZero: true, ...extra });

function registerChart(mountId, chart) {
  if (!state.charts.has(mountId)) state.charts.set(mountId, []);
  state.charts.get(mountId).push(chart);
}
function destroyCharts(mountId) {
  for (const c of state.charts.get(mountId) || []) { try { c.destroy(); } catch (e) { /* noop */ } }
  state.charts.delete(mountId);
}

// A chart card: title, note, canvas + a table twin behind a toggle.
// spec = { labels, datasets:[{label,data,color,kind?}], type:'bar'|'line', stacked?, height?, percent?, yMax?, tooltipSuffix?, hideLegend?, footer, single? }
function chartCard(mountId, opts) {
  const { title, kicker, note, spec, cls = '', foot, tools = [] } = opts;
  const card = h('div', { class: 'card ' + cls });
  const head = h('div', { class: 'card-head' },
    h('div', null, kicker ? h('span', { class: 'kicker' }, kicker) : null, h('h3', null, title), note ? h('div', { class: 'card-note' }, note) : null),
    h('div', { class: 'card-tools' }, ...tools));
  card.appendChild(head);
  if (!spec || !spec.labels || !spec.labels.length || !spec.datasets.length || !spec.datasets.some((d) => d.data.some((v) => num(v) !== 0))) {
    card.appendChild(emptyState(opts.empty || 'No rows in this window yet.', opts.emptyTag));
    if (foot) card.appendChild(h('div', { class: 'card-foot' }, foot));
    return card;
  }
  const tableBtn = h('button', { type: 'button', class: 'tool-btn', title: 'Show the numbers behind this chart' }, 'Table');
  tableBtn.addEventListener('click', () => { card.classList.toggle('show-table'); tableBtn.classList.toggle('active'); });
  head.lastChild.appendChild(tableBtn);
  const height = spec.height || 240;
  const wrap = h('div', { class: 'chart-wrap', style: { height: height + 'px' } });
  const canvas = h('canvas', { role: 'img', 'aria-label': title });
  wrap.appendChild(canvas);
  card.appendChild(wrap);
  card.appendChild(chartTable(spec));
  if (foot) card.appendChild(h('div', { class: 'card-foot' }, foot));
  // Chart.js wants the canvas in the DOM with a size; the caller appends the card
  // synchronously, so a zero-delay timer (which also runs in background tabs) is enough.
  setTimeout(() => {
    if (!canvas.isConnected || !window.Chart) return;
    try { registerChart(mountId, buildChart(canvas, spec)); } catch (e) { console.error('chart failed:', title, e); }
  }, 0);
  return card;
}
function chartTable(spec) {
  const multi = spec.datasets.length > 1;
  const thead = h('thead', null, h('tr', null, h('th', null, spec.xLabel || ''), ...spec.datasets.map((d) => h('th', { class: 'num' }, d.label)), multi ? h('th', { class: 'num' }, 'Total') : null));
  const rows = spec.labels.map((l, i) => {
    const vals = spec.datasets.map((d) => num(d.data[i]));
    return h('tr', null, h('td', null, String(l)), ...vals.map((v) => h('td', { class: 'num' }, spec.percent ? pct(v / 100, 1) : fmt(v, spec.decimals || 0))), multi ? h('td', { class: 'num' }, spec.percent ? '' : fmt(sum(vals))) : null);
  });
  if (!spec.percent && multi) {
    rows.push(h('tr', null, h('td', null, h('b', null, 'Total')), ...spec.datasets.map((d) => h('td', { class: 'num' }, h('b', null, fmt(sum(d.data), spec.decimals || 0)))), h('td', { class: 'num' }, h('b', null, fmt(sum(spec.datasets.map((d) => sum(d.data))))))));
  }
  return h('div', { class: 'chart-table tbl-wrap' }, h('table', { class: 'tbl' }, thead, h('tbody', null, rows)));
}
function buildChart(canvas, spec) {
  const type = spec.type || 'bar';
  const stacked = !!spec.stacked;
  const datasets = spec.datasets.map((d) => {
    const base = { label: d.label, data: d.data };
    const kind = d.kind || type;
    if (kind === 'line') {
      return { ...base, type: 'line', borderColor: d.color, backgroundColor: d.fill ? hexA(d.color, 0.12) : d.color, fill: !!d.fill,
        pointBackgroundColor: d.color, pointBorderColor: SURFACE, pointBorderWidth: 2, pointRadius: spec.labels.length <= 31 ? 3 : 0,
        borderDash: d.dash ? [6, 4] : undefined, borderWidth: d.dash ? 1.5 : 2, order: d.dash ? 0 : 1 };
    }
    return { ...base, type: 'bar', backgroundColor: d.color, borderColor: SURFACE, borderWidth: stacked ? 2 : 0, maxBarThickness: 24, order: 2 };
  });
  const single = spec.datasets.length === 1 && !spec.forceLegend;
  const horizontal = spec.horizontal;
  const valueAxis = { ...axisY(spec.percent ? { max: spec.yMax || 100, ticks: { color: MUTED, callback: (v) => v + '%' } } : (spec.yMax ? { max: spec.yMax } : {})), stacked };
  const catAxis = { ...axisX(), stacked, ticks: { color: horizontal ? INK : MUTED, maxTicksLimit: horizontal ? 50 : 10, maxRotation: 0, autoSkip: !horizontal } };
  return new window.Chart(canvas.getContext('2d'), {
    type, data: { labels: spec.labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, indexAxis: horizontal ? 'y' : 'x',
      plugins: {
        legend: { display: !single, labels: { usePointStyle: type === 'line', pointStyle: type === 'line' ? 'line' : 'rect' } },
        tooltip: {
          callbacks: {
            label: (c) => `${c.dataset.label}: ${spec.percent ? c.parsed[horizontal ? 'x' : 'y'].toFixed(1) + '%' : fmt(c.parsed[horizontal ? 'x' : 'y'], spec.decimals || 0)}${spec.tooltipSuffix || ''}`,
            footer: stacked ? (items) => 'Total: ' + fmt(items.reduce((s, it) => s + num(it.parsed[horizontal ? 'x' : 'y']), 0), spec.decimals || 0) : undefined,
          },
        },
      },
      scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
    },
  });
}
function hexA(hex, a) {
  const m = String(hex).match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return hex;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
function sparkline(values, color = ACCENT) {
  const w = 120, hgt = 26, n = values.length;
  if (n < 2) return null;
  const max = Math.max(...values, 1), min = 0;
  const pts = values.map((v, i) => `${((i / (n - 1)) * w).toFixed(1)},${(hgt - 2 - ((v - min) / (max - min || 1)) * (hgt - 4)).toFixed(1)}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('class', 'spark'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true');
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('d', `M0,${hgt} L${pts.join(' L')} L${w},${hgt} Z`); area.setAttribute('fill', hexA(color, 0.14));
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', pts.join(' ')); line.setAttribute('fill', 'none'); line.setAttribute('stroke', color); line.setAttribute('stroke-width', '1.5'); line.setAttribute('vector-effect', 'non-scaling-stroke');
  svg.appendChild(area); svg.appendChild(line);
  return svg;
}

// ============================================================================
// Generic components
// ============================================================================
function card(opts, ...body) {
  const { title, kicker, note, cls = '', foot, tools } = opts;
  const c = h('div', { class: 'card ' + cls });
  if (title) c.appendChild(h('div', { class: 'card-head' },
    h('div', null, kicker ? h('span', { class: 'kicker' }, kicker) : null, h('h3', null, title), note ? h('div', { class: 'card-note' }, note) : null),
    tools ? h('div', { class: 'card-tools' }, ...tools) : null));
  append(c, body);
  if (foot) c.appendChild(h('div', { class: 'card-foot' }, foot));
  return c;
}
function emptyState(msg, tag = 'Collecting') { return h('div', { class: 'empty' }, h('span', { class: 'tag' }, tag), msg); }
function tile(label, value, opts = {}) {
  const t = h('div', { class: 'tile' }, h('div', { class: 'label', title: label }, label), h('div', { class: 'value' + (opts.gold ? ' gold' : '') }, value));
  if (opts.sub) t.appendChild(h('div', { class: 'sub' }, ...(Array.isArray(opts.sub) ? opts.sub : [opts.sub])));
  if (opts.spark) { const s = sparkline(opts.spark, opts.sparkColor); if (s) t.appendChild(s); }
  return t;
}
function tiles(...items) { return h('div', { class: 'tiles' }, ...items); }
function table(columns, rows, opts = {}) {
  // columns: [{key,label,num,render}] rows: objects
  const thead = h('thead', null, h('tr', null, ...columns.map((c) => h('th', { class: c.num ? 'num' : '' }, c.label))));
  const tbody = h('tbody', null, ...rows.map((r) => h('tr', null, ...columns.map((c) => {
    const v = c.render ? c.render(r) : r[c.key];
    return h('td', { class: (c.num ? 'num ' : '') + (c.cls ? c.cls(r) || '' : '') }, v == null ? '—' : v);
  }))));
  return h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' + (opts.cls ? ' ' + opts.cls : '') }, thead, tbody));
}
function hbarList(rows, opts = {}) {
  // rows: [{label, value, color?, sub?, labelNode?}] ; opts: {total, tight, max, dimUnknown}
  const max = opts.max || Math.max(...rows.map((r) => r.value), 1);
  const total = opts.total != null ? opts.total : sum(rows.map((r) => r.value));
  return h('div', { class: 'hbar-list' + (opts.tight ? ' tight' : '') }, ...rows.map((r) => h('div', { class: 'hbar-row' },
    h('span', { class: 'hbar-label', title: String(r.label) }, r.labelNode || r.label),
    h('div', { class: 'hbar-track' }, h('span', { class: 'hbar-fill' + (r.dim ? ' dim' : ''), style: { width: ((r.value / max) * 100).toFixed(1) + '%', background: r.dim ? undefined : (r.color || ACCENT) } })),
    h('span', { class: 'hbar-val' }, h('b', null, fmt(r.value)), total ? ' · ' + pct(r.value / total, 0) : ''))));
}
function shareBar(title, parts, opts = {}) {
  // parts: [{label, value, color}]
  const total = sum(parts.map((p) => p.value));
  const block = h('div', { class: 'share-block' },
    h('div', { class: 'share-title' }, h('span', null, title), h('span', null, h('b', null, fmt(total)), opts.unit ? ' ' + opts.unit : '')));
  if (!total) { block.appendChild(h('div', { class: 'empty compact' }, 'No rows in this window.')); return block; }
  block.appendChild(h('div', { class: 'share-bar', title: parts.map((p) => `${p.label}: ${fmt(p.value)} (${pct(p.value / total, 0)})`).join(' · ') },
    ...parts.filter((p) => p.value > 0).map((p) => h('span', { style: { width: ((p.value / total) * 100).toFixed(2) + '%', background: p.color } }))));
  block.appendChild(h('div', { class: 'legend-inline' }, ...parts.map((p) => h('span', null, swatch(p.color), `${p.label} `, h('b', { style: { color: INK, marginLeft: '4px' } }, fmt(p.value)), h('span', { style: { color: FAINT, marginLeft: '4px' } }, pct(p.value / total, 0))))));
  return block;
}
function heatCell(value, opts = {}) {
  if (value == null || Number.isNaN(Number(value))) return h('span', { class: 'heat empty-cell' }, '—');
  const v = Number(value), max = opts.max || 1;
  const a = clamp(v / max, 0, 1);
  return h('span', { class: 'heat', style: { background: `rgba(139,123,255,${(0.08 + a * 0.55).toFixed(2)})`, color: a > 0.55 ? INK : '#c9c6ff' } }, opts.pct ? pct(v, 0) : fmt(v));
}
function statusChip(kind, text) { return h('span', { class: 'status-chip ' + kind }, text); }
function balls(predicted, winning, lottery, opts = {}) {
  const euro = lottery === 'euroMillions';
  const mainN = 5;
  const pMain = (predicted || []).slice(0, mainN), pSpec = (predicted || []).slice(mainN);
  const wMain = new Set((winning || []).slice(0, mainN)), wSpec = (winning || []).slice(mainN);
  const wrap = h('span', { class: 'balls' + (opts.lg ? ' lg' : ''), style: { '--game': LOTTERY_BRAND[lottery] || ACCENT } });
  for (const n of pMain) wrap.appendChild(h('span', { class: 'ball' + (wMain.has(n) ? ' hit' : '') }, n));
  if (pSpec.length) wrap.appendChild(h('span', { class: 'ball-sep' }));
  pSpec.forEach((n, i) => {
    const hit = euro ? wSpec.includes(n) : (wSpec[0] === n);
    wrap.appendChild(h('span', { class: 'ball special' + (hit ? ' hit' : '') }, n));
  });
  return wrap;
}

// ============================================================================
// Aggregations over the legacy `models` block (all-time, game-filtered)
// ============================================================================
function modelRows(games = gamesInScope()) {
  const models = (state.data && isObj(state.data.models)) ? state.data.models : {};
  const acc = {};
  for (const l of games) {
    for (const [m, s] of Object.entries(models[l] || {})) {
      if (!isObj(s)) continue;
      const r = acc[m] || (acc[m] = { model: m, n: 0, hits: 0, special: 0, moneyUSD: 0, moneyEUR: 0, jackpots: 0, matches: 0, hit2: 0, chanceW: 0, expMain: 0, expSpecial: 0, dist: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } });
      const n = num(s.totalPredictions);
      r.n += n; r.hits += num(s.hits); r.special += num(s.specialMatches); r.jackpots += num(s.jackpots);
      if (l === 'euroMillions') r.moneyEUR += num(s.moneyWon); else r.moneyUSD += num(s.moneyWon);
      for (const [k, v] of Object.entries(s.matchDistribution || {})) { r.dist[k] = (r.dist[k] || 0) + num(v); r.matches += num(k) * num(v); if (num(k) >= 2) r.hit2 += num(v); }
      r.chanceW += n * CHANCE_HIT[l]; r.expMain += n * EXPECTED_MAIN[l];
      if (SPECIAL_POOL[l]) r.expSpecial += n / SPECIAL_POOL[l];
    }
  }
  return Object.values(acc).filter((r) => r.n > 0).map((r) => {
    r.rate = r.hits / r.n; r.chance = r.chanceW / r.n; r.avg = r.matches / r.n; r.expAvg = r.expMain / r.n;
    return r;
  });
}
function totalsInScope() {
  const rows = modelRows();
  return { n: sum(rows.map((r) => r.n)), hits: sum(rows.map((r) => r.hits)), usd: sum(rows.map((r) => r.moneyUSD)), eur: sum(rows.map((r) => r.moneyEUR)), jackpots: sum(rows.map((r) => r.jackpots)) };
}
function recentResults(games = gamesInScope()) {
  const models = (state.data && isObj(state.data.models)) ? state.data.models : {};
  const all = [];
  for (const l of games) for (const [m, s] of Object.entries(models[l] || {})) for (const r of (s && Array.isArray(s.recentResults) ? s.recentResults : [])) if (isObj(r)) all.push({ ...r, lotteryType: l, modelType: m });
  all.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')) || String(b.drawDate || '').localeCompare(String(a.drawDate || '')));
  return all;
}

// ============================================================================
// Chapter 1 — Scoreboard
// ============================================================================
function renderScoreboard(mount) {
  const rows = modelRows();
  const t = totalsInScope();
  const subs = (state.data && isObj(state.data.subscribers)) ? state.data.subscribers : {};
  const snaps = (Array.isArray(subs.snapshots) ? subs.snapshots : []).filter((s) => s && isDay(s.date)).sort((a, b) => a.date.localeCompare(b.date));
  const dev = v3() && isObj(v3().devices) ? v3().devices : null;
  const active = dev && isObj(dev.active) ? dev.active : {};

  const evidence = state.evidence;
  const hero = evidence && evidence.models.find(m => m.id === 'proposal-distribution-t32-p128');
  const live = v3()?.evidenceScope === 'pair_tagged_5_1_plus' ? v3()?.arms?.powerball?.byModel?.enhanced?.paired : null;
  const heroCard = h('div', { class: 'card hero-card accent' });
  if (hero) {
    heroCard.appendChild(h('div', { class: 'hero' },
      h('div', null,
        h('span', { class: 'kicker' }, 'Powerball · retrospective development study'),
        h('div', { class: 'hero-figure' }, (hero.value * 100).toFixed(1), h('small', null, '%')),
        h('div', { class: 'hero-lead' }, 'Neural Focus 2 matched at least one main number across ', h('em', null, fmt(evidence.draw_count)), ' historical drawings. Random expectation: ', pct(evidence.baseline), '.'),
        h('span', { class: 'verdict collecting' }, 'Historical result · future advantage unproven')),
      h('div', null,
        h('div', { class: 'hero-meta' },
          h('span', { class: 'chip-stat' }, `${evidence.range[0]} – ${evidence.range[1]}`),
          h('span', { class: 'chip-stat' }, `${evidence.models.length} policies published, including those that lost`),
          h('span', { class: 'chip-stat' }, 'Exploratory draw-block interval ', `${pct(hero.interval[0])} – ${pct(hero.interval[1])}`)),
        h('p', { class: 'card-foot' }, 'Selected after repeated searches on previously examined history; the interval is not adjusted for model selection. Applies to Powerball only, regardless of the game filter.'),
        h('p', { class: 'card-foot' }, live?.pairs ? `Live Neuron check: ${pct(live.modelHitRate)} draw-averaged hit rate over ${fmt(live.draws)} drawings (${fmt(live.pairs)} pairs). These observations do not yet establish whether the backtest generalizes.` : 'Live Neuron check: awaiting paired Powerball results.'))));
  } else heroCard.appendChild(emptyState('Historical evidence could not be loaded. Live observations remain available below.', 'Unavailable'));
  mount.appendChild(heroCard);

  // KPI tiles
  const last = snaps[snaps.length - 1], wk = snaps.length > 7 ? snaps[snaps.length - 8] : snaps[0], mo = snaps.length > 30 ? snaps[snaps.length - 31] : snaps[0];
  const newDev7 = sum(snaps.slice(-7).map((s) => s.newUsers));
  const hist = (state.data && Array.isArray(state.data.resultsHistory)) ? state.data.resultsHistory.filter((r) => r && isDay(r.date)).sort((a, b) => a.date.localeCompare(b.date)) : [];
  const perDay = hist.map((r, i) => (i ? Math.max(0, num(r.predictions) - num(hist[i - 1].predictions)) : 0)).slice(-14);
  const opsOnly = (el) => { el.dataset.ops = ''; return el; };
  const k = h('div', { class: 'card' }, tiles(
    tile('Lines scored', compact(t.n), { sub: state.game === 'all' ? `+${fmt(sum(perDay.slice(-7)))} in 7d` : 'all-time · this game', spark: state.game === 'all' ? perDay : null }),
    tile('Hit ≥1 number', compact(t.hits), { sub: t.n ? pct(t.hits / t.n) + ' of lines' : '' }),
    tile('Money won', h('span', null, money(t.usd), t.eur ? h('small', null, ` + ${money(t.eur, 'EUR')}`) : null), { gold: true, sub: t.jackpots ? `${fmt(t.jackpots)} jackpots` : 'no jackpots yet' }),
    tile('Devices active 7d', fmt(active.d7), { sub: dev ? `${fmt(active.d1)} today · ${fmt(active.d30)} in 30d` : 'needs v3' }),
    tile('Devices seen 90d', fmt(subs.total), { sub: last && wk ? ['7d', deltaTag(num(last.total) - num(wk.total)), '30d', deltaTag(num(last.total) - num(mo.total))] : 'reporting devices' }),
    opsOnly(tile('Paid Apple subscriptions', state.subsError ? '—' : fmt(state.subs?.snapshot?.paid), { sub: state.subs?.snapshot ? `Apple report · ${state.subs.snapshot.day}` : 'daily report unavailable' })),
    opsOnly(tile('Subscribed device share', subs.total ? pct(num(subs.subscribed) / num(subs.total)) : '—', { sub: `${fmt(subs.subscribed)} of ${fmt(subs.total)} devices (90d)` })),
    opsOnly(tile('New devices 7d', fmt(newDev7), { sub: 'first seen this week' })),
  ));
  mount.appendChild(k);
}

// ============================================================================
// Chapter 2 — Proof
// ============================================================================
function renderProof(mount) {
  const rows = modelRows().sort((a, b) => b.n - a.n);
  const scopeGames = gamesInScope();
  const mixed = state.game === 'all';

  const evidence = state.evidence;
  if (evidence) {
    const details = h('details', { style: { marginTop: '14px' } },
      h('summary', null, `All ${evidence.models.length} historical policies — wins and losses`),
      table([
        { key: 'label', label: 'Policy', render: r => r.label },
        { key: 'value', label: 'Hit ≥1 main', num: true, render: r => pct(r.value) },
        { key: 'interval', label: 'Draw-block 95% interval', num: true, render: r => `${pct(r.interval[0])} – ${pct(r.interval[1])}` },
      ], evidence.models));
    mount.appendChild(card({ title: 'Complete Powerball development record', kicker: `${fmt(evidence.draw_count)} drawings · ${evidence.range.join(' – ')}`,
      note: evidence.allowed_public_claim, foot: evidence.limitation }, details,
      h('p', { class: 'card-foot' }, h('a', { href: './evidence.json' }, 'Download the evidence summary'), ` · artifact ${evidence.version} · source checksum included in the download`)));
  }
  mount.appendChild(card({ title: 'Historical community observations', kicker: 'All-time · includes unauditable legacy totals', cls: 'two-thirds',
    note: 'Lines are repeated within drawings and span older engines. These totals cannot establish a model advantage.',
    foot: mixed ? 'Random expectation is weighted by the mix of games. No confidence interval or verdict is inferred from these totals.' : `Random expectation for ${gameName(state.game)}: ${pct(CHANCE_HIT[state.game])}.` },
    rows.length ? table([
      { key: 'model', label: 'Model', render: r => modelLabel(r.model) },
      { key: 'n', label: 'Lines', num: true, render: r => fmt(r.n) },
      { key: 'rate', label: 'Hit ≥1 main', num: true, render: r => pct(r.rate) },
      { key: 'chance', label: 'Random expectation', num: true, render: r => pct(r.chance) },
    ], rows) : emptyState('No historical observations for this game.')));

  // --- Since v3: matches vs expected, per arm ---
  const arms = v3()?.evidenceScope === 'pair_tagged_5_1_plus' && isObj(v3().arms) ? v3().arms : {};
  const v3rows = [];
  for (const l of scopeGames) {
    const a = arms[l]; if (!isObj(a)) continue;
    for (const [m, b] of Object.entries(a.byModel || {})) {
      if (!isObj(b) || !isObj(b.model) || !num(b.model.n)) continue;
      v3rows.push({ model: m, n: num(b.model.n), hits: num(b.model.hits), sumMain: num(b.model.sumMain), exp: num(b.model.sumExpected) });
    }
    if (isObj(a.control) && num(a.control.n)) v3rows.push({ model: 'control', n: num(a.control.n), hits: num(a.control.hits), sumMain: num(a.control.sumMain), exp: num(a.control.sumExpected) });
  }
  const merged = {};
  for (const r of v3rows) { const m = merged[r.model] || (merged[r.model] = { model: r.model, n: 0, hits: 0, sumMain: 0, exp: 0 }); m.n += r.n; m.hits += r.hits; m.sumMain += r.sumMain; m.exp += r.exp; }
  const v3list = Object.values(merged).sort((a, b) => (a.model === 'control') - (b.model === 'control') || b.n - a.n);
  mount.appendChild(card({
    title: 'Paired-era forecasts', kicker: 'Pair-tagged reports · 5.1+', cls: 'third',
    note: 'Only 5.1+ reports with a pair ID and a non-legacy origin. Older history uploaded after an upgrade is excluded.',
    foot: 'Expected = lines × 25 ÷ pool (0.362 Powerball, 0.357 Mega Millions, 0.500 EuroMillions). The paired random rows are the control lines.',
  }, v3list.length ? table([
    { key: 'model', label: 'Arm', render: (r) => modelLabel(r.model) },
    { key: 'n', label: 'Lines', num: true, render: (r) => fmt(r.n) },
    { key: 'rate', label: 'Hit', num: true, render: (r) => pct(r.hits / r.n, 0) },
    { key: 'sumMain', label: 'Matches', num: true, render: (r) => fmt(r.sumMain) },
    { key: 'exp', label: 'Expected', num: true, render: (r) => fmt(r.exp, 1) },
    { key: 'ratio', label: 'Ratio', num: true, render: (r) => (r.exp ? (r.sumMain / r.exp).toFixed(2) + '×' : '—') },
  ], v3list) : emptyState('No 5.1 lines scored for this game yet. Rows appear once a 5.1 device reveals a draw.')));

  // Repeated lines on a drawing do not add independent evidence.
  const pairedGrid = h('div', { class: 'paired-grid' });
  const interval = p => Array.isArray(p?.drawCI95) ? `exploratory 95% draw-block interval ${signed(p.drawCI95[0], 3)} to ${signed(p.drawCI95[1], 3)}` : 'interval unavailable: too few independent drawings or no observed variation';
  for (const l of scopeGames) {
    const a = arms[l], p = a?.paired;
    const el = h('div', { class: 'paired collecting' },
      h('div', { class: 'game' }, chip(l), h('span', { class: 'muted' }, `${fmt(p?.draws || 0)} drawings · ${fmt(p?.pairs || 0)} pairs`)),
      h('div', { class: 'big' }, p?.pairs ? signed(p.drawMeanDiff, 3) : '—', h('small', null, 'extra main matches · equal weight per draw')),
      h('div', { class: 'meta' }, interval(p)),
      h('span', { class: 'verdict collecting' }, 'Observational · no live advantage established'));
    for (const [m,b] of Object.entries(a?.byModel || {})) if (b.paired?.pairs) {
      el.appendChild(h('div', { class: 'models' }, modelLabel(m),
        ` ${signed(b.paired.drawMeanDiff, 3)} · ${fmt(b.paired.draws)} drawings · ${fmt(b.paired.pairs)} pairs; ${interval(b.paired)}`));
    }
    pairedGrid.appendChild(el);
  }
  mount.appendChild(card({ title: 'Paired random comparison', kicker: 'Can the historical result hold up on new draws?',
    note: 'Model and random lines are scored against the same winning numbers. Differences are averaged within each drawing, then each drawing receives equal weight. There is no verdict at 200 pairs.',
    foot: 'Exploratory intervals resample blocks of five consecutive observed drawings, after at least 20 drawings. Twenty is an interval-display minimum, not proof or a stopping rule. Repeated monitoring and model selection prevent confirmatory claims.' }, pairedGrid));

  // --- Draw ledger ---
  const draws = (v3()?.evidenceScope === 'pair_tagged_5_1_plus' && Array.isArray(v3().draws) ? v3().draws : []).filter((d) => isObj(d) && isDay(d.draw) && scopeGames.includes(d.lottery)).sort((a, b) => b.draw.localeCompare(a.draw) || a.lottery.localeCompare(b.lottery)).slice(0, 20);
  const ledgerRows = draws.map((d) => {
    const byModel = isObj(d.byModel) ? d.byModel : {};
    const n = sum(Object.values(byModel).map((m) => m && m.n)), hits = sum(Object.values(byModel).map((m) => m && m.hits));
    const c = isObj(d.control) ? d.control : {};
    return { ...d, n, hits, cn: num(c.n), ch: num(c.hits), chance: CHANCE_HIT[d.lottery] || 0 };
  });
  const rate = (hits, n, chance, ctl) => n ? h('span', { class: 'mini-rate' },
    h('span', { class: 'mini-track' }, h('span', { class: 'mini-fill' + (ctl ? ' ctl' : ''), style: { width: pct(clamp((hits / n) / 0.8, 0, 1), 0) } }), h('span', { class: 'mini-chance', style: { left: pct(chance / 0.8, 0) } })),
    h('span', null, h('b', null, pct(hits / n, 0)), h('span', { class: 'muted' }, ` ${fmt(hits)}/${fmt(n)}`))) : h('span', { class: 'muted' }, '—');
  mount.appendChild(card({
    title: 'Draw ledger', kicker: 'Last 20 draws · pair-tagged 5.1+ forecasts', cls: 'two-thirds',
    note: 'One row per drawing: how the community\'s forecast lines did, how the paired control lines did, with older untagged history excluded.',
    foot: 'Bars show the hit rate against an 80% axis; the gold tick is chance for that game. Per-model counts sit in the last column.',
  }, ledgerRows.length ? table([
    { key: 'draw', label: 'Draw', render: (r) => h('span', { style: { fontFamily: 'var(--mono)', fontSize: '0.76rem' } }, r.draw) },
    { key: 'lottery', label: 'Game', render: (r) => chip(r.lottery) },
    { key: 'n', label: 'Lines', num: true, render: (r) => fmt(r.n) },
    { key: 'rate', label: 'Forecast hit rate', render: (r) => rate(r.hits, r.n, r.chance) },
    { key: 'ctl', label: 'Control', render: (r) => rate(r.ch, r.cn, r.chance, true) },
    { key: 'models', label: 'By model', render: (r) => h('span', { class: 'muted' }, Object.entries(r.byModel || {}).map(([m, s]) => `${modelName(m)} ${fmt(s && s.hits)}/${fmt(s && s.n)}`).join(' · ')) },
  ], ledgerRows) : emptyState('No draws scored on 5.1 devices for this game yet.')));

  // --- Top wins ---
  const wins = (state.data && Array.isArray(state.data.topWins) ? state.data.topWins : []).filter((w) => isObj(w) && scopeGames.includes(w.lotteryType));
  const winDesc = (w) => {
    const stars = num(w.specialMatchCount);
    const m = w.lotteryType === 'euroMillions' ? `${num(w.mainMatches)} of 5${stars ? ` + ${stars} star${stars > 1 ? 's' : ''}` : ''}` : `${num(w.mainMatches)} of 5${w.specialMatch ? ' + special' : ''}`;
    return `${m} · ${modelName(w.modelType)} · ${w.drawDate || ''}`;
  };
  const winAmt = (w) => w.isJackpot ? 'JACKPOT' : money(w.prize, w.currency === 'EUR' ? 'EUR' : 'USD');
  mount.appendChild(card({ title: 'Top wins', kicker: 'All-time · biggest scored prizes', cls: 'third gold', foot: 'Gold ring = the ball matched the draw. Prizes use the published prize tables; no ticket is implied.' },
    wins.length ? h('div', null, ...wins.slice(0, 5).map((w, i) => h('div', { class: 'topwin' },
      h('div', { class: 'amt' + (i ? ' small' : '') }, winAmt(w)),
      h('div', { class: 'win-meta' }, h('div', null, chip(w.lotteryType)), h('div', { class: 'desc' }, winDesc(w)), h('div', { style: { marginTop: '8px' } }, balls(w.predictedNumbers, w.winningNumbers, w.lotteryType, { lg: i === 0 }))))))
      : emptyState('No prize-winning lines for this game yet.')));

  // --- Scoring over time (two single-series charts) ---
  const hist = (state.data && Array.isArray(state.data.resultsHistory) ? state.data.resultsHistory : []).filter((r) => r && isDay(r.date)).sort((a, b) => a.date.localeCompare(b.date));
  const days = windowDays();
  const byDate = {}; for (const r of hist) byDate[r.date] = r;
  const perDay = [], cumRate = [];
  let prev = null;
  for (const d of days) {
    const r = byDate[d];
    perDay.push(r && prev ? Math.max(0, num(r.predictions) - num(prev.predictions)) : (r && !prev ? null : null));
    cumRate.push(r && num(r.predictions) ? +((num(r.hits) / num(r.predictions)) * 100).toFixed(2) : null);
    if (r) prev = r;
  }
  const chanceAll = (() => { const rows2 = modelRows(LOTTERIES); const n = sum(rows2.map((r) => r.n)); return n ? sum(rows2.map((r) => r.chance * r.n)) / n : 0.32; })();
  mount.appendChild(chartCard('proof', {
    title: 'Lines scored per day', kicker: 'All games · daily snapshot deltas', cls: 'half',
    spec: { type: 'bar', labels: days.map(fmtDay), xLabel: 'Day', datasets: [{ label: 'Lines scored', data: perDay.map((v) => v == null ? 0 : v), color: ACCENT }] },
    empty: 'Daily snapshots begin after the next 00:30 UTC run.', foot: 'Counted from the daily results snapshot; the first day of a window has no delta. Not affected by the game filter.',
  }));
  mount.appendChild(chartCard('proof', {
    title: 'Community hit rate over time', kicker: 'All games · cumulative', cls: 'half',
    spec: { type: 'line', percent: true, yMax: 50, labels: days.map(fmtDay), xLabel: 'Day', forceLegend: true, datasets: [
      { label: 'Hit rate (all lines)', data: cumRate.map((v) => v == null ? null : v), color: ACCENT, fill: true },
      { label: 'Chance (weighted)', data: days.map(() => +(chanceAll * 100).toFixed(2)), color: GOLD, dash: true },
    ] },
    empty: 'Daily snapshots begin after the next 00:30 UTC run.', foot: 'Cumulative hits ÷ cumulative lines at each day\'s snapshot. The chance line is weighted by the community\'s mix of games.',
  }));

  // --- Recent lines (first 10, the rest behind one tap) ---
  const recent = recentResults().slice(0, 30);
  const FEED_FIRST = 10;
  const feedRow = (r) => {
    const hit = num(r.mainMatches) > 0 || r.specialMatch || num(r.specialMatchCount) > 0;
    const stars = num(r.specialMatchCount);
    const txt = num(r.mainMatches) > 0 ? `${num(r.mainMatches)} of 5${r.lotteryType === 'euroMillions' ? (stars ? ` + ${stars} star${stars > 1 ? 's' : ''}` : '') : (r.specialMatch ? ' + special' : '')}` : (r.specialMatch || stars ? 'Special only' : 'No match');
    return h('div', { class: 'feed-row' }, chip(r.lotteryType), modelLabel(r.modelType), balls(r.predictedNumbers, r.winningNumbers, r.lotteryType),
      h('span', { class: 'result' + (hit ? '' : ' miss') }, txt), h('span', { class: 'prize' }, num(r.prize) > 0 ? money(r.prize, r.currency === 'EUR' ? 'EUR' : 'USD') : ''), h('span', { class: 'date' }, r.drawDate || ''));
  };
  const feed = h('div', { class: 'feed' }, ...recent.slice(0, FEED_FIRST).map(feedRow));
  const rest = recent.slice(FEED_FIRST);
  const moreBtn = rest.length ? h('button', { type: 'button', class: 'more-btn' }, `Show ${fmt(rest.length)} more lines`) : null;
  if (moreBtn) moreBtn.addEventListener('click', () => { append(feed, rest.map(feedRow)); moreBtn.remove(); });
  mount.appendChild(card({ title: 'Recent lines', kicker: 'Latest scored forecasts', foot: 'Each row is one forecast line as scored by the device that revealed it. Special ball shown after the divider.' },
    recent.length ? [feed, moreBtn] : emptyState('No scored lines for this game yet.')));
}

// ============================================================================
// Chapter 3 — The loop
// ============================================================================
const LADDER = [['first_open', 'First open'], ['onboarding', 'Onboarding done'], ['forecast_user', 'Made own forecast'], ['intent', 'Copied / saved / shared'], ['loop', 'Revealed a result'], ['notif', 'Notifications on'], ['paywall', 'Saw the paywall'], ['subscribed', 'Subscribed']];

function renderLoop(mount) {
  const days = windowDays();
  const act = v3() && isObj(v3().activation) ? v3().activation : null;
  const ret = v3() && Array.isArray(v3().retention) ? v3().retention.filter((r) => r && r.cohortWeek) : [];
  const dev = v3() && isObj(v3().devices) ? v3().devices : null;

  // --- Activation ladder ---
  const stages = act && isObj(act.stages) ? act.stages : {};
  const ladderRows = LADDER.map(([k, l]) => ({ key: k, label: l, value: num(stages[k]) }));
  const base = Math.max(num(stages.first_open), 1);
  const ramp = ORDINAL(ladderRows.length);
  const funnel = h('div', { class: 'funnel' }, ...ladderRows.map((r, i) => h('div', { class: 'funnel-row' },
    h('span', null, r.label),
    h('div', { class: 'funnel-track' }, h('span', { class: 'funnel-fill', style: { width: pct(clamp(r.value / Math.max(...ladderRows.map((x) => x.value), 1), 0, 1), 1), background: ramp[i] } })),
    h('span', { class: 'funnel-val' }, h('b', null, fmt(r.value)), r.value <= base && r.key !== 'first_open' ? ` · ${pct(r.value / base, 0)}` : ''))));
  const sizes = {}; for (const r of ret) sizes[r.cohortWeek] = num(r.size);
  const cohorts = (act && Array.isArray(act.byCohort) ? act.byCohort : []).filter((c) => c && c.cohortWeek).sort((a, b) => String(b.cohortWeek).localeCompare(String(a.cohortWeek)));
  const cohortTable = cohorts.length ? table([
    { key: 'cohortWeek', label: 'Cohort', render: (c) => h('b', null, c.cohortWeek) },
    { key: 'size', label: 'Devices', num: true, render: (c) => fmt(sizes[c.cohortWeek] || c.size) },
    ...LADDER.map(([k, l]) => ({ key: k, label: l.replace('Copied / saved / shared', 'Intent').replace('Made own forecast', 'Own forecast').replace('Revealed a result', 'Reveal').replace('Notifications on', 'Notifs').replace('Saw the paywall', 'Paywall').replace('Onboarding done', 'Onboarded'), num: true,
      render: (c) => { const s = sizes[c.cohortWeek] || num(c.size); return heatCell(s ? num(c[k]) / s : null, { pct: true, max: 1 }); } })),
  ], cohorts) : null;
  mount.appendChild(card({
    title: 'Activation ladder', kicker: 'Per device · stages reached since 5.1', cls: 'half',
    note: 'Each device sets a stage flag once. Paywall and subscribed also include devices imported from before 5.1, so those two rows can exceed first opens.',
    foot: 'Percentages are of first opens. Intent = copied numbers, saved a favorite, or shared. Loop = revealed a scored result.',
  }, ladderRows.some((r) => r.value) ? funnel : emptyState('No 5.1 devices have reported stages yet.')));
  mount.appendChild(card({ title: 'Stages by install cohort', kicker: 'ISO week of first open', cls: 'half', foot: 'Share of each weekly cohort that reached the stage. Cohorts before 5.1 only carry the two imported flags.' },
    cohortTable || emptyState('Cohorts appear once devices report an install date.')));

  // --- Retention ---
  const retSorted = ret.slice().sort((a, b) => String(b.cohortWeek).localeCompare(String(a.cohortWeek)));
  mount.appendChild(card({ title: 'Retention', kicker: 'Weekly install cohorts · seen again after 1, 7, 30 days', cls: 'half', foot: 'Dashes mean the window has not elapsed yet. "Seen" = any batch from the device on or after that day.' },
    retSorted.length ? table([
      { key: 'cohortWeek', label: 'Cohort', render: (r) => h('b', null, r.cohortWeek) },
      { key: 'size', label: 'Devices', num: true, render: (r) => fmt(r.size) },
      { key: 'd1', label: 'D1', num: true, render: (r) => heatCell(r.d1 == null ? null : num(r.d1), { pct: true, max: 1 }) },
      { key: 'd7', label: 'D7', num: true, render: (r) => heatCell(r.d7 == null ? null : num(r.d7), { pct: true, max: 1 }) },
      { key: 'd30', label: 'D30', num: true, render: (r) => heatCell(r.d30 == null ? null : num(r.d30), { pct: true, max: 1 }) },
    ], retSorted) : emptyState('Retention needs at least one cohort with an install date.')));
  const retAsc = ret.slice().sort((a, b) => String(a.cohortWeek).localeCompare(String(b.cohortWeek)));
  mount.appendChild(chartCard('loop', {
    title: 'Retention by cohort', kicker: 'Same table, as lines', cls: 'half',
    spec: { type: 'line', percent: true, labels: retAsc.map((r) => r.cohortWeek), xLabel: 'Cohort', datasets: [
      { label: 'D1', data: retAsc.map((r) => r.d1 == null ? null : +(num(r.d1) * 100).toFixed(1)), color: CAT[0] },
      { label: 'D7', data: retAsc.map((r) => r.d7 == null ? null : +(num(r.d7) * 100).toFixed(1)), color: CAT[1] },
      { label: 'D30', data: retAsc.map((r) => r.d30 == null ? null : +(num(r.d30) * 100).toFixed(1)), color: CAT[2] },
    ] },
    empty: 'Retention needs at least one cohort with an install date.', foot: 'Small cohorts swing hard; read the table\'s device counts alongside.',
  }));

  // --- Daily activity small multiples ---
  const labels = days.map(fmtDay);
  const s1 = seriesByDim('session_start', 'kind', days, { order: ['cold', 'warm'] });
  mount.appendChild(chartCard('loop', { title: 'Sessions per day', kicker: 'session_start · cold vs warm', cls: 'half',
    spec: { type: 'bar', stacked: true, labels, xLabel: 'Day', datasets: s1.values.map((v, i) => ({ label: v === 'cold' ? 'Cold launch' : v === 'warm' ? 'Warm (from background)' : v, data: s1.rows[v], color: CAT[i] })) },
    foot: (() => { const dn = sumEvent('session_start', (p) => p.drawNight === 'yes', days), all = sumEvent('session_start', null, days); return all ? `${pct(dn / all, 0)} of sessions happened on a draw night.` : 'Draw-night share appears with the first sessions.'; })() }));
  const s2 = seriesByDim('forecast_generated', 'origin', days, { order: ['auto', 'user'] });
  mount.appendChild(chartCard('loop', { title: 'Forecasts per day', kicker: 'forecast_generated · auto vs user-made', cls: 'half',
    spec: { type: 'bar', stacked: true, labels, xLabel: 'Day', datasets: s2.values.map((v, i) => ({ label: v === 'auto' ? 'Auto (on open)' : v === 'user' ? 'User-made' : v, data: s2.rows[v], color: CAT[i] })) },
    foot: (() => { const rep = sumEvent('forecast_generated', (p) => p.replacedAuto === 'yes', days), user = sumEvent('forecast_generated', (p) => p.origin === 'user', days); return user ? `${pct(rep / user, 0)} of user-made forecasts replaced the auto pick.` : 'Replaced-auto share appears with the first user-made forecast.'; })() }));
  const s3 = seriesByDim('reveal', 'matches', days, { order: ['0', '1-2', '3plus', 'special'] });
  const s3ramp = ORDINAL(Math.max(s3.values.length, 1));
  mount.appendChild(chartCard('loop', { title: 'Reveals per day', kicker: 'reveal · by match band', cls: 'half',
    spec: { type: 'bar', stacked: true, labels, xLabel: 'Day', datasets: s3.values.map((v, i) => ({ label: { '0': 'No match', '1-2': '1–2 numbers', '3plus': '3+ numbers', special: 'Special only', '(none)': 'Legacy (no band)' }[v] || v, data: s3.rows[v], color: v === '(none)' ? OTHER : s3ramp[i] })) },
    foot: 'A reveal is the moment a user opens a scored result. Legacy devices send reveals without the band.' }));
  const s4a = seriesByDim('first_open', null, days), s4b = seriesByDim('onboarding_done', null, days);
  mount.appendChild(chartCard('loop', { title: 'Arrivals per day', kicker: 'first_open and onboarding_done', cls: 'half',
    spec: { type: 'bar', labels, xLabel: 'Day', datasets: [{ label: 'First opens', data: s4a.rows.total || days.map(() => 0), color: CAT[0] }, { label: 'Onboarding done', data: s4b.rows.total || days.map(() => 0), color: CAT[1] }] },
    foot: (() => { const cta = sumEvent('onboarding_done', (p) => p.result === 'cta', days), sk = sumEvent('onboarding_done', (p) => p.result === 'skipped', days); return cta + sk ? `Onboarding: ${fmt(cta)} tapped the CTA, ${fmt(sk)} skipped.` : 'First opens are only reported by 5.1 devices.'; })() }));

  // --- Reveal behaviour ---
  const late = breakdown('reveal', 'lateness', days), origin = breakdown('reveal', 'origin', days);
  const lateOrder = ['sameNight', 'nextDay', 'later'], lateLabel = { sameNight: 'Same night', nextDay: 'Next day', later: 'Later', '(none)': 'Legacy' };
  const originOrder = ['auto', 'user', 'mixed', 'legacy'], originLabel = { auto: 'Auto pick', user: 'User-made', mixed: 'Mixed', legacy: 'Legacy', '(none)': 'Legacy' };
  mount.appendChild(card({ title: 'Reveal behaviour', kicker: 'How soon after the draw, and whose pick', cls: 'half', foot: 'Lateness is measured from the draw instant to the reveal on the device.' },
    shareBar('When results get revealed', [...lateOrder, '(none)'].filter((k) => late[k]).map((k, i) => ({ label: lateLabel[k] || k, value: late[k], color: k === '(none)' ? OTHER : ORDINAL(3)[i] })), { unit: 'reveals' }),
    shareBar('Whose forecast was revealed', [...originOrder, '(none)'].filter((k) => origin[k]).map((k, i) => ({ label: originLabel[k] || k, value: origin[k], color: k === '(none)' || k === 'legacy' ? OTHER : CAT[i] })), { unit: 'reveals' })));

  // --- Forecast choices ---
  const userModel = breakdown('forecast_generated', 'model', days, (p) => p.origin === 'user');
  const selected = breakdown('model_selected', 'model', days);
  const jackpot = breakdown('forecast_generated', 'jackpot', days);
  const jpOrder = ['unknown', 'lt100M', '100-300M', '300-500M', '500M-1B', '1Bplus'], jpLabel = { unknown: 'Unknown', lt100M: '< $100M', '100-300M': '$100–300M', '300-500M': '$300–500M', '500M-1B': '$500M–1B', '1Bplus': '$1B+' };
  const jpKeys = jpOrder.filter((k) => jackpot[k]);
  mount.appendChild(card({ title: 'Which model people choose', kicker: 'forecast_generated origin=user · model_selected', cls: 'half', foot: 'Left: the model behind each user-made forecast. Right: explicit picks in the model sheet.' },
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '18px' } },
      h('div', null, h('div', { class: 'share-title', style: { marginBottom: '8px', color: MUTED, fontSize: '0.8rem' } }, 'User-made forecasts by model'),
        sumObj(userModel) ? hbarList(MODEL_ORDER.filter((m) => userModel[m]).map((m) => ({ label: modelName(m), labelNode: modelLabel(m), value: userModel[m], color: modelColor(m) })), { tight: true }) : h('div', { class: 'empty compact' }, 'No user-made forecasts in this window.')),
      h('div', null, h('div', { class: 'share-title', style: { marginBottom: '8px', color: MUTED, fontSize: '0.8rem' } }, 'Model selected in the sheet'),
        sumObj(selected) ? hbarList(MODEL_ORDER.filter((m) => selected[m]).map((m) => ({ label: modelName(m), labelNode: modelLabel(m), value: selected[m], color: modelColor(m) })), { tight: true }) : h('div', { class: 'empty compact' }, 'No model_selected events in this window.'))),
    h('div', { style: { marginTop: '16px' } }, shareBar('Forecasts by jackpot band', jpKeys.map((k, i) => ({ label: jpLabel[k] || k, value: jackpot[k], color: k === 'unknown' ? OTHER : ORDINAL(Math.max(jpKeys.length, 2))[i] })), { unit: 'forecasts' }))));

  // --- Notifications ---
  const optin = allTimeEvent('notif_optin') || {};
  const granted = num(optin.granted), denied = num(optin.denied);
  const notifMix = dev && isObj(dev.byNotif) ? dev.byNotif : {};
  const sched = breakdown('notif_scheduled_unique', 'kind', days), opened = breakdown('notif_opened_unique', 'kind', days);
  const legacyScheduled = sumEvent('notif_scheduled', null, days);
  const kindLabel = { reminder: 'Draw reminder', resultsReady: 'Results ready', nudge: 'Nudge', drawComplete: 'Draw complete', jackpot: 'Jackpot alert', hot: 'Hot numbers', other: 'Other' };
  const kindOrder = ['reminder', 'resultsReady', 'drawComplete', 'nudge', 'jackpot', 'hot', 'other'];
  const disabled = breakdown('notif_disabled_in_app', 'kind', days), enabled = breakdown('notif_enabled_in_app', 'kind', days);
  const optinTile = tile('Opt-in rate', granted + denied ? pct(granted / (granted + denied), 0) : '—', { sub: `${fmt(granted)} granted · ${fmt(denied)} denied · all-time` });
  const mixKeys = Object.keys(notifMix).filter((k) => k !== 'unknown');
  mount.appendChild(card({ title: 'Notifications', kicker: 'Permission and unique notification requests', cls: 'half', foot: `Unique requests are counted after iOS accepts scheduling, once per request. Opens count only requests measured by the new client. Cancellations and delivery are not observed: these window totals are not a delivery/open rate. Older clients reported ${fmt(legacyScheduled)} scheduling attempts.` },
    h('div', { class: 'tiles', style: { marginBottom: '14px' } }, optinTile,
      tile('Unique schedules', fmt(sumObj(sched)), { sub: `${state.window}d · ${fmt(sumObj(opened))} opened` }),
      tile('In-app toggles', fmt(sumObj(enabled) + sumObj(disabled)), { sub: `${fmt(sumObj(enabled))} on · ${fmt(sumObj(disabled))} off` })),
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '18px' } },
      h('div', null, h('div', { class: 'share-title', style: { marginBottom: '8px', color: MUTED, fontSize: '0.8rem' } }, 'Unique schedules by kind'),
        sumObj(sched) ? hbarList(kindOrder.filter((k) => sched[k]).map((k) => ({ label: kindLabel[k] || k, value: sched[k], color: ACCENT })), { tight: true }) : h('div', { class: 'empty compact' }, 'Nothing scheduled in this window.')),
      h('div', null, h('div', { class: 'share-title', style: { marginBottom: '8px', color: MUTED, fontSize: '0.8rem' } }, 'Permission status (5.1 devices)'),
        mixKeys.length ? hbarList(mixKeys.sort((a, b) => notifMix[b] - notifMix[a]).map((k) => ({ label: k, value: num(notifMix[k]), color: k === 'authorized' ? STATUS.good : k === 'denied' ? STATUS.crit : ACCENT })), { tight: true }) : h('div', { class: 'empty compact' }, 'No 5.1 devices have reported a status yet.')))));

  // --- Feature usage ---
  const screens = breakdown('screen_view', 'screen', days);
  const screenLabel = { home: 'Home', results: 'Results', numbers: 'Numbers', packs: 'Packs', settings: 'Settings', heatmap: 'Heatmap', badges: 'Badges', backtest: 'Backtest', scanner: 'Scanner', modelSheet: 'Model sheet' };
  const shares = breakdown('share', 'surface', days), shareDone = breakdown('share_completed', 'outcome', days);
  const widgets = breakdown('widget_open', 'kind', days);
  const packsGen = breakdown('pack_generated', 'spread', days);
  const tinyCounts = [
    ['Numbers copied', sumEvent('numbers_copied', null, days)], ['Favorites saved', sumEvent('favorite_saved', null, days)],
    ['Widget opens', sumObj(widgets)], ['Edge window changed', sumEvent('edge_window_changed', null, days)],
    ['Language changed', sumEvent('language_changed', null, days)], ['Model sheet opened', sumEvent('model_chooser_opened', null, days)],
    ['Neuron viewed', sumEvent('enhanced_viewed', null, days)], ['Evidence opened', sumEvent('evidence_opened', null, days)],
    ['Quantum details', sumEvent('quantum_details_opened', null, days)], ['Review prompts', sumEvent('review_prompt', null, days)],
    ['Packs generated', sumObj(packsGen)], ['Watch paired', dev ? num(dev.watch) : 0],
  ];
  mount.appendChild(card({ title: 'Feature usage', kicker: `Screens and actions · last ${state.window} days`, cls: 'half', foot: `Widgets placed on 5.1 devices: ${dev && isObj(dev.widgets) && Object.keys(dev.widgets).length ? Object.entries(dev.widgets).map(([k, n]) => `${k} ×${fmt(n)}`).join(', ') : 'none reported yet'}.` },
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '18px' } },
      h('div', null, h('div', { class: 'share-title', style: { marginBottom: '8px', color: MUTED, fontSize: '0.8rem' } }, 'Screen views'),
        sumObj(screens) ? hbarList(Object.keys(screens).sort((a, b) => screens[b] - screens[a]).map((k) => ({ label: screenLabel[k] || k, value: screens[k], color: ACCENT })), { tight: true }) : h('div', { class: 'empty compact' }, 'No screen views in this window.')),
      h('div', null, h('div', { class: 'share-title', style: { marginBottom: '8px', color: MUTED, fontSize: '0.8rem' } }, 'Shares'),
        h('div', { class: 'tiles' }, tile('Share sheets', fmt(sumObj(shares)), { sub: Object.entries(shares).map(([k, n]) => `${k} ${fmt(n)}`).join(' · ') || 'none' }),
          tile('Completed', fmt(num(shareDone.completed)), { sub: sumObj(shareDone) ? `${pct(num(shareDone.completed) / sumObj(shareDone), 0)} completion · ${fmt(num(shareDone.cancelled))} cancelled` : 'from the real share sheet' })))),
    h('div', { class: 'tiles', style: { marginTop: '14px' } }, ...tinyCounts.map(([l, v]) => tile(l, fmt(v))))));

  // --- Packs & scanner ---
  const packs = v3() && isObj(v3().packs) ? v3().packs : {};
  const packRows = [];
  const spreadOrder = ['half', 'full', 'plus', 'double'];
  for (const [l, spreads] of Object.entries(packs)) for (const [sp, s] of Object.entries(spreads || {})) if (isObj(s) && num(s.n) > 0) packRows.push({ lottery: l, spread: sp, ...s });
  packRows.sort((a, b) => LOTTERIES.indexOf(a.lottery) - LOTTERIES.indexOf(b.lottery) || spreadOrder.indexOf(a.spread) - spreadOrder.indexOf(b.spread));
  const tierLabel = (k) => { const m = String(k).match(/^(\d)_(true|false|[0-2])$/); return m ? `${m[1]}${m[2] === 'true' ? '+S' : /^[12]$/.test(m[2]) ? `+${m[2]}★` : ''}` : String(k); };
  const distSum = (d) => Object.entries(d || {}).reduce((acc, [k, v]) => { const n = num(v); acc.lines += n; acc.matches += num(k) * n; if (num(k) > 0) acc.hits += n; return acc; }, { lines: 0, matches: 0, hits: 0 });
  const scans = breakdown('scan', 'outcome', days), scanMode = breakdown('scan', 'mode', days), scanLat = breakdown('scan', 'latency', days);
  const scanRes = v3() && isObj(v3().scanResults) ? Object.entries(v3().scanResults).filter(([, s]) => isObj(s) && num(s.n) > 0).map(([l, s]) => ({ lottery: l, ...s })) : [];
  mount.appendChild(card({ title: 'Ticket packs', kicker: 'Spreads generated and scored · since 5.1', cls: 'half', foot: 'Hit lines = lines with ≥1 main match; the chance column is the same baseline as the Proof chapter. ROI = prize ÷ cost at the game\'s ticket price.' },
    packRows.length ? table([
      { key: 'lottery', label: 'Game', render: (r) => chip(r.lottery) },
      { key: 'spread', label: 'Spread', render: (r) => h('b', null, r.spread) },
      { key: 'n', label: 'Packs', num: true, render: (r) => fmt(r.n) },
      { key: 'lines', label: 'Lines', num: true, render: (r) => fmt(num(r.lines) || distSum(r.dist).lines) },
      { key: 'hit', label: 'Hit lines', num: true, render: (r) => { const d = distSum(r.dist); return d.lines ? pct(d.hits / d.lines, 0) : '—'; } },
      { key: 'chance', label: 'Chance', num: true, render: (r) => pct(CHANCE_HIT[r.lottery], 0) },
      { key: 'avg', label: 'Avg matches', num: true, render: (r) => { const d = distSum(r.dist); return d.lines ? (d.matches / d.lines).toFixed(2) : '—'; } },
      { key: 'cost', label: 'Cost', num: true, render: (r) => money(r.cost, CURRENCY[r.lottery]) },
      { key: 'prize', label: 'Prize', num: true, cls: () => 'money', render: (r) => money(r.prize, CURRENCY[r.lottery]) },
      { key: 'roi', label: 'ROI', num: true, render: (r) => (num(r.cost) ? pct(num(r.prize) / num(r.cost), 0) : '—') },
      { key: 'tiers', label: 'Best tiers', render: (r) => h('span', { class: 'muted' }, Object.entries(r.bestTierCounts || {}).filter(([, n]) => num(n) > 0).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${tierLabel(k)} ×${fmt(n)}`).join(', ') || '—') },
    ], packRows) : emptyState('Packs are reported once a spread\'s draw is scored on a 5.1 device.')));
  mount.appendChild(card({ title: 'Ticket scanner', kicker: 'scan outcomes and scanned-ticket results', cls: 'half', foot: 'Outcomes and latency are for the selected window; scanned-ticket match counts are all-time. Numbers on tickets are never sent.' },
    h('div', { class: 'tiles', style: { marginBottom: '14px' } },
      tile('Scans', fmt(sumObj(scans)), { sub: Object.entries(scanMode).map(([k, n]) => `${k} ${fmt(n)}`).join(' · ') || `last ${state.window}d` }),
      tile('Parsed', sumObj(scans) ? pct(num(scans.parsed) / sumObj(scans), 0) : '—', { sub: `${fmt(num(scans.unread))} unread · ${fmt(num(scans.error))} errors` }),
      tile('Under 3 s', sumObj(scanLat) ? pct((num(scanLat.lt1s) + num(scanLat['1-3s'])) / sumObj(scanLat), 0) : '—', { sub: 'parse latency' })),
    scanRes.length ? table([
      { key: 'lottery', label: 'Game', render: (r) => chip(r.lottery) },
      { key: 'n', label: 'Tickets', num: true, render: (r) => fmt(r.n) },
      ...[0, 1, 2, 3, 4, 5].map((i) => ({ key: 'd' + i, label: `${i}`, num: true, render: (r) => fmt(num((r.dist || {})[i])) })),
      { key: 'special', label: 'Special', num: true, render: (r) => fmt(r.special) },
      { key: 'tiers', label: 'Tiers', render: (r) => h('span', { class: 'muted' }, Object.entries(r.tiers || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${tierLabel(k)} ×${fmt(n)}`).join(', ') || '—') },
    ], scanRes) : emptyState('No scanned tickets have been scored on 5.1 devices yet. Columns 0–5 will show main-number matches per ticket.')));
}

// ============================================================================
// Chapter 4 — Money
// ============================================================================
const APPLE_TYPES = [
  ['SUBSCRIBED', 'New subscription', CAT[0]], ['EXPIRED', 'Expired', CAT[1]], ['DID_RENEW', 'Renewed', CAT[2]],
  ['DID_CHANGE_RENEWAL_STATUS', 'Auto-renew changed', CAT[3]], ['REFUND', 'Refund', CAT[4]], ['OFFER_REDEEMED', 'Offer redeemed', CAT[5]],
  ['DID_FAIL_TO_RENEW', 'Billing issue', CAT[6]], ['GRACE_PERIOD_EXPIRED', 'Grace period ended', CAT[7]],
];

function renderMoney(mount) {
  const days = windowDays();
  const labels = days.map(fmtDay);
  const subs = (state.data && isObj(state.data.subscribers)) ? state.data.subscribers : {};
  const snaps = (Array.isArray(subs.snapshots) ? subs.snapshots : []).filter((s) => s && isDay(s.date)).sort((a, b) => a.date.localeCompare(b.date));
  const byDate = {}; for (const s of snaps) byDate[s.date] = s;

  const snapshot = !state.subsError && state.subs?.snapshot;
  const appleHistory = !state.subsError && Array.isArray(state.subs?.history) ? state.subs.history.filter(s => s.day >= windowStart()) : [];
  mount.appendChild(chartCard('money', { title: 'Paid subscriptions reported by Apple', kicker: snapshot ? `Latest daily report: ${snapshot.day}` : 'Daily Apple report unavailable',
    spec: { type: 'line', labels: appleHistory.map(s => fmtDay(s.day)), xLabel: 'Report day', datasets: [{label:'Paid subscriptions',data:appleHistory.map(s=>s.paid),color:ACCENT}] },
    foot: snapshot ? `${fmt(snapshot.paid)} paid subscriptions · ${fmt(snapshot.freeTrials)} free trials · ${fmt(snapshot.billingRetry)} billing retry · ${fmt(snapshot.grace)} grace. This is the app-scoped Apple subscription report, not device counts. Historical points are report snapshots, not interpolated daily counts.` : 'The daily KPI job posts the latest available report with its actual date.' }));
  const ledger = !state.subsError && state.subs?.ledger;
  mount.appendChild(card({ title: 'Apple subscription ledger', kicker: 'Verified notifications · one record per original transaction',
    note: ledger?.note || 'Apple subscription accounting is unavailable.',
    foot: ledger ? `As of ${fmtStamp(ledger.asOf)}. Notifications observed since ${ledger.historyFrom || ledger.startedAt}. Grace periods are shown separately from paid active subscriptions. Annual or dormant subscriptions outside this history may be missing.` : 'Device counts below are not a substitute.' },
    ledger ? tiles(tile('Observed active', fmt(ledger.active)), tile('Grace', fmt(ledger.grace)), tile('Billing retry', fmt(ledger.billingRetry)),
      tile('Auto-renew off', fmt(ledger.autoRenewOff)), tile('Observed chains', fmt(ledger.observed)), tile('Expired chains', fmt(ledger.expired)), tile('Refunded / revoked chains', fmt(ledger.refunded))) : emptyState('Awaiting verified Apple ledger data.', 'Unavailable')));

  // --- Subscribed devices + new devices ---
  mount.appendChild(chartCard('money', { title: 'Devices reporting a subscription', kicker: 'Daily snapshot · device state, not paying people', cls: 'half',
    spec: { type: 'line', labels, xLabel: 'Day', datasets: [{ label: 'Subscribed devices', data: days.map((d) => byDate[d] ? num(byDate[d].subscribed) : null), color: ACCENT, fill: true }] },
    foot: `Now ${fmt(subs.subscribed)} of ${fmt(subs.total)} devices seen in 90 days (${subs.total ? pct(num(subs.subscribed) / num(subs.total)) : '—'}).` }));
  mount.appendChild(chartCard('money', { title: 'New devices per day', kicker: 'Daily snapshot · first seen that day', cls: 'half',
    spec: { type: 'bar', labels, xLabel: 'Day', datasets: [{ label: 'New devices', data: days.map((d) => byDate[d] ? num(byDate[d].newUsers) : 0), color: ACCENT }] },
    foot: 'Before 2026-09-10 the nightly job counted this at the wrong moment and it read ~0; it is real from then on.' }));

  // --- Paywall funnel ---
  const srcs = new Set();
  const win = {}; for (const ev of ['paywall_view', 'purchase_started', 'purchase_completed', 'subscribe', 'paywall_dismiss', 'purchase_cancelled', 'purchase_failed', 'purchase_pending']) { win[ev] = breakdown(ev, 'source', days); Object.keys(win[ev]).forEach((s) => srcs.add(s)); }
  const legacyViews = allTimeEvent('paywall_view') || {}, legacySubs = allTimeEvent('subscribe') || {};
  const allTimeSrcs = Array.from(new Set([...Object.keys(legacyViews), ...Object.keys(legacySubs)])).filter((s) => s !== 'debug');
  const srcRows = Array.from(srcs).sort((a, b) => num(win.paywall_view[b]) - num(win.paywall_view[a])).map((s) => ({ s, views: num(win.paywall_view[s]), started: num(win.purchase_started[s]), completed: num(win.purchase_completed[s]) || num(win.subscribe[s]), dismissed: num(win.paywall_dismiss[s]), failed: num(win.purchase_cancelled[s]) + num(win.purchase_failed[s]) + num(win.purchase_pending[s]) }));
  const winTotal = srcRows.reduce((a, r) => ({ views: a.views + r.views, started: a.started + r.started, completed: a.completed + r.completed, dismissed: a.dismissed + r.dismissed, failed: a.failed + r.failed }), { views: 0, started: 0, completed: 0, dismissed: 0, failed: 0 });
  const funnelSteps = [['Paywall views', winTotal.views], ['Purchase started', winTotal.started], ['Completed', winTotal.completed]];
  const ramp3 = ORDINAL(3);
  mount.appendChild(card({ title: 'Paywall funnel', kicker: `Last ${state.window} days · by source`, cls: 'half', foot: 'Sources are the surface that opened the paywall. Completed counts purchase_completed, or subscribe for older clients.' },
    winTotal.views ? h('div', { class: 'funnel', style: { marginBottom: '14px' } }, ...funnelSteps.map(([l, v], i) => h('div', { class: 'funnel-row' }, h('span', null, l),
      h('div', { class: 'funnel-track' }, h('span', { class: 'funnel-fill', style: { width: pct(clamp(v / Math.max(winTotal.views, 1), 0, 1), 1), background: ramp3[i] } })),
      h('span', { class: 'funnel-val' }, h('b', null, fmt(v)), i ? ` · ${pct(v / Math.max(winTotal.views, 1), 1)}` : '')))) : emptyState('No paywall views in this window from 5.1 devices.'),
    srcRows.length ? table([
      { key: 's', label: 'Source', render: (r) => h('b', null, r.s) }, { key: 'views', label: 'Views', num: true, render: (r) => fmt(r.views) },
      { key: 'started', label: 'Started', num: true, render: (r) => fmt(r.started) }, { key: 'completed', label: 'Completed', num: true, render: (r) => fmt(r.completed) },
      { key: 'dismissed', label: 'Dismissed', num: true, render: (r) => fmt(r.dismissed) }, { key: 'failed', label: 'Cancel/fail', num: true, render: (r) => fmt(r.failed) },
      { key: 'conv', label: 'Convert', num: true, render: (r) => (r.views ? pct(r.completed / r.views) : '—') },
    ], srcRows) : null,
    h('div', { class: 'card-foot', style: { marginTop: '14px' } }, h('b', null, 'All-time (legacy counters): '), allTimeSrcs.length ? allTimeSrcs.map((s) => `${s} ${fmt(num(legacyViews[s]))} views → ${fmt(num(legacySubs[s]))} subs (${num(legacyViews[s]) ? pct(num(legacySubs[s]) / num(legacyViews[s])) : '—'})`).join(' · ') : 'none')));

  // --- Paywall context ---
  const jp = breakdown('paywall_view', 'jackpot', days), dsi = breakdown('paywall_view', 'drawsSinceInstall', days), intro = breakdown('paywall_view', 'introEligible', days), price = breakdown('paywall_view', 'price', days);
  const jpOrder = ['unknown', 'lt100M', '100-300M', '300-500M', '500M-1B', '1Bplus'], jpLabel = { unknown: 'Unknown', lt100M: '< $100M', '100-300M': '$100–300M', '300-500M': '$300–500M', '500M-1B': '$500M–1B', '1Bplus': '$1B+' };
  const dsiOrder = ['0', '1-2', '3-5', '6plus'], dsiLabel = { '0': 'Same day', '1-2': '1–2 draws', '3-5': '3–5 draws', '6plus': '6+ draws' };
  const ordered = (obj, order) => [...order.filter((k) => obj[k]), ...Object.keys(obj).filter((k) => !order.includes(k))];
  mount.appendChild(card({ title: 'Paywall context', kicker: 'What was true when the paywall showed', cls: 'half', foot: 'Jackpot band and draws-since-install ride on every paywall view since 5.1; price is the localized product price the sheet displayed.' },
    shareBar('By jackpot band', ordered(jp, jpOrder).map((k, i) => ({ label: jpLabel[k] || k, value: jp[k], color: k === 'unknown' ? OTHER : ORDINAL(6)[Math.max(jpOrder.indexOf(k), 0)] })), { unit: 'views' }),
    shareBar('By draws since install', ordered(dsi, dsiOrder).map((k) => ({ label: dsiLabel[k] || k, value: dsi[k], color: ORDINAL(4)[Math.max(dsiOrder.indexOf(k), 0)] })), { unit: 'views' }),
    shareBar('Intro offer eligible', ['yes', 'no', 'unknown'].filter((k) => intro[k]).map((k, i) => ({ label: k === 'yes' ? 'Eligible' : k === 'no' ? 'Not eligible' : 'Not resolved', value: intro[k], color: CAT[i] })), { unit: 'views' }),
    Object.keys(price).length ? h('div', { class: 'card-foot' }, h('b', null, 'Prices shown: '), Object.entries(price).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k.replace('_', ' ')} ×${fmt(n)}`).join(' · ')) : null));

  // --- Apple subscription events ---
  const appleDays = days;
  const ev = state.subs && isObj(state.subs.events) ? state.subs.events : null;
  const typeOf = (k) => String(k).split(':')[0];
  const subOf = (k) => String(k).split(':')[1] || '';
  const perType = {}, perDay = {};
  const totals30 = {};
  if (ev) {
    for (const d of appleDays) {
      const m = isObj(ev[d]) ? ev[d] : {};
      for (const [k, n] of Object.entries(m)) {
        const t = typeOf(k); if (t === 'TEST') continue;
        if (!perType[t]) perType[t] = appleDays.map(() => 0);
        perType[t][appleDays.indexOf(d)] += num(n);
        perDay[k] = (perDay[k] || 0) + num(n);
        totals30[t] = (totals30[t] || 0) + num(n);
      }
    }
  }
  const known = APPLE_TYPES.filter(([t]) => perType[t]);
  const unknownTypes = Object.keys(perType).filter((t) => !APPLE_TYPES.some(([k]) => k === t));
  const datasets = known.map(([t, label, color]) => ({ label, data: perType[t], color }));
  if (unknownTypes.length) datasets.push({ label: 'Other', data: appleDays.map((_, i) => sum(unknownTypes.map((t) => perType[t][i]))), color: OTHER });
  const autoOff = sum(Object.entries(perDay).filter(([k]) => k.startsWith('DID_CHANGE_RENEWAL_STATUS') && subOf(k) === 'AUTO_RENEW_DISABLED').map(([, n]) => n));
  const autoOn = sum(Object.entries(perDay).filter(([k]) => k.startsWith('DID_CHANGE_RENEWAL_STATUS') && subOf(k) === 'AUTO_RENEW_ENABLED').map(([, n]) => n));
  const appleTiles = tiles(
    tile('Renewals', fmt(num(totals30.DID_RENEW)), { sub: `last ${state.window}d` }),
    tile('New subscriptions', fmt(num(totals30.SUBSCRIBED)), { sub: 'SUBSCRIBED notifications' }),
    tile('Refunds', fmt(num(totals30.REFUND)), { sub: num(totals30.CONSUMPTION_REQUEST) ? `${fmt(totals30.CONSUMPTION_REQUEST)} consumption requests` : 'REFUND notifications' }),
    tile('Expired', fmt(num(totals30.EXPIRED)), { sub: Object.entries(perDay).filter(([k]) => k.startsWith('EXPIRED:')).map(([k, n]) => `${subOf(k).toLowerCase()} ${fmt(n)}`).join(' · ') || 'EXPIRED notifications' }),
    tile('Auto-renew off', fmt(autoOff), { sub: autoOn ? `${fmt(autoOn)} turned it back on` : 'churn signal ahead of expiry' }),
    tile('Billing issues', fmt(num(totals30.DID_FAIL_TO_RENEW)), { sub: num(totals30.GRACE_PERIOD_EXPIRED) ? `${fmt(totals30.GRACE_PERIOD_EXPIRED)} grace periods ended` : 'DID_FAIL_TO_RENEW' }));
  const appleCard = chartCard('money', { title: 'Apple subscription events', kicker: 'App Store Server Notifications v2 · per day', cls: 'half',
    spec: { type: 'bar', stacked: true, labels: appleDays.map(fmtDay), xLabel: 'Day', datasets },
    empty: SUBS_URL ? (state.subsError ? 'Could not load /subscription-events.' : 'No notifications in this window. Apple delivers renewals, refunds and expirations here since 2026-09-10.') : 'Not loaded in fixture mode (pass ?subs=<url>).',
    emptyTag: SUBS_URL && !state.subsError ? 'Collecting' : 'Unavailable',
    foot: 'Counts of notification types as Apple delivered them; a subtype (voluntary, billing retry, auto-renew disabled) rides in the tooltip table. Verified live on 2026-09-10.' });
  appleCard.classList.add('half');
  mount.appendChild(card({ title: 'Subscription health', kicker: `Apple · last ${state.window} days`, cls: 'half', foot: 'Renewals extend existing subscriptions; they do not add subscribers. Expiration/refund notifications may concern the same subscription. Current state comes from the ledger above.' }, appleTiles,
    Object.keys(perDay).length ? h('div', { style: { marginTop: '14px' } }, table([{ key: 'k', label: 'Notification', render: (r) => h('span', { style: { fontFamily: 'var(--mono)', fontSize: '0.74rem' } }, r.k) }, { key: 'n', label: 'Count', num: true, render: (r) => fmt(r.n) }], Object.entries(perDay).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })))) : null));
  mount.appendChild(appleCard);

  // --- Growth weekly + reconcile ---
  const growth = (v3() && Array.isArray(v3().growth) ? v3().growth : []).filter((r) => r && r.weekEnding).sort((a, b) => String(b.weekEnding).localeCompare(String(a.weekEnding)));
  const rec = v3() && isObj(v3().reconcile) ? v3().reconcile : null;
  const proceeds = (p) => { if (p == null || p === '') return '—'; return String(p).split(';').map((part) => { const m = part.match(/^([A-Z]{3}):(-?[\d.]+)$/); return m ? money(Number(m[2]), m[1], 2) : part; }).join(' + '); };
  mount.appendChild(card({ title: 'Weekly growth', kicker: 'App Store Connect · PowerPlayAI only · retried daily', cls: 'two-thirds', foot: 'Downloads, new subs, renewals, units and proceeds come from App Store Connect Sales & Trends; first opens and new devices from the app for the same ISO week. New subscription units are net of refunds; their ratio to downloads is not cohort conversion.' },
    growth.length ? table([
      { key: 'weekEnding', label: 'Week ending', render: (r) => h('b', null, r.weekEnding) },
      { key: 'firstDownloads', label: 'Downloads', num: true, render: (r) => fmt(r.firstDownloads) },
      { key: 'firstOpen', label: 'First opens', num: true, render: (r) => (rec && rec.weekEnd === r.weekEnding ? fmt(rec.firstOpen) : h('span', { class: 'muted' }, '—')) },
      { key: 'newDevices', label: 'New devices', num: true, render: (r) => (rec && rec.weekEnd === r.weekEnding ? fmt(rec.newDevices) : h('span', { class: 'muted' }, '—')) },
      { key: 'newSubs', label: 'New subs', num: true, render: (r) => fmt(r.newSubs) },
      { key: 'renewals', label: 'Renewals', num: true, render: (r) => fmt(r.renewals) },
      { key: 'subUnits', label: 'Sub units', num: true, render: (r) => fmt(r.subUnits) },
      { key: 'dlToPaid', label: 'New units / DL', num: true, render: (r) => (r.dlToPaid == null ? '—' : pct(r.dlToPaid)) },
      { key: 'proceeds', label: 'Proceeds', num: true, cls: () => 'money', render: (r) => proceeds(r.proceeds) },
    ], growth) : emptyState('No weekly rows yet. `node scripts/kpi/kpi.mjs --post` publishes one every Monday.')));
  const checks = [];
  if (rec) {
    const flags = Array.isArray(rec.flags) ? rec.flags : [];
    const has = (f) => flags.includes(f);
    checks.push({ kind: rec.downloads == null ? 'warn' : has('first_open_below_half_of_downloads') ? 'warn' : 'ok', title: `Downloads ${fmt(rec.downloads)} vs first opens ${fmt(rec.firstOpen)} vs new devices ${fmt(rec.newDevices)}`,
      why: rec.downloads == null ? 'No App Store row for this week yet.' : has('first_open_below_half_of_downloads') ? 'First opens come only from 5.1 devices; expect this flag until most installs are on 5.1. If it persists, check territory mix and the workers.dev DNS block.' : 'Opens and downloads agree within the tolerance.' });
    checks.push({ kind: rec.newSubsSales == null ? 'warn' : has('new_subs_vs_subscribe_events_differ_gt_1') ? 'warn' : 'ok', title: `New subs (App Store) ${fmt(rec.newSubsSales)} vs subscribe events ${fmt(rec.subscribeEvents)} vs activations ${fmt(rec.subActivations)}`,
      why: rec.newSubsSales == null ? 'No App Store subscription row for this week; comparison unavailable.' : has('new_subs_vs_subscribe_events_differ_gt_1') ? 'Subscribe events only arrive from 5.1 devices; the gap closes as the rollout completes.' : 'App Store and in-app counts agree.' });
    checks.push({ kind: has('model_control_rows_differ_gt_5pct') ? 'crit' : 'ok', title: `Model rows ${fmt(rec.modelRows)} vs control rows ${fmt(rec.controlRows)} · ${fmt(rec.forecastsGenerated)} forecasts generated`,
      why: has('model_control_rows_differ_gt_5pct') ? 'Pair-tagged 5.1+ reports differ; check delayed delivery or missing partners. Older, untagged history is excluded.' : 'Pair-tagged model and control row totals agree; individual pair completeness is checked separately.' });
  }
  mount.appendChild(card({ title: 'Reconcile', kicker: rec ? `Week ${rec.week} · ${fmtDay(rec.weekStart)} – ${fmtDay(rec.weekEnd)}` : 'Latest complete ISO week', cls: 'third', foot: 'The Monday scorecard runs the same checks. Flags are hints, not verdicts.' },
    checks.length ? h('div', { class: 'checks' }, ...checks.map((c) => h('div', { class: 'check ' + c.kind }, h('span', { class: 'mark' }, c.kind === 'ok' ? '✓' : c.kind === 'warn' ? '!' : '✕'), h('div', null, h('div', null, c.title), h('div', { class: 'why' }, c.why))))) : emptyState('Reconcile appears once a complete ISO week has been built.')));
}

// ============================================================================
// Chapter 5 — Ops
// ============================================================================
const SRC_LABEL = { ny_pb: 'NY Open Data · Powerball', ny_mm: 'NY Open Data · Mega Millions', history_json: 'squatchcraft history.json', euro_api: 'EuroMillions API', euro_github: 'EuroMillions (GitHub)', jackpot_pb: 'Jackpot · Powerball', jackpot_mm: 'Jackpot · Mega Millions', prices: 'Ticket prices', prize_tables: 'Prize tables', jackpot_parse_powerball: 'Jackpot parse · Powerball', jackpot_parse_megaMillions: 'Jackpot parse · Mega Millions', jackpot_parse_euroMillions: 'Jackpot parse · EuroMillions' };

function renderOps(mount) {
  const days = windowDays();
  const labels = days.map(fmtDay);
  const health = v3() && isObj(v3().health) ? v3().health : {};
  const byDay = isObj(health.byDay) ? health.byDay : {};
  const hDays = days.filter((d) => byDay[d]);

  // --- Data health per day (ok vs fail) ---
  const okPerDay = days.map((d) => sum(Object.values(byDay[d] || {}).map((c) => c && c.ok))), failPerDay = days.map((d) => sum(Object.values(byDay[d] || {}).map((c) => c && c.fail)));
  mount.appendChild(chartCard('ops', { title: 'Data fetches per day', kicker: 'data_fetch + jackpot_parse · all sources · last 30 days max', cls: 'half',
    spec: { type: 'bar', stacked: true, labels, xLabel: 'Day', datasets: [{ label: 'OK', data: okPerDay, color: STATUS.good }, { label: 'Failed', data: failPerDay, color: STATUS.crit }] },
    empty: 'Fetch outcomes are reported by 5.1 devices.', foot: `${fmt(sum(failPerDay))} failures out of ${fmt(sum(okPerDay) + sum(failPerDay))} fetches (${sum(okPerDay) + sum(failPerDay) ? pct(sum(failPerDay) / (sum(okPerDay) + sum(failPerDay))) : '—'}). The worker keeps 30 days of health.` }));

  // --- Per-source table with latency mix ---
  const perSrc = {};
  for (const d of hDays) for (const [src, c] of Object.entries(byDay[d] || {})) { const p = perSrc[src] || (perSrc[src] = { ok: 0, fail: 0 }); p.ok += num(c && c.ok); p.fail += num(c && c.fail); }
  const latency = {};
  const b = eventsByDay();
  for (const d of days) { const dims = b[d] && b[d].data_fetch; if (!isObj(dims)) continue; for (const [k, c] of Object.entries(dims)) { const p = parseDims(k); const l = latency[p.src || 'unknown'] || (latency[p.src || 'unknown'] = { lt1s: 0, '1-3s': 0, '3-10s': 0, gt10s: 0 }); if (p.latency in l) l[p.latency] += num(c); } }
  const outcomes = {};
  for (const d of days) { const dims = b[d] && b[d].data_fetch; if (!isObj(dims)) continue; for (const [k, c] of Object.entries(dims)) { const p = parseDims(k); if (p.outcome && p.outcome !== 'ok') { const o = outcomes[p.src || 'unknown'] || (outcomes[p.src || 'unknown'] = {}); o[p.outcome] = (o[p.outcome] || 0) + num(c); } } }
  const latRamp = ORDINAL(4);
  const latBar = (l) => { const t = sumObj(l); return t ? h('span', { class: 'lat', title: `<1s ${fmt(l.lt1s)} · 1–3s ${fmt(l['1-3s'])} · 3–10s ${fmt(l['3-10s'])} · >10s ${fmt(l.gt10s)}` }, ...['lt1s', '1-3s', '3-10s', 'gt10s'].map((k, i) => h('span', { style: { width: pct(l[k] / t, 1), background: latRamp[i] } }))) : h('span', { class: 'muted' }, '—'); };
  const srcRows = Object.keys(perSrc).sort((a, b2) => (perSrc[b2].ok + perSrc[b2].fail) - (perSrc[a].ok + perSrc[a].fail)).map((s) => ({ s, ...perSrc[s], lat: latency[s], out: outcomes[s] }));
  mount.appendChild(card({ title: 'Sources', kicker: `Outcome and latency per source · last ${state.window} days`, cls: 'half', foot: 'Latency bar reads left to right: under 1 s, 1–3 s, 3–10 s, over 10 s (darker = slower). Fail share ≥ 50% on a day with ≥ 5 fetches raises an alert.' },
    srcRows.length ? table([
      { key: 's', label: 'Source', render: (r) => h('span', { title: r.s }, SRC_LABEL[r.s] || r.s) },
      { key: 'n', label: 'Fetches', num: true, render: (r) => fmt(r.ok + r.fail) },
      { key: 'fail', label: 'Failed', num: true, render: (r) => (r.fail ? h('span', null, fmt(r.fail), ' ', h('span', { class: 'muted' }, Object.entries(r.out || {}).map(([k, n]) => `${k} ${fmt(n)}`).join(', '))) : '0') },
      { key: 'share', label: 'Fail share', num: true, render: (r) => { const t = r.ok + r.fail, sh = t ? r.fail / t : 0; return statusChip(sh >= 0.5 ? 'crit' : sh >= 0.1 ? 'warn' : 'ok', pct(sh)); } },
      { key: 'lat', label: 'Latency mix', render: (r) => latBar(r.lat || {}) },
      { key: 'slow', label: '> 3 s', num: true, render: (r) => { const l = r.lat || {}; const t = sumObj(l); return t ? pct((num(l['3-10s']) + num(l.gt10s)) / t, 0) : '—'; } },
    ], srcRows) : emptyState('Per-source health appears with the first 5.1 fetch report.'),
    h('ul', { class: 'alerts' }, ...(Array.isArray(health.alerts) ? health.alerts : []).filter((a) => isObj(a) && (!a.day || days.includes(a.day))).slice(0, 12).map((a) => h('li', { class: num(a.failShare) >= 0.8 ? 'crit' : 'warn' }, h('span', { class: 'k' }, 'alert'), `${SRC_LABEL[a.src] || a.src || 'unknown source'} · ${fmtDay(a.day)} · ${pct(a.failShare, 0)} of ${fmt(a.n)} fetches failed`)))));

  // --- Other data signals ---
  const stale = breakdown('data_staleness', 'lottery', days), disagree = breakdown('data_disagreement', 'lottery', days), jpFail = breakdown('jackpot_parse', 'lottery', days, (p) => p.outcome === 'fail'), errs = breakdown('error_shown', 'kind', days);
  const signalRows = [
    ...Object.entries(stale).map(([l, n]) => ({ what: 'Draw-to-fetch delay', where: gameName(l), n, why: Object.entries(breakdown('data_staleness', 'hours', days, p => p.lottery === l)).map(([k, c]) => `${k}h ×${fmt(c)}`).join(', ') })),
    ...Object.entries(disagree).map(([l, n]) => ({ what: 'Sources disagreed', where: gameName(l), n, why: 'view-model dictionary vs history cache' })),
    ...Object.entries(jpFail).map(([l, n]) => ({ what: 'Jackpot parse failed', where: gameName(l), n, why: 'headline amount not readable' })),
    ...Object.entries(errs).map(([k, n]) => ({ what: 'Error shown to user', where: k, n, why: '' })),
  ].sort((a, b2) => b2.n - a.n);
  mount.appendChild(card({ title: 'Data signals', kicker: 'Return timing, disagreement, parse failures, errors shown', cls: 'third', foot: 'Draw-to-fetch delay measures the time from the drawing to the device fetching its results, often when the user returns. It is not a stale-data or source-latency measure. Each game has its own breakdown.' },
    signalRows.length ? table([{ key: 'what', label: 'Signal', render: (r) => r.what }, { key: 'where', label: 'Where', render: (r) => r.where }, { key: 'n', label: 'Count', num: true, render: (r) => fmt(r.n) }, { key: 'why', label: 'Detail', render: (r) => h('span', { class: 'muted' }, r.why) }], signalRows) : h('div', { class: 'empty' }, h('span', { class: 'tag' }, 'Quiet'), 'No draw-to-fetch, disagreement, parse-failure or user-facing error events in this window.')));

  // --- Reliability: MetricKit + Neuron runs ---
  const mk = seriesByDim('metrickit', 'kind', days, { order: ['crash', 'hang', 'launch_slow', 'memory'] });
  const mkLabel = { crash: 'Crashes', hang: 'Hangs', launch_slow: 'Slow launches', memory: 'Memory warnings' };
  mount.appendChild(chartCard('ops', { title: 'Crashes and hangs', kicker: 'MetricKit diagnostics · per day', cls: 'third',
    spec: { type: 'bar', stacked: true, labels, xLabel: 'Day', datasets: mk.values.map((v, i) => ({ label: mkLabel[v] || v, data: mk.rows[v], color: CAT[i] })) },
    empty: 'No MetricKit diagnostics received. That is the good outcome; iOS delivers them up to a day late.', emptyTag: 'Quiet',
    foot: (() => { const codes = breakdown('metrickit', 'code', days); const top = Object.entries(codes).sort((a, b2) => b2[1] - a[1]).slice(0, 3); return top.length ? 'Top codes: ' + top.map(([k, n]) => `${k} ×${fmt(n)}`).join(', ') : 'Codes appear in the tooltip once diagnostics arrive.'; })() }));
  const dur = breakdown('enhanced_run', 'duration', days), durOrder = ['lt5', '5-15', '15-30', 'gt30'], durLabel = { lt5: '< 5 s', '5-15': '5–15 s', '15-30': '15–30 s', gt30: '> 30 s' };
  const expired = sumEvent('enhanced_run', (p) => p.expired === 'yes', days), shortB = sumEvent('enhanced_run', (p) => p.budget === 'short', days), runs = sumEvent('enhanced_run', null, days);
  const runsByGame = breakdown('enhanced_run', 'lottery', days);
  mount.appendChild(card({ title: 'Neuron runs', kicker: 'enhanced_run · on-device training time', cls: 'third', foot: 'The engine trains under a time budget; "expired" runs hit the budget before converging. Short budget = Low Power Mode or background.' },
    runs ? h('div', null, h('div', { class: 'tiles', style: { marginBottom: '12px' } }, tile('Runs', fmt(runs), { sub: Object.entries(runsByGame).map(([l, n]) => `${gameName(l)} ${fmt(n)}`).join(' · ') }), tile('Hit the budget', pct(expired / runs, 0), { sub: `${fmt(expired)} expired` }), tile('Short budget', pct(shortB / runs, 0), { sub: `${fmt(shortB)} runs` })),
      shareBar('Run duration', durOrder.filter((k) => dur[k]).map((k, i) => ({ label: durLabel[k], value: dur[k], color: ORDINAL(4)[durOrder.indexOf(k)] })), { unit: 'runs' })) : emptyState('Neuron run timings arrive from 5.1 devices that generate a Neuron forecast.')));

  // --- Audience ---
  const dev = v3() && isObj(v3().devices) ? v3().devices : null;
  const MIX = [['byApp', 'App version'], ['byOS', 'iOS version'], ['byDeviceClass', 'Device class'], ['byRegion', 'Region'], ['byStorefront', 'Storefront'], ['byLang', 'Language'], ['bySubState', 'Subscription state'], ['byNotif', 'Notification status']];
  const mixCards = dev ? MIX.map(([k, title]) => {
    const src = isObj(dev[k]) ? dev[k] : {};
    const entries = Object.entries(src).map(([l, n]) => ({ label: l === 'unknown' ? 'unknown (pre-5.1)' : l === 'legacy' ? 'legacy (pre-5.1)' : l, value: num(n), dim: l === 'unknown' || l === 'legacy' })).sort((a, b2) => b2.value - a.value).slice(0, 8);
    return entries.length ? h('div', null, h('div', { class: 'share-title', style: { marginBottom: '8px', color: MUTED, fontSize: '0.8rem' } }, title), hbarList(entries, { tight: true })) : null;
  }).filter(Boolean) : [];
  const v3Devices = dev && isObj(dev.byApp) ? sum(Object.entries(dev.byApp).filter(([k]) => k !== 'legacy').map(([, n]) => n)) : 0;
  mount.appendChild(card({ title: 'Audience', kicker: `Devices seen in 90 days · ${fmt(dev ? dev.byApp && sumObj(dev.byApp) : 0)} total · ${fmt(v3Devices)} on 5.1+`, cls: 'two-thirds', foot: 'Devices imported from before 5.1 carry no version, OS, region or language; they show as the dimmed "pre-5.1" rows and fade out under the 90-day prune.' },
    mixCards.length ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: '18px 22px' } }, ...mixCards) : emptyState('Device blocks arrive with the first 5.1 presence ping.')));

  // --- Pipeline + coverage ---
  const v = v3();
  const rej = v && isObj(v.rejected) ? v.rejected : {};
  const seenWindow = new Set(); for (const d of days) for (const n of Object.keys(b[d] || {})) seenWindow.add(n);
  const seenEver = new Set([...Object.keys((state.data && isObj(state.data.events)) ? state.data.events : {}), ...daysWithEvents().flatMap((d) => Object.keys(b[d] || {}))]);
  const catalog = EVENT_CATALOG.map((n) => ({ n, cls: seenWindow.has(n) ? 'seen' : seenEver.has(n) ? '' : 'never' }));
  const pill = $('statusPill'), pillText = $('statusText');
  const ageMin = state.data && state.data.lastUpdated ? Math.round((Date.now() - new Date(state.data.lastUpdated).getTime()) / 60000) : null;
  mount.appendChild(card({ title: 'Pipeline', kicker: 'Worker build and event coverage', cls: 'third', foot: `Whitelisted events: green = seen in the last ${state.window} days, plain = seen before, dashed = never received. Three link-out events are deferred to 5.1 and omitted.` },
    h('div', { class: 'tiles', style: { marginBottom: '14px' } },
      tile('Last built', fmtStamp(v && v.builtAt ? v.builtAt : state.data && state.data.lastUpdated), { sub: v ? `${v.build || '—'} build · ${v.channel || 'appstore'}` : 'legacy cache' }),
      tile('Rejected (30d)', fmt(num(rej.events) + num(rej.results) + num(rej.packs)), { sub: `${fmt(rej.events)} events · ${fmt(rej.results)} results · ${fmt(rej.packs)} packs` }),
      tile('Events seen', `${fmt(catalog.filter((c) => c.cls === 'seen').length)} / ${fmt(EVENT_CATALOG.length)}`, { sub: `${fmt(catalog.filter((c) => c.cls === 'never').length)} never received` })),
    h('div', { class: 'chips' }, ...catalog.map((c) => h('span', { class: 'ev ' + c.cls, title: c.cls === 'never' ? 'never received' : c.cls === 'seen' ? 'seen in this window' : 'seen before this window' }, c.n)))));
  if (pill) {
    pill.classList.toggle('stale', ageMin != null && ageMin > 120);
    pillText.textContent = '';
    append(pillText, ['Live · ', h('b', null, ageMin == null ? '—' : ageMin < 1 ? 'just now' : ageMin < 60 ? `${ageMin} min ago` : `${Math.round(ageMin / 60)} h ago`), v ? ` · ${v.channel || 'appstore'}` : '']);
  }
}

// ============================================================================
// Chapter 6 — Explore
// ============================================================================
function renderExplore(mount) {
  const days = windowDays();
  const b = eventsByDay();
  const names = Array.from(new Set(days.flatMap((d) => Object.keys(b[d] || {})))).sort();
  if (!names.length) { mount.appendChild(card({ title: 'Event explorer' }, emptyState('No events in this window. Widen the window, or wait for 5.1 devices to report.'))); return; }
  if (!names.includes(state.explore.event)) state.explore.event = names.includes('forecast_generated') ? 'forecast_generated' : names[0];
  const dimsFor = (name) => { const set = new Set(); for (const d of days) for (const k of Object.keys((b[d] && b[d][name]) || {})) Object.keys(parseDims(k)).forEach((x) => set.add(x)); return Array.from(set).sort(); };
  let dims = dimsFor(state.explore.event);
  if (!dims.includes(state.explore.dim)) state.explore.dim = dims[0] || '';
  const evSel = h('select', { class: 'sel' }, ...names.map((n) => h('option', { value: n, selected: n === state.explore.event }, n)));
  const dimSel = h('select', { class: 'sel' }, h('option', { value: '', selected: !state.explore.dim }, '(total)'), ...dims.map((n) => h('option', { value: n, selected: n === state.explore.dim }, n)));
  const holder = h('div');
  const draw = () => {
    destroyCharts('explore-chart');
    holder.textContent = '';
    const dim = state.explore.dim;
    const s = seriesByDim(state.explore.event, dim || null, days, { max: 8 });
    const total = sumObj(Object.fromEntries(s.values.map((v2) => [v2, sum(s.rows[v2])])));
    const spec = { type: 'bar', stacked: true, labels: days.map(fmtDay), xLabel: 'Day', datasets: s.values.map((v2, i) => ({ label: v2, data: s.rows[v2], color: v2 === 'Other' ? OTHER : CAT[i % CAT.length] })) };
    const cc = chartCard('explore-chart', { title: `${state.explore.event}${dim ? ' · by ' + dim : ''}`, kicker: `${fmt(total)} events · last ${state.window} days`, spec, empty: 'No rows for this event in the window.',
      foot: dim ? 'Up to eight values are drawn; the rest fold into Other. Every value is in the table.' : 'Pick a dimension to split the daily totals.' });
    cc.classList.remove('card'); cc.classList.add('card'); cc.style.gridColumn = 'span 12';
    holder.appendChild(cc);
    if (dim) {
      const totals = breakdown(state.explore.event, dim, days);
      const rows = Object.entries(totals).sort((a, b2) => b2[1] - a[1]).map(([k, n]) => ({ k, n }));
      holder.appendChild(card({ title: `All ${dim} values`, kicker: 'Totals over the window' }, table([{ key: 'k', label: dim, render: (r) => h('span', { style: { fontFamily: 'var(--mono)', fontSize: '0.76rem' } }, r.k) }, { key: 'n', label: 'Events', num: true, render: (r) => fmt(r.n) }, { key: 'share', label: 'Share', num: true, render: (r) => pct(r.n / Math.max(total, 1)) }], rows)));
    }
  };
  evSel.addEventListener('change', () => { state.explore.event = evSel.value; dims = dimsFor(evSel.value); state.explore.dim = dims.includes('lottery') ? 'lottery' : (dims[0] || ''); dimSel.textContent = ''; append(dimSel, [h('option', { value: '', selected: !state.explore.dim }, '(total)'), ...dims.map((n) => h('option', { value: n, selected: n === state.explore.dim }, n))]); draw(); });
  dimSel.addEventListener('change', () => { state.explore.dim = dimSel.value; draw(); });
  mount.appendChild(card({ title: 'Event explorer', kicker: `${fmt(names.length)} event types in this window`, foot: 'Events are counted by the day they happened on the device (clamped to 7 days before receipt). Dimension values are what the app sent, after the worker\'s whitelist.' },
    h('div', { class: 'explore-controls' }, h('label', null, 'Event', evSel), h('label', null, 'Split by', dimSel)), holder));
  draw();
}

// ============================================================================
// Orchestration
// ============================================================================
const SECTIONS = [
  ['mount-scoreboard', renderScoreboard], ['mount-proof', renderProof], ['mount-loop', renderLoop],
  ['mount-money', renderMoney], ['mount-ops', renderOps], ['mount-explore', renderExplore],
];
function renderAll() {
  if (!state.data) return;
  for (const [id, fn] of SECTIONS) {
    const mount = $(id); if (!mount) continue;
    destroyCharts(id.replace('mount-', '')); destroyCharts('explore-chart');
    mount.textContent = '';
    try { fn(mount); } catch (e) { console.error(fn.name + ' failed:', e); mount.appendChild(card({ title: 'This chapter could not render' }, emptyState(String(e && e.message || e), 'Error'))); }
  }
  observeReveals();
}

async function fetchJSON(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(url.startsWith('http') ? `${url}${sep}cb=${Date.now()}` : url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function load() {
  const content = $('content');
  if (state.data) content.classList.add('refreshing');
  const [stats, subs, evidence] = await Promise.allSettled([fetchJSON(API_URL), SUBS_URL ? fetchJSON(SUBS_URL) : Promise.reject(new Error('disabled')), fetchJSON('./evidence.json')]);
  state.evidence = evidence.status === 'fulfilled' && Array.isArray(evidence.value.models) ? evidence.value : null;
  if (subs.status === 'fulfilled' && isObj(subs.value)) { state.subs = subs.value; state.subsError = null; } else if (SUBS_URL) { state.subsError = subs.reason; console.warn('subscription-events unavailable:', subs.reason && subs.reason.message); }
  if (stats.status === 'fulfilled' && isObj(stats.value)) {
    state.data = stats.value;
    $('loading').style.display = 'none'; $('error').style.display = 'none'; content.style.display = '';
    renderAll();
  } else {
    console.error('Failed to load stats:', stats.reason);
    const pill = $('statusPill'); if (pill) { pill.classList.add('down'); $('statusText').textContent = 'Worker unreachable'; }
    if (!state.data) { $('loading').style.display = 'none'; $('error').style.display = ''; }
  }
  content.classList.remove('refreshing');
}

// Filters
function wireFilters() {
  const segW = $('segWindow'), segG = $('segGame');
  const sync = () => {
    segW.querySelectorAll('button').forEach((b) => b.classList.toggle('active', Number(b.dataset.window) === state.window));
    segG.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.game === state.game));
  };
  segW.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.window = Number(b.dataset.window) || 30; sync(); renderAll(); });
  segG.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.game = b.dataset.game || 'all'; sync(); renderAll(); });
  sync();
}
// View: 'results' (public proof) vs 'all' (adds the operator chapters). Remembered per browser.
function applyView() {
  document.body.dataset.view = state.view;
  document.querySelectorAll('#segView button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  if (state.view === 'all') {
    // Charts built inside display:none containers have no size; give them one now that they are visible.
    setTimeout(() => { for (const list of state.charts.values()) for (const c of list) { try { c.resize(); } catch (e) { /* noop */ } } }, 0);
  }
}
function wireView() {
  const seg = $('segView'); if (!seg) return;
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    state.view = b.dataset.view === 'all' ? 'all' : 'results';
    writePref('ppai.dash.view', state.view);
    applyView();
    observeReveals();
  });
  applyView();
}

// Chapter nav highlighting + reveal animation
let revealObserver = null;
function observeReveals() {
  if (!('IntersectionObserver' in window)) return;
  if (!revealObserver) revealObserver = new IntersectionObserver((entries) => { for (const en of entries) if (en.isIntersecting) { en.target.classList.add('in'); revealObserver.unobserve(en.target); } }, { rootMargin: '240px 0px 240px 0px' });
  const fresh = Array.from(document.querySelectorAll('.card:not(.reveal)'));
  const limit = window.innerHeight + 240;
  fresh.forEach((c, i) => {
    c.classList.add('reveal'); c.style.transitionDelay = `${(i % 4) * 60}ms`;
    // Cards already on screen fade in right away; the observer handles the rest.
    if (c.getBoundingClientRect().top < limit) setTimeout(() => c.classList.add('in'), 0); else revealObserver.observe(c);
  });
  // Safety net: nothing stays hidden for long, whatever the observer does (fast scrolls, print, crawlers).
  setTimeout(() => { for (const c of fresh) { c.classList.add('in'); revealObserver.unobserve(c); } }, 1200);
}
function wireNav() {
  const links = Array.from(document.querySelectorAll('#nav a'));
  const sections = links.map((a) => $(a.getAttribute('href').slice(1))).filter(Boolean);
  if (!('IntersectionObserver' in window) || !sections.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) links.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#' + en.target.id));
  }, { rootMargin: '-40% 0px -55% 0px' });
  sections.forEach((s) => io.observe(s));
}

// Init
setChartDefaults();
wireFilters();
wireView();
wireNav();
load();
let timer = setInterval(load, REFRESH_MS);
let lastLoad = Date.now();
const loadTracked = () => { lastLoad = Date.now(); return load(); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clearInterval(timer); timer = null; return; }
  // Coming back to the tab: refresh only if the data could actually have moved (edge cache is 5 min).
  if (Date.now() - lastLoad > 60000) loadTracked();
  if (!timer) timer = setInterval(loadTracked, REFRESH_MS);
});
})();
