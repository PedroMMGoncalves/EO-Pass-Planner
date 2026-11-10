/**
 * insar.js: candidate interferometric pairs for repeat-pass SAR (Sentinel-1, NISAR).
 *
 * Inputs:  predicted SAR passes (engine output) and, optionally, past
 *          Sentinel-1 acquisitions from STAC with relative orbits.
 * Outputs: tracks [{key, platforms[], direction, rel_orbit, incidence_deg,
 *          dates[ms], pairs[{a, b, days}]}], sorted by the shortest
 *          temporal baseline.
 *
 * Method: passes over the ROI belong to the same track (same orbit geometry)
 * when they share mission, direction, look geometry (cross-track position
 * within 10 km) and time of day (within 10 minutes); for Sentinel-1 the
 * relative orbit, when known, is used instead. Consecutive dates on a track
 * form pairs; Sentinel-1C and -1D share tracks 6 days apart.
 *
 * Limitations: only the temporal baseline is given. The perpendicular
 * baseline needs precise orbits and is not computed. Acquisition depends on
 * the observation scenario (check the ESA plan for Sentinel-1).
 */

const MISSION = (platform) => (/^Sentinel-1/i.test(platform) ? 'Sentinel-1' : platform);
const DAY = 86400000;

function timeOfDay(ms) {
  return (ms % DAY + DAY) % DAY;
}

function sameTrack(t, p) {
  if (t.mission !== MISSION(p.platform) || t.direction !== p.direction || t.sensor !== p.instrument.split(' ')[0]) return false;
  if (t.rel_orbit && p.rel_orbit) return t.rel_orbit === p.rel_orbit;
  const dtod = Math.abs(timeOfDay(t.ref) - timeOfDay(p.closest_utc));
  return Math.abs(t.cross - p.cross_track_km) < 10 && Math.min(dtod, DAY - dtod) < 10 * 60000;
}

/** Group SAR passes into tracks and list consecutive-date pairs. */
export function insarTracks(passes) {
  const tracks = [];
  for (const p of passes) {
    let t = tracks.find((x) => sameTrack(x, p));
    if (!t) {
      t = {
        mission: MISSION(p.platform), sensor: p.instrument.split(' ')[0], direction: p.direction,
        rel_orbit: p.rel_orbit ?? null, cross: p.cross_track_km, ref: p.closest_utc,
        incidence_deg: p.incidence_deg, passes: [],
      };
      tracks.push(t);
    }
    t.passes.push(p);
    if (!t.rel_orbit && p.rel_orbit) t.rel_orbit = p.rel_orbit;
  }
  for (const t of tracks) {
    t.passes.sort((a, b) => a.closest_utc - b.closest_utc);
    t.platforms = [...new Set(t.passes.map((p) => p.platform))];
    t.pairs = [];
    for (let i = 0; i + 1 < t.passes.length; i++) {
      const a = t.passes[i];
      const b = t.passes[i + 1];
      t.pairs.push({ a, b, days: Math.round((b.closest_utc - a.closest_utc) / DAY) });
    }
    t.minDays = t.pairs.length ? Math.min(...t.pairs.map((x) => x.days)) : Infinity;
  }
  return tracks.filter((t) => t.passes.length > 1).sort((a, b) => a.minDays - b.minDays || a.ref - b.ref);
}
