// Tests for plans.js, weather.js, tiles.js, stac.js, insar.js, export.js (ICS,
// GeoLibre) and geometry_diagram.js (node --test, offline).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepare, planStatus, planSatellite } from '../js/plans.js';
import { interpolate, cloudAt, fetchCloudSeries, cloudRelevant } from '../js/weather.js';
import { s2Tile, s2TilesForRoi, s1RelativeOrbit } from '../js/tiles.js';
import { normaliseItem, groupByPass } from '../js/stac.js';
import { insarTracks } from '../js/insar.js';
import { passesToIcs, geolibreProject } from '../js/export.js';
import { geometryDiagram } from '../js/geometry_diagram.js';

const H = 3600000;
const DAY = 86400000;

test('ESA plan cross-check: planned, not planned, no plan', () => {
  const fc = {
    type: 'FeatureCollection',
    plan: { coverage: [['2026-11-10T00:00:00Z', '2026-11-20T00:00:00Z']] },
    features: [
      { type: 'Feature', properties: { start: '2026-11-12T11:29:00Z', stop: '2026-11-12T11:33:00Z', mode: 'NOBS' }, geometry: { type: 'Polygon', coordinates: [[[-9, 37], [-7, 37], [-7, 39], [-9, 39], [-9, 37]]] } },
      { type: 'Feature', properties: { start: '2026-11-18T11:29:00Z', stop: '2026-11-18T11:33:00Z', mode: 'NOBS' }, geometry: { type: 'MultiPolygon', coordinates: [[[[170, 0], [180, 0], [180, 1], [170, 0]]]] } },
    ],
  };
  const plan = prepare(fc);
  const anchor = { lat: 38, lon: -8 };
  assert.deepEqual(planStatus(plan, { closest_utc: Date.parse('2026-11-12T11:30:00Z') }, anchor), { status: 'planned', mode: 'NOBS' });
  assert.equal(planStatus(plan, { closest_utc: Date.parse('2026-11-15T11:30:00Z') }, anchor).status, 'not_planned');
  // After the last segment the nominal coverage is clipped: "no plan".
  assert.equal(planStatus(plan, { closest_utc: Date.parse('2026-11-19T11:30:00Z') }, anchor).status, 'no_plan');
  assert.equal(planStatus(null, { closest_utc: 0 }, anchor).status, 'no_plan');
  assert.equal(planSatellite({ platform: 'Sentinel-2C', plan_source: 'esa_s2_kml' }), 'S2C');
  assert.equal(planSatellite({ platform: 'Landsat 9', plan_source: null }), null);
});

test('cloud: interpolation, gaps and source labels', async () => {
  const s = { time: [0, H, 2 * H, 10 * H], total: [0, 100, 50, 0], low: [0, 0, 0, 0], mid: [0, 0, 0, 0], high: [0, 100, 50, 0], kind: ['analysis', 'forecast', 'forecast', 'forecast'] };
  assert.equal(interpolate(s, s.total, H / 2), 50);
  assert.equal(interpolate(s, s.total, -1), null);
  assert.equal(interpolate(s, s.total, 5 * H), 50, 'across a gap > 3 h the earlier value is kept');
  assert.equal(cloudAt(s, 1.9 * H).kind, 'forecast');
  assert.equal(cloudRelevant({ categories: ['sar'] }), false);
  assert.equal(cloudRelevant({ categories: ['thermal'] }), true);
  // Requests: forecast API with past_days for a recent window; archive for an old one.
  const urls = [];
  const fake = async (url) => {
    urls.push(url);
    return { ok: true, json: async () => ({ hourly: { time: ['2026-01-01T00:00'], cloud_cover: [10], cloud_cover_low: [1], cloud_cover_mid: [2], cloud_cover_high: [3] } }) };
  };
  const now = Date.parse('2026-11-10T00:00:00Z');
  await fetchCloudSeries({ lat: 38, lon: -8 }, now - 2 * DAY, now + 5 * DAY, now, fake);
  assert.match(urls[0], /api\.open-meteo\.com\/v1\/forecast.*past_days=3.*forecast_days=6/);
  urls.length = 0;
  await fetchCloudSeries({ lat: 38, lon: -8 }, now - 200 * DAY, now - 190 * DAY, now, fake);
  assert.match(urls[0], /archive-api\.open-meteo\.com/);
  assert.equal(urls.length, 1);
});

test('Sentinel-2 MGRS tiles', () => {
  assert.equal(s2Tile(-7.971, 37.573), '29SNB'); // matches the STAC item tile for Neves-Corvo
  assert.equal(s2Tile(32.57, -25.97), '36JVS');
  assert.equal(s2Tile(0, 85), null);
  const tiles = s2TilesForRoi({ type: 'Polygon', coordinates: [[[-9.5, 37], [-6.2, 37], [-6.2, 42], [-9.5, 42], [-9.5, 37]]] });
  assert.ok(tiles.length >= 3 && tiles.every((x) => /^\d{2}[C-X][A-Z]{2}$/.test(x)));
});

