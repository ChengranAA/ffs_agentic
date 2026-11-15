#!/usr/bin/env python3
"""Scale check for the record layer: many sessions, retention, and evidence deletion.

Synthetic project, no imaging data. Exercises inspection session sharding, feature ingestion,
deterministic profile aggregation, retention compaction and deletion at a few hundred sessions,
and prints timings so a regression is visible.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "python") not in sys.path:
    sys.path.insert(0, str(ROOT / "python"))

from ffsrecord.deletion import delete_evidence  # noqa: E402
from ffsrecord.policy import preferences_dir  # noqa: E402
from ffsrecord.profile import ingest_sessions, recompute  # noqa: E402

SPEC = importlib.util.spec_from_file_location("compact_inspection", ROOT / "scripts" / "compact_inspection.py")
COMPACT = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(COMPACT)

SESSIONS = 400
OLD = 300
NOW = datetime(2026, 11, 13, 12, 0, 0, tzinfo=timezone.utc)


def write_session(directory: Path, index: int, started: datetime) -> None:
    session_id = f"insp-scale-{index:04d}"
    frames = [{
        "schema": "ffs-inspection/1", "frame": "session.start", "seq": 1,
        "sessionId": session_id, "ts": started.isoformat(),
        "context": {"project": {"task": "rest", "modality": "func", "stage": "qc"}},
    }]
    seq = 2
    for _ in range(10):
        frames.append({
            "schema": "ffs-inspection/1", "frame": "event", "seq": seq, "sessionId": session_id,
            "ts": (started + timedelta(seconds=seq)).isoformat(), "origin": "ui",
            "command": {"line": "SET_THRESHOLD S 2.3", "name": "SET_THRESHOLD", "category": "display"},
            "semantic": {"kind": "display", "value": ["2.3"]},
        })
        seq += 1
    frames.append({
        "schema": "ffs-inspection/1", "frame": "mark", "seq": seq, "sessionId": session_id,
        "ts": (started + timedelta(minutes=1)).isoformat(), "text": "scale mark", "tags": ["scale"], "kind": "mark",
    })
    seq += 1
    frames.append({
        "schema": "ffs-inspection/1", "frame": "session.end", "seq": seq, "sessionId": session_id,
        "ts": (started + timedelta(minutes=2)).isoformat(),
    })
    (directory / f"{session_id}.jsonl").write_text(
        "\n".join(json.dumps(frame) for frame in frames) + "\n", encoding="utf-8")


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ffs-record-scale-") as tmp:
        project = Path(tmp) / "project"
        state_dir = project / ".ffs-viewer"
        inspection = state_dir / "inspection"
        inspection.mkdir(parents=True)
        started = time.perf_counter()
        for index in range(SESSIONS):
            # 300 old sessions (before the deletion cut), 100 recent.
            age_days = 90 if index < OLD else 1
            write_session(inspection, index, NOW - timedelta(days=age_days))
        write_time = time.perf_counter() - started

        started = time.perf_counter()
        shards = ingest_sessions(project, state_dir)
        profile = recompute(project, now=NOW.isoformat())
        profile_time = time.perf_counter() - started
        assert len(shards) == SESSIONS, len(shards)
        assert profile["evidence"]["sessions"] == SESSIONS, profile["evidence"]
        assert profile["preferences"], "no preference learned from 400 sessions"
        assert all(record["evidence"]["sessions"] == SESSIONS for record in profile["preferences"])

        started = time.perf_counter()
        retention = COMPACT.compact(state_dir, raw_days=30, keep_sessions=20)
        compact_time = time.perf_counter() - started
        raw_left = len(list(inspection.glob("insp-*.jsonl")))
        # 300 sessions are older than 30 days; the 100 recent ones stay raw.
        assert raw_left == SESSIONS - OLD, raw_left
        assert len(retention["compacted"]) == OLD, retention["planned"]
        tombstones = (inspection / "tombstones.jsonl").read_text().strip().splitlines()
        assert len(tombstones) == OLD

        # Retention only compacts raw sessions; evidence remains and the profile is unchanged.
        after_compaction = recompute(project, now=NOW.isoformat())
        assert after_compaction["evidence"]["sessions"] == SESSIONS

        cutoff = (NOW - timedelta(days=60)).isoformat()
        started = time.perf_counter()
        deletion = delete_evidence(project, state_dir, {"before": cutoff}, reason="scale check", now=NOW.isoformat())
        delete_time = time.perf_counter() - started
        assert deletion["deleted"] == OLD, deletion["deleted"]
        remaining = preferences_dir(project) / "evidence"
        assert len(list(remaining.glob("*.json"))) == SESSIONS - OLD
        after_delete = recompute(project, now=NOW.isoformat())
        assert after_delete["evidence"]["sessions"] == SESSIONS - OLD, after_delete["evidence"]

        print(f"scale ok: {SESSIONS} sessions · {len(tombstones)} retention tombstones · {deletion['deleted']} evidence deletes")
        print(f"timing: write {write_time:.2f}s · ingest+profile {profile_time:.2f}s · "
              f"compact {compact_time:.2f}s · delete {delete_time:.2f}s")
        print("PASS record scale")
        return 0


if __name__ == "__main__":
    sys.exit(main())
