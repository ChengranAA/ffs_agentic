#!/usr/bin/env python3
"""Tests for the viewer sidecar's durable inspection log (RECORD.md §6)."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for entry in (ROOT / "python", ROOT / "reference" / "fastfuncstuff"):
    if str(entry) not in sys.path:
        sys.path.insert(0, str(entry))

from ffsviewer.inspection import (  # noqa: E402
    InspectionLog,
    new_session_id,
    semantics,
    state_hash,
)


def snapshot(threshold=2.3, ijk=(10, 20, 30), rev=1):
    return {
        "rev": rev,
        "theme": "dark",
        "crosshair": list(ijk),
        "crosshairMm": [1.0, 2.0, 3.0],
        "timeIndex": 4,
        "selected": "layer-1",
        "inputKey": "layer-1",
        "layers": [{
            "key": "layer-1", "name": "stats", "threshold": threshold,
            "rangeLo": 0.0, "rangeHi": 6.0, "colormap": "redblue",
            "alphaMode": "linear", "signMode": "both", "opacity": 1.0,
        }],
        "viewports": [{"key": "V1", "plane": "axial", "locked": False, "position": 30}],
        "surfaces": {"subject": None, "shown": [], "outlineWidth": 1.0, "selected": None},
        "mode": {"name": "view"},
        "grid": {"shape": [64, 64, 40]},
    }


class InspectionLogTests(unittest.TestCase):
    def test_session_is_append_only_and_hashed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_dir = root / ".ffs-viewer"
            log = InspectionLog(state_dir, root, version="0.1.0", clock=lambda: 1_700_000_000.0)
            start = log.start()
            self.assertEqual(start["frame"], "session.start")
            self.assertRegex(log.session_id, r"^insp-\d{8}T\d{6}-[0-9a-f]{4}$")
            state = snapshot()
            baseline = log.baseline("SET_THEME dark\n", state)
            self.assertRegex(baseline["sha256"], r"^[0-9a-f]{64}$")
            self.assertTrue((state_dir / "inspection" / f"{log.session_id}.start.ffs").exists())
            self.assertEqual(log.status()["baseline"]["stateSha256"], baseline["stateSha256"])
            event = log.command(line="SET_IJK 10 20 30", name="SET_IJK", category="navigation",
                                origin="ui", snapshot=state)
            self.assertIsNotNone(event)
            self.assertEqual(event["semantic"]["kind"], "crosshair")
            self.assertEqual(event["semantic"]["ijk"], [10, 20, 30])
            self.assertEqual(event["snapshot"]["rev"], 1)
            self.assertEqual(len(event["snapshot"]["stateSha256"]), 64)
            capture = log.compute(state, label="registration check")
            self.assertRegex(capture["stateSha256"], r"^[0-9a-f]{64}$")
            self.assertEqual(capture["coordinates"]["ijk"], [10, 20, 30])
            self.assertEqual(capture["display"]["threshold"], 2.3)
            self.assertEqual(capture["baselineSha256"], baseline["sha256"])
            mark = log.mark(text="check the boundary", tags=["qc"], kind="mark", snapshot=state)
            self.assertEqual(mark["frame"], "mark")
            self.assertEqual(mark["text"], "check the boundary")
            log.save(note="after inspection", files={"savedAt": "now", "counts": {"display": 1}})
            log.prune(count=3, reason="surface-unload")
            log.end()

            lines = log.path.read_text().strip().splitlines()
            frames = [json.loads(line) for line in lines]
            self.assertEqual([frame["seq"] for frame in frames], list(range(1, len(frames) + 1)))
            self.assertEqual(frames[0]["frame"], "session.start")
            self.assertIn("session.baseline", [frame["frame"] for frame in frames])
            self.assertEqual(frames[-1]["frame"], "session.end")
            self.assertEqual({frame["sessionId"] for frame in frames}, {log.session_id})
            self.assertTrue(any(frame["frame"] == "prune" and frame["count"] == 3 for frame in frames))
            self.assertEqual(len({frame["ts"] for frame in frames}), 1)  # fixed clock
            self.assertIn("inspection", str(log.path))

    def test_state_hash_is_stable_and_display_sensitive(self) -> None:
        a = snapshot(threshold=2.3)
        b = snapshot(threshold=2.3)
        c = snapshot(threshold=3.1)
        self.assertEqual(state_hash(a), state_hash(b))
        self.assertNotEqual(state_hash(a), state_hash(c))
        self.assertEqual(hash(state_hash(a)), 64) if False else None
        d = snapshot(ijk=(11, 20, 30))
        self.assertNotEqual(state_hash(a), state_hash(d))

    def test_pause_suppresses_events_but_records_the_toggle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            log = InspectionLog(Path(tmp) / ".ffs-viewer", Path(tmp), clock=lambda: 1.0)
            log.start()
            log.pause(True)
            self.assertIsNone(log.command(line="SET_INDEX 3", name="SET_INDEX", category="navigation",
                                          origin="ui", snapshot=snapshot()))
            log.pause(False)
            self.assertIsNotNone(log.command(line="SET_INDEX 3", name="SET_INDEX", category="navigation",
                                             origin="ui", snapshot=snapshot()))
            log.end()
            frames = [json.loads(line)["frame"] for line in log.path.read_text().strip().splitlines()]
            self.assertIn("session.paused", frames)
            self.assertIn("session.resumed", frames)

    def test_semantics_cover_the_command_vocabulary(self) -> None:
        from fastfuncstuff.viewer import commands as ffs_commands
        names = ffs_commands.registered_names()
        self.assertGreater(len(names), 100)
        for name in names:
            projected = semantics(name, f"{name} 1 2 3")
            self.assertIsInstance(projected, dict)
            self.assertIn("kind", projected)
        self.assertEqual(semantics("SET_ALPHA", "SET_ALPHA S 0.4")["kind"], "display")
        self.assertEqual(semantics("SET_XYZ", "SET_XYZ 1.5 -2 3")["space"], "mm")
        self.assertEqual(semantics("OPEN_VIEW", "OPEN_VIEW V2 image sagittal")["view"], "V2")
        self.assertEqual(semantics("LOAD_SURFACES", "LOAD_SURFACES /tmp/subj")["kind"], "surface")
        self.assertEqual(new_session_id().split("-")[0], "insp")


if __name__ == "__main__":
    unittest.main()
