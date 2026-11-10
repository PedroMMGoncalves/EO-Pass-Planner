/**
 * panels.js: DOM rendering of the pass drawer, the InSAR pairs tab, the real
 * acquisitions (STAC) tab and the printable field sheet.
 *
 * Inputs:  passes and results prepared by main.js, translation function `t`,
 *          formatting helpers and callbacks.
 * Outputs: DOM content in the given containers.
 *
 * Limitations: presentation only; the numbers come from engine.js, weather.js,
 * plans.js, tiles.js, stac.js and insar.js, whose limitations apply.
 */

import { geometryDiagram } from './geometry_diagram.js';
import { solarElevation } from './sun.js';
import { window as cloudWindow } from './weather.js';

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};

function sparkline(points, colour) {
  const vals = points.filter((p) => p.v != null);
  if (vals.length < 2) return null;
  const W = 160;
  const H = 34;
  const x = (h) => ((h + 3) / 6) * (W - 8) + 4;
  const y = (v) => H - 4 - (v / 100) * (H - 8);
  const d = vals.map((p, i) => `${i ? 'L' : 'M'}${x(p.h).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="spark" aria-hidden="true">`
    + `<line x1="${x(0)}" y1="2" x2="${x(0)}" y2="${H - 2}" class="spark-now"/>`
    + `<path d="${d}" fill="none" stroke="${colour}" stroke-width="1.6"/></svg>`;
  return el('span', { html: svg });
}

/**
 * Pass drawer.
 * @param {HTMLElement} root
 * @param {object} c context: { pass, entry, intervals, tz, t, fmt: {dateTime, time, timeSec}, colour, ink, soft,
 *   cloudSeries, cloudRelevant, onClose, onIcs, onCopyLink, droneMinutes, onDroneMinutes }
 */
export function renderDrawer(root, c) {
  const { pass: p, entry: e, t } = c;
  root.replaceChildren();
  if (!p) { root.hidden = true; return; }
  root.hidden = false;
  const local = c.fmt.dateTime(p.closest_utc, c.tz);
  const utc = new Date(p.closest_utc).toISOString().slice(0, 19).replace('T', ' ');
  const diagram = geometryDiagram(p, c.intervals, {
    colour: c.colour, ink: c.ink, soft: c.soft,
    labels: {
      left: t('diag_left'), right: t('diag_right'), roi: t('diag_roi'), offset: t('diag_offset'),
      view: t('diag_view'), inc: t('diag_inc'), sun: t('diag_sun'), aria: t('diag_aria'),
    },
  });

  const facts = [
    [t('col_local'), `${local} (${c.tz})`],
    [t('col_utc'), utc],
    [t('col_dir'), t(`dir_${p.direction}`)],
    [t('col_cov'), `${p.coverage_pct.toFixed(1)} %`],
    [t('col_edge'), `${p.edge_margin_km.toFixed(1)} km${p.edge_uncertain ? ` (${t('edge_uncertain')})` : ''}`],
    [t('col_view'), `${p.view_angle_deg.toFixed(1)}°, ${t('diag_inc')} ${p.incidence_deg.toFixed(1)}°`],
    [t('col_sun'), `${p.sun_elevation_deg.toFixed(1)}° (${t('sun_az')} ${p.sun_azimuth_deg.toFixed(0)}°)`],
    [t('col_tle'), `${p.tle_age_days.toFixed(1)} ${t('days')}`],
    [t('col_acq'), t(`acq_${p.acquisition}`)],
  ];
  if (c.cloudRelevant) {
    facts.push([t('col_cloud'), p.cloud ? `${Math.round(p.cloud.total)} % (${t(`cloud_${p.cloud.kind}`)}; ${t('cloud_layers', { l: fmtPct(p.cloud.low), m: fmtPct(p.cloud.mid), h: fmtPct(p.cloud.high) })})` : t('cloud_none')]);
  } else {
    facts.push([t('col_cloud'), t('cloud_na')]);
  }
  if (p.plan) facts.push([t('col_plan'), t(`plan_${p.plan.status}`) + (p.plan.mode ? ` (${p.plan.mode})` : '')]);
  if (p.tiles?.length) facts.push([t('col_tile'), p.tiles.join(', ')]);
  if (p.rel_orbit) facts.push([t('col_relorb'), String(p.rel_orbit)]);

  const dl = el('dl', { class: 'facts' }, facts.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
  const spark = c.cloudRelevant && c.cloudSeries ? sparkline(cloudWindow(c.cloudSeries, p.closest_utc, 3), c.ink) : null;

  // Drone window
  const n = c.droneMinutes;
  const s0 = solarElevation(p.closest_utc - n * 60000, p.anchor_lat, c.anchorLon);
  const s1 = solarElevation(p.closest_utc + n * 60000, p.anchor_lat, c.anchorLon);
  const droneInput = el('input', { type: 'number', min: '5', max: '180', step: '5', value: String(n), class: 'drone-min', 'aria-label': t('drone_minutes') });
  droneInput.addEventListener('change', () => c.onDroneMinutes(Math.min(180, Math.max(5, Number(droneInput.value) || 30))));
  const drone = el('div', { class: 'drone' },
    el('label', { class: 'speed' }, el('span', {}, t('drone_label')), droneInput, el('span', {}, 'min')),
    el('p', { class: 'hint' }, t('drone_window', {
      from: c.fmt.time(p.closest_utc - n * 60000, c.tz), to: c.fmt.time(p.closest_utc + n * 60000, c.tz),
      s0: s0.toFixed(0), s1: s1.toFixed(0),
    })));

  const access = e.data_access ? el('a', { href: e.data_access, target: '_blank', rel: 'noopener' }, t('data_access')) : null;

  root.append(
    el('div', { class: 'drawer-head' },
      el('h3', {}, `${p.platform} ${p.instrument}`),
      el('button', { type: 'button', class: 'quiet', onclick: c.onClose, 'aria-label': t('close') }, '×')),
    el('div', { class: 'drawer-diagram', html: diagram }),
    dl,
    spark ? el('div', { class: 'spark-wrap' }, el('span', { class: 'hint' }, t('cloud_spark')), spark) : null,
    drone,
    el('div', { class: 'drawer-actions' },
      el('button', { type: 'button', class: 'secondary', onclick: c.onIcs }, t('add_calendar')),
      el('button', { type: 'button', class: 'secondary', onclick: c.onCopyLink }, t('copy_link')),
      access),
  );
}

const fmtPct = (v) => (v == null ? '–' : `${Math.round(v)} %`);

/** InSAR pairs tab. */
export function renderInsar(root, tracks, c) {
  root.replaceChildren();
  if (!tracks.length) { root.append(el('p', { class: 'hint' }, c.t('insar_empty'))); return; }
  for (const tr of tracks) {
    const head = `${tr.mission} ${tr.sensor}, ${c.t(`dir_${tr.direction}`)}${tr.rel_orbit ? `, ${c.t('col_relorb').toLowerCase()} ${tr.rel_orbit}` : ''}, ${c.t('diag_inc')} ${tr.incidence_deg.toFixed(1)}°`;
    const pairs = tr.pairs.map((pr) => el('li', {},
      el('button', { type: 'button', class: 'link', onclick: () => c.onSelect(pr.a.id) }, c.fmt.date(pr.a.closest_utc, c.tz)),
      ' → ',
      el('button', { type: 'button', class: 'link', onclick: () => c.onSelect(pr.b.id) }, c.fmt.date(pr.b.closest_utc, c.tz)),
      ` (${c.t('insar_days', { n: pr.days })}${pr.a.platform !== pr.b.platform ? `, ${pr.a.platform} + ${pr.b.platform}` : ''})`));
    root.append(el('section', { class: 'insar-track' }, el('h4', {}, head), el('ul', {}, pairs)));
  }
  root.append(el('p', { class: 'hint' }, c.t('insar_note')));
}

/** "sentinel-2b" → "Sentinel-2B", "landsat-9" → "Landsat 9". */
export function prettyPlatform(s) {
  let m = s.match(/^sentinel-(\d)([a-z])$/);
  if (m) return `Sentinel-${m[1]}${m[2].toUpperCase()}`;
  m = s.match(/^landsat-(\d+)$/);
  if (m) return `Landsat ${m[1]}`;
  return s;
}

/** Real acquisitions (STAC) tab. */
export function renderStac(root, state, c) {
  root.replaceChildren();
  if (state.loading) { root.append(el('p', { class: 'hint' }, c.t('stac_loading'))); return; }
  if (!state.groups) { root.append(el('p', { class: 'hint' }, c.t('stac_idle'))); return; }
  const errs = Object.entries(state.errors ?? {});
  if (errs.length) root.append(el('p', { class: 'error' }, c.t('stac_error', { list: errs.map(([k, v]) => `${k}: ${v}`).join('; ') })));
  root.append(el('p', { class: 'hint' }, c.t('stac_range', { from: c.fmt.date(state.from, c.tz), to: c.fmt.date(state.to, c.tz), n: state.groups.length })));
  if (!state.groups.length) return;
  const rows = state.groups.map((g) => el('tr', {},
    el('td', {}, prettyPlatform(g.platform)),
    el('td', {}, c.fmt.dateTime(g.datetime, c.tz)),
    el('td', { class: 'num' }, g.cloud == null ? '–' : `${Math.round(g.cloud)}`),
    el('td', {}, g.tiles.join(', ') || g.path_row || (g.rel_orbit ? `${c.t('col_relorb')} ${g.rel_orbit}` : '')),
    el('td', {}, [g.mode, g.orbit_state ? c.t(`dir_${g.orbit_state}`) : ''].filter(Boolean).join(', ')),
    el('td', {}, g.url ? el('a', { href: g.url, target: '_blank', rel: 'noopener' }, 'STAC') : '')));
  root.append(el('div', { class: 'table-wrap' }, el('table', {},
    el('thead', {}, el('tr', {}, [c.t('col_sat'), c.t('col_local'), c.t('col_cloud'), c.t('stac_tile'), c.t('stac_mode'), ''].map((h, i) => el('th', { class: i === 2 ? 'num' : '' }, h)))),
    el('tbody', {}, rows))));
  root.append(el('p', { class: 'hint' }, c.t('stac_note')));
}

/** Build and print the field sheet. */
export function printFieldSheet(root, c) {
  root.replaceChildren(
    el('h1', {}, 'EO Pass Planner'),
    el('p', { class: 'ps-answer' }, c.answer),
    el('p', {}, c.roiSummary),
    c.mapImage ? el('img', { src: c.mapImage, alt: c.t('print_map_alt'), class: 'ps-map' }) : null,
    c.table,
    el('h2', {}, c.t('print_provenance')),
    el('p', {}, c.provenance),
    el('h2', {}, c.t('print_limitations')),
    el('div', { html: c.limitations }),
  );
  window.print();
}
