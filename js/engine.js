/**
 * engine.js: swath-aware pass prediction (pure functions; run in a Web Worker
 * by engine.worker.js, and imported directly by the Node tests).
 *
 * Inputs:  catalogue entries, TLE records {line1, line2, epoch}, an ROI GeoJSON
 *          geometry, a time window (start, days) and options.
 * Outputs: { passes[], per_entry{}, roi{}, window{} }. Each pass has times (ms
 *          UTC), direction, ROI coverage %, cross-track offset, side of track,
 *          edge margin, view and incidence angles, sun position, altitude, TLE
 *          age, an `imaging_expected` flag and the reasons when it is false.
 *
 * Method:
 * 1. SGP4 (satellite.js) sampled every `coarseStepS` (30 s). A candidate window
 *    opens while the sub-satellite point is within reach + ROI radius + margin
 *    (150 km) of the ROI anchor; reach is the farthest cross-track extent.
 * 2. Each window (padded by one coarse step) is resampled every `fineStepS`
 *    (1 s). The heading is the geodesic azimuth between consecutive
 *    sub-satellite points; the scan line runs perpendicular to it (yaw-steered
 *    imager) over the instrument's cross-track extent.
 * 3. Scan lines form a strip, intersected with the ROI in an ROI-centred LAEA
 *    projection: coverage %, entry and exit times.
 * 4. Closest approach is the minimum geodesic distance between the
 *    sub-satellite point and the ROI anchor, refined below the step by a
 *    parabola through the squared distances (exact for uniform straight motion).
 *
 * Limitations:
 * - Only `nadir_symmetric` swaths are implemented so far. Other models are
 *   reported as unsupported, not silently skipped.
 * - Nominal swath widths; real edges vary by a few km (|edge margin| < 5 km
 *   is flagged as uncertain).
 * - SGP4 error grows with TLE age and across manoeuvres.
 * - Geometric prediction is not acquisition: systematic missions can still
 *   skip acquisitions.
 */

import * as sat from '../vendor/satellite.js';
import {
  prepareRoi, geoInverse, haversineKm, wrap180, scanLine, stripPolygon,
  stripLonLat, intersectionArea, touchesRoi,
} from './geometry.js';
import { solarPosition } from './sun.js';

export const ENGINE_VERSION = '0.1.0';
export const EDGE_UNCERTAIN_KM = 5;
const DAY_MS = 86400000;
const DEG = 180 / Math.PI;

export const DEFAULTS = {
  coarseStepS: 30,
  fineStepS: 1,
  marginKm: 150,
  minCoveragePct: 0,
  minSunElevationDeg: 0,
};

/** Signed cross-track extent [a, b] in km (positive = right of track), or null if unsupported. */
export function crossTrackExtent(entry) {
  const s = entry.swath;
  if (s.model === 'nadir_symmetric') return [-s.width_km / 2, s.width_km / 2];
  return null;
}

/** Sub-satellite point and ECF position at time `ms`; null if SGP4 fails. */
function subPoint(satrec, ms) {
  const d = new Date(ms);
  const pv = sat.propagate(satrec, d);
  if (!pv || !pv.position || Number.isNaN(pv.position.x)) return null;
  const gmst = sat.gstime(d);
  const g = sat.eciToGeodetic(pv.position, gmst);
  return {
    t: ms,
    lat: g.latitude * DEG,
    lon: wrap180(g.longitude * DEG),
    height: g.height,
    ecf: sat.eciToEcf(pv.position, gmst),
  };
}

function ecfOfGround(lat, lon) {
  return sat.geodeticToEcf({ latitude: lat / DEG, longitude: lon / DEG, height: 0 });
}

const sub3 = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const norm = (a) => Math.sqrt(dot(a, a));
const angleDeg = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (norm(a) * norm(b))))) * DEG;

/**
 * Off-nadir view angle at the satellite and incidence angle at the ground
 * point, both from the ellipsoid normal (geodetic), in degrees.
 */
export function viewGeometry(s, lat, lon) {
  const ground = ecfOfGround(lat, lon);
  const nadirGround = ecfOfGround(s.lat, s.lon);
  const up = {
    x: Math.cos(lat / DEG) * Math.cos(lon / DEG),
    y: Math.cos(lat / DEG) * Math.sin(lon / DEG),
    z: Math.sin(lat / DEG),
  };
  const toGround = sub3(ground, s.ecf);
  return {
    view: angleDeg(sub3(nadirGround, s.ecf), toGround),
    incidence: angleDeg(sub3(s.ecf, ground), up),
  };
}

