"""Turn one inspection session into a fixed, additive feature shard (RECORD.md §7.2).

Only user-origin commands feed behavioral aggregates; agent/system activity is counted for
audit. A restored or agent-heavy session keeps `behavioralWeight: 0` and cannot support a
preference. The shard is deliberately coarse and contains no image data.
"""

from __future__ import annotations

import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "ffs-record-features/1"
_UI_ORIGINS = {"ui", "user", "browser"}
_MAX_FLOAT_PRECISION = 3


def _ts(value) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def read_frames(path: Path) -> list[dict]:
    frames = []
    try:
        text = Path(path).read_text(encoding="utf-8")
    except OSError:
        return frames
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            frames.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return frames


def _numbers(value) -> list[float]:
    out: list[float] = []
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, str):
        tokens = value.replace(",", " ").split()
    elif isinstance(value, (list, tuple)):
        tokens = []
        for item in value:
            if isinstance(item, (int, float)):
                out.append(float(item))
            elif isinstance(item, str):
                tokens.extend(item.replace(",", " ").split())
    else:
        tokens = []
    for token in tokens:
        try:
            out.append(float(token))
        except ValueError:
            continue
    return out


def _strings(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, (list, tuple)):
        return [str(item) for item in value if item is not None]
    return []


def feature_from_frames(frames: list[dict], *, session_id: str | None = None,
                        project: dict | None = None) -> dict:
    start = next((frame for frame in frames if frame.get("frame") == "session.start"), {})
    end = next((frame for frame in reversed(frames) if frame.get("frame") == "session.end"), None)
    context = next((frame for frame in frames if frame.get("frame") == "session.context"), {})
    events = [frame for frame in frames if frame.get("frame") == "event"]
    marks = [frame for frame in frames if frame.get("frame") == "mark"]

    origin_counts: Counter[str] = Counter()
    by_category: Counter[str] = Counter()
    by_name: Counter[str] = Counter()
    thresholds: list[float] = []
    alphas: list[float] = []
    colormaps: list[str] = []
    views: list[str] = []
    layers: list[str] = []
    user_events = 0
    for frame in events:
        origin = str(frame.get("origin") or "ui")
        origin_counts[origin] += 1
        command = frame.get("command") or {}
        semantic = frame.get("semantic") or {}
        if origin not in _UI_ORIGINS:
            continue
        user_events += 1
        by_category[str(command.get("category") or "unknown")] += 1
        by_name[str(command.get("name") or "unknown")] += 1
        name = str(command.get("name") or "").upper()
        value = semantic.get("value")
        if name == "SET_THRESHOLD":
            thresholds.extend(_numbers(value))
        elif name == "SET_ALPHA":
            alphas.extend(_numbers(value))
        elif name == "SET_COLORMAP":
            colormaps.extend(_strings(value))
        elif name == "OPEN_VIEW":
            view = semantic.get("view")
            if view:
                views.append(str(view))
        elif name in {"LOAD", "ADD_LAYER", "SET_OVERLAY", "SET_UNDERLAY", "SET_INPUT"}:
            layer = semantic.get("path")
            if layer:
                layers.append(str(layer))

    started = _ts(start.get("ts"))
    ended = _ts(end.get("ts")) if end else None
    restored = bool(start.get("restored"))
    total_events = len(events)
    user_ratio = (user_events / total_events) if total_events else 0.0
    behavioral_weight = 0.0
    if total_events and user_ratio >= 0.6 and not restored:
        behavioral_weight = round(min(1.0, user_ratio), _MAX_FLOAT_PRECISION)

    project_value = dict(project or {})
    for source in (start.get("context"), context, start):
        if not isinstance(source, dict):
            continue
        candidate = source.get("project") if isinstance(source.get("project"), dict) else source
        for key in ("task", "modality", "stage"):
            if candidate.get(key) and not project_value.get(key):
                project_value[key] = candidate[key]

    return {
        "schema": SCHEMA,
        "sessionId": session_id or start.get("sessionId"),
        "project": project_value,
        "window": {
            "from": start.get("ts"),
            "to": (end or {}).get("ts"),
            "durationS": int(ended - started) if started and ended else None,
        },
        "status": "complete" if end else ("paused" if any(frame.get("frame") == "session.paused" for frame in frames) else "partial"),
        "restored": restored,
        "originCounts": dict(origin_counts),
        "behavioralWeight": behavioral_weight,
        "userEvents": user_events,
        "counts": {
            "byCategory": dict(by_category),
            "byName": dict(by_name),
            "marks": len(marks),
        },
        "settings": {
            "thresholdsSet": thresholds,
            "alphasSet": alphas,
            "colormaps": colormaps,
            "viewsOpened": views,
            "layersLoaded": layers,
        },
    }


def feature_from_session(path: Path, *, project: dict | None = None) -> dict:
    frames = read_frames(path)
    return feature_from_frames(frames, session_id=Path(path).stem, project=project)


def write_shard(project_root: Path, shard: dict) -> Path:
    directory = Path(project_root) / "work" / "ffs-record" / "preferences" / "evidence"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{shard['sessionId']}.json"
    path.write_text(json.dumps(shard, indent=1, sort_keys=True, default=str) + "\n", encoding="utf-8")
    return path


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
