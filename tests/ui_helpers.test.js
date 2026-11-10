// Tests for js/absences.js, js/export.js, js/live.js and the i18n date helpers (node --test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { predictPasses } from '../js/engine.js';
import { bestPass, answerSentence, absences } from '../js/absences.js';
import { passesToCsv } from '../js/export.js';
import { makeTrackers, positions, tracks, nightPolygon } from '../js/live.js';
import { setLang, formatDay, isoLocal, utcOffset } from '../js/i18n.js';
import { solarElevation } from '../js/sun.js';

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));
const fx = read('./fixtures/sgp4_skyfield.json');
const catalogue = read('../data/catalogue.json');
const tles = Object.fromEntries(fx.satellites.map((s) => [String(s.norad), { line1: s.line1, line2: s.line2, epoch: s.samples[0].utc }]));
const START = fx.satellites[0].samples[0].utc;
// Only the instruments whose TLEs are in the fixture (Landsat 8/9, Sentinel-2B/C).
const entries = catalogue.entries.filter((e) => e.status === 'active' && tles[String(e.norad_id)] && e.swath.model === 'nadir_symmetric');
const point = { type: 'Point', coordinates: [-7.971, 37.573] };
const result = predictPasses({ entries, tles, roi: point, start: START, days: 16 });

test('best pass: highest coverage, earliest on ties, expected-imaging only', () => {
  const b = bestPass(result.passes);
  const exp = result.passes.filter((p) => p.imaging_expected);
  assert.ok(b.imaging_expected);
  assert.equal(b.closest_utc, Math.min(...exp.filter((p) => p.coverage_pct === 100).map((p) => p.closest_utc)));
});

test('answer sentence (pt and en)', () => {
  setLang('pt');
  const a = answerSentence(result, { tz: 'Europe/Lisbon', days: 16, isPoint: true });
  assert.match(a.main, /passa sobre o local (no|na) \S+, \d{1,2} (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez), às \d\d:\d\d\./);
  assert.match(a.sub, /Mais \d+ passagens nos próximos 16 dias/);
  setLang('en');
  const e = answerSentence(result, { tz: 'Europe/Lisbon', days: 16, isPoint: true });
  assert.match(e.main, /passes over the place on \w+/);
  setLang('pt');
  const none = answerSentence({ passes: [], per_entry: {} }, { tz: 'UTC', days: 3, isPoint: true });
  assert.match(none.main, /Nenhum instrumento/);
});

test('per-category highlights: one line per category, earliest headline', async () => {
  const { categoryHighlights } = await import('../js/absences.js');
  setLang('pt');
  const byId = Object.fromEntries(catalogue.entries.map((e) => [e.id, e]));
  const hl = categoryHighlights(result, byId);
  const cats = hl.map((h) => h.cat);
  assert.ok(cats.includes('optical_multispectral'));
  assert.equal(new Set(cats).size, cats.length);
  const a = answerSentence(result, { tz: 'Europe/Lisbon', days: 16, isPoint: true, entriesById: byId });
  assert.equal(a.best.closest_utc, Math.min(...hl.map((h) => h.pass.closest_utc)));
  if (hl.length > 1) assert.equal(a.lines.length, hl.length);
});

test('absences explain a missed swath with distance and side', () => {
  setLang('pt');
  const short = predictPasses({ entries, tles, roi: point, start: START, days: 1 });
  const list = absences(short, entries, 'Europe/Lisbon');
  assert.ok(list.length > 0);
  for (const a of list) assert.match(a.text, /A faixa passa a \d+ km do local \(a (este|oeste)\)|só em condições/);
});

test('CSV has a header, one row per pass and explicit offsets', () => {
  const exp = result.passes.filter((p) => p.imaging_expected);
  const csv = passesToCsv(exp, { tz: 'Europe/Lisbon', catalogueVersion: 'v', dataUpdated: 'd', engineVersion: 'e' });
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, exp.length + 1);
  assert.ok(lines[0].startsWith('platform,instrument,norad_id'));
  assert.match(lines[1], /,20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d,/);
});

test('local time helpers handle DST', () => {
  assert.equal(utcOffset(Date.parse('2026-07-01T12:00:00Z'), 'Europe/Lisbon'), '+01:00');
  assert.equal(utcOffset(Date.parse('2026-12-01T12:00:00Z'), 'Europe/Lisbon'), '+00:00');
  assert.equal(isoLocal(Date.parse('2026-07-01T12:00:00Z'), 'Africa/Maputo'), '2026-07-01T14:00:00+02:00');
  setLang('pt');
  assert.equal(formatDay(Date.parse('2026-11-14T11:30:00Z'), 'Europe/Lisbon'), 'no sábado, 14 nov');
});

test('live layer: positions, unwrapped tracks, night polygon', () => {
  const tr = makeTrackers(entries, tles);
  const now = Date.parse(START);
  const pos = positions(tr, now);
  assert.equal(pos.length, entries.length);
  for (const f of tracks(tr, now).features) {
    const c = f.geometry.coordinates;
    for (let i = 1; i < c.length; i++) assert.ok(Math.abs(c[i][0] - c[i - 1][0]) < 180);
  }
  // A point on the night side has negative solar elevation.
  const ring = nightPolygon(now).features[0].geometry.coordinates[0];
  assert.ok(ring.length > 100);
  const [lon, lat] = ring[Math.floor(ring.length / 4)];
  assert.ok(Math.abs(solarElevation(now, lat, lon)) < 1.5, 'terminator points have sun near 0°');
});
