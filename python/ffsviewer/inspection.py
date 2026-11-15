"""Durable, append-only inspection record for the viewer sidecar.

RECORD.md §6: every accepted command is written to
``<state-dir>/inspection/<sessionId>.jsonl`` with a semantic projection, so a decision can cite
``{inspection, seq, stateSha256, coordinates, display}``. The FFS ``.ffs`` scripts remain the
current-state replay files; this log is the history and is exempt from surface pruning.

The log is deliberately small and dependency-free: one JSON object per line, one session per
sidecar boot, no reads during writes. A state hash covers display state (layers, viewports,
surfaces, crosshair, time index, mode) but never voxel bytes.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .snapshot import jsonable

SCHEMA = "ffs-inspection/1"

# Snapshot keys that make up the display state a decision can cite.
STATE_KEYS = ("theme", "crosshair", "crosshairMm", "timeIndex", "selected", "inputKey",
              "layers", "viewports", "surfaces", "mode", "grid")

_INT = r"-?\d+"
_FLOAT = r"-?\d+(?:\.\d+)?"


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")


def new_session_id() -> str:
    return f"insp-{_utc_stamp()}-{uuid.uuid4().hex[:4]}"


def state_hash(snapshot: dict) -> str:
    """sha256 of the canonical display state, independent of rev/notice/log excerpts."""
    subset = {key: snapshot.get(key) for key in STATE_KEYS if key in snapshot}
    payload = json.dumps(subset, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(payload.encode()).hexdigest()


def _ints(tokens: list[str], count: int) -> list[int] | None:
    try:
        return [int(float(tokens[i])) for i in range(1, count + 1)]
    except (IndexError, ValueError):
        return None


def _floats(tokens: list[str], count: int) -> list[float] | None:
    try:
        return [float(tokens[i]) for i in range(1, count + 1)]
    except (IndexError, ValueError):
        return None


def semantics(name: str, line: str) -> dict:
    """Table-driven semantic projection of one command; always returns a dict."""
    upper = str(name).upper()
    tokens = str(line).strip().split()
    if upper == "SET_IJK":
        ijk = _ints(tokens, 3)
        return {"kind": "crosshair", "space": "voxel", "ijk": ijk} if ijk else {"kind": "other"}
    if upper == "SET_XYZ":
        xyz = _floats(tokens, 3)
        return {"kind": "crosshair", "space": "mm", "xyz": xyz} if xyz else {"kind": "other"}
    if upper == "SET_INDEX":
        index = _ints(tokens, 1)
        return {"kind": "frame", "index": index[0]} if index else {"kind": "other"}
    if upper in {"SET_THRESHOLD", "SET_RANGE", "SET_ALPHA", "SET_COLORMAP", "SET_SIGN"}:
        target = tokens[1] if len(tokens) > 1 else None
        value: Any = tokens[2:] if len(tokens) > 2 else None
        if isinstance(value, list) and len(value) == 1:
            value = value[0]
        return {"kind": "display", "command": upper, "target": target, "value": value}
    if upper in {"OPEN_VIEW", "CLOSE_VIEW"}:
        return {"kind": "viewport", "command": upper, "view": tokens[1] if len(tokens) > 1 else None}
    if upper.startswith("SET_VIEW_"):
        return {"kind": "viewport", "command": upper, "view": tokens[1] if len(tokens) > 1 else None,
                "value": tokens[2:] or None}
    if upper in {"LOAD", "ADD_LAYER", "SET_OVERLAY", "SET_UNDERLAY", "SET_VOLUME", "SET_INPUT"}:
        return {"kind": "layer", "command": upper, "path": " ".join(tokens[1:]) or None}
    if upper.startswith("SET_LAYER"):
        return {"kind": "layer", "command": upper, "value": tokens[1:] or None}
    if "SURFACE" in upper or upper.startswith("SET_OUTLINE"):
        return {"kind": "surface", "command": upper, "value": tokens[1:] or None}
    if upper in {"SET_THEME"}:
        return {"kind": "theme", "value": tokens[1] if len(tokens) > 1 else None}
    return {"kind": "other"}


def _coordinates(snapshot: dict) -> dict:
    coords = {"space": "voxel", "ijk": list(snapshot.get("crosshair") or [])}
    mm = snapshot.get("crosshairMm")
    if isinstance(mm, (list, tuple)) and len(mm) == 3:
        coords["mm"] = list(mm)
        coords["mmSpace"] = "reference"
    return coords


def _display(snapshot: dict) -> dict:
    layers = snapshot.get("layers") or []
    selected = snapshot.get("selected")
    chosen = next((layer for layer in layers if layer.get("key") == selected), None) or (layers[-1] if layers else None)
    if not chosen:
        return {}
    keys = ("name", "key", "threshold", "rangeLo", "rangeHi", "colormap", "alphaMode", "signMode", "opacity")
    return {key: chosen.get(key) for key in keys if key in chosen}


class InspectionLog:
    """Append-only per-session JSONL. Safe for the sidecar's command thread."""

    def __init__(self, state_dir: Path, project_root: Path, *, version: str | None = None,
                 session_id: str | None = None, clock=time.time) -> None:
        self.state_dir = Path(state_dir)
        self.project_root = Path(project_root)
        self.version = version
        self.session_id = session_id or new_session_id()
        self.directory = self.state_dir / "inspection"
        self.path = self.directory / f"{self.session_id}.jsonl"
        self.seq = 0
        self.paused = False
        self._lock = threading.Lock()
        self._clock = clock
        self._handle = None
        self.baseline_info: dict | None = None
        self.directory.mkdir(parents=True, exist_ok=True)

    # -- lifecycle ------------------------------------------------------
    def start(self, *, restored: bool = False, context: dict | None = None) -> dict:
        return self._append("session.start", {
            "restored": bool(restored),
            "appVersion": self.version,
            "project": {"root": str(self.project_root)},
            "context": context or {},
        })

    def context(self, payload: dict) -> dict:
        return self._append("session.context", payload)

    def baseline(self, script_text: str, snapshot: dict) -> dict:
        """Write the seq-0 state script so a cited seq can be reconstructed from a baseline.

        The script is the FFS state script at session start; the hash is the state hash at the
        same moment. This is a side effect of opening/warming the viewer, never of a command.
        """
        text = str(script_text or "")
        path = self.directory / f"{self.session_id}.start.ffs"
        path.write_text(text, encoding="utf-8")
        try:
            display_path = str(path.relative_to(self.project_root))
        except ValueError:
            display_path = str(path)
        info = {
            "path": display_path,
            "sha256": hashlib.sha256(text.encode()).hexdigest(),
            "bytes": len(text.encode()),
            "stateSha256": state_hash(snapshot),
        }
        self.baseline_info = info
        self._append("session.baseline", info)
        return info

    def end(self) -> dict | None:
        record = self._append("session.end", {"commands": self.seq, "paused": self.paused})
        with self._lock:
            if self._handle is not None:
                try:
                    self._handle.flush()
                    self._handle.close()
                finally:
                    self._handle = None
        return record

    def pause(self, paused: bool) -> dict:
        with self._lock:
            self.paused = bool(paused)
        return self._append("session.paused" if paused else "session.resumed", {})

    def status(self) -> dict:
        try:
            path = str(self.path.relative_to(self.project_root))
        except ValueError:
            path = str(self.path)
        return {
            "schema": SCHEMA,
            "sessionId": self.session_id,
            "seq": self.seq,
            "paused": self.paused,
            "path": path,
            "baseline": self.baseline_info,
        }

    # -- events ---------------------------------------------------------
    def command(self, *, line: str, name: str, category: str, origin: str, snapshot: dict) -> dict | None:
        if self.paused:
            return None
        return self._append("event", {
            "origin": origin,
            "command": {"line": line, "name": name, "category": category},
            "semantic": semantics(name, line),
            "snapshot": {"rev": snapshot.get("rev"), "stateSha256": state_hash(snapshot)},
            "view": _view_projection(snapshot),
            "layer": _layer_projection(snapshot),
        })

    def compute(self, snapshot: dict, *, capture: bool = True, label: str | None = None) -> dict:
        sha = state_hash(snapshot)
        coordinates = _coordinates(snapshot)
        display = _display(snapshot)
        record = None
        if capture:
            record = self._append("capture", {
                "label": label,
                "stateSha256": sha,
                "coordinates": coordinates,
                "display": display,
            })
        return {
            "sessionId": self.session_id,
            "seq": (record or {}).get("seq", self.seq),
            "stateSha256": sha,
            "coordinates": coordinates,
            "display": display,
            "baselineSha256": (self.baseline_info or {}).get("sha256"),
        }

    def mark(self, *, text: str, tags: list[str] | None = None, kind: str = "mark",
             correction_of: int | None = None, snapshot: dict | None = None,
             capture: bool = True) -> dict:
        payload: dict[str, Any] = {
            "text": str(text or ""),
            "tags": [str(tag) for tag in (tags or [])],
            "kind": kind if kind in {"mark", "measure", "correct"} else "mark",
        }
        if correction_of is not None:
            payload["correctionOf"] = int(correction_of)
        if snapshot is not None:
            if capture:
                payload["stateSha256"] = state_hash(snapshot)
            payload["coordinates"] = _coordinates(snapshot)
            payload["display"] = _display(snapshot)
        return self._append("mark", payload)

    def save(self, *, note: str | None, files: dict) -> dict:
        return self._append("save", {"note": note, "files": files})

    def prune(self, *, count: int, reason: str) -> dict:
        return self._append("prune", {"count": int(count), "reason": str(reason)})

    # -- io -------------------------------------------------------------
    def _append(self, frame: str, payload: dict) -> dict:
        with self._lock:
            self.seq += 1
            record = {
                "schema": SCHEMA,
                "frame": frame,
                "seq": self.seq,
                "sessionId": self.session_id,
                "ts": datetime.fromtimestamp(self._clock(), timezone.utc).isoformat(),
                **jsonable(payload),
            }
            if self._handle is None:
                self._handle = self.path.open("a", encoding="utf-8")
            self._handle.write(json.dumps(record, sort_keys=True, default=str) + "\n")
            self._handle.flush()
            if frame in {"session.end", "mark", "capture"}:
                os.fsync(self._handle.fileno())
            return record


def _view_projection(snapshot: dict) -> dict:
    viewports = snapshot.get("viewports") or []
    active = next((vp for vp in viewports if vp.get("focused")), viewports[0] if viewports else None)
    if not active:
        return {}
    return {
        "active": active.get("key") or active.get("id"),
        "plane": active.get("plane"),
        "locked": active.get("locked"),
        "position": active.get("position"),
    }


def _layer_projection(snapshot: dict) -> dict:
    layers = snapshot.get("layers") or []
    selected = snapshot.get("selected")
    chosen = next((layer for layer in layers if layer.get("key") == selected), None) or (layers[-1] if layers else None)
    if not chosen:
        return {}
    return {"id": chosen.get("key"), "name": chosen.get("name")}
