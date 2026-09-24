#!/usr/bin/env python3
"""Unit tests for refresh.py (standard library only)."""

import copy
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import refresh
from refresh import DataError


def row(**overrides):
    base = ["Model A", "Acme", "2026-01-15", 40.0, 0.5, 0, 1,
            [["2026-01-15", 0.5, 40.0]],
            [10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, None],
            1, 12.5, 100.0, 0.4]
    keys = ["name", "creator", "release", "iq", "cost", "retired", "open",
            "hist", "caps", "era", "time", "tps", "ttft"]
    for k, v in overrides.items():
        base[keys.index(k)] = v
    return base


def upstream(**overrides):
    data = {
        "updated": "2026-09-23",
        "eras": [["2026-09-05", "recomposition note", "v4.3", "v4.1", "2026-09-07"]],
        "models": [row()],
    }
    data.update(overrides)
    return data


class ValidateTest(unittest.TestCase):
    def test_valid_payload_passes(self):
        self.assertEqual(refresh.validate_upstream(upstream())["updated"], "2026-09-23")

    def test_missing_models_key_is_rejected(self):
        data = upstream()
        del data["models"]
        with self.assertRaises(DataError):
            refresh.validate_upstream(data)

    def test_empty_models_is_rejected(self):
        with self.assertRaises(DataError):
            refresh.validate_upstream(upstream(models=[]))

    def test_non_positive_cost_is_rejected(self):
        with self.assertRaises(DataError):
            refresh.validate_upstream(upstream(models=[row(cost=0)]))
        with self.assertRaises(DataError):
            refresh.validate_upstream(upstream(models=[row(cost=-1.5)]))

    def test_era_beyond_declared_boundaries_is_rejected(self):
        with self.assertRaises(DataError):
            refresh.validate_upstream(upstream(models=[row(era=5)]))

    def test_truncated_positional_row_is_rejected(self):
        bad = row()
        bad.pop()
        with self.assertRaises(DataError):
            refresh.validate_upstream(upstream(models=[bad]))


class NormalizeTest(unittest.TestCase):
    def test_positional_fields_map_to_named_snapshot(self):
        payload = refresh.normalize(upstream())

        self.assertEqual(len(payload["models"]), 1)
        m = payload["models"][0]
        self.assertEqual(m["name"], "Model A")
        self.assertEqual(m["creator"], "Acme")
        self.assertEqual(m["release"], "2026-01-15")
        self.assertEqual(m["iq"], 40.0)
        self.assertEqual(m["cost"], 0.5)
        self.assertFalse(m["retired"])
        self.assertTrue(m["open"])
        self.assertEqual(m["era"], 1)
        self.assertEqual(m["time_sec"], 12.5)
        self.assertEqual(m["tps"], 100.0)
        self.assertEqual(m["ttft"], 0.4)
        self.assertEqual(payload["source_updated"], "2026-09-23")
        self.assertTrue(m["id"])

    def test_null_speed_metrics_survive_normalization(self):
        payload = refresh.normalize(
            upstream(models=[row(time=None, tps=None, ttft=None)]))

        m = payload["models"][0]
        self.assertIsNone(m["time_sec"])
        self.assertIsNone(m["tps"])
        self.assertIsNone(m["ttft"])

    def test_duplicate_names_get_unique_ids(self):
        payload = refresh.normalize(upstream(models=[row(), row()]))

        ids = [m["id"] for m in payload["models"]]
        self.assertEqual(len(set(ids)), 2)

    def test_era_labels_mark_current_era(self):
        payload = refresh.normalize(upstream())

        labels = {e["index"]: e["label"] for e in payload["eras"]}
        self.assertEqual(len(labels), 2)  # one boundary -> two eras
        self.assertIn("current", labels[1])
        self.assertIn("v4.1", labels[0])


class RefreshFileTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.tmp.name, "models.json")
        self._real_fetch = refresh.fetch_bytes
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(setattr, refresh, "fetch_bytes", self._real_fetch)

    def _serve(self, data):
        refresh.fetch_bytes = lambda url, timeout=60: json.dumps(data).encode()

    def test_failed_fetch_preserves_previous_snapshot(self):
        previous = {"models": [{"id": "old"}], "fetched_at": "old"}
        with open(self.out, "w") as f:
            json.dump(previous, f)
        with open(self.out, "rb") as f:
            before = f.read()
        refresh.fetch_bytes = lambda url, timeout=60: (_ for _ in ()).throw(
            ConnectionError("offline"))

        status = refresh.main(["--out", self.out])

        self.assertEqual(status, 1)
        with open(self.out, "rb") as f:
            self.assertEqual(f.read(), before)

    def test_identical_measurements_cause_no_rewrite(self):
        self._serve(upstream())
        self.assertEqual(refresh.refresh(out=self.out), "updated")
        with open(self.out, "rb") as f:
            before = f.read()

        # Same measurements, different day: must not churn the file.
        self._serve(upstream())
        self.assertEqual(refresh.refresh(out=self.out), "unchanged")
        with open(self.out, "rb") as f:
            self.assertEqual(f.read(), before)

    def test_changed_measurements_rewrite_atomically(self):
        self._serve(upstream())
        refresh.refresh(out=self.out)

        changed = upstream(models=[row(name="Model B", cost=0.25)])
        self._serve(changed)
        self.assertEqual(refresh.refresh(out=self.out), "updated")

        with open(self.out) as f:
            stored = json.load(f)
        self.assertEqual(stored["models"][0]["name"], "Model B")
        leftovers = [n for n in os.listdir(self.tmp.name) if n.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_invalid_upstream_leaves_no_partial_file(self):
        self._serve({"models": []})  # fails validation

        with self.assertRaises(DataError):
            refresh.refresh(out=self.out)
        self.assertFalse(os.path.exists(self.out))


class AtomicWritePermissionsTest(unittest.TestCase):
    def test_atomic_write_is_world_readable_for_unprivileged_nginx(self):
        # nginx serves as UID 101 from files owned by root in the image;
        # Docker COPY preserves modes, so the snapshot must carry o+r or
        # the fetch of data/models.json fails with 403.
        with tempfile.TemporaryDirectory() as tmp:
            out = os.path.join(tmp, "models.json")
            refresh.atomic_write_json(out, {"models": []})

            mode = os.stat(out).st_mode & 0o777
            self.assertTrue(
                mode & 0o004,
                f"snapshot mode {oct(mode)} lacks other-read; "
                "unprivileged nginx would return 403",
            )


class DockerfileServingPermissionsTest(unittest.TestCase):
    def test_runtime_normalizes_served_files_to_world_readable(self):
        # Docker is unavailable in this sandbox, so assert the serving
        # contract statically: the runtime image must repair modes from
        # pre-existing restrictive snapshots (mkstemp created 0600).
        repo_root = os.path.dirname(
            os.path.dirname(os.path.abspath(__file__)))
        with open(os.path.join(repo_root, "Dockerfile"),
                  encoding="utf-8") as f:
            dockerfile = f.read()

        self.assertIn(
            "/usr/share/nginx/html", dockerfile,
            "runtime stage must copy the built site to the nginx html root",
        )
        self.assertRegex(
            dockerfile, r"chmod\s+.*a\+r",
            "runtime image must chmod served files world-readable "
            "so existing 0600 snapshots do not 403 under UID 101",
        )


if __name__ == "__main__":
    unittest.main()
