// run_engine.mjs: command-line wrapper around js/engine.js (used by oracle_compare.py).
//
// Input:  a JSON query on stdin:
//         { roi: <GeoJSON geometry>, start: <ISO UTC>, days: <number>,
//           entry_ids?: [...], options?: {...} }
//         Catalogue and TLEs are read from data/ unless "tles" is given in the query.
// Output: the engine result as JSON on stdout (footprints omitted), plus
//         "elapsed_ms".
// Limitations: Node only; same method and limitations as js/engine.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { predictPasses } from '../js/engine.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => JSON.parse(readFileSync(root + p, 'utf8'));

const query = JSON.parse(readFileSync(0, 'utf8'));
const catalogue = read('data/catalogue.json');
const tles = query.tles ?? read('data/tles.json');
const entries = catalogue.entries.filter(
  (e) => !query.entry_ids || query.entry_ids.includes(e.id),
);

const t0 = performance.now();
const result = predictPasses({ entries, tles, roi: query.roi, start: query.start, days: query.days, options: query.options });
result.elapsed_ms = performance.now() - t0;
for (const p of result.passes) { delete p.footprint; delete p.footprints; }
process.stdout.write(JSON.stringify(result));
