"""Saving and restoring viewer state and the Harness workspace layout.

Two different things are persisted, on purpose:

* ``viewer.ffs`` is the FFS command script -- the authoritative viewer state.
* ``workspace.json`` is the Harness workspace layout (docks, tabs, sizes). It is not
  FFS state and replaying it can never change a voxel or a computation.

``display.ffs`` and ``analysis.ffs`` split the command log by category so a cosmetic
change can be saved or replayed without rewriting what data exists or what was computed.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
from pathlib import Path

from fastfuncstuff.viewer import commands as ffs_commands

from .classify import CATEGORY_ANALYSIS, CATEGORY_DISPLAY, CATEGORY_NAVIGATION, CATEGORY_SOURCE
from .snapshot import jsonable

VIEWER_SCRIPT = "viewer.ffs"
DISPLAY_SCRIPT = "display.ffs"
ANALYSIS_SCRIPT = "analysis.ffs"
WORKSPACE_FILE = "workspace.json"
MANIFEST_FILE = "session.json"
SCREENSHOT_DIR = "screenshots"


def _stamp() -> str:
    return _dt.datetime.now().astimezone().isoformat(timespec="seconds")


def default_workspace(session) -> dict:
    """A first layout shaped for the docked Sidebar.

    MRI panes are close to square, so the default is a 2x2 grid: the three
    orthogonal slices each get a pane, and surfaces/graphs share the fourth as
    tabs. The UI can switch to columns or tabs and remembers that choice.
    """
    st = session.state
    images = [vp.id for vp in st.viewports if vp.kind.value == "image"]
    rest = [
        vp.id for vp in st.viewports
        if vp.kind.value in ("surface", "graph")
    ] + [
        vp.id for vp in st.viewports
        if vp.kind.value not in ("image", "surface", "graph")
    ]

    def group(ident: str, tabs: list[str], size: float = 1.0) -> dict:
        return {"type": "group", "id": ident, "tabs": tabs, "active": tabs[0], "size": size}

    cells = [group(f"g-{vid}", [vid]) for vid in images]
    if rest:
        cells.append(group("g-rest", rest))
    if not cells:
        return {"version": 1, "open": True, "maximized": None, "docks": None}

    def split(ident: str, direction: str, children: list[dict]) -> dict:
        return children[0] if len(children) == 1 else {
            "type": "split", "id": ident, "direction": direction, "children": children,
        }

    if len(cells) <= 2:
        docks = split("s-root", "column", cells)
    else:
        rows = [
            split(f"s-row-{index}", "row", cells[index:index + 2])
            for index in range(0, len(cells), 2)
        ]
        docks = split("s-root", "column", rows)
    return {"version": 1, "open": True, "maximized": None, "docks": docks}


def load_workspace(state_dir: Path) -> dict | None:
    path = Path(state_dir) / WORKSPACE_FILE
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and data.get("version") == 1:
            return data
    except (OSError, ValueError):
        return None
    return None


def save_workspace(state_dir: Path, layout: dict) -> Path:
    path = Path(state_dir) / WORKSPACE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(layout, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(tmp, path)
    return path


def _read_script(state_dir: Path) -> str | None:
    path = Path(state_dir) / VIEWER_SCRIPT
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _source_manifest(session) -> list[dict]:
    out = []
    seen = set()
    for layer in session.state.layers.layers:
        if layer.source != "file" or layer.path in seen:
            continue
        seen.add(layer.path)
        entry = {"path": layer.path, "key": layer.key, "name": layer.name}
        try:
            stat = os.stat(layer.path)
            entry["bytes"] = int(stat.st_size)
            entry["mtime"] = int(stat.st_mtime)
        except OSError:
            entry["missing"] = True
        out.append(entry)
    return out


def analysis_layers(session) -> list[dict]:
    """Layers whose voxels this session did not read from a file unmodified."""
    out = []
    for layer in session.state.layers.layers:
        if layer.source == "file":
            continue
        out.append({
            "key": layer.key,
            "name": layer.name,
            "source": layer.source,
            "nVolumes": int(layer.n_volumes),
        })
    return out


def save_state(
    session,
    *,
    state_dir: Path,
    command_log: list[dict],
    workspace: dict | None,
    note: str | None = None,
) -> dict:
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    header = (
        f"FFS Harness viewer state -- {_stamp()}\n"
        "Replay with: ffs_viewer_command action=execute lines=... or session.run_script(text)"
    )
    whole = session.to_script(header=header)
    display_lines = [
        entry["line"] for entry in command_log
        if entry["category"] in (CATEGORY_DISPLAY, CATEGORY_NAVIGATION)
    ]
    analysis_lines = [
        entry["line"] for entry in command_log
        if entry["category"] in (CATEGORY_SOURCE, CATEGORY_ANALYSIS)
    ]
    files: dict[str, str] = {}
    for name, text in (
        (VIEWER_SCRIPT, whole),
        (DISPLAY_SCRIPT, _section("display + navigation changes only", display_lines)),
        (ANALYSIS_SCRIPT, _section("source + analysis changes", analysis_lines)),
    ):
        path = state_dir / name
        path.write_text(text, encoding="utf-8")
        files[name] = str(path)
    layout = workspace or default_workspace(session)
    files[WORKSPACE_FILE] = str(save_workspace(state_dir, layout))
    (state_dir / SCREENSHOT_DIR).mkdir(exist_ok=True)

    counts = {category: 0 for category in ("source", "analysis", "display", "navigation")}
    for entry in command_log:
        counts[entry["category"]] = counts.get(entry["category"], 0) + 1
    manifest = {
        "savedAt": _stamp(),
        "note": note,
        "viewerScript": VIEWER_SCRIPT,
        "displayScript": DISPLAY_SCRIPT,
        "analysisScript": ANALYSIS_SCRIPT,
        "workspace": WORKSPACE_FILE,
        "counts": counts,
        "analysisLayers": analysis_layers(session),
        "sources": _source_manifest(session),
        "surfaces": {
            "subject": None if session.surfaces.subject is None else str(session.surfaces.subject),
            "shown": [str(s) for s in session.state.surfaces_shown],
        },
        "viewports": [vp.id for vp in session.state.viewports],
        "layers": [layer.key for layer in session.state.layers.layers],
        "scriptLines": whole.count("\n"),
    }
    manifest_path = state_dir / MANIFEST_FILE
    manifest_path.write_text(
        json.dumps(jsonable(manifest), indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    files[MANIFEST_FILE] = str(manifest_path)
    return {"dir": str(state_dir), "files": files, "manifest": jsonable(manifest)}


def _section(title: str, lines: list[str]) -> str:
    body = "\n".join(lines)
    return f"# {title}\n{body}\n" if body else f"# {title}\n# (none)\n"


def restore_state(session, state_dir: Path) -> dict:
    """Replay the saved script into a fresh session; returns what happened."""
    text = _read_script(state_dir)
    if not text:
        return {"restored": False, "reason": "no viewer.ffs"}
    parsed = ffs_commands.parse_script(text)
    session.run_script(text)
    log = [
        {
            "line": cmd.to_line(),
            "name": cmd.name,
            "category": _category(cmd.name),
            "origin": "restore",
            "ts": _stamp(),
        }
        for cmd in parsed
    ]
    return {
        "restored": True,
        "commands": len(parsed),
        "log": log,
        "workspace": load_workspace(state_dir),
    }


def _category(name: str) -> str:
    from .classify import category_of

    try:
        return category_of(name)
    except KeyError:
        return "display"
