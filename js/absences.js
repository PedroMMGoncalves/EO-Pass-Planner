/**
 * absences.js: the answer sentence, per-category highlights and "why no pass"
 * reasons.
 *
 * Inputs:  the engine result (passes, per_entry), the entries that were run,
 *          the ROI time zone and window length.
 * Outputs: the best pass, the answer sentence and one absence reason per
 *          instrument without an expected-imaging pass.
 *
 * Rules:
 * - Per category (primary category of the instrument), the highlighted pass is
 *   the earliest expected-imaging pass covering at least half of the ROI (or,
 *   if none does, the one with the highest coverage, earliest on ties).
 *   Instruments with a best resolution of 100 m or finer are preferred over
 *   coarser ones, then systematic over partial acquisitions, and both over
 *   tasked opportunities. The headline is the earliest of these highlights; one line
 *   per active category follows.
 * - bestPass (kept for single-list use): highest coverage, earliest on ties.
 * - An absence is either "swath missed by X km" (closest approach minus
 *   reach), "passes only when it does not acquire" (night, ascending, outside
 *   latitude limits), or a data/model problem.
 *
 * Limitations: "missed by" uses the closest approach of the sub-satellite
 * point over the whole window, refined to 1 s.
 */

import { t, formatDay, formatTime } from './i18n.js';
import { CATEGORIES } from './catalogue.js';

const HALF = 50;

/**
 * Name for sentences: the platform, or "instrument (platform)" when the
 * platform carries several catalogue instruments (ISS, Sentinel-3, NISAR).
 */
export function displayName(p, entriesById) {
  if (!entriesById) return p.platform;
  let n = 0;
  for (const e of Object.values(entriesById)) if (e.norad_id === p.norad_id && e.status !== 'inactive') n++;
  return n > 1 ? `${p.instrument.replace(/\s*\(.*\)$/, '')} (${p.platform})` : p.platform;
}

const FINE_M = 100;

/** Highlighted pass among candidates (see rules above). */
function highlight(passes, entriesById) {
  if (!passes.length) return null;
  const fineOf = (p) => (entriesById[p.entry_id]?.resolution_m?.min ?? Infinity) <= FINE_M;
  const fine = passes.filter(fineOf);
  const level = fine.length ? fine : passes;
  const systematic = level.filter((p) => p.acquisition === 'systematic' || p.acquisition === 'profile');
  const partial = level.filter((p) => p.acquisition === 'partial');
  const pool = systematic.length ? systematic : partial.length ? partial : level;
  const good = pool.filter((p) => p.coverage_pct >= HALF).sort((a, b) => a.closest_utc - b.closest_utc);
  return good[0] ?? pickBest(pool);
}

/** [{cat, pass}] in catalogue category order, one per category with an expected pass. */
export function categoryHighlights(result, entriesById) {
  const exp = result.passes.filter((p) => p.imaging_expected);
  const out = [];
  for (const cat of CATEGORIES) {
    const pass = highlight(exp.filter((p) => entriesById[p.entry_id]?.categories[0] === cat), entriesById);
    if (pass) out.push({ cat, pass });
  }
  return out;
}

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

function shortLine(cat, p, tz, isPoint, entriesById) {
  const cov = isPoint || p.model === 'profile' ? '' : `, ${Math.round(p.coverage_pct)} %`;
  const opp = p.opportunity ? ` (${t('acq_tasked')})` : '';
  return t('answer_line', { cat: t(`cat_${cat}`), sat: displayName(p, entriesById), when: formatDay(p.closest_utc, tz), time: formatTime(p.closest_utc, tz) }) + cov + opp;
}

/**
 * { main, sub, best, lines } for the answer bar. `entriesById` maps entry id to
 * catalogue entry (for the categories); without it, a single best pass is used.
 */
export function answerSentence(result, { tz, days, isPoint, entriesById = null }) {
  const exp = result.passes.filter((p) => p.imaging_expected);
  const hl = entriesById ? categoryHighlights(result, entriesById) : [];
  const best = hl.length ? hl.map((h) => h.pass).sort((a, b) => a.closest_utc - b.closest_utc)[0] : bestPass(exp);
  if (!best) return { main: t('answer_none', { days }), sub: t('answer_none_hint'), lines: [] };
  const when = formatDay(best.closest_utc, tz);
  const time = formatTime(best.closest_utc, tz);
  const sat = displayName(best, entriesById);
  let main;
  if (best.opportunity) main = t('answer_tasked', { sat, when, time });
  else if (best.model === 'profile') main = t('answer_profile', { sat, km: Math.max(0, -best.edge_margin_km).toFixed(1), when, time });
  else if (isPoint) main = t('answer_point', { sat, when, time });
  else main = t('answer_poly', { sat, cov: Math.round(best.coverage_pct), when, time });
  const n = exp.length - 1;
  const sub = [
    n > 0 ? t(n === 1 ? 'answer_more_one' : 'answer_more_other', { n, days }) : '',
    best.acquisition === 'partial' ? t('answer_partial') : '',
    t('answer_tz', { tz }),
  ].filter(Boolean).join(' ');
  const lines = hl.length > 1 ? hl.map((h) => ({ cat: h.cat, pass: h.pass, text: shortLine(h.cat, h.pass, tz, isPoint, entriesById) })) : [];
  return { main, sub, best, lines };
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
