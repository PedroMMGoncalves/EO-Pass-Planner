"""Unit tests for scripts/update_data.py and scripts/validate_catalogue.py (offline).

Run: python -m unittest discover -s tests -p "test_*.py"
"""

import copy
import datetime as dt
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import update_data as ud  # noqa: E402
import validate_catalogue as vc  # noqa: E402

ISS = (
    "ISS (ZARYA)",
    "1 25544U 98067A   19156.50900463  .00003075  00000-0  59442-4 0  9992",
    "2 25544  51.6433  59.2583 0008217  16.4489 347.6017 15.51174618173442",
)


class TleHelpers(unittest.TestCase):
    def test_checksum_valid(self):
        self.assertTrue(ud.tle_checksum_ok(ISS[1]))
        self.assertTrue(ud.tle_checksum_ok(ISS[2]))

    def test_checksum_detects_corruption(self):
        bad = ISS[1][:30] + ("1" if ISS[1][30] != "1" else "2") + ISS[1][31:]
        self.assertFalse(ud.tle_checksum_ok(bad))

    def test_epoch(self):
        e = ud.epoch_from_line1(ISS[1])
        self.assertEqual(e.date(), dt.date(2019, 6, 5))
        frac = (e - dt.datetime(2019, 6, 5, tzinfo=dt.timezone.utc)).total_seconds() / 86400
        self.assertAlmostEqual(frac, 0.50900463, places=7)

    def test_parse_three_line(self):
        text = "\n".join(ISS) + "\n" + "\n".join(ISS) + "\n"
        self.assertEqual(len(ud.parse_tle_text(text)), 2)
        self.assertEqual(ud.parse_tle_text("No GP data found"), [])

    def test_validate_name_mismatch_is_error(self):
        errs = ud.validate_tle(ISS[0], ISS[1], ISS[2], 25544, "ISS")
        self.assertTrue(any("OBJECT_NAME" in e for e in errs))
        self.assertEqual(ud.validate_tle(*ISS, 25544, "ISS (ZARYA)"), [])

    def test_validate_wrong_catnr(self):
        errs = ud.validate_tle(*ISS, 39084, "ISS (ZARYA)")
        self.assertTrue(any("catalogue number" in e for e in errs))

    def test_merge_history_dedupes_epochs(self):
        t = {"25544": {"line1": ISS[1], "line2": ISS[2], "epoch": "2019-06-05T12:13:05.20Z"}}
        day = ud.merge_history({}, t)
        day = ud.merge_history(day, t)
        self.assertEqual(len(day["25544"]), 1)


class OmmRecords(unittest.TestCase):
    def setUp(self):
        self.omm = json.loads((ROOT / "tests/fixtures/omm_sentinel-3c.json").read_text(encoding="utf-8"))

    def test_valid_omm(self):
        self.assertEqual(ud.validate_omm(self.omm, 100690, "SENTINEL-3C"), [])
        self.assertEqual(ud.omm_epoch(self.omm).tzinfo, dt.timezone.utc)

    def test_omm_name_and_number_checked(self):
        self.assertTrue(ud.validate_omm(self.omm, 100690, "SENTINEL-3A"))
        self.assertTrue(ud.validate_omm(self.omm, 100691, "SENTINEL-3C"))
        bad = dict(self.omm, MEAN_MOTION=40)
        self.assertTrue(ud.validate_omm(bad, 100690, "SENTINEL-3C"))

    def test_history_keeps_omm(self):
        day = ud.merge_history({}, {"100690": {"omm": self.omm, "epoch": "2026-11-10T03:06:33.99Z"}})
        self.assertIn("omm", day["100690"][0])


class CatalogueValidation(unittest.TestCase):
    def setUp(self):
        self.cat = json.loads((ROOT / "data/catalogue.json").read_text(encoding="utf-8"))
        self.today = dt.date(2026, 11, 10)

    def test_repo_catalogue_is_valid(self):
        errors, _ = vc.validate(self.cat, None, self.today)
        self.assertEqual(errors, [])

    def test_missing_status_source_fails(self):
        cat = copy.deepcopy(self.cat)
        e = cat["entries"][0]
        e["sources"] = [s for s in e["sources"] if s["field"] != "status"]
        errors, _ = vc.validate(cat, None, self.today)
        self.assertTrue(any("source for 'status'" in x for x in errors))

    def test_bad_enum_fails(self):
        cat = copy.deepcopy(self.cat)
        cat["entries"][0]["pass_filter"] = "sometimes"
        errors, _ = vc.validate(cat, None, self.today)
        self.assertTrue(any("pass_filter" in x for x in errors))

    def test_name_mismatch_against_tles_fails(self):
        e = self.cat["entries"][0]
        tles = {str(e["norad_id"]): {"name": "SOMETHING ELSE"}}
        errors, _ = vc.validate(self.cat, tles, self.today)
        self.assertTrue(any("tles.json" in x for x in errors))

    def test_expired_note_warns(self):
        _, warnings = vc.validate(self.cat, None, dt.date(2027, 1, 1))
        self.assertTrue(any("expired" in w for w in warnings))


if __name__ == "__main__":
    unittest.main()
