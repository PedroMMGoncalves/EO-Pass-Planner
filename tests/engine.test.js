// Tests for js/engine.js, js/geometry.js and js/sun.js (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as sat from '../vendor/satellite.js';
import { predictPasses, predictEntry } from '../js/engine.js';
import {
  prepareRoi, roiAnchor, geoDirect, geoInverse, laea, polygonArea, wrap180,
} from '../js/geometry.js';
import { solarPosition } from '../js/sun.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const fx = read('./fixtures/sgp4_skyfield.json');
const catalogue = read('../data/catalogue.json');
const entry = (id) => catalogue.entries.find((e) => e.id === id);

// Fixed TLEs (copied into the fixture) so the tests do not change when data/tles.json updates.
const tles = Object.fromEntries(fx.satellites.map((s) => [String(s.norad), {
  line1: s.line1, line2: s.line2, epoch: s.samples[0].utc,
}]));
const S2C = fx.satellites.find((s) => s.norad === 60989);
const START = S2C.samples[0].utc;

test('SGP4: satellite.js agrees with Skyfield to < 10 m (TEME)', () => {
  let worst = 0;
  for (const s of fx.satellites) {
    const rec = sat.twoline2satrec(s.line1, s.line2);
    for (const smp of s.samples) {
      const p = sat.propagate(rec, new Date(smp.utc)).position;
      const d = Math.hypot(p.x - smp.teme_km[0], p.y - smp.teme_km[1], p.z - smp.teme_km[2]) * 1000;
      worst = Math.max(worst, d);
    }
  }
  assert.ok(worst < 10, `worst position difference ${worst.toFixed(3)} m`);
});

test('sun: NOAA equations agree with Skyfield/DE421 to < 0.05°', () => {
  for (const c of fx.sun) {
    const s = solarPosition(new Date(c.utc), c.lat, c.lon);
    assert.ok(Math.abs(s.elevation - c.elevation_deg) < 0.05, `${c.place} elevation ${s.elevation} vs ${c.elevation_deg}`);
    if (c.elevation_deg > -80) {
      assert.ok(Math.abs(wrap180(s.azimuth - c.azimuth_deg)) < 0.1, `${c.place} azimuth ${s.azimuth} vs ${c.azimuth_deg}`);
    }
  }
});

test('geometry: LAEA areas are true areas', () => {
  // 1° x 1° cell at the equator: 12 308.8 km² on WGS84 (spherical cap formula on the authalic sphere gives the same to < 0.1 %).
  const p = laea(0.5, 0.5);
  const ring = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]].map((v) => p.fwd(v));
  const km2 = polygonArea([ring]) / 1e6;
  assert.ok(Math.abs(km2 - 12308.8) < 15, `area ${km2}`);
});

test('geometry: anchor of a concave (C-shaped) polygon lies inside it', () => {
  const c = { type: 'Polygon', coordinates: [[[0, 0], [3, 0], [3, 1], [1, 1], [1, 2], [3, 2], [3, 3], [0, 3], [0, 0]]] };
  const a = roiAnchor(c);
  assert.ok(a.lon >= 0 && a.lon <= 1 && a.lat > 0 && a.lat < 3, JSON.stringify(a));
});

/** A point at signed cross-track distance `km` (positive = right) from the S2C sub-satellite point at its closest approach to `base`. */
function pointAcross(base, km) {
  const r = predictEntry(entry('S2C_MSI'), tles['60989'], prepareRoi(base), Date.parse(START), Date.parse(START) + 5 * 86400000);
  const p = r.passes[0];
  const rec = sat.twoline2satrec(tles['60989'].line1, tles['60989'].line2);
  const d = new Date(p.closest_utc);
  const g = sat.eciToGeodetic(sat.propagate(rec, d).position, sat.gstime(d));
  const sub = { lat: sat.degreesLat(g.latitude), lon: sat.degreesLong(g.longitude) };
  const q = geoDirect(sub.lat, sub.lon, p.heading_deg + (km >= 0 ? 90 : -90), Math.abs(km));
  return { pass: p, roi: { type: 'Point', coordinates: [q.lon, q.lat] } };
}

test('point ROI just inside / just outside the swath edge (145 km half-swath)', () => {
  const base = { type: 'Point', coordinates: [-8, 38] };
  const start = Date.parse(START);
  for (const [km, inside] of [[142, true], [148, false], [-142, true], [-148, false]]) {
    const { pass, roi } = pointAcross(base, km);
    const r = predictEntry(entry('S2C_MSI'), tles['60989'], prepareRoi(roi), start, start + 5 * 86400000);
    const hit = r.passes.find((p) => Math.abs(p.closest_utc - pass.closest_utc) < 60000);
    assert.equal(Boolean(hit), inside, `offset ${km} km`);
    if (hit) {
      assert.ok(Math.abs(hit.edge_margin_km - 3) < 0.5, `edge margin ${hit.edge_margin_km}`);
      assert.equal(hit.side, km > 0 ? 'right' : 'left');
      assert.equal(hit.edge_uncertain, true);
    }
  }
});

