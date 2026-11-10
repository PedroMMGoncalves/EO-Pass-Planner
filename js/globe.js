/**
 * globe.js: the MapLibre GL JS map in globe projection, with its data layers.
 *
 * Inputs:  a container element; data pushed through the setters below.
 * Outputs: a map with an offline basemap (Natural Earth 1:50 m land and borders,
 *          graticule), night side, ground tracks, swaths, pass footprints, ROI
 *          and satellite markers. Map clicks are reported through onClick.
 *
 * Limitations: the basemap is a generalised context layer (1:50 m), not imagery.
 * There are no text labels on the map itself, because they would need a
 * glyph server. Satellite labels are HTML markers.
 */

import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

const C = {
  ocean: '#CFDBE1',
  land: '#F7F9FA',
  border: '#B9C4CB',
  graticule: '#B9C4CB',
  ink: '#17283A',
};

const empty = () => ({ type: 'FeatureCollection', features: [] });

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

function style() {
  return {
    version: 8,
    projection: { type: 'globe' },
    sources: {
      land: { type: 'geojson', data: 'data/basemap/land.geojson' },
      borders: { type: 'geojson', data: 'data/basemap/borders.geojson' },
      graticule: { type: 'geojson', data: graticule() },
      night: { type: 'geojson', data: empty() },
      tracks: { type: 'geojson', data: empty() },
      swaths: { type: 'geojson', data: empty() },
      footprints: { type: 'geojson', data: empty() },
      roi: { type: 'geojson', data: empty() },
    },
    layers: [
      { id: 'ocean', type: 'background', paint: { 'background-color': C.ocean } },
      { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': C.graticule, 'line-width': ['case', ['get', 'equator'], 1, 0.5] } },
      { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': C.land } },
      { id: 'borders', type: 'line', source: 'borders', paint: { 'line-color': C.border, 'line-width': 0.6 } },
      { id: 'night', type: 'fill', source: 'night', paint: { 'fill-color': C.ink, 'fill-opacity': 0.13 } },
      { id: 'footprints-fill', type: 'fill', source: 'footprints', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': ['case', ['get', 'selected'], 0.3, 0.08] } },
      { id: 'footprints-line', type: 'line', source: 'footprints', paint: { 'line-color': ['get', 'colour'], 'line-width': ['case', ['get', 'selected'], 2, 0.6], 'line-opacity': ['case', ['get', 'selected'], 1, 0.5] } },
      { id: 'swaths-fill', type: 'fill', source: 'swaths', paint: { 'fill-color': ['get', 'colour'], 'fill-opacity': 0.25 } },
      { id: 'swaths-line', type: 'line', source: 'swaths', paint: { 'line-color': ['get', 'colour'], 'line-width': 1.2 } },
      { id: 'tracks-past', type: 'line', source: 'tracks', filter: ['==', ['get', 'when'], 'past'], paint: { 'line-color': ['get', 'colour'], 'line-width': 1.2, 'line-dasharray': [2, 2], 'line-opacity': 0.7 } },
      { id: 'tracks-future', type: 'line', source: 'tracks', filter: ['==', ['get', 'when'], 'future'], paint: { 'line-color': ['get', 'colour'], 'line-width': 1.4 } },
      { id: 'roi-fill', type: 'fill', source: 'roi', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': C.ink, 'fill-opacity': 0.08 } },
      { id: 'roi-halo', type: 'line', source: 'roi', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': '#FFFFFF', 'line-width': 5 } },
      { id: 'roi-line', type: 'line', source: 'roi', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'line-color': C.ink, 'line-width': 2 } },
      { id: 'roi-point', type: 'circle', source: 'roi', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 6, 'circle-color': C.ink, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2.5 } },
    ],
  };
}

/** Add a `colour` property to each feature from a map of entry id → colour. */
function colourise(fc, colours) {
  for (const f of fc.features) f.properties.colour = colours[f.properties.id] ?? C.ink;
  return fc;
}

export function createGlobe(container, { onClick, attribution }) {
  const map = new maplibregl.Map({
    container,
    style: style(),
    center: [-8, 30],
    zoom: 2.1,
    attributionControl: { compact: true, customAttribution: attribution },
    renderWorldCopies: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  map.on('click', (ev) => onClick?.({ lat: ev.lngLat.lat, lon: ev.lngLat.lng }));
  map.getCanvas().style.cursor = 'crosshair';

  const ready = new Promise((resolve) => map.on('load', resolve));
  const markers = new Map();
  let colours = {};

  const set = (id, fc) => { const s = map.getSource(id); if (s) s.setData(fc); };

  return {
    map,
    ready,
    setColours(c) { colours = c; },
    setNight: (fc) => set('night', fc),
    setTracks: (fc) => set('tracks', colourise(fc, colours)),
    setSwaths: (fc) => set('swaths', colourise(fc, colours)),
    setFootprints: (fc) => set('footprints', colourise(fc, colours)),
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
          el.querySelector('.sat-dot').style.background = s.colour;
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
  };
}
