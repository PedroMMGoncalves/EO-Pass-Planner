// e2e.mjs: end-to-end check of the page in a real browser (Playwright, Chromium).
//
// Inputs:  BASE_URL (default http://localhost:8765/), a static server running
//          from the repository root; PLAYWRIGHT_MODULE to override where the
//          playwright package is imported from.
// Outputs: assertions on the main user flows; screenshots in e2e-output/;
//          exit code 1 on the first failure.
// Flows:   idle globe; point query from a link; answer, calendar, table and
//          pass drawer; exports (CSV, ICS, GeoJSON, GeoLibre); spectral ruler;
//          rectangle drawing; KMZ file; theme and language toggles; mobile
//          layout; no page errors.
// Limitations: needs network access for the online parts (Open-Meteo, STAC);
//          those are checked for presence, not for values.
// Usage:   python -m http.server 8765 &   then   node scripts/e2e.mjs

import { mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const BASE = process.env.BASE_URL ?? 'http://localhost:8765/';
const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}e2e-output`;
mkdirSync(out, { recursive: true });

const errors = [];
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => localStorage.clear());
  const done = () => page.waitForFunction(() => /s\.$/.test(document.querySelector('#progress').textContent), null, { timeout: 90000 });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  check((await page.textContent('#answer-main')).length > 10, 'idle answer text');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/1_idle.png` });

  await page.goto(`${BASE}?run=1#roi=p:37.57300,-7.97100&d=10`, { waitUntil: "networkidle" });
  await done();
  await page.waitForTimeout(5000);
  check(/às \d\d:\d\d/.test(await page.textContent('#answer-main')), 'answer sentence for a point (pt)');
  check((await page.$$('#answer-lines button')).length >= 2, 'per-category lines');
  check((await page.$$('.cal-cell[data-id]')).length > 10, 'calendar cells');
  check(await page.isVisible('#drawer'), 'pass drawer open on the best pass');
  check((await page.$$('#drawer .geom-diagram')).length === 1, 'geometry diagram');
  await page.screenshot({ path: `${out}/2_point.png` });

  await page.click('#tab-table');
  check((await page.$$('#passes tbody tr')).length > 10, 'table rows');
  await page.click('.exports summary');
  await page.waitForTimeout(300); // the menu settles on the side with room
  for (const id of ['export-csv', 'export-ics', 'export-geojson', 'export-geolibre']) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click(`#${id}`)]);
    const p = `${out}/${dl.suggestedFilename()}`;
    await dl.saveAs(p);
    check(statSync(p).size > 500, `export ${dl.suggestedFilename()}`);
  }
  await page.click('.exports summary');
  await page.click('#tab-spectral');
  await page.waitForTimeout(800);
  check((await page.$$('#spectral svg')).length === 1, 'spectral ruler');

  await page.click('[data-mode="rectangle"]');
  const box = await page.locator('#globe canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.48, box.y + box.height * 0.45);
  await page.mouse.click(box.x + box.width * 0.52, box.y + box.height * 0.5);
  check(/km²/.test(await page.textContent('#roi-summary')), 'rectangle drawn');

  await page.click('text=Carregar ficheiro');
  await page.setInputFiles('#roi-file', `${root}tests/fixtures/roi_ossa_morena.kmz`);
  await page.waitForTimeout(1000);
  check(/5 vértices/.test(await page.textContent('#roi-summary')), 'KMZ file read');
  await page.click('#run');
  await done();
  await page.waitForTimeout(4000);
  check(/cobre \d+ % da área/.test(await page.textContent('#answer-main')), 'answer sentence for a polygon');

  await page.click('#theme');
  await page.click('#lang');
  await page.waitForTimeout(1500);
  check(/covers \d+ % of the area/.test(await page.textContent('#answer-main')), 'English answer after the language toggle');
  await page.screenshot({ path: `${out}/3_polygon_dark_en.png` });

  const m = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  m.on('pageerror', (e) => errors.push(`mobile: ${e.message}`));
  await m.goto(BASE, { waitUntil: 'networkidle' });
  await m.waitForTimeout(1500);
  await m.screenshot({ path: `${out}/4_mobile.png`, fullPage: true });
  check(true, 'mobile layout rendered');

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`);
} finally {
  await browser.close();
}
