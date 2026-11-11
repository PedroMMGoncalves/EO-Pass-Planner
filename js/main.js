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

import {
  CRS, RoiError, parseCoordinates, readRoiFile, simplifyRoi, bufferRoi, createDrawer, parseHash, buildHash,
} from './roi.js';
import { roiAnchor, prepareRoi, polygonsOf } from './geometry.js';
import {
  loadCatalogue, filterEntries, entryStyle, shortName, defaultSelected, CATEGORIES,
} from './catalogue.js';
import { loadTles, loadMeta, dataFreshness } from './tle.js';
import {
  t, setLang, getLang, formatDateTime, formatTimeSec, formatDuration,
} from './i18n.js';
import { createGlobe, BASEMAPS } from './globe.js';
import { makeTrackers, positions, tracks, liveSwaths, nightPolygon } from './live.js';
import { answerSentence, absences, displayName } from './absences.js';
import {
  passesToCsv, passesToIcs, footprintsGeoJSON, geolibreProject, download,
} from './export.js';
import {
  ENGINE_VERSION, swathIntervals, meanAltitudeKm, satrecFrom,
} from './engine.js';
import {
  fetchAtmosphere, cloudAt, cloudRelevant, atmosphereAt, atmosphereKind, hourlyRows,
} from './weather.js';
import { s2TilesForRoi, s1RelativeOrbit, landsatPathRow } from './tiles.js';
import { searchIcesat2, icesat2Rgt } from './cmr.js';
import { searchAcquisitions, groupByPass } from './stac.js';
import { insarTracks } from './insar.js';
import { annotatePlans } from './plans.js';
import { renderCalendar } from './calendar.js';
import {
  renderDrawer, renderInsar, renderStac, printFieldSheet,
} from './panels.js';
import {
  openCard, renderFreshDetails, glossary, GLOSSARY_KEYS,
} from './cards.js';
import { spectralRuler } from './spectral.js';

const $ = (sel) => document.querySelector(sel);
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const store = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private browsing */ } };
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
  cloudSeries: null,
  cloudError: null,
  stac: { loading: false, groups: null, items: [], errors: {} },
  droneMinutes: 30,
  gustLimit: Number(stored('eopp-gust-limit')) || 36,
  pendingPass: null,
  drawerOpen: false,
  bands: null,
  manoeuvres: {},
  constellationTles: null,
  icesat2: { granules: [], error: null, loading: false },
  sweep: null,
  pastNote: '',
  theme: stored('eopp-theme') === 'dracula' ? 'dracula' : 'light',
  basemap: stored('eopp-basemap') || 'simple',
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

// ---------- theme ----------

const colourOf = (e) => entryStyle(e, state.theme).colour;

/** Category marker: colour plus shape (shapes back up colour, SPEC 8A.1). */
function makeDot(e) {
  const st = entryStyle(e, state.theme);
  const dot = document.createElement('span');
  dot.className = `dot shape-${st.shape}`;
  dot.style.background = st.colour;
  if (st.colour2) dot.style.setProperty('--stripe', st.colour2);
  dot.setAttribute('aria-hidden', 'true');
  return dot;
}
const colourMap = () => Object.fromEntries(state.catalogue.entries.map((e) => [e.id, colourOf(e)]));

function setTheme(theme) {
  state.theme = theme;
  store('eopp-theme', theme);
  document.documentElement.dataset.theme = theme;
  $('#theme').textContent = t(theme === 'dracula' ? 'theme_light' : 'theme_dark');
  $('#theme').setAttribute('aria-pressed', String(theme === 'dracula'));
  if (globe) {
    globe.setTheme(theme);
    globe.setColours(colourMap());
    lastTrackSim = NaN;
    lastDataUpdate = -Infinity;
    renderFootprints();
    renderInstruments();
    renderTable();
  }
}

// ---------- globe ----------