test('Sentinel-1 relative orbit from a past acquisition 12 days earlier', () => {
  const acq = [{ platform: 'sentinel-1c', orbit_state: 'ascending', datetime: Date.parse('2026-11-06T18:26:07Z'), rel_orbit: 147 }];
  const p = { platform: 'Sentinel-1C', direction: 'ascending', closest_utc: Date.parse('2026-11-18T18:26:30Z') };
  assert.equal(s1RelativeOrbit(p, acq), 147);
  assert.equal(s1RelativeOrbit({ ...p, direction: 'descending' }, acq), null);
  assert.equal(s1RelativeOrbit({ ...p, closest_utc: p.closest_utc + 6 * DAY }, acq), null);
});

test('STAC items are normalised and grouped per pass', () => {
  const s2 = normaliseItem({ id: 'S2B_29SNB_20261109_0_L2A', links: [{ rel: 'self', href: 'https://x/items/a' }], properties: { platform: 'sentinel-2b', datetime: '2026-11-09T11:30:58Z', 'eo:cloud_cover': 57.4, 'grid:code': 'MGRS-29SNB' } }, 'sentinel-2-l2a');
  const s2b = { ...s2, id: 'b', tile: '29SNC', cloud: 20, datetime: s2.datetime + 5000 };
  assert.equal(s2.tile, '29SNB');
  assert.equal(s2.url, 'https://x/items/a');
  const g = groupByPass([s2, s2b]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].tiles, ['29SNB', '29SNC']);
  assert.equal(g[0].cloud, 20);
  const s1 = normaliseItem({ id: 'S1C', properties: { platform: 'sentinel-1c', datetime: '2026-11-06T18:26:07Z', 'sat:relative_orbit': 147, 'sat:orbit_state': 'ascending', 'sar:instrument_mode': 'IW' } }, 'sentinel-1-grd');
  assert.equal(s1.rel_orbit, 147);
  assert.equal(s1.mode, 'IW');
});

test('InSAR tracks: Sentinel-1C and -1D share a track 6 days apart', () => {
  const mk = (plat, day, cross = 400, dir = 'ascending') => ({
    id: `${plat}_${day}`, platform: plat, instrument: 'C-SAR (IW)', direction: dir, cross_track_km: cross,
    closest_utc: Date.parse('2026-11-11T18:34:00Z') + day * DAY, incidence_deg: 40,
  });
  const tracks = insarTracks([mk('Sentinel-1C', 0), mk('Sentinel-1D', 6), mk('Sentinel-1C', 12), mk('Sentinel-1C', 1, 150, 'descending')]);
  assert.equal(tracks.length, 1, 'the single descending pass makes no pair');
  assert.deepEqual(tracks[0].pairs.map((p) => p.days), [6, 6]);
  assert.deepEqual(tracks[0].platforms, ['Sentinel-1C', 'Sentinel-1D']);
});

test('ICS: stable UID, escaping, line folding', () => {
  const p = { id: 'S2C_MSI_2026-11-14T11:30', entry_utc: 1000, exit_utc: 2000, closest_utc: 1500 };
  const ics = passesToIcs([p], { anchor: { lat: 37.5, lon: -8 }, describe: () => ({ summary: 'A, B; C', description: `x\n${'y'.repeat(120)}` }), now: 0 });
  assert.match(ics, /UID:S2C_MSI_2026-11-14T11:30@eo-pass-planner/);
  assert.match(ics, /SUMMARY:A\\, B\\; C/);
  for (const line of ics.split('\r\n')) assert.ok(new TextEncoder().encode(line).length <= 75, line);
  assert.match(ics, /DTEND:19700101T000101Z/, 'events last at least one minute');
});

test('GeoLibre project structure', () => {
  const p = { platform: 'Sentinel-2C', instrument: 'MSI', closest_utc: 0, direction: 'descending', coverage_pct: 100, acquisition: 'systematic', edge_margin_km: 50, footprints: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]], entry_id: 'S2C_MSI' };
  const proj = geolibreProject([p], {
    roi: { type: 'Point', coordinates: [0.5, 0.5] }, anchor: { lat: 0.5, lon: 0.5 }, tz: 'UTC', name: 'x',
    categoryOf: () => 'optical_multispectral', colourOf: () => '#1F7A8C', labelOf: () => 'Optical',
  });
  assert.equal(proj.version, '0.2.0');
  assert.equal(proj.layers.length, 2);
  for (const l of proj.layers) {
    assert.equal(l.type, 'geojson');
    assert.equal(l.geojson.type, 'FeatureCollection');
    assert.ok(proj.styles[l.id]);
  }
  assert.deepEqual(proj.mapView.center, [0.5, 0.5]);
});

test('geometry diagram is an SVG drawn to scale', () => {
  const svg = geometryDiagram(
    { altitude_km: 786, cross_track_km: 52, view_angle_deg: 3.8, incidence_deg: 4.2, sun_elevation_deg: 33 },
    [[-145, 145]],
    { colour: '#1F7A8C', ink: '#17283A', soft: '#4A5968', labels: { left: 'L', right: 'R', roi: 'ROI', offset: 'off', view: 'v', inc: 'i', sun: 's', aria: 'a' } },
  );
  assert.match(svg, /^<svg[^>]*viewBox="0 0 380 216"/);
  assert.match(svg, /786 km/);
  assert.ok((svg.match(/<polyline/g) ?? []).length >= 2);
});
