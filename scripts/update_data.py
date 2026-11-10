"""Fetch external data for the static site and commit-ready JSON.

Run by .github/workflows/update-data.yml every 6 h; can also be run locally.

Inputs:  data/catalogue.json (NORAD ids, expected CelesTrak OBJECT_NAME).
Outputs: data/tles.json        {norad: {name, line1, line2, epoch, source, fetched}}
                                or, for catalogue numbers above 99 999 (no legacy TLE
                                exists), {norad: {name, omm, epoch, source, fetched}} where
                                `omm` is CelesTrak's OMM JSON record (CCSDS mean elements)
         data/tle_history/YYYY-MM-DD.json.gz  {norad: [{line1, line2, epoch} | {omm, epoch}, ...]}
         data/meta.json        last update, per-source status, stale TLEs
         --changes-file PATH   one line per change (used as the commit message)
Exit code: 0 OK; 1 if any hard error (name mismatch, checksum failure, fetch
failure). Good data is still written before exiting 1.

Rules:
- Never overwrite good data with an empty or failed fetch: a failed satellite
  keeps its previous TLE.
- Files are only rewritten when their content changes, and gzip is written
  with mtime=0, so an unchanged run produces no git diff.
- A NORAD/OBJECT_NAME mismatch is a hard error and that TLE is not written.
- Catalogue numbers above 99 999 do not fit the 5-digit TLE field. CelesTrak
  serves them only as OMM (JSON); those are stored as OMM and propagated with
  satellite.js json2satrec (same SGP4 mean elements).

Limitations:
- ESA Sentinel-1/-2 acquisition plans are converted by scripts/esa_plans.py
  (see its docstring); plan failures are reported in meta.json and never
  remove existing plan files. Plan errors do not change the exit code.
- CelesTrak is the single TLE source. Its GP data can lag after manoeuvres.
- History keeps every distinct epoch seen per day; days with no run have no file.
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import sys
import time
from pathlib import Path

import requests

import esa_plans

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HISTORY = DATA / "tle_history"
CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php"
USER_AGENT = "EO-Pass-Planner data updater (https://github.com/PedroMMGoncalves/EO-Pass-Planner)"
HISTORY_DAYS = 400
STALE_DAYS = 7
REQUEST_PAUSE_S = 1.0


# ---------- pure helpers (unit tested) ----------

def tle_checksum_ok(line: str) -> bool:
    """Modulo-10 checksum of a TLE line: digits count their value, '-' counts 1."""
    if len(line) < 69 or not line[68].isdigit():
        return False
    total = sum(int(c) if c.isdigit() else (1 if c == "-" else 0) for c in line[:68])
    return total % 10 == int(line[68])


def epoch_from_line1(line1: str) -> dt.datetime:
    """TLE epoch (columns 19-32, YYDDD.DDDDDDDD) as an aware UTC datetime."""
    yy = int(line1[18:20])
    year = 2000 + yy if yy < 57 else 1900 + yy
    doy = float(line1[20:32])
    return dt.datetime(year, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=doy - 1)


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"


def parse_tle_text(text: str) -> list[tuple[str, str, str]]:
    """Parse CelesTrak FORMAT=TLE (3-line) text into (name, line1, line2) tuples."""
    lines = [ln.rstrip() for ln in text.strip().splitlines() if ln.strip()]
    out = []
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 "):
            out.append((name.strip(), l1, l2))
            i += 3
        else:
            i += 1
    return out


def validate_tle(name: str, l1: str, l2: str, norad: int, expected_name: str) -> list[str]:
    """Return a list of hard errors for one TLE (empty if valid)."""
    errs = []
    if not tle_checksum_ok(l1):
        errs.append(f"{norad}: line 1 checksum failed")
    if not tle_checksum_ok(l2):
        errs.append(f"{norad}: line 2 checksum failed")
    if l1[2:7].strip() != str(norad) or l2[2:7].strip() != str(norad):
        errs.append(f"{norad}: catalogue number in TLE lines does not match")
    if name != expected_name:
        errs.append(f"{norad}: CelesTrak OBJECT_NAME is '{name}', catalogue expects '{expected_name}'")
    return errs


OMM_FIELDS = ("OBJECT_NAME", "OBJECT_ID", "EPOCH", "MEAN_MOTION", "ECCENTRICITY", "INCLINATION",
              "RA_OF_ASC_NODE", "ARG_OF_PERICENTER", "MEAN_ANOMALY", "NORAD_CAT_ID", "BSTAR",
              "MEAN_MOTION_DOT", "MEAN_MOTION_DDOT")


def validate_omm(omm: dict, norad: int, expected_name: str) -> list[str]:
    """Return a list of hard errors for one OMM record (empty if valid)."""
    errs = [f"{norad}: OMM lacks {k}" for k in OMM_FIELDS if k not in omm]
    if errs:
        return errs
    if int(omm["NORAD_CAT_ID"]) != norad:
        errs.append(f"{norad}: OMM catalogue number is {omm['NORAD_CAT_ID']}")
    if omm["OBJECT_NAME"] != expected_name:
        errs.append(f"{norad}: CelesTrak OBJECT_NAME is '{omm['OBJECT_NAME']}', catalogue expects '{expected_name}'")
    try:
        mm = float(omm["MEAN_MOTION"]); ecc = float(omm["ECCENTRICITY"])
        if not (0.5 < mm < 20 and 0 <= ecc < 1):
            errs.append(f"{norad}: OMM elements out of range (mean motion {mm}, eccentricity {ecc})")
        dt.datetime.fromisoformat(omm["EPOCH"])
    except (TypeError, ValueError) as exc:
        errs.append(f"{norad}: OMM value error: {exc}")
    return errs


def omm_epoch(omm: dict) -> dt.datetime:
    return dt.datetime.fromisoformat(omm["EPOCH"]).replace(tzinfo=dt.timezone.utc)


def merge_history(day: dict, tles: dict) -> dict:
    """Add each element set to a day's history if its epoch is not already present."""
    out = {k: list(v) for k, v in day.items()}
    for norad, t in tles.items():
        rec = ({"omm": t["omm"], "epoch": t["epoch"]} if "omm" in t
               else {"line1": t["line1"], "line2": t["line2"], "epoch": t["epoch"]})
        lst = out.setdefault(norad, [])
        if all(r["epoch"] != rec["epoch"] for r in lst):
            lst.append(rec)
            lst.sort(key=lambda r: r["epoch"])
    return dict(sorted(out.items(), key=lambda kv: int(kv[0])))


