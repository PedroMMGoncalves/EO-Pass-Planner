"""Validate data/catalogue.json: schema, enums, provenance, NORAD/name consistency.

Inputs:  data/catalogue.json; data/tles.json if present (offline name check).
Outputs: exit code 0 if valid, 1 otherwise; errors and warnings on stdout.

Rules:
- Every entry has the required fields with valid enum values.
- Every non-inactive entry cites a source for `status` and `swath` (hard error).
- Constellation entries (several satellites selected by a CelesTrak query)
  have no single NORAD id; they need `constellation.query` (group or name).
- `verified: true` requires a source for `norad_id` as well.
- If data/tles.json has the entry's NORAD id, its name must equal `object_name`.
- A `note_expires` date in the past is a warning (the UI also shows it).

Limitations: this checks structure and provenance, not truth. Whether a cited
page really supports a value is a human check (recorded by `verified` and
`unverified_fields`). The live CelesTrak name check runs in update_data.py.
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

CATEGORIES = {
    "optical_multispectral", "optical_vhr", "hyperspectral", "thermal", "sar",
    "lidar_altimetry", "meteo_polar", "meteo_geo", "atmosphere", "geophysics",
}
STATUSES = {"active", "commissioning", "degraded", "ending", "inactive"}
ACQUISITIONS = {"systematic", "partial", "tasked", "continuous_geo", "profile"}
PASS_FILTERS = {"day_descending", "day_ascending", "day_any", "any", "night_any"}
PLAN_SOURCES = {"esa_s2_kml", "esa_s1_kml", None}
# Required parameters per swath model. field_of_regard needs width_km plus
# either max_offnadir_deg (agile optical) or access_incidence_deg (tasked SAR).
SWATH_PARAMS = {
    "nadir_symmetric": {"width_km"},
    "side_looking": {"look_side", "incidence_deg"},
    "field_of_regard": {"width_km"},
    "profile": {"beams_cross_track_km"},
    "continuous_geo": {"sub_lon", "repeat_min", "max_view_zenith_deg"},
    "track_only": set(),
}
LOOK_SIDES = {"right", "left", "both"}
REQUIRED = [
    "id", "platform", "object_name", "norad_id", "instrument", "categories",
    "tags", "status", "acquisition", "pass_filter", "swath", "data_access",
    "sources", "verified",
]


def _date(s: str) -> dt.date:
    return dt.date.fromisoformat(s)


def validate(catalogue: dict, tles: dict | None, today: dt.date) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    entries = catalogue.get("entries")
    if not isinstance(entries, list) or not entries:
        return ["catalogue has no 'entries' list"], warnings
    if not catalogue.get("version"):
        errors.append("catalogue has no 'version'")

    seen: set[str] = set()
    for e in entries:
        eid = e.get("id", "<missing id>")
        err = lambda msg: errors.append(f"{eid}: {msg}")  # noqa: E731

        for f in REQUIRED:
            if f not in e:
                err(f"missing field '{f}'")
        if eid in seen:
            err("duplicate id")
        seen.add(eid)

        if not set(e.get("categories", [])) or not set(e.get("categories", [])) <= CATEGORIES:
            err(f"bad categories {e.get('categories')}")
        if e.get("status") not in STATUSES:
            err(f"bad status {e.get('status')!r}")
        if e.get("acquisition") not in ACQUISITIONS:
            err(f"bad acquisition {e.get('acquisition')!r}")
        if e.get("pass_filter") not in PASS_FILTERS:
            err(f"bad pass_filter {e.get('pass_filter')!r}")
        if e.get("plan_source") not in PLAN_SOURCES:
            err(f"bad plan_source {e.get('plan_source')!r}")
        constellation = e.get("constellation")
        if constellation:
            q = constellation.get("query") or {}
            if not (q.get("group") or q.get("name")):
                err("constellation.query needs 'group' or 'name'")
            if "commercial" not in e.get("tags", []) and not constellation.get("open"):
                warnings.append(f"{eid}: constellation without the 'commercial' tag")
        elif not isinstance(e.get("norad_id"), int) and e.get("status") != "inactive":
            err("norad_id must be an integer")
        if e.get("short") is not None and not (isinstance(e["short"], str) and 0 < len(e["short"]) <= 6):
            err("short label must be 1-6 characters")

        swath = e.get("swath") or {}
        model = swath.get("model")
        if model not in SWATH_PARAMS:
            err(f"bad swath model {model!r}")
        else:
            missing = SWATH_PARAMS[model] - set(swath)
            if missing:
                err(f"swath model {model} missing {sorted(missing)}")
        if "width_km" in swath and not (isinstance(swath["width_km"], (int, float)) and swath["width_km"] > 0):
            err("swath.width_km must be > 0")
        if model == "field_of_regard" and not any(k in swath for k in ("max_offnadir_deg", "offnadir_range_deg", "access_incidence_deg")):
            err("field_of_regard needs max_offnadir_deg, offnadir_range_deg or access_incidence_deg")
        if "offnadir_range_deg" in swath:
            v = swath["offnadir_range_deg"]
            if not (isinstance(v, list) and len(v) == 2 and -90 < v[0] < v[1] < 90):
                err("swath.offnadir_range_deg must be [min, max], signed, positive = right of track")
        for key in ("incidence_deg", "access_incidence_deg"):
            if key in swath:
                v = swath[key]
                if not (isinstance(v, list) and len(v) == 2 and 0 <= v[0] < v[1] < 90):
                    err(f"swath.{key} must be [near, far] with 0 <= near < far < 90")
        if "look_side" in swath and swath["look_side"] not in LOOK_SIDES:
            err(f"bad look_side {swath['look_side']!r}")
        if model == "nadir_symmetric" and swath.get("gap_km", 0) >= swath.get("width_km", 0) > 0:
            err("gap_km must be smaller than width_km")
        if model == "profile" and not swath.get("beams_cross_track_km"):
            err("profile needs at least one beam offset")

        lat = e.get("lat_limits")
        if lat is not None and not (len(lat) == 2 and -90 <= lat[0] < lat[1] <= 90):
            err(f"bad lat_limits {lat}")

        sourced = set()
        for s in e.get("sources", []):
            if not str(s.get("url", "")).startswith("https://"):
                err(f"source for {s.get('field')} has no https url")
                continue
            try:
                _date(s.get("accessed", ""))
            except ValueError:
                err(f"source for {s.get('field')} has bad 'accessed' date")
            sourced.add(s.get("field"))
        if e.get("status") != "inactive":
            for f in ("status", "swath"):
                if f not in sourced:
                    err(f"active entry lacks a source for '{f}'")
        if e.get("verified") and "norad_id" not in sourced and isinstance(e.get("norad_id"), int):
            err("verified entry lacks a source for 'norad_id'")
        if not e.get("verified"):
            warnings.append(f"{eid}: not verified")
        if e.get("unverified_fields"):
            warnings.append(f"{eid}: unverified fields {e['unverified_fields']}")

        exp = e.get("note_expires")
        if exp:
            try:
                if _date(exp) < today:
                    warnings.append(f"{eid}: note expired on {exp}; review status/acquisition notes")
            except ValueError:
                err(f"bad note_expires {exp!r}")

        if tles and str(e.get("norad_id")) in tles:
            name = tles[str(e["norad_id"])].get("name", "").strip()
            if name != e.get("object_name"):
                err(f"NORAD {e['norad_id']} is '{name}' in tles.json, catalogue says '{e.get('object_name')}'")
    return errors, warnings


def main() -> int:
    catalogue = json.loads((ROOT / "data/catalogue.json").read_text(encoding="utf-8"))
    tles_path = ROOT / "data/tles.json"
    tles = json.loads(tles_path.read_text(encoding="utf-8")) if tles_path.exists() else None
    errors, warnings = validate(catalogue, tles, dt.date.today())
    for w in warnings:
        print(f"warning: {w}")
    for e in errors:
        print(f"ERROR: {e}")
    print(f"{len(catalogue.get('entries', []))} entries, {len(errors)} errors, {len(warnings)} warnings")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
