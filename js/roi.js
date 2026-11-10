/**
 * roi.js: region-of-interest input and encoding.
 *
 * Inputs:  typed coordinates in a chosen CRS; GeoJSON, KML, KMZ or zipped
 *          Shapefile files; polygons drawn on the globe; URL hash strings.
 * Outputs: a GeoJSON geometry (Point, Polygon or MultiPolygon, lon/lat WGS84)
 *          plus warnings; simplified and buffered versions; a compact URL
 *          encoding (polyline algorithm, 1e-5° precision).
 *
 * Limitations:
 * - Multi-feature files are dissolved (planar union in lon/lat). Lines are
 *   ignored; if a file holds only points, the first point is used.
 * - The buffer is built in an ROI-centred LAEA projection (polygon ∪ edge
 *   rectangles ∪ vertex circles), accurate to well under 1 % for buffers of
 *   tens of km.
 * - Simplification (Douglas-Peucker in LAEA) is applied before computation
 *   when an ROI has many vertices; the change in area is reported.
 * - The URL stores the outer and inner rings at 1e-5° (about 1 m).
 */

import proj4 from '../vendor/proj4.js';
import polygonClipping from '../vendor/polygon-clipping.js';
import {
  laea, roiAnchor, polygonsOf, multiPolygonArea, geoDirect,
} from './geometry.js';

// ---------- coordinate reference systems ----------

export const CRS = {
  'EPSG:4326': { label: 'WGS 84 (lat, lon em graus)', def: null, latFirst: true },
  'EPSG:3763': { label: 'ETRS89 / PT-TM06 (EPSG:3763)', def: '+proj=tmerc +lat_0=39.6682583333333 +lon_0=-8.13310833333333 +k=1 +x_0=0 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs' },
  'EPSG:32629': { label: 'WGS 84 / UTM 29N (Portugal continental)', def: '+proj=utm +zone=29 +datum=WGS84 +units=m +no_defs' },
  'EPSG:32628': { label: 'WGS 84 / UTM 28N (Madeira, Cabo Verde)', def: '+proj=utm +zone=28 +datum=WGS84 +units=m +no_defs' },
  'EPSG:32632': { label: 'WGS 84 / UTM 32N (São Tomé)', def: '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs' },
  'EPSG:32736': { label: 'WGS 84 / UTM 36S (Moçambique)', def: '+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs' },
  'EPSG:32737': { label: 'WGS 84 / UTM 37S (Moçambique)', def: '+proj=utm +zone=37 +south +datum=WGS84 +units=m +no_defs' },
  custom: { label: 'Outro (proj4)', def: null },
};

export class RoiError extends Error {}

/**
 * Parse typed coordinates: one pair per line, separated by spaces, commas or
 * semicolons. EPSG:4326 expects "lat, lon"; projected CRS expect "E N".
 * One pair → Point; three or more → Polygon (closed automatically).
 */
export function parseCoordinates(text, crsKey = 'EPSG:4326', customDef = '') {
  const crs = CRS[crsKey];
  if (!crs) throw new RoiError(`unknown CRS ${crsKey}`);
  const def = crsKey === 'custom' ? customDef.trim() : crs.def;
  if (crsKey === 'custom' && !def) throw new RoiError('custom_crs_missing');
  let toLonLat;
  try {
    toLonLat = def ? proj4(def, 'EPSG:4326').forward : null;
  } catch {
    throw new RoiError('custom_crs_bad');
  }
  const pts = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const nums = splitPair(line);
    if (nums.length !== 2 || nums.some((n) => !Number.isFinite(n))) throw new RoiError('coords_bad');
    const [lon, lat] = crs.latFirst ? [nums[1], nums[0]] : toLonLat([nums[0], nums[1]]);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new RoiError('coords_bad');
    pts.push([lon, lat]);
  }
  if (pts.length === 0) throw new RoiError('coords_bad');
  if (pts.length === 1) return { type: 'Point', coordinates: pts[0] };
  if (pts.length < 3) throw new RoiError('coords_two');
  const ring = closeRing(pts);
  return { type: 'Polygon', coordinates: [orientRing(ring, true)] };
}