# ---------- I/O ----------

def dump_json(obj) -> str:
    return json.dumps(obj, indent=1, ensure_ascii=False, sort_keys=False) + "\n"


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")
    return True


def write_gz_if_changed(path: Path, obj) -> bool:
    raw = json.dumps(obj, separators=(",", ":")).encode()
    data = gzip.compress(raw, mtime=0)
    if path.exists() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return True


def get(session: requests.Session, params: dict, retries: int = 3) -> str:
    last = None
    for attempt in range(retries):
        try:
            r = session.get(CELESTRAK, params=params, timeout=30)
            if r.status_code == 200:
                return r.text
            last = f"HTTP {r.status_code}"
        except requests.RequestException as exc:
            last = str(exc)
        time.sleep(REQUEST_PAUSE_S * 2 ** (attempt + 1))
    raise RuntimeError(last or "unknown error")


def fetch_tles(catalogue: dict, old: dict, now: dt.datetime) -> tuple[dict, list[str], list[str]]:
    """Return (tles, changes, errors). Failed satellites keep their old entry."""
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    tles = dict(old)
    changes, errors = [], []

    wanted: dict[int, str] = {}
    for e in catalogue["entries"]:
        if e.get("status") == "inactive":
            continue
        norad = e.get("norad_id")
        if not isinstance(norad, int):
            if e.get("cospar_id"):
                errors.append(f"{e['id']}: no NORAD id; resolve from COSPAR {e['cospar_id']} "
                              f"({CELESTRAK}?INTDES={e['cospar_id']}&FORMAT=JSON) and add it to the catalogue")
            continue
        wanted[norad] = e["object_name"]

    for norad, expected in sorted(wanted.items()):
        if norad > 99999:
            try:
                data = json.loads(get(session, {"CATNR": norad, "FORMAT": "JSON"}))
                if len(data) != 1:
                    raise RuntimeError(f"expected 1 OMM record, got {len(data)}")
                omm = data[0]
                errs = validate_omm(omm, norad, expected)
                if errs:
                    errors.extend(errs)
                    continue
                key = str(norad)
                prev = old.get(key)
                if prev and prev.get("omm") == omm:
                    continue
                tles[key] = {"name": omm["OBJECT_NAME"], "omm": omm, "epoch": iso(omm_epoch(omm)),
                             "source": "celestrak-omm", "fetched": iso(now)}
                changes.append(f"OMM {omm['OBJECT_NAME']} ({norad}) epoch {tles[key]['epoch']}")
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{norad}: fetch failed: {exc}")
            finally:
                time.sleep(REQUEST_PAUSE_S)
            continue
        try:
            text = get(session, {"CATNR": norad, "FORMAT": "TLE"})
            parsed = parse_tle_text(text)
            if len(parsed) != 1:
                raise RuntimeError(f"expected 1 TLE, got {len(parsed)}: {text.strip()[:80]!r}")
            name, l1, l2 = parsed[0]
            errs = validate_tle(name, l1, l2, norad, expected)
            if errs:
                errors.extend(errs)
                continue
            key = str(norad)
            prev = old.get(key)
            if prev and prev.get("line1") == l1 and prev.get("line2") == l2:
                continue
            tles[key] = {
                "name": name, "line1": l1, "line2": l2,
                "epoch": iso(epoch_from_line1(l1)), "source": "celestrak", "fetched": iso(now),
            }
            changes.append(f"TLE {name} ({norad}) epoch {tles[key]['epoch']}")
        except Exception as exc:  # noqa: BLE001 - every failure is reported, none is fatal here
            errors.append(f"{norad}: fetch failed: {exc}")
        finally:
            time.sleep(REQUEST_PAUSE_S)
    tles = dict(sorted(tles.items(), key=lambda kv: int(kv[0])))
    return tles, changes, errors


