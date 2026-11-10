"""Unit tests for scripts/esa_plans.py (offline).

Fixtures in tests/fixtures are trimmed copies of the Sentinel Online listing pages and
of ESA acquisition-plan KML files retrieved on 2026-11-10 (a few placemarks each).

Run: python -m unittest discover -s tests -p "test_esa_plans.py"
"""

import datetime as dt
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "scripts"))

import esa_plans as ep  # noqa: E402

ep.REQUEST_PAUSE_S = 0.0
UTC = dt.timezone.utc
LM = "Tue, 10 Nov 2026 11:12:58 GMT"


def fixture_bytes(name: str) -> bytes:
    return (FIX / name).read_bytes()


def listing_plans() -> list[dict]:
    return (ep.parse_listing((FIX / "esa_plans_listing_s1.html").read_text(encoding="utf-8"), "S1")
            + ep.parse_listing((FIX / "esa_plans_listing_s2.html").read_text(encoding="utf-8"), "S2"))


def area(ring) -> float:
    return abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(ring, ring[1:]))) / 2


class FakeResponse:
    def __init__(self, status: int, body: bytes = b"", headers: dict | None = None):
        self.status_code = status
        self.content = body
        self.text = body.decode("utf-8", "replace")
        self.headers = headers or {}


class FakeSession:
    """Serves the listing fixtures and selected KML fixtures; honours If-Modified-Since."""

    def __init__(self, kml: dict[str, bytes], fail: set[str] = frozenset(), broken: bool = False):
        self.kml = kml
        self.fail = set(fail)
        self.broken = broken
        self.full_downloads: list[str] = []

    def get(self, url, headers=None, timeout=None):
        if self.broken:
            raise ValueError("unexpected failure")
        headers = headers or {}
        if url == ep.LISTING_URLS["S1"]:
            return FakeResponse(200, fixture_bytes("esa_plans_listing_s1.html"))
        if url == ep.LISTING_URLS["S2"]:
            return FakeResponse(200, fixture_bytes("esa_plans_listing_s2.html"))
        name = url.rsplit("/", 1)[-1]
        if name in self.fail or name not in self.kml:
            return FakeResponse(404)
        if headers.get("If-Modified-Since") == LM:
            return FakeResponse(304, headers={"Last-Modified": LM})
        self.full_downloads.append(name)
        return FakeResponse(200, self.kml[name], {"Last-Modified": LM})


class Listing(unittest.TestCase):
    def test_parse_listing_names_urls_and_validity(self):
        plans = listing_plans()
        names = {p["name"] for p in plans}
        self.assertIn("S1C_MP_USER_20261106T173554_20261128T193600", names)
        self.assertIn("S2B_MP_ACQ__KML_20261105T120000_20261123T150000", names)
        p = next(p for p in plans if p["name"] == "S1D_MP_USER_20261109T175423_20261129T200300")
        self.assertEqual(p["mission"], "S1")
        self.assertEqual(p["satellite"], "S1D")
        self.assertEqual(p["url"], "https://sentinels.copernicus.eu/documents/d/sentinel/"
                                   "s1d_mp_user_20261109t175423_20261129t200300")
        self.assertEqual(p["valid_from"], dt.datetime(2026, 11, 9, 17, 54, 23, tzinfo=UTC))
        self.assertEqual(p["valid_to"], dt.datetime(2026, 11, 29, 20, 3, 0, tzinfo=UTC))

    def test_malformed_and_absolute_links_are_rebuilt(self):
        urls = {p["url"] for p in listing_plans()}
        self.assertIn("https://sentinels.copernicus.eu/documents/d/sentinel/"
                      "s1d_mp_user_20261008t182319_20261015t200700", urls)
        self.assertFalse(any(u.startswith("https://documents") for u in urls))

    def test_commented_links_ignored(self):
        names = {p["name"] for p in listing_plans()}
        self.assertNotIn("S2B_MP_ACQ__KML_20251204T120000_20251222T150000", names)
        self.assertNotIn("S2A_MP_ACQ__KML_20251212T150000_20251229T180000", names)

    def test_mission_filter(self):
        html = (FIX / "esa_plans_listing_s1.html").read_text(encoding="utf-8")
        self.assertEqual(ep.parse_listing(html, "S2"), [])

    def test_select_plans_latest_and_future(self):
        sel = ep.select_plans(listing_plans(), dt.date(2026, 11, 10))
        self.assertEqual(sorted(p["name"] for p in sel), [
            "S1C_MP_USER_20261106T173554_20261128T193600",
            "S1D_MP_USER_20261109T175423_20261129T200300",
            "S2A_MP_ACQ__KML_20261029T150000_20261116T180000",
            "S2B_MP_ACQ__KML_20261105T120000_20261123T150000",
            "S2C_MP_ACQ__KML_20261029T120000_20261116T150000",
        ])

    def test_select_plans_keeps_base_and_newer(self):
        sel = ep.select_plans(listing_plans(), dt.datetime(2026, 11, 6, 9, tzinfo=UTC))
        s1c = [p["name"] for p in sel if p["satellite"] == "S1C"]
        self.assertEqual(s1c, ["S1C_MP_USER_20261105T173841_20261127T200600",
                               "S1C_MP_USER_20261106T173554_20261128T193600"])

    def test_list_current_plans_uses_both_pages(self):
        sel = ep.list_current_plans(FakeSession({}), dt.date(2026, 11, 10))
        self.assertEqual({p["mission"] for p in sel}, {"S1", "S2"})

    def test_list_current_plans_empty_page_is_error(self):
        class Empty(FakeSession):
            def get(self, url, headers=None, timeout=None):
                return FakeResponse(200, b"<html><body>maintenance</body></html>")
        with self.assertRaises(RuntimeError):
            ep.list_current_plans(Empty({}), dt.date(2026, 11, 10))