/**
 * Split one coordinate pair. "a, b" and "a b" use a decimal point; with a
 * semicolon or whitespace separator, a decimal comma is also accepted
 * ("37,57; -7,97" or "37,57 -7,97").
 */
function splitPair(line) {
  let parts;
  if (line.includes(';')) parts = line.split(';');
  else if (/\s/.test(line.replace(/,\s+/g, ','))) parts = line.replace(/,\s+/g, ',').split(/\s+/);
  else parts = line.split(',');
  parts = parts.map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 2) return [];
  return parts.map((s) => Number(s.replace(',', '.')));
}

function closeRing(pts) {
  const r = pts.slice();
  const [a, b] = [r[0], r[r.length - 1]];
  if (a[0] !== b[0] || a[1] !== b[1]) r.push([a[0], a[1]]);
  return r;
}

function signedArea(ring) {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return s / 2;
}

/** Counter-clockwise for outer rings (RFC 7946), clockwise for holes. */
function orientRing(ring, outer) {
  const ccw = signedArea(ring) > 0;
  return ccw === outer ? ring : ring.slice().reverse();
}

// ---------- GeoJSON normalisation and files ----------

/**
 * Reduce any GeoJSON (FeatureCollection, Feature or geometry) to one ROI
 * geometry. Returns { geom, warnings: [key, ...] }.
 */
export function normaliseGeoJSON(gj) {
  const geoms = [];
  const collect = (g) => {
    if (!g) return;
    if (g.type === 'FeatureCollection') g.features.forEach((f) => collect(f.geometry));
    else if (g.type === 'Feature') collect(g.geometry);
    else if (g.type === 'GeometryCollection') g.geometries.forEach(collect);
    else geoms.push(g);
  };
  collect(gj);
  const warnings = [];
  const polys = [];
  const points = [];
  let lines = 0;
  for (const g of geoms) {
    if (g.type === 'Polygon') polys.push(g.coordinates.map((r) => r.map((p) => [p[0], p[1]])));
    else if (g.type === 'MultiPolygon') g.coordinates.forEach((pc) => polys.push(pc.map((r) => r.map((p) => [p[0], p[1]]))));
    else if (g.type === 'Point') points.push([g.coordinates[0], g.coordinates[1]]);
    else if (g.type === 'MultiPoint') g.coordinates.forEach((p) => points.push([p[0], p[1]]));
    else lines++;
  }
  if (lines) warnings.push('file_lines_ignored');
  if (polys.length) {
    if (points.length) warnings.push('file_points_ignored');
    if (polys.length > 1) warnings.push('file_dissolved');
    const u = polys.length > 1 ? polygonClipping.union(...polys.map((p) => [p])) : [polys[0]];
    const mp = u.map((poly) => poly.map((r, i) => orientRing(closeRing(r), i === 0)));
    return { geom: mp.length === 1 ? { type: 'Polygon', coordinates: mp[0] } : { type: 'MultiPolygon', coordinates: mp }, warnings };
  }
  if (points.length) {
    if (points.length > 1) warnings.push('file_first_point');
    return { geom: { type: 'Point', coordinates: points[0] }, warnings };
  }
  throw new RoiError('file_empty');
}

const loadFormats = () => import('../vendor/fileformats.js');

/** Read an ROI from a File (GeoJSON, KML, KMZ, zipped Shapefile). */
export async function readRoiFile(file) {
  const name = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  return readRoiBytes(name, bytes);
}