function passFilterReasons(entry, p, opts) {
  const reasons = [];
  const day = p.sun_elevation_deg > opts.minSunElevationDeg;
  switch (entry.pass_filter) {
    case 'day_descending':
      if (!day) reasons.push('night');
      if (p.direction !== 'descending') reasons.push('ascending');
      break;
    case 'day_ascending':
      if (!day) reasons.push('night');
      if (p.direction !== 'ascending') reasons.push('descending');
      break;
    case 'day_any':
      if (!day) reasons.push('night');
      break;
    case 'night_any':
      if (day) reasons.push('day');
      break;
    default:
      break;
  }
  const ll = entry.lat_limits;
  if (ll && (p.anchor_lat < ll[0] || p.anchor_lat > ll[1])) reasons.push('outside_lat_limits');
  if (p.coverage_pct < opts.minCoveragePct || p.coverage_pct === 0) reasons.push('below_min_coverage');
  return reasons;
}

/** Candidate windows [t0, t1] (ms) from the coarse scan, plus the overall closest sample. */
function coarseScan(satrec, roi, startMs, endMs, reachKm, opts) {
  const step = opts.coarseStepS * 1000;
  const limit = reachKm + roi.radiusKm + opts.marginKm;
  const windows = [];
  let open = null;
  let closest = { km: Infinity, t: null };
  for (let t = startMs; t <= endMs; t += step) {
    const s = subPoint(satrec, t);
    if (!s) { open = null; continue; }
    const d = haversineKm(s.lat, s.lon, roi.anchor.lat, roi.anchor.lon);
    if (d < closest.km) closest = { km: d, t };
    if (d < limit) {
      if (open) open[1] = t;
      else { open = [t, t]; windows.push(open); }
    } else {
      open = null;
    }
  }
  return {
    windows: windows.map(([a, b]) => [Math.max(startMs, a - step), Math.min(endMs, b + step)]),
    closest,
  };
}

/** Refine one candidate window into a pass (or null if the swath misses the ROI). */
function refineWindow(entry, satrec, tle, roi, [w0, w1], extent, opts) {
  const step = opts.fineStepS * 1000;
  const subs = [];
  for (let t = w0; t <= w1 + step; t += step) {
    const s = subPoint(satrec, t);
    if (s) subs.push(s);
  }
  if (subs.length < 3) return null;

  const lines = [];
  const d2 = [];
  for (let i = 0; i + 1 < subs.length; i++) {
    const g = geoInverse(subs[i].lat, subs[i].lon, subs[i + 1].lat, subs[i + 1].lon);
    lines.push({ t: subs[i].t, ...scanLine(subs[i], g.azi1, extent) });
    d2.push(geoInverse(subs[i].lat, subs[i].lon, roi.anchor.lat, roi.anchor.lon).km ** 2);
  }

  // Closest approach, refined below the step.
  let k = 0;
  for (let i = 1; i < d2.length; i++) if (d2[i] < d2[k]) k = i;
  let tStar = lines[k].t;
  if (k > 0 && k < d2.length - 1) {
    const den = d2[k - 1] - 2 * d2[k] + d2[k + 1];
    if (den > 0) tStar += (0.5 * (d2[k - 1] - d2[k + 1]) / den) * step;
  }
  const s = subPoint(satrec, tStar);
  const sm = subPoint(satrec, tStar - 500);
  const sp = subPoint(satrec, tStar + 500);
  if (!s || !sm || !sp) return null;
  const hd = geoInverse(sm.lat, sm.lon, sp.lat, sp.lon);
  const heading = wrap180(hd.azi1 + wrap180(hd.azi2 - hd.azi1) / 2);
  const toAnchor = geoInverse(s.lat, s.lon, roi.anchor.lat, roi.anchor.lon);
  const rel = wrap180(toAnchor.azi1 - heading);
  const crossKm = toAnchor.km * Math.sign(rel || 1);
  const [a, b] = extent;
  const edgeMargin = crossKm >= a && crossKm <= b ? Math.min(crossKm - a, b - crossKm)
    : -Math.min(Math.abs(crossKm - a), Math.abs(crossKm - b));

  // Coverage and entry/exit.
  let coverage;
  let entryT = tStar;
  let exitT = tStar;
  if (roi.isPoint) {
    coverage = edgeMargin >= 0 ? 100 : 0;
  } else {
    const strip = stripPolygon(lines, roi.proj);
    coverage = Math.min(100, (100 * intersectionArea(strip, roi)) / roi.area);
    if (coverage > 0) {
      let first = null;
      let last = null;
      for (let i = 0; i + 1 < lines.length; i++) {
        const cell = stripPolygon([lines[i], lines[i + 1]], roi.proj);
        if (touchesRoi(cell, roi)) {
          if (first === null) first = i;
          last = i + 1;
        }
      }
      if (first !== null) { entryT = lines[first].t; exitT = lines[last].t; }
    }
  }
  if (coverage <= 0) return null;

  const sun = solarPosition(tStar, roi.anchor.lat, roi.anchor.lon);
  const vg = viewGeometry(s, roi.anchor.lat, roi.anchor.lon);
  const p = {
    id: `${entry.id}_${new Date(tStar).toISOString().slice(0, 16)}`,
    entry_id: entry.id,
    platform: entry.platform,
    instrument: entry.instrument,
    norad_id: entry.norad_id,
    acquisition: entry.acquisition,
    direction: sp.lat < sm.lat ? 'descending' : 'ascending',
    closest_utc: tStar,
    entry_utc: Math.min(entryT, tStar),
    exit_utc: Math.max(exitT, tStar),
    coverage_pct: coverage,
    nadir_offset_km: Math.abs(crossKm),
    cross_track_km: crossKm,
    side: rel >= 0 ? 'right' : 'left',
    side_compass: Math.sin(toAnchor.azi1 / DEG) >= 0 ? 'E' : 'W',
    edge_margin_km: edgeMargin,
    edge_uncertain: Math.abs(edgeMargin) < EDGE_UNCERTAIN_KM,
    view_angle_deg: vg.view,
    incidence_deg: vg.incidence,
    sun_elevation_deg: sun.elevation,
    sun_azimuth_deg: sun.azimuth,
    altitude_km: s.height,
    heading_deg: heading,
    anchor_lat: roi.anchor.lat,
    tle_epoch: tle.epoch,
    tle_age_days: Math.abs(tStar - new Date(tle.epoch).getTime()) / DAY_MS,
    footprint: stripLonLat(lines),
  };
  p.filter_reasons = passFilterReasons(entry, p, opts);
  p.imaging_expected = p.filter_reasons.length === 0;
  return p;
}

