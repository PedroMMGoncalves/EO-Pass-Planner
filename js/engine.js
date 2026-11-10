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
 *          Geostationary entries return view geometry in per_entry instead.
 *
 * Method:
 * 1. SGP4 (satellite.js) sampled every `coarseStepS` (30 s). A candidate window
 *    opens while the sub-satellite point is within reach + ROI radius + margin
 *    (150 km) of the ROI anchor; reach is the farthest cross-track extent.
 * 2. Each window (padded by one coarse step) is resampled every `fineStepS`
 *    (1 s). The heading is the geodesic azimuth between consecutive
 *    sub-satellite points; scan lines run perpendicular to it (yaw-steered
 *    imager) over each cross-track interval of the instrument.
 * 3. Scan lines form strips, intersected with the ROI in an ROI-centred LAEA
 *    projection: coverage %, entry and exit times.
 * 4. Closest approach is the minimum geodesic distance between the
 *    sub-satellite point and the ROI anchor, refined below the step by a
 *    parabola through the squared distances (exact for uniform straight motion).
 *
 * Swath models → signed cross-track intervals (km, positive = right of track):
 * - nadir_symmetric: [-w/2, w/2]; with gap_km, two strips outside the gap.
 * - side_looking: incidence range [near, far] on the look side.
 * - field_of_regard: the reachable corridor (geometric opportunity only):
 *   ± (ground reach at max_offnadir_deg + w/2), a signed off-nadir range
 *   (offnadir_range_deg, positive = right of track), or the access incidence
 *   range on the look side (tasked SAR).
 * - profile: one narrow strip per beam (footprint diameter). A pass is listed
 *   when the nearest beam is within `near_km` (default 2 km) of the ROI.
 * - track_only: ± proximity_km (default 50 km) of the ground track.
 * - continuous_geo: no passes; view zenith angle at the ROI anchor.
 *
 * Limitations:
 * - Incidence/off-nadir angles are converted to ground distance on a sphere
 *   (R = 6371 km) with the mean altitude from the TLE mean motion; terrain is
 *   ignored. Error: a few km at the far edge of wide SAR swaths.
 * - Nominal swath widths; real edges vary by a few km (|edge margin| < 5 km
 *   is flagged as uncertain).
 * - SGP4 error grows with TLE age and across manoeuvres. Lidar beams may be
 *   pointed off the TLE track (ICESat-2 reference ground tracks).
 * - Geometric prediction is not acquisition: systematic missions can still
 *   skip acquisitions, and tasked sensors only offer opportunities.
 */

import * as sat from '../vendor/satellite.js';
import polygonClipping from '../vendor/polygon-clipping.js';
import {
  prepareRoi, geoInverse, haversineKm, wrap180, scanLine, stripPolygon,
  stripLonLat, multiPolygonArea, pointInPolygon,
} from './geometry.js';
import { solarPosition } from './sun.js';

export const ENGINE_VERSION = '0.2.0';
export const EDGE_UNCERTAIN_KM = 5;
const DAY_MS = 86400000;
const DEG = 180 / Math.PI;
const R_EARTH = 6371.0088;
const R_EQUATOR = 6378.137;
const MU = 398600.4418; // km³/s²
const R_GEO = 42164.17; // geostationary orbit radius, km

export const DEFAULTS = {
  coarseStepS: 30,
  fineStepS: 1,
  marginKm: 150,
  minCoveragePct: 0,
  minSunElevationDeg: 0,
};

// ---------- geometry of the swath ----------

/**
 * SGP4 record from a stored element set: TLE lines, or an OMM JSON record for
 * catalogue numbers above 99 999 (which do not fit the TLE format).
 */
export function satrecFrom(rec) {
  return rec.omm ? sat.json2satrec(rec.omm) : sat.twoline2satrec(rec.line1, rec.line2);
}

/** Mean altitude (km) from the TLE mean motion (satrec.no, rad/min). */
export function meanAltitudeKm(satrec) {
  const n = satrec.no / 60;
  return Math.cbrt(MU / (n * n)) - R_EQUATOR;
}

/** Ground distance (km) from nadir to a point seen at incidence `incDeg` from altitude h (sphere). */
export function groundFromIncidence(incDeg, h) {
  const inc = incDeg / DEG;
  const eta = Math.asin((R_EARTH / (R_EARTH + h)) * Math.sin(inc));
  return R_EARTH * (inc - eta);
}