export async function readRoiBytes(name, bytes) {
  const text = () => new TextDecoder().decode(bytes);
  if (name.endsWith('.geojson') || name.endsWith('.json')) return normaliseGeoJSON(JSON.parse(text()));
  const fmt = await loadFormats();
  const kmlToGeoJSON = (str) => fmt.kml(new DOMParser().parseFromString(str, 'text/xml'));
  if (name.endsWith('.kml')) return normaliseGeoJSON(kmlToGeoJSON(text()));
  if (name.endsWith('.kmz')) {
    for (const entry of fmt.unzip(bytes)) {
      if (entry.filename.toLowerCase().endsWith('.kml')) {
        const data = await entry.read();
        return normaliseGeoJSON(kmlToGeoJSON(new TextDecoder().decode(data)));
      }
    }
    throw new RoiError('file_empty');
  }
  if (name.endsWith('.zip')) {
    const gj = await fmt.shp(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return normaliseGeoJSON(Array.isArray(gj) ? { type: 'FeatureCollection', features: gj.flatMap((c) => c.features) } : gj);
  }
  throw new RoiError('file_type');
}

// ---------- simplification and buffer ----------

/** Douglas-Peucker on a closed ring: split at the vertex farthest from the first one. */
function dpRing(ring, tol) {
  if (ring.length <= 5) return ring;
  let k = 1;
  let dk = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (d > dk) { dk = d; k = i; }
  }
  const a = dpLine(ring.slice(0, k + 1), tol);
  const b = dpLine(ring.slice(k), tol);
  const out = [...a, ...b.slice(1)];
  return out.length >= 4 ? out : ring;
}

function dpLine(pts, tol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [x1, y1] = pts[a];
    const [x2, y2] = pts[b];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1e-12;
    let best = -1;
    let dmax = 0;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / len;
      if (d > dmax) { dmax = d; best = i; }
    }
    if (dmax > tol && best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const vertexCount = (geom) => polygonsOf(geom).reduce((n, p) => n + p.reduce((m, r) => m + r.length, 0), 0);

/**
 * Simplify a polygon ROI to at most `maxVertices` (Douglas-Peucker in LAEA).
 * Returns { geom, simplified, areaChangePct }.
 */
export function simplifyRoi(geom, maxVertices = 300) {
  if (geom.type === 'Point' || vertexCount(geom) <= maxVertices) return { geom, simplified: false, areaChangePct: 0 };
  const a = roiAnchor(geom);
  const p = laea(a.lat, a.lon);
  const proj = polygonsOf(geom).map((poly) => poly.map((r) => r.map((v) => p.fwd(v))));
  const area0 = multiPolygonArea(proj);
  let tol = Math.sqrt(area0) / 1000;
  let out = proj;
  for (let k = 0; k < 30; k++) {
    out = proj.map((poly) => poly.map((r) => dpRing(r, tol)));
    if (out.reduce((n, poly) => n + poly.reduce((m, r) => m + r.length, 0), 0) <= maxVertices) break;
    tol *= 1.6;
  }
  const back = out.map((poly) => poly.map((r) => r.map((v) => p.inv(v))));
  const g = back.length === 1 ? { type: 'Polygon', coordinates: back[0] } : { type: 'MultiPolygon', coordinates: back };
  return { geom: g, simplified: true, areaChangePct: (100 * (multiPolygonArea(out) - area0)) / area0 };
}

/** Geodesic circle polygon (lon/lat) of radius `km` around (lat, lon). */
export function circle(lat, lon, km, n = 64) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const q = geoDirect(lat, lon, (360 * i) / n, km);
    ring.push([q.lon, q.lat]);
  }
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [orientRing(ring, true)] };
}

