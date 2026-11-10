/**
 * main.js: UI wiring, state and the simulation clock.
 *
 * Inputs:  data/catalogue.json, data/tles.json, data/meta.json (relative paths);
 *          user actions (globe click or drawing, typed coordinates, ROI files,
 *          buffer, window, instruments); the URL hash.
 * Outputs: DOM updates, the live globe, pass computation in a Web Worker,
 *          the answer sentence, table, absences, CSV export and a shareable
 *          URL that reproduces the query.
 *
 * Limitations: polygons with more than 300 vertices are simplified before
 * computation (the change in area is shown); cloud forecast not yet included.
 */

import tzlookup from '../vendor/tz-lookup.js';
import {
  CRS, RoiError, parseCoordinates, readRoiFile, simplifyRoi, bufferRoi, createDrawer, parseHash, buildHash,
} from './roi.js';
import { roiAnchor, prepareRoi, polygonsOf } from './geometry.js';
import { loadCatalogue, filterEntries, entryStyle, shortName } from './catalogue.js';
import { loadTles, loadMeta, dataFreshness } from './tle.js';
import { t, setLang, getLang, formatDateTime, formatTimeSec } from './i18n.js';
import { createGlobe } from './globe.js';
import { makeTrackers, positions, tracks, liveSwaths, nightPolygon } from './live.js';
import { answerSentence, absences } from './absences.js';
import { passesToCsv, download } from './export.js';
import { ENGINE_VERSION } from './engine.js';

const $ = (sel) => document.querySelector(sel);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  catalogue: null,
  tles: null,
  meta: null,
  selected: new Set(),
  roi: null,
  tz: 'UTC',
  result: null,
  ranEntries: [],
  days: 16,
  selectedPass: null,
  sort: { key: 'closest_utc', dir: 1, col: 2 },
  clock: { baseSim: Date.now(), baseReal: performance.now(), speed: reducedMotion ? 1 : 60, playing: true },
};

// ---------- clock ----------

const simNow = () => {
  const c = state.clock;
  return c.playing ? c.baseSim + (performance.now() - c.baseReal) * c.speed : c.baseSim;
};

function setClock(patch) {
  const c = state.clock;
  c.baseSim = simNow();
  c.baseReal = performance.now();
  Object.assign(c, patch);
  const sel = $('#speed');
  if (![...sel.options].some((o) => o.value === String(c.speed))) sel.add(new Option(`${c.speed}×`, String(c.speed)), 0);
  sel.value = String(c.speed);
  renderPlay();
  lastDataUpdate = -Infinity;
  lastTrackSim = NaN;
}

// ---------- globe ----------

let globe;
let trackers = [];
let lastDataUpdate = -Infinity;
let lastTrackSim = NaN;

function activeEntries() {
  return filterEntries(state.catalogue.entries, { includeTransitional: $('#transitional').checked })
    .filter((e) => state.selected.has(e.id));
}

function rebuildTrackers() {
  trackers = makeTrackers(activeEntries(), state.tles);
  lastTrackSim = NaN;
  lastDataUpdate = -Infinity;
}

function frame() {
  const now = simNow();
  globe.setSatellites(positions(trackers, now).map((p) => ({
    id: p.tr.entry.id,
    label: shortName(p.tr.entry),
    title: `${p.tr.entry.platform} ${p.tr.entry.instrument}, ${p.height.toFixed(0)} km`,
    lat: p.lat,
    lon: p.lon,
    colour: entryStyle(p.tr.entry).colour,
    imaging: p.imaging,
  })));
  const real = performance.now();
  if (real - lastDataUpdate > 120) {
    lastDataUpdate = real;
    globe.setSwaths(liveSwaths(trackers, now));
    globe.setNight(nightPolygon(now));
    if (!(Math.abs(now - lastTrackSim) < 20000)) {
      lastTrackSim = now;
      globe.setTracks(tracks(trackers, now));
    }
    renderClock(now);
  }
  requestAnimationFrame(frame);
}

function renderClock(now) {
  const utc = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
  const local = state.roi ? `, ${formatTimeSec(now, state.tz)} ${state.tz}` : '';
  $('#clock').textContent = `${utc} UTC${local}`;
}

function renderPlay() {
  const b = $('#play');
  b.textContent = state.clock.playing ? t('time_pause') : t('time_play');
  b.setAttribute('aria-pressed', String(state.clock.playing));
}

// ---------- ROI ----------

let drawer;

function showRoiError(err) {
  const el = $('#roi-error');
  if (!err) { el.hidden = true; return; }
  const key = err instanceof RoiError ? err.message : null;
  el.textContent = key ? t(key) : t('file_read', { msg: err.message ?? String(err) });
  el.hidden = false;
}

