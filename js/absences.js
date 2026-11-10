/**
 * absences.js: the answer sentence and "why no pass" reasons.
 *
 * Inputs:  the engine result (passes, per_entry), the entries that were run,
 *          the ROI time zone and window length.
 * Outputs: the best pass, the answer sentence and one absence reason per
 *          instrument without an expected-imaging pass.
 *
 * Rules:
 * - Best pass: highest coverage among expected-imaging passes (cloud cover is
 *   not yet included); the earliest wins ties.
 * - An absence is either "swath missed by X km" (closest approach minus
 *   reach), "passes only when it does not acquire" (night, ascending, outside
 *   latitude limits), or a data/model problem.
 *
 * Limitations: "missed by" uses the closest approach of the sub-satellite
 * point over the whole window, refined to 1 s.
 */

import { t, formatDay, formatTime } from './i18n.js';

/** Best pass; systematic/partial acquisitions are preferred over tasked opportunities. */
export function bestPass(passes) {
  const exp = passes.filter((p) => p.imaging_expected);
  const firm = exp.filter((p) => !p.opportunity);
  return pickBest(firm.length ? firm : exp);
}

function pickBest(passes) {
  let best = null;
  for (const p of passes) {
    if (!best || p.coverage_pct > best.coverage_pct + 1e-9
      || (Math.abs(p.coverage_pct - best.coverage_pct) <= 1e-9 && p.closest_utc < best.closest_utc)) best = p;
  }
  return best;
}

/** { main, sub } strings for the answer bar. */
export function answerSentence(result, { tz, days, isPoint }) {
  const exp = result.passes.filter((p) => p.imaging_expected);
  const best = bestPass(exp);
  if (!best) return { main: t('answer_none', { days }), sub: t('answer_none_hint') };
  const when = formatDay(best.closest_utc, tz);
  const time = formatTime(best.closest_utc, tz);
  let main;
  if (best.opportunity) main = t('answer_tasked', { sat: best.platform, when, time });
  else if (best.model === 'profile') main = t('answer_profile', { sat: best.platform, km: Math.max(0, -best.edge_margin_km).toFixed(1), when, time });
  else if (isPoint) main = t('answer_point', { sat: best.platform, when, time });
  else main = t('answer_poly', { sat: best.platform, cov: Math.round(best.coverage_pct), when, time });
  const n = exp.length - 1;
  const sub = [
    n > 0 ? t(n === 1 ? 'answer_more_one' : 'answer_more_other', { n, days }) : '',
    best.acquisition === 'partial' ? t('answer_partial') : '',
    t('answer_tz', { tz }),
  ].filter(Boolean).join(' ');
  return { main, sub, best };
}

/** [{entry, text}] for entries without an expected-imaging pass. */
export function absences(result, entries, tz) {
  const out = [];
  for (const e of entries) {
    const r = result.per_entry[e.id];
    if (!r || r.n_expected > 0 || r.status === 'geo') continue;
    let text;
    if (r.status === 'unsupported_model') text = t('abs_unsupported');
    else if (r.status === 'no_tle') text = t('abs_no_tle');
    else if (r.n_passes > 0) {
      const reasons = new Set(result.passes.filter((p) => p.entry_id === e.id).flatMap((p) => p.filter_reasons));
      text = t('abs_filtered', { reasons: [...reasons].map((x) => t(`reason_${x}`)).join(', ') });
    } else {
      text = t('abs_missed', {
        km: Math.max(0, Math.round(r.closest_km - r.reach_km)),
        side: t(`side_${r.closest_side ?? 'E'}`),
        when: `${formatDay(r.closest_utc, tz)}, ${formatTime(r.closest_utc, tz)}`,
      });
    }
    out.push({ entry: e, text });
  }
  return out;
}
