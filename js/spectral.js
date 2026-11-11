/**
 * spectral.js: spectral ruler (SVG). Bands of the selected instruments on a
 * logarithmic wavelength axis, with diagnostic absorption features.
 *
 * Inputs:  data/bands.json {groups: [{ids, label, bands[{name, center_um,
 *          width_um}], ranges[{from_um, to_um, label}], microwave[{name,
 *          freq_ghz}], laser[{name, center_um}], sources, unverified}],
 *          absorption_features[{label, center_um, range_um, source}]}; the
 *          selected catalogue entries; colours; the highlighted entry id.
 * Outputs: an SVG element.
 *
 * Axis: two logarithmic segments, 0.3–20 µm (optical and thermal infrared,
 * 72 % of the width) and 0.5–30 cm (microwave), with a break between them.
 * Microwave wavelength = c / f.
 *
 * Limitations: bands are drawn by centre and full width at half maximum;
 * spectral response shapes are not shown. Absorption positions are typical
 * values; real positions shift with composition and grain size.
 */

const C_CM_GHZ = 29.9792458; // speed of light in cm·GHz

const OPT = { min: 0.3, max: 20 }; // µm
const MW = { min: 0.5, max: 30 }; // cm

export function wavelengthCm(freqGhz) {
  return C_CM_GHZ / freqGhz;
}

const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻' };
const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };

/** Chemical notation for a feature's short label: "Fe3+" -> "Fe³⁺", "CO3" -> "CO₃". */
export function chemLabel(s) {
  return s
    .replace(/([A-Z][a-z]?)(\d)([+-])/g, (_, el, n, q) => el + SUP[n] + SUP[q])
    .replace(/([A-Z][a-z]?)(\d)(?![\d.])/g, (_, el, n) => el + SUB[n]);
}

/**
 * Stack labels centred at x into the fewest rows without overlaps (greedy,
 * left to right). Items: {x, w}; returns the row index of each item.
 */
