// Tests for js/roi.js (node --test). KML/KMZ parsing needs DOMParser and is
// exercised in the browser check instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  parseCoordinates, normaliseGeoJSON, readRoiBytes, simplifyRoi, bufferRoi, circle,
  encodePolyline, decodePolyline, encodeRoi, decodeRoi, buildHash, parseHash, RoiError,
} from '../js/roi.js';
import { prepareRoi } from '../js/geometry.js';

const km2 = (g) => prepareRoi(g).area / 1e6;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

test('coordinates: WGS 84 lat, lon with decimal point or comma', () => {
  for (const s of ['37.573, -7.971', '37.573 -7.971', '37,573 -7,971', '37,573; -7,971']) {
    const g = parseCoordinates(s, 'EPSG:4326');
    assert.deepEqual(g, { type: 'Point', coordinates: [-7.971, 37.573] }, s);
  }
  assert.throws(() => parseCoordinates('95, 10', 'EPSG:4326'), RoiError);
  assert.throws(() => parseCoordinates('1, 2\n3, 4', 'EPSG:4326'), RoiError);
});

test('coordinates: PT-TM06 origin and UTM 29N convert to WGS 84', () => {
  const o = parseCoordinates('0 0', 'EPSG:3763').coordinates;
  assert.ok(near(o[0], -8.1331083, 1e-6) && near(o[1], 39.6682583, 1e-6), JSON.stringify(o));
  // UTM 29N central meridian (-9°) at the equator: E = 500 000, N = 0.
  const u = parseCoordinates('500000 0', 'EPSG:32629').coordinates;
  assert.ok(near(u[0], -9, 1e-9) && near(u[1], 0, 1e-9));
  const c = parseCoordinates('500000 10000000', 'custom', '+proj=utm +zone=36 +south +datum=WGS84 +units=m +no_defs').coordinates;
  assert.ok(near(c[0], 33, 1e-9) && near(c[1], 0, 1e-6));
});

test('coordinates: three or more pairs make a closed, counter-clockwise polygon', () => {
  const g = parseCoordinates('38.2 -7.9\n38.2 -7.0\n38.9 -7.0\n38.9 -7.9', 'EPSG:4326');
  assert.equal(g.type, 'Polygon');
  const r = g.coordinates[0];
  assert.deepEqual(r[0], r[r.length - 1]);
  let s = 0;
  for (let i = 0; i + 1 < r.length; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  assert.ok(s > 0);
});

test('GeoJSON: overlapping polygons are dissolved, with a warning', () => {
  const sq = (x) => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]] } });
  const { geom, warnings } = normaliseGeoJSON({ type: 'FeatureCollection', features: [sq(0), sq(0.5)] });
  assert.equal(geom.type, 'Polygon');
  assert.ok(warnings.includes('file_dissolved'));
  assert.ok(near(km2(geom), 1.5 * 12308.8, 40), `${km2(geom)}`);
  const pts = normaliseGeoJSON({ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
  assert.deepEqual(pts.geom.coordinates, [1, 2]);
  assert.ok(pts.warnings.includes('file_first_point'));
});

test('zipped Shapefile in PT-TM06 is read and reprojected (.prj)', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/roi_pt-tm06_shapefile.zip', import.meta.url)));
  const { geom, warnings } = await readRoiBytes('roi.zip', bytes);
  assert.ok(warnings.includes('file_dissolved'));
  const lon = geom.coordinates.flat(3).filter((_, i) => i % 2 === 0);
  assert.ok(Math.min(...lon) > -8.2 && Math.max(...lon) < -6.8, 'longitudes are WGS 84 degrees');
});

test('buffer: point circle and square ring areas', () => {
  const c = bufferRoi({ type: 'Point', coordinates: [-8, 38] }, 10);
  assert.ok(near(km2(c), Math.PI * 100, Math.PI * 100 * 0.01), `${km2(c)}`);
  const sqPoly = circle(38, -8, 10, 4); // a square with a 10 km half-diagonal: area 200 km²
  const b = bufferRoi(sqPoly, 1);
  const expected = 200 + 4 * Math.sqrt(200) * 1 + Math.PI * 1;
  assert.ok(near(km2(b), expected, expected * 0.01), `${km2(b)} vs ${expected}`);
});

test('simplify keeps the area within 1 % and limits vertices', () => {
  const big = circle(38, -8, 50, 2000);
  const s = simplifyRoi(big, 200);
  assert.ok(s.simplified);
  assert.ok(s.geom.coordinates[0].length <= 200);
  assert.ok(Math.abs(s.areaChangePct) < 1, `${s.areaChangePct}`);
});

test('polyline and URL hash round-trip', () => {
  const pts = [[-7.90123, 38.2], [-7.05, 38.12345], [-6.95, 38.55]];
  assert.deepEqual(decodePolyline(encodePolyline(pts)), pts);
  const poly = { type: 'Polygon', coordinates: [[...pts, pts[0]]] };
  assert.deepEqual(decodeRoi(encodeRoi(poly)), poly);
  const h = buildHash({ roi: poly, buffer: 2, start: '2026-11-10T11:27', days: 10, ids: ['S2C_MSI', 'L9_OLI2_TIRS2'], transitional: true, lang: 'en' });
  const back = parseHash(h);
  assert.deepEqual(back.roi, poly);
  assert.equal(back.buffer, 2);
  assert.equal(back.days, 10);
  assert.deepEqual(back.ids, ['S2C_MSI', 'L9_OLI2_TIRS2']);
  assert.equal(back.transitional, true);
  assert.equal(back.lang, 'en');
  assert.deepEqual(parseHash(buildHash({ roi: { type: 'Point', coordinates: [32.5732, -25.9692] } })).roi, { type: 'Point', coordinates: [32.5732, -25.9692] });
  assert.throws(() => decodeRoi('x:1'), RoiError);
});
