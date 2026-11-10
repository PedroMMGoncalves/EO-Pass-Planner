/**
 * geometry.js: geodesics, ROI-centred equal-area projection, swath strips,
 * clipping and area.
 *
 * Inputs:  ROI as a GeoJSON geometry (Point, Polygon or MultiPolygon, lon/lat
 *          WGS84); sub-satellite points and headings from the engine.
 * Outputs: projection functions, scan-line end points, strip polygons, areas
 *          (m²), coverage fractions, point-in-polygon tests.
 *
 * Method:
 * - Geodesics on the WGS84 ellipsoid (Karney, via geographiclib-geodesic).
 * - Intersections and areas are computed in a Lambert azimuthal equal-area
 *   projection centred on the ROI anchor, so planar areas are true areas.
 * - Consecutive scan lines are joined into one strip polygon (left edge
 *   forward, right edge backward), so there are no gaps between samples.
 *
 * Limitations:
 * - LAEA is equal-area but not conformal. Shapes far from the anchor
 *   (> ~2000 km) are distorted. Only geometry near the ROI is projected.
 * - The strip between two scan lines is a straight-edged quadrilateral in the
 *   projected plane. With 1 s sampling (~7 km along-track) the error is negligible.
 * - A strip whose edges self-intersect (very wide swaths turning sharply near
 *   the poles) is not handled specially.
 * - The ROI anchor is the planar lon/lat centroid when it lies inside the ROI,
 *   otherwise an interior point on the centroid's parallel.
 */

import proj4 from '../vendor/proj4.js';
import polygonClipping from '../vendor/polygon-clipping.js';
import { Geodesic } from '../vendor/geographiclib-geodesic.js';

const GEOD = Geodesic.WGS84;
export const EARTH_MEAN_RADIUS_KM = 6371.0088;
const RAD = Math.PI / 180;

// ---------- geodesics ----------

/** Point at distance `km` along azimuth `aziDeg` from (lat, lon). Returns {lat, lon}. */
export function geoDirect(lat, lon, aziDeg, km) {
  const r = GEOD.Direct(lat, lon, aziDeg, km * 1000);
  return { lat: r.lat2, lon: r.lon2 };
}

/** Geodesic distance (km) and forward azimuths (deg) from point 1 to point 2. */
export function geoInverse(lat1, lon1, lat2, lon2) {
  const r = GEOD.Inverse(lat1, lon1, lat2, lon2);
  return { km: r.s12 / 1000, azi1: r.azi1, azi2: r.azi2 };
}

/** Fast great-circle distance (km) on the mean sphere; for coarse screening only. */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD;
  const dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MEAN_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Normalise an angle to (-180, 180]. */
