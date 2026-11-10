# Vendored libraries

The site has no build step and no runtime CDN dependency. Each library below is a
single-file ES module generated once by [`scripts/vendor.sh`](../scripts/vendor.sh)
from a pinned npm version and committed. The entry files in
[`scripts/vendor_entries/`](../scripts/vendor_entries/) define which API is
exposed. Licence texts are in [`licenses/`](licenses/).

| File | Package | Version | Licence | Used for |
|---|---|---|---|---|
| `satellite.js` | [satellite.js](https://github.com/shashwatak/satellite-js) | 7.1.0 | MIT | SGP4 propagation, ECI/ECF/geodetic transforms (WASM build excluded) |
| `proj4.js` | [proj4js](https://github.com/proj4js/proj4js) | 2.22.0 | MIT | ROI-centred LAEA projection, user CRS input |
| `polygon-clipping.js` | [polygon-clipping](https://github.com/mfogel/polygon-clipping) | 0.15.7 | MIT | planar swath/ROI intersection |
| `geographiclib-geodesic.js` | [geographiclib-geodesic](https://github.com/geographiclib/geographiclib-js) | 2.2.0 | MIT | WGS84 geodesics (Karney) for swath construction |
| `tz-lookup.js` | [tz-lookup](https://github.com/darkskyapp/tz-lookup-oss) | 6.1.25 | CC0-1.0 | IANA time zone of the ROI anchor |

Bundled transitive dependencies (inside the files above):

| Package | Version | Licence | Inside |
|---|---|---|---|
| splaytree | 3.2.3 | MIT (declared in package.json and inline `@license` comment; the package ships no licence file) | `polygon-clipping.js` |
| robust-predicates | 3.0.3 | Unlicense | `polygon-clipping.js` |
| mgrs | 1.0.0 | MIT | `proj4.js` |
| wkt-parser | 1.6.0 | MIT | `proj4.js` |

Known quirk: proj4 2.22.0 returns `NaN` for `+proj=laea` unless `+x_0=0 +y_0=0`
are written explicitly. `geometry.js` must always build the LAEA string with
them; a test in `tests/catalogue_tle.test.js` tracks the quirk.

To add or update a library: edit `PINS` in `scripts/vendor.sh` (and an entry file),
run `bash scripts/vendor.sh`, update this table, run `npm test`.

Still to vendor (later steps): MapLibre GL JS, terra-draw + MapLibre adapter,
@tmcw/togeojson, JSZip, shpjs, Barlow fonts (WOFF2). Basemap sources and their
terms will also be recorded here.
