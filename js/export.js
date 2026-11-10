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
