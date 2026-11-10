#!/usr/bin/env bash
# Purpose: regenerate the vendored ES-module builds in vendor/ from pinned npm versions.
# Inputs:  the entry files in scripts/vendor_entries/ and the PINS list below.
# Outputs: vendor/<name>.js (single-file ESM, minified, licence comments kept)
#          and vendor/licenses/*.
# Limitations: this is a maintainer-only, one-off step (needs node + npm + network).
#   The site itself has no build step: the generated files are committed and
#   served as they are. After changing a pin, update vendor/README.md and run the tests.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# npm packages to install (exact versions).
PINS=(
  "satellite.js@7.1.0"
  "proj4@2.22.0"
  "polygon-clipping@0.15.7"
  "geographiclib-geodesic@2.2.0"
  "tz-lookup@6.1.25"
  "@tmcw/togeojson@7.1.3"
  "shpjs@6.2.0"
)
# Output bundles: scripts/vendor_entries/<name>.js -> vendor/<name>.js
BUNDLES=(satellite proj4 polygon-clipping geographiclib-geodesic tz-lookup fileformats)

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "${PINS[@]}" esbuild@0.25

mkdir -p entries
cp "$ROOT"/scripts/vendor_entries/*.js entries/

for base in "${BUNDLES[@]}"; do
  npx esbuild "entries/$base.js" --bundle --format=esm --minify --platform=browser \
    --legal-comments=inline \
    --banner:js="/*! $base bundle, vendored by scripts/vendor.sh (versions and licences: vendor/README.md) */" \
    --outfile="$ROOT/vendor/$base.js" --log-level=warning
done

# MapLibre GL JS is copied as published (ESM build), not rebundled.
MAPLIBRE=6.17.0
npm install --no-audit --no-fund --silent "maplibre-gl@$MAPLIBRE"
mkdir -p "$ROOT/vendor/maplibre"
cp node_modules/maplibre-gl/dist/{maplibre-gl.mjs,maplibre-gl-worker.mjs,maplibre-gl-shared.mjs,maplibre-gl.css} "$ROOT/vendor/maplibre/"

echo "Vendored into $ROOT/vendor. Remember to update vendor/README.md."