function lonLatBounds(geom) {
  const pts = geom.type === 'Point' ? [geom.coordinates] : geom.coordinates.flat(geom.type === 'Polygon' ? 1 : 2);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]];
}

/** Set the ROI as entered (before buffer); `fly` moves the view to it. */
function setRoiGeom(geom, { warnings = [], fly = false } = {}) {
  showRoiError(null);
  state.roiRaw = geom;
  state.roiWarnings = warnings;
  applyBuffer();
  const a = roiAnchor(state.roi);
  try { state.tz = tzlookup(a.lat, a.lon); } catch { state.tz = 'UTC'; }
  state.result = null;
  state.selectedPass = null;
  renderFootprints();
  $('#run').disabled = false;
  $('#export-csv').disabled = true;
  $('#copy-link').disabled = true;
  $('#roi-clear').hidden = false;
  setAnswer(t('answer_ready'), '');
  renderTable();
  renderAbsences();
  if (fly) {
    if (geom.type === 'Point') globe.flyTo(a.lat, a.lon, Math.max(globe.map.getZoom(), 3));
    else globe.fitBounds(lonLatBounds(state.roi));
  }
}

function applyBuffer() {
  if (!state.roiRaw) return;
  state.buffer = Math.min(200, Math.max(0, Number($('#buffer').value) || 0));
  state.roi = bufferRoi(state.roiRaw, state.buffer);
  globe.setRoi(state.roi);
  renderRoiSummary();
}

function renderRoiSummary() {
  const el = $('#roi-summary');
  if (!state.roi) { el.textContent = ''; return; }
  const parts = [];
  if (state.roi.type === 'Point') {
    const [lon, lat] = state.roi.coordinates;
    parts.push(t('roi_point_summary', { lat: lat.toFixed(5), lon: lon.toFixed(5) }));
  } else {
    const prep = prepareRoi(state.roi);
    const n = polygonsOf(state.roi).reduce((k, p) => k + p.reduce((m, r) => m + r.length - 1, 0), 0);
    parts.push(t('roi_poly_summary', { area: Math.round(prep.area / 1e6).toLocaleString(getLang() === 'pt' ? 'pt-PT' : 'en-GB'), n }));
  }
  if (state.buffer > 0) parts.push(t('roi_buffer_summary', { km: state.buffer }));
  for (const w of state.roiWarnings ?? []) parts.push(t(w));
  if (state.simplifiedNote) parts.push(state.simplifiedNote);
  el.textContent = parts.join(' ');
}

function clearRoi() {
  drawer.stop();
  state.roi = null;
  state.roiRaw = null;
  state.result = null;
  state.simplifiedNote = '';
  globe.setRoi(null);
  renderFootprints();
  renderRoiSummary();
  $('#run').disabled = true;
  $('#export-csv').disabled = true;
  $('#copy-link').disabled = true;
  $('#roi-clear').hidden = true;
  setAnswer(t('answer_idle'), t('answer_idle_sub'));
  renderTable();
  renderAbsences();
  history.replaceState(null, '', location.pathname + location.search);
}

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('.segmented [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
  if (mode === 'point') drawer.stop(); else drawer.start(mode);
  renderDrawHint();
}

function renderDrawHint() {
  $('#draw-hint').textContent = t(`hint_${state.mode}`);
  $('#draw-actions').hidden = !drawer?.active;
  $('#draw-finish').hidden = state.mode !== 'polygon';
}

function renderCoordsLabel() {
  const key = $('#crs').value;
  $('#coords-label').textContent = t(CRS[key]?.latFirst ? 'coords_label_latlon' : 'coords_label_en');
  $('#custom-wrap').hidden = key !== 'custom';
  $('#coords').placeholder = CRS[key]?.latFirst ? '37.573, -7.971' : '120000 -150000';
}

// ---------- computation ----------

let worker = null;
let jobId = 0;