test('ROI larger than the swath is never fully covered', () => {
  const pt = { type: 'Polygon', coordinates: [[[-9.55, 36.95], [-6.18, 36.95], [-6.18, 42.15], [-9.55, 42.15], [-9.55, 36.95]]] };
  const r = predictPasses({ entries: [entry('L9_OLI2_TIRS2'), entry('S2C_MSI')], tles, roi: pt, start: START, days: 16 });
  assert.ok(r.passes.length > 5);
  for (const p of r.passes) assert.ok(p.coverage_pct > 0 && p.coverage_pct < 100, `${p.id} ${p.coverage_pct}`);
  assert.ok(Math.abs(r.roi.area_km2 - 300 * 577) / (300 * 577) < 0.1, `area ${r.roi.area_km2}`);
});

test('antimeridian-crossing polygon ROI (Fiji)', () => {
  const fiji = { type: 'Polygon', coordinates: [[[179.4, -17.2], [-179.6, -17.2], [-179.6, -16.2], [179.4, -16.2], [179.4, -17.2]]] };
  const prep = prepareRoi(fiji);
  assert.ok(Math.abs(Math.abs(prep.anchor.lon) - 179.9) < 0.05, `anchor ${prep.anchor.lon}`);
  assert.ok(prep.area / 1e6 > 11000 && prep.area / 1e6 < 12500, `area ${prep.area / 1e6}`);
  const r = predictPasses({ entries: [entry('S2C_MSI'), entry('L9_OLI2_TIRS2')], tles, roi: fiji, start: START, days: 16 });
  const exp = r.passes.filter((p) => p.imaging_expected);
  assert.ok(exp.length >= 3, `${exp.length} expected passes`);
  for (const p of r.passes) assert.ok(p.coverage_pct > 0 && p.coverage_pct <= 100);
});

test('high latitude: 80° N is reachable; 85° N is outside Sentinel-2 limits and beyond Landsat', () => {
  const at = (lat) => ({ type: 'Point', coordinates: [20, lat] });
  const r80 = predictPasses({ entries: [entry('S2C_MSI')], tles, roi: at(80), start: START, days: 5 });
  assert.ok(r80.passes.length > 5, `${r80.passes.length} passes at 80° N`);
  const r85 = predictPasses({ entries: [entry('S2C_MSI'), entry('L9_OLI2_TIRS2')], tles, roi: at(85), start: START, days: 5 });
  for (const p of r85.passes) assert.ok(p.filter_reasons.includes('outside_lat_limits'), p.id);
  assert.equal(r85.per_entry.L9_OLI2_TIRS2.n_passes, 0);
  assert.ok(r85.per_entry.L9_OLI2_TIRS2.closest_km > r85.per_entry.L9_OLI2_TIRS2.reach_km);
});

test('pass attributes are consistent', () => {
  const r = predictPasses({ entries: [entry('S2C_MSI')], tles, roi: { type: 'Point', coordinates: [32.5732, -25.9692] }, start: START, days: 10 });
  const exp = r.passes.filter((p) => p.imaging_expected);
  assert.ok(exp.length >= 2);
  for (const p of exp) {
    assert.equal(p.direction, 'descending');
    assert.ok(p.sun_elevation_deg > 0);
    assert.ok(p.altitude_km > 780 && p.altitude_km < 810, `altitude ${p.altitude_km}`);
    assert.ok(Math.abs(p.edge_margin_km - (145 - p.nadir_offset_km)) < 1e-9);
    assert.ok(p.view_angle_deg < 11 && p.incidence_deg >= p.view_angle_deg);
    assert.ok(p.tle_age_days < 10);
  }
  const night = r.passes.filter((p) => !p.imaging_expected);
  for (const p of night) assert.ok(p.filter_reasons.length > 0);
});

test('unsupported swath models and missing TLEs are reported', () => {
  const sar = { ...entry('S2C_MSI'), id: 'X', swath: { model: 'side_looking', look_side: 'right', incidence_deg: [29, 46] } };
  const r = predictPasses({ entries: [sar, { ...entry('S2C_MSI'), id: 'Y', norad_id: 1 }], tles, roi: { type: 'Point', coordinates: [0, 0] }, start: START, days: 1 });
  assert.equal(r.per_entry.X.status, 'unsupported_model');
  assert.equal(r.per_entry.Y.status, 'no_tle');
});

test('geodesic helpers round-trip', () => {
  const q = geoDirect(38, -8, 37, 250);
  const inv = geoInverse(38, -8, q.lat, q.lon);
  assert.ok(Math.abs(inv.km - 250) < 1e-6 && Math.abs(inv.azi1 - 37) < 1e-6);
});
