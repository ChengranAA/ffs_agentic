#!/usr/bin/env python3
"""Tests for inspection retention/compaction."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("compact_inspection", ROOT / "scripts" / "compact_inspection.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def write_session(directory: Path, session_id: str, *, started: datetime, with_mark: bool = True) -> Path:
    frames = [
        {"schema": "ffs-inspection/1", "frame": "session.start", "seq": 1, "sessionId": session_id,
         "ts": started.isoformat()},
        {"schema": "ffs-inspection/1", "frame": "event", "seq": 2, "sessionId": session_id,
         "ts": (started + timedelta(seconds=1)).isoformat(),
         "command": {"line": "SET_IJK 1 2 3", "name": "SET_IJK", "category": "navigation"},
         "snapshot": {"rev": 1, "stateSha256": "a" * 64}},
    ]
    if with_mark:
        frames.append({"schema": "ffs-inspection/1", "frame": "mark", "seq": 3, "sessionId": session_id,
                       "ts": (started + timedelta(seconds=2)).isoformat(),
                       "text": "look here", "tags": ["qc"], "kind": "mark"})
    frames.append({"schema": "ffs-inspection/1", "frame": "session.end", "seq": 4, "sessionId": session_id,
                   "ts": (started + timedelta(seconds=3)).isoformat()})
    path = directory / f"{session_id}.jsonl"
    path.write_text("\n".join(json.dumps(frame) for frame in frames) + "\n", encoding="utf-8")
    return path


class CompactionTests(unittest.TestCase):
    def test_compacts_old_sessions_but_keeps_newest_raw(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".ffs-viewer"
            inspection = state_dir / "inspection"
            inspection.mkdir(parents=True)
            now = datetime.now(timezone.utc)
            old_one = write_session(inspection, "insp-old-1", started=now - timedelta(days=10))
            old_two = write_session(inspection, "insp-old-2", started=now - timedelta(days=5))
            recent = write_session(inspection, "insp-recent", started=now - timedelta(hours=1))

            dry = MODULE.compact(state_dir, raw_days=1, keep_sessions=1, dry_run=True)
            self.assertEqual(dry["planned"], 2)
            self.assertTrue(old_one.exists() and old_two.exists() and recent.exists())

            result = MODULE.compact(state_dir, raw_days=1, keep_sessions=1)
            self.assertEqual(result["planned"], 2)
            self.assertEqual(len(result["compacted"]), 2)
            self.assertFalse(old_one.exists())
            self.assertFalse(old_two.exists())
            self.assertTrue(recent.exists())
            self.assertTrue((inspection / "compact" / "insp-old-1.json").exists())
            compacted = json.loads((inspection / "compact" / "insp-old-1.json").read_text())
            self.assertEqual(compacted["sessionId"], "insp-old-1")
            self.assertEqual(compacted["marks"][0]["text"], "look here")
            self.assertEqual(compacted["events"], 1)
            tombstones = [json.loads(line) for line in (inspection / "tombstones.jsonl").read_text().splitlines()]
            self.assertEqual({item["sessionId"] for item in tombstones}, {"insp-old-1", "insp-old-2"})
            self.assertEqual({item["frame"] for item in tombstones}, {"session.compacted"})

            again = MODULE.compact(state_dir, raw_days=1, keep_sessions=1)
            self.assertEqual(again["planned"], 0)
            self.assertEqual(again["compacted"], [])

    def test_all_sessions_kept_when_under_budget_and_recent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".ffs-viewer"
            inspection = state_dir / "inspection"
            inspection.mkdir(parents=True)
            now = datetime.now(timezone.utc)
            for index in range(3):
                write_session(inspection, f"insp-new-{index}", started=now - timedelta(hours=index + 1))
            result = MODULE.compact(state_dir, raw_days=30, raw_bytes=10 * 1024 * 1024, keep_sessions=2)
            self.assertEqual(result["planned"], 0)
            self.assertEqual(len(list(inspection.glob("*.jsonl"))), 3)

    def test_byte_budget_compacts_oldest_first(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / ".ffs-viewer"
            inspection = state_dir / "inspection"
            inspection.mkdir(parents=True)
            now = datetime.now(timezone.utc)
            for index in range(6):
                write_session(inspection, f"insp-{index}", started=now - timedelta(minutes=10 - index))
            total = sum(path.stat().st_size for path in inspection.glob("*.jsonl"))
            result = MODULE.compact(state_dir, raw_days=365, raw_bytes=max(1, total // 3), keep_sessions=1)
            self.assertGreater(result["planned"], 0)
            compacted = {item["sessionId"] for item in result["compacted"]}
            self.assertIn("insp-0", compacted)
            self.assertNotIn("insp-5", compacted)


if __name__ == "__main__":
    unittest.main()
