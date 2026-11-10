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

test('unknown swath models and missing TLEs are reported', () => {
  const sar = { ...entry('S2C_MSI'), id: 'X', swath: { model: 'mystery' } };
  const r = predictPasses({ entries: [sar, { ...entry('S2C_MSI'), id: 'Y', norad_id: 1 }], tles, roi: { type: 'Point', coordinates: [0, 0] }, start: START, days: 1 });
  assert.equal(r.per_entry.X.status, 'unsupported_model');
  assert.equal(r.per_entry.Y.status, 'no_tle');
});

test('geodesic helpers round-trip', () => {
  const q = geoDirect(38, -8, 37, 250);
  const inv = geoInverse(38, -8, q.lat, q.lon);
  assert.ok(Math.abs(inv.km - 250) < 1e-6 && Math.abs(inv.azi1 - 37) < 1e-6);
});

// ---------- swath models ----------
import { swathIntervals, groundFromIncidence, groundFromOffNadir, geoViewZenith } from '../js/engine.js';

const s2c = entry('S2C_MSI');
const withSwath = (swath, extra = {}) => ({ ...s2c, id: `T_${swath.model}`, swath, ...extra });
const baseRoi = { type: 'Point', coordinates: [-8, 38] };
const startMs = Date.parse(START);
const passNear = (e, km) => {
  const { pass, roi } = pointAcross(baseRoi, km);
  const r = predictEntry(e, tles['60989'], prepareRoi(roi), startMs, startMs + 5 * 86400000);
  return r.passes.find((p) => Math.abs(p.closest_utc - pass.closest_utc) < 60000);
};

test('spherical conversions: incidence and off-nadir to ground distance', () => {
  // Sentinel-1 IW at 693 km: 29.1°–46.0° incidence spans roughly 250–290 km of ground range.
  const w = groundFromIncidence(46.0, 693) - groundFromIncidence(29.1, 693);
  assert.ok(w > 240 && w < 290, `IW ground range ${w}`);
  assert.equal(groundFromIncidence(0, 700), 0);
  // Off-nadir 30° from 650 km reaches ~380 km; beyond the horizon it saturates.
  const d = groundFromOffNadir(30, 650);
  assert.ok(d > 360 && d < 400, `reach ${d}`);
  assert.ok(groundFromOffNadir(89, 650) < 3000);
});

test('side_looking: right-looking strip images the right side only', () => {
  const e = withSwath({ model: 'side_looking', look_side: 'right', incidence_deg: [29.1, 46.0] }, { pass_filter: 'any' });
  const [[n, f]] = swathIntervals(e, 786);
  const mid = (n + f) / 2;
  const right = passNear(e, mid);
  assert.ok(right && right.side === 'right' && right.edge_margin_km > 50, 'pass on the right');
  assert.equal(passNear(e, -mid), undefined, 'nothing on the left');
  assert.equal(passNear(e, 20), undefined, 'nothing under the nadir');
  const left = withSwath({ model: 'side_looking', look_side: 'left', incidence_deg: [29.1, 46.0] }, { pass_filter: 'any' });
  assert.ok(passNear(left, -mid));
});

test('field_of_regard: reachable corridor flagged as a geometric opportunity', () => {
  const e = withSwath({ model: 'field_of_regard', width_km: 30, max_offnadir_deg: 30 }, { acquisition: 'tasked' });
  for (const km of [-300, 300]) {
    const p = passNear(e, km);
    assert.ok(p && p.opportunity, `opportunity at ${km} km`);
    assert.ok(p.view_angle_deg > 20 && p.view_angle_deg < 30, `pointing ${p.view_angle_deg}`);
  }
  assert.equal(passNear(e, 600), undefined);
  const sar = withSwath({ model: 'field_of_regard', width_km: 30, look_side: 'right', access_incidence_deg: [20, 45] }, { acquisition: 'tasked', pass_filter: 'any' });
  assert.ok(passNear(sar, 400));
  assert.equal(passNear(sar, -400), undefined);
  const asym = withSwath({ model: 'field_of_regard', width_km: 30, offnadir_range_deg: [-45, 5] }, { acquisition: 'tasked' });
  const [[lo, hi]] = swathIntervals(asym, 786);
  assert.ok(lo < -700 && hi > 70 && hi < 100, `asymmetric corridor ${lo}..${hi}`);
  assert.ok(passNear(asym, -500));
  assert.equal(passNear(asym, 200), undefined);
});

