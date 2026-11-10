/**
 * export.js: CSV export of computed passes (GeoJSON, ICS, field sheet and
 * GeoLibre project to follow).
 *
 * Inputs:  passes from engine.js, ROI time zone, provenance (catalogue
 *          version, data update time, engine version).
 * Outputs: CSV text (RFC 4180, comma-separated, UTF-8) and a browser download.
 *
 * Limitations: numeric values are rounded for readability (times to 0.1 s,
 * distances to 0.1 km, angles to 0.01°).
 */

import { isoLocal } from './i18n.js';

const COLUMNS = [
  ['platform', (p) => p.platform],
  ['instrument', (p) => p.instrument],
  ['norad_id', (p) => p.norad_id],
  ['acquisition', (p) => p.acquisition],
  ['imaging_expected', (p) => p.imaging_expected],
  ['filter_reasons', (p) => p.filter_reasons.join(';')],
  ['direction', (p) => p.direction],
  ['closest_utc', (p) => new Date(p.closest_utc).toISOString().replace(/(\.\d)\d\dZ$/, '$1Z')],
  ['closest_local', (p, ctx) => isoLocal(p.closest_utc, ctx.tz)],
  ['entry_utc', (p) => new Date(p.entry_utc).toISOString().slice(0, 19) + 'Z'],
  ['exit_utc', (p) => new Date(p.exit_utc).toISOString().slice(0, 19) + 'Z'],
  ['timezone', (_p, ctx) => ctx.tz],
  ['coverage_pct', (p) => p.coverage_pct.toFixed(1)],
  ['nadir_offset_km', (p) => p.nadir_offset_km.toFixed(1)],
  ['side_of_track', (p) => p.side],
  ['edge_margin_km', (p) => p.edge_margin_km.toFixed(1)],
  ['edge_uncertain', (p) => p.edge_uncertain],
  ['view_angle_deg', (p) => p.view_angle_deg.toFixed(2)],
  ['incidence_deg', (p) => p.incidence_deg.toFixed(2)],
  ['sun_elevation_deg', (p) => p.sun_elevation_deg.toFixed(2)],
  ['sun_azimuth_deg', (p) => p.sun_azimuth_deg.toFixed(2)],
  ['altitude_km', (p) => p.altitude_km.toFixed(1)],
  ['cloud_pct', (p) => (p.cloud ? Math.round(p.cloud.total) : '')],
  ['cloud_source', (p) => p.cloud?.kind ?? ''],
  ['esa_plan', (p) => p.plan?.status ?? ''],
  ['s2_tiles', (p) => p.tiles?.join(' ') ?? ''],
  ['s1_relative_orbit', (p) => p.rel_orbit ?? ''],
  ['tle_epoch_utc', (p) => p.tle_epoch],
  ['tle_age_days', (p) => p.tle_age_days.toFixed(2)],
  ['catalogue_version', (_p, ctx) => ctx.catalogueVersion],
  ['data_updated_utc', (_p, ctx) => ctx.dataUpdated],
  ['engine_version', (_p, ctx) => ctx.engineVersion],
];

const cell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function passesToCsv(passes, ctx) {
  const lines = [COLUMNS.map(([h]) => h).join(',')];
  for (const p of passes) lines.push(COLUMNS.map(([, f]) => cell(f(p, ctx))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function download(filename, text, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- iCalendar ----------

const icsEscape = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Fold content lines at 75 octets (RFC 5545 §3.1). */
function fold(line) {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 75) return line;
  const out = [];
  let cur = '';
  let len = 0;
  for (const ch of line) {
    const l = new TextEncoder().encode(ch).length;
    if (len + l > (out.length ? 74 : 75)) { out.push(cur); cur = ''; len = 0; }
    cur += ch;
    len += l;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/**
 * iCalendar with one VEVENT per pass, from ROI entry to exit (at least one
 * minute). UID = pass id (instrument + closest-approach minute), stable across
 * re-runs unless an element-set update moves the pass across a minute boundary.
 * `describe(p)` returns {summary, description}.
 */
export function passesToIcs(passes, { anchor, describe, now = Date.now() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EO Pass Planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  for (const p of passes) {
    const { summary, description } = describe(p);
    const start = Math.min(p.entry_utc, p.closest_utc);
    const end = Math.max(p.exit_utc, start + 60000);
    lines.push('BEGIN:VEVENT',
      `UID:${p.id}@eo-pass-planner`,
      `DTSTAMP:${icsTime(now)}`,
      `DTSTART:${icsTime(start)}`,
      `DTEND:${icsTime(end)}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      `GEO:${anchor.lat.toFixed(5)};${anchor.lon.toFixed(5)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

// ---------- GeoJSON footprints ----------

export function footprintsGeoJSON(passes, { roi, tz }) {
  const features = passes.map((p) => ({
    type: 'Feature',
    properties: {
      platform: p.platform, instrument: p.instrument, closest_utc: new Date(p.closest_utc).toISOString(),
      closest_local: isoLocal(p.closest_utc, tz), direction: p.direction, coverage_pct: +p.coverage_pct.toFixed(1),
      acquisition: p.acquisition, edge_margin_km: +p.edge_margin_km.toFixed(1),
      cloud_pct: p.cloud ? Math.round(p.cloud.total) : null,
    },
    geometry: { type: 'MultiPolygon', coordinates: p.footprints },
  }));
  features.unshift({ type: 'Feature', properties: { role: 'roi' }, geometry: roi });
  return { type: 'FeatureCollection', features };
}

// ---------- GeoLibre project ----------

/**
 * A GeoLibre project (format 0.2.0, https://geolibre.app) with the ROI and
 * one footprint layer per instrument category, to continue the analysis in
 * GeoLibre (opengeos). Layers embed their GeoJSON.
 */
export function geolibreProject(passes, { roi, anchor, tz, name, categoryOf, colourOf, labelOf }) {
  const layers = [];
  const styles = {};
  const add = (id, label, geojson, colour, fillOpacity) => {
    const style = {
      minZoom: 0, maxZoom: 24, fillColor: colour, strokeColor: colour, strokeWidth: 1.5, strokeWidthUnit: 'pixels',
      strokeOpacity: 1, strokeDash: [], strokeBlur: 0, fillOpacity, circleRadius: 6,
    };
    layers.push({ id, name: label, type: 'geojson', source: { type: 'geojson' }, visible: true, opacity: 1, style, metadata: {}, geojson });
    styles[id] = style;
  };
  const groups = new Map();
  for (const p of passes) {
    const c = categoryOf(p);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(p);
  }
  for (const [c, ps] of groups) {
    const fc = footprintsGeoJSON(ps, { roi, tz });
    fc.features.shift();
    add(`footprints-${c}`, labelOf(c), fc, colourOf(c), 0.15);
  }
  add('roi', 'ROI', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: roi }] }, '#17283A', 0.1);
  return {
    version: '0.2.0',
    name,
    mapView: { center: [anchor.lon, anchor.lat], zoom: 6, bearing: 0, pitch: 0 },
    basemapStyleUrl: 'https://tiles.openfreemap.org/styles/positron',
    basemapVisible: true,
    basemapOpacity: 1,
    blankBackgroundColor: null,
    layers,
    selectedLayerId: null,
    styles,
    preferences: {},
    metadata: { generator: 'EO Pass Planner', generated_utc: new Date().toISOString(), note: 'Predicted geometric footprints; not acquisitions.' },
  };
}