def prune_history(today: dt.date) -> list[str]:
    removed = []
    cutoff = today - dt.timedelta(days=HISTORY_DAYS)
    for f in sorted(HISTORY.glob("*.json.gz")):
        try:
            d = dt.date.fromisoformat(f.name[:10])
        except ValueError:
            continue
        if d < cutoff:
            f.unlink()
            removed.append(f"pruned history {f.name}")
    return removed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--changes-file", type=Path, help="write the list of changes here")
    args = ap.parse_args(argv)

    now = dt.datetime.now(dt.timezone.utc)
    catalogue = json.loads((DATA / "catalogue.json").read_text(encoding="utf-8"))
    tles_path = DATA / "tles.json"
    old = json.loads(tles_path.read_text(encoding="utf-8")) if tles_path.exists() else {}

    tles, changes, errors = fetch_tles(catalogue, old, now)
    write_if_changed(tles_path, dump_json(tles))

    day_path = HISTORY / f"{now.date().isoformat()}.json.gz"
    day = json.loads(gzip.decompress(day_path.read_bytes())) if day_path.exists() else {}
    if write_gz_if_changed(day_path, merge_history(day, tles)):
        changes.append(f"history {day_path.name}")
    changes += prune_history(now.date())

    plan_session = requests.Session()
    plan_session.headers["User-Agent"] = USER_AGENT
    plan_changes, plan_errors = esa_plans.update_plans(plan_session, DATA, now)
    changes += plan_changes

    meta_path = DATA / "meta.json"
    meta_old = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    stale = sorted(
        (int(k) for k, t in tles.items()
         if (now - dt.datetime.fromisoformat(t["epoch"].replace("Z", "+00:00"))).days > STALE_DAYS)
    )
    sources = {
        "celestrak": {"ok": not errors, "errors": errors},
        "esa_plans": {"ok": not plan_errors, "errors": plan_errors},
    }
    if changes or sources != meta_old.get("sources") or stale != meta_old.get("stale_tles"):
        meta = {
            "updated_utc": iso(now) if changes else meta_old.get("updated_utc", iso(now)),
            "catalogue_version": catalogue.get("version"),
            "tle_count": len(tles),
            "stale_tles": stale,
            "sources": sources,
        }
        if write_if_changed(meta_path, dump_json(meta)) and not changes:
            changes.append("meta.json: source status changed")

    for e in errors:
        print(f"ERROR: {e}", file=sys.stderr)
    for c in changes:
        print(c)
    if args.changes_file:
        args.changes_file.write_text("\n".join(changes) + ("\n" if changes else ""), encoding="utf-8")
    for e in plan_errors:
        print(f"warning (ESA plans): {e}", file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