function runPasses() {
  if (!state.roi) return;
  const entries = activeEntries();
  const startVal = $('#start').value;
  const start = startVal ? `${startVal}:00Z` : new Date().toISOString();
  const days = Math.min(30, Math.max(1, Number($('#days').value) || 16));
  const simp = simplifyRoi(state.roi, 300);
  state.simplifiedNote = simp.simplified
    ? t('roi_simplified', { n: polygonsOf(simp.geom).reduce((k, p) => k + p.reduce((m, r) => m + r.length - 1, 0), 0), pct: `${simp.areaChangePct >= 0 ? '+' : ''}${simp.areaChangePct.toFixed(2)}` })
    : '';
  renderRoiSummary();
  updateHash(startVal, days, entries);
  worker?.terminate();
  worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
  const id = ++jobId;
  const t0 = performance.now();
  $('#run').disabled = true;
  setAnswer(t('answer_computing'), '');
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.id !== id) return;
    if (m.type === 'progress') $('#progress').textContent = t('progress', { done: m.done, total: m.total });
    if (m.type === 'error') { $('#progress').textContent = m.message; $('#run').disabled = false; }
    if (m.type === 'result') {
      $('#run').disabled = false;
      $('#progress').textContent = t('done_in', { n: m.result.passes.filter((p) => p.imaging_expected).length, s: ((performance.now() - t0) / 1000).toFixed(1) });
      state.result = m.result;
      state.ranEntries = entries;
      state.days = days;
      onResult(true);
    }
  };
  worker.postMessage({ id, query: { entries, tles: state.tles, roi: simp.geom, start, days } });
}

function updateHash(startVal, days, entries) {
  const defaults = filterEntries(state.catalogue.entries, {}).map((e) => e.id);
  const ids = entries.map((e) => e.id);
  const sameAsDefault = ids.length === defaults.length && ids.every((id) => defaults.includes(id));
  const hash = buildHash({
    roi: state.roiRaw,
    buffer: state.buffer,
    start: startVal || undefined,
    days,
    ids: sameAsDefault ? undefined : ids,
    transitional: $('#transitional').checked,
    lang: getLang(),
  });
  history.replaceState(null, '', hash);
}

/** Apply a query from the URL hash; returns true if it held an ROI. */
function applyHash() {
  if (!location.hash) return false;
  let q;
  try { q = parseHash(location.hash); } catch (err) { showRoiError(err); return false; }
  if (q.lang) setLang(q.lang);
  if (q.transitional) $('#transitional').checked = true;
  if (q.ids) state.selected = new Set(q.ids);
  if (q.days) $('#days').value = String(q.days);
  if (q.start) $('#start').value = q.start;
  if (q.buffer) $('#buffer').value = String(q.buffer);
  if (!q.roi) return false;
  setRoiGeom(q.roi, { fly: true });
  return true;
}

function onResult(fresh = false) {
  const a = answerSentence(state.result, { tz: state.tz, days: state.days, isPoint: state.roi.type === 'Point' });
  setAnswer(a.main, a.sub);
  renderTable();
  renderAbsences();
  $('#export-csv').disabled = !state.result.passes.some((p) => p.imaging_expected);
  $('#copy-link').disabled = false;
  if (fresh && a.best) selectPass(a.best.id, { fly: true });
  else renderFootprints();
}

function selectPass(id, { fly = false } = {}) {
  state.selectedPass = id;
  const p = state.result?.passes.find((x) => x.id === id);
  renderFootprints();
  for (const tr of document.querySelectorAll('#passes tbody tr')) tr.classList.toggle('is-selected', tr.dataset.id === id);
  if (!p) return;
  // Show the pass: start 90 s before closest approach at 10x (directly at closest approach with reduced motion).
  setClock(reducedMotion
    ? { baseSim: p.closest_utc, playing: false }
    : { baseSim: p.closest_utc - 90000, playing: true, speed: 10 });
  if (fly) { const a = roiAnchor(state.roi); globe.flyTo(a.lat, a.lon, state.roi.type === 'Point' ? 3.2 : Math.max(3.2, globe.map.getZoom())); }
}

function renderFootprints() {
  const feats = (state.result?.passes ?? []).filter((p) => p.imaging_expected).map((p) => ({
    type: 'Feature',
    properties: { id: p.entry_id, selected: p.id === state.selectedPass },
    geometry: { type: 'Polygon', coordinates: p.footprint },
  }));
  globe.setFootprints({ type: 'FeatureCollection', features: feats });
}

// ---------- rendering ----------

function setAnswer(main, sub) {
  $('#answer-main').textContent = main;
  $('#answer-sub').textContent = sub;
}

