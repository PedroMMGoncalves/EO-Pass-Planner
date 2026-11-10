// lighthouse_summary.mjs: Markdown summary of a Lighthouse JSON report.
// Input: path to the report. Output: scores and the failed accessibility audits
// on stdout; exit code 1 if accessibility < 95 or performance < 85 (targets).
import { readFileSync } from 'node:fs';

const r = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const score = (k) => Math.round((r.categories[k]?.score ?? 0) * 100);
const a11y = score('accessibility');
const perf = score('performance');
const failed = (r.categories.accessibility?.auditRefs ?? [])
  .map((ref) => r.audits[ref.id])
  .filter((a) => a && a.score !== null && a.score < 1)
  .map((a) => `- ${a.id}: ${a.title}`);
console.log(`### Lighthouse\n\n| Category | Score | Target |\n|---|---:|---:|\n| Accessibility | ${a11y} | 95 |\n| Performance | ${perf} | 85 |\n`);
if (failed.length) console.log(`Accessibility audits to fix:\n${failed.join('\n')}\n`);
process.exit(a11y >= 95 && perf >= 85 ? 0 : 1);
