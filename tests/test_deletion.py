#!/usr/bin/env python3
"""Tests for R4 bounded deletion: dry-run, tombstones, exact recompute, retention of confirmations."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "python") not in sys.path:
    sys.path.insert(0, str(ROOT / "python"))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ffsrecord.deletion import delete_evidence  # noqa: E402
from ffsrecord.lifecycle import record_action  # noqa: E402
from ffsrecord.policy import preferences_dir  # noqa: E402
from ffsrecord.profile import ingest_sessions, read_profile, recompute  # noqa: E402
try:
    from tests.test_preferences import NOW, preference, write_session  # noqa: E402
except ImportError:  # unittest discover imports test modules top-level
    from test_preferences import NOW, preference, write_session  # noqa: E402


def build_project(tmp: str, count: int = 9) -> tuple[Path, Path]:
    project = Path(tmp)
    state_dir = project / ".ffs-viewer"
    for index in range(count):
        write_session(state_dir, f"insp-{index}", commands=preference())
    ingest_sessions(project, state_dir)
    recompute(project, now=NOW)
    return project, state_dir


def tombstones(project: Path) -> list[dict]:
    path = preferences_dir(project) / "tombstones.jsonl"
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


class DeletionTests(unittest.TestCase):
    def test_dry_run_never_touches_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, state_dir = build_project(tmp)
            before = read_profile(project)
            plan = delete_evidence(project, state_dir, {"sessionId": "insp-0"}, dry_run=True, now=NOW)
            self.assertTrue(plan["dryRun"])
            self.assertEqual(plan["sessions"], ["insp-0"])
            self.assertEqual(plan["rawDeletionQueued"], 1)
            self.assertTrue((preferences_dir(project) / "evidence" / "insp-0.json").exists())
            self.assertFalse((preferences_dir(project) / "tombstones.jsonl").exists())
            self.assertEqual(read_profile(project)["preferences"], before["preferences"])

    def test_session_deletion_appends_tombstone_and_exact_remaining_profile(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, state_dir = build_project(tmp)
            result = delete_evidence(project, state_dir, {"sessionId": "insp-0"}, reason="duplicate run", now=NOW)
            self.assertFalse(result["dryRun"])
            self.assertEqual(result["deleted"], 1)
            self.assertFalse((preferences_dir(project) / "evidence" / "insp-0.json").exists())
            records = tombstones(project)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["schema"], "ffs-record-tombstone/1")
            self.assertEqual(records[0]["counts"], {"sessions": 1, "shards": 1})
            self.assertEqual(records[0]["sessionIds"], ["insp-0"])
            self.assertEqual(records[0]["reason"], "duplicate run")
            self.assertNotIn("settings", json.dumps(records[0]))
            queue = state_dir / "inspection" / "deletion-queue.jsonl"
            self.assertTrue(queue.exists())
            queued = [json.loads(line) for line in queue.read_text().splitlines()]
            self.assertEqual(queued[0]["sessionId"], "insp-0")
            self.assertEqual(queued[0]["status"], "pending")

            remaining = read_profile(project)
            self.assertEqual(remaining["evidence"]["sessions"], 8)
            for record in remaining["preferences"]:
                self.assertEqual(record["evidence"]["sessions"], 8)
            self.assertTrue(result["profile"]["preferences"])

    def test_add_delete_add_matches_recompute_from_remaining(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, state_dir = build_project(tmp)
            original = read_profile(project)
            shard_path = preferences_dir(project) / "evidence" / "insp-0.json"
            content = shard_path.read_text()
            delete_evidence(project, state_dir, {"sessionId": "insp-0"}, now=NOW)
            shard_path.write_text(content)
            restored = recompute(project, now=NOW)
            self.assertEqual(restored["preferences"], original["preferences"])
            self.assertEqual(restored["evidence"]["sessions"], original["evidence"]["sessions"])

    def test_project_deletion_is_fully_subtractive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, state_dir = build_project(tmp)
            result = delete_evidence(project, state_dir, {"project": True}, now=NOW)
            self.assertEqual(result["deleted"], 9)
            self.assertEqual(list((preferences_dir(project) / "evidence").glob("*.json")), [])
            self.assertEqual(read_profile(project)["preferences"], [])
            self.assertEqual(len(tombstones(project)), 1)
            self.assertGreaterEqual(result["pendingRawDeletions"], 9)

    def test_confirmed_preference_survives_evidence_deletion_with_rewritten_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, state_dir = build_project(tmp)
            record_action(project, "establish", "pref-threshold-2-3",
                          actor={"kind": "user"}, reason="confirmed", now=NOW)
            recompute(project, now=NOW)
            result = delete_evidence(project, state_dir, {"project": True}, now=NOW)
            preferences = {record["id"]: record for record in result["profile"]["preferences"]}
            self.assertIn("pref-threshold-2-3", preferences)
            retained = preferences["pref-threshold-2-3"]
            self.assertEqual(retained["status"], "established")
            self.assertTrue(retained["evidence"]["behavioralDeleted"])
            self.assertEqual(retained["evidence"]["sessions"], 0)
            self.assertEqual(retained["provenance"], "confirmation-supported (behavioral evidence deleted)")
            self.assertNotIn("pref-alpha-0-4", preferences)

    def test_preference_mode_retires_instead_of_removing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, state_dir = build_project(tmp)
            result = delete_evidence(project, state_dir, {"preferenceId": "pref-alpha-0-4"},
                                     mode="preference", reason="not a habit", now=NOW)
            self.assertFalse(result["dryRun"])
            record = next(item for item in result["profile"]["preferences"] if item["id"] == "pref-alpha-0-4")
            self.assertEqual(record["status"], "retired")
            self.assertFalse(record["active"])
            self.assertIn("deletedAt", record)
            self.assertEqual(tombstones(project)[0]["mode"], "preference")

    def test_cited_decisions_are_marked_deleted_not_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project, state_dir = build_project(tmp)
            state = {
                "decisions": [{
                    "id": "dec-1", "action": "accept", "target": {"kind": "qc", "ref": "sub-001:qc"},
                    "evidence": {"visual": [{"inspection": "insp-0", "seq": 5, "stateSha256": "a" * 64}]},
                }],
            }
            (project / "work").mkdir(parents=True, exist_ok=True)
            (project / "work" / "ffs-analysis-project.json").write_text(json.dumps(state))
            result = delete_evidence(project, state_dir, {"sessionId": "insp-0"}, now=NOW)
            self.assertEqual([item["id"] for item in result["citedDecisions"]], ["dec-1"])
            updated = json.loads((project / "work" / "ffs-analysis-project.json").read_text())
            visual = updated["decisions"][0]["evidence"]["visual"][0]
            self.assertEqual(visual["status"], "deleted")
            self.assertEqual(updated["decisions"][0]["id"], "dec-1")

    def test_preference_scope_selects_only_contributing_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state_dir = project / ".ffs-viewer"
            # Four sessions: two use alpha 0.4, two use alpha 0.8; only the 0.4 shards are deleted.
            for index in range(2):
                write_session(state_dir, f"insp-a{index}", commands=preference())
            for index in range(2):
                write_session(state_dir, f"insp-b{index}", commands=[
                    ("SET_ALPHA", "SET_ALPHA S 0.8"), ("SET_ALPHA", "SET_ALPHA S 0.8"),
                ])
            ingest_sessions(project, state_dir)
            recompute(project, now=NOW)
            plan = delete_evidence(project, state_dir, {"preferenceId": "pref-alpha-0-4"}, dry_run=True, now=NOW)
            self.assertEqual(sorted(plan["sessions"]), ["insp-a0", "insp-a1"])
            result = delete_evidence(project, state_dir, {"preferenceId": "pref-alpha-0-4"}, now=NOW)
            self.assertEqual(sorted(result["sessions"]), ["insp-a0", "insp-a1"])
            remaining = {path.stem for path in (preferences_dir(project) / "evidence").glob("*.json")}
            self.assertEqual(remaining, {"insp-b0", "insp-b1"})


if __name__ == "__main__":
    unittest.main()
