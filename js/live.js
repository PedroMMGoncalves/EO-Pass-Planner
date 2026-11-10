/**
 * live.js: satellite positions, ground tracks and instantaneous swaths at a
 * given (simulated) time, for display on the globe.
 *
 * Inputs:  catalogue entries, TLE records, a time in ms UTC.
 * Outputs: GeoJSON-ready objects: positions, past/future ground tracks
 *          (longitudes unwrapped so lines do not jump across the antimeridian),
 *          recent swath strips while imaging conditions hold at the
 *          sub-satellite point, and the night-side polygon.
 *
 * Limitations: for display only. The swath is drawn while the sun is above
 * the horizon at the sub-satellite point and the pass direction matches the
 * entry's pass filter. This approximates "sensor on"; the real acquisition
 * depends on the mission plan. Pass computations use engine.js.
 */

import * as sat from '../vendor/satellite.js';
import { scanLine, geoInverse, wrap180 } from './geometry.js';
import { swathIntervals, meanAltitudeKm, satrecFrom } from './engine.js';
import { solarElevation, subsolarPoint } from './sun.js';

const DEG = 180 / Math.PI;
const MIN = 60000;

export const TRACK_PAST_MIN = 45;
export const TRACK_FUTURE_MIN = 90;
const TRACK_STEP_MS = 30000;
const SWATH_HISTORY_MS = 4 * MIN;
const SWATH_STEP_MS = 15000;

/**
 * Prepare satrecs once. Entries without a TLE are skipped. Live swaths are
 * drawn only for systematic/partial acquisition (not for tasked corridors,
 * lidar beams, track proximity or geostationary imagers).
 */
export function makeTrackers(entries, tles) {
  return entries.flatMap((e) => {
    const tle = tles[String(e.norad_id)];
    if (!tle) return [];
    const satrec = satrecFrom(tle);
    const live = ['nadir_symmetric', 'side_looking'].includes(e.swath.model) && e.acquisition !== 'tasked';
    return [{ entry: e, satrec, intervals: live ? swathIntervals(e, meanAltitudeKm(satrec)) : null }];
  });
}

function sub(satrec, ms) {
  const d = new Date(ms);
  const pv = sat.propagate(satrec, d);
  if (!pv || !pv.position || Number.isNaN(pv.position.x)) return null;
  const g = sat.eciToGeodetic(pv.position, sat.gstime(d));
  return { lat: g.latitude * DEG, lon: wrap180(g.longitude * DEG), height: g.height };
}

/** Unwrap longitudes of [lon, lat] points so consecutive points never differ by > 180°. */
function unwrap(points) {
  let prev = null;
  return points.map(([lon, lat]) => {
    let x = lon;
    if (prev !== null) {
      while (x - prev > 180) x -= 360;
      while (x - prev < -180) x += 360;
    }
    prev = x;
    return [x, lat];
  });
}

/** Current positions with heading and imaging state. */
export function positions(trackers, ms) {
  return trackers.flatMap((tr) => {
    const a = sub(tr.satrec, ms);
    const b = sub(tr.satrec, ms + 1000);
    if (!a || !b) return [];
    const heading = geoInverse(a.lat, a.lon, b.lat, b.lon).azi1;
    return [{ tr, ...a, heading, imaging: isImaging(tr.entry, a, b, ms) }];
  });
}

function isImaging(entry, a, b, ms) {
  const day = solarElevation(ms, a.lat, a.lon) > 0;
  const desc = b.lat < a.lat;
  switch (entry.pass_filter) {
    case 'day_descending': return day && desc;
    case 'day_ascending': return day && !desc;
    case 'day_any': return day;
    case 'night_any': return !day;
    default: return true;
  }
}

/** Past and future ground tracks as GeoJSON features. */
export function tracks(trackers, ms) {
  const feats = [];
  for (const tr of trackers) {
    const past = [];
    const future = [];
    for (let t = ms - TRACK_PAST_MIN * MIN; t <= ms + TRACK_FUTURE_MIN * MIN; t += TRACK_STEP_MS) {
      const s = sub(tr.satrec, t);
      if (!s) continue;
      (t <= ms ? past : future).push([s.lon, s.lat]);
    }
    const now = sub(tr.satrec, ms);
    if (now) { past.push([now.lon, now.lat]); future.unshift([now.lon, now.lat]); }
    const props = { id: tr.entry.id };
    if (past.length > 1) feats.push({ type: 'Feature', properties: { ...props, when: 'past' }, geometry: { type: 'LineString', coordinates: unwrap(past) } });
    if (future.length > 1) feats.push({ type: 'Feature', properties: { ...props, when: 'future' }, geometry: { type: 'LineString', coordinates: unwrap(future) } });
  }
  return { type: 'FeatureCollection', features: feats };
}

/** Swath strips over the last few minutes, only while imaging conditions hold. */
export function liveSwaths(trackers, ms) {
  const feats = [];
  for (const tr of trackers) {
    if (!tr.intervals) continue;
    let run = [];
    const flush = () => {
      if (run.length > 1) {
        for (let j = 0; j < tr.intervals.length; j++) {
          const left = run.map((l) => [l[j].left.lon, l[j].left.lat]);
          const right = run.map((l) => [l[j].right.lon, l[j].right.lat]).reverse();
          const ring = unwrap([...left, ...right]);
          ring.push(ring[0]);
          feats.push({ type: 'Feature', properties: { id: tr.entry.id }, geometry: { type: 'Polygon', coordinates: [ring] } });
        }
      }
      run = [];
    };
    for (let t = ms - SWATH_HISTORY_MS; t <= ms; t += SWATH_STEP_MS) {
      const a = sub(tr.satrec, t);
      const b = sub(tr.satrec, t + 1000);
      if (!a || !b || !isImaging(tr.entry, a, b, t)) { flush(); continue; }
      const h = geoInverse(a.lat, a.lon, b.lat, b.lon).azi1;
      run.push(tr.intervals.map((iv) => scanLine(a, h, iv)));
    }
    flush();
  }
  return { type: 'FeatureCollection', features: feats };
}

/** Night-side polygon (sun below the geometric horizon). */
export function nightPolygon(ms) {
  const s = subsolarPoint(ms);
  const dec = s.lat / DEG;
  const pts = [];
  for (let lon = -180; lon <= 180; lon += 2) {
    const h = (lon - s.lon) / DEG;
    // Terminator latitude: tan(lat) = -cos(H) / tan(dec)
    const lat = Math.atan(-Math.cos(h) / Math.tan(Math.abs(dec) < 1e-6 ? 1e-6 : dec)) * DEG;
    pts.push([lon, lat]);
  }
  const pole = dec > 0 ? -90 : 90; // the night side contains the pole opposite the declination
  const ring = [...pts, [180, pole], [-180, pole], pts[0]];
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }] };
}
