/**
 * calendar.js: revisit matrix (instruments × local days) for the computed window.
 *
 * Inputs:  passes (expected imaging), catalogue entries, ROI time zone, window
 *          [startMs, endMs], colour function, cloud lookup, selection callback.
 * Outputs: DOM in the given container: one row per instrument (grouped by
 *          category), one column per local day. A cell's fill opacity is
 *          proportional to ROI coverage; tasked opportunities are outlined,
 *          not filled; forecast cloud is a hatch whose density grows with
 *          cloud cover. Each cell is a button (keyboard and screen reader
 *          accessible) that selects the best pass of that day.
 *
 * Limitations: one cell per day shows the pass with the highest coverage;
 * other passes on the same day are listed in its tooltip and in the table.
 * Built with HTML/CSS (no chart library) so that the instrument column can
 * stay fixed while the days scroll.
 */

const DAY = 86400000;

function dayKey(ms, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * @param {HTMLElement} el
 * @param {object} o { passes, entries, categories, tz, startMs, endMs, colourOf, cloudOf, onSelect,
 *                     selectedId, t, formatTime, dayLabel, nameOf }
 */
export function renderCalendar(el, o) {
  el.replaceChildren();
  const days = [];
  const seen = new Set();
  for (let ms = o.startMs; ms <= o.endMs + DAY; ms += 3600000 * 6) {
    const k = dayKey(ms, o.tz);
    if (!seen.has(k) && ms <= o.endMs) { seen.add(k); days.push({ key: k, ms }); }
  }
  const byEntry = new Map();
  for (const p of o.passes) {
    if (!byEntry.has(p.entry_id)) byEntry.set(p.entry_id, new Map());
    const m = byEntry.get(p.entry_id);
    const k = dayKey(p.closest_utc, o.tz);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(p);
  }
  if (!byEntry.size) return false;

  const grid = document.createElement('div');
  grid.className = 'cal';
  grid.style.gridTemplateColumns = `minmax(9rem, max-content) repeat(${days.length}, minmax(1.6rem, 1fr))`;
  grid.setAttribute('role', 'grid');

  const head = (text, cls = '') => {
    const d = document.createElement('div');
    d.className = `cal-head ${cls}`;
    d.setAttribute('role', 'columnheader');
    d.textContent = text;
    return d;
  };
  grid.append(head('', 'cal-corner'));
  for (const d of days) grid.append(head(o.dayLabel(d.ms), new Date(d.ms).getUTCDay() % 6 === 0 ? 'cal-weekend' : ''));

  for (const cat of o.categories) {
    const entries = o.entries.filter((e) => e.categories[0] === cat && byEntry.has(e.id));
    if (!entries.length) continue;
    const g = document.createElement('div');
    g.className = 'cal-group';
    g.style.gridColumn = `1 / span ${days.length + 1}`;
    g.textContent = o.t(`cat_${cat}`);
    grid.append(g);
    for (const e of entries) {
      const name = document.createElement('div');
      name.className = 'cal-name';
      name.setAttribute('role', 'rowheader');
      name.textContent = o.nameOf(e);
      grid.append(name);
      const [r, gr, b] = hexToRgb(o.colourOf(e));
      for (const d of days) {
        const list = byEntry.get(e.id).get(d.key) ?? [];
        const cell = document.createElement(list.length ? 'button' : 'div');
        cell.className = 'cal-cell';
        cell.setAttribute('role', 'gridcell');
        if (list.length) {
          const best = list.reduce((a, x) => (x.coverage_pct > a.coverage_pct ? x : a));
          const alpha = 0.25 + 0.75 * Math.min(1, best.coverage_pct / 100);
          const layers = [];
          const cloud = o.cloudOf(best);
          if (cloud != null && cloud > 5) {
            const gap = Math.max(2, Math.round(9 - cloud / 14)); // denser hatch for more cloud
            layers.push(`repeating-linear-gradient(135deg, rgba(0,0,0,0.45) 0 1px, transparent 1px ${gap}px)`);
          }
          if (best.opportunity) {
            cell.classList.add('is-opportunity');
            cell.style.borderColor = `rgb(${r},${gr},${b})`;
          } else {
            layers.push(`linear-gradient(rgba(${r},${gr},${b},${alpha.toFixed(2)}), rgba(${r},${gr},${b},${alpha.toFixed(2)}))`);
          }
          cell.style.background = layers.join(', ');
          cell.type = 'button';
          cell.dataset.id = best.id;
          if (best.id === o.selectedId) cell.classList.add('is-selected');
          const desc = list.map((p) => `${o.formatTime(p.closest_utc, o.tz)} ${Math.round(p.coverage_pct)} %${o.cloudOf(p) != null ? `, ${o.t('cloud_short', { v: Math.round(o.cloudOf(p)) })}` : ''}${p.opportunity ? `, ${o.t('acq_tasked')}` : ''}`).join('; ');
          cell.title = `${o.nameOf(e)}, ${d.key}: ${desc}`;
          cell.setAttribute('aria-label', cell.title);
          cell.addEventListener('click', () => o.onSelect(best.id));
          if (list.length > 1) cell.textContent = String(list.length);
        }
        grid.append(cell);
      }
    }
  }
  el.append(grid);
  return true;
}
