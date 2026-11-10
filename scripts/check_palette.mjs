// check_palette.mjs: colour-vision-deficiency check of the category palette.
//
// Inputs:  CATEGORY_STYLE from js/catalogue.js (light and dark themes).
// Outputs: for normal vision and simulated protanopia, deuteranopia and
//          tritanopia, the smallest CIELAB ΔE (CIE76) between any two distinct
//          category colours, and the contrast of each colour against the page
//          background; exit code 1 if a pair falls below MIN_DE.
// Method:  Machado, Oliveira & Fernandes (2009) simulation matrices at
//          severity 1.0, applied in linear sRGB; ΔE in CIELAB (D65).
// Limitations: ΔE76 is a coarse perceptual distance; marker shapes back up
//          colour on the globe and in lists, so a moderate ΔE is acceptable.
// Usage:   node scripts/check_palette.mjs

import { CATEGORY_STYLE } from '../js/catalogue.js';

const MIN_DE = 12;
const BG = { light: '#E9EEF0', dark: '#282A36' };
const M = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const mul = (m, v) => m.map((r) => Math.min(1, Math.max(0, r[0] * v[0] + r[1] * v[1] + r[2] * v[2])));
function lab(rgbLin) {
  const [r, g, b] = rgbLin;
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const lum = (rgbLin) => 0.2126 * rgbLin[0] + 0.7152 * rgbLin[1] + 0.0722 * rgbLin[2];
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

let fail = false;
for (const theme of ['light', 'dark']) {
  const cols = {};
  for (const [cat, s] of Object.entries(CATEGORY_STYLE)) cols[s[theme]] = (cols[s[theme]] ?? []).concat(cat);
  const list = Object.entries(cols);
  console.log(`\n${theme} theme (${list.length} distinct colours)`);
  for (const [name, m] of Object.entries(M)) {
    let worst = { d: Infinity };
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = lab(mul(m, hex(list[i][0]).map(lin)));
        const b = lab(mul(m, hex(list[j][0]).map(lin)));
        const d = dE(a, b);
        if (d < worst.d) worst = { d, pair: `${list[i][1][0]} ${list[i][0]} / ${list[j][1][0]} ${list[j][0]}` };
      }
    }
    const flag = worst.d < MIN_DE ? '  <-- below threshold' : '';
    if (worst.d < MIN_DE) fail = true;
    console.log(`  ${name.padEnd(13)} min ΔE ${worst.d.toFixed(1).padStart(5)}  (${worst.pair})${flag}`);
  }
  const bg = hex(BG[theme]).map(lin);
  console.log('  contrast vs background:', list.map(([c, cats]) => `${cats[0]} ${contrast(hex(c).map(lin), bg).toFixed(1)}`).join(', '));
}
process.exit(fail ? 1 : 0);
