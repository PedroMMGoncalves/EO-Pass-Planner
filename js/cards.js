/**
 * cards.js: instrument cards, the data-freshness details and the glossary.
 *
 * Inputs:  a catalogue entry (with its sources), meta.json, translation `t`.
 * Outputs: DOM content for the card dialog, the freshness popover and the
 *          glossary list in the About panel.
 *
 * Limitations: the card shows catalogue values as stored; fields listed in
 * `unverified_fields` are marked. "Useful for" (`useful_for`) is written by
 * the catalogue owner and never generated; it is omitted when empty.
 */

const el = (tag, attrs = {}, ...children) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false && c !== '') e.append(c);
  return e;
};

const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener' }, text ?? href);

/** Fill the <dialog> with the card of `e` and open it. */
export function openCard(dialog, e, { t, lang, swathSummary }) {
  const unv = new Set(e.unverified_fields ?? []);
  const mark = (field) => (unv.has(field) ? el('span', { class: 'unverified', title: t('card_unverified') }, ` (${t('card_unverified_short')})`) : null);
  const srcFor = (field) => (e.sources ?? []).filter((s) => s.field === field);
  const o = e.orbit ?? {};
  const orbit = [
    o.type ? t(`orbit_${o.type}`) : null,
    o.altitude_km ? `${o.altitude_km} km` : null,
    o.inclination_deg ? `${o.inclination_deg}°` : null,
    o.ltdn ? t('orbit_ltdn', { v: o.ltdn }) : null,
    o.ltan ? t('orbit_ltan', { v: o.ltan }) : null,
    o.repeat_days ? t('orbit_repeat', { n: o.repeat_days }) : null,
    o.equator_crossing_local ? t('orbit_crossing', { v: o.equator_crossing_local }) : null,
  ].filter(Boolean).join(', ');
  const statusSrc = srcFor('status')[0];
  const rows = [
    [t('card_agency'), e.agency],
    [t('card_launch'), e.launch],
    [t('card_status'), [t(`status_${e.status}`), e.status_note ? ` – ${e.status_note}` : '', statusSrc ? ' ' : '', statusSrc ? link(statusSrc.url, t('card_source_dated', { d: statusSrc.accessed })) : null]],
    [t('card_orbit'), orbit ? [orbit, mark('orbit')] : null],
    [t('card_swath'), swathSummary(e)],
    [t('card_resolution'), e.resolution_m ? [`${e.resolution_m.min}–${e.resolution_m.max} m`, mark('resolution_m')] : null],
    [t('card_spectral'), e.spectral ? [e.spectral, mark('spectral')] : null],
    [t('card_acquisition'), [t(`acq_${e.acquisition}`), e.acquisition_note ? ` – ${e.acquisition_note}` : '']],
    [t('card_useful'), e.useful_for?.[lang] ?? (typeof e.useful_for === 'string' ? e.useful_for : null)],
    [t('card_access'), e.data_access ? link(e.data_access) : null],
    ['NORAD / COSPAR', `${e.norad_id ?? '–'} / ${e.cospar_id ?? '–'}`],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  const sources = el('ul', { class: 'card-sources' }, (e.sources ?? []).map((s) => el('li', {}, `${s.field}: `, link(s.url), ` (${s.accessed})`)));
  dialog.replaceChildren(
    el('div', { class: 'card-head' },
      el('h3', { id: 'card-title' }, `${e.platform} ${e.instrument}`),
      el('button', { type: 'button', class: 'quiet', onclick: () => dialog.close(), 'aria-label': t('close') }, '×')),
    el('dl', { class: 'facts' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])),
    unv.size ? el('p', { class: 'hint' }, t('card_unverified_list', { list: [...unv].join(', ') })) : null,
    el('details', {}, el('summary', {}, t('card_sources', { n: (e.sources ?? []).length })), sources),
  );
  if (!dialog.open) dialog.showModal();
}

/** Freshness popover content from meta.json. */
export function renderFreshDetails(root, meta, { t, formatDateTime }) {
  root.replaceChildren();
  if (!meta) { root.append(el('p', {}, t('freshness_unknown'))); return; }
  const rows = [[t('fresh_updated'), `${formatDateTime(Date.parse(meta.updated_utc), 'UTC')} UTC`], [t('fresh_catalogue'), meta.catalogue_version], [t('fresh_count'), String(meta.tle_count)]];
  for (const [k, s] of Object.entries(meta.sources ?? {})) {
    rows.push([t(`fresh_src_${k}`), s.ok ? t('fresh_ok') : s.ok === false ? t(s.errors.length === 1 ? 'fresh_fail_one' : 'fresh_fail', { n: s.errors.length }) : t('fresh_na')]);
  }
  rows.push([t('fresh_stale'), meta.stale_tles?.length ? meta.stale_tles.join(', ') : t('fresh_none')]);
  root.append(el('dl', { class: 'facts' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])));
  if (meta.catalogue_alerts?.length) {
    root.append(el('h4', {}, t('alerts_title')));
    root.append(el('ul', { class: 'card-sources' }, meta.catalogue_alerts.map((a) => el('li', { class: a.kind === 'stale_elements' ? 'is-warn' : '' }, `${a.id}: ${t(`alert_${a.kind}`, { d: a.detail })}`))));
  }
  const errs = Object.entries(meta.sources ?? {}).flatMap(([k, s]) => (s.errors ?? []).map((m) => `${k}: ${m}`));
  if (errs.length) root.append(el('details', {}, el('summary', {}, t('fresh_errors')), el('ul', {}, errs.slice(0, 20).map((m) => el('li', {}, m)))));
}

/** Glossary <dl> for the About panel. */
export function glossary(t, keys) {
  return el('section', { class: 'glossary' },
    el('h3', {}, t('glossary_title')),
    el('dl', {}, keys.flatMap((k) => [el('dt', { id: `gloss-${k}` }, t(`gloss_${k}_term`)), el('dd', {}, t(`gloss_${k}`))])));
}

export const GLOSSARY_KEYS = ['swath', 'nadir', 'offnadir', 'incidence', 'edge', 'tle', 'sso', 'node', 'tasked', 'systematic', 'relorb', 'mgrs', 'stac', 'insar'];
