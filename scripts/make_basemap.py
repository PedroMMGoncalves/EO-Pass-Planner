"""Build the offline basemap layers in data/basemap/ from Natural Earth (public domain).

Inputs:  Natural Earth GeoJSON downloaded from
         https://github.com/nvkelso/natural-earth-vector/tree/master/geojson
         (ne_50m_land, ne_50m_admin_0_boundary_lines_land, and the 1:110m
         versions ne_110m_land, ne_110m_admin_0_boundary_lines_land).
Outputs: data/basemap/land.geojson, data/basemap/borders.geojson (1:50m) and
         data/basemap/land-110m.geojson, data/basemap/borders-110m.geojson
         (loaded first; the 1:50m files replace them when zooming in).
         Properties removed, coordinates rounded to 0.01° (~1 km).
Usage:   python scripts/make_basemap.py <dir with the downloaded files>
Limitations: 1:50m generalisation; small islands and coastline detail are
         simplified. Intended as a light, offline context layer only.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def rnd(c):
    if isinstance(c[0], (int, float)):
        return [round(c[0], 2), round(c[1], 2)]
    out = [rnd(x) for x in c]
    # drop consecutive duplicates created by rounding
    if out and isinstance(out[0][0], (int, float)):
        out = [p for i, p in enumerate(out) if i == 0 or p != out[i - 1]]
    return out


def convert(src: Path, dst: Path) -> None:
    fc = json.loads(src.read_text(encoding="utf-8"))
    feats = [{"type": "Feature", "properties": {},
              "geometry": {"type": f["geometry"]["type"], "coordinates": rnd(f["geometry"]["coordinates"])}}
             for f in fc["features"] if f.get("geometry")]
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")),
                   encoding="utf-8")
    print(f"{dst.name}: {len(feats)} features, {dst.stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    d = Path(sys.argv[1])
    convert(d / "ne_50m_land.geojson", ROOT / "data/basemap/land.geojson")
    convert(d / "ne_50m_admin_0_boundary_lines_land.geojson", ROOT / "data/basemap/borders.geojson")
    convert(d / "ne_110m_land.geojson", ROOT / "data/basemap/land-110m.geojson")
    convert(d / "ne_110m_admin_0_boundary_lines_land.geojson", ROOT / "data/basemap/borders-110m.geojson")
