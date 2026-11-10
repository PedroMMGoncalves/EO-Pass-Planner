/**
 * i18n.js: UI strings (pt-PT default, English toggle) and glossary definitions.
 *
 * Inputs:  a string key and optional parameters.
 * Outputs: the localised string; the key itself if missing (visible, so gaps get noticed).
 *
 * Limitations: no plural rules beyond the explicit `_one`/`_other` keys used here.
 */

const STRINGS = {
  pt: {
    app_title: 'EO Pass Planner',
    freshness_hours: 'Dados actualizados há {h} h',
    freshness_unknown: 'Não foi possível ler a data de actualização dos dados.',
    loading: 'A carregar dados…',
    load_error: 'Não foi possível carregar {what}. Recarrega a página; se persistir, os dados no repositório podem estar em falta.',
    tle_age_days: 'TLE com {d} dias',
    note_expired: 'A nota deste satélite expirou em {date}; o estado pode ter mudado.',
    catalogue_heading: 'Instrumentos no catálogo',
    lang_toggle: 'English',
    status_active: 'activo',
    status_ending: 'em fim de missão',
    status_commissioning: 'em comissionamento',
    status_degraded: 'degradado',
    acq_systematic: 'aquisição sistemática',
    acq_partial: 'aquisição parcial',
    acq_tasked: 'oportunidade geométrica',
  },
  en: {
    app_title: 'EO Pass Planner',
    freshness_hours: 'Data updated {h} h ago',
    freshness_unknown: 'Could not read when the data was last updated.',
    loading: 'Loading data…',
    load_error: 'Could not load {what}. Reload the page; if it persists, the repository data may be missing.',
    tle_age_days: 'TLE {d} days old',
    note_expired: 'This satellite’s note expired on {date}; its status may have changed.',
    catalogue_heading: 'Instruments in the catalogue',
    lang_toggle: 'Português',
    status_active: 'active',
    status_ending: 'ending',
    status_commissioning: 'commissioning',
    status_degraded: 'degraded',
    acq_systematic: 'systematic acquisition',
    acq_partial: 'partial acquisition',
    acq_tasked: 'geometric opportunity',
  },
};

let lang = 'pt';

export function setLang(l) { if (STRINGS[l]) lang = l; }
export function getLang() { return lang; }

/** Translate `key`, replacing `{name}` placeholders from `params`. */
export function t(key, params = {}) {
  const s = STRINGS[lang][key] ?? STRINGS.pt[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

export const LOCALES = { pt: 'pt-PT', en: 'en-GB' };
