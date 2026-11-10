// Tests for js/catalogue.js, js/tle.js and the vendored libraries (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { filterEntries, noteExpired, DEFAULT_CATEGORIES, defaultSelected } from '../js/catalogue.js';
import { tleAgeDays, tleAgeLevel, dataFreshness } from '../js/tle.js';
import { t, setLang } from '../js/i18n.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const catalogue = read('../data/catalogue.json');
const tles = read('../data/tles.json');

test('default filter hides transitional (ending) satellites', () => {
  const ids = filterEntries(catalogue.entries, { categories: DEFAULT_CATEGORIES }).map((e) => e.id);
  assert.ok(ids.includes('S2C_MSI'));
  assert.ok(!ids.includes('S2A_MSI'), 'S2A is "ending" and needs includeTransitional');
  const all = filterEntries(catalogue.entries, { includeTransitional: true });
  assert.equal(all.length, catalogue.entries.filter((e) => e.status !== 'inactive').length);
});

test('category, thermal and resolution filters', () => {
  const thermal = filterEntries(catalogue.entries, { categories: ['thermal'] }).map((e) => e.id);
  assert.ok(thermal.includes('L8_OLI_TIRS') && thermal.includes('S3A_SLSTR'));
  assert.ok(!thermal.includes('TERRA_ASTER_TIR'), 'inactive entries are never listed');
  const fine = filterEntries(catalogue.entries, { resolution: [0, 1] });
  for (const e of fine) assert.ok(!e.resolution_m || e.resolution_m.min <= 1, e.id);
  const sar = filterEntries(catalogue.entries, { categories: ['sar'] }).map((e) => e.id);
  assert.ok(sar.includes('S1C_CSAR_IW') && !sar.includes('S1A_CSAR_IW'));
});

test('default selection: default categories, no commercial or geophysics', () => {
  const sel = catalogue.entries.filter(defaultSelected).map((e) => e.id);
  assert.ok(sel.includes('S2C_MSI') && sel.includes('S1D_CSAR_IW') && sel.includes('ENMAP_HSI'));
  for (const id of ['PHR1A_OPT', 'TSX_SARX', 'SWARMA', 'MET12_FCI', 'N20_VIIRS']) assert.ok(!sel.includes(id), id);
});

test('S2A note expires after 2026-12-31', () => {
  const s2a = catalogue.entries.find((e) => e.id === 'S2A_MSI');
  assert.equal(noteExpired(s2a, '2026-12-31'), false);
  assert.equal(noteExpired(s2a, '2027-01-01'), true);
});

test('every catalogue NORAD id has a TLE with the expected name', () => {
  for (const e of catalogue.entries.filter((x) => x.status !== 'inactive' && !x.constellation)) {
    const tle = tles[String(e.norad_id)];
    assert.ok(tle, `${e.id}: no TLE`);
    assert.equal(tle.name, e.object_name);
  }
});

test('TLE age levels', () => {
  const tle = { epoch: '2026-11-01T00:00:00Z' };
  assert.equal(tleAgeDays(tle, '2026-10-30T00:00:00Z'), 2); // past passes use |dt|
  assert.equal(tleAgeLevel(7), 'ok');
  assert.equal(tleAgeLevel(7.1), 'warn');
  assert.equal(tleAgeLevel(14.1), 'strong');
});

test('data freshness turns stale after 24 h', () => {
  const meta = { updated_utc: '2026-11-10T00:00:00Z' };
  assert.equal(dataFreshness(meta, '2026-11-10T23:00:00Z').stale, false);
  assert.equal(dataFreshness(meta, '2026-11-11T01:00:00Z').stale, true);
});

test('i18n placeholders and fallback', () => {
  setLang('en');
  assert.equal(t('freshness_hours', { h: 3 }), 'Data updated 3 h ago');
  setLang('pt');
  assert.equal(t('freshness_hours', { h: 3 }), 'Dados atualizados há 3 h');
  assert.equal(t('no_such_key'), 'no_such_key');
});

test('vendored libraries load as ES modules', async () => {
  const sat = await import('../vendor/satellite.js');
  const rec = sat.twoline2satrec(tles['60989'].line1, tles['60989'].line2);
  const pv = sat.propagate(rec, new Date(tles['60989'].epoch));
  const r = Math.hypot(pv.position.x, pv.position.y, pv.position.z);
  assert.ok(r > 6371 + 700 && r < 6371 + 850, `S2C radius ${r} km`);

  const { default: proj4 } = await import('../vendor/proj4.js');
  // proj4 2.22 returns NaN for laea unless +x_0/+y_0 are given explicitly (see vendor/README.md).
  const laea = '+proj=laea +lat_0=38 +lon_0=-8 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs';
  assert.ok(proj4('EPSG:4326', '+proj=laea +lat_0=38 +lon_0=-8 +datum=WGS84', [-7, 38]).every(Number.isNaN),
    'quirk fixed upstream? then drop the workaround note');
  const [x, y] = proj4('EPSG:4326', laea, [-8, 38]);
  assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6);

  const { default: pc } = await import('../vendor/polygon-clipping.js');
  const sq = [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]];
  const sq2 = [[[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]]];
  assert.equal(pc.intersection(sq, sq2).length, 1);

  const { Geodesic } = await import('../vendor/geographiclib-geodesic.js');
  const inv = Geodesic.WGS84.Inverse(38.7, -9.1, -25.97, 32.57);
  assert.ok(Math.abs(inv.s12 / 1000 - 8000) < 500, `Lisboa–Maputo ${inv.s12 / 1000} km`);

  const { default: tz } = await import('../vendor/tz-lookup.js');
  assert.equal(tz(38.72, -9.14), 'Europe/Lisbon');
  assert.equal(tz(0.34, 6.73), 'Africa/Sao_Tome');
});