const COLS = [
  { key: 'platform', label: 'col_sat', cell: (p) => p.platform },
  { key: 'instrument', label: 'col_instrument', cell: (p) => p.instrument },
  { key: 'closest_utc', label: 'col_local', cell: (p) => formatDateTime(p.closest_utc, state.tz) },
  { key: 'closest_utc', label: 'col_utc', cell: (p) => new Date(p.closest_utc).toISOString().slice(11, 19), num: true },
  { key: 'direction', label: 'col_dir', cell: (p) => t(`dir_${p.direction}`) },
  { key: 'coverage_pct', label: 'col_cov', cell: (p) => p.coverage_pct.toFixed(0), num: true },
  { key: 'edge_margin_km', label: 'col_edge', cell: (p) => `${p.edge_margin_km.toFixed(1)}${p.edge_uncertain ? ` (${t('edge_uncertain')})` : ''}`, num: true, warn: (p) => p.edge_uncertain },
  { key: 'view_angle_deg', label: 'col_view', cell: (p) => p.view_angle_deg.toFixed(1), num: true },
  { key: 'sun_elevation_deg', label: 'col_sun', cell: (p) => p.sun_elevation_deg.toFixed(0), num: true },
  { key: 'tle_age_days', label: 'col_tle', cell: (p) => p.tle_age_days.toFixed(1), num: true, warn: (p) => p.tle_age_days > 7 },
  { key: 'acquisition', label: 'col_acq', cell: (p) => t(`acq_${p.acquisition}`) },
];

function renderTable() {
  const head = $('#passes thead');
  head.replaceChildren();
  const hr = document.createElement('tr');
  COLS.forEach((c, i) => {
    const th = document.createElement('th');
    th.scope = 'col';
    if (c.num) th.className = 'num';
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(c.label);
    b.addEventListener('click', () => {
      state.sort = { key: c.key, dir: state.sort.col === i ? -state.sort.dir : 1, col: i };
      renderTable();
    });
    if (state.sort.col === i) th.setAttribute('aria-sort', state.sort.dir > 0 ? 'ascending' : 'descending');
    th.append(b);
    hr.append(th);
  });
  head.append(hr);

  const body = $('#passes tbody');
  body.replaceChildren();
  const rows = (state.result?.passes ?? []).filter((p) => p.imaging_expected);
  const { key, dir } = state.sort;
  rows.sort((a, b) => (a[key] < b[key] ? -dir : a[key] > b[key] ? dir : a.closest_utc - b.closest_utc));
  for (const p of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = p.id;
    tr.tabIndex = 0;
    if (p.id === state.selectedPass) tr.classList.add('is-selected');
    for (const c of COLS) {
      const td = document.createElement('td');
      td.textContent = c.cell(p);
      if (c.num) td.className = 'num';
      if (c.warn?.(p)) td.classList.add('is-warn');
      if (c.key === 'platform') {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = entryStyle(state.catalogue.entries.find((e) => e.id === p.entry_id)).colour;
        td.prepend(dot);
      }
      tr.append(td);
    }
    tr.addEventListener('click', () => selectPass(p.id, { fly: true }));
    tr.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectPass(p.id, { fly: true }); }
    });
    body.append(tr);
  }
  $('#table-empty').hidden = rows.length > 0;
}

function renderAbsences() {
  const ul = $('#absences');
  ul.replaceChildren();
  if (!state.result) return;
  const list = absences(state.result, state.ranEntries, state.tz);
  if (!list.length) {
    const li = document.createElement('li');
    li.textContent = t('abs_empty');
    ul.append(li);
  }
  for (const { entry, text } of list) {
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = `${entry.platform} ${entry.instrument}`;
    li.append(name, document.createTextNode(` ${text}`));
    ul.append(li);
  }
}

function renderInstruments() {
  const ul = $('#instruments');
  ul.replaceChildren();
  const entries = filterEntries(state.catalogue.entries, { includeTransitional: $('#transitional').checked });
  for (const e of entries) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(e.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(e.id); else state.selected.delete(e.id);
      rebuildTrackers();
    });
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = entryStyle(e).colour;
    const text = document.createElement('span');
    text.className = 'inst-text';
    const name = document.createElement('span');
    name.textContent = `${e.platform} ${e.instrument}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${e.swath.width_km ?? ''} km, ${t(`acq_${e.acquisition}`)}`;
    text.append(name, meta);
    label.append(cb, dot, text);
    li.append(label);
    ul.append(li);
  }
}

function renderFreshness() {
  const el = $('#freshness');
  if (!state.meta?.updated_utc) { el.textContent = t('freshness_unknown'); el.classList.add('is-warn'); return; }
  const { hours, stale } = dataFreshness(state.meta);
  el.textContent = t('freshness_hours', { h: Math.max(0, Math.round(hours)) });
  el.classList.toggle('is-warn', stale);
}

