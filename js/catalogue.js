/**
 * catalogue.js: load and filter the instrument catalogue (data/catalogue.json).
 *
 * Inputs:  the catalogue JSON (schema: scripts/validate_catalogue.py); filter options.
 * Outputs: arrays of entry objects; per-entry warnings (e.g. expired notes).
 *
 * Limitations: the catalogue is hand-maintained. Values are only as good as
 * the cited sources; fields listed in `unverified_fields` have not been
 * checked. Status can change between catalogue updates.
 */

export const CATEGORIES = [
  'optical_multispectral', 'optical_vhr', 'hyperspectral', 'thermal', 'sar',
  'lidar_altimetry', 'meteo_polar', 'meteo_geo', 'atmosphere', 'geophysics',
];

/** Categories enabled on first load. */
export const DEFAULT_CATEGORIES = ['optical_multispectral', 'hyperspectral', 'sar', 'thermal'];

/** Statuses shown unless the user includes commissioning/ending satellites. */
const CORE_STATUSES = new Set(['active', 'degraded']);

/** Fetch the catalogue. `url` defaults to the copy next to the page (relative path). */
export async function loadCatalogue(url = 'data/catalogue.json') {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`catalogue: HTTP ${res.status}`);
  return res.json();
}

/**
 * Filter entries.
 * @param {object[]} entries
 * @param {object} f
 * @param {string[]} [f.categories]      keep entries with any of these categories
 * @param {string[]} [f.acquisition]     keep these acquisition models
 * @param {boolean} [f.openDataOnly]
 * @param {boolean} [f.swirOnly]
 * @param {number[]} [f.resolution]      [min, max] m; keeps entries whose range overlaps
 * @param {boolean} [f.includeTransitional] include commissioning and ending satellites
 */
export function filterEntries(entries, f = {}) {
  return entries.filter((e) => {
    if (e.status === 'inactive') return false;
    if (!CORE_STATUSES.has(e.status) && !f.includeTransitional) return false;
    if (f.categories && !e.categories.some((c) => f.categories.includes(c))) return false;
    if (f.acquisition && !f.acquisition.includes(e.acquisition)) return false;
    if (f.openDataOnly && !e.tags.includes('open_data')) return false;
    if (f.swirOnly && !e.tags.includes('swir')) return false;
    if (f.resolution && e.resolution_m) {
      const [lo, hi] = f.resolution;
      if (e.resolution_m.max < lo || e.resolution_m.min > hi) return false;
    }
    return true;
  });
}

/** True when the entry's notes have an expiry date before `today` (Date or ISO string). */
export function noteExpired(entry, today = new Date()) {
  if (!entry.note_expires) return false;
  const t = typeof today === 'string' ? today : today.toISOString().slice(0, 10);
  return entry.note_expires < t;
}
