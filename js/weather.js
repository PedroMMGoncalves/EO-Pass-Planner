/**
 * weather.js: cloud cover at the ROI anchor at pass time, from Open-Meteo.
 *
 * Inputs:  ROI anchor {lat, lon}, window [startMs, endMs], passes.
 * Outputs: an hourly series {time[], total[], low[], mid[], high[], kind[]}
 *          and, per pass, cloud cover (%) linearly interpolated to the
 *          closest-approach time, labelled 'forecast' (future), 'analysis'
 *          (recent past, best-estimate model run) or 'reanalysis' (ERA5).
 *
 * Sources (free, no key, CORS enabled; checked 2026-11-10):
 * - Forecast API (best-match models, up to 16 days ahead, 92 days back):
 *   https://api.open-meteo.com/v1/forecast
 * - Archive API (ERA5 reanalysis, about 5 days behind real time):
 *   https://archive-api.open-meteo.com/v1/archive
 *
 * Limitations: a point value on a model grid (about 9-25 km) is not the cloud
 * cover of a satellite scene. Passes more than 16 days ahead get no value.
 * Cloud cover is irrelevant for SAR and lidar; the UI shows "n/a" for them.
 */

const FORECAST = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const DAY = 86400000;
const VARS = 'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high';

/** Instruments for which cloud cover matters (optical and thermal sensing). */
export function cloudRelevant(entry) {
  return !['sar', 'lidar_altimetry', 'geophysics'].includes(entry.categories[0]);
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function parse(json, kindOf) {
  const h = json.hourly;
  const time = h.time.map((s) => Date.parse(`${s}Z`));
  return {
    time,
    total: h.cloud_cover,
    low: h.cloud_cover_low ?? [],
    mid: h.cloud_cover_mid ?? [],
    high: h.cloud_cover_high ?? [],
    kind: time.map(kindOf),
  };
}

/** Fetch the hourly cloud series covering [startMs, endMs] (clipped to what the APIs offer). */
export async function fetchCloudSeries({ lat, lon }, startMs, endMs, now = Date.now(), fetchImpl = fetch) {
  const q = (base, params) => `${base}?${new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: VARS, timezone: 'UTC', ...params })}`;
  const series = [];
  // Old windows: ERA5 reanalysis up to five days ago.
  if (startMs < now - 92 * DAY) {
    const end = Math.min(endMs, now - 6 * DAY);
    const res = await fetchImpl(q(ARCHIVE, { start_date: isoDay(startMs), end_date: isoDay(end) }));
    if (!res.ok) throw new Error(`Open-Meteo archive: HTTP ${res.status}`);
    series.push(parse(await res.json(), () => 'reanalysis'));
  }
  // Recent past and future: forecast API with past_days.
  if (endMs > now - 92 * DAY && startMs < now + 16 * DAY) {
    const pastDays = Math.min(92, Math.max(0, Math.ceil((now - startMs) / DAY) + 1));
    const forecastDays = Math.min(16, Math.max(1, Math.ceil((endMs - now) / DAY) + 1));
    const res = await fetchImpl(q(FORECAST, { past_days: String(pastDays), forecast_days: String(forecastDays) }));
    if (!res.ok) throw new Error(`Open-Meteo forecast: HTTP ${res.status}`);
    series.push(parse(await res.json(), (t) => (t < now ? 'analysis' : 'forecast')));
  }
  return mergeSeries(series);
}

function mergeSeries(list) {
  const rows = new Map();
  for (const s of list) {
    s.time.forEach((t, i) => rows.set(t, [s.total[i], s.low[i], s.mid[i], s.high[i], s.kind[i]]));
  }
  const time = [...rows.keys()].sort((a, b) => a - b);
  const pick = (j) => time.map((t) => rows.get(t)[j]);
  return { time, total: pick(0), low: pick(1), mid: pick(2), high: pick(3), kind: pick(4) };
}

/** Linear interpolation of `values` at `ms`; null outside the series or across gaps > 3 h. */
export function interpolate(series, values, ms) {
  const t = series.time;
  if (!t.length || ms < t[0] || ms > t[t.length - 1]) return null;
  let i = 0;
  while (i + 1 < t.length && t[i + 1] < ms) i++;
  if (i + 1 >= t.length) return values[i] ?? null;
  const [a, b] = [values[i], values[i + 1]];
  if (a == null || b == null || t[i + 1] - t[i] > 3 * 3600000) return a ?? b ?? null;
  const f = (ms - t[i]) / (t[i + 1] - t[i]);
  return a + f * (b - a);
}

/** Cloud at a pass: {total, low, mid, high, kind} or null. */
export function cloudAt(series, ms) {
  if (!series) return null;
  const total = interpolate(series, series.total, ms);
  if (total == null) return null;
  const nearest = series.time.reduce((best, t, i) => (Math.abs(t - ms) < Math.abs(series.time[best] - ms) ? i : best), 0);
  return {
    total,
    low: interpolate(series, series.low, ms),
    mid: interpolate(series, series.mid, ms),
    high: interpolate(series, series.high, ms),
    kind: series.kind[nearest],
  };
}

/** Values every hour within ±hours of `ms` (for the pass sparkline). */
export function window(series, ms, hours = 3) {
  if (!series) return [];
  const out = [];
  for (let h = -hours; h <= hours; h++) {
    const v = interpolate(series, series.total, ms + h * 3600000);
    out.push({ h, v });
  }
  return out;
}
