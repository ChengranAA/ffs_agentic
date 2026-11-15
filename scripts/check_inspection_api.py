#!/usr/bin/env python3
"""Exercise the sidecar's durable inspection log over the real NDJSON protocol.

Spawns `python -m ffsviewer.server` against a temporary state dir, drives a few commands,
captures/marks/pauses, saves and shuts down, then validates the JSONL frames and state hash.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / ".venv" / "bin" / "python"
ENV = dict(os.environ)
ENV["PYTHONPATH"] = f"{ROOT / 'python'}:{ROOT / 'reference' / 'fastfuncstuff'}"
# Deterministic retention in this check: keep only the newest session raw.
ENV["FFS_RECORD_COMPACT_DAYS"] = "1"
ENV["FFS_RECORD_COMPACT_KEEP"] = "1"


class Sidecar:
    def __init__(self, state_dir: Path, project_root: Path) -> None:
        self.process = subprocess.Popen(
            [str(PYTHON), "-u", "-m", "ffsviewer.server",
             "--project-root", str(project_root), "--state-dir", str(state_dir)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=ENV, cwd=str(ROOT),
        )
        self.next_id = 0

    def call(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        request_id = self.next_id
        line = json.dumps({"id": request_id, "method": method, "params": params or {}})
        assert self.process.stdin is not None
        self.process.stdin.write(line + "\n")
        self.process.stdin.flush()
        while True:
            assert self.process.stdout is not None
            response_line = self.process.stdout.readline()
            if not response_line:
                stderr = self.process.stderr.read() if self.process.stderr else ""
                raise RuntimeError(f"sidecar exited: {stderr[-2000:]}")
            response = json.loads(response_line)
            if response.get("id") != request_id:
                continue
            if not response.get("ok"):
                raise RuntimeError(f"{method} failed: {response.get('error')}")
            return response["result"]

    def close(self) -> None:
        try:
            self.call("shutdown")
        except Exception:
            pass
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="ffs-inspection-") as tmp:
        project_root = Path(tmp) / "project"
        project_root.mkdir(parents=True, exist_ok=True)
        state_dir = project_root / ".ffs-viewer"
        inspection_dir = state_dir / "inspection"
        inspection_dir.mkdir(parents=True, exist_ok=True)
        old_session = inspection_dir / "insp-old.jsonl"
        old_session.write_text("\n".join(json.dumps(frame) for frame in [
            {"schema": "ffs-inspection/1", "frame": "session.start", "seq": 1, "sessionId": "insp-old", "ts": "2026-09-01T10:00:00Z"},
            {"schema": "ffs-inspection/1", "frame": "event", "seq": 2, "sessionId": "insp-old", "ts": "2026-09-01T10:00:01Z",
             "command": {"line": "SET_THEME dark", "name": "SET_THEME", "category": "display"}, "semantic": {"kind": "theme"}},
            {"schema": "ffs-inspection/1", "frame": "session.end", "seq": 3, "sessionId": "insp-old", "ts": "2026-09-01T10:05:00Z"},
        ]) + "\n")
        dead_session = inspection_dir / "insp-dead.jsonl"
        dead_session.write_text('{"schema":"ffs-inspection/1","frame":"session.start","seq":1,"sessionId":"insp-dead"}\n')
        (inspection_dir / "deletion-queue.jsonl").write_text(json.dumps({
            "schema": "ffs-inspection-deletion/1", "sessionId": "insp-dead",
            "paths": [str(dead_session)], "at": "2026-11-13T00:00:00Z", "status": "pending",
        }) + "\n")
        sidecar = Sidecar(state_dir, project_root)
        try:
            hello = sidecar.call("hello")
            assert hello["inspection"]["sessionId"].startswith("insp-")
            assert not dead_session.exists(), "queued raw inspection deletion was not applied"
            receipts = (inspection_dir / "deletion-receipts.jsonl").read_text().strip().splitlines()
            assert json.loads(receipts[-1])["sessionId"] == "insp-dead"
            sidecar.call("open", {"preset": "empty"})
            sidecar.call("execute", {"line": "SET_THEME dark", "origin": "ui"})
            opened = sidecar.call("execute", {"line": "OPEN_VIEW V1 image axial", "origin": "ui"})
            session_id = opened["state"]["inspection"]["sessionId"]
            capture = sidecar.call("inspection_capture", {"label": "smoke capture"})
            assert len(capture["stateSha256"]) == 64
            assert len(capture["baselineSha256"]) == 64
            baseline_file = state_dir / "inspection" / f"{session_id}.start.ffs"
            assert baseline_file.exists(), f"baseline missing: {baseline_file}" 
            mark = sidecar.call("inspection_mark", {"text": "check alignment", "tags": ["smoke"]})
            assert mark["frame"] == "mark" and mark["seq"] > capture["seq"]
            sidecar.call("inspection_pause", {"paused": True})
            sidecar.call("execute", {"line": "SET_THEME light", "origin": "ui"})
            sidecar.call("inspection_pause", {"paused": False})
            sidecar.call("execute", {"line": "SET_THEME light", "origin": "ui"})
            sidecar.call("save", {"note": "inspection smoke"})
            status = sidecar.call("inspection_state")
            assert status["sessionId"] == session_id
        finally:
            sidecar.close()

        log_path = state_dir / "inspection" / f"{session_id}.jsonl"
        assert log_path.exists(), f"inspection log missing: {log_path}"
        frames = [json.loads(line) for line in log_path.read_text().strip().splitlines()]
        kinds = [frame["frame"] for frame in frames]
        assert kinds[0] == "session.start"
        assert kinds[-1] == "session.end"
        assert "session.paused" in kinds and "session.resumed" in kinds
        assert "mark" in kinds and "capture" in kinds and "save" in kinds
        assert "session.baseline" in kinds
        assert [frame["seq"] for frame in frames] == list(range(1, len(frames) + 1))
        events = [frame for frame in frames if frame["frame"] == "event"]
        themes = [event for event in events if event["command"]["name"] == "SET_THEME"]
        lights = [event for event in themes if event["command"]["line"] == "SET_THEME light"]
        assert len(lights) == 1, f"the paused SET_THEME was recorded: {[(e['command']['line'], e['origin']) for e in themes]}"
        assert all(event["semantic"]["kind"] == "theme" for event in themes)
        assert all(event["snapshot"]["stateSha256"] for event in events)
        assert not old_session.exists(), "retention did not compact the old raw session"
        assert (inspection_dir / "compact" / "insp-old.json").exists(), "compact record missing"
        tombstones = (inspection_dir / "tombstones.jsonl").read_text().strip().splitlines()
        assert json.loads(tombstones[-1])["sessionId"] == "insp-old"
        profile_path = project_root / "work" / "ffs-record" / "preferences" / "profile.json"
        assert profile_path.exists(), f"auto profile missing: {profile_path}"
        profile = json.loads(profile_path.read_text())
        assert profile["evidence"]["sessions"] >= 1
        print(f"inspection api ok: {len(frames)} frames · session {session_id} · baseline {capture['baselineSha256'][:12]}")
        print(f"auto profile ok: {profile['evidence']['sessions']} session(s) · {len(profile['preferences'])} preference(s)")
        print("retention ok: old raw session compacted + tombstoned")
        print(f"capture state {capture['stateSha256'][:12]} · mark seq {mark['seq']}")
        print("PASS inspection api")
        return 0


if __name__ == "__main__":
    sys.exit(main())
