/**
 * weather.js: cloud cover and atmospheric conditions at the ROI anchor at pass
 * time, from Open-Meteo.
 *
 * Inputs:  ROI anchor {lat, lon}, window [startMs, endMs].
 * Outputs: an hourly series {time[], vars{name: []}, kind[], upperHeight,
 *          soilDepth} and, per pass, interpolated values: cloud cover
 *          (total/low/mid/high), aerosol optical depth at 550 nm and dust,
 *          total column water vapour, direct and diffuse radiation,
 *          visibility, wind (10 m, upper level, gusts), precipitation (at the
 *          pass and accumulated over the previous 24 and 48 h), precipitation
 *          probability, humidity, temperature, soil moisture and snow depth.
 *          Each value is labelled 'forecast' (future), 'analysis' (recent past,
 *          best-estimate model run) or 'reanalysis' (ERA5).
 *
 * Sources (free, no key, CORS enabled; checked 2026-11-10):
 * - Forecast API (best-match models, up to 16 days ahead, 92 days back):
 *   https://api.open-meteo.com/v1/forecast
 * - Archive API (ERA5 reanalysis, about 5 days behind real time):
 *   https://archive-api.open-meteo.com/v1/archive
 *   (upper wind at 100 m instead of 80 m; soil moisture 0-7 cm instead of
 *   0-1 cm; no visibility or precipitation probability)
 * - Air-quality API (CAMS; aerosol optical depth and dust, 5 days ahead,
 *   92 days back): https://air-quality-api.open-meteo.com/v1/air-quality
 *
 * Limitations: point values on model grids (about 9-40 km) are not the state
 * of a satellite scene. Passes more than 16 days ahead get no values; aerosol
 * values only within 5 days ahead and 92 days back. Model soil moisture is
 * indicative only.
 */

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const DAY = 86400000;
const HOUR = 3600000;

// API variable → canonical name, per source.
const FORECAST_VARS = {
  cloud_cover: 'cloud', cloud_cover_low: 'cloud_low', cloud_cover_mid: 'cloud_mid', cloud_cover_high: 'cloud_high',
  precipitation: 'precip', precipitation_probability: 'precip_prob', visibility: 'visibility',
  wind_speed_10m: 'wind10', wind_gusts_10m: 'gust', wind_speed_80m: 'wind_upper',
  relative_humidity_2m: 'rh', temperature_2m: 'temp', direct_radiation: 'direct', diffuse_radiation: 'diffuse',
  total_column_integrated_water_vapour: 'tcwv', soil_moisture_0_to_1cm: 'soil', snow_depth: 'snow',
};
const ARCHIVE_VARS = {
  cloud_cover: 'cloud', cloud_cover_low: 'cloud_low', cloud_cover_mid: 'cloud_mid', cloud_cover_high: 'cloud_high',
  precipitation: 'precip', wind_speed_10m: 'wind10', wind_gusts_10m: 'gust', wind_speed_100m: 'wind_upper',
  relative_humidity_2m: 'rh', temperature_2m: 'temp', direct_radiation: 'direct', diffuse_radiation: 'diffuse',
  total_column_integrated_water_vapour: 'tcwv', soil_moisture_0_to_7cm: 'soil', snow_depth: 'snow',
};
const AIR_VARS = { aerosol_optical_depth: 'aod', dust: 'dust' };

/** Cloud cover matters for optical and thermal sensing and for laser altimetry. */
export function cloudRelevant(entry) {
  const cat = entry?.categories?.[0];
  if (cat === 'sar' || cat === 'geophysics') return false;
  if (cat === 'lidar_altimetry') return /ATLAS|GEDI/i.test(entry.instrument ?? '');
  return true;
}

