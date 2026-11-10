"""Orbit watch: manoeuvre detection from archived element sets, catalogue alerts,
and commercial-constellation members (called by update_data.py).

Inputs:  data/tle_history/*.json.gz (archived element sets, TLE lines or OMM),
         data/tles.json, data/catalogue.json, CelesTrak GP (constellations).
Outputs: data/manoeuvres.json  {norad: [{before, after, delta_a_m, delta_n}]}
         meta.json "catalogue_alerts" (returned to the caller)
         data/tles_constellations.json {entry_id: {members: {norad: {name, omm, epoch}}}}

Manoeuvre detection: for consecutive element sets of a satellite (at most
3 days apart), the mean motion of the later set is predicted from the earlier
one with its first derivative (TLE n-dot); a residual above THRESH_A_M of
semi-major-axis change (|Δa| = (2/3) a |Δn| / n) flags a probable manoeuvre.
Natural decay at 400-900 km changes a by metres per day, and fit noise of
mean elements is of the order of a metre, so tens of metres indicate a
thrust. THRESH_A_M = 25 m is provisional; it is to be checked against the
archive as it grows (archived element sets start on 2026-11-10).

Catalogue alerts: an active entry whose element set is more than
STALE_ALERT_DAYS old (probable end of mission, safe mode or decay), and
entries whose status note has expired.

Limitations: manoeuvres between two archived element sets more than 3 days
apart are not evaluated; small manoeuvres (< 25 m) are not detected; the
first element set after a manoeuvre can itself be of lower quality.
"""

from __future__ import annotations

import datetime as dt
import gzip
import json
import math
import re
import time
from pathlib import Path

MU = 398600.4418  # km^3 s^-2
THRESH_A_M = 25.0
MAX_GAP_DAYS = 3.0
STALE_ALERT_DAYS = 10
CONSTELLATION_MAX_AGE_DAYS = 14
CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php"


# ---------- element-set parsing ----------

def _tle_exp(field: str) -> float:
    """TLE implied-decimal exponent field, e.g. ' 12345-4' -> 0.12345e-4."""
    f = field.strip()
    if not f:
        return 0.0
    sign = -1.0 if f[0] == "-" else 1.0
    f = f.lstrip("+-")
    mant, exp = f[:-2], f[-2:]
    return sign * float(f"0.{mant}") * 10 ** int(exp)


def mean_elements(rec: dict) -> tuple[dt.datetime, float, float]:
    """(epoch, mean motion rev/day, n-dot rev/day^2) from TLE lines or OMM."""
    epoch = dt.datetime.fromisoformat(rec["epoch"].replace("Z", "+00:00"))
    if "omm" in rec:
        o = rec["omm"]
        return epoch, float(o["MEAN_MOTION"]), 2.0 * float(o.get("MEAN_MOTION_DOT", 0.0))
    n = float(rec["line2"][52:63])
    ndot_half = float(rec["line1"][33:43])
    return epoch, n, 2.0 * ndot_half


def semi_major_axis_km(n_rev_day: float) -> float:
    n = n_rev_day * 2 * math.pi / 86400.0
    return (MU / (n * n)) ** (1 / 3)


def detect_manoeuvres(records: list[dict]) -> list[dict]:
    """Probable manoeuvres in a time-ordered list of element sets of one satellite."""
    elems = sorted({mean_elements(r) for r in records}, key=lambda x: x[0])
    out = []
    for (t1, n1, d1), (t2, n2, _d2) in zip(elems, elems[1:]):
        gap = (t2 - t1).total_seconds() / 86400.0
        if gap <= 0 or gap > MAX_GAP_DAYS:
            continue
        predicted = n1 + d1 * gap
        dn = n2 - predicted
        a = semi_major_axis_km(n1)
        da_m = -(2.0 / 3.0) * a * dn / n1 * 1000.0
        if abs(da_m) > THRESH_A_M:
            out.append({"before": t1.strftime("%Y-%m-%dT%H:%M:%SZ"), "after": t2.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "delta_a_m": round(da_m, 1), "delta_n": round(dn, 8)})
    return out


def load_history(history_dir: Path) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {}
    for f in sorted(history_dir.glob("*.json.gz")):
        try:
            day = json.loads(gzip.decompress(f.read_bytes()))
        except (OSError, ValueError):
            continue
        for norad, recs in day.items():
            out.setdefault(norad, []).extend(recs)
    return out


def manoeuvres_from_history(history_dir: Path) -> dict[str, list[dict]]:
    result = {}
    for norad, recs in load_history(history_dir).items():
        found = detect_manoeuvres(recs)
        if found:
            result[norad] = found
    return dict(sorted(result.items(), key=lambda kv: int(kv[0])))


# ---------- catalogue alerts ----------

def catalogue_alerts(catalogue: dict, tles: dict, now: dt.datetime) -> list[dict]:
    alerts = []
    for e in catalogue["entries"]:
        if e.get("status") == "inactive":
            continue
        if e.get("note_expires") and dt.date.fromisoformat(e["note_expires"]) < now.date():
            alerts.append({"id": e["id"], "kind": "note_expired", "detail": e["note_expires"]})
        norad = e.get("norad_id")
        if not isinstance(norad, int) or e.get("swath", {}).get("model") == "continuous_geo":
            continue
        t = tles.get(str(norad))
        if not t:
            alerts.append({"id": e["id"], "kind": "no_elements", "detail": str(norad)})
            continue
        age = (now - dt.datetime.fromisoformat(t["epoch"].replace("Z", "+00:00"))).total_seconds() / 86400.0
        if age > STALE_ALERT_DAYS:
            alerts.append({"id": e["id"], "kind": "stale_elements", "detail": f"{age:.0f} d"})
    return alerts


# ---------- commercial constellations ----------

def constellation_members(session, catalogue: dict, now: dt.datetime, pause_s: float = 1.0) -> tuple[dict, list[str]]:
    """Current members of every constellation entry, as OMM records. Never raises."""
    out, errors = {}, []
    for e in catalogue["entries"]:
        c = e.get("constellation")
        if not c or e.get("status") == "inactive":
            continue
        q = c.get("query", {})
        params = {"FORMAT": "JSON"}
        if q.get("group"):
            params["GROUP"] = q["group"]
        elif q.get("name"):
            params["NAME"] = q["name"]
        else:
            errors.append(f"{e['id']}: constellation query has neither group nor name")
            continue
        try:
            r = session.get(CELESTRAK, params=params, timeout=60)
            r.raise_for_status()
            data = r.json()
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{e['id']}: fetch failed: {exc}")
            continue
        finally:
            time.sleep(pause_s)
        rx = re.compile(q.get("name_regex", ".*"))
        members = {}
        for o in data:
            if not rx.search(o.get("OBJECT_NAME", "")):
                continue
            try:
                epoch = dt.datetime.fromisoformat(o["EPOCH"]).replace(tzinfo=dt.timezone.utc)
            except (KeyError, ValueError):
                continue
            if (now - epoch).days > CONSTELLATION_MAX_AGE_DAYS:
                continue  # no recent elements: decayed or not tracked
            members[str(o["NORAD_CAT_ID"])] = {"name": o["OBJECT_NAME"], "omm": o,
                                                "epoch": epoch.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-4] + "Z"}
        if members:
            out[e["id"]] = {"members": dict(sorted(members.items(), key=lambda kv: int(kv[0])))}
        else:
            errors.append(f"{e['id']}: no current members found")
    return out, errors
