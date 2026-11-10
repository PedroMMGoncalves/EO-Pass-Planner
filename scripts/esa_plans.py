"""Fetch ESA Sentinel-1 and Sentinel-2 acquisition plans and convert them to GeoJSON.

Intended to be called from scripts/update_data.py (every 6 h); has no command line of its own.

Inputs:  the Sentinel Online acquisition-plan pages (static HTML lists of KML links)
           https://sentinels.copernicus.eu/web/sentinel/copernicus/sentinel-1/acquisition-plans
           https://sentinels.copernicus.eu/web/sentinel/copernicus/sentinel-2/acquisition-plans
         and the KML files they link to, served from
           https://sentinels.copernicus.eu/documents/d/sentinel/<name>
         where <name> encodes satellite and nominal validity (UTC), e.g.
           s1c_mp_user_20261106t173554_20261128t193600   (Sentinel-1, about 20 days)
           s2b_mp_acq__kml_20261105t120000_20261123t150000 (Sentinel-2, about 18 days)
Outputs: data/plans/s1/<SAT>.geojson, data/plans/s2/<SAT>.geojson (SAT = S1C, S2B, ...)
         FeatureCollection, one feature per acquisition segment, one feature per line:
           geometry   Polygon, or MultiPolygon when split at the antimeridian
                      (lon/lat, at most 40 vertices per ring, rounded to 0.001 deg,
                      exterior ring counter-clockwise)
           properties satellite, mode, start, stop (ISO UTC, "Z", whole seconds),
                      orbit, rel_orbit; Sentinel-1 also pol, datatake and, for
                      stripmap, swath
         plus a foreign member "plan":
           {format, satellite, mission, sources: [{name, last_modified}],
            window: [start, end], coverage: [[start, end], ...]}
         `coverage` is the union of the nominal validity periods of the plans used,
         clipped to `window` (today 00:00 UTC to today + 30 d). A predicted pass inside
         `coverage` that intersects no segment is "not planned"; a pass outside it has
         "no plan".

Rules:
- Plans are revised and re-issued often (Sentinel-1 almost daily, Sentinel-2 every
  two weeks, with files also replaced in place). For a given instant the plan with
  the latest nominal start not after that instant is authoritative: each plan only
  contributes segments that start before the next plan starts. Older plans are not
  downloaded.
- Only imaging segments are kept: Sentinel-1 modes IW, EW, SM, WV (RFC excluded);
  Sentinel-2 modes NOBS and VIC (SUN, DARK-O, DARK-C, MSMOON, RAW, TEST excluded),
  and Sentinel-2 segments classed NOT_RECORDING are dropped.
- Downloads are conditional (If-Modified-Since): when every plan of a satellite is
  unchanged and already fully inside the stored window, the existing features are
  re-filtered instead of downloading the KML again (each file is 1-3 MB).
- Files are only rewritten when their content changes. A satellite whose listing or
  KML download fails, or whose plans yield no segment, keeps its previous file.
- A satellite with no current plan is left untouched; its stored `coverage` then lies
  in the past, which the browser reads as "no plan".

Limitations:
- The listing is parsed from the page HTML (links inside HTML comments are ignored).
  A change of page layout or file naming yields "no plan links found" errors and no
  new data, not wrong data.
- Validity is taken from the file name; the KML Document name states the same period.
  Link texts on the page are occasionally inconsistent with the file names and are
  not used.
- Footprints are ESA's planned swath polygons, simplified; segments near the poles
  have long edges that are straight in lon/lat, not geodesics. A planned segment is
  not a guaranteed acquisition (anomalies, manoeuvres, late re-planning).
- KML times carry no zone designator; they are UTC.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import time
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from pathlib import Path

import requests

BASE = "https://sentinels.copernicus.eu"
LISTING_URLS = {
    "S1": BASE + "/web/sentinel/copernicus/sentinel-1/acquisition-plans",
    "S2": BASE + "/web/sentinel/copernicus/sentinel-2/acquisition-plans",
}
DOCUMENT_URL = BASE + "/documents/d/sentinel/{name}"
PLAN_NAME = re.compile(
    r"(?P<sat>s[12][a-z])_mp_(?:user|acq__kml)_(?P<start>\d{8}t\d{6})_(?P<stop>\d{8}t\d{6})",
    re.IGNORECASE)
KML_NS = "{http://www.opengis.net/kml/2.2}"
FORMAT_VERSION = 1
WINDOW_DAYS = 30
MAX_VERTICES = 40
ROUND_DEG = 3
S1_MODES = {"IW", "EW", "SM", "WV"}
S2_MODES = {"NOBS", "VIC"}
S2_DROP_CLASS = "NOT_RECORDING"
REQUEST_PAUSE_S = 1.0
TIMEOUT_S = 60


# ---------- time helpers ----------

def iso_z(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(text: str) -> dt.datetime:
    """ISO 8601 time, with or without "Z" or fraction; naive values are UTC."""
    t = dt.datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    return t.replace(tzinfo=dt.timezone.utc) if t.tzinfo is None else t.astimezone(dt.timezone.utc)


def day_start(today: dt.date | dt.datetime) -> dt.datetime:
    """00:00 UTC of the given date (an aware datetime is first converted to UTC)."""
    if isinstance(today, dt.datetime):
        today = (today if today.tzinfo else today.replace(tzinfo=dt.timezone.utc)) \
            .astimezone(dt.timezone.utc).date()
    return dt.datetime(today.year, today.month, today.day, tzinfo=dt.timezone.utc)


def plan_window(today: dt.date | dt.datetime) -> tuple[dt.datetime, dt.datetime]:
    t0 = day_start(today)
    return t0, t0 + dt.timedelta(days=WINDOW_DAYS)


# ---------- listing ----------

class _LinkParser(HTMLParser):
    """Collects href values of <a> elements; HTML comments are skipped by HTMLParser."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.hrefs.append(href)


