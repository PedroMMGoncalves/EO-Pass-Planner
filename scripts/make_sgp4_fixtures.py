"""Generate reference fixtures for the SGP4 and solar-position tests.

Inputs:  data/tles.json (the TLEs current when the fixtures are generated;
         they are copied into the fixture, so later TLE updates do not affect it).
Outputs: tests/fixtures/sgp4_skyfield.json with, for each TLE, TEME position
         (km) at offsets of 0 h, ±12 h, ±3 d and +7 d from its epoch, computed
         with Skyfield's SGP4. It also holds geometric solar elevation and
         azimuth (no refraction) at a few places and times, from Skyfield with
         the JPL DE421 ephemeris.
Requirements: skyfield (maintainer machine or CI; not needed at runtime).
Limitations: Skyfield and satellite.js implement the same Vallado SGP4, so the
         test checks that the port and the vendored build agree with the reference.
         It does not measure SGP4's own accuracy.
"""

import datetime as dt
import json
from pathlib import Path

from skyfield.api import EarthSatellite, load, wgs84

ROOT = Path(__file__).resolve().parent.parent
OFFSETS_H = [0, -12, 12, -72, 72, 168]
SUN_CASES = [
    ("Lisboa", 38.7223, -9.1393, "2026-06-21T12:00:00Z"),
    ("Lisboa", 38.7223, -9.1393, "2026-12-21T11:30:00Z"),
    ("Maputo", -25.9692, 32.5732, "2026-11-12T07:44:00Z"),
    ("Sao Tome", 0.3365, 6.7273, "2026-03-20T12:00:00Z"),
    ("Svalbard", 78.2232, 15.6267, "2026-12-01T11:00:00Z"),
    ("Praia", 14.9330, -23.5133, "2026-09-01T18:30:00Z"),
]


def main() -> None:
    ts = load.timescale()
    tles = json.loads((ROOT / "data/tles.json").read_text(encoding="utf-8"))
    sats = []
    for norad, t in tles.items():
        s = EarthSatellite(t["line1"], t["line2"], t["name"], ts)
        epoch = s.epoch.utc_datetime()
        samples = []
        for h in OFFSETS_H:
            when = epoch + dt.timedelta(hours=h)
            tt = ts.from_datetime(when)
            r, _v, err = s._position_and_velocity_TEME_km(tt)
            if err:
                continue
            samples.append({"utc": when.isoformat().replace("+00:00", "Z"), "teme_km": [float(x) for x in r]})
        sats.append({"norad": int(norad), "name": t["name"], "line1": t["line1"], "line2": t["line2"], "samples": samples})

    eph = load("de421.bsp")
    earth, sun = eph["earth"], eph["sun"]
    suns = []
    for name, lat, lon, when in SUN_CASES:
        tt = ts.from_datetime(dt.datetime.fromisoformat(when.replace("Z", "+00:00")))
        alt, az, _ = (earth + wgs84.latlon(lat, lon)).at(tt).observe(sun).apparent().altaz()
        suns.append({"place": name, "lat": lat, "lon": lon, "utc": when,
                     "elevation_deg": alt.degrees, "azimuth_deg": az.degrees})

    out = {"generator": "scripts/make_sgp4_fixtures.py", "skyfield": __import__("skyfield").__version__,
           "satellites": sats, "sun": suns}
    path = ROOT / "tests/fixtures/sgp4_skyfield.json"
    path.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path} ({len(sats)} satellites, {len(suns)} sun cases)")


if __name__ == "__main__":
    main()
