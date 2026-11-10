/**
 * stac.js: real past acquisitions over the ROI from public STAC APIs.
 *
 * Inputs:  ROI geometry, a time range (ms UTC).
 * Outputs: a list of acquisitions {collection, platform, datetime (ms), id,
 *          cloud (%), tile, path_row, rel_orbit, orbit_state, mode, url},
 *          newest first, and per-source errors.
 *
 * Sources (no key, CORS enabled; checked 2026-11-10):
 * - Earth Search (Element 84), https://earth-search.aws.element84.com/v1:
 *   sentinel-2-l2a, landsat-c2-l2.
 * - Copernicus Data Space Ecosystem, https://stac.dataspace.copernicus.eu/v1:
 *   sentinel-1-grd.
 *
 * Limitations: catalogues lag acquisition by hours to days; L2A/L2 products
 * exist only where processed (Landsat L2 is not produced for every scene).
 * Polygon ROIs are searched with their bounding box. At most 300 items per
 * collection are read.
 */

import { polygonsOf, roiAnchor } from './geometry.js';

const SOURCES = [
  { key: 's2', base: 'https://earth-search.aws.element84.com/v1', collection: 'sentinel-2-l2a' },
  { key: 'landsat', base: 'https://earth-search.aws.element84.com/v1', collection: 'landsat-c2-l2' },
  { key: 's1', base: 'https://stac.dataspace.copernicus.eu/v1', collection: 'sentinel-1-grd' },
];
const PAGE = 100;
const MAX_PAGES = 3;

function spatialParams(geom) {
  if (geom.type === 'Point') return { intersects: JSON.stringify({ type: 'Point', coordinates: geom.coordinates.map((v) => +v.toFixed(5)) }) };
  const pts = polygonsOf(geom).flat(2);
  const lons = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  return { bbox: [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].map((v) => v.toFixed(4)).join(',') };
}

/** Normalise one STAC item to the fields shown in the UI. */
export function normaliseItem(item, collection) {
  const p = item.properties ?? {};
  const self = (item.links ?? []).find((l) => l.rel === 'self')?.href ?? null;
  const tile = p['grid:code']?.replace(/^MGRS-/, '') ?? (p['mgrs:utm_zone'] ? `${String(p['mgrs:utm_zone']).padStart(2, '0')}${p['mgrs:latitude_band']}${p['mgrs:grid_square']}` : null);
  const pathRow = p['landsat:wrs_path'] ? `${p['landsat:wrs_path']}/${p['landsat:wrs_row']}` : null;
  return {
    collection,
    id: item.id,
    platform: String(p.platform ?? '').toLowerCase(),
    datetime: Date.parse(p.datetime ?? p.start_datetime),
    cloud: typeof p['eo:cloud_cover'] === 'number' ? p['eo:cloud_cover'] : null,
    tile,
    path_row: pathRow,
    rel_orbit: p['sat:relative_orbit'] ?? null,
    orbit_state: p['sat:orbit_state'] ?? null,
    mode: p['sar:instrument_mode'] ?? null,
    url: self,
  };
}

async function searchOne(src, geom, startMs, endMs, fetchImpl) {
  const params = new URLSearchParams({
    collections: src.collection,
    datetime: `${new Date(startMs).toISOString()}/${new Date(endMs).toISOString()}`,
    limit: String(PAGE),
    ...spatialParams(geom),
  });
  let url = `${src.base}/search?${params}`;
  const out = [];
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const res = await fetchImpl(url, { headers: { Accept: 'application/geo+json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const fc = await res.json();
    for (const f of fc.features ?? []) out.push(normaliseItem(f, src.collection));
    const next = (fc.links ?? []).find((l) => l.rel === 'next' && (!l.method || l.method === 'GET'));
    url = next?.href ?? null;
  }
  return out;
}

/** Search all sources; never throws. Returns { items, errors: {key: message} }. */
export async function searchAcquisitions(geom, startMs, endMs, fetchImpl = fetch) {
  const results = await Promise.allSettled(SOURCES.map((s) => searchOne(s, geom, startMs, endMs, fetchImpl)));
  const items = [];
  const errors = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value);
    else errors[SOURCES[i].key] = String(r.reason?.message ?? r.reason);
  });
  // One row per platform pass: S2 tiles and S1 slices of the same pass share a minute.
  items.sort((a, b) => b.datetime - a.datetime);
  return { items, errors, anchor: roiAnchor(geom) };
}

/** Group items of the same platform within 2 minutes (several tiles or slices of one pass). */
export function groupByPass(items) {
  const groups = [];
  for (const it of items) {
    const g = groups.find((x) => x.platform === it.platform && Math.abs(x.datetime - it.datetime) < 120000);
    if (g) {
      g.items.push(it);
      if (it.tile && !g.tiles.includes(it.tile)) g.tiles.push(it.tile);
      if (it.cloud != null) g.cloud = g.cloud == null ? it.cloud : Math.min(g.cloud, it.cloud);
    } else {
      groups.push({ platform: it.platform, collection: it.collection, datetime: it.datetime, items: [it], tiles: it.tile ? [it.tile] : [], cloud: it.cloud, rel_orbit: it.rel_orbit, orbit_state: it.orbit_state, mode: it.mode, path_row: it.path_row, url: it.url });
    }
  }
  return groups;
}
