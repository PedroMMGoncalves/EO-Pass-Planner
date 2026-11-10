"""Compare the JavaScript engine with the reference Python implementation.

Reference: julianManning/eo-overpass-predictor (MIT), pinned at ORACLE_COMMIT.
Its Python engine is used only as a test oracle; none of its code is part of
this project.

Inputs:  --oracle-dir   clone of the reference repository at ORACLE_COMMIT
         data/tles.json  the same TLEs are given to both engines
         tests/fixtures/rois.json plus the reference repository's Port Phillip
         Bay shapefile
Outputs: a residual table on stdout; --report PATH writes it as Markdown;
         --json PATH writes all matched pairs. Exit code 1 when an
         acceptance criterion fails:
           - identical pass sets (expected-imaging passes, matched by
             satellite and time within 120 s),
           - |closest-approach time difference| <= 1 s,
           - |coverage difference| <= 1 percentage point.

Requirements (CI only): the reference environment (geopandas, shapely, pyproj,
skyfield, timezonefinder, pandas, numpy, folium, requests) and node >= 20.

Limitations: the reference covers 5 satellites (Landsat 8/9, Sentinel-2A/B/C),
all with nadir-symmetric swaths, so only that swath model is compared.
"""

from __future__ import annotations

import argparse
import contextlib
import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORACLE_COMMIT = "eb6bccea08501dda8b232c24d979f158181f50be"
ORACLE_REPO = "https://github.com/julianManning/eo-overpass-predictor"
NAME_TO_ID = {
    "LANDSAT 8": "L8_OLI_TIRS", "LANDSAT 9": "L9_OLI2_TIRS2",
    "SENTINEL-2A": "S2A_MSI", "SENTINEL-2B": "S2B_MSI", "SENTINEL-2C": "S2C_MSI",
}
MATCH_WINDOW_S = 120
TIME_TOL_S = 1.0
COVERAGE_TOL_PCT = 1.0


def load_oracle(oracle_dir: Path):
    sys.path.insert(0, str(oracle_dir / "Tools"))
    import overpass_helper_utility as ohu  # noqa: PLC0415 (import from the pinned clone)
    return ohu


def rois(ohu, oracle_dir: Path) -> dict:
    """{name: (oracle roi GeoDataFrame, GeoJSON geometry)}."""
    from shapely.geometry import mapping, shape  # noqa: PLC0415

    out = {}
    with contextlib.redirect_stdout(io.StringIO()):
        ppb = ohu.load_roi(oracle_dir / "DATA/SHP/Port_Phillip_Bay_Extent_EPSG_32755.shp")
    out["port_phillip_bay"] = (ppb, mapping(ppb.geometry.iloc[0]))
    fixtures = json.loads((ROOT / "tests/fixtures/rois.json").read_text(encoding="utf-8"))
    for name, geom in fixtures.items():
        g = shape(geom)
        src = (g.x, g.y) if g.geom_type == "Point" else g
        with contextlib.redirect_stdout(io.StringIO()):
            out[name] = (ohu.load_roi(src), geom)
    return out


def run_js(geom: dict, start: str, days: float, tles: dict) -> dict:
    q = {"roi": geom, "start": start, "days": days, "tles": tles, "entry_ids": list(NAME_TO_ID.values())}
    r = subprocess.run(["node", str(ROOT / "scripts/run_engine.mjs")], input=json.dumps(q),
                       capture_output=True, text=True, check=True)
    return json.loads(r.stdout)


def run_oracle(ohu, roi_gdf, tle_dict, start: str, days: float):
    import pandas as pd  # noqa: PLC0415

    with contextlib.redirect_stdout(io.StringIO()):
        df = ohu.predict_overpasses(roi_gdf, tle_dict, start_utc=start, days=days,
                                    daytime_descending_only=True, verbose=False)
    rows = []
    for _, r in df.iterrows():
        rows.append({
            "sat": r["satellite"],
            "t": pd.Timestamp(r["overpass_utc"]).tz_convert("UTC").timestamp() if pd.Timestamp(r["overpass_utc"]).tzinfo
            else pd.Timestamp(r["overpass_utc"]).tz_localize("UTC").timestamp(),
            "coverage": float(r["roi_coverage_pct"]),
            "offset_km": float(r["nadir_offset_km"]),
            "edge_km": float(r["edge_margin_km"]),
            "view_deg": float(r["view_angle_deg"]),
            "sun_deg": float(r["sun_elevation_deg"]),
            "alt_km": float(r["sat_altitude_km"]),
        })
    return rows