/**
 * Predict passes of one catalogue entry over a prepared ROI.
 * Returns { status, passes, closest_km, closest_utc, reach_km }.
 */
export function predictEntry(entry, tle, roi, startMs, endMs, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const extent = crossTrackExtent(entry);
  if (!extent) return { status: 'unsupported_model', passes: [] };
  if (!tle) return { status: 'no_tle', passes: [] };
  const satrec = sat.twoline2satrec(tle.line1, tle.line2);
  const reachKm = Math.max(Math.abs(extent[0]), Math.abs(extent[1]));
  const { windows, closest } = coarseScan(satrec, roi, startMs, endMs, reachKm, opts);
  const passes = [];
  for (const w of windows) {
    const p = refineWindow(entry, satrec, tle, roi, w, extent, opts);
    if (p) passes.push(p);
  }
  return { status: 'ok', passes, closest_km: closest.km, closest_utc: closest.t, reach_km: reachKm };
}

/**
 * Predict passes for several entries.
 * @param {object} q
 * @param {object[]} q.entries   catalogue entries
 * @param {object} q.tles        {norad: {line1, line2, epoch}}
 * @param {object} q.roi         GeoJSON geometry
 * @param {string|number|Date} q.start
 * @param {number} q.days
 * @param {object} [q.options]   see DEFAULTS
 * @param {function} [onProgress] ({entry_id, done, total}) => void
 */
export function predictPasses(q, onProgress = () => {}) {
  const roi = prepareRoi(q.roi);
  const startMs = new Date(q.start).getTime();
  const endMs = startMs + q.days * DAY_MS;
  const passes = [];
  const perEntry = {};
  q.entries.forEach((e, i) => {
    const r = predictEntry(e, q.tles[String(e.norad_id)], roi, startMs, endMs, q.options);
    passes.push(...r.passes);
    const { passes: ps, ...rest } = r;
    perEntry[e.id] = { ...rest, n_passes: ps.length, n_expected: ps.filter((p) => p.imaging_expected).length };
    onProgress({ entry_id: e.id, done: i + 1, total: q.entries.length });
  });
  passes.sort((a, b) => a.closest_utc - b.closest_utc);
  return {
    engine_version: ENGINE_VERSION,
    roi: { anchor: roi.anchor, area_km2: roi.area / 1e6, radius_km: roi.radiusKm },
    window: { start_utc: startMs, end_utc: endMs },
    passes,
    per_entry: perEntry,
  };
}