/** Label for a platform carrying several selected instruments ("ISS", "NISAR"). */
function platformLabel(e) {
  if (e.platform.length <= 6) return e.platform;
  return e.object_name.split(/[\s(]/)[0].slice(0, 6);
}

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

const FRAME_MS = 50; // markers at about 20 updates per second keep the main thread free
let lastFrame = 0;

function frame(ts = performance.now()) {
  if (ts - lastFrame < FRAME_MS) { requestAnimationFrame(frame); return; }
  lastFrame = ts;
  const now = simNow();
  // One marker per platform (several instruments can share a satellite, e.g. the ISS).
  const byNorad = new Map();
  for (const p of positions(trackers, now)) {
    const k = p.tr.entry.norad_id;
    const m = byNorad.get(k);
    if (!m) byNorad.set(k, { p, instruments: [p.tr.entry.instrument], labels: new Set([shortName(p.tr.entry)]), imaging: p.imaging });
    else { m.instruments.push(p.tr.entry.instrument); m.labels.add(shortName(p.tr.entry)); m.imaging ||= p.imaging; }
  }
  globe.setSatellites([...byNorad.values()].map(({ p, instruments, labels, imaging }) => ({
    id: String(p.tr.entry.norad_id),
    label: labels.size === 1 ? [...labels][0] : platformLabel(p.tr.entry),
    title: `${p.tr.entry.platform} (${instruments.join(', ')}), ${p.height.toFixed(0)} km`,
    lat: p.lat,
    lon: p.lon,
    colour: colourOf(p.tr.entry),
    shape: entryStyle(p.tr.entry, state.theme).shape,
    colour2: entryStyle(p.tr.entry, state.theme).colour2,
    imaging,
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
  const local = state.roi ? `, ${formatTimeSec(now, state.tz).slice(0, 5)} ${t('local_short')}` : '';
  $('#clock').textContent = `${utc} UTC${local}`;
  $('#clock').title = state.roi ? state.tz : '';
}

function renderPlay() {
  const b = $('#play');
  b.textContent = state.clock.playing ? t('time_pause') : t('time_play');
  b.setAttribute('aria-pressed', String(state.clock.playing));
}

// ---------- time zone (tz-lookup loaded on demand, ~74 KB) ----------

let tzlookup = null;
const tzReady = () => import('../vendor/tz-lookup.js').then((m) => { tzlookup = m.default; });

/** IANA zone of a point; 'UTC' until the lookup table has loaded (then views refresh). */
function zoneOf(lat, lon) {
  if (tzlookup) {
    try { return tzlookup(lat, lon); } catch { return 'UTC'; }
  }
  tzReady().then(() => {
    if (!state.roi) return;
    const a = roiAnchor(state.roi);
    state.tz = zoneOf(a.lat, a.lon);
    if (state.result) refreshViews();
  });
  return 'UTC';
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
  state.tz = zoneOf(a.lat, a.lon);
  state.result = null;
  state.selectedPass = null;
  state.drawerOpen = false;
  renderDrawerPanel();
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
  state.drawerOpen = false;
  renderDrawerPanel();
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

let workers = [];
let jobId = 0;

/** Estimated relative cost of an entry (wide swaths refine longer windows). */
function entryCost(e) {
  const s = e.swath;
  const w = s.width_km ?? (s.incidence_deg ? 400 : 100);
  return 1 + (s.model === 'field_of_regard' ? 2 : 0) + w / 500;
}

/** Split entries into k groups of similar total cost (greedy, largest first). */
function splitEntries(entries, k) {
  const groups = Array.from({ length: k }, () => ({ cost: 0, list: [] }));
  for (const e of [...entries].sort((a, b) => entryCost(b) - entryCost(a))) {
    const g = groups.reduce((a, b) => (b.cost < a.cost ? b : a));
    g.list.push(e);
    g.cost += entryCost(e);
  }
  return groups.map((g) => g.list).filter((l) => l.length);
}

/** Merge the results of several workers into one engine result. */
function mergeResults(parts) {
  const first = parts[0];
  return {
    ...first,
    passes: parts.flatMap((r) => r.passes).sort((a, b) => a.closest_utc - b.closest_utc),
    per_entry: Object.assign({}, ...parts.map((r) => r.per_entry)),
  };
}

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
  for (const w of workers) w.terminate();
  const id0 = jobId + 1;
  expandConstellations(entries).then(({ list, tles: extraTles }) => {
    if (jobId !== id0) return;
    startWorkers(id0, entries, list, extraTles, start, days, simp);
  });
  jobId = id0;
  $('#run').disabled = true;
  setAnswer(t('answer_computing'), '');
}

/** Replace constellation entries by one entry per current member (element sets loaded on demand). */
async function expandConstellations(entries) {
  const groups = entries.filter((e) => e.constellation);
  if (!groups.length) return { list: entries, tles: {} };
  if (!state.constellationTles) {
    try {
      const res = await fetch('data/tles_constellations.json', { cache: 'no-cache' });
      state.constellationTles = res.ok ? await res.json() : {};
    } catch { state.constellationTles = {}; }
  }
  const list = entries.filter((e) => !e.constellation);
  const tles = {};
  for (const g of groups) {
    for (const [norad, m] of Object.entries(state.constellationTles[g.id]?.members ?? {})) {
      list.push({ ...g, id: `${g.id}~${norad}`, group_id: g.id, norad_id: Number(norad), object_name: m.name, platform: m.name, constellation: undefined });
      tles[norad] = { name: m.name, omm: m.omm, epoch: m.epoch };
    }
  }
  return { list, tles };
}

/** Fold member results back into their constellation entry. */
function foldConstellations(result) {
  for (const p of result.passes) {
    const i = p.entry_id.indexOf('~');
    if (i < 0) continue;
    p.member = p.platform;
    p.entry_id = p.entry_id.slice(0, i);
    p.id = `${p.entry_id}_${p.norad_id}_${new Date(p.closest_utc).toISOString().slice(0, 16)}`;
  }
  const per = {};
  for (const [k, v] of Object.entries(result.per_entry)) {
    const i = k.indexOf('~');
    if (i < 0) { per[k] = v; continue; }
    const g = k.slice(0, i);
    const acc = per[g] ?? { status: 'ok', n_passes: 0, n_expected: 0, closest_km: Infinity, reach_km: 0, members: 0 };
    acc.n_passes += v.n_passes ?? 0;
    acc.n_expected += v.n_expected ?? 0;
    acc.members += 1;
    if ((v.closest_km ?? Infinity) < acc.closest_km) Object.assign(acc, { closest_km: v.closest_km, closest_utc: v.closest_utc, closest_side: v.closest_side });
    acc.reach_km = Math.max(acc.reach_km, v.reach_km ?? 0);
    per[g] = acc;
  }
  result.per_entry = per;
  return result;
}

function startWorkers(id, entries, list, extraTles, start, days, simp) {
  if (!list.length) { $('#run').disabled = false; $('#progress').textContent = ''; return; }
  // One worker per spare core (at most 4): entries are independent.
  const cores = navigator.hardwareConcurrency || 2;
  const groups = splitEntries(list, Math.max(1, Math.min(4, cores - 1, list.length)));
  workers = groups.map(() => new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' }));
  const t0 = performance.now();
  const done = new Array(groups.length).fill(0);
  const parts = new Array(groups.length).fill(null);
  workers.forEach((w, gi) => {
    w.onmessage = (ev) => {
      const m = ev.data;
      if (m.id !== id) return;
      if (m.type === 'progress') {
        done[gi] = m.done;
        $('#progress').textContent = t('progress', { done: done.reduce((a, b) => a + b, 0), total: list.length });
      }
      if (m.type === 'error') { $('#progress').textContent = m.message; $('#run').disabled = false; }
      if (m.type === 'result') {
        parts[gi] = m.result;
        w.terminate();
        if (parts.every(Boolean)) {
          $('#run').disabled = false;
          state.result = foldConstellations(mergeResults(parts));
          const nExp = state.result.passes.filter((p) => p.imaging_expected).length;
          $('#progress').textContent = t(nExp === 1 ? 'done_in_one' : 'done_in', { n: nExp, s: ((performance.now() - t0) / 1000).toFixed(1) });
          state.ranEntries = entries;
          state.days = days;
          onResult(true);
        }
      }
    };
  });
  pastElementSets(Date.parse(start), days).then((pastTles) => {
    if (id !== jobId) return;
    const tles = { ...(pastTles ?? state.tles), ...extraTles };
    workers.forEach((w, gi) => w.postMessage({ id, query: { entries: groups[gi], tles, roi: simp.geom, start, days } }));
  });
}

const HISTORY_SEARCH_DAYS = 7;

/** Decompress a gzip response body (DecompressionStream). */
async function gunzipJson(res) {
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

/**
 * For windows starting more than two days ago, use the archived element sets
 * (data/tle_history/) closest to the window centre, if one exists within 7
 * days; otherwise flag low confidence. Returns a tles map or null (current).
 */
async function pastElementSets(startMs, days) {
  state.pastNote = '';
  const now = Date.now();
  if (startMs > now - 2 * 86400000) return null;
  const centre = Math.min(startMs + (days * 86400000) / 2, now);
  const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
  for (let k = 0; k <= HISTORY_SEARCH_DAYS; k++) {
    for (const sign of k ? [-1, 1] : [1]) {
      const d = dayOf(centre + sign * k * 86400000);
      try {
        const res = await fetch(`data/tle_history/${d}.json.gz`);
        if (!res.ok) continue;
        const hist = await gunzipJson(res);
        const tles = { ...state.tles };
        for (const [norad, list] of Object.entries(hist)) {
          const best = list.reduce((a, r) => (Math.abs(Date.parse(r.epoch) - centre) < Math.abs(Date.parse(a.epoch) - centre) ? r : a));
          tles[norad] = { ...state.tles[norad], ...best };
        }
        state.pastNote = t('past_history', { date: d });
        return tles;
      } catch { /* try the next day */ }
    }
  }
  state.pastNote = t('past_low_confidence');
  return null;
}

function updateHash(startVal, days, entries) {
  const defaults = filterEntries(state.catalogue.entries, {}).filter(defaultSelected).map((e) => e.id);
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
  if (q.pass) state.pendingPass = q.pass;
  if (!q.roi) return false;
  setRoiGeom(q.roi, { fly: true });
  return true;
}

const byIdCache = new WeakMap();
function entriesById() {
  if (!byIdCache.has(state.catalogue)) byIdCache.set(state.catalogue, Object.fromEntries(state.catalogue.entries.map((e) => [e.id, e])));
  return byIdCache.get(state.catalogue);
}

function refreshViews() {
  const a = answerSentence({ ...state.result, passes: answerPasses() }, { tz: state.tz, days: state.days, isPoint: state.roi.type === 'Point', entriesById: entriesById() });
  const cloudNote = (state.cloudError ? ` ${t('cloud_error')}` : '') + (state.pastNote ? ` ${state.pastNote}` : '');
  setAnswer(a.main, a.sub + cloudNote, a.lines);
  renderTableCategories();
  renderTable();
  renderCalendarTab();
  renderAbsences();
  renderGeo();
  renderInsarTab();
  renderStacTab();
  renderSpectralTab();
  renderDrawerPanel();
  const any = state.result.passes.some((p) => p.imaging_expected);
  for (const id of ['#export-csv', '#export-ics', '#export-geojson', '#export-geolibre', '#print-sheet-btn']) $(id).disabled = !any;
  $('#copy-link').disabled = false;
  return a;
}

function onResult(fresh = false) {
  const a = refreshViews();
  if (fresh) {
    const pending = state.pendingPass && state.result.passes.find((p) => p.id === state.pendingPass);
    state.pendingPass = null;
    setupScrubber();
    if (pending) selectPass(pending.id, { fly: true, open: true });
    else if (a.best && !reducedMotion) startSweep(a.best.id);
    else if (a.best) selectPass(a.best.id, { fly: true });
    else renderFootprints();
    enrich();
  } else {
    renderFootprints();
  }
}

/** Plans, tiles, cloud and STAC: added after the geometric result, each re-rendering the views. */
async function enrich() {
  const res = state.result;
  const anchor = roiAnchor(state.roi);
  const byId = entriesById();
  // S2 tiles (same for every S2 pass over this ROI).
  const tiles = s2TilesForRoi(state.roi);
  for (const p of res.passes) if (/^Sentinel-2/.test(p.platform)) p.tiles = tiles;
  // Probable manoeuvres between the element-set epoch and the pass.
  for (const p of res.passes) {
    const ev = (state.manoeuvres[String(p.norad_id)] ?? []).find((m) => {
      const t = Date.parse(m.after);
      const e = Date.parse(p.tle_epoch);
      return t > Math.min(e, p.closest_utc) && t <= Math.max(e, p.closest_utc);
    });
    if (ev) p.manoeuvre = ev;
  }
  // ICESat-2: reference ground tracks and past tracks from NASA CMR.
  if (res.passes.some((p) => /ATLAS/.test(p.instrument))) {
    state.icesat2 = { granules: [], error: null, loading: true };
    searchIcesat2(state.roi, Date.now() - 400 * 86400000, Date.now()).then((g) => {
      if (state.result !== res) return;
      state.icesat2 = { ...g, loading: false };
      for (const p of res.passes) if (/ATLAS/.test(p.instrument)) p.rgt = icesat2Rgt(p, g.granules);
      refreshViews();
    });
  } else {
    state.icesat2 = { granules: [], error: null, loading: false };
  }
  // ESA acquisition plans.
  annotatePlans(res.passes, byId, anchor).then(() => { if (state.result === res) refreshViews(); });
  // Cloud cover at the anchor.
  state.cloudSeries = null;
  state.cloudError = null;
  fetchAtmosphere(anchor, res.window.start_utc - 3 * 3600000, res.window.end_utc + 3 * 3600000)
    .then((series) => {
      if (state.result !== res) return;
      state.cloudSeries = series;
      for (const p of res.passes) {
        if (cloudRelevant(byId[p.entry_id])) p.cloud = cloudAt(series, p.closest_utc);
        p.atm = atmosphereAt(series, p.closest_utc);
      }
      refreshViews();
    })
    .catch(() => { if (state.result === res) { state.cloudError = true; refreshViews(); } });
  // Real acquisitions (STAC): the past part of the window, and at least the last 36 days
  // (three Sentinel-1 cycles) to infer relative orbits.
  const now = Date.now();
  const to = Math.min(res.window.end_utc, now);
  const from = Math.min(res.window.start_utc, now - 36 * 86400000);
  state.stac = { loading: true, groups: null, items: [], errors: {}, from, to };
  renderStacTab();
  const r = await searchAcquisitions(state.roi, from, to);
  if (state.result !== res) return;
  state.stac = { loading: false, items: r.items, groups: groupByPass(r.items), errors: r.errors, from, to };
  for (const p of res.passes) {
    if (/^Sentinel-1/.test(p.platform)) p.rel_orbit = s1RelativeOrbit(p, r.items.filter((x) => x.collection === 'sentinel-1-grd'));
    if (/^Landsat/.test(p.platform)) p.path_row = landsatPathRow(p, r.items);
  }
  refreshViews();
}

/** Expected passes after the opportunity and cloud filters (used by the answer). */
function answerPasses() {
  const opp = $('#table-opp').checked;
  const dir = $('#table-dir').value;
  const maxCloud = $('#max-cloud').value === '' ? null : Number($('#max-cloud').value);
  return (state.result?.passes ?? []).filter((p) => p.imaging_expected
    && (opp || !p.opportunity)
    && (maxCloud == null || !p.cloud || p.cloud.total <= maxCloud)
    && aodOk(p)
    && (!dir || p.direction === dir));
}

/** Max-AOD filter: applies to optical passes with an aerosol value. */
function aodOk(p) {
  const max = $('#max-aod').value === '' ? null : Number($('#max-aod').value);
  if (max == null || p.atm?.aod == null) return true;
  return atmosphereKind(entriesById()[p.entry_id]) !== 'optical' || p.atm.aod <= max;
}

function selectPass(id, { fly = false, open = true } = {}) {
  state.selectedPass = id;
  const p = state.result?.passes.find((x) => x.id === id);
  renderFootprints();
  for (const tr of document.querySelectorAll('#passes tbody tr')) tr.classList.toggle('is-selected', tr.dataset.id === id);
  for (const c of document.querySelectorAll('.cal-cell[data-id]')) c.classList.toggle('is-selected', c.dataset.id === id);
  markAnswerLine();
  if (open) state.drawerOpen = true;
  renderDrawerPanel();
  if (!$('#panel-spectral').hidden) renderSpectralTab();
  if (!p) return;
  // Show the pass: start 90 s before closest approach at 10x (directly at closest approach with reduced motion).
  setClock(reducedMotion
    ? { baseSim: p.closest_utc, playing: false }
    : { baseSim: p.closest_utc - 90000, playing: true, speed: 10 });
  if (fly) { const a = roiAnchor(state.roi); globe.flyTo(a.lat, a.lon, state.roi.type === 'Point' ? 3.2 : Math.max(3.2, globe.map.getZoom())); }
}

function renderFootprints() {
  const until = state.sweep ? state.sweep.t : Infinity;
  const feats = (state.result?.passes ?? []).filter((p) => p.imaging_expected && p.closest_utc <= until).map((p) => ({
    type: 'Feature',
    properties: { id: p.entry_id, selected: p.id === state.selectedPass || Boolean(state.sweep && state.sweep.t - p.closest_utc < state.sweep.glow) },
    geometry: { type: 'MultiPolygon', coordinates: p.footprints },
  }));
  globe.setFootprints({ type: 'FeatureCollection', features: feats });
}

// ---------- rendering ----------

function setAnswer(main, sub, lines = []) {
  $('#answer-main').textContent = main;
  $('#answer-sub').textContent = sub;
  const ul = $('#answer-lines');
  ul.replaceChildren();
  for (const l of lines) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = l.pass.id;
    const entry = state.catalogue.entries.find((e) => e.id === l.pass.entry_id);
    // SAR geometry depends on the orbit direction: state it in the line.
    const dir = entry?.categories[0] === 'sar' ? `, ${t(`dir_${l.pass.direction}`)}` : '';
    b.append(makeDot(entry), document.createTextNode(`${l.text}${dir} (${relTime(l.pass.closest_utc)})`));
    b.addEventListener('click', () => selectPass(l.pass.id, { fly: true }));
    li.append(b);
    ul.append(li);
  }
  markAnswerLine();
}

/** "daqui a 2 d 4 h" / "in 2 d 4 h". */
function relTime(ms) {
  const d = ms - Date.now();
  return t(d >= 0 ? 'countdown_in' : 'countdown_ago', { v: formatDuration(Math.abs(d)) });
}

// ---------- sweep animation and scrubber ----------

const SWEEP_MS = 3000;

/** Reveal the footprints in chronological order over ~3 s, then select the best pass. */
function startSweep(bestId) {
  const res = state.result;
  const t0 = performance.now();
  const span = res.window.end_utc - res.window.start_utc;
  state.sweep = { t: res.window.start_utc, glow: span / 40 };
  $('#replay').hidden = false;
  const step = () => {
    if (state.result !== res || !state.sweep) return;
    const f = Math.min(1, (performance.now() - t0) / SWEEP_MS);
    state.sweep.t = res.window.start_utc + f * span;
    $('#scrub').value = String(Math.round(f * 1000));
    setClock({ baseSim: state.sweep.t, playing: false });
    renderFootprints();
    if (f < 1) requestAnimationFrame(step);
    else { state.sweep = null; selectPass(bestId, { fly: true }); }
  };
  const a = roiAnchor(state.roi);
  globe.flyTo(a.lat, a.lon, state.roi.type === 'Point' ? 3.2 : Math.max(3.2, globe.map.getZoom()));
  requestAnimationFrame(step);
}

function setupScrubber() {
  $('#scrub-wrap').hidden = !state.result;
  $('#replay').hidden = !state.result || reducedMotion;
}

function onScrub() {
  if (!state.result) return;
  state.sweep = null;
  const { start_utc: a, end_utc: b } = state.result.window;
  setClock({ baseSim: a + (Number($('#scrub').value) / 1000) * (b - a), playing: false });
  renderFootprints();
}

// ---------- spectral ruler ----------

async function renderSpectralTab() {
  const root = $('#spectral');
  if (!state.bands) {
    try {
      const res = await fetch('data/bands.json', { cache: 'no-cache' });
      state.bands = res.ok ? await res.json() : { groups: [] };
    } catch { state.bands = { groups: [] }; }
  }
  const entries = state.catalogue.entries.filter((e) => state.selected.has(e.id) && e.status !== 'inactive');
  const sel = state.result?.passes.find((p) => p.id === state.selectedPass);
  const svg = spectralRuler(state.bands, entries, { colourOf, highlightId: sel?.entry_id, t });
  root.replaceChildren();
  if (!svg) { root.textContent = t('spectral_empty'); return; }
  root.insertAdjacentHTML('beforeend', svg);
  const det = document.createElement('details');
  const sum = document.createElement('summary');
  sum.textContent = t('spectral_sources');
  const ul = document.createElement('ul');
  const urls = new Set();
  for (const g of state.bands.groups ?? []) if (entries.some((e) => g.ids.includes(e.id))) for (const u of g.sources ?? []) urls.add(u);
  for (const f of state.bands.absorption_features ?? []) if (f.source) urls.add(f.source);
  for (const u of urls) {
    const li = document.createElement('li');
    const a = Object.assign(document.createElement('a'), { href: u, target: '_blank', rel: 'noopener', textContent: u });
    li.append(a);
    ul.append(li);
  }
  det.append(sum, ul);
  root.append(det);
  if ((state.bands.groups ?? []).some((g) => g.unverified && entries.some((e) => g.ids.includes(e.id)))) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = `* ${t('spectral_unverified')}`;
    root.append(p);
  }
}

function markAnswerLine() {
  for (const b of document.querySelectorAll('#answer-lines button')) b.setAttribute('aria-current', String(b.dataset.id === state.selectedPass));
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
  { key: 'tle_age_days', label: 'col_tle', cell: (p) => `${p.tle_age_days.toFixed(1)}${p.manoeuvre ? ' ⚠' : ''}`, num: true, warn: (p) => p.tle_age_days > 7 || Boolean(p.manoeuvre) },
  { key: 'cloud', label: 'col_cloud', cell: (p) => cloudCell(p), num: true, sortVal: (p) => p.cloud?.total ?? 999 },
  { key: 'aod', label: 'col_aod', cell: (p) => (atmosphereKind(entriesById()[p.entry_id]) === 'optical' && p.atm?.aod != null ? p.atm.aod.toFixed(2) : ''), num: true, sortVal: (p) => p.atm?.aod ?? 9, warn: (p) => (p.atm?.aod ?? 0) > 0.4 && atmosphereKind(entriesById()[p.entry_id]) === 'optical' },
  { key: 'plan', label: 'col_plan', cell: (p) => (p.plan ? t(`plan_${p.plan.status}`) : ''), warn: (p) => p.plan?.status === 'not_planned' },
  { key: 'tiles', label: 'col_tile_orbit', cell: (p) => p.tiles?.join(' ') ?? (p.rel_orbit ? `${t('orbit_abbr')} ${p.rel_orbit}` : p.path_row ? `WRS ${p.path_row}` : p.rgt ? `RGT ${p.rgt}` : '') },
  { key: 'acquisition', label: 'col_acq', cell: (p) => t(`acq_${p.acquisition}`) },
];

function cloudCell(p) {
  const e = entriesById()[p.entry_id];
  if (!cloudRelevant(e)) return t('cloud_na_short');
  return p.cloud ? `${Math.round(p.cloud.total)}${p.cloud.kind === 'forecast' ? '' : '*'}` : '–';
}

/** Expected-imaging passes after the table filters (category, opportunities). */
function visiblePasses() {
  const cat = $('#table-cat').value;
  const opp = $('#table-opp').checked;
  const dir = $('#table-dir').value;
  const byId = Object.fromEntries(state.catalogue.entries.map((e) => [e.id, e]));
  const maxCloud = $('#max-cloud').value === '' ? null : Number($('#max-cloud').value);
  return (state.result?.passes ?? []).filter((p) => p.imaging_expected
    && (opp || !p.opportunity)
    && (maxCloud == null || !p.cloud || p.cloud.total <= maxCloud)
    && aodOk(p)
    && (!dir || p.direction === dir)
    && (!cat || byId[p.entry_id]?.categories[0] === cat));
}

// ---------- calendar, drawer, InSAR, STAC ----------

const DAY_FMT = new Map();
/** Calendar column label: {day, month, weekend, full} in the ROI time zone. */
function dayLabel(ms) {
  const k = `${getLang()}|${state.tz}`;
  if (!DAY_FMT.has(k)) {
    const loc = getLang() === 'pt' ? 'pt-PT' : 'en-GB';
    DAY_FMT.set(k, {
      parts: new Intl.DateTimeFormat('en-GB', { timeZone: state.tz, day: 'numeric', month: 'numeric', weekday: 'short' }),
      month: new Intl.DateTimeFormat(loc, { timeZone: state.tz, month: 'short' }),
      full: new Intl.DateTimeFormat(loc, { timeZone: state.tz, weekday: 'long', day: 'numeric', month: 'long' }),
    });
  }
  const f = DAY_FMT.get(k);
  const p = Object.fromEntries(f.parts.formatToParts(ms).map((x) => [x.type, x.value]));
  return { day: String(Number(p.day)), month: f.month.format(ms).replace('.', ''), weekend: p.weekday === 'Sat' || p.weekday === 'Sun', full: f.full.format(ms) };
}
const fmtDate = (ms, tz) => new Intl.DateTimeFormat(getLang() === 'pt' ? 'pt-PT' : 'en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(ms);

function renderCalendarTab() {
  const root = $('#calendar');
  if (!state.result) { root.replaceChildren(); $('#calendar-empty').hidden = false; return; }
  const ok = renderCalendar(root, {
    passes: visiblePasses(),
    entries: state.ranEntries,
    categories: CATEGORIES,
    tz: state.tz,
    startMs: state.result.window.start_utc,
    endMs: state.result.window.end_utc,
    colourOf,
    cloudOf: (p) => (p.cloud ? p.cloud.total : null),
    onSelect: (id) => selectPass(id, { fly: true }),
    selectedId: state.selectedPass,
    t,
    formatTime: (ms, tz) => formatTimeSec(ms, tz).slice(0, 5),
    dayLabel,
    nameOf: (e) => `${e.platform} ${e.instrument}`,
  });
  $('#calendar-empty').hidden = ok;
}

function renderDrawerPanel() {
  const root = $('#drawer');
  const p = state.drawerOpen ? state.result?.passes.find((x) => x.id === state.selectedPass) : null;
  if (!p) { renderDrawer(root, { pass: null }); return; }
  const e = entriesById()[p.entry_id];
  const tle = state.tles[String(p.norad_id)] ?? { omm: state.constellationTles?.[e.id]?.members?.[String(p.norad_id)]?.omm };
  const intervals = swathIntervals(e, meanAltitudeKm(satrecFrom(tle))) ?? [[0, 0]];
  const css = getComputedStyle(document.documentElement);
  renderDrawer(root, {
    pass: p, entry: e, intervals, tz: state.tz, t,
    fmt: { dateTime: formatDateTime, time: (ms, tz) => formatTimeSec(ms, tz).slice(0, 5) },
    colour: colourOf(e), ink: css.getPropertyValue('--ink').trim(), soft: css.getPropertyValue('--ink-soft').trim(),
    cloudSeries: state.cloudSeries, cloudRelevant: cloudRelevant(e),
    atmKind: atmosphereKind(e),
    droneRows: hourlyRows(state.cloudSeries, p.closest_utc - state.droneMinutes * 60000, p.closest_utc + state.droneMinutes * 60000),
    gustLimit: state.gustLimit,
    onGustLimit: (v) => { state.gustLimit = v; store('eopp-gust-limit', String(v)); renderDrawerPanel(); },
    anchorLon: roiAnchor(state.roi).lon,
    droneMinutes: state.droneMinutes,
    onDroneMinutes: (n) => { state.droneMinutes = n; renderDrawerPanel(); },
    onClose: () => { state.drawerOpen = false; renderDrawerPanel(); },
    onIcs: () => download(`passagem_${p.id}.ics`, icsFor([p]), 'text/calendar;charset=utf-8'),
    onCopyLink: () => copyLink(p.id),
    onCard: () => showCard(e),
  });
}

function icsFor(passes) {
  const anchor = roiAnchor(state.roi);
  return passesToIcs(passes, {
    anchor,
    describe: (p) => ({
      summary: t('ics_summary', { sat: `${p.platform} ${p.instrument}`, cov: Math.round(p.coverage_pct) }),
      description: [
        `${t('col_local')}: ${formatDateTime(p.closest_utc, state.tz)} (${state.tz})`,
        `${t('col_dir')}: ${t(`dir_${p.direction}`)}`,
        `${t('col_cov')}: ${p.coverage_pct.toFixed(1)} %`,
        `${t('col_edge')}: ${p.edge_margin_km.toFixed(1)} km`,
        `${t('col_view')}: ${p.view_angle_deg.toFixed(1)}`,
        p.cloud ? `${t('col_cloud')}: ${Math.round(p.cloud.total)} % (${t(`cloud_${p.cloud.kind}`)})` : '',
        p.plan ? `${t('col_plan')}: ${t(`plan_${p.plan.status}`)}` : '',
        `${t('col_acq')}: ${t(`acq_${p.acquisition}`)}`,
        t('ics_note'),
      ].filter(Boolean).join('\n'),
    }),
  });
}

async function copyLink(passId = null) {
  const url = new URL(location.href);
  const q = new URLSearchParams(url.hash.slice(1));
  if (passId) q.set('p', passId); else q.delete('p');
  url.hash = q.toString();
  try {
    await navigator.clipboard.writeText(url.href);
    $('#link-status').textContent = t('link_copied');
  } catch {
    $('#link-status').textContent = url.href;
  }
  setTimeout(() => { $('#link-status').textContent = ''; }, 4000);
}

function renderInsarTab() {
  const sar = visiblePasses().filter((p) => entriesById()[p.entry_id]?.categories[0] === 'sar' && !p.opportunity);
  renderInsar($('#insar'), insarTracks(sar), {
    t, tz: state.tz, fmt: { date: fmtDate }, onSelect: (id) => selectPass(id, { fly: true }),
  });
}

function renderStacTab() {
  renderStac($('#stac'), state.stac, { t, tz: state.tz, fmt: { date: fmtDate, dateTime: formatDateTime }, icesat2: state.icesat2 });
}

function exportAll(kind) {
  const passes = visiblePasses();
  const stamp = new Date().toISOString().slice(0, 10);
  if (kind === 'ics') download(`passagens_${stamp}.ics`, icsFor(passes), 'text/calendar;charset=utf-8');
  if (kind === 'geojson') download(`passagens_${stamp}.geojson`, JSON.stringify(footprintsGeoJSON(passes, { roi: state.roi, tz: state.tz })), 'application/geo+json');
  if (kind === 'geolibre') {
    const catOf = (p) => entriesById()[p.entry_id]?.categories[0] ?? 'other';
    const project = geolibreProject(passes, {
      roi: state.roi, anchor: roiAnchor(state.roi), tz: state.tz,
      name: `EO Pass Planner ${stamp}`,
      categoryOf: catOf,
      colourOf: (c) => entryStyle({ categories: [c] }, 'light').colour,
      labelOf: (c) => t(`cat_${c}`),
    });
    download(`eo-pass-planner_${stamp}.geolibre`, JSON.stringify(project), 'application/json');
    // GeoLibre opens projects by URL only from public addresses; the results
    // never leave the browser, so the file is loaded there with Open From → File.
    window.open('https://web.geolibre.app/', '_blank', 'noopener');
  }
}

function printSheet() {
  let mapImage = null;
  try { mapImage = globe.map.getCanvas().toDataURL('image/png'); } catch { /* tainted or unavailable */ }
  const table = $('#passes').cloneNode(true);
  table.querySelectorAll('button').forEach((b) => b.replaceWith(document.createTextNode(b.textContent)));
  const provenance = t('print_prov', {
    when: formatDateTime(Date.now(), state.tz), tz: state.tz, cat: state.catalogue.version,
    data: state.meta?.updated_utc ?? '?', engine: ENGINE_VERSION, url: location.href,
  });
  printFieldSheet($('#print-sheet'), {
    t, answer: `${$('#answer-main').textContent} ${$('#answer-sub').textContent}`,
    roiSummary: $('#roi-summary').textContent, mapImage, table, provenance,
    limitations: (t('about_html').match(/<ul>[\s\S]*?<\/ul>/) ?? [''])[0],
  });
}

function renderTableCategories() {
  const sel = $('#table-cat');
  const keep = sel.value;
  sel.replaceChildren(new Option(t('table_all'), ''));
  const present = new Set((state.result?.passes ?? []).filter((p) => p.imaging_expected)
    .map((p) => state.catalogue.entries.find((e) => e.id === p.entry_id)?.categories[0]));
  for (const c of CATEGORIES) if (present.has(c)) sel.add(new Option(t(`cat_${c}`), c));
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : '';
}

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
  const rows = visiblePasses();
  const { key, dir } = state.sort;
  const col = COLS[state.sort.col];
  const val = col?.sortVal ?? ((p) => p[key] ?? '');
  rows.sort((a, b) => (val(a) < val(b) ? -dir : val(a) > val(b) ? dir : a.closest_utc - b.closest_utc));
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
        const dot = makeDot(state.catalogue.entries.find((e) => e.id === p.entry_id));
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

function renderGeo() {
  const ul = $('#geo-list');
  ul.replaceChildren();
  const rows = state.result ? state.ranEntries.filter((e) => state.result.per_entry[e.id]?.status === 'geo') : [];
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = t('geo_empty');
    ul.append(li);
    return;
  }
  for (const e of rows) {
    const r = state.result.per_entry[e.id];
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = `${e.platform} ${e.instrument}`;
    const lon = `${Math.abs(r.sub_lon).toFixed(1)}° ${r.sub_lon >= 0 ? 'E' : 'W'}`;
    li.append(name, document.createTextNode(` ${t('geo_row', {
      vza: r.view_zenith_deg.toFixed(1), max: r.max_view_zenith_deg, usable: t(r.usable ? 'geo_usable' : 'geo_not_usable'), repeat: r.repeat_min, lon,
    })}`));
    if (!r.usable) li.classList.add('is-warn');
    ul.append(li);
  }
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

function swathSummary(e) {
  const s = e.swath;
  if (s.model === 'continuous_geo') return t('swath_geo');
  if (s.model === 'profile') return t('swath_profile');
  if (s.model === 'track_only') return t('swath_track');
  if (s.model === 'side_looking') return t('swath_sar', { inc: `${s.incidence_deg[0]}–${s.incidence_deg[1]}`, side: t(`look_${s.look_side}`) });
  return s.width_km ? `${s.width_km} km` : '';
}

const openGroups = new Set();

function renderInstruments() {
  const ul = $('#instruments');
  ul.replaceChildren();
  const entries = filterEntries(state.catalogue.entries, { includeTransitional: $('#transitional').checked });
  for (const cat of CATEGORIES) {
    const members = entries.filter((e) => e.categories[0] === cat);
    if (!members.length) continue;
    const li = document.createElement('li');
    li.className = 'group';
    const det = document.createElement('details');
    const nSel = members.filter((e) => state.selected.has(e.id)).length;
    det.open = openGroups.has(cat);
    det.addEventListener('toggle', () => { if (det.open) openGroups.add(cat); else openGroups.delete(cat); });
    const sum = document.createElement('summary');
    const gcb = document.createElement('input');
    gcb.type = 'checkbox';
    gcb.checked = nSel === members.length;
    gcb.indeterminate = nSel > 0 && nSel < members.length;
    gcb.setAttribute('aria-label', t(`cat_${cat}`));
    gcb.addEventListener('click', (ev) => ev.stopPropagation());
    gcb.addEventListener('change', () => {
      for (const e of members) { if (gcb.checked) state.selected.add(e.id); else state.selected.delete(e.id); }
      renderInstruments();
      rebuildTrackers();
    });
    const gdot = makeDot(members[0]);
    const gname = document.createElement('span');
    gname.textContent = `${t(`cat_${cat}`)} (${nSel}/${members.length})`;
    sum.append(gcb, gdot, gname);
    det.append(sum);
    const inner = document.createElement('ul');
    inner.className = 'instruments';
    for (const e of members) inner.append(instrumentItem(e));
    det.append(inner);
    li.append(det);
    ul.append(li);
  }
}

function instrumentItem(e) {
  {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.selected.has(e.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(e.id); else state.selected.delete(e.id);
      renderInstruments();
      rebuildTrackers();
    });
    const dot = makeDot(e);
    const text = document.createElement('span');
    text.className = 'inst-text';
    const name = document.createElement('span');
    name.textContent = `${e.platform} ${e.instrument}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = [swathSummary(e), t(`acq_${e.acquisition}`), e.status !== 'active' ? t(`status_${e.status}`) : ''].filter(Boolean).join(', ');
    text.append(name, meta);
    label.append(cb, dot, text);
    const info = document.createElement('button');
    info.type = 'button';
    info.className = 'info quiet';
    info.textContent = 'i';
    info.title = t('card_open');
    info.setAttribute('aria-label', `${t('card_open')}: ${e.platform} ${e.instrument}`);
    info.addEventListener('click', (ev) => { ev.preventDefault(); showCard(e); });
    label.append(info);
    if (e.status_note) label.title = e.status_note;
    li.append(label);
    return li;
  }
}

function showCard(e) {
  openCard($('#card'), e, { t, lang: getLang(), swathSummary });
}

function renderFreshness() {
  renderFreshDetails($('#fresh-details'), state.meta, { t, formatDateTime });
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
  $('#theme').textContent = t(state.theme === 'dracula' ? 'theme_light' : 'theme_dark');
  for (const o of $('#basemap').options) o.textContent = t(`bm_${o.value}`);
  $('#basemap').title = t('basemap_label');
  $('#replay').title = t('replay');
  $('#replay').setAttribute('aria-label', t('replay'));
  $('#panel-about').innerHTML = t('about_html');
  $('#panel-about').append(glossary(t, GLOSSARY_KEYS));
  for (const el of document.querySelectorAll('.segmented')) el.setAttribute('aria-label', t('mode_label'));
  for (const [sel, key] of [['.query', 'aria_query'], ['#globe', 'aria_globe'], ['#results', 'aria_results'], ['#splitter', 'aria_splitter']]) $(sel)?.setAttribute('aria-label', t(key));
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

// ---------- results splitter ----------

const wideQuery = window.matchMedia('(min-width: 1800px)');

/** Drag (or arrow keys) resizes the results panel; double-click toggles a large panel. */
function initSplitter() {
  const center = $('#center');
  const sp = $('#splitter');
  const varName = () => (wideQuery.matches ? '--results-w' : '--results-h');
  const key = () => (wideQuery.matches ? 'eopp-results-w' : 'eopp-results-h');
  const apply = (frac) => {
    const f = Math.min(0.85, Math.max(0.15, frac));
    center.style.setProperty(varName(), `${(f * 100).toFixed(1)}%`);
    sp.setAttribute('aria-valuenow', String(Math.round(f * 100)));
    sp.setAttribute('aria-orientation', wideQuery.matches ? 'vertical' : 'horizontal');
    store(key(), String(f));
    return f;
  };
  const restore = () => {
    center.style.removeProperty('--results-h');
    center.style.removeProperty('--results-w');
    const v = Number(stored(key()));
    if (v) apply(v);
  };
  restore();
  wideQuery.addEventListener('change', restore);
  let dragging = false;
  sp.addEventListener('pointerdown', (ev) => { dragging = true; sp.setPointerCapture(ev.pointerId); sp.classList.add('is-dragging'); });
  sp.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = center.getBoundingClientRect();
    apply(wideQuery.matches ? (r.right - ev.clientX) / r.width : (r.bottom - ev.clientY) / r.height);
  });
  const end = () => { dragging = false; sp.classList.remove('is-dragging'); };
  sp.addEventListener('pointerup', end);
  sp.addEventListener('pointercancel', end);
  sp.addEventListener('dblclick', () => apply(Number(stored(key()) || 0.42) > 0.6 ? 0.42 : 0.75));
  sp.addEventListener('keydown', (ev) => {
    const cur = Number(stored(key()) || 0.42);
    const grow = wideQuery.matches ? ['ArrowLeft'] : ['ArrowUp'];
    const shrink = wideQuery.matches ? ['ArrowRight'] : ['ArrowDown'];
    if (grow.includes(ev.key)) { ev.preventDefault(); apply(cur + 0.05); }
    if (shrink.includes(ev.key)) { ev.preventDefault(); apply(cur - 0.05); }
  });
  // Keep the map canvas and the sticky tab bar in step with the panel size.
  new ResizeObserver(() => globe?.map.resize()).observe($('#globe'));
  const tools = document.querySelector('.results .panel-tools');
  new ResizeObserver(() => center.style.setProperty('--tools-h', `${tools.offsetHeight}px`)).observe(tools);
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
  document.documentElement.dataset.theme = state.theme;
  try {
    [state.catalogue, state.tles, state.meta, state.manoeuvres] = await Promise.all([
      loadCatalogue(), loadTles(), loadMeta().catch(() => null),
      fetch('data/manoeuvres.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
  } catch (err) {
    setAnswer(t('load_error', { what: err.message }), '');
    return;
  }
  for (const e of filterEntries(state.catalogue.entries, {})) if (defaultSelected(e)) state.selected.add(e.id);
  for (const e of state.catalogue.entries) if (state.selected.has(e.id)) openGroups.add(e.categories[0]);

  globe = createGlobe($('#globe'), {
    theme: state.theme,
    basemap: state.basemap,
    onBasemapError: (id) => {
      $('#basemap').value = 'simple';
      $('#progress').textContent = t('basemap_error', { name: t(`bm_${id}`) });
    },
    onClick: ({ lat, lon }) => {
      if (drawer.active || state.mode !== 'point') return;
      setRoiGeom({ type: 'Point', coordinates: [lon, lat] });
    },
  });
  globe.setColours(colourMap());
  $('#basemap').replaceChildren(...Object.keys(BASEMAPS).map((id) => new Option(t(`bm_${id}`), id)));
  $('#basemap').value = state.basemap;
  $('#basemap').addEventListener('change', () => {
    state.basemap = $('#basemap').value;
    store('eopp-basemap', state.basemap);
    globe.setBasemap(state.basemap);
  });
  $('#theme').addEventListener('click', () => setTheme(state.theme === 'dracula' ? 'light' : 'dracula'));
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
  $('#copy-link').addEventListener('click', () => copyLink(null));
  $('#days').addEventListener('input', () => { $('#days-warn').hidden = !(Number($('#days').value) > 16); });
  $('#transitional').addEventListener('change', () => {
    for (const e of state.catalogue.entries) if (e.status !== 'active') state.selected.add(e.id);
    renderInstruments();
    rebuildTrackers();
  });
  $('#run').addEventListener('click', runPasses);
  $('#table-cat').addEventListener('change', () => { renderTable(); renderCalendarTab(); renderInsarTab(); });
  $('#table-opp').addEventListener('change', () => { if (state.result) refreshViews(); });
  $('#max-cloud').addEventListener('change', () => { if (state.result) refreshViews(); });
  $('#table-dir').addEventListener('change', () => { if (state.result) refreshViews(); });
  $('#max-aod').addEventListener('change', () => { if (state.result) refreshViews(); });
  // Open the export menu towards the side with room (it must not slide under the query panel).
  $('.exports').addEventListener('toggle', (ev) => {
    const det = ev.currentTarget;
    if (!det.open) return;
    const menu = det.querySelector('.exports-menu');
    const sum = det.querySelector('summary').getBoundingClientRect();
    const panel = $('#results').getBoundingClientRect();
    const toLeft = sum.right - menu.offsetWidth >= panel.left;
    menu.style.left = toLeft ? 'auto' : '0';
    menu.style.right = toLeft ? '0' : 'auto';
  });
  $('#export-ics').addEventListener('click', () => exportAll('ics'));
  $('#export-geojson').addEventListener('click', () => exportAll('geojson'));
  $('#export-geolibre').addEventListener('click', () => exportAll('geolibre'));
  $('#print-sheet-btn').addEventListener('click', printSheet);
  $('#scrub').addEventListener('input', onScrub);
  $('#replay').addEventListener('click', () => { const a = answerSentence({ ...state.result, passes: answerPasses() }, { tz: state.tz, days: state.days, isPoint: state.roi.type === 'Point', entriesById: entriesById() }); if (a.best) startSweep(a.best.id); });
  $('#freshness').addEventListener('click', () => {
    const d = $('#fresh-details');
    d.hidden = !d.hidden;
    $('#freshness').setAttribute('aria-expanded', String(!d.hidden));
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.fresh-wrap')) { $('#fresh-details').hidden = true; $('#freshness').setAttribute('aria-expanded', 'false'); }
  });
  $('#tab-spectral').addEventListener('click', renderSpectralTab);
  $('#play').addEventListener('click', () => setClock({ playing: !state.clock.playing }));
  $('#speed').addEventListener('change', () => setClock({ speed: Number($('#speed').value) }));
  $('#now').addEventListener('click', () => setClock({ baseSim: Date.now(), speed: 1, playing: true }));
  $('#export-csv').addEventListener('click', () => {
    const csv = passesToCsv(visiblePasses(), {
      tz: state.tz, catalogueVersion: state.catalogue.version, dataUpdated: state.meta?.updated_utc ?? '', engineVersion: ENGINE_VERSION,
    });
    download(`passagens_${new Date().toISOString().slice(0, 10)}.csv`, csv);
  });
  initTabs();
  initSplitter();
  renderStatic();

  rebuildTrackers();
  await globe.ready;
  // Start the live layer once the page is idle, so it does not compete with the first render.
  (window.requestIdleCallback ?? setTimeout)(() => requestAnimationFrame(frame), { timeout: 1500 });
  (window.requestIdleCallback ?? setTimeout)(() => tzReady());
  if (applyHash()) {
    renderStatic();
    rebuildTrackers();
    runPasses();
  }
}

init();