def parse_listing(html: str, mission: str) -> list[dict]:
    """All KML plans of one mission ('S1' or 'S2') linked from a listing page.

    The URL is rebuilt from the file name, since some links on the page are absolute,
    relative or malformed ("https://documents/d/...").
    """
    p = _LinkParser()
    p.feed(html)
    plans = {}
    for href in p.hrefs:
        m = PLAN_NAME.search(href)
        if not m or not m.group("sat").upper().startswith(mission):
            continue
        name = m.group(0).lower()
        plans[name] = {
            "name": name.upper(),
            "url": DOCUMENT_URL.format(name=name),
            "mission": mission,
            "satellite": m.group("sat").upper(),
            "valid_from": dt.datetime.strptime(m.group("start").upper(), "%Y%m%dT%H%M%S")
                            .replace(tzinfo=dt.timezone.utc),
            "valid_to": dt.datetime.strptime(m.group("stop").upper(), "%Y%m%dT%H%M%S")
                          .replace(tzinfo=dt.timezone.utc),
        }
    return sorted(plans.values(), key=lambda q: (q["satellite"], q["valid_from"], q["valid_to"]))


def select_plans(plans: list[dict], today: dt.date | dt.datetime) -> list[dict]:
    """Plans needed to cover today 00:00 UTC to +30 d, per satellite.

    Keeps the latest plan starting at or before the window start (if still valid then)
    and every plan starting inside the window; earlier plans are superseded. Plans with
    the same start keep the longer one.
    """
    w0, w1 = plan_window(today)
    out = []
    for sat in sorted({q["satellite"] for q in plans}):
        own = {}
        for q in plans:
            if q["satellite"] == sat:
                prev = own.get(q["valid_from"])
                if prev is None or q["valid_to"] > prev["valid_to"]:
                    own[q["valid_from"]] = q
        ordered = [own[k] for k in sorted(own)]
        base = [q for q in ordered if q["valid_from"] <= w0]
        chosen = [base[-1]] if base and base[-1]["valid_to"] >= w0 else []
        chosen += [q for q in ordered if w0 < q["valid_from"] <= w1]
        out += chosen
    return out


def list_current_plans(session: requests.Session, today: dt.date | dt.datetime) -> list[dict]:
    """Fetch both listing pages and return the plans needed for today -> +30 d.

    Each item: {name, url, mission 'S1'|'S2', satellite e.g. 'S1C', valid_from, valid_to}
    with aware UTC datetimes. Raises RuntimeError if a page fails or has no plan link.
    """
    plans = []
    for mission, url in LISTING_URLS.items():
        r = _get(session, url)
        found = parse_listing(r.text, mission)
        if not found:
            raise RuntimeError(f"{mission}: no plan links found at {url}")
        plans += found
        time.sleep(REQUEST_PAUSE_S)
    return select_plans(plans, today)


