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

/**
 * Category colour (spectral region) and marker shape. Colour encodes the part
 * of the spectrum sensed. The hex values are provisional until checked with a
 * colour-vision-deficiency simulator.
 */
export const CATEGORY_STYLE = {
  optical_multispectral: { colour: '#1F7A8C', shape: 'circle' },
  optical_vhr: { colour: '#1F7A8C', shape: 'circle' },
  hyperspectral: { colour: '#1F7A8C', colour2: '#C98A1B', shape: 'circle-stripe' },
  thermal: { colour: '#C2412D', shape: 'triangle' },
  sar: { colour: '#6B4FA0', shape: 'diamond' },
  lidar_altimetry: { colour: '#2E8B3E', shape: 'bar' },
  meteo_polar: { colour: '#6C7A86', shape: 'square' },
  meteo_geo: { colour: '#6C7A86', shape: 'square' },
  atmosphere: { colour: '#6C7A86', shape: 'square' },
  geophysics: { colour: '#8C6E4F', shape: 'cross' },
};

/** Style of an entry: that of its first (primary) category. */
export const entryStyle = (e) => CATEGORY_STYLE[e.categories[0]] ?? CATEGORY_STYLE.meteo_polar;

/** Short platform label for the globe ("Sentinel-2C" → "S2C", "Landsat 9" → "L9"). */
export function shortName(e) {
  const p = e.platform;
  let m = p.match(/^Sentinel-(\d)([A-Z])$/);
  if (m) return `S${m[1]}${m[2]}`;
  m = p.match(/^Landsat (\d+)$/);
  if (m) return `L${m[1]}`;
  return p;
}
