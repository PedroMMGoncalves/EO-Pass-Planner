/**
 * tle.js: load data/tles.json and report TLE quality (age, data freshness).
 *
 * Inputs:  tles.json {norad: {name, line1, line2, epoch, source, fetched}},
 *          meta.json {updated_utc, sources, stale_tles}.
 * Outputs: TLE records, age in days relative to a pass time, warning levels.
 *
 * Limitations: SGP4 error grows with TLE age (roughly 1-3 km/day for LEO;
 * larger across manoeuvres). Age thresholds (7 / 14 days) are
 * warnings, not error bounds. Manoeuvre detection from archived TLEs
 * (mean-motion jumps) is not implemented yet: it needs a calibrated threshold.
 */

export const TLE_WARN_DAYS = 7;
export const TLE_STRONG_WARN_DAYS = 14;
export const DATA_STALE_HOURS = 24;

const DAY_MS = 86400000;

export async function loadJson(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export const loadTles = (url = 'data/tles.json') => loadJson(url);
export const loadMeta = (url = 'data/meta.json') => loadJson(url);

/** |t - epoch| in days. */
export function tleAgeDays(tle, t) {
  return Math.abs(new Date(t).getTime() - new Date(tle.epoch).getTime()) / DAY_MS;
}

/** 'ok' | 'warn' (> 7 d) | 'strong' (> 14 d). */
export function tleAgeLevel(ageDays) {
  if (ageDays > TLE_STRONG_WARN_DAYS) return 'strong';
  if (ageDays > TLE_WARN_DAYS) return 'warn';
  return 'ok';
}

/** Hours since the data pipeline last changed the data, and whether that is stale. */
export function dataFreshness(meta, now = new Date()) {
  const hours = (new Date(now).getTime() - new Date(meta.updated_utc).getTime()) / 3600000;
  return { hours, stale: hours > DATA_STALE_HOURS };
}