function renderStatic() {
  document.documentElement.lang = getLang() === 'pt' ? 'pt-PT' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('#lang').textContent = t('lang_toggle');
  $('#panel-about').innerHTML = t('about_html');
  for (const el of document.querySelectorAll('.segmented')) el.setAttribute('aria-label', t('mode_label'));
  renderPlay();
  renderFreshness();
  renderInstruments();
  renderDrawHint();
  renderCoordsLabel();
  renderRoiSummary();
  if (state.result) onResult();
  else {
    renderTable();
    renderAbsences();
    if (state.roi) setAnswer(t('answer_ready'), '');
  }
}

// ---------- tabs ----------

function initTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const activate = (tab) => {
    for (const x of tabs) {
      const on = x === tab;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
    }
    tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight') activate(tabs[(i + 1) % tabs.length]);
      if (ev.key === 'ArrowLeft') activate(tabs[(i - 1 + tabs.length) % tabs.length]);
    });
  });
}

// ---------- init ----------

async function init() {
  try {
    [state.catalogue, state.tles, state.meta] = await Promise.all([
      loadCatalogue(), loadTles(), loadMeta().catch(() => null),
    ]);
  } catch (err) {
    setAnswer(t('load_error', { what: err.message }), '');
    return;
  }
  for (const e of filterEntries(state.catalogue.entries, {})) state.selected.add(e.id);

  globe = createGlobe($('#globe'), {
    onClick: ({ lat, lon }) => {
      if (drawer.active || state.mode !== 'point') return;
      setRoiGeom({ type: 'Point', coordinates: [lon, lat] });
    },
    attribution: 'Natural Earth, CelesTrak',
  });
  globe.setColours(Object.fromEntries(state.catalogue.entries.map((e) => [e.id, entryStyle(e).colour])));
  drawer = createDrawer(globe, {
    onDone: (geom) => { setRoiGeom(geom); setMode('point'); },
    onChange: () => renderDrawHint(),
  });
  state.mode = 'point';
  for (const [key, c] of Object.entries(CRS)) $('#crs').add(new Option(key === 'custom' ? t('custom_crs') : c.label, key));

  $('#start').value = new Date().toISOString().slice(0, 16);
  $('#speed').value = String(state.clock.speed);

  $('#lang').addEventListener('click', () => { setLang(getLang() === 'pt' ? 'en' : 'pt'); renderStatic(); });
  for (const b of document.querySelectorAll('.segmented [data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  $('#draw-finish').addEventListener('click', () => drawer.finish());
  $('#draw-cancel').addEventListener('click', () => setMode('point'));
  $('#crs').addEventListener('change', renderCoordsLabel);
  $('#apply-coords').addEventListener('click', () => {
    try {
      setRoiGeom(parseCoordinates($('#coords').value, $('#crs').value, $('#custom-crs').value), { fly: true });
    } catch (err) { showRoiError(err); }
  });
  $('#roi-file').addEventListener('change', async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const { geom, warnings } = await readRoiFile(file);
      setRoiGeom(geom, { warnings, fly: true });
    } catch (err) { showRoiError(err); }
    ev.target.value = '';
  });
  $('#buffer').addEventListener('change', () => { if (state.roiRaw) setRoiGeom(state.roiRaw, { warnings: state.roiWarnings }); });
  $('#roi-clear').addEventListener('click', clearRoi);
  $('#copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $('#link-status').textContent = t('link_copied');
    } catch {
      $('#link-status').textContent = location.href;
    }
    setTimeout(() => { $('#link-status').textContent = ''; }, 4000);
  });
  $('#days').addEventListener('input', () => { $('#days-warn').hidden = !(Number($('#days').value) > 16); });
  $('#transitional').addEventListener('change', () => {
    for (const e of state.catalogue.entries) if (e.status !== 'active') state.selected.add(e.id);
    renderInstruments();
    rebuildTrackers();
  });
  $('#run').addEventListener('click', runPasses);
  $('#play').addEventListener('click', () => setClock({ playing: !state.clock.playing }));
  $('#speed').addEventListener('change', () => setClock({ speed: Number($('#speed').value) }));
  $('#now').addEventListener('click', () => setClock({ baseSim: Date.now(), speed: 1, playing: true }));
  $('#export-csv').addEventListener('click', () => {
    const csv = passesToCsv(state.result.passes.filter((p) => p.imaging_expected), {
      tz: state.tz, catalogueVersion: state.catalogue.version, dataUpdated: state.meta?.updated_utc ?? '', engineVersion: ENGINE_VERSION,
    });
    download(`passagens_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  });
  initTabs();
  renderStatic();

  rebuildTrackers();
  await globe.ready;
  requestAnimationFrame(frame);
  if (applyHash()) {
    renderStatic();
    rebuildTrackers();
    runPasses();
  }
}

init();
