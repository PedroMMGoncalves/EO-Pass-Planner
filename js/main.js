/**
 * main.js: UI wiring and state.
 *
 * Current scope: load catalogue, TLEs and meta; show the data freshness badge and
 * the catalogue with TLE ages. The full layout is not implemented yet.
 *
 * Inputs:  data/catalogue.json, data/tles.json, data/meta.json (relative paths).
 * Outputs: DOM updates.
 * Limitations: no pass computation yet.
 */

import { loadCatalogue, filterEntries, noteExpired } from './catalogue.js';
import { loadTles, loadMeta, tleAgeDays, tleAgeLevel, dataFreshness } from './tle.js';
import { t, setLang, getLang } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

const state = { catalogue: null, tles: null, meta: null };

function renderFreshness() {
  const el = $('#freshness');
  if (!state.meta?.updated_utc) {
    el.textContent = t('freshness_unknown');
    el.classList.add('is-warn');
    return;
  }
  const { hours, stale } = dataFreshness(state.meta);
  el.textContent = t('freshness_hours', { h: Math.max(0, Math.round(hours)) });
  el.classList.toggle('is-warn', stale);
}

function renderCatalogue() {
  const list = $('#catalogue');
  list.replaceChildren();
  const now = new Date();
  for (const e of filterEntries(state.catalogue.entries, { includeTransitional: true })) {
    const li = document.createElement('li');
    const tle = state.tles?.[String(e.norad_id)];
    const parts = [`${e.platform} ${e.instrument}`, t(`status_${e.status}`), t(`acq_${e.acquisition}`)];
    if (tle) {
      const age = tleAgeDays(tle, now);
      parts.push(t('tle_age_days', { d: age.toFixed(1) }));
      if (tleAgeLevel(age) !== 'ok') li.classList.add('is-warn');
    }
    li.textContent = parts.join(', ');
    if (noteExpired(e, now)) {
      const warn = document.createElement('p');
      warn.className = 'is-warn';
      warn.textContent = t('note_expired', { date: e.note_expires });
      li.append(warn);
    }
    list.append(li);
  }
}

function render() {
  document.documentElement.lang = getLang() === 'pt' ? 'pt-PT' : 'en';
  $('#lang').textContent = t('lang_toggle');
  $('#catalogue-heading').textContent = t('catalogue_heading');
  renderFreshness();
  renderCatalogue();
}

async function init() {
  $('#lang').addEventListener('click', () => {
    setLang(getLang() === 'pt' ? 'en' : 'pt');
    render();
  });
  try {
    [state.catalogue, state.tles, state.meta] = await Promise.all([
      loadCatalogue(), loadTles(), loadMeta().catch(() => null),
    ]);
  } catch (err) {
    $('#status').textContent = t('load_error', { what: err.message });
    return;
  }
  $('#status').textContent = '';
  render();
}

init();