export function stackLabels(items, pad = 4) {
  const ends = [];
  const order = items.map((it, i) => i).sort((a, b) => items[a].x - items[b].x);
  const rows = new Array(items.length);
  for (const i of order) {
    const { x, w } = items[i];
    let r = ends.findIndex((e) => x - w / 2 >= e + pad);
    if (r < 0) { r = ends.length; ends.push(-Infinity); }
    ends[r] = x + w / 2;
    rows[i] = r;
  }
  return rows;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Build the ruler as an SVG string. */
export function spectralRuler(bands, entries, { colourOf, highlightId, t, labelW = 170, width = 980 }) {
  const groups = [];
  for (const g of bands.groups ?? []) {
    const members = entries.filter((e) => g.ids.includes(e.id));
    if (members.length) groups.push({ g, e: members[0], ids: members.map((m) => m.id) });
  }
  if (!groups.length) return null;
  const rowH = 18;
  const top = 64;
  const plotW = width - labelW - 16;
  const optW = plotW * 0.72;
  const gap = 18;
  const mwW = plotW - optW - gap;
  const x0 = labelW;
  const xOpt = (um) => x0 + (Math.log10(um / OPT.min) / Math.log10(OPT.max / OPT.min)) * optW;
  const xMw = (cm) => x0 + optW + gap + (Math.log10(cm / MW.min) / Math.log10(MW.max / MW.min)) * mwW;
  const clampOpt = (um) => Math.min(OPT.max, Math.max(OPT.min, um));
  // Absorption feature labels: stacked in rows so that close features do not overlap.
  const LABEL_ROW = 11;
  const feats = (bands.absorption_features ?? []).filter((f) => (f.range_um ?? [f.center_um])[0] <= OPT.max).map((f) => {
    const [a, b] = f.range_um ?? [f.center_um, f.center_um];
    const xa = xOpt(clampOpt(a));
    const xb = xOpt(clampOpt(b));
    const text = chemLabel(f.label.split(' (')[0]);
    return { f, xa, xb, x: f.center_um ? xOpt(f.center_um) : (xa + xb) / 2, text, w: text.length * 5.2 };
  });
  const labelRow = stackLabels(feats);
  const extra = (Math.max(0, ...labelRow) ) * LABEL_ROW;
  const height = top + groups.length * rowH + 44 + extra;
  const parts = [];

  // Spectral region shading and axis ticks
  const regions = [[0.3, 0.4, 'UV'], [0.4, 0.7, 'VIS'], [0.7, 1.4, 'NIR'], [1.4, 3, 'SWIR'], [3, 8, 'MWIR'], [8, 15, 'TIR']];
  for (const [a, b, name] of regions) {
    parts.push(`<rect x="${xOpt(a).toFixed(1)}" y="${top - 6}" width="${(xOpt(b) - xOpt(a)).toFixed(1)}" height="${height - top - 18}" class="sr-region"/>`);
    parts.push(`<text x="${((xOpt(a) + xOpt(b)) / 2).toFixed(1)}" y="${top - 10}" class="sr-region-label">${name}</text>`);
  }
  parts.push(`<text x="${(x0 + optW + gap + mwW / 2).toFixed(1)}" y="${top - 10}" class="sr-region-label">${esc(t('sr_microwave'))}</text>`);
  const ticksOpt = [0.4, 0.5, 0.7, 1, 1.5, 2, 3, 5, 8, 10, 15];
  for (const v of ticksOpt) {
    parts.push(`<line x1="${xOpt(v).toFixed(1)}" y1="${height - 22}" x2="${xOpt(v).toFixed(1)}" y2="${height - 17}" class="sr-tick"/>`);
    parts.push(`<text x="${xOpt(v).toFixed(1)}" y="${height - 6}" class="sr-tick-label">${v}</text>`);
  }
  parts.push(`<text x="${x0 + optW - 2}" y="${height - 6}" class="sr-tick-label" text-anchor="end">µm</text>`);
  for (const v of [1, 3, 10, 25]) {
    parts.push(`<line x1="${xMw(v).toFixed(1)}" y1="${height - 22}" x2="${xMw(v).toFixed(1)}" y2="${height - 17}" class="sr-tick"/>`);
    parts.push(`<text x="${xMw(v).toFixed(1)}" y="${height - 6}" class="sr-tick-label">${v}</text>`);
  }
  // The unit sits past the last tick (25 cm is close to the end of the axis).
  parts.push(`<text x="${x0 + plotW + 3}" y="${height - 6}" class="sr-tick-label" style="text-anchor: start">cm</text>`);
  // Axis break
  const xb = x0 + optW + gap / 2;
  parts.push(`<path d="M${xb - 4},${height - 26} l4,-8 M${xb},${height - 26} l4,-8" class="sr-tick"/>`);

  // Absorption features
  const rowsBottom = top + groups.length * rowH;
  feats.forEach(({ f, xa, xb, x, text }, i) => {
    const w = Math.max(1.5, xb - xa);
    parts.push(`<rect x="${xa.toFixed(1)}" y="${top - 2}" width="${w.toFixed(1)}" height="${groups.length * rowH + 4}" class="sr-feature"><title>${esc(f.label)}</title></rect>`);
    if (f.center_um) parts.push(`<line x1="${x.toFixed(1)}" y1="${top - 2}" x2="${x.toFixed(1)}" y2="${rowsBottom + 2}" class="sr-feature-line"/>`);
    const y = rowsBottom + 13 + labelRow[i] * LABEL_ROW;
    // Labels moved to a lower row keep a leader to their feature.
    if (labelRow[i] > 0) parts.push(`<line x1="${x.toFixed(1)}" y1="${rowsBottom + 2}" x2="${x.toFixed(1)}" y2="${y - 8}" class="sr-feature-line"/>`);
    parts.push(`<text x="${x.toFixed(1)}" y="${y}" class="sr-feature-label">${esc(text)}<title>${esc(f.label)}</title></text>`);
  });

  // Rows
  groups.forEach(({ g, e, ids }, i) => {
    const y = top + i * rowH;
    const colour = colourOf(e);
    const hl = ids.includes(highlightId);
    parts.push(`<g class="sr-row${hl ? ' is-highlight' : ''}">`);
    if (hl) parts.push(`<rect x="0" y="${y}" width="${width}" height="${rowH}" class="sr-hl"/>`);
    parts.push(`<text x="${labelW - 8}" y="${y + rowH * 0.68}" text-anchor="end" class="sr-label">${esc(g.label)}${g.unverified ? ' *' : ''}</text>`);
    parts.push(`<line x1="${x0}" y1="${y + rowH / 2}" x2="${x0 + plotW}" y2="${y + rowH / 2}" class="sr-baseline"/>`);
    for (const r of g.ranges ?? []) {
      const a = xOpt(clampOpt(r.from_um));
      const b = xOpt(clampOpt(r.to_um));
      parts.push(`<rect x="${a.toFixed(1)}" y="${y + 4}" width="${Math.max(1, b - a).toFixed(1)}" height="${rowH - 8}" fill="${colour}" fill-opacity="0.35" stroke="${colour}"><title>${esc(`${g.label}: ${r.label ?? ''} ${r.from_um}–${r.to_um} µm`)}</title></rect>`);
    }
    for (const bd of g.bands ?? []) {
      if (!(bd.center_um > 0)) continue;
      const w = bd.width_um > 0 ? bd.width_um : 0.01;
      const a = xOpt(clampOpt(bd.center_um - w / 2));
      const b = xOpt(clampOpt(bd.center_um + w / 2));
      parts.push(`<rect x="${a.toFixed(1)}" y="${y + 3}" width="${Math.max(1.5, b - a).toFixed(1)}" height="${rowH - 6}" fill="${colour}"><title>${esc(`${bd.name}: ${bd.center_um} µm (${w} µm)`)}</title></rect>`);
    }
    for (const l of g.laser ?? []) {
      parts.push(`<rect x="${(xOpt(l.center_um) - 1).toFixed(1)}" y="${y + 1}" width="2.5" height="${rowH - 2}" fill="${colour}"><title>${esc(`${l.name}`)}</title></rect>`);
    }
    for (const m of g.microwave ?? []) {
      const cm = wavelengthCm(m.freq_ghz);
      if (cm < MW.min || cm > MW.max) continue;
      const x = xMw(cm);
      parts.push(`<path d="M${x.toFixed(1)},${y + 3} l5,${rowH / 2 - 3} l-5,${rowH / 2 - 3} l-5,${-(rowH / 2 - 3)} z" fill="${colour}"><title>${esc(`${m.name}: ${m.freq_ghz} GHz, ${cm.toFixed(1)} cm`)}</title></path>`);
    }
    parts.push('</g>');
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" class="spectral-ruler" role="img" aria-label="${esc(t('tab_spectral'))}">${parts.join('')}</svg>`;
}
