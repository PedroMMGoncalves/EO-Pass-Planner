/**
 * engine.worker.js: runs the pass prediction (engine.js) off the UI thread.
 *
 * Message in:  { id, query }  (query as for engine.predictPasses)
 * Messages out: { id, type: 'progress', entry_id, done, total }
 *               { id, type: 'result', result }
 *               { id, type: 'error', message }
 * Start with: new Worker('js/engine.worker.js', { type: 'module' })
 *
 * Limitations: see engine.js.
 */

import { predictPasses } from './engine.js';

self.onmessage = (ev) => {
  const { id, query } = ev.data;
  try {
    const result = predictPasses(query, (p) => self.postMessage({ id, type: 'progress', ...p }));
    self.postMessage({ id, type: 'result', result });
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message ?? err) });
  }
};
