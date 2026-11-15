#!/usr/bin/env python3
"""Retention/compaction for viewer inspection sessions (RECORD.md §6).

Raw sessions are JSONL and grow with every command. Retention keeps the newest sessions raw,
turns older ones into a compact JSON record (session boundaries + marks + captures + head/tail
frames), removes the raw file, and appends a tombstone. Runs are idempotent.

This is the sidecar-side operation: it never reads voxel data and never rewrites marks/captures.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCHEMA = "ffs-inspection-compact/1"
TOMBSTONES = "tombstones.jsonl"
COMPACT_DIR = "compact"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_ts(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def read_session(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines()
    frames = []
    for line in lines:
        if not line.strip():
            continue
        try:
            frames.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    start = next((frame for frame in frames if frame.get("frame") == "session.start"), frames[0] if frames else {})
    end = next((frame for frame in reversed(frames) if frame.get("frame") == "session.end"), None)
    return {
        "sessionId": start.get("sessionId") or path.stem,
        "startedAt": start.get("ts"),
        "endedAt": (end or {}).get("ts"),
        "frames": frames,
        "events": sum(1 for frame in frames if frame.get("frame") == "event"),
        "marks": [frame for frame in frames if frame.get("frame") == "mark"],
        "captures": [frame for frame in frames if frame.get("frame") == "capture"],
    }


def compact_record(session: dict) -> dict:
    frames = session["frames"]
    return {
        "schema": SCHEMA,
        "sessionId": session["sessionId"],
        "startedAt": session["startedAt"],
        "endedAt": session["endedAt"],
        "frames": len(frames),
        "events": session["events"],
        "marks": session["marks"],
        "captures": session["captures"],
        "head": frames[:10],
        "tail": frames[-10:],
        "compactedAt": _now().isoformat(),
    }


def compact(state_dir: Path, *, raw_days: float = 30.0, raw_bytes: int = 64 * 1024 * 1024,
            keep_sessions: int = 20, dry_run: bool = False) -> dict:
    inspection_dir = Path(state_dir) / "inspection"
    compact_dir = inspection_dir / COMPACT_DIR
    sessions = []
    if inspection_dir.exists():
        for path in sorted(inspection_dir.glob("*.jsonl")):
            if path.name == TOMBSTONES:
                continue
            sessions.append((path, read_session(path)))
    sessions.sort(key=lambda item: str(item[1].get("startedAt") or ""))
    newest = [item[0].name for item in sessions[-max(0, keep_sessions):]] if sessions else []
    cutoff = _now() - timedelta(days=max(0.0, float(raw_days)))
    total_bytes = sum(path.stat().st_size for path, _ in sessions)
    plan = []
    for path, session in sessions:
        if path.name in newest:
            continue
        started = _parse_ts(session.get("startedAt"))
        old = started is not None and started < cutoff
        over_budget = total_bytes > raw_bytes
        if not old and not over_budget:
            continue
        plan.append((path, session))
        total_bytes -= path.stat().st_size
    result = {"planned": len(plan), "compacted": [], "dryRun": bool(dry_run), "sessions": len(sessions)}
    if dry_run:
        result["plan"] = [{"sessionId": session["sessionId"], "frames": len(session["frames"]),
                           "marks": len(session["marks"]), "captures": len(session["captures"])}
                          for _, session in plan]
        return result

    compact_dir.mkdir(parents=True, exist_ok=True)
    tombstones = inspection_dir / TOMBSTONES
    for path, session in plan:
        compact_path = compact_dir / f"{session['sessionId']}.json"
        if compact_path.exists():
            continue
        record = compact_record(session)
        compact_path.write_text(json.dumps(record, sort_keys=True, default=str) + "\n", encoding="utf-8")
        raw_bytes_value = path.stat().st_size
        path.unlink()
        tombstone = {
            "frame": "session.compacted",
            "schema": SCHEMA,
            "sessionId": session["sessionId"],
            "at": _now().isoformat(),
            "rawBytes": raw_bytes_value,
            "frames": len(session["frames"]),
            "events": session["events"],
            "marks": len(session["marks"]),
            "captures": len(session["captures"]),
            "compact": str(compact_path.relative_to(inspection_dir)),
        }
        with tombstones.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(tombstone, sort_keys=True) + "\n")
        result["compacted"].append(tombstone)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", default=".ffs-viewer", help="viewer state dir (default .ffs-viewer)")
    parser.add_argument("--raw-days", type=float, default=30.0, help="keep raw sessions newer than this")
    parser.add_argument("--raw-bytes", type=int, default=64 * 1024 * 1024, help="raw session byte budget")
    parser.add_argument("--keep-sessions", type=int, default=20, help="always keep this many newest raw")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    result = compact(Path(args.state_dir), raw_days=args.raw_days, raw_bytes=args.raw_bytes,
                     keep_sessions=args.keep_sessions, dry_run=args.dry_run)
    print(json.dumps(result, indent=2, sort_keys=True, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
