/**
 * globe.js: the MapLibre GL JS map in globe projection, with its data layers,
 * colour themes and switchable basemaps.
 *
 * Inputs:  a container element; theme ('light' | 'dracula'); basemap id;
 *          data pushed through the setters below.
 * Outputs: a map with a basemap, graticule, night side, ground tracks, swaths,
 *          pass footprints, ROI, drawing sketch and satellite markers. Map clicks
 *          are reported through onClick.
 *
 * Basemaps (terms checked 2026-11-10, see vendor/README.md):
 * - simple: Natural Earth 1:50 m, bundled, works offline (public domain).
 * - s2cloudless: EOxCloudless 2024 Sentinel-2 mosaic, EOX IT Services
 *   (CC BY-NC-SA 4.0 for non-commercial use; attribution shown on the map).
 * - osm-light / osm-dark / osm-liberty: OpenFreeMap vector styles (OpenStreetMap
 *   data, OpenMapTiles schema; free, no key, attribution required).
 *
 * Limitations: online basemaps need a network connection. If one cannot be
 * loaded, the map falls back to the bundled basemap and reports it through
 * onBasemapError. The simple basemap has no text labels (they would need a
 * glyph server); satellite labels are HTML markers.
 */

import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

export const THEMES = {
  light: { ocean: '#CFDBE1', land: '#F7F9FA', border: '#B9C4CB', graticule: '#B9C4CB', ink: '#17283A', halo: '#FFFFFF', night: ['#17283A', 0.13], paper: '#E9EEF0' },
  dracula: { ocean: '#1E1F29', land: '#343746', border: '#6272A4', graticule: '#44475A', ink: '#F8F8F2', halo: '#282A36', night: ['#000000', 0.32], paper: '#282A36' },
};

export const BASEMAPS = {
  simple: { kind: 'simple' },
  s2cloudless: {
    kind: 'raster',
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg'],
    maxzoom: 15,
    attribution: '<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024)',
  },
  'osm-light': { kind: 'vector', style: 'https://tiles.openfreemap.org/styles/positron' },
  'osm-dark': { kind: 'vector', style: 'https://tiles.openfreemap.org/styles/dark' },
  'osm-liberty': { kind: 'vector', style: 'https://tiles.openfreemap.org/styles/liberty' },
};
const OFM_ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

const empty = () => ({ type: 'FeatureCollection', features: [] });
const DATA_SOURCES = ['night', 'tracks', 'swaths', 'footprints', 'roi', 'draft'];

function graticule(step = 30) {
  const feats = [];
  for (let lon = -180; lon < 180; lon += step) {
    const coords = [];
    for (let lat = -85; lat <= 85; lat += 5) coords.push([lon, lat]);
    feats.push({ type: 'Feature', properties: { equator: false }, geometry: { type: 'LineString', coordinates: coords } });
  }
  for (let lat = -60; lat <= 60; lat += step) {
    const coords = [];
    for (let lon = -180; lon <= 180; lon += 5) coords.push([lon, lat]);
    feats.push({ type: 'Feature', properties: { equator: lat === 0 }, geometry: { type: 'LineString', coordinates: coords } });
  }
  return { type: 'FeatureCollection', features: feats };
}

