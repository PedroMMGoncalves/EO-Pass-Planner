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

PINS=(
  "satellite.js@7.1.0"
  "proj4@2.22.0"
  "polygon-clipping@0.15.7"
  "geographiclib-geodesic@2.2.0"
  "tz-lookup@6.1.25"
)

cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "${PINS[@]}" esbuild@0.25

mkdir -p entries
cp "$ROOT"/scripts/vendor_entries/*.js entries/

for pin in "${PINS[@]}"; do
  name="${pin%@*}"
  version="${pin##*@}"
  base="${name%.js}"
  [ "$name" = "satellite.js" ] && base="satellite"
  licence="$(node -p "require('./node_modules/$name/package.json').license")"
  npx esbuild "entries/$base.js" --bundle --format=esm --minify \
    --legal-comments=inline \
    --banner:js="/*! $name $version ($licence), vendored by scripts/vendor.sh; see vendor/README.md */" \
    --outfile="$ROOT/vendor/$base.js" --log-level=warning
done

echo "Vendored into $ROOT/vendor. Remember to update vendor/README.md."