def compare(oracle_rows: list, js: dict) -> tuple[list, list, list]:
    by_id = {v: k for k, v in NAME_TO_ID.items()}
    js_rows = [{
        "sat": by_id[p["entry_id"]], "t": p["closest_utc"] / 1000, "coverage": p["coverage_pct"],
        "offset_km": p["nadir_offset_km"], "edge_km": p["edge_margin_km"], "view_deg": p["view_angle_deg"],
        "sun_deg": p["sun_elevation_deg"], "alt_km": p["altitude_km"],
    } for p in js["passes"] if p["imaging_expected"]]
    pairs, only_oracle = [], []
    unused = list(js_rows)
    for o in oracle_rows:
        cands = [j for j in unused if j["sat"] == o["sat"] and abs(j["t"] - o["t"]) <= MATCH_WINDOW_S]
        if not cands:
            only_oracle.append(o)
            continue
        j = min(cands, key=lambda j: abs(j["t"] - o["t"]))
        unused.remove(j)
        pairs.append((o, j))
    return pairs, only_oracle, unused


def iso(t: float) -> str:
    import datetime as dt  # noqa: PLC0415
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--oracle-dir", type=Path, required=True)
    ap.add_argument("--start", default=None, help="window start, ISO UTC (default: today 00:00)")
    ap.add_argument("--days", type=float, default=16)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--json", type=Path)
    args = ap.parse_args(argv)

    import datetime as dt  # noqa: PLC0415
    start = args.start or dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT00:00:00Z")
    tles = json.loads((ROOT / "data/tles.json").read_text(encoding="utf-8"))
    tle_text = "\n".join(f"{t['name']}\n{t['line1']}\n{t['line2']}" for t in tles.values())

    ohu = load_oracle(args.oracle_dir)
    with tempfile.TemporaryDirectory() as tmp, contextlib.redirect_stdout(io.StringIO()):
        tle_dict = ohu.fetch_tles(list(NAME_TO_ID), tle_dir=Path(tmp), tle_text=tle_text)

    lines = [
        f"Oracle: {ORACLE_REPO} @ {ORACLE_COMMIT[:12]}",
        f"Window: {start} + {args.days:g} d; TLEs from data/tles.json "
        f"(epochs {min(t['epoch'] for t in tles.values())[:16]} to {max(t['epoch'] for t in tles.values())[:16]} UTC)",
        "Residuals are JS − oracle.",
        "",
    ]
    failures = 0
    all_pairs = []
    for name, (gdf, geom) in rois(ohu, args.oracle_dir).items():
        orows = run_oracle(ohu, gdf, tle_dict, start, args.days)
        js = run_js(geom, start, args.days, tles)
        pairs, only_o, only_j = compare(orows, js)
        all_pairs += [{"roi": name, "oracle": o, "js": j} for o, j in pairs]
        dts = [j["t"] - o["t"] for o, j in pairs]
        dcs = [j["coverage"] - o["coverage"] for o, j in pairs]
        bad_t = [d for d in dts if abs(d) > TIME_TOL_S]
        bad_c = [d for d in dcs if abs(d) > COVERAGE_TOL_PCT]
        ok = not (only_o or only_j or bad_t or bad_c)
        failures += 0 if ok else 1
        lines.append(f"## {name}: {'PASS' if ok else 'FAIL'}")
        lines.append(f"oracle {len(orows)} passes, JS {len(pairs) + len(only_j)} passes, matched {len(pairs)}; "
                     f"JS engine time {js['elapsed_ms']:.0f} ms")
        if dts:
            lines.append(f"Δt (s): max |Δ| {max(map(abs, dts)):.3f}, mean {sum(dts) / len(dts):+.3f}; "
                         f"Δcoverage (pp): max |Δ| {max(map(abs, dcs)):.3f}")
        lines.append("")
        lines.append("| satellite | closest approach (UTC) | Δt s | cov. oracle % | Δcov pp | Δoffset km | Δedge km | Δview ° | Δsun ° | Δalt km |")
        lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|")
        for o, j in pairs:
            lines.append(
                f"| {o['sat']} | {iso(o['t'])} | {j['t'] - o['t']:+.3f} | {o['coverage']:.1f} | "
                f"{j['coverage'] - o['coverage']:+.2f} | {j['offset_km'] - o['offset_km']:+.2f} | "
                f"{j['edge_km'] - o['edge_km']:+.2f} | {j['view_deg'] - o['view_deg']:+.3f} | "
                f"{j['sun_deg'] - o['sun_deg']:+.3f} | {j['alt_km'] - o['alt_km']:+.2f} |")
        for o in only_o:
            lines.append(f"| {o['sat']} | {iso(o['t'])} | oracle only | {o['coverage']:.2f} | | | {o['edge_km']:+.2f} | | | |")
        for j in only_j:
            lines.append(f"| {j['sat']} | {iso(j['t'])} | JS only | {j['coverage']:.2f} | | | {j['edge_km']:+.2f} | | | |")
        lines.append("")

    text = "\n".join(lines)
    print(text)
    if args.report:
        args.report.write_text(text + "\n", encoding="utf-8")
    if args.json:
        args.json.write_text(json.dumps(all_pairs, indent=1), encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
