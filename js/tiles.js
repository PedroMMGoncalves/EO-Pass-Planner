/**
 * tiles.js: Sentinel-2 MGRS tile identifiers, Sentinel-1 relative orbits and
 * Landsat WRS-2 path/row.
 *
 * Inputs:  ROI geometry (lon/lat); predicted passes; past Sentinel-1
 *          acquisitions from STAC (platform, orbit direction, time, relative orbit).
 * Outputs: S2 tile ids ("29SNB") covering the ROI sample points; the relative
 *          orbit of a predicted Sentinel-1 pass; the WRS-2 path/row of a
 *          predicted Landsat pass.
 *
 * Method:
 * - S2 tiles follow the MGRS 100 km grid (proj4js mgrs module). Tiles are
 *   listed for the ROI anchor and every polygon vertex.
 * - A Sentinel-1 satellite repeats its ground track every 12 days (175
 *   orbits). A predicted pass inherits the relative orbit of a past STAC
 *   acquisition by the same satellite, in the same direction, whose time lies
 *   a whole number of 12-day cycles earlier (within 5 minutes).
 * - Landsat 8 and 9 share the WRS-2 grid (233 paths, 16-day repeat each, 8
 *   days apart): a predicted pass inherits the path/row of past STAC scenes
 *   a whole number of 8 days earlier (within 5 minutes).
 *
 * Limitations: S2 tiles overlap by about 10 km, so a point near a tile edge
 * also lies in the neighbouring tile, which is not listed. The relative orbit
 * is unknown when STAC has no matching acquisition in its search window, or
 * after an orbit change. Path/row needs a Landsat scene over the ROI in the
 * STAC window (Landsat L2 products appear days after acquisition).
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

const LANDSAT_OFFSET = 8 * 86400000; // Landsat 8 and 9 share the WRS-2 grid, 8 days apart

/**
 * WRS-2 path/row of a predicted Landsat pass from past STAC scenes: the pass
 * inherits path and rows of scenes (Landsat 8 or 9) whose time lies a whole
 * number of 8-day offsets earlier, within 5 minutes.
 * @returns {string|null} e.g. "203/033" or "203/033-034"
 */
export function landsatPathRow(pass, items) {
  if (!/^Landsat/.test(pass.platform)) return null;
  const scenes = items.filter((a) => /^landsat-\d/.test(a.platform) && a.path_row);
  let best = null;
  for (const a of scenes) {
    const dt = pass.closest_utc - a.datetime;
    const n = Math.round(dt / LANDSAT_OFFSET);
    const off = Math.abs(dt - n * LANDSAT_OFFSET);
    if (n >= 1 && off < 5 * 60000 && (!best || off < best.off)) best = { off, a };
  }
  if (!best) return null;
  const same = scenes.filter((s) => s.platform === best.a.platform && Math.abs(s.datetime - best.a.datetime) < 180000);
  const path = best.a.path_row.split('/')[0];
  const rows = [...new Set(same.filter((s) => s.path_row.startsWith(`${path}/`)).map((s) => s.path_row.split('/')[1]))].sort();
  return rows.length > 1 ? `${path}/${rows[0]}-${rows[rows.length - 1]}` : `${path}/${rows[0]}`;
}