class Kml(unittest.TestCase):
    def test_sentinel1_fields(self):
        segs = ep.kml_to_segments(fixture_bytes("esa_plan_s1c_20261106.kml"), "S1C")
        self.assertEqual(len(segs), 6)
        self.assertEqual([s["start"] for s in segs], sorted(s["start"] for s in segs))
        s = next(s for s in segs if s["start"] == "2026-11-10T00:11:03Z")
        self.assertEqual(s["satellite"], "S1C")
        self.assertEqual(s["mode"], "IW")
        self.assertEqual(s["pol"], "DV")
        self.assertEqual(s["stop"], "2026-11-10T00:15:39Z")
        self.assertEqual((s["orbit"], s["rel_orbit"], s["datatake"]), (10267, 19, "14813"))
        self.assertNotIn("swath", s)
        self.assertEqual(s["polygon"][0], s["polygon"][-1])
        sm = [s for s in segs if s["mode"] == "SM"]
        self.assertEqual(len(sm), 1)
        self.assertRegex(sm[0]["swath"], r"^S[1-6]$")

    def test_sentinel1_wrong_satellite_skipped(self):
        self.assertEqual(ep.kml_to_segments(fixture_bytes("esa_plan_s1c_20261106.kml"), "S1D"), [])

    def test_sentinel1_antimeridian(self):
        segs = ep.kml_to_segments(fixture_bytes("esa_plan_s1c_20261106.kml"), "S1C")
        # ESA writes this ring with a longitude of -261.4 deg; it is unwrapped, then split
        s = next(s for s in segs if s["start"] == "2026-11-10T01:39:33Z")
        lons = [p[0] for p in s["polygon"]]
        self.assertTrue(all(abs(a - b) <= 180 for a, b in zip(lons, lons[1:])))
        g = ep.ring_to_geometry(s["polygon"])
        self.assertEqual(g["type"], "MultiPolygon")
        for part in g["coordinates"]:
            ring = part[0]
            self.assertEqual(ring[0], ring[-1])
            self.assertTrue(all(-180 <= x <= 180 for x, _ in ring))
            self.assertTrue(any(abs(x) == 180 for x, _ in ring))
        total = sum(area(part[0]) for part in g["coordinates"])
        self.assertAlmostEqual(total, area(s["polygon"]), delta=0.01 * area(s["polygon"]))

    def test_sentinel2_modes_and_times(self):
        segs = ep.kml_to_segments(fixture_bytes("esa_plan_s2b_20261105.kml"), "S2B")
        self.assertEqual(sorted(s["mode"] for s in segs), ["NOBS", "NOBS", "NOBS", "VIC"])
        s = next(s for s in segs if s["start"].startswith("2026-11-05T12:07"))
        # 12:07:16.245 -> 12:07:16 (floor), 12:07:37.893 -> 12:07:38 (ceiling)
        self.assertEqual((s["start"], s["stop"]), ("2026-11-05T12:07:16Z", "2026-11-05T12:07:38Z"))
        self.assertEqual(s["satellite"], "S2B")
        self.assertIsInstance(s["orbit"], int)
        self.assertIsInstance(s["rel_orbit"], int)
        self.assertNotIn("pol", s)

    def test_sentinel2_simplified_and_rounded(self):
        raw = ep.parse_coordinates(
            fixture_bytes("esa_plan_s2a_20261029.kml").split(b"<coordinates>")[1]
            .split(b"</coordinates>")[0].decode())
        self.assertGreater(len(raw) - 1, 40)
        (s,) = ep.kml_to_segments(fixture_bytes("esa_plan_s2a_20261029.kml"), "S2A")
        ring = s["polygon"]
        self.assertLessEqual(len(ring) - 1, 40)
        self.assertEqual(ring[0], ring[-1])
        self.assertTrue(all(round(v, 3) == v for p in ring for v in p))
        ref = ep.unwrap(raw)
        self.assertAlmostEqual(area(ring), area(ref), delta=0.01 * area(ref))
        self.assertGreater(ep._signed_area(ring[:-1]), 0)

    def test_bad_xml(self):
        with self.assertRaises(ValueError):
            ep.kml_to_segments(b"<kml><Document>", "S1C")
        with self.assertRaises(ValueError):
            ep.kml_to_segments(b'<?xml version="1.0"?><!DOCTYPE k [<!ENTITY a "x">]><k/>', "S1C")


