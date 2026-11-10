/**
 * tiles.js: Sentinel-2 MGRS tile identifiers and Sentinel-1 relative orbits.
 *
 * Inputs:  ROI geometry (lon/lat); predicted passes; past Sentinel-1
 *          acquisitions from STAC (platform, orbit direction, time, relative orbit).
 * Outputs: S2 tile ids ("29SNB") covering the ROI sample points; the relative
 *          orbit of a predicted Sentinel-1 pass.
 *
 * Method:
 * - S2 tiles follow the MGRS 100 km grid (proj4js mgrs module). Tiles are
 *   listed for the ROI anchor and every polygon vertex.
 * - A Sentinel-1 satellite repeats its ground track every 12 days (175
 *   orbits). A predicted pass inherits the relative orbit of a past STAC
 *   acquisition by the same satellite, in the same direction, whose time lies
 *   a whole number of 12-day cycles earlier (within 5 minutes).
 *
 * Limitations: S2 tiles overlap by about 10 km, so a point near a tile edge
 * also lies in the neighbouring tile, which is not listed. The relative orbit
 * is unknown when STAC has no matching acquisition in its search window, or
 * after an orbit change. Landsat WRS-2 path/row is not computed (v2).
 */

import proj4 from '../vendor/proj4.js';
import { polygonsOf, roiAnchor } from './geometry.js';

/** S2 tile id ("29SNB") of a lon/lat point, or null outside the MGRS domain (|lat| > 84°). */
export function s2Tile(lon, lat) {
  if (Math.abs(lat) > 84) return null;
  const m = proj4.mgrs.forward([lon, lat], 0).match(/^(\d{1,2})([C-X])([A-Z]{2})/);
  return m ? `${m[1].padStart(2, '0')}${m[2]}${m[3]}` : null;
}

/** Unique S2 tiles for the ROI anchor and polygon vertices. */
export function s2TilesForRoi(geom) {
  const a = roiAnchor(geom);
  const pts = [[a.lon, a.lat]];
  for (const poly of polygonsOf(geom)) for (const ring of poly) for (const v of ring) pts.push(v);
  const out = new Set();
  for (const [lon, lat] of pts) {
    const t = s2Tile(lon, lat);
    if (t) out.add(t);
  }
  return [...out];
}

const CYCLE = 12 * 86400000;

/**
 * Relative orbit for a predicted Sentinel-1 pass from past acquisitions.
 * @param {{platform: string, direction: string, closest_utc: number}} pass  platform e.g. "Sentinel-1C"
 * @param {Array<{platform: string, orbit_state: string, datetime: number, rel_orbit: number}>} acquisitions
 */
export function s1RelativeOrbit(pass, acquisitions) {
  const plat = pass.platform.toLowerCase();
  let best = null;
  for (const a of acquisitions) {
    if (a.platform !== plat || a.orbit_state !== pass.direction || !a.rel_orbit) continue;
    const dt = pass.closest_utc - a.datetime;
    const n = Math.round(dt / CYCLE);
    const off = Math.abs(dt - n * CYCLE);
    if (off < 5 * 60000 && (!best || off < best.off)) best = { off, rel: a.rel_orbit };
  }
  return best ? best.rel : null;
}
