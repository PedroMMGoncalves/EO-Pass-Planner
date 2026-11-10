"""Unit tests for scripts/orbit_watch.py (offline)."""

import datetime as dt
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import orbit_watch as ow  # noqa: E402


def omm(epoch: str, n: float, ndot: float = 0.0) -> dict:
    return {"epoch": epoch, "omm": {"MEAN_MOTION": n, "MEAN_MOTION_DOT": ndot}}


class Manoeuvres(unittest.TestCase):
    def test_tle_exponent_field(self):
        self.assertAlmostEqual(ow._tle_exp(" 12345-4"), 0.12345e-4)
        self.assertAlmostEqual(ow._tle_exp("-11606-4"), -0.11606e-4)
        self.assertEqual(ow._tle_exp("        "), 0.0)

    def test_semi_major_axis(self):
        # Sentinel-2: 14.3 rev/day -> about 7167 km
        self.assertAlmostEqual(ow.semi_major_axis_km(14.30815), 7167, delta=3)

    def test_quiet_orbit_has_no_manoeuvre(self):
        recs = [omm(f"2026-11-{d:02d}T12:00:00Z", 14.30815 + 1e-7 * d) for d in range(10, 15)]
        self.assertEqual(ow.detect_manoeuvres(recs), [])

    def test_raise_is_detected_with_sign_and_size(self):
        # A rise of 100 m in semi-major axis lowers n by about (3/2) n da/a.
        n = 14.30815
        dn = -1.5 * n * 0.100 / ow.semi_major_axis_km(n)
        recs = [omm("2026-11-10T12:00:00Z", n), omm("2026-11-11T12:00:00Z", n), omm("2026-11-12T12:00:00Z", n + dn)]
        found = ow.detect_manoeuvres(recs)
        self.assertEqual(len(found), 1)
        self.assertAlmostEqual(found[0]["delta_a_m"], 100, delta=2)
        self.assertEqual(found[0]["after"], "2026-11-12T12:00:00Z")

    def test_large_gap_is_not_evaluated(self):
        recs = [omm("2026-11-01T00:00:00Z", 14.3), omm("2026-11-10T00:00:00Z", 14.2)]
        self.assertEqual(ow.detect_manoeuvres(recs), [])


class Alerts(unittest.TestCase):
    def test_stale_and_expired(self):
        cat = {"entries": [
            {"id": "A", "status": "active", "norad_id": 1, "swath": {"model": "nadir_symmetric"}, "note_expires": "2026-01-01"},
            {"id": "B", "status": "active", "norad_id": 2, "swath": {"model": "nadir_symmetric"}},
            {"id": "C", "status": "inactive", "norad_id": 3, "swath": {"model": "nadir_symmetric"}},
        ]}
        tles = {"1": {"epoch": "2026-11-09T00:00:00Z"}, "2": {"epoch": "2026-10-20T00:00:00Z"}}
        alerts = ow.catalogue_alerts(cat, tles, dt.datetime(2026, 11, 10, tzinfo=dt.timezone.utc))
        kinds = {(a["id"], a["kind"]) for a in alerts}
        self.assertIn(("A", "note_expired"), kinds)
        self.assertIn(("B", "stale_elements"), kinds)
        self.assertFalse(any(a["id"] == "C" for a in alerts))


if __name__ == "__main__":
    unittest.main()
