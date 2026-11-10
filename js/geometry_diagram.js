/**
 * geometry_diagram.js: cross-section of one pass, drawn to scale (SVG).
 *
 * Inputs:  pass (altitude_km, cross_track_km, view_angle_deg, incidence_deg,
 *          sun_elevation_deg), the instrument's cross-track intervals (km,
 *          positive = right of track), colours and labels.
 * Outputs: an SVG string. The view looks along the flight direction: left of
 *          track on the left. Earth curvature, altitude, swath and ROI offset
 *          share one scale.
 *
 * Limitations: a schematic plane section through the satellite perpendicular
 * to the track; the Earth is a sphere (R = 6371 km) and terrain is ignored.
 * Sun elevation is given as a value, not drawn in the section.
 */

const R = 6371;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * @param {object} p        pass
 * @param {number[][]} intervals  cross-track intervals in km
 * @param {object} o        { colour, ink, soft, labels: {left, right, nadir, roi, alt, offset, view, inc, sun} }
 */
export function geometryDiagram(p, intervals, o) {
  const W = 380;
  const H = 210;
  const pad = 26;
  const h = p.altitude_km;
  const extent = Math.max(...intervals.flat().map(Math.abs), Math.abs(p.cross_track_km), 50);
  const span = extent * 1.18;
  const k = Math.min((W - 2 * pad) / (2 * span), (H - 2 * pad - 18) / (h * 1.12));
  const cx = W / 2;
  const base = H - pad;
  const drop = (x) => R - Math.sqrt(Math.max(0, R * R - x * x)); // surface below the tangent plane
  const X = (x) => cx + x * k;
  const Y = (y) => base - y * k;
  const surf = (x) => [X(x), Y(-drop(x))];
  const sat = [X(0), Y(h)];

  // Ground arc
  const arc = [];
  for (let x = -span; x <= span; x += span / 40) arc.push(surf(x).map((v) => v.toFixed(1)).join(','));
  const ground = `<polyline points="${arc.join(' ')}" fill="none" stroke="${o.soft}" stroke-width="1.5"/>`;

  // Swath intervals: beam wedge from the satellite and a thick segment on the ground.
  const swaths = intervals.map(([a, b]) => {
    const pts = [];
    for (let x = a; x <= b; x += Math.max((b - a) / 20, 0.001)) pts.push(surf(x));
    pts.push(surf(b));
    const wedge = [sat, ...pts].map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ');
    const seg = pts.map((q) => q.map((v) => v.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${wedge}" fill="${o.colour}" fill-opacity="0.16" stroke="none"/>`
      + `<polyline points="${seg}" fill="none" stroke="${o.colour}" stroke-width="5" stroke-linecap="butt"/>`;
  }).join('');

  // Nadir and line of sight to the ROI
  const nadir = surf(0);
  const roi = surf(p.cross_track_km);
  const lines = `<line x1="${sat[0]}" y1="${sat[1]}" x2="${nadir[0]}" y2="${nadir[1]}" stroke="${o.soft}" stroke-dasharray="2 3"/>`
    + `<line x1="${sat[0]}" y1="${sat[1]}" x2="${roi[0].toFixed(1)}" y2="${roi[1].toFixed(1)}" stroke="${o.ink}" stroke-width="1.2" stroke-dasharray="5 3"/>`;

  // Markers
  const satMark = `<rect x="${sat[0] - 5}" y="${sat[1] - 4}" width="10" height="8" fill="${o.colour}" stroke="${o.ink}"/>`
    + `<line x1="${sat[0] - 12}" y1="${sat[1]}" x2="${sat[0] + 12}" y2="${sat[1]}" stroke="${o.ink}"/>`;
  const roiMark = `<path d="M${roi[0].toFixed(1)},${(roi[1] - 2).toFixed(1)} l-5,-10 h10 z" fill="${o.ink}"/>`;

  // Labels
  const t = (x, y, s, anchor = 'middle', cls = '') => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" class="${cls}">${esc(s)}</text>`;
  const L = o.labels;
  const labels = [
    t(pad - 6, 14, L.left, 'start', 'soft'),
    t(W - pad + 6, 14, L.right, 'end', 'soft'),
    t(sat[0] + 16, sat[1] + 4, `${Math.round(h)} km`, 'start'),
    t(roi[0], roi[1] - 15, L.roi),
    t(cx, base + 18, `${L.offset} ${Math.abs(p.cross_track_km).toFixed(1)} km · ${L.view} ${p.view_angle_deg.toFixed(1)}° · ${L.inc} ${p.incidence_deg.toFixed(1)}° · ${L.sun} ${p.sun_elevation_deg.toFixed(0)}°`),
  ].join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H + 6}" class="geom-diagram" role="img" aria-label="${esc(L.aria)}">`
    + ground + swaths + lines + satMark + roiMark + labels + '</svg>';
}
