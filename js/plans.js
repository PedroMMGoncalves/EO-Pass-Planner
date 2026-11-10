/**
 * plans.js: cross-check predicted Sentinel-1/-2 passes against ESA
 * acquisition plans (converted by the data workflow to data/plans/).
 *
 * Inputs:  catalogue entry (plan_source esa_s1_kml | esa_s2_kml), pass,
 *          plan FeatureCollections data/plans/{s1,s2}/<satellite>.geojson
 *          (features: Polygon or MultiPolygon; properties satellite, mode,
 *          start, stop; foreign member `plan.coverage`, the time intervals the
 *          published plans cover; see scripts/esa_plans.py).
 * Outputs: 'planned' (with mode), 'not_planned', or 'no_plan' per pass.
 *
 * Rule: a pass is planned when a plan segment of the same satellite contains
 * the ROI anchor and its time span contains the closest-approach time
 * (± 60 s). It is not planned when that time lies inside the plan coverage
 * but no segment contains the anchor. Otherwise there is no plan (outside the
 * published period, or plan files missing).
 *
 * Limitations: plans change; ESA republishes them and the workflow refreshes
 * them every 6 h. A planned segment can still be lost (anomalies, downlink).
 * Only the ROI anchor is tested, not the whole polygon.
 */

import { pointInPolygon } from './geometry.js';

const cache = new Map();
const SLACK = 60000;

/** "Sentinel-1C" → "S1C"; null for other platforms. */
export function planSatellite(entry) {
  const m = entry?.platform?.match(/^Sentinel-([12])([A-Z])$/);
  return m && entry.plan_source ? `S${m[1]}${m[2]}` : null;
}

export async function loadPlan(sat, fetchImpl = fetch) {
  if (cache.has(sat)) return cache.get(sat);
  const p = (async () => {
    try {
      const res = await fetchImpl(`data/plans/s${sat[1]}/${sat}.geojson`, { cache: 'no-cache' });
      if (!res.ok) return null;
      return prepare(await res.json());
    } catch {
      return null;
    }
  })();
  cache.set(sat, p);
  return p;
}

export function prepare(fc) {
  const segs = (fc.features ?? []).map((f) => ({
    start: Date.parse(f.properties.start),
    stop: Date.parse(f.properties.stop),
    mode: f.properties.mode ?? '',
    polys: f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates,
  })).filter((s) => Number.isFinite(s.start) && Number.isFinite(s.stop));
  const coverage = (fc.plan?.coverage ?? []).map(([a, b]) => [Date.parse(a), Date.parse(b)]);
  if (!segs.length && !coverage.length) return null;
  if (!coverage.length) coverage.push([Math.min(...segs.map((s) => s.start)), Math.max(...segs.map((s) => s.stop))]);
  // Nominal plan periods sometimes extend days past the last planned segment;
  // treat the time after the last segment as "no plan", not "not planned".
  const lastStop = segs.length ? Math.max(...segs.map((s) => s.stop)) : -Infinity;
  const clipped = coverage.map(([a, b]) => [a, Math.min(b, lastStop)]).filter(([a, b]) => b > a);
  return { segs, coverage: clipped };
}

/** Plan status of a pass: {status: 'planned'|'not_planned'|'no_plan', mode?} */
export function planStatus(plan, pass, anchor) {
  if (!plan) return { status: 'no_plan' };
  const t = pass.closest_utc;
  if (!plan.coverage.some(([a, b]) => t >= a - SLACK && t <= b + SLACK)) return { status: 'no_plan' };
  for (const s of plan.segs) {
    if (t < s.start - SLACK || t > s.stop + SLACK) continue;
    if (s.polys.some((poly) => pointInPolygon([anchor.lon, anchor.lat], poly))) return { status: 'planned', mode: s.mode };
  }
  return { status: 'not_planned' };
}

/** Attach plan_status to every pass of plan-capable entries (mutates the passes). */
export async function annotatePlans(passes, entriesById, anchor, fetchImpl = fetch) {
  const sats = new Set();
  for (const p of passes) {
    const sat = planSatellite(entriesById[p.entry_id] ?? {});
    if (sat) sats.add(sat);
  }
  const plans = Object.fromEntries(await Promise.all([...sats].map(async (s) => [s, await loadPlan(s, fetchImpl)])));
  for (const p of passes) {
    const sat = planSatellite(entriesById[p.entry_id] ?? {});
    if (sat) p.plan = planStatus(plans[sat], p, anchor);
  }
}