# ---------- geometry ----------

def parse_coordinates(text: str) -> list[tuple[float, float]]:
    pts = []
    for tok in text.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            pts.append((float(parts[0]), float(parts[1])))
    return pts


def unwrap(ring: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Make longitudes continuous (steps of more than 180 deg are taken the short way)."""
    if not ring:
        return []
    out = [ring[0]]
    for lon, lat in ring[1:]:
        prev = out[-1][0]
        while lon - prev > 180:
            lon -= 360
        while lon - prev < -180:
            lon += 360
        out.append((lon, lat))
    return out


def _seg_dist(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    if dx == 0 and dy == 0:
        return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5


def _dp(pts, tol):
    """Douglas-Peucker on an open polyline (iterative)."""
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        best, k = -1.0, -1
        for m in range(i + 1, j):
            d = _seg_dist(pts[m], pts[i], pts[j])
            if d > best:
                best, k = d, m
        if k >= 0 and best > tol:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [p for p, f in zip(pts, keep) if f]


def simplify_ring(ring: list[tuple[float, float]], max_vertices: int = MAX_VERTICES,
                  tol: float = 10 ** -ROUND_DEG) -> list[tuple[float, float]]:
    """Simplify a ring to at most `max_vertices` distinct vertices.

    Input may be open or closed; output is open (no repeated first vertex). The ring is
    split at its first vertex and the vertex farthest from it, and Douglas-Peucker is
    applied to both halves with a tolerance doubled until the limit is met.
    """
    pts = list(ring)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts = pts[:-1]
    if len(pts) <= 3:
        return pts
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    a, b = pts[:far + 1], pts[far:] + [pts[0]]
    while True:
        out = _dp(a, tol)[:-1] + _dp(b, tol)[:-1]
        if len(out) <= max_vertices:
            return out
        tol *= 2


def _round_ring(ring):
    out = []
    for lon, lat in ring:
        p = [round(lon, ROUND_DEG) + 0.0, round(lat, ROUND_DEG) + 0.0]
        if not out or p != out[-1]:
            out.append(p)
    while len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def _signed_area(ring) -> float:
    return sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:] + ring[:1])) / 2


def _close_ccw(ring):
    """Closed ring, counter-clockwise; None if degenerate (fewer than 3 vertices or no area)."""
    if len(ring) < 3 or _signed_area(ring) == 0:
        return None
    if _signed_area(ring) < 0:
        ring = ring[::-1]
    return ring + [list(ring[0])]


def _clip(ring, x0: float, keep_below: bool):
    """Sutherland-Hodgman clip of a ring by the vertical line lon = x0."""
    inside = (lambda p: p[0] <= x0) if keep_below else (lambda p: p[0] >= x0)
    out = []
    for i, cur in enumerate(ring):
        prev = ring[i - 1]
        if inside(cur):
            if not inside(prev):
                out.append(_cross(prev, cur, x0))
            out.append(cur)
        elif inside(prev):
            out.append(_cross(prev, cur, x0))
    return out


def _cross(a, b, x0):
    t = (x0 - a[0]) / (b[0] - a[0])
    return (x0, a[1] + t * (b[1] - a[1]))


def ring_to_geometry(polygon: list[list[float]]) -> dict | None:
    """GeoJSON geometry of an unwrapped ring; split into a MultiPolygon at +-180 deg."""
    ring = [tuple(p) for p in polygon]
    if len(ring) > 1 and ring[0] == ring[-1]:
        ring = ring[:-1]
    lo, hi = min(p[0] for p in ring), max(p[0] for p in ring)
    if -180 <= lo and hi <= 180:
        r = _close_ccw(_round_ring(ring))
        return {"type": "Polygon", "coordinates": [r]} if r else None
    edge = 180.0 if hi > 180 else -180.0
    shift = -360.0 if hi > 180 else 360.0
    parts = [_clip(ring, edge, keep_below=edge > 0),
             [(x + shift, y) for x, y in _clip(ring, edge, keep_below=edge < 0)]]
    rings = [r for r in (_close_ccw(_round_ring(p)) for p in parts) if r]
    if not rings:
        return None
    if len(rings) == 1:
        return {"type": "Polygon", "coordinates": rings}
    return {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}


# ---------- KML ----------

def _iter_placemarks(el, folders=()):
    for child in el:
        if child.tag == KML_NS + "Placemark":
            yield child, folders
        elif child.tag in (KML_NS + "Folder", KML_NS + "Document"):
            name = child.findtext(KML_NS + "name") or ""
            yield from _iter_placemarks(child, folders + (name,) if child.tag == KML_NS + "Folder" else folders)


def _int_or_none(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def kml_to_segments(kml_bytes: bytes, satellite: str) -> list[dict]:
    """Convert one ESA acquisition-plan KML into a list of segment dicts.

    Each segment: {satellite, mode, start, stop (ISO UTC "Z"), orbit, rel_orbit,
    polygon [[lon, lat], ...]} plus pol, datatake and swath (stripmap only) for
    Sentinel-1. `polygon` is closed, simplified to at most 40 vertices, rounded to
    0.001 deg, with continuous longitudes (it may extend beyond +-180 deg).
    Non-imaging modes and unusable placemarks are skipped; sorted by start.
    Raises ValueError for unparseable XML or documents declaring entities.
    """
    if b"<!ENTITY" in kml_bytes[:4096]:
        raise ValueError("KML declares XML entities; refused")
    try:
        root = ET.fromstring(kml_bytes)
    except ET.ParseError as exc:
        raise ValueError(f"KML parse error: {exc}") from exc
    sat = satellite.upper()
    s1 = sat.startswith("S1")
    out = []
    for pm, folders in _iter_placemarks(root):
        data = {d.get("name"): (d.findtext(KML_NS + "value") or "").strip()
                for d in pm.iter(KML_NS + "Data")}
        mode = data.get("Mode", "")
        if s1:
            if mode not in S1_MODES or data.get("SatelliteId", sat).upper() != sat:
                continue
        else:
            style = (pm.findtext(KML_NS + "styleUrl") or "").lstrip("#")
            if mode not in S2_MODES or S2_DROP_CLASS in style or S2_DROP_CLASS in folders:
                continue
        try:
            start = parse_utc(data.get("ObservationTimeStart")
                              or pm.findtext(f"{KML_NS}TimeSpan/{KML_NS}begin"))
            stop = parse_utc(data.get("ObservationTimeStop")
                             or pm.findtext(f"{KML_NS}TimeSpan/{KML_NS}end"))
            ring = parse_coordinates(pm.findtext(f".//{KML_NS}LinearRing/{KML_NS}coordinates") or "")
        except (TypeError, ValueError, AttributeError):
            continue
        if stop < start or len(ring) < 3:
            continue
        unwrapped = unwrap(ring)
        crosses = any(abs(x) > 180 for x, _ in unwrapped)
        simple = _round_ring(simplify_ring(unwrapped, MAX_VERTICES - 2 if crosses else MAX_VERTICES))
        poly = _close_ccw(simple)
        if poly is None:
            continue
        stop_s = stop if stop.microsecond == 0 else stop.replace(microsecond=0) + dt.timedelta(seconds=1)
        seg = {"satellite": sat, "mode": mode}
        if s1:
            seg["pol"] = data.get("Polarisation") or None
            if data.get("Swath") and data["Swath"] != "NA":
                seg["swath"] = data["Swath"]
            seg["datatake"] = data.get("DatatakeId") or None
        seg.update({
            "start": iso_z(start.replace(microsecond=0)),
            "stop": iso_z(stop_s),
            "orbit": _int_or_none(data.get("OrbitAbsolute")),
            "rel_orbit": _int_or_none(data.get("OrbitRelative")),
            "polygon": poly,
        })
        out.append({k: v for k, v in seg.items() if v is not None})
    out.sort(key=lambda s: (s["start"], s["stop"]))
    return out


def merge_plan_segments(plan_segments: list[tuple[dict, list[dict]]]) -> list[dict]:
    """Combine segments of successive plans of one satellite.

    `plan_segments` is a list of (plan, segments). A plan contributes only segments
    starting before the next plan's nominal start, so newer plans supersede older ones.
    """
    ordered = sorted(plan_segments, key=lambda ps: ps[0]["valid_from"])
    out = []
    for i, (plan, segs) in enumerate(ordered):
        lo = iso_z(plan["valid_from"]) if i else ""
        hi = iso_z(ordered[i + 1][0]["valid_from"]) if i + 1 < len(ordered) else "~"
        out += [s for s in segs if lo <= s["start"] < hi]
    out.sort(key=lambda s: (s["start"], s["stop"]))
    return out


# ---------- output ----------

def _merge_intervals(intervals):
    out = []
    for a, b in sorted(intervals):
        if out and a <= out[-1][1]:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def plan_meta(satellite: str, plans: list[dict], today, last_modified: dict | None = None) -> dict:
    """The "plan" foreign member of a satellite file."""
    w0, w1 = plan_window(today)
    last_modified = last_modified or {}
    own = sorted((p for p in plans if p["satellite"] == satellite), key=lambda p: p["valid_from"])
    cov = _merge_intervals([(max(p["valid_from"], w0), min(p["valid_to"], w1)) for p in own
                            if p["valid_to"] >= w0 and p["valid_from"] <= w1])
    return {
        "format": FORMAT_VERSION,
        "satellite": satellite,
        "mission": satellite[:2],
        "sources": [{"name": p["name"], "last_modified": last_modified.get(p["name"])} for p in own],
        "window": [iso_z(w0), iso_z(w1)],
        "coverage": [[iso_z(a), iso_z(b)] for a, b in cov],
    }


def segment_to_feature(seg: dict) -> dict | None:
    geom = seg.get("geometry") or ring_to_geometry(seg["polygon"])
    if geom is None:
        return None
    props = {k: v for k, v in seg.items() if k not in ("polygon", "geometry")}
    return {"type": "Feature", "properties": props, "geometry": geom}


def dump_collection(meta: dict, features: list[dict]) -> str:
    """Compact GeoJSON, one feature per line so that plan revisions give small diffs."""
    c = (",", ":")
    head = '{"type":"FeatureCollection","plan":' + json.dumps(meta, separators=c) + ',"features":['
    body = ",\n".join(json.dumps(f, separators=c, ensure_ascii=False) for f in features)
    return head + ("\n" + body + "\n" if body else "") + "]}\n"


def write_plans(out_dir: Path, segments: list[dict], today, plans: list[dict] | None = None,
                last_modified: dict | None = None) -> list[str]:
    """Write <out_dir>/s1/<SAT>.geojson and <out_dir>/s2/<SAT>.geojson; return changes.

    `out_dir` is the plans directory (data/plans). Only segments with stop >= today
    00:00 UTC and start <= today + 30 d are written, sorted by start. A satellite with
    no segment in that window is not written, so a good file is never replaced by an
    empty one. `plans` (as from list_current_plans) and `last_modified` ({name: HTTP
    Last-Modified}) fill the "plan" member; without `plans` the coverage is empty.
    Files are rewritten only when their content changes.
    """
    out_dir = Path(out_dir)
    w0, w1 = plan_window(today)
    lo, hi = iso_z(w0), iso_z(w1)
    by_sat: dict[str, list[dict]] = {}
    for s in segments:
        if s["stop"] >= lo and s["start"] <= hi:
            by_sat.setdefault(s["satellite"].upper(), []).append(s)
    changes = []
    for sat, segs in sorted(by_sat.items()):
        segs.sort(key=lambda s: (s["start"], s["stop"]))
        feats = [f for f in (segment_to_feature(s) for s in segs) if f]
        if not feats:
            continue
        meta = plan_meta(sat, plans or [], today, last_modified)
        text = dump_collection(meta, feats)
        path = out_dir / sat[:2].lower() / f"{sat}.geojson"
        if path.exists() and path.read_text(encoding="utf-8") == text:
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        src = ", ".join(p["name"] for p in meta["sources"]) or "no source listed"
        changes.append(f"plans {sat}: {len(feats)} segments {feats[0]['properties']['start']} "
                       f"to {feats[-1]['properties']['stop']} ({src})")
    return changes


# ---------- network ----------

def _get(session: requests.Session, url: str, headers: dict | None = None,
         retries: int = 3) -> requests.Response:
    """GET with retries; returns 200 or 304 responses, raises RuntimeError otherwise."""
    last = None
    for attempt in range(retries):
        try:
            r = session.get(url, headers=headers or {}, timeout=TIMEOUT_S)
            if r.status_code in (200, 304):
                return r
            last = f"HTTP {r.status_code}"
            if 400 <= r.status_code < 500 and r.status_code != 429:
                break
        except requests.RequestException as exc:
            last = str(exc)
        time.sleep(REQUEST_PAUSE_S * 2 ** (attempt + 1))
    raise RuntimeError(f"{url}: {last or 'unknown error'}")


def _read_existing(path: Path) -> dict | None:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
        return obj if obj.get("plan", {}).get("format") == FORMAT_VERSION else None
    except (OSError, ValueError, AttributeError):
        return None


def _http_date_ok(value: str | None) -> bool:
    try:
        return value is not None and parsedate_to_datetime(value) is not None
    except (TypeError, ValueError):
        return False


def update_plans(session: requests.Session, data_dir: Path,
                 now: dt.datetime) -> tuple[list[str], list[str]]:
    """Refresh <data_dir>/plans from ESA. Returns (changes, errors); never raises.

    The caller sets the session User-Agent. Each satellite is handled independently:
    a failure for one keeps its previous file and is reported in `errors`.
    """
    changes: list[str] = []
    errors: list[str] = []
    try:
        out_dir = Path(data_dir) / "plans"
        try:
            plans = list_current_plans(session, now)
        except Exception as exc:  # noqa: BLE001
            return changes, [f"ESA plans listing: {exc}"]
        _, w1 = plan_window(now)
        for sat in sorted({p["satellite"] for p in plans}):
            own = [p for p in plans if p["satellite"] == sat]
            try:
                changes += _update_satellite(session, out_dir, sat, own, now, w1)
            except Exception as exc:  # noqa: BLE001 - every failure is reported, none is fatal
                errors.append(f"{sat} plan: {exc}")
    except Exception as exc:  # noqa: BLE001
        errors.append(f"ESA plans: {exc}")
    return changes, errors


def _update_satellite(session, out_dir: Path, sat: str, own: list[dict], now: dt.datetime,
                      window_end: dt.datetime) -> list[str]:
    path = out_dir / sat[:2].lower() / f"{sat}.geojson"
    old = _read_existing(path)
    old_lm = {}
    old_end = None
    if old:
        old_lm = {s["name"]: s.get("last_modified") for s in old["plan"].get("sources", [])}
        old_end = parse_utc(old["plan"]["window"][1])

    # Conditional requests: reuse the stored features if no plan changed and nothing
    # beyond the previous window end could be missing.
    same_set = old is not None and set(old_lm) == {p["name"] for p in own}
    responses: dict[str, requests.Response] = {}
    for p in own:
        lm = old_lm.get(p["name"]) if same_set else None
        headers = {"If-Modified-Since": lm} if _http_date_ok(lm) else None
        responses[p["name"]] = _get(session, p["url"], headers)
        time.sleep(REQUEST_PAUSE_S)
    unchanged = all(r.status_code == 304 for r in responses.values())
    if unchanged and old_end is not None and max(p["valid_to"] for p in own) <= old_end:
        segs = [dict(f["properties"], geometry=f["geometry"]) for f in old.get("features", [])]
        return write_plans(out_dir, segs, now, own, old_lm)

    last_modified = {}
    plan_segments = []
    for p in own:
        r = responses[p["name"]]
        if r.status_code == 304:
            r = _get(session, p["url"])
            time.sleep(REQUEST_PAUSE_S)
        last_modified[p["name"]] = r.headers.get("Last-Modified")
        segs = kml_to_segments(r.content, sat)
        if not segs:
            raise RuntimeError(f"{p['name']}: no usable segment in KML")
        plan_segments.append((p, segs))
    merged = merge_plan_segments(plan_segments)
    lo, hi = iso_z(day_start(now)), iso_z(window_end)
    if not any(s["stop"] >= lo and s["start"] <= hi for s in merged):
        raise RuntimeError("no segment inside the window; previous file kept")
    return write_plans(out_dir, merged, now, own, last_modified)