/** Buffer an ROI outward by `km` (0 returns the input). */
export function bufferRoi(geom, km) {
  if (!(km > 0)) return geom;
  if (geom.type === 'Point') return circle(geom.coordinates[1], geom.coordinates[0], km);
  const a = roiAnchor(geom);
  const p = laea(a.lat, a.lon);
  const r = km * 1000;
  const parts = [];
  // Each edge becomes a "stadium" (the set of points within r of the segment),
  // so the union has n + 1 well-separated parts with no coincident vertices.
  // Coordinates are rounded to 1 cm; polygon-clipping is fragile with
  // near-coincident segments.
  const q = (v) => Math.round(v * 100) / 100;
  const stadium = ([x1, y1], [x2, y2]) => {
    const ang = Math.atan2(y2 - y1, x2 - x1);
    const ring = [];
    const n = 12;
    for (let i = 0; i <= n; i++) {
      const a = ang + Math.PI / 2 + (i * Math.PI) / n;
      ring.push([q(x1 + r * Math.cos(a)), q(y1 + r * Math.sin(a))]);
    }
    for (let i = 0; i <= n; i++) {
      const a = ang - Math.PI / 2 + (i * Math.PI) / n;
      ring.push([q(x2 + r * Math.cos(a)), q(y2 + r * Math.sin(a))]);
    }
    ring.push(ring[0]);
    return [ring];
  };
  const proj = polygonsOf(geom).map((poly) => poly.map((ring) => ring.map((v) => p.fwd(v).map(q))));
  for (const poly of proj) {
    parts.push(poly);
    for (const ring of poly) {
      for (let i = 0; i + 1 < ring.length; i++) {
        if (ring[i][0] === ring[i + 1][0] && ring[i][1] === ring[i + 1][1]) continue;
        parts.push(stadium(ring[i], ring[i + 1]));
      }
    }
  }
  const u = polygonClipping.union(...parts);
  // Holes smaller than the buffer disappear naturally; keep what remains.
  const back = u.map((poly) => poly.map((ring, i) => orientRing(ring.map((v) => p.inv(v)), i === 0)));
  return back.length === 1 ? { type: 'Polygon', coordinates: back[0] } : { type: 'MultiPolygon', coordinates: back };
}

// ---------- URL encoding ----------

function encodeSigned(v) {
  let x = v < 0 ? ~(v << 1) : v << 1;
  let s = '';
  while (x >= 0x20) { s += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
  return s + String.fromCharCode(x + 63);
}

/** Polyline-encode [lon, lat] points (precision 1e-5°). */
export function encodePolyline(points) {
  let plat = 0;
  let plon = 0;
  let s = '';
  for (const [lon, lat] of points) {
    const la = Math.round(lat * 1e5);
    const lo = Math.round(lon * 1e5);
    s += encodeSigned(la - plat) + encodeSigned(lo - plon);
    plat = la; plon = lo;
  }
  return s;
}

export function decodePolyline(str) {
  const pts = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let shift = 0;
    let result = 0;
    let b;
    do {
      if (i >= str.length) throw new RoiError('hash_bad');
      b = str.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    pts.push([lon / 1e5, lat / 1e5]);
  }
  return pts;
}

/** Encode an ROI geometry for the URL: "p:lat,lon" or "g:" + polygons ("!") of rings ("."). */
export function encodeRoi(geom) {
  if (geom.type === 'Point') return `p:${geom.coordinates[1].toFixed(5)},${geom.coordinates[0].toFixed(5)}`;
  return `g:${polygonsOf(geom).map((poly) => poly.map((r) => encodePolyline(r.slice(0, -1))).join('.')).join('!')}`;
}

export function decodeRoi(s) {
  if (s.startsWith('p:')) {
    const [lat, lon] = s.slice(2).split(',').map(Number);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new RoiError('hash_bad');
    return { type: 'Point', coordinates: [lon, lat] };
  }
  if (s.startsWith('g:')) {
    const polys = s.slice(2).split('!').map((poly) => poly.split('.').map((r) => closeRing(decodePolyline(r))));
    if (polys.some((poly) => poly.some((r) => r.length < 4))) throw new RoiError('hash_bad');
    return polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys };
  }
  throw new RoiError('hash_bad');
}