/** Which atmospheric block to show: 'optical' | 'thermal' | 'sar' | 'laser' | null. */
export function atmosphereKind(entry) {
  const cat = entry?.categories?.[0];
  if (cat === 'sar') return 'sar';
  if (cat === 'thermal') return 'thermal';
  if (cat === 'lidar_altimetry') return /ATLAS|GEDI/i.test(entry.instrument ?? '') ? 'laser' : null;
  if (cat === 'geophysics' || cat === 'meteo_geo') return null;
  return 'optical';
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function parse(json, map, kindOf) {
  const h = json.hourly ?? {};
  const time = (h.time ?? []).map((s) => Date.parse(`${s}Z`));
  const vars = {};
  for (const [api, name] of Object.entries(map)) if (h[api]) vars[name] = h[api];
  return { time, vars, kind: time.map(kindOf) };
}

/** Merge series; later sources overwrite earlier ones at the same hour, variable by variable. */
export function mergeSeries(list) {
  const rows = new Map();
  for (const s of list) {
    s.time.forEach((t, i) => {
      const r = rows.get(t) ?? { vars: {}, kind: s.kind[i] };
      for (const [k, arr] of Object.entries(s.vars)) if (arr[i] != null) r.vars[k] = arr[i];
      if (s.kind[i] && !s.aux) r.kind = s.kind[i];
      rows.set(t, r);
    });
  }
  const time = [...rows.keys()].sort((a, b) => a - b);
  const names = new Set(list.flatMap((s) => Object.keys(s.vars)));
  const vars = {};
  for (const n of names) vars[n] = time.map((t) => rows.get(t).vars[n] ?? null);
  return { time, vars, kind: time.map((t) => rows.get(t).kind) };
}

/**
 * Fetch hourly weather (forecast or archive) and aerosol series covering
 * [startMs, endMs]. The aerosol request may fail without failing the whole.
 */
export async function fetchAtmosphere({ lat, lon }, startMs, endMs, now = Date.now(), fetchImpl = fetch) {
  const q = (base, vars, params) => `${base}?${new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: Object.keys(vars).join(','), timezone: 'UTC', ...params })}`;
  const get = async (url, label) => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Open-Meteo ${label}: HTTP ${res.status}`);
    return res.json();
  };
  const jobs = [];
  let upperHeight = 80;
  let soilDepth = '0-1 cm';
  if (startMs < now - 92 * DAY) {
    const end = Math.min(endMs, now - 6 * DAY);
    upperHeight = 100;
    soilDepth = '0-7 cm';
    jobs.push(get(q(ARCHIVE, ARCHIVE_VARS, { start_date: isoDay(startMs - 2 * DAY), end_date: isoDay(end) }), 'archive')
      .then((j) => parse(j, ARCHIVE_VARS, () => 'reanalysis')));
  }
  if (endMs > now - 92 * DAY && startMs < now + 16 * DAY) {
    const pastDays = Math.min(92, Math.max(0, Math.ceil((now - startMs) / DAY) + 3));
    const forecastDays = Math.min(16, Math.max(1, Math.ceil((endMs - now) / DAY) + 1));
    jobs.push(get(q(FORECAST, FORECAST_VARS, { past_days: String(pastDays), forecast_days: String(forecastDays) }), 'forecast')
      .then((j) => parse(j, FORECAST_VARS, (t) => (t < now ? 'analysis' : 'forecast'))));
  }
  if (!jobs.length) throw new Error('window outside the Open-Meteo range');
  const weather = await Promise.all(jobs);
  let air = null;
  if (endMs > now - 92 * DAY && startMs < now + 5 * DAY) {
    try {
      const pastDays = Math.min(92, Math.max(0, Math.ceil((now - startMs) / DAY) + 1));
      const j = await get(q(AIR, AIR_VARS, { past_days: String(pastDays), forecast_days: '5' }), 'air quality');
      air = { ...parse(j, AIR_VARS, () => null), aux: true };
    } catch { /* aerosols are optional */ }
  }
  const series = mergeSeries(air ? [...weather, air] : weather);
  series.upperHeight = upperHeight;
  series.soilDepth = soilDepth;
  return series;
}

/** Kept for compatibility: the cloud part of fetchAtmosphere. */
export const fetchCloudSeries = fetchAtmosphere;

/** Linear interpolation of variable `name` at `ms`; null outside the series or across gaps > 3 h. */
export function valueAt(series, name, ms) {
  const t = series?.time;
  const v = series?.vars?.[name];
  if (!t?.length || !v || ms < t[0] || ms > t[t.length - 1]) return null;
  let i = 0;
  while (i + 1 < t.length && t[i + 1] < ms) i++;
  if (i + 1 >= t.length) return v[i] ?? null;
  const [a, b] = [v[i], v[i + 1]];
  if (a == null || b == null || t[i + 1] - t[i] > 3 * HOUR) return a ?? b ?? null;
  return a + ((ms - t[i]) / (t[i + 1] - t[i])) * (b - a);
}

/** Back-compatible interpolation over an explicit value array (used by tests and the sparkline). */
export function interpolate(series, values, ms) {
  return valueAt({ time: series.time, vars: { x: values } }, 'x', ms);
}

/** Sum of hourly values of `name` in (ms - hours, ms]; null if the period is not fully covered. */
export function sumBefore(series, name, ms, hours) {
  const t = series?.time;
  const v = series?.vars?.[name];
  if (!t?.length || !v || t[0] > ms - hours * HOUR + HOUR || t[t.length - 1] < ms - HOUR) return null;
  let s = 0;
  for (let i = 0; i < t.length; i++) if (t[i] > ms - hours * HOUR && t[i] <= ms && v[i] != null) s += v[i];
  return s;
}

function kindAt(series, ms) {
  let best = 0;
  series.time.forEach((t, i) => { if (Math.abs(t - ms) < Math.abs(series.time[best] - ms)) best = i; });
  return series.kind[best];
}

/** Cloud at a pass: {total, low, mid, high, kind} or null. */
export function cloudAt(series, ms) {
  if (!series) return null;
  const total = valueAt(series, 'cloud', ms);
  if (total == null) return null;
  return {
    total,
    low: valueAt(series, 'cloud_low', ms),
    mid: valueAt(series, 'cloud_mid', ms),
    high: valueAt(series, 'cloud_high', ms),
    kind: kindAt(series, ms),
  };
}

/** All atmospheric values at a pass (null members where unavailable). */
export function atmosphereAt(series, ms) {
  if (!series) return null;
  const v = (n) => valueAt(series, n, ms);
  const direct = v('direct');
  const diffuse = v('diffuse');
  return {
    kind: kindAt(series, ms),
    aod: v('aod'),
    dust: v('dust'),
    tcwv: v('tcwv'),
    direct,
    diffuse,
    direct_fraction: direct != null && diffuse != null && direct + diffuse > 20 ? direct / (direct + diffuse) : null,
    visibility_km: v('visibility') == null ? null : v('visibility') / 1000,
    wind10: v('wind10'),
    wind_upper: v('wind_upper'),
    upper_height: series.upperHeight ?? 80,
    gust: v('gust'),
    precip: v('precip'),
    precip_24h: sumBefore(series, 'precip', ms, 24),
    precip_48h: sumBefore(series, 'precip', ms, 48),
    precip_prob: v('precip_prob'),
    rh: v('rh'),
    temp: v('temp'),
    soil: v('soil'),
    soil_depth: series.soilDepth ?? '0-1 cm',
    snow: v('snow'),
  };
}

/** Hourly rows covering [fromMs, toMs] for the drone window. */
export function hourlyRows(series, fromMs, toMs) {
  if (!series) return [];
  const rows = [];
  for (let t = Math.floor(fromMs / HOUR) * HOUR; t <= Math.ceil(toMs / HOUR) * HOUR; t += HOUR) {
    const i = series.time.indexOf(t);
    if (i < 0) continue;
    const g = (n) => series.vars[n]?.[i] ?? null;
    rows.push({ t, wind10: g('wind10'), wind_upper: g('wind_upper'), gust: g('gust'), precip_prob: g('precip_prob'), precip: g('precip'), visibility_km: g('visibility') == null ? null : g('visibility') / 1000, temp: g('temp') });
  }
  return rows;
}

/** Cloud values every hour within ±hours of `ms` (for the pass sparkline). */
export function window(series, ms, hours = 3) {
  if (!series) return [];
  const out = [];
  for (let h = -hours; h <= hours; h++) out.push({ h, v: valueAt(series, 'cloud', ms + h * HOUR) });
  return out;
}