class Geometry(unittest.TestCase):
    def test_simplify_collinear_square(self):
        side = [(i / 10, 0.0) for i in range(10)] + [(1.0, i / 10) for i in range(10)] \
            + [(1 - i / 10, 1.0) for i in range(10)] + [(0.0, 1 - i / 10) for i in range(10)]
        out = ep.simplify_ring(side)
        self.assertEqual(sorted(out), [(0.0, 0.0), (0.0, 1.0), (1.0, 0.0), (1.0, 1.0)])

    def test_simplify_limit(self):
        import math
        circle = [(math.cos(2 * math.pi * i / 200), math.sin(2 * math.pi * i / 200)) for i in range(200)]
        self.assertLessEqual(len(ep.simplify_ring(circle, 40)), 40)

    def test_polygon_orientation_ccw(self):
        g = ep.ring_to_geometry([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]])
        self.assertEqual(g["type"], "Polygon")
        self.assertGreater(ep._signed_area(g["coordinates"][0][:-1]), 0)

    def test_degenerate_polygon(self):
        self.assertIsNone(ep.ring_to_geometry([[0, 0], [1, 1], [2, 2], [0, 0]]))

    def test_unwrap(self):
        self.assertEqual(ep.unwrap([(179.0, 0), (-179.0, 0), (-178.0, 1)]),
                         [(179.0, 0), (181.0, 0), (182.0, 1)])


class Merge(unittest.TestCase):
    def test_newer_plan_supersedes(self):
        plans = {p["name"]: p for p in listing_plans()}
        old = plans["S1C_MP_USER_20261105T173841_20261127T200600"]
        new = plans["S1C_MP_USER_20261106T173554_20261128T193600"]
        merged = ep.merge_plan_segments([
            (new, ep.kml_to_segments(fixture_bytes("esa_plan_s1c_20261106.kml"), "S1C")),
            (old, ep.kml_to_segments(fixture_bytes("esa_plan_s1c_20261105.kml"), "S1C")),
        ])
        starts = [s["start"] for s in merged]
        self.assertEqual(len(starts), len(set(starts)))
        self.assertIn("2026-11-05T17:44:03Z", starts)  # only in the older plan, before the newer one
        s = next(s for s in merged if s["start"] == "2026-11-09T14:08:58Z")
        self.assertEqual(s["stop"], "2026-11-09T14:14:21Z")  # revised in the newer plan (was 14:16:13)