/** Read query state from a location hash ("#roi=...&d=16..."). */
export function parseHash(hash) {
  const q = new URLSearchParams(hash.replace(/^#/, ''));
  const out = {};
  if (q.get('roi')) out.roi = decodeRoi(q.get('roi'));
  if (q.get('b')) out.buffer = Number(q.get('b'));
  if (q.get('s')) out.start = q.get('s');
  if (q.get('d')) out.days = Number(q.get('d'));
  if (q.get('i')) out.ids = q.get('i').split(',');
  if (q.get('t')) out.transitional = q.get('t') === '1';
  if (q.get('l')) out.lang = q.get('l');
  if (q.get('p')) out.pass = q.get('p');
  return out;
}

export function buildHash(s) {
  const q = new URLSearchParams();
  if (s.roi) q.set('roi', encodeRoi(s.roi));
  if (s.buffer > 0) q.set('b', String(s.buffer));
  if (s.start) q.set('s', s.start);
  if (s.days) q.set('d', String(s.days));
  if (s.ids) q.set('i', s.ids.join(','));
  if (s.transitional) q.set('t', '1');
  if (s.lang && s.lang !== 'pt') q.set('l', s.lang);
  if (s.pass) q.set('p', s.pass);
  return `#${q.toString()}`;
}

// ---------- drawing on the globe ----------

/**
 * Polygon / rectangle drawing on a MapLibre map.
 * `globe.setDraft(fc)` displays the sketch; `onDone(geom)` receives the result.
 * Polygon: click to add vertices; double-click, Enter or a click on the first
 * vertex closes it. Rectangle: two clicks on opposite corners. Esc cancels.
 */
export function createDrawer(globe, { onDone, onChange }) {
  const map = globe.map;
  let mode = null;
  let pts = [];
  let cursor = null;

  const lngLat = (ev) => [ev.lngLat.lng, ev.lngLat.lat];
  const rectFrom = (a, b) => [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]], [a[0], a[1]]];

  function render() {
    const feats = [];
    if (mode === 'polygon' && pts.length) {
      const line = cursor ? [...pts, cursor] : pts;
      if (line.length > 1) feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: line } });
      pts.forEach((p) => feats.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } }));
    }
    if (mode === 'rectangle' && pts.length === 1 && cursor) {
      feats.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: rectFrom(pts[0], cursor) } });
    }
    globe.setDraft({ type: 'FeatureCollection', features: feats });
    onChange?.({ mode, n: pts.length });
  }

  function finish() {
    let geom = null;
    if (mode === 'polygon' && pts.length >= 3) geom = { type: 'Polygon', coordinates: [orientRing(closeRing(pts), true)] };
    if (mode === 'rectangle' && pts.length === 2) geom = { type: 'Polygon', coordinates: [orientRing(rectFrom(pts[0], pts[1]), true)] };
    stop();
    if (geom) onDone(geom);
  }

  function near(a, b, px = 10) {
    const pa = map.project(a);
    const pb = map.project(b);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y) < px;
  }

  const onClick = (ev) => {
    const p = lngLat(ev);
    if (mode === 'polygon') {
      if (pts.length >= 3 && near(p, pts[0])) { finish(); return; }
      if (pts.length && near(p, pts[pts.length - 1], 4)) return; // double-click duplicate
      pts.push(p);
    } else if (mode === 'rectangle') {
      pts.push(p);
      if (pts.length === 2) { finish(); return; }
    }
    render();
  };
  const onMove = (ev) => { cursor = lngLat(ev); if (pts.length) render(); };
  const onDbl = (ev) => { ev.preventDefault(); if (mode === 'polygon') finish(); };
  const onKey = (ev) => {
    if (ev.key === 'Escape') stop();
    if (ev.key === 'Enter' && mode === 'polygon') finish();
    if (ev.key === 'Backspace' && mode === 'polygon' && pts.length) { pts.pop(); render(); }
  };

  function start(m) {
    stop();
    mode = m;
    pts = [];
    map.doubleClickZoom.disable();
    map.on('click', onClick);
    map.on('mousemove', onMove);
    map.on('dblclick', onDbl);
    window.addEventListener('keydown', onKey);
    render();
  }

  function stop() {
    if (!mode) return;
    map.off('click', onClick);
    map.off('mousemove', onMove);
    map.off('dblclick', onDbl);
    window.removeEventListener('keydown', onKey);
    setTimeout(() => map.doubleClickZoom.enable(), 0);
    mode = null;
    pts = [];
    cursor = null;
    globe.setDraft({ type: 'FeatureCollection', features: [] });
    onChange?.({ mode: null, n: 0 });
  }

  return { start, stop, finish, get active() { return mode !== null; }, get mode() { return mode; } };
}