/** Ground distance (km) from nadir to the point seen at off-nadir angle `etaDeg` (sphere). */
export function groundFromOffNadir(etaDeg, h) {
  const eta = etaDeg / DEG;
  const s = ((R_EARTH + h) / R_EARTH) * Math.sin(eta);
  if (s >= 1) return R_EARTH * Math.acos(R_EARTH / (R_EARTH + h)); // horizon
  return R_EARTH * (Math.asin(s) - eta);
}

/**
 * Signed cross-track intervals [[a, b], ...] in km for an entry at altitude h,
 * or null for models without a ground swath (continuous_geo) or unknown models.
 */
export function swathIntervals(entry, h) {
  const s = entry.swath;
  const sideOf = (n, f, side) => {
    if (side === 'left') return [[-f, -n]];
    if (side === 'both') return [[-f, -n], [n, f]];
    return [[n, f]];
  };
  switch (s.model) {
    case 'nadir_symmetric':
      return s.gap_km > 0
        ? [[-s.width_km / 2, -s.gap_km / 2], [s.gap_km / 2, s.width_km / 2]]
        : [[-s.width_km / 2, s.width_km / 2]];
    case 'side_looking':
      return sideOf(groundFromIncidence(s.incidence_deg[0], h), groundFromIncidence(s.incidence_deg[1], h), s.look_side);
    case 'field_of_regard': {
      if (s.offnadir_range_deg) {
        // Asymmetric pointing range, signed (positive = right of track).
        const g = (eta) => Math.sign(eta) * groundFromOffNadir(Math.abs(eta), h);
        const half = (s.width_km ?? 0) / 2;
        return [[g(s.offnadir_range_deg[0]) - half, g(s.offnadir_range_deg[1]) + half]];
      }
      if (s.access_incidence_deg) {
        return sideOf(groundFromIncidence(s.access_incidence_deg[0], h), groundFromIncidence(s.access_incidence_deg[1], h), s.look_side ?? 'right');
      }
      const d = groundFromOffNadir(s.max_offnadir_deg, h) + (s.width_km ?? 0) / 2;
      return [[-d, d]];
    }
    case 'profile': {
      const half = (s.footprint_m ?? 20) / 2000;
      return s.beams_cross_track_km.map((o) => [o - half, o + half]);
    }
    case 'track_only': {
      const p = s.proximity_km ?? 50;
      return [[-p, p]];
    }
    default:
      return null;
  }
}

/** Signed margin of a cross-track position x to a set of intervals (positive inside). */
function intervalMargin(x, intervals) {
  let best = -Infinity;
  for (const [a, b] of intervals) {
    const m = x >= a && x <= b ? Math.min(x - a, b - x) : -Math.min(Math.abs(x - a), Math.abs(x - b));
    if (m > best) best = m;
  }
  return best;
}

// ---------- propagation helpers ----------

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
const upVector = (lat, lon) => ({
  x: Math.cos(lat / DEG) * Math.cos(lon / DEG),
  y: Math.cos(lat / DEG) * Math.sin(lon / DEG),
  z: Math.sin(lat / DEG),
});

/**
 * Off-nadir view angle at the satellite and incidence angle at the ground
 * point, both from the ellipsoid normal (geodetic), in degrees.
 */
export function viewGeometry(s, lat, lon) {
  const ground = ecfOfGround(lat, lon);
  const nadirGround = ecfOfGround(s.lat, s.lon);
  return {
    view: angleDeg(sub3(nadirGround, s.ecf), sub3(ground, s.ecf)),
    incidence: angleDeg(sub3(s.ecf, ground), upVector(lat, lon)),
  };
}