export function wrap180(a) {
  const x = ((a + 180) % 360 + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

// ---------- projection ----------

/**
 * Lambert azimuthal equal-area projection centred on (lat0, lon0), metres.
 * +x_0/+y_0 must be explicit: proj4 2.22 returns NaN without them.
 */
export function laea(lat0, lon0) {
  const def = `+proj=laea +lat_0=${lat0} +lon_0=${lon0} +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs`;
  const p = proj4('EPSG:4326', def);
  return { def, fwd: (lonlat) => p.forward(lonlat), inv: (xy) => p.inverse(xy) };
}

// ---------- ROI ----------

/** Polygons of a geometry as an array of polygon coordinate arrays ([] for a Point). */
export function polygonsOf(geom) {
  if (geom.type === 'Polygon') return [geom.coordinates];
  if (geom.type === 'MultiPolygon') return geom.coordinates;
  if (geom.type === 'Point') return [];
  throw new Error(`unsupported ROI geometry type: ${geom.type}`);
}

/** Unwrap ring longitudes so consecutive vertices never jump across the antimeridian. */
function unwrapRing(ring, refLon) {
  let prev = refLon;
  return ring.map(([lon, lat]) => {
    let x = lon;
    while (x - prev > 180) x -= 360;
    while (x - prev < -180) x += 360;
    prev = x;
    return [x, lat];
  });
}

function ringSignedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

/** Shoelace area of polygon coordinates (outer ring minus holes), in input units². */
export function polygonArea(poly) {
  return poly.reduce((acc, ring, i) => acc + (i === 0 ? 1 : -1) * Math.abs(ringSignedArea(ring)), 0);
}

/** Area of a MultiPolygon coordinate array. */
export function multiPolygonArea(mp) {
  return mp.reduce((acc, poly) => acc + polygonArea(poly), 0);
}

/** Ray-casting point-in-ring test (planar). */
function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Planar point-in-polygon, holes respected. */
export function pointInPolygon(pt, poly) {
  if (!inRing(pt, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(pt, poly[k])) return false;
  return true;
}

/**
 * ROI anchor {lat, lon}: the point used for distances, sun and view angles.
 * Point ROI: the point itself. Polygon: area centroid in lon/lat if inside,
 * else the midpoint of the widest interior chord along the centroid's parallel.
 */
export function roiAnchor(geom) {
  if (geom.type === 'Point') return { lon: geom.coordinates[0], lat: geom.coordinates[1] };
  const polys = polygonsOf(geom);
  const refLon = polys[0][0][0][0];
  const outers = polys.map((p) => p.map((r) => unwrapRing(r, refLon)));
  let A = 0, cx = 0, cy = 0;
  for (const p of outers) {
    for (let k = 0; k < p.length; k++) {
      const ring = p[k];
      const sgn = (k === 0 ? 1 : -1) * Math.sign(ringSignedArea(ring)) || 1;
      for (let i = 0, n = ring.length; i < n; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % n];
        const c = (x1 * y2 - x2 * y1) * sgn;
        A += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c;
      }
    }
  }
  const c = [cx / (3 * A), cy / (3 * A)];
  if (outers.some((p) => pointInPolygon(c, p))) return { lon: wrap180(c[0]), lat: c[1] };

  // Widest interior chord on the parallel through the centroid.
  let best = null;
  for (const p of outers) {
    const xs = [];
    for (const ring of p) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > c[1]) !== (yj > c[1])) xs.push(xi + ((c[1] - yi) * (xj - xi)) / (yj - yi));
      }
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i];
      if (!best || w > best.w) best = { w, x: (xs[i] + xs[i + 1]) / 2 };
    }
  }
  if (!best) throw new Error('could not find an interior point for the ROI');
  return { lon: wrap180(best.x), lat: c[1] };
}

/**
 * Prepare an ROI for intersection: anchor, projection, projected polygons,
 * area (m²) and radius (km, max vertex distance from the anchor).
 */
export function prepareRoi(geom) {
  const anchor = roiAnchor(geom);
  const proj = laea(anchor.lat, anchor.lon);
  const polys = polygonsOf(geom).map((p) => p.map((ring) => ring.map((v) => proj.fwd(v))));
  const area = multiPolygonArea(polys);
  let radiusKm = 0;
  for (const p of polys) for (const ring of p) for (const [x, y] of ring) {
    radiusKm = Math.max(radiusKm, Math.hypot(x, y) / 1000);
  }
  return { geom, isPoint: geom.type === 'Point', anchor, proj, polys, area, radiusKm };
}

// ---------- swath ----------

/**
 * End points of the instantaneous cross-track scan line.
 * `crossKm` = [a, b]: signed cross-track offsets (km, positive to the right of
 * the ground-track heading). nadir_symmetric: [-w/2, +w/2].
 */
export function scanLine(sub, headingDeg, [a, b]) {
  const end = (d) => (d >= 0 ? geoDirect(sub.lat, sub.lon, headingDeg + 90, d)
    : geoDirect(sub.lat, sub.lon, headingDeg - 90, -d));
  return { left: end(a), right: end(b) };
}

/** Projected strip polygon (one ring, closed) from a sequence of scan lines. */
export function stripPolygon(lines, proj) {
  const left = lines.map((l) => proj.fwd([l.left.lon, l.left.lat]));
  const right = lines.map((l) => proj.fwd([l.right.lon, l.right.lat])).reverse();
  const ring = [...left, ...right, left[0]];
  return [ring];
}

/** Lon/lat strip polygon (GeoJSON Polygon coordinates) for display and export. */
export function stripLonLat(lines) {
  const left = lines.map((l) => [l.left.lon, l.left.lat]);
  const right = lines.map((l) => [l.right.lon, l.right.lat]).reverse();
  return [[...left, ...right, left[0]]];
}

/** Intersection area (m²) of a projected polygon with the projected ROI polygons. */
export function intersectionArea(polyProj, roi) {
  if (roi.isPoint) return 0;
  const out = polygonClipping.intersection(polyProj, roi.polys);
  return multiPolygonArea(out);
}

/** True when the projected polygon touches the ROI (point inside, or non-zero overlap). */
export function touchesRoi(polyProj, roi) {
  if (roi.isPoint) return pointInPolygon([0, 0], polyProj);
  return intersectionArea(polyProj, roi) > 0;
}