test('profile: nearby beam listed with its miss distance; far track not listed', () => {
  const e = withSwath({ model: 'profile', beams_cross_track_km: [-3.3, 0, 3.3], footprint_m: 13 }, { pass_filter: 'any', acquisition: 'systematic' });
  const p = passNear(e, 0.5);
  assert.ok(p, 'listed within near_km');
  assert.equal(p.coverage_pct, 0);
  assert.ok(Math.abs(p.edge_margin_km + 0.4935) < 0.05, `margin ${p.edge_margin_km}`);
  assert.ok(p.imaging_expected && p.edge_uncertain);
  assert.equal(passNear(e, 10), undefined);
});

test('nadir_symmetric with a nadir gap (SWOT-like)', () => {
  const e = withSwath({ model: 'nadir_symmetric', width_km: 120, gap_km: 20 }, { pass_filter: 'any' });
  assert.equal(passNear(e, 4), undefined, 'inside the gap');
  assert.ok(passNear(e, 30) && passNear(e, -30));
  const poly = { type: 'Polygon', coordinates: [[[-8.3, 37.8], [-7.7, 37.8], [-7.7, 38.2], [-8.3, 38.2], [-8.3, 37.8]]] };
  const r = predictEntry(e, tles['60989'], prepareRoi(poly), startMs, startMs + 16 * 86400000);
  for (const p of r.passes) assert.equal(p.footprints.length, 2);
});

test('track_only: proximity of the ground track', () => {
  const e = withSwath({ model: 'track_only', proximity_km: 50 }, { pass_filter: 'any', categories: ['geophysics'] });
  assert.ok(passNear(e, 40));
  assert.equal(passNear(e, 70), undefined);
});

test('continuous_geo: view zenith angle, no passes', () => {
  assert.ok(geoViewZenith(0, 0, 0) < 1e-6);
  const lisbon = geoViewZenith(0, 38.72, -9.14);
  assert.ok(lisbon > 40 && lisbon < 50, `Lisbon VZA ${lisbon}`);
  assert.ok(geoViewZenith(0, 0, 81.3) > 89);
  const geo = withSwath({ model: 'continuous_geo', sub_lon: 0, repeat_min: 10, max_view_zenith_deg: 70 });
  const r = predictEntry(geo, undefined, prepareRoi({ type: 'Point', coordinates: [32.57, -25.97] }), startMs, startMs + 86400000);
  assert.equal(r.status, 'geo');
  assert.equal(r.passes.length, 0);
  assert.ok(r.usable && r.view_zenith_deg > 30 && r.view_zenith_deg < 50, `Maputo VZA ${r.view_zenith_deg}`);
});

test('six-digit catalogue numbers: OMM record propagates like a TLE', async () => {
  const { satrecFrom, meanAltitudeKm } = await import('../js/engine.js');
  const omm = read('./fixtures/omm_sentinel-3c.json');
  const rec = satrecFrom({ omm });
  assert.equal(String(rec.satnum), '100690');
  const pv = sat.propagate(rec, new Date(omm.EPOCH + 'Z'));
  const alt = Math.hypot(pv.position.x, pv.position.y, pv.position.z) - 6371;
  assert.ok(alt > 780 && alt < 830, `altitude ${alt}`);
  assert.ok(meanAltitudeKm(rec) > 780 && meanAltitudeKm(rec) < 830);
  const e = { ...entry('S2C_MSI'), id: 'S3C_TEST', norad_id: 100690, swath: { model: 'nadir_symmetric', width_km: 1270 } };
  const r = predictEntry(e, { omm, epoch: omm.EPOCH + 'Z' }, prepareRoi({ type: 'Point', coordinates: [-8, 38] }), Date.parse(omm.EPOCH + 'Z'), Date.parse(omm.EPOCH + 'Z') + 3 * 86400000);
  assert.ok(r.passes.length >= 2, `${r.passes.length} passes`);
});
