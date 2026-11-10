/**
 * cmr.js: past ICESat-2 tracks over the ROI from NASA CMR, and the reference
 * ground track (RGT) of predicted ICESat-2 passes.
 *
 * Inputs:  ROI geometry; a time range; predicted passes.
 * Outputs: granules [{id, rgt, cycle, segment, time (ms), url}] of ATL08
 *          (land and vegetation height) intersecting the ROI's bounding box;
 *          the RGT number of a predicted pass.
 *
 * Source: NASA Common Metadata Repository, public search API with CORS
 * (https://cmr.earthdata.nasa.gov/search, checked 2026-11-10). Granule names
 * encode the RGT, cycle and segment: ATL08_YYYYMMDDhhmmss_RRRRCCSS_VVV_RR.h5.
 *
 * Method: ICESat-2 repeats its 1387 reference ground tracks every 91 days; a
 * predicted pass inherits the RGT of a past granule a whole number of
 * 91-day cycles earlier. Granule start times are segment starts (segments
 * last about 1/14 of an orbit), so the match tolerance is 15 minutes.
 *
 * Limitations: granules are searched by bounding box, so some pass near but
 * not over a point ROI; downloading data needs a (free) Earthdata login; the
 * beams may be pointed off the RGT, which the TLE-based prediction ignores.
 */

import { polygonsOf, roiAnchor } from './geometry.js';

const CMR = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const CYCLE = 91 * 86400000;

function bbox(geom) {
  if (geom.type === 'Point') {
    const [lon, lat] = geom.coordinates;
    return [lon - 0.05, lat - 0.05, lon + 0.05, lat + 0.05];
  }
  const pts = polygonsOf(geom).flat(2);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** Parse "ATL08_20260829104504_11673206_007_01.h5". */
export function parseGranule(name) {
  const m = name.match(/^ATL\d\d_(\d{14})_(\d{4})(\d{2})(\d{2})_/);
  if (!m) return null;
  return { rgt: Number(m[2]), cycle: Number(m[3]), segment: Number(m[4]) };
}

/** Search ATL08 granules over the ROI; never throws. */
export async function searchIcesat2(geom, fromMs, toMs, fetchImpl = fetch) {
  const params = new URLSearchParams({
    short_name: 'ATL08',
    bounding_box: bbox(geom).map((v) => v.toFixed(4)).join(','),
    temporal: `${new Date(fromMs).toISOString()},${new Date(toMs).toISOString()}`,
    page_size: '200',
    sort_key: '-start_date',
  });
  try {
    const res = await fetchImpl(`${CMR}?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = (await res.json()).feed?.entry ?? [];
    const out = [];
    const seen = new Set();
    for (const e of entries) {
      const name = e.producer_granule_id ?? e.title ?? '';
      const g = parseGranule(name);
      if (!g) continue;
      const key = `${g.rgt}_${g.cycle}`;
      if (seen.has(key)) continue; // several product versions of the same track
      seen.add(key);
      const link = (e.links ?? []).find((l) => /data#/.test(l.rel ?? ''))?.href ?? null;
      out.push({ id: name, ...g, time: Date.parse(e.time_start), url: link });
    }
    return { granules: out, error: null, anchor: roiAnchor(geom) };
  } catch (err) {
    return { granules: [], error: String(err.message ?? err) };
  }
}

/** RGT of a predicted ICESat-2 pass from past granules (whole 91-day cycles earlier, ±15 min). */
export function icesat2Rgt(pass, granules) {
  let best = null;
  for (const g of granules) {
    const dt = pass.closest_utc - g.time;
    const n = Math.round(dt / CYCLE);
    if (n < 1) continue;
    const off = Math.abs(dt - n * CYCLE);
    if (off < 15 * 60000 && (!best || off < best.off)) best = { off, rgt: g.rgt };
  }
  return best ? best.rgt : null;
}