/** Overlay (data) layers, drawn above any basemap. */
function overlayLayers(C, withGraticule) {
  const layers = [];
  if (withGraticule) layers.push({ id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': C.graticule, 'line-width': ['case', ['get', 'equator'], 1, 0.5], 'line-opacity': 0.8 } });
  layers.push(
    { id: 'night', type: 'fill', source: 'night', paint: { 'fill-color': C.night[0], 'fill-opacity': C.night[1] } },
    { id: 'footprints-fill', type: 'fill', source: 'footprints', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': ['case', ['get', 'selected'], 0.22, 0] } },
    { id: 'footprints-line', type: 'line', source: 'footprints', paint: { 'line-color': ['get', 'colour'], 'line-width': ['case', ['get', 'selected'], 2, 0.6], 'line-opacity': ['case', ['get', 'selected'], 1, 0.35] } },
    { id: 'swaths-fill', type: 'fill', source: 'swaths', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.25 } },
    { id: 'swaths-line', type: 'line', source: 'swaths', paint: { 'line-color': ['get', 'colour'], 'line-width': 1.2 } },
    { id: 'tracks-past', type: 'line', source: 'tracks', filter: ['==', ['get', 'when'], 'past'], paint: { 'line-color': ['get', 'colour'], 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } },
    { id: 'tracks-future', type: 'line', source: 'tracks', filter: ['==', ['get', 'when'], 'future'], paint: { 'line-color': ['get', 'colour'], 'line-width': 1.4 } },
    { id: 'roi-fill', type: 'fill', source: 'roi', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': C.ink, 'fill-opacity': 0.08 } },
    { id: 'roi-halo', type: 'line', source: 'roi', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': C.halo, 'line-width': 5 } },
    { id: 'roi-line', type: 'line', source: 'roi', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': C.ink, 'line-width': 2 } },
    { id: 'roi-point', type: 'circle', source: 'roi', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': C.ink, 'circle-stroke-color': C.halo, 'circle-stroke-width': 2.5 } },
    { id: 'draft-line', type: 'line', source: 'draft', filter: ['==', ['geometry-type'], 'LineString'], paint: { 'line-color': C.ink, 'line-width': 2, 'line-dasharray': [3, 2] } },
    { id: 'draft-vertex', type: 'circle', source: 'draft', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': C.halo, 'circle-stroke-color': C.ink, 'circle-stroke-width': 2 } },
  );
  return layers;
}

const vectorStyleCache = new Map();

async function fetchVectorStyle(url) {
  if (!vectorStyleCache.has(url)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    vectorStyleCache.set(url, await res.json());
  }
  return structuredClone(vectorStyleCache.get(url));
}

/** Build a complete style for a theme and basemap, carrying over current data. */
const DETAIL_ZOOM = 2.5; // above this zoom the 1:50 m basemap replaces the 1:110 m one

async function buildStyle(theme, basemapId, data, detail) {
  const C = THEMES[theme] ?? THEMES.light;
  const bm = BASEMAPS[basemapId] ?? BASEMAPS.simple;
  const sources = Object.fromEntries(DATA_SOURCES.map((id) => [id, { type: 'geojson', data: data[id] ?? empty() }]));
  sources.graticule = { type: 'geojson', data: graticule() };
  let base = [];
  let extra = {};
  if (bm.kind === 'simple') {
    const sfx = detail ? '' : '-110m';
    sources.land = { type: 'geojson', data: `data/basemap/land${sfx}.geojson`, attribution: 'Natural Earth' };
    sources.borders = { type: 'geojson', data: `data/basemap/borders${sfx}.geojson` };
    base = [
      { id: 'ocean', type: 'background', paint: { 'background-color': C.ocean } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': C.land } },
      { id: 'borders', type: 'line', source: 'borders', paint: { 'line-color': C.border, 'line-width': 0.6 } },
    ];
  } else if (bm.kind === 'raster') {
    sources.basemap = { type: 'raster', tiles: bm.tiles, tileSize: 256, maxzoom: bm.maxzoom, attribution: bm.attribution };
    base = [
      { id: 'ocean', type: 'background', paint: { 'background-color': C.ocean } },
      { id: 'basemap', type: 'raster', source: 'basemap', paint: theme === 'dracula' ? { 'raster-brightness-max': 0.75, 'raster-saturation': -0.2 } : {} },
    ];
  } else {
    const vs = await fetchVectorStyle(bm.style);
    for (const [id, src] of Object.entries(vs.sources)) sources[id] = { ...src, attribution: src.attribution || OFM_ATTRIBUTION };
    base = vs.layers;
    extra = { glyphs: vs.glyphs, sprite: vs.sprite };
  }
  return {
    version: 8,
    projection: { type: 'globe' },
    ...extra,
    sources,
    layers: [...base, ...overlayLayers(C, bm.kind !== 'vector')],
  };
}

/** Add a `colour` property to each feature from a map of entry id → colour. */
function colourise(fc, colours) {
  for (const f of fc.features) f.properties.colour = colours[f.properties.id] ?? '#888888';
  return fc;
}

export function createGlobe(container, { onClick, onBasemapError, theme = 'light', basemap = 'simple' }) {
  const state = { theme, basemap, detail: false };
  const data = {};
  const map = new maplibregl.Map({
    container,
    style: { version: 8, sources: {}, layers: [] },
    center: [-8, 30],
    zoom: 2.1,
    attributionControl: { compact: true, customAttribution: 'CelesTrak' },
    renderWorldCopies: false,
    canvasContextAttributes: { preserveDrawingBuffer: true }, // map image for the printed field sheet
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.on('click', (ev) => onClick?.({ lat: ev.lngLat.lat, lon: ev.lngLat.lng }));
  // Light start: the 1:110 m land and borders load first; the 1:50 m files
  // (about 1.3 MB) are fetched only when the user zooms in.
  map.on('zoomend', () => {
    if (state.detail || map.getZoom() < DETAIL_ZOOM) return;
    state.detail = true;
    map.getSource('land')?.setData('data/basemap/land.geojson');
    map.getSource('borders')?.setData('data/basemap/borders.geojson');
  });
  // Some online styles reference icons missing from their sprite; use a blank image.
  map.on('styleimagemissing', (ev) => {
    if (!map.hasImage(ev.id)) map.addImage(ev.id, { width: 1, height: 1, data: new Uint8Array(4) });
  });
  map.getCanvas().style.cursor = 'crosshair';

  let styleVersion = 0;
  async function applyStyle() {
    const v = ++styleVersion;
    let style;
    try {
      style = await buildStyle(state.theme, state.basemap, data, state.detail);
    } catch (err) {
      onBasemapError?.(state.basemap, err);
      state.basemap = 'simple';
      style = await buildStyle(state.theme, 'simple', data, state.detail);
    }
    if (v !== styleVersion) return;
    map.setStyle(style, { diff: false });
  }

  // After every style change, push the latest data (it may have changed while
  // an online style was loading). The first real style resolves `ready`.
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  map.on('style.load', () => {
    if (!map.getSource('roi')) return; // the initial empty style
    for (const id of DATA_SOURCES) if (data[id]) map.getSource(id)?.setData(data[id]);
    resolveReady();
  });
  applyStyle();

  const markers = new Map();
  let colours = {};

  const set = (id, fc) => {
    data[id] = fc;
    const s = map.getSource(id);
    if (s) s.setData(fc);
  };

  function clearMarkers() {
    for (const m of markers.values()) m.remove();
    markers.clear();
  }

  return {
    map,
    ready,
    get theme() { return state.theme; },
    get basemap() { return state.basemap; },
    setColours(c) { colours = c; clearMarkers(); for (const id of ['tracks', 'swaths', 'footprints']) if (data[id]) set(id, colourise(data[id], colours)); },
    setTheme(t) { state.theme = t; applyStyle(); },
    setBasemap(b) { state.basemap = b; applyStyle(); },
    setNight: (fc) => set('night', fc),
    setTracks: (fc) => set('tracks', colourise(fc, colours)),
    setSwaths: (fc) => set('swaths', colourise(fc, colours)),
    setFootprints: (fc) => set('footprints', colourise(fc, colours)),
    setDraft: (fc) => set('draft', fc),
    setRoi: (geom) => set('roi', geom ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: geom }] } : empty()),
    /** Update satellite markers: [{id, label, lat, lon, colour, imaging, title}] */
    setSatellites(list) {
      const seen = new Set();
      for (const s of list) {
        seen.add(s.id);
        let m = markers.get(s.id);
        if (!m) {
          const el = document.createElement('div');
          el.className = 'sat-marker';
          el.innerHTML = '<span class="sat-dot"></span><span class="sat-label"></span>';
          const dotEl = el.querySelector('.sat-dot');
          dotEl.style.background = s.colour;
          dotEl.classList.add(`shape-${s.shape ?? 'circle'}`);
          if (s.colour2) dotEl.style.setProperty('--stripe', s.colour2);
          el.querySelector('.sat-label').textContent = s.label;
          el.title = s.title;
          m = new maplibregl.Marker({ element: el, anchor: 'left', offset: [-6, 0], opacityWhenCovered: '0' }).setLngLat([s.lon, s.lat]).addTo(map);
          markers.set(s.id, m);
        }
        m.setLngLat([s.lon, s.lat]);
        m.getElement().classList.toggle('is-imaging', s.imaging);
      }
      for (const [id, m] of markers) if (!seen.has(id)) { m.remove(); markers.delete(id); }
    },
    flyTo(lat, lon, zoom = 4) { map.flyTo({ center: [lon, lat], zoom, essential: true }); },
    /** Fit the view to a lon/lat bounding box [[w, s], [e, n]]. */
    fitBounds(b) { map.fitBounds(b, { padding: 80, maxZoom: 6.5, essential: true }); },
  };
}
