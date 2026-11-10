/**
 * i18n.js: UI strings (pt-PT default, English toggle), date/time formatting
 * and glossary definitions.
 *
 * Inputs:  a string key and optional parameters; times in ms UTC and an IANA zone.
 * Outputs: the localised string; the key itself if missing (visible, so gaps get noticed).
 *
 * Limitations: no general plural rules; the few plural cases use explicit
 * `_one` / `_other` keys.
 */

const STRINGS = {
  pt: {
    app_title: 'EO Pass Planner',
    freshness_hours: 'Dados actualizados há {h} h',
    freshness_unknown: 'Data dos dados desconhecida',
    load_error: 'Não foi possível carregar {what}. Recarrega a página; se persistir, os dados do repositório podem estar em falta.',
    lang_toggle: 'English',

    answer_idle: 'Escolhe um local no globo para saber que satélites o vão observar.',
    answer_idle_sub: 'Os satélites partem da posição actual, em tempo acelerado; a faixa colorida é o que cada sensor está a observar. “Agora” repõe o tempo real.',
    answer_ready: 'Local escolhido. Carrega em “Calcular passagens”.',
    answer_computing: 'A calcular passagens…',
    answer_point: '{sat} passa sobre o local {when}, às {time}.',
    answer_poly: '{sat} cobre {cov} % da área {when}, às {time}.',
    answer_partial: 'Aquisição parcial: confirma no plano da missão.',
    answer_more_one: 'Mais 1 passagem nos próximos {days} dias.',
    answer_more_other: 'Mais {n} passagens nos próximos {days} dias.',
    answer_none: 'Nenhum instrumento seleccionado observa este local nos próximos {days} dias.',
    answer_none_hint: 'Alarga a janela ou selecciona mais instrumentos. O separador Ausências explica porquê.',
    answer_tz: 'Hora local: {tz}.',

    roi_heading: 'Local',
    mode_label: 'Forma do local',
    mode_point: 'Ponto',
    mode_polygon: 'Polígono',
    mode_rectangle: 'Rectângulo',
    hint_point: 'Clica no globo para escolher um ponto.',
    hint_polygon: 'Clica para juntar vértices. Fecha com duplo clique, Enter ou clicando no primeiro vértice. Backspace apaga o último; Esc cancela.',
    hint_rectangle: 'Clica em dois cantos opostos.',
    draw_finish: 'Terminar',
    draw_cancel: 'Cancelar',
    coords_summary: 'Escrever coordenadas',
    crs_label: 'Sistema de coordenadas',
    custom_crs: 'Definição proj4',
    coords_label_latlon: 'Um par por linha: latitude, longitude. Três ou mais pares formam um polígono.',
    coords_label_en: 'Um par por linha: E N (metros). Três ou mais pares formam um polígono.',
    roi_apply: 'Usar coordenadas',
    file_summary: 'Carregar ficheiro',
    file_hint: 'GeoJSON, KML, KMZ ou Shapefile em .zip (com o .prj). Vários elementos são fundidos num só.',
    buffer_label: 'Margem à volta do local (km)',
    roi_point_summary: 'Ponto em {lat}, {lon}.',
    roi_poly_summary: 'Polígono com {area} km² e {n} vértices.',
    roi_buffer_summary: 'Inclui uma margem de {km} km.',
    roi_simplified: 'Para o cálculo, o polígono foi simplificado para {n} vértices (área {pct} %).',
    roi_clear: 'Limpar local',
    file_lines_ignored: 'As linhas do ficheiro foram ignoradas.',
    file_points_ignored: 'Os pontos do ficheiro foram ignorados; usam-se os polígonos.',
    file_dissolved: 'O ficheiro tinha vários polígonos; foram fundidos num só.',
    file_first_point: 'O ficheiro tinha vários pontos; usa-se o primeiro.',
    coords_bad: 'Coordenadas inválidas. Escreve um par por linha (por exemplo 37.573, -7.971); latitude entre −90 e 90, longitude entre −180 e 180.',
    coords_two: 'Dois pontos não formam uma área: escreve um ponto ou pelo menos três.',
    custom_crs_missing: 'Escreve a definição proj4 do sistema de coordenadas.',
    custom_crs_bad: 'A definição proj4 não é válida.',
    file_empty: 'O ficheiro não tem pontos nem polígonos.',
    file_type: 'Formato não suportado. Usa GeoJSON, KML, KMZ ou Shapefile em .zip.',
    file_read: 'Não foi possível ler o ficheiro: {msg}',
    hash_bad: 'O link tem um local inválido; foi ignorado.',
    copy_link: 'Copiar link',
    link_copied: 'Link copiado.',
    window_heading: 'Janela',
    window_start: 'Início (UTC)',
    window_days: 'Duração (dias)',
    window_long: 'Acima de 16 dias a incerteza da órbita cresce: confirma mais perto da data.',
    instruments_heading: 'Instrumentos',
    include_transitional: 'Incluir satélites em fim de missão ou em comissionamento',
    run: 'Calcular passagens',
    progress: 'A calcular {done} de {total}…',
    done_in: '{n} passagens calculadas em {s} s.',

    time_play: 'Reproduzir',
    time_pause: 'Pausa',
    time_now: 'Agora',
    time_speed: 'Velocidade',
    time_utc: 'UTC',
    theme_dark: 'Tema escuro',
    theme_light: 'Tema claro',
    basemap_label: 'Mapa de base',
    bm_simple: 'Simples (funciona sem rede)',
    bm_s2cloudless: 'Imagem Sentinel-2 sem nuvens (EOX, 2024)',
    'bm_osm-light': 'OpenStreetMap claro',
    'bm_osm-dark': 'OpenStreetMap escuro',
    'bm_osm-liberty': 'OpenStreetMap detalhado',
    basemap_error: 'Não foi possível carregar o mapa de base “{name}” (sem rede?); voltou-se ao mapa simples.',

    tab_table: 'Tabela',
    tab_absences: 'Ausências',
    tab_geo: 'Geoestacionários',
    geo_hint: 'Os satélites geoestacionários não têm passagens: observam continuamente o mesmo disco da Terra. O que importa é o ângulo de observação a partir do local.',
    geo_empty: 'Nenhum satélite geoestacionário seleccionado, ou ainda sem cálculo.',
    geo_row: 'ângulo zenital de observação {vza}° (limite útil {max}°), {usable}; imagem completa a cada {repeat} min; satélite em {lon}.',
    geo_usable: 'dentro da cobertura útil',
    geo_not_usable: 'fora da cobertura útil',
    answer_line: '{cat}: {sat}, {when}, às {time}',
    answer_tasked: '{sat} pode ser programado para observar o local {when}, às {time} (oportunidade geométrica).',
    answer_profile: '{sat} passa com o feixe mais próximo a {km} km do local {when}, às {time}.',
    swath_geo: 'geoestacionário',
    swath_profile: 'perfil (feixes)',
    swath_track: 'traço orbital',
    swath_sar: 'incidência {inc}°, {side}',
    look_right: 'olha à direita',
    look_left: 'olha à esquerda',
    look_both: 'olha para os dois lados',
    acq_profile: 'perfil (laser ou altímetro)',
    acq_continuous_geo: 'observação contínua',
    cat_optical_multispectral: 'Óptico multiespectral',
    cat_optical_vhr: 'Óptico de muito alta resolução',
    cat_hyperspectral: 'Hiperespectral',
    cat_thermal: 'Infravermelho térmico',
    cat_sar: 'Radar (SAR)',
    cat_lidar_altimetry: 'Lidar e altimetria',
    cat_meteo_polar: 'Meteorológicos polares',
    cat_meteo_geo: 'Meteorológicos geoestacionários',
    cat_atmosphere: 'Atmosfera',
    cat_geophysics: 'Geofísica',
    status_inactive: 'inactivo',
    tab_about: 'Sobre e limitações',
    export_csv: 'Exportar CSV',
    table_cat: 'Categoria',
    table_all: 'Todas',
    table_opp: 'Incluir oportunidades geométricas (sensores programáveis)',
    table_empty: 'Ainda não há passagens. Escolhe um local e calcula.',
    col_sat: 'Satélite',
    col_instrument: 'Instrumento',
    col_local: 'Data e hora local',
    col_utc: 'UTC',
    col_dir: 'Direcção',
    col_cov: 'Cobertura %',
    col_edge: 'Margem ao bordo (km)',
    col_view: 'Ângulo de visada (°)',
    col_sun: 'Elevação solar (°)',
    col_tle: 'Idade do TLE (dias)',
    col_acq: 'Tipo',
    dir_descending: 'descendente',
    dir_ascending: 'ascendente',
    edge_uncertain: 'incerto',

    abs_empty: 'Todos os instrumentos seleccionados têm pelo menos uma passagem.',
    abs_missed: 'A faixa passa a {km} km do local (a {side}); o mais perto foi {when}.',
    abs_filtered: 'Passa sobre o local, mas só em condições em que não adquire: {reasons}.',
    abs_unsupported: 'Modelo de faixa ainda não implementado.',
    abs_no_tle: 'Sem elementos orbitais (TLE) disponíveis.',
    reason_night: 'de noite',
    reason_day: 'de dia',
    reason_ascending: 'em passagem ascendente',
    reason_descending: 'em passagem descendente',
    reason_outside_lat_limits: 'fora dos limites de latitude da missão',
    reason_below_min_coverage: 'cobertura abaixo do mínimo',
    side_E: 'este',
    side_W: 'oeste',

    status_active: 'activo',
    status_ending: 'em fim de missão',
    status_commissioning: 'em comissionamento',
    status_degraded: 'degradado',
    acq_systematic: 'aquisição sistemática',
    acq_partial: 'aquisição parcial',
    acq_tasked: 'oportunidade geométrica',
    note_expired: 'A nota deste satélite expirou em {date}; o estado pode ter mudado.',

    about_html: `<h3>O que esta ferramenta faz</h3>
<p>Para um local e uma janela de tempo, calcula quando a faixa observada por cada instrumento cobre esse local. Propaga a órbita com SGP4 a partir dos elementos orbitais (TLE) mais recentes, constrói a faixa perpendicular ao traço no solo e intersecta-a com o local numa projecção equivalente centrada nele.</p>
<h3>Limitações</h3>
<ul>
<li>Uma previsão geométrica não é uma aquisição. Missões sistemáticas também falham aquisições (manobras, conflitos, descarga de dados, planos de campanha).</li>
<li>São usadas larguras nominais de faixa. O bordo real varia alguns km com a altitude e a disposição dos detectores; margens abaixo de 5 km são marcadas como incertas.</li>
<li>O erro do SGP4 cresce com a idade do TLE e depois de manobras.</li>
<li>O globo mostra a faixa enquanto o Sol está acima do horizonte no ponto sob o satélite e a direcção é a de aquisição; é uma aproximação do sensor ligado.</li>
<li>O mapa de base (Natural Earth 1:50 m) é generalizado e serve só de contexto.</li>
</ul>
<h3>Créditos</h3>
<p>Método inspirado em <a href="https://github.com/julianManning/eo-overpass-predictor">eo-overpass-predictor</a> (Julian Manning, MIT), usado apenas como referência de validação. Bibliotecas: satellite.js, MapLibre GL JS, proj4js, polygon-clipping, GeographicLib, tz-lookup, togeojson, shpjs. Mapa de base: Natural Earth (domínio público). Elementos orbitais: CelesTrak.</p>`,
  },
  en: {
    app_title: 'EO Pass Planner',
    freshness_hours: 'Data updated {h} h ago',
    freshness_unknown: 'Data date unknown',
    load_error: 'Could not load {what}. Reload the page; if it persists, the repository data may be missing.',
    lang_toggle: 'Português',

    answer_idle: 'Pick a place on the globe to see which satellites will observe it.',
    answer_idle_sub: 'Satellites start from their current position, in accelerated time; the coloured strip is what each sensor is observing. “Now” returns to real time.',
    answer_ready: 'Place selected. Press “Compute passes”.',
    answer_computing: 'Computing passes…',
    answer_point: '{sat} passes over the place {when} at {time}.',
    answer_poly: '{sat} covers {cov} % of the area {when} at {time}.',
    answer_partial: 'Partial acquisition: check the mission plan.',
    answer_more_one: '1 more pass in the next {days} days.',
    answer_more_other: '{n} more passes in the next {days} days.',
    answer_none: 'No selected instrument observes this place in the next {days} days.',
    answer_none_hint: 'Extend the window or select more instruments. The Absences tab explains why.',
    answer_tz: 'Local time: {tz}.',

    roi_heading: 'Place',
    mode_label: 'Shape of the place',
    mode_point: 'Point',
    mode_polygon: 'Polygon',
    mode_rectangle: 'Rectangle',
    hint_point: 'Click the globe to pick a point.',
    hint_polygon: 'Click to add vertices. Close with a double-click, Enter or a click on the first vertex. Backspace removes the last one; Esc cancels.',
    hint_rectangle: 'Click two opposite corners.',
    draw_finish: 'Finish',
    draw_cancel: 'Cancel',
    coords_summary: 'Type coordinates',
    crs_label: 'Coordinate system',
    custom_crs: 'proj4 definition',
    coords_label_latlon: 'One pair per line: latitude, longitude. Three or more pairs make a polygon.',
    coords_label_en: 'One pair per line: E N (metres). Three or more pairs make a polygon.',
    roi_apply: 'Use coordinates',
    file_summary: 'Load a file',
    file_hint: 'GeoJSON, KML, KMZ or zipped Shapefile (with the .prj). Several features are merged into one.',
    buffer_label: 'Margin around the place (km)',
    roi_point_summary: 'Point at {lat}, {lon}.',
    roi_poly_summary: 'Polygon of {area} km² with {n} vertices.',
    roi_buffer_summary: 'Includes a {km} km margin.',
    roi_simplified: 'For the computation the polygon was simplified to {n} vertices (area {pct} %).',
    roi_clear: 'Clear place',
    file_lines_ignored: 'Lines in the file were ignored.',
    file_points_ignored: 'Points in the file were ignored; the polygons are used.',
    file_dissolved: 'The file had several polygons; they were merged into one.',
    file_first_point: 'The file had several points; the first one is used.',
    coords_bad: 'Invalid coordinates. Type one pair per line (for example 37.573, -7.971); latitude between −90 and 90, longitude between −180 and 180.',
    coords_two: 'Two points do not make an area: type one point or at least three.',
    custom_crs_missing: 'Type the proj4 definition of the coordinate system.',
    custom_crs_bad: 'The proj4 definition is not valid.',
    file_empty: 'The file has no points or polygons.',
    file_type: 'Unsupported format. Use GeoJSON, KML, KMZ or a zipped Shapefile.',
    file_read: 'Could not read the file: {msg}',
    hash_bad: 'The link holds an invalid place; it was ignored.',
    copy_link: 'Copy link',
    link_copied: 'Link copied.',
    window_heading: 'Window',
    window_start: 'Start (UTC)',
    window_days: 'Length (days)',
    window_long: 'Beyond 16 days orbit uncertainty grows: check again closer to the date.',
    instruments_heading: 'Instruments',
    include_transitional: 'Include ending and commissioning satellites',
    run: 'Compute passes',
    progress: 'Computing {done} of {total}…',
    done_in: '{n} passes computed in {s} s.',

    time_play: 'Play',
    time_pause: 'Pause',
    time_now: 'Now',
    time_speed: 'Speed',
    time_utc: 'UTC',
    theme_dark: 'Dark theme',
    theme_light: 'Light theme',
    basemap_label: 'Basemap',
    bm_simple: 'Simple (works offline)',
    bm_s2cloudless: 'Cloudless Sentinel-2 imagery (EOX, 2024)',
    'bm_osm-light': 'OpenStreetMap light',
    'bm_osm-dark': 'OpenStreetMap dark',
    'bm_osm-liberty': 'OpenStreetMap detailed',
    basemap_error: 'Could not load the “{name}” basemap (offline?); switched back to the simple map.',

    tab_table: 'Table',
    tab_absences: 'Absences',
    tab_geo: 'Geostationary',
    geo_hint: 'Geostationary satellites have no passes: they observe the same Earth disc continuously. What matters is the viewing angle from the place.',
    geo_empty: 'No geostationary satellite selected, or not computed yet.',
    geo_row: 'view zenith angle {vza}° (usable limit {max}°), {usable}; full disc every {repeat} min; satellite at {lon}.',
    geo_usable: 'within usable coverage',
    geo_not_usable: 'outside usable coverage',
    answer_line: '{cat}: {sat}, {when} at {time}',
    answer_tasked: '{sat} can be tasked to observe the place {when} at {time} (geometric opportunity).',
    answer_profile: '{sat} passes with its nearest beam {km} km from the place {when} at {time}.',
    swath_geo: 'geostationary',
    swath_profile: 'profile (beams)',
    swath_track: 'ground track',
    swath_sar: 'incidence {inc}°, {side}',
    look_right: 'right-looking',
    look_left: 'left-looking',
    look_both: 'looks both ways',
    acq_profile: 'profile (laser or altimeter)',
    acq_continuous_geo: 'continuous observation',
    cat_optical_multispectral: 'Optical multispectral',
    cat_optical_vhr: 'Optical very high resolution',
    cat_hyperspectral: 'Hyperspectral',
    cat_thermal: 'Thermal infrared',
    cat_sar: 'Radar (SAR)',
    cat_lidar_altimetry: 'Lidar and altimetry',
    cat_meteo_polar: 'Polar meteorological',
    cat_meteo_geo: 'Geostationary meteorological',
    cat_atmosphere: 'Atmosphere',
    cat_geophysics: 'Geophysics',
    status_inactive: 'inactive',
    tab_about: 'About and limitations',
    export_csv: 'Export CSV',
    table_cat: 'Category',
    table_all: 'All',
    table_opp: 'Include geometric opportunities (tasked sensors)',
    table_empty: 'No passes yet. Pick a place and compute.',
    col_sat: 'Satellite',
    col_instrument: 'Instrument',
    col_local: 'Local date and time',
    col_utc: 'UTC',
    col_dir: 'Direction',
    col_cov: 'Coverage %',
    col_edge: 'Edge margin (km)',
    col_view: 'View angle (°)',
    col_sun: 'Sun elevation (°)',
    col_tle: 'TLE age (days)',
    col_acq: 'Type',
    dir_descending: 'descending',
    dir_ascending: 'ascending',
    edge_uncertain: 'uncertain',

    abs_empty: 'Every selected instrument has at least one pass.',
    abs_missed: 'The swath passes {km} km from the place (to the {side}); closest {when}.',
    abs_filtered: 'Passes over the place, but only when it does not acquire: {reasons}.',
    abs_unsupported: 'Swath model not implemented yet.',
    abs_no_tle: 'No orbital elements (TLE) available.',
    reason_night: 'at night',
    reason_day: 'in daylight',
    reason_ascending: 'on ascending passes',
    reason_descending: 'on descending passes',
    reason_outside_lat_limits: 'outside the mission latitude limits',
    reason_below_min_coverage: 'coverage below the minimum',
    side_E: 'east',
    side_W: 'west',

    status_active: 'active',
    status_ending: 'ending',
    status_commissioning: 'commissioning',
    status_degraded: 'degraded',
    acq_systematic: 'systematic acquisition',
    acq_partial: 'partial acquisition',
    acq_tasked: 'geometric opportunity',
    note_expired: 'This satellite’s note expired on {date}; its status may have changed.',

    about_html: `<h3>What this tool does</h3>
<p>For a place and a time window, it computes when each instrument's swath covers the place. It propagates the orbit with SGP4 from the latest orbital elements (TLE), builds the swath perpendicular to the ground track and intersects it with the place in an equal-area projection centred on it.</p>
<h3>Limitations</h3>
<ul>
<li>A geometric prediction is not an acquisition. Systematic missions also skip acquisitions (manoeuvres, conflicts, downlink, campaign plans).</li>
<li>Nominal swath widths are used. The real edge varies by a few km with altitude and detector layout; margins under 5 km are flagged as uncertain.</li>
<li>SGP4 error grows with TLE age and after manoeuvres.</li>
<li>The globe shows the swath while the sun is above the horizon under the satellite and the direction is the acquiring one; this approximates the sensor being on.</li>
<li>The basemap (Natural Earth 1:50 m) is generalised and serves as context only.</li>
</ul>
<h3>Credits</h3>
<p>Method inspired by <a href="https://github.com/julianManning/eo-overpass-predictor">eo-overpass-predictor</a> (Julian Manning, MIT), used only as a validation reference. Libraries: satellite.js, MapLibre GL JS, proj4js, polygon-clipping, GeographicLib, tz-lookup, togeojson, shpjs. Basemap: Natural Earth (public domain). Orbital elements: CelesTrak.</p>`,
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

const fmtCache = new Map();
function fmt(opts, tz) {
  const key = `${lang}|${tz}|${JSON.stringify(opts)}`;
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat(LOCALES[lang], { timeZone: tz, ...opts }));
  return fmtCache.get(key);
}

/** "14/11/2026, 11:30" style date + time in zone `tz`. */
export const formatDateTime = (ms, tz) => fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz).format(ms);
export const formatTime = (ms, tz) => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz).format(ms);
export const formatTimeSec = (ms, tz) => fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }, tz).format(ms);

/** UTC offset of `tz` at `ms`, as "+01:00". */
export function utcOffset(ms, tz) {
  const part = fmt({ timeZoneName: 'longOffset' }, tz).formatToParts(ms).find((p) => p.type === 'timeZoneName');
  const m = part?.value.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] ?? '00'}` : '+00:00';
}

/** ISO-8601 local time with explicit offset, e.g. 2026-11-14T11:30:52+00:00. */
export function isoLocal(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${utcOffset(ms, tz)}`;
}

const MONTH_PT = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const WEEKDAY_PT = ['no domingo', 'na segunda', 'na terça', 'na quarta', 'na quinta', 'na sexta', 'no sábado'];

/** Natural-language day: "na sexta, 14 nov" / "on Friday 14 Nov". */
export function formatDay(ms, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'numeric' })
    .formatToParts(ms).map((x) => [x.type, x.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  if (lang === 'pt') {
    const mon = Number(parts.month) - 1;
    return `${WEEKDAY_PT[wd]}, ${parts.day} ${MONTH_PT[mon]}`;
  }
  return `on ${fmt({ weekday: 'long', day: 'numeric', month: 'short' }, tz).format(ms)}`;
}