/** View zenith angle (deg) of a geostationary satellite at `subLon` seen from (lat, lon). */
export function geoViewZenith(subLon, lat, lon) {
  const satPos = { x: R_GEO * Math.cos(subLon / DEG), y: R_GEO * Math.sin(subLon / DEG), z: 0 };
  return angleDeg(sub3(satPos, ecfOfGround(lat, lon)), upVector(lat, lon));
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
  if (entry.swath.model !== 'profile' && (p.coverage_pct < opts.minCoveragePct || p.coverage_pct === 0)) reasons.push('below_min_coverage');
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

/** Coverage (%) of the ROI by the union of strips (projected polygons). */
function stripsCoverage(strips, roi) {
  const u = strips.length === 1 ? [strips[0]] : polygonClipping.union(...strips);
  const inter = polygonClipping.intersection(u, roi.polys);
  return Math.min(100, (100 * multiPolygonArea(inter)) / roi.area);
}

function touches(strips, roi) {
  if (roi.isPoint) return strips.some((s) => pointInPolygon([0, 0], s));
  return strips.some((s) => polygonClipping.intersection(s, roi.polys).length > 0);
}

/** Refine one candidate window into a pass (or null if the swath misses the ROI). */
function refineWindow(entry, satrec, tle, roi, [w0, w1], intervals, opts) {
  const step = opts.fineStepS * 1000;
  const subs = [];
  for (let t = w0; t <= w1 + step; t += step) {
    const s = subPoint(satrec, t);
    if (s) subs.push(s);
  }
  if (subs.length < 3) return null;

  // Closest sample by great-circle distance, then geodesic distances around it
  // for the sub-step parabola.
  const n = subs.length - 1;
  let k = 0;
  let dk = Infinity;
  for (let i = 0; i < n; i++) {
    const d = haversineKm(subs[i].lat, subs[i].lon, roi.anchor.lat, roi.anchor.lon);
    if (d < dk) { dk = d; k = i; }
  }
  const gd2 = (i) => geoInverse(subs[i].lat, subs[i].lon, roi.anchor.lat, roi.anchor.lon).km ** 2;
  let tStar = subs[k].t;
  if (k > 0 && k < n - 1) {
    const [a, b, c] = [gd2(k - 1), gd2(k), gd2(k + 1)];
    const den = a - 2 * b + c;
    if (den > 0) tStar += (0.5 * (a - c) / den) * step;
  }

  // Scan lines are only needed where they can reach the ROI: within 1.2 × ROI
  // radius + 10 km along-track of the closest approach (the factor covers the
  // convergence of scan lines far from the track). A sparser set over a longer
  // stretch is kept for display.
  const vStep = Math.max(0.5, haversineKm(subs[k].lat, subs[k].lon, subs[k + 1].lat, subs[k + 1].lon));
  const half = Math.ceil((1.2 * roi.radiusKm + 10) / vStep) + 1;
  const lineAt = (i) => {
    const g = geoInverse(subs[i].lat, subs[i].lon, subs[i + 1].lat, subs[i + 1].lon);
    return { t: subs[i].t, lines: intervals.map((iv) => scanLine(subs[i], g.azi1, iv)) };
  };
  const samples = [];
  for (let i = Math.max(0, k - half); i <= Math.min(n - 1, k + half); i++) samples.push(lineAt(i));
  const dispHalf = Math.ceil((roi.radiusKm + 300) / vStep);
  const display = [];
  for (let i = Math.max(0, k - dispHalf); i <= Math.min(n - 1, k + dispHalf); i += 5) display.push(lineAt(i));
  const s = subPoint(satrec, tStar);
  const sm = subPoint(satrec, tStar - 500);
  const sp = subPoint(satrec, tStar + 500);
  if (!s || !sm || !sp) return null;
  const hd = geoInverse(sm.lat, sm.lon, sp.lat, sp.lon);
  const heading = wrap180(hd.azi1 + wrap180(hd.azi2 - hd.azi1) / 2);
  const toAnchor = geoInverse(s.lat, s.lon, roi.anchor.lat, roi.anchor.lon);
  const rel = wrap180(toAnchor.azi1 - heading);
  const crossKm = toAnchor.km * Math.sign(rel || 1);
  const edgeMargin = intervalMargin(crossKm, intervals);
  const isProfile = entry.swath.model === 'profile';
  const nearKm = entry.swath.near_km ?? 2;

  // Coverage and entry/exit.
  const lineSets = intervals.map((_, j) => samples.map((smp) => ({ t: smp.t, ...smp.lines[j] })));
  let coverage;
  let entryT = tStar;
  let exitT = tStar;
  if (roi.isPoint) {
    coverage = edgeMargin >= 0 ? 100 : 0;
  } else {
    coverage = stripsCoverage(lineSets.map((ls) => stripPolygon(ls, roi.proj)), roi);
    if (coverage > 0) {
      let first = null;
      let last = null;
      for (let i = 0; i + 1 < samples.length; i++) {
        const cells = lineSets.map((ls) => stripPolygon([ls[i], ls[i + 1]], roi.proj));
        if (touches(cells, roi)) {
          if (first === null) first = i;
          last = i + 1;
        }
      }
      if (first !== null) { entryT = samples[first].t; exitT = samples[last].t; }
    }
  }
  if (coverage <= 0 && !(isProfile && edgeMargin >= -nearKm)) return null;

  const sun = solarPosition(tStar, roi.anchor.lat, roi.anchor.lon);
  const vg = viewGeometry(s, roi.anchor.lat, roi.anchor.lon);
  const p = {
    id: `${entry.id}_${new Date(tStar).toISOString().slice(0, 16)}`,
    entry_id: entry.id,
    platform: entry.platform,
    instrument: entry.instrument,
    norad_id: entry.norad_id,
    acquisition: entry.acquisition,
    model: entry.swath.model,
    opportunity: entry.acquisition === 'tasked',
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
    edge_uncertain: isProfile || Math.abs(edgeMargin) < EDGE_UNCERTAIN_KM,
    view_angle_deg: vg.view,
    incidence_deg: vg.incidence,
    sun_elevation_deg: sun.elevation,
    sun_azimuth_deg: sun.azimuth,
    altitude_km: s.height,
    heading_deg: heading,
    anchor_lat: roi.anchor.lat,
    tle_epoch: tle.epoch,
    tle_age_days: Math.abs(tStar - new Date(tle.epoch).getTime()) / DAY_MS,
    footprints: intervals.map((_, j) => stripLonLat(display.map((smp) => ({ t: smp.t, ...smp.lines[j] })))),
  };
  p.filter_reasons = passFilterReasons(entry, p, opts);
  p.imaging_expected = p.filter_reasons.length === 0;
  return p;
}

/**
 * Predict passes of one catalogue entry over a prepared ROI.
 * Returns { status, passes, closest_km, closest_utc, closest_side, reach_km }
 * or, for geostationary entries, { status: 'geo', passes: [], view_zenith_deg, usable, ... }.
 */
export function predictEntry(entry, tle, roi, startMs, endMs, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (entry.swath.model === 'continuous_geo') {
    const s = entry.swath;
    const vza = geoViewZenith(s.sub_lon, roi.anchor.lat, roi.anchor.lon);
    return {
      status: 'geo', passes: [], view_zenith_deg: vza, usable: vza <= s.max_view_zenith_deg,
      repeat_min: s.repeat_min, sub_lon: s.sub_lon, max_view_zenith_deg: s.max_view_zenith_deg,
    };
  }
  if (!tle) return { status: 'no_tle', passes: [] };
  const satrec = satrecFrom(tle);
  const intervals = swathIntervals(entry, meanAltitudeKm(satrec));
  if (!intervals) return { status: 'unsupported_model', passes: [] };
  const reachKm = Math.max(...intervals.flat().map(Math.abs));
  const { windows, closest } = coarseScan(satrec, roi, startMs, endMs, reachKm, opts);
  const passes = [];
  for (const w of windows) {
    const p = refineWindow(entry, satrec, tle, roi, w, intervals, opts);
    if (p) passes.push(p);
  }
  // Refine the overall closest approach (geodesic, 1 s) around the best coarse sample.
  let best = { km: closest.km, t: closest.t, side: null };
  if (closest.t !== null) {
    for (let t = closest.t - opts.coarseStepS * 1000; t <= closest.t + opts.coarseStepS * 1000; t += 1000) {
      const s = subPoint(satrec, t);
      if (!s) continue;
      const g = geoInverse(s.lat, s.lon, roi.anchor.lat, roi.anchor.lon);
      if (g.km <= best.km) best = { km: g.km, t, side: Math.sin(g.azi1 / DEG) >= 0 ? 'E' : 'W' };
    }
  }
  return {
    status: 'ok', passes, closest_km: best.km, closest_utc: best.t, closest_side: best.side, reach_km: reachKm,
  };
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
