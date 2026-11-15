#!/usr/bin/env python3
"""Tests for the record/package content consistency checker."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("verify_record_package", ROOT / "scripts" / "verify_record_package.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def build_package(root: Path, *, decision_id: str = "dec-1", profile_mismatch: bool = False,
                  with_provenance: bool = True) -> Path:
    sha = "a" * 64
    (root / "record" / "decisions").mkdir(parents=True)
    (root / "record" / "preferences").mkdir(parents=True)
    (root / "tables").mkdir()
    decisions = [{"id": decision_id, "action": "accept", "target": {"kind": "qc", "ref": "sub-001:qc"}}]
    (root / "decisions.json").write_text(json.dumps(decisions))
    profile = {"schema": "ffs-record-profile/1", "preferences": [{"id": "pref-alpha-0-4"}]}
    (root / "preferences.json").write_text(json.dumps(profile))
    (root / "record" / "preferences" / "profile.json").write_text(
        json.dumps({"schema": "ffs-record-profile/1", "preferences": []} if profile_mismatch else profile))
    event = {"schema": "ffs-record/1", "type": "decision.recorded", "payload": {"decision": {"id": decision_id}}}
    (root / "record" / "decisions" / "2026-11.jsonl").write_text(json.dumps(event) + "\n")
    if with_provenance:
        (root / "provenance.json").write_text(json.dumps({
            "schema": "ffs-analysis-provenance/1",
            "run": {"id": "settle-1"},
            "outputs": [{"name": "stats.nii.gz", "sha256": sha}],
        }))
    (root / "inputs.json").write_text(json.dumps({
        "count": 1, "files": [{"path": "sub-001/func/bold.nii.gz", "bytes": 10, "sha256": sha}],
    }))
    (root / "tables" / "artifacts.csv").write_text("name,kind,status,stage,sha256,explanation\nstats.nii.gz,stats,accepted,GLM," + sha + ",\n")
    (root / "manifest.json").write_text(json.dumps({
        "settledId": "settle-1",
        "artifacts": [{"name": "stats.nii.gz", "sha256": sha}],
        "record": {"counts": {"decisions": {"records": 1}}},
        "inputs": {"count": 1},
    }))
    return root


class PackageVerifyTests(unittest.TestCase):
    def test_consistent_package_passes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            package = build_package(Path(tmp))
            result = MODULE.verify(package)
            self.assertTrue(result["ok"], result)
            self.assertTrue(all(check["ok"] for check in result["checks"]))
            names = [check["name"] for check in result["checks"]]
            self.assertIn("decision ledger covers decisions", names)
            self.assertIn("preference view matches record profile", names)
            self.assertIn("provenance outputs match manifest artifacts", names)

    def test_dangling_decision_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            package = build_package(Path(tmp))
            decisions = json.loads((package / "decisions.json").read_text())
            decisions[0]["id"] = "dec-2"
            (package / "decisions.json").write_text(json.dumps(decisions))
            result = MODULE.verify(package)
            self.assertFalse(result["ok"])
            failing = [check["name"] for check in result["checks"] if not check["ok"]]
            self.assertIn("decision ledger covers decisions", failing)

    def test_preference_view_drift_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            package = build_package(Path(tmp), profile_mismatch=True)
            result = MODULE.verify(package)
            self.assertFalse(result["ok"])
            failing = [check["name"] for check in result["checks"] if not check["ok"]]
            self.assertIn("preference view matches record profile", failing)

    def test_missing_provenance_is_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            package = build_package(Path(tmp), with_provenance=False)
            result = MODULE.verify(package)
            self.assertFalse(result["ok"])
            failing = [check["name"] for check in result["checks"] if not check["ok"]]
            self.assertIn("provenance present", failing)


if __name__ == "__main__":
    unittest.main()