class Write(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.plans = [p for p in listing_plans() if p["name"] == "S1C_MP_USER_20261106T173554_20261128T193600"]
        self.segs = ep.kml_to_segments(fixture_bytes("esa_plan_s1c_20261106.kml"), "S1C")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_window_sort_meta_and_idempotence(self):
        today = dt.date(2026, 11, 10)
        changes = ep.write_plans(self.tmp, list(reversed(self.segs)), today, self.plans, {
            self.plans[0]["name"]: LM})
        self.assertEqual(len(changes), 1)
        self.assertIn("S1C", changes[0])
        path = self.tmp / "s1" / "S1C.geojson"
        text = path.read_text(encoding="utf-8")
        fc = json.loads(text)
        self.assertEqual(fc["type"], "FeatureCollection")
        starts = [f["properties"]["start"] for f in fc["features"]]
        self.assertEqual(starts, sorted(starts))
        self.assertTrue(all(f["properties"]["stop"] >= "2026-11-10T00:00:00Z" for f in fc["features"]))
        self.assertEqual(len(starts), 3)
        self.assertTrue(all("polygon" not in f["properties"] for f in fc["features"]))
        self.assertEqual(fc["plan"]["window"], ["2026-11-10T00:00:00Z", "2026-12-10T00:00:00Z"])
        self.assertEqual(fc["plan"]["coverage"], [["2026-11-10T00:00:00Z", "2026-11-28T19:36:00Z"]])
        self.assertEqual(fc["plan"]["sources"][0]["last_modified"], LM)
        self.assertNotIn(": ", text.splitlines()[1])  # compact separators
        self.assertEqual(ep.write_plans(self.tmp, self.segs, today, self.plans, {
            self.plans[0]["name"]: LM}), [])

    def test_empty_result_never_overwrites(self):
        ep.write_plans(self.tmp, self.segs, dt.date(2026, 11, 10), self.plans)
        path = self.tmp / "s1" / "S1C.geojson"
        before = path.read_text(encoding="utf-8")
        self.assertEqual(ep.write_plans(self.tmp, [], dt.date(2026, 11, 10), self.plans), [])
        self.assertEqual(ep.write_plans(self.tmp, self.segs, dt.date(2027, 1, 1), self.plans), [])
        self.assertEqual(path.read_text(encoding="utf-8"), before)

    def test_mission_directories(self):
        segs = ep.kml_to_segments(fixture_bytes("esa_plan_s2b_20261105.kml"), "S2B")
        ep.write_plans(self.tmp, segs + self.segs, dt.date(2026, 11, 5))
        self.assertTrue((self.tmp / "s2" / "S2B.geojson").exists())
        self.assertTrue((self.tmp / "s1" / "S1C.geojson").exists())


class Update(unittest.TestCase):
    NOW = dt.datetime(2026, 11, 7, 6, 0, tzinfo=UTC)
    KML = {
        "s1c_mp_user_20261106t173554_20261128t193600": fixture_bytes("esa_plan_s1c_20261106.kml"),
        "s2b_mp_acq__kml_20261105t120000_20261123t150000": fixture_bytes("esa_plan_s2b_20261105.kml"),
    }

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def test_full_cycle(self):
        sess = FakeSession(self.KML)
        changes, errors = ep.update_plans(sess, self.tmp, self.NOW)
        self.assertEqual(len(changes), 2)
        self.assertEqual(sorted(e.split()[0] for e in errors), ["S1D", "S2A", "S2C"])
        s1c = self.tmp / "plans" / "s1" / "S1C.geojson"
        s2b = self.tmp / "plans" / "s2" / "S2B.geojson"
        self.assertTrue(s1c.exists() and s2b.exists())
        self.assertFalse((self.tmp / "plans" / "s1" / "S1D.geojson").exists())
        fc = json.loads(s2b.read_text(encoding="utf-8"))
        self.assertEqual([f["properties"]["mode"] for f in fc["features"]], ["NOBS"])
        self.assertIn(fc["features"][0]["geometry"]["type"], ("Polygon", "MultiPolygon"))

        # unchanged plans: answered 304, nothing downloaded, nothing rewritten
        before = s1c.read_text(encoding="utf-8")
        sess.full_downloads.clear()
        changes, _ = ep.update_plans(sess, self.tmp, self.NOW + dt.timedelta(hours=6))
        self.assertEqual(changes, [])
        self.assertEqual(sess.full_downloads, [])
        self.assertEqual(s1c.read_text(encoding="utf-8"), before)

        # next day: stored features are re-filtered without downloading
        changes, _ = ep.update_plans(sess, self.tmp, self.NOW + dt.timedelta(days=3))
        self.assertEqual(sess.full_downloads, [])
        self.assertTrue(any(c.startswith("plans S1C") for c in changes))
        fc = json.loads(s1c.read_text(encoding="utf-8"))
        self.assertTrue(all(f["properties"]["stop"] >= "2026-11-10T00:00:00Z" for f in fc["features"]))

    def test_failed_download_keeps_file(self):
        ep.update_plans(FakeSession(self.KML), self.tmp, self.NOW)
        s1c = self.tmp / "plans" / "s1" / "S1C.geojson"
        before = s1c.read_text(encoding="utf-8")
        failing = FakeSession(self.KML, fail={"s1c_mp_user_20261106t173554_20261128t193600"})
        changes, errors = ep.update_plans(failing, self.tmp, self.NOW + dt.timedelta(days=1))
        self.assertTrue(any(e.startswith("S1C") for e in errors))
        self.assertEqual(s1c.read_text(encoding="utf-8"), before)

    def test_never_raises(self):
        changes, errors = ep.update_plans(FakeSession({}, broken=True), self.tmp, self.NOW)
        self.assertEqual(changes, [])
        self.assertEqual(len(errors), 1)
        changes, errors = ep.update_plans(FakeSession(self.KML), "/nonexistent\0path", self.NOW)
        self.assertIsInstance(errors, list)


if __name__ == "__main__":
    unittest.main()
