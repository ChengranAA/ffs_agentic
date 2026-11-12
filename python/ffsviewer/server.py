"""Headless FFS viewer sidecar: newline-delimited JSON on stdio.

The Harness Host plugin starts this process and forwards both browser and agent
actions here. Every mutation goes through the FFS command bus, so a command a person
clicks and a command an agent asks for are the same validated operation.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import threading
import time
import traceback
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FFS_SRC = ROOT / "reference" / "fastfuncstuff"
for _candidate in (str(ROOT / "python"), str(FFS_SRC)):
    if _candidate not in sys.path:
        sys.path.insert(0, _candidate)

import numpy as np  # noqa: E402
import torch  # noqa: E402

from fastfuncstuff.viewer import commands as ffs_commands  # noqa: E402
from fastfuncstuff.viewer import compose  # noqa: E402
from fastfuncstuff.viewer.session import ViewerSession  # noqa: E402

from . import persist, png, series_ops, surface_ops  # noqa: E402
from .classify import (  # noqa: E402
    CATEGORIES,
    CATEGORY_ANALYSIS,
    CATEGORY_DISPLAY,
    CATEGORY_NAVIGATION,
    CATEGORY_SOURCE,
    assert_complete,
    category_of,
)
from fastfuncstuff.viewer.catalog import SUFFIXES, SURFACE_SUFFIXES  # noqa: E402

from .schema import command_schema  # noqa: E402
from .snapshot import aspects_names, build_snapshot  # noqa: E402

VERSION = "0.1.0"
MAX_LINE = 4096
LIMITED_COMMANDS = frozenset({"READ", "READ_FILES", "LOAD", "ADD_LAYER", "SET_UNDERLAY", "SET_OVERLAY"})


class SidecarError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}


class Sidecar:
    def __init__(self, project_root: Path, state_dir: Path, *, autosave: bool = True) -> None:
        self.project_root = Path(project_root)
        self.state_dir = Path(state_dir)
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.autosave = autosave
        self.session: ViewerSession | None = None
        self.command_log: list[dict] = []
        self._render_cache: dict[str, dict] = {}
        self._surface_cache: dict[str, dict] = {}
        self._surface_note: dict[str, dict] = {}
        self._sources: dict | None = None
        self._change_lock = threading.Lock()
        self.meta = self._fresh_meta()
        self.meta["notice"] = None
        self.meta["stateDir"] = str(self.state_dir)

    # -- bookkeeping ---------------------------------------------------
    def _fresh_meta(self) -> dict:
        return {
            "rev": 0,
            "revByCategory": {category: 0 for category in CATEGORIES},
            "category": "system",
            "origin": "system",
            "dirty": {category: False for category in CATEGORIES},
            "workspace": None,
            "showSeq": 0,
            "commandCount": 0,
            "lastSavedAt": None,
            "lastSaveRev": 0,
        }

    def _bump(self, category: str, origin: str) -> None:
        self.meta["rev"] += 1
        self.meta["revByCategory"][category] += 1
        self.meta["category"] = category
        self.meta["origin"] = origin
        if category != CATEGORY_NAVIGATION:
            self.meta["dirty"][category] = True
        # A display-only change is not the same warning as a data change, but any
        # unsaved state means the saved files are older than the session.
        self.meta["dirty"]["display"] = self.meta["dirty"]["display"] or category == CATEGORY_DISPLAY
        self._render_cache.clear()
        if category in (CATEGORY_DISPLAY, CATEGORY_NAVIGATION):
            self._surface_cache.clear()

    def _maybe_autosave(self) -> None:
        if not self.autosave:
            return
        if self.meta["commandCount"] - self.meta["lastSaveRev"] < 25:
            return
        if not any(self.meta["dirty"].values()):
            return
        try:
            self.save(None)
        except Exception:
            traceback.print_exc(file=sys.stderr)

    # -- session lifecycle ---------------------------------------------
    def ensure_session(self) -> ViewerSession:
        if self.session is None:
            torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
            self.session = ViewerSession(device=torch.device("cpu"))
            self.meta = self._fresh_meta()
            self.meta["stateDir"] = str(self.state_dir)
            missing = assert_complete(ffs_commands.registered_names())
            if missing:  # a vocabulary addition must be classified, not defaulted
                print(f"[ffs-viewer] unclassified commands: {missing}", file=sys.stderr)
        return self.session

    def _demo_paths(self) -> dict[str, Path]:
        demo = self.project_root / "data" / "demo"
        return {
            "anat": demo / "anat.nii.gz",
            "func": demo / "func.nii.gz",
            "stats": demo / "stats.nii.gz",
            "subject": demo / "subject",
        }

    def open(self, params: dict) -> dict:
        preset = str(params.get("preset") or "auto")
        explicit = params.get("paths") or []
        subject = params.get("subject")
        self.ensure_session()
        assert self.session is not None

        if preset == "demo":
            return self._open_demo()

        if preset == "restore" or (
            preset == "auto" and (self.state_dir / persist.VIEWER_SCRIPT).exists()
        ):
            try:
                result = persist.restore_state(self.session, self.state_dir)
            except Exception as exc:
                traceback.print_exc(file=sys.stderr)
                self.meta["notice"] = f"restore failed ({exc}); starting with empty sources"
                result = {"restored": False, "reason": str(exc)}
            if result.get("restored"):
                self.command_log = result.pop("log", [])
                self.meta["workspace"] = result.get("workspace") or persist.default_workspace(self.session)
                self.meta["rev"] = 1
                self.meta["revByCategory"]["layout"] = self.meta["revByCategory"].get("layout", 0) + 1
                self.meta["lastSaveRev"] = self.meta["commandCount"]
                self._await_resident()
                return {
                    "state": self.snapshot(),
                    "restored": True,
                    "preset": "restore",
                    "loading": self.snapshot()["loading"],
                }

        if explicit:
            return self._open_paths(list(explicit), subject)

        return self._open_empty()

    def _open_empty(self) -> dict:
        """A fresh viewer with no dataset: the Sources picker is the way in.

        Default viewports are opened so the workspace is ready; nothing is
        loaded and no demo is implied. The demo preset stays explicit, for tests.
        """
        assert self.session is not None
        script = [
            "SET_THEME dark",
            "OPEN_VIEW V1 image axial",
            "OPEN_VIEW V2 image sagittal",
            "OPEN_VIEW V3 image coronal",
            "OPEN_VIEW G1 graph",
            "SET_VIEW_GRID G1 1",
        ]
        for line in script:
            self.execute(line, "system")
        self.meta["workspace"] = persist.default_workspace(self.session)
        persist.save_workspace(self.state_dir, self.meta["workspace"])
        self.meta["notice"] = "No dataset loaded. Use Sources to add a folder and load data."
        return {
            "state": self.snapshot(),
            "restored": False,
            "preset": "empty",
            "loading": False,
        }

    def _open_paths(self, paths: list[str], subject: str | None) -> dict:
        assert self.session is not None
        for path in paths:
            self.execute(f"LOAD {_quote(path)}", "system")
        if subject:
            self.execute(f"LOAD_SURFACES {_quote(subject)} lh,rh", "system")
        self.execute("SELECT_LAYER " + self.session.state.layers.layers[-1].key, "system")
        for plane, vid in (("axial", "V1"), ("sagittal", "V2"), ("coronal", "V3")):
            self.execute(f"OPEN_VIEW {vid} image {plane}", "system")
        if subject:
            self.execute("OPEN_VIEW S1 surface", "system")
        self.execute("OPEN_VIEW G1 graph", "system")
        self.meta["workspace"] = persist.default_workspace(self.session)
        self._await_resident()
        return {"state": self.snapshot(), "restored": False, "preset": "paths", "loading": False}

    def _open_demo(self) -> dict:
        assert self.session is not None
        paths = self._demo_paths()
        if not paths["anat"].exists():
            self.meta["notice"] = (
                f"demo data not found at {paths['anat']}; run scripts/build_demo_data.py "
                "or load a dataset with the command bar"
            )
            self.meta["workspace"] = persist.default_workspace(self.session)
            return {
                "state": self.snapshot(),
                "restored": False,
                "preset": "empty",
                "notice": self.meta["notice"],
            }
        script = ["SET_THEME dark"]
        script.append(f"LOAD {_quote(paths['anat'])} A")
        if paths["func"].exists():
            script.append(f"LOAD {_quote(paths['func'])} F")
            script.append("SET_COLORMAP F hot")
            script.append("SET_LAYER_VISIBLE F 0")
        if paths["stats"].exists():
            script.append(f"LOAD {_quote(paths['stats'])} S")
            script.append("SET_COLORMAP S redblue")
            script.append("SET_SIGN S both")
            script.append("SET_ALPHA S linear")
            script.append("SET_BOXED S 1")
            script.append("SET_THRESHOLD S 2.5")
            script.append("SET_RANGE S -6 6")
            script.append("SET_RANGE_MIRROR S 1")
            script.append("SELECT_LAYER S")
        if paths["subject"].exists() and (paths["subject"] / "surf").exists():
            script.append(f"LOAD_SURFACES {_quote(paths['subject'])} lh,rh")
            script.append("SHOW_SURFACES white,pial")
        script.extend([
            "OPEN_VIEW V1 image axial",
            "OPEN_VIEW V2 image sagittal",
            "OPEN_VIEW V3 image coronal",
        ])
        if paths["subject"].exists() and (paths["subject"] / "surf").exists():
            script.append("OPEN_VIEW S1 surface")
            script.append("SET_SURFACE_SHAPE S1 inflated")
            script.append("SET_SURFACE_DEPTH S1 0.5 0.5 1")
            script.append("SET_SURFACE_FOLDING S1 curv")
        script.append("OPEN_VIEW G1 graph")
        script.append("SET_VIEW_GRID G1 1")
        for line in script:
            self.execute(line, "system")
        self.meta["workspace"] = persist.default_workspace(self.session)
        self._await_resident()
        state = self.snapshot()
        self.save("initial demo session")
        return {"state": state, "restored": False, "preset": "demo", "loading": state["loading"]}

    def _await_resident(self, timeout: float = 60.0) -> None:
        """Wait for background 4-D inflates so scrubbing and graphs work immediately."""
        if self.session is None:
            return
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pending = []
            for layer in self.session.state.layers.layers:
                if layer.n_volumes <= 1:
                    continue
                try:
                    if self.session.store.get(layer.key).array is None:
                        pending.append(layer.key)
                except Exception:
                    pass
            if not pending:
                self._render_cache.clear()
                self._surface_cache.clear()
                return
            time.sleep(0.02)

    # -- commands ------------------------------------------------------
    def _validate(self, line: str) -> object:
        if not isinstance(line, str) or not line.strip():
            raise SidecarError("command-invalid", "command line is empty")
        if len(line) > MAX_LINE:
            raise SidecarError("command-invalid", f"command line exceeds {MAX_LINE} bytes")
        try:
            cmd = ffs_commands.parse_line(line)
        except KeyError as exc:
            raise SidecarError("command-invalid", str(exc), {"line": line}) from None
        except (ValueError, TypeError) as exc:
            raise SidecarError("command-invalid", str(exc), {"line": line}) from None
        if cmd is None:
            raise SidecarError("command-invalid", "empty or comment line", {"line": line})
        return cmd

    def execute(self, line: str, origin: str = "ui") -> dict:
        self.ensure_session()
        assert self.session is not None
        cmd = self._validate(line)
        try:
            category = category_of(cmd.name)
        except KeyError as exc:
            raise SidecarError("command-unclassified", str(exc), {"line": line}) from None
        if self.session.state.grid is None and cmd.name not in {
            "LOAD", "ADD_LAYER", "SET_UNDERLAY", "SET_OVERLAY", "READ", "READ_FILES",
            "LOAD_SURFACES", "SET_THEME",
            # An empty viewer must be able to open its initial panes.
            "OPEN_VIEW", "CLOSE_VIEW", "SET_VIEW_PLANE", "SET_VIEW_LOCKED",
            "SET_VIEW_POSITION", "SET_VIEW_GRID", "SET_VIEW_GEOMETRY", "SET_ZOOM",
            "SET_PAN", "SET_VIEW_TILT", "SET_VIEW_SOLO", "SET_VIEW_TILES",
        }:
            raise SidecarError(
                "no-data", f"cannot apply {cmd.name} before any dataset is loaded", {"line": line}
            )
        try:
            dirty = self.session.do(cmd)
        except KeyError as exc:
            raise SidecarError("not-found", str(exc), {"line": line}) from None
        except (ValueError, TypeError, FileNotFoundError) as exc:
            raise SidecarError("command-failed", str(exc), {"line": line}) from None
        with self._change_lock:
            self.meta["commandCount"] += 1
            self.command_log.append({
                "line": cmd.to_line(),
                "name": cmd.name,
                "category": category,
                "origin": origin,
                "ts": time.time(),
            })
            self._bump(category, origin)
        self._render_cache.clear()
        self._maybe_autosave()
        if cmd.name in LIMITED_COMMANDS:
            self._await_resident()
        return {
            "state": self.snapshot(),
            "dirty": aspects_names(dirty),
            "command": cmd.to_line(),
            "name": cmd.name,
            "category": category,
        }

    def execute_batch(self, lines: list[str], origin: str = "ui") -> dict:
        results = []
        for line in lines:
            results.append(self.execute(line, origin))
        return {"state": self.snapshot(), "results": results}

    # -- reads ---------------------------------------------------------
    def snapshot(self) -> dict:
        self.ensure_session()
        assert self.session is not None
        if self.meta["workspace"] is None:
            # Cheap and side-effect free: the browser needs to know whether the
            # saved workspace was open before deciding to load a dataset.
            self.meta["workspace"] = persist.load_workspace(self.state_dir)
        return build_snapshot(self.session, self.meta)

    def hello(self) -> dict:
        return {
            "version": VERSION,
            "ffsVersion": _ffs_version(),
            "python": sys.version.split()[0],
            "projectRoot": str(self.project_root),
            "stateDir": str(self.state_dir),
            "device": "cpu",
            "commands": len(ffs_commands.registered_names()),
        }

    def commands(self) -> dict:
        return {"commands": command_schema(), "categories": _category_counts()}

    def render(self, view: str, params_outline: str | None = None) -> dict:
        self.ensure_session()
        assert self.session is not None
        st = self.session.state
        vp = st.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        key = (self.meta["rev"], view, tuple(_vp_signature(vp)), params_outline or "-")
        cached = self._render_cache.get(view)
        if cached is not None and cached["key"] == key:
            return cached["value"]
        grid_token = compose.view_grid(st, vp)
        outline_token = "no-surfaces"
        if grid_token is not None and self.session.surfaces.hemis and st.surfaces_shown:
            pos = (
                compose.plane_position(st, vp.plane)
                if vp.locked
                else (vp.position if vp.position is not None else compose.plane_position(st, vp.plane))
            )
            outline_token = _hash({
                "subject": None if self.session.surfaces.subject is None else str(self.session.surfaces.subject),
                "versions": {h: self.session.surfaces.version.get(h, 0) for h in self.session.surfaces.hemis},
                "shown": list(st.surfaces_shown),
                "shape": list(grid_token.shape),
                "affine": np.round(np.asarray(grid_token.affine, float), 8).tolist(),
                "plane": vp.plane.value,
                "position": int(pos),
                "zoom": round(float(vp.zoom), 6),
                "pan": [round(float(v), 6) for v in vp.pan],
                "tilt": [round(float(v), 6) for v in vp.tilt],
            })
        outlines_unchanged = params_outline is not None and params_outline == outline_token
        img = compose.render_viewport(self.session, vp)
        if img is None:
            rgba = png.blank_rgba()
            plane_name = vp.plane.value
            position = 0
            width = height = 1
        else:
            rgba = img.rgba.detach().cpu().numpy()
            plane_name = img.plane.value
            position = int(img.position)
            height, width = rgba.shape[:2]
        pv = compose.plane_view(st, vp)
        grid = compose.view_grid(st, vp)
        crosshair_px = None
        outlines: list[dict] = []
        if pv is not None and grid is not None:
            frac = pv.points_to_image(np.asarray(st.crosshair, np.float64))
            span = pv.span
            crosshair_px = [
                float(frac[0] / max(1, span[0])),
                float(frac[1] / max(1, span[1])),
            ]
            pos = int(position if not vp.locked else compose.plane_position(st, vp.plane))
            if (not outlines_unchanged) and self.session.surfaces.hemis and st.surfaces_shown:
                try:
                    outlines = _outline_payload(
                        self.session.surfaces.outlines(
                            np.asarray(grid.affine, float),
                            pv,
                            pos,
                            tuple(st.surfaces_shown),
                        ),
                        pv.span,
                    )
                except Exception:
                    traceback.print_exc(file=sys.stderr)
        value = {
            "rev": int(self.meta["rev"]),
            "unchanged": False,
            "view": view,
            "png": base64.b64encode(png.encode_rgba(rgba)).decode("ascii"),
            "width": int(width),
            "height": int(height),
            "plane": plane_name,
            "position": int(position),
            "crosshairPx": crosshair_px,
            "outlines": outlines,
            "outlineToken": outline_token,
            "outlinesUnchanged": bool(outlines_unchanged),
            "viewInfo": {
                "zoom": float(vp.zoom),
                "pan": [float(vp.pan[0]), float(vp.pan[1])],
                "span": None if pv is None else [int(pv.span[0]), int(pv.span[1])],
                "extent": None if pv is None else [int(pv.extent[0]), int(pv.extent[1])],
                "origin": None if pv is None else [int(pv.origin[0]), int(pv.origin[1])],
                "identity": None if pv is None else bool(pv.is_identity),
            },
        }
        self._render_cache[view] = {"key": key, "value": value}
        return value

    def auto_range(self, params: dict) -> dict:
        """Auto-range a layer exactly as the original viewer's AUTORANGE.

        A time-linked or single-volume layer re-derives the range from the shown
        volume; a stats bucket uses the displayed sub-brick, not volume 0, so
        auto follows the OLAY selection. The resulting SET_RANGE is recorded.
        """
        self.ensure_session()
        assert self.session is not None
        key = str(params.get("key") or "")
        layer = self.session.state.layers.get(key)
        if layer is None:
            raise SidecarError("not-found", f"no layer {key!r}", {"key": key})
        from fastfuncstuff.viewer.session import derive_range

        suggested = None
        if layer.time_linked or layer.n_volumes <= 1 or layer.is_computed:
            lo, hi = derive_range(self.session.shown_volume(key))
        else:
            look = self.session.overlay_look(key, layer.volume_index, colormap=layer.colormap)
            if "range_lo" not in look or "range_hi" not in look:
                raise SidecarError("auto-range-failed", f"no range for {key!r}", {"key": key})
            lo, hi = float(look["range_lo"]), float(look["range_hi"])
            suggested = look.get("colormap")
        lo, hi = float(lo), float(hi)
        if not (lo < hi):
            raise SidecarError("auto-range-failed", f"degenerate range for {key!r}: {lo}..{hi}")
        self.execute(f"SET_RANGE {key} {lo:.8g} {hi:.8g}", str(params.get("origin") or "ui"))
        if suggested and suggested != layer.colormap:
            self.execute(f"SET_COLORMAP {key} {suggested}", str(params.get("origin") or "ui"))
        return {"state": self.snapshot(), "key": key, "range": [lo, hi]}

    def colorbar(self, params: dict) -> dict:
        """An exact colour-scale strip from the viewer's own LUT."""
        from fastfuncstuff.viewer.colormap import available_colormaps, build_lut

        name = str(params.get("colormap") or "gray")
        if name not in available_colormaps():
            raise SidecarError("not-found", f"unknown colormap {name!r}", {"colormap": name})
        count = max(8, min(256, int(params.get("n", 64))))
        reverse = bool(params.get("reverse", False))
        lut = build_lut(name, count, reverse=reverse).detach().cpu().numpy()
        colors = [
            [int(round(float(channel) * 255.0)) for channel in row]
            for row in lut
        ]
        return {"colormap": name, "reverse": reverse, "colors": colors}

    def pick(self, params: dict) -> dict:
        self.ensure_session()
        assert self.session is not None
        view = str(params.get("view") or "")
        vp = self.session.state.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        pv = compose.plane_view(self.session.state, vp)
        if pv is None:
            raise SidecarError("no-data", "no display grid")
        row = int(round(float(params.get("row", 0))))
        col = int(round(float(params.get("col", 0))))
        if not (0 <= row < pv.span[0] and 0 <= col < pv.span[1]):
            raise SidecarError("out-of-range", "click is outside the drawn plane")
        ijk = pv.to_ijk(row, col, self.session.state.crosshair)
        origin = str(params.get("origin") or "ui")
        action = str(params.get("action") or "crosshair")
        command = "SET_SEED" if action == "seed" else "SET_IJK"
        result = self.execute(f"{command} {ijk[0]} {ijk[1]} {ijk[2]}", origin)
        return {"state": result["state"], "ijk": [int(v) for v in ijk], "mm": _crosshair_mm(self.session)}

    def pan(self, params: dict) -> dict:
        self.ensure_session()
        assert self.session is not None
        view = str(params.get("view") or "")
        vp = self.session.state.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        pv = compose.plane_view(self.session.state, vp)
        if pv is None:
            raise SidecarError("no-data", "no display grid")
        span = pv.span
        dx = float(params.get("dx", 0.0))
        dy = float(params.get("dy", 0.0))
        # dx/dy are fractions of the drawn plane; pan is in display-grid voxels.
        x = vp.pan[0] + dy * span[0]
        y = vp.pan[1] + dx * span[1]
        result = self.execute(
            f"SET_PAN {view} {x:.5f} {y:.5f}", str(params.get("origin") or "ui")
        )
        return {"state": result["state"]}

    def step(self, params: dict) -> dict:
        """Wheel step through slices, exactly as the original image window does it.

        A locked window moves the shared crosshair along the plane's fixed axis; a
        parked window moves only its own parked slice. An oblique grid is stepped
        along the tilted slice's own normal in millimetres.
        """
        self.ensure_session()
        assert self.session is not None
        st = self.session.state
        view = str(params.get("view") or "")
        vp = st.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        if st.grid is None:
            raise SidecarError("no-data", "no display grid")
        delta = int(params.get("delta", 1))
        axis = __import__("fastfuncstuff.viewer.slicing", fromlist=["plane_layout"]).plane_layout(
            st.grid.affine, vp.plane
        ).fixed
        grid = compose.view_grid(st, vp)
        origin = str(params.get("origin") or "ui")
        if grid is not None and grid.layout_affine is not None:
            mm = np.asarray(st.crosshair_mm, float) + delta * np.asarray(grid.affine)[:3, axis]
            self.execute(f"SET_XYZ {mm[0]:.6f} {mm[1]:.6f} {mm[2]:.6f}", origin)
        elif vp.locked:
            ijk = list(st.crosshair)
            ijk[axis] += delta
            self.execute(f"SET_IJK {ijk[0]} {ijk[1]} {ijk[2]}", origin)
        else:
            here = vp.position if vp.position is not None else st.crosshair[axis]
            limit = st.grid.shape[axis] - 1
            self.execute(f"SET_VIEW_POSITION {view} {max(0, min(here + delta, limit))}", origin)
        return {"state": self.snapshot(), "axis": int(axis)}

    def zoom(self, params: dict) -> dict:
        self.ensure_session()
        assert self.session is not None
        view = str(params.get("view") or "")
        vp = self.session.state.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        factor = float(params.get("factor", 1.0))
        if factor <= 0:
            raise SidecarError("invalid", "zoom factor must be positive")
        zoom = float(np.clip(vp.zoom * factor, 1.0, 16.0))
        result = self.execute(
            f"SET_ZOOM {view} {zoom:.5f}", str(params.get("origin") or "ui")
        )
        return {"state": result["state"]}

    def surface(self, params: dict) -> dict:
        self.ensure_session()
        assert self.session is not None
        view = str(params.get("view") or "")
        vp = self.session.state.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        if vp.kind.value != "surface":
            raise SidecarError("invalid", f"{view} is not a surface viewport")
        shape = params.get("shape")
        if shape is not None:
            from fastfuncstuff.viewer import surface3d as _s3

            if shape not in _s3.SHAPES:
                raise SidecarError("invalid", f"unknown surface shape {shape!r}", {"shape": shape})
        colors = params.get("colors", True) is not False
        fragment = bool(params.get("fragment", False))
        colors_token = self._surface_colors_token(vp)
        client_colors = params.get("colorsToken")
        if not colors:
            payload, rev = surface_ops.surface_payload(
                self.session, vp, client_mesh_rev=params.get("meshRev"), colors=False,
                shape=shape, fragment=bool(params.get("fragment", False)),
            )
            payload["colors"] = []
            payload["colorsUnchanged"] = True
            payload["layer"] = {"mode": "geometry-only"}
        elif (not fragment) and client_colors is not None and client_colors == colors_token and view in self._surface_note:
            payload, rev = surface_ops.surface_payload(
                self.session, vp, client_mesh_rev=params.get("meshRev"), colors=False,
                shape=shape, fragment=bool(params.get("fragment", False)),
            )
            payload["colors"] = []
            payload["colorsUnchanged"] = True
            payload["layer"] = self._surface_note[view]
        else:
            payload, rev = surface_ops.surface_payload(
                self.session, vp, client_mesh_rev=params.get("meshRev"), shape=shape,
                fragment=fragment,
                client_overlay_token=params.get("overlayToken"),
                data_token=(
                    f"{self.meta['revByCategory'].get('source', 0)}:"
                    f"{self.meta['revByCategory'].get('analysis', 0)}"
                ),
            )
            payload["colorsUnchanged"] = False
            self._surface_note[view] = payload.get("layer") or {}
        payload["colorsToken"] = colors_token
        payload["rev"] = int(self.meta["rev"])
        payload["meshRevCurrent"] = rev
        self._surface_cache[view] = payload
        return payload

    def _surface_colors_token(self, vp) -> str:
        assert self.session is not None
        st = self.session.state
        layers = []
        for layer in st.layers.layers:
            layers.append([
                layer.key, bool(layer.visible), float(layer.opacity), layer.colormap,
                bool(layer.colormap_reversed), layer.range_lo, layer.range_hi,
                bool(layer.range_mirror), bool(layer.range_fixed), float(layer.threshold),
                layer.threshold_index, layer.threshold_follow, layer.alpha_mode.value,
                bool(layer.boxed), layer.sign_mode.value, int(layer.n_panes),
                int(layer.volume_index), bool(layer.time_linked), bool(layer.roi),
                bool(layer.colour), float(layer.time_detrend), bool(layer.time_psc), layer.source,
            ])
        return _hash({
            "layers": layers,
            "timeIndex": int(st.time_index),
            "selected": st.selected,
            "annot": st.surface_annot,
            "mesh": surface_ops.mesh_revision(self.session, vp),
            "shape": vp.shape,
            "hemis": vp.hemis,
            "split": round(float(vp.split), 6),
            "hinge": round(float(vp.hinge), 6),
            "depth": [round(float(v), 6) for v in vp.depth],
            "samples": int(vp.samples),
            "depthStat": vp.depth_stat,
            "equivolume": bool(vp.equivolume),
            "vertexMap": vp.vertex_map,
            "folding": vp.folding,
        })

    def surface_pick(self, params: dict) -> dict:
        self.ensure_session()
        assert self.session is not None
        view = str(params.get("view") or "")
        vp = self.session.state.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        try:
            hit = surface_ops.pick_surface(
                self.session,
                vp,
                x_ndc=float(params.get("xNdc", 0.0)),
                y_ndc=float(params.get("yNdc", 0.0)),
                aspect=float(params.get("aspect", 1.0)),
                camera=params.get("camera") or {},
            )
        except ValueError as exc:
            # A click on empty background is an ordinary miss, not a failure.
            raise SidecarError("pick-miss", str(exc), {"view": view}) from None
        x, y, z = hit["mm"]
        origin = str(params.get("origin") or "ui")
        action = str(params.get("action") or "crosshair")
        if action == "seed" and self.session.state.grid is not None:
            i, j, k = self.session.state.grid.mm_to_ijk((x, y, z))
            seed = self.session.state.grid.clamp((round(i), round(j), round(k)))
            self.execute(f"SET_SEED {seed[0]} {seed[1]} {seed[2]}", origin)
        else:
            self.execute(f"SET_XYZ {x:.5f} {y:.5f} {z:.5f}", origin)
        self.execute(f"SELECT_SURFACE_VERTEX {hit['hemi']} {hit['vertex']}", origin)
        return {"state": self.snapshot(), **hit}

    def series(self, params: dict) -> dict:
        self.ensure_session()
        assert self.session is not None
        view = str(params.get("view") or "")
        vp = self.session.state.viewports.find(view)
        if vp is None:
            raise SidecarError("not-found", f"no viewport {view!r}", {"view": view})
        payload = series_ops.series_payload(self.session, vp)
        payload["rev"] = int(self.meta["rev"])
        return payload

    # -- data picker ---------------------------------------------------
    def browse(self, params: dict) -> dict:
        """List one directory for the dataset picker.

        Runs in the sidecar (the process that reads the data), so the browser can
        browse the same filesystem the FFS loaders see without uploading bytes.
        Directories that look like FreeSurfer subjects are marked so the picker can
        offer ``LOAD_SURFACES``.
        """
        raw = params.get("path")
        if raw:
            base = Path(str(raw)).expanduser()
            if not base.is_absolute():
                base = self.project_root / base
        else:
            demo = self.project_root / "data" / "demo"
            base = demo if demo.is_dir() else (self.project_root / "data")
            if not base.exists():
                base = self.project_root
        try:
            base = base.resolve()
        except OSError:
            raise SidecarError("not-found", f"cannot resolve {raw!r}") from None
        if base.is_file():
            base = base.parent
        if not base.is_dir():
            raise SidecarError("not-found", f"not a directory: {base}", {"path": str(base)})
        supported = tuple(SUFFIXES) + tuple(SURFACE_SUFFIXES)
        entries = []
        try:
            children = sorted(base.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))
        except OSError as exc:
            raise SidecarError("browse-failed", str(exc), {"path": str(base)}) from None
        for child in children:
            if child.name.startswith("."):
                continue
            try:
                if child.is_dir():
                    is_subject = any(
                        (child / "surf" / f"{hemi}.white").exists() for hemi in ("lh", "rh")
                    )
                    entries.append({
                        "name": child.name,
                        "path": str(child),
                        "kind": "dir",
                        "subject": bool(is_subject),
                    })
                elif child.is_file():
                    lowered = child.name.lower()
                    suffix = next((item for item in supported if lowered.endswith(item.lower())), None)
                    if suffix is None:
                        continue
                    entries.append({
                        "name": child.name,
                        "path": str(child),
                        "kind": "file",
                        "size": int(child.stat().st_size),
                        "suffix": suffix,
                    })
            except OSError:
                continue
        return {
            "path": str(base),
            "parent": None if base.parent == base else str(base.parent),
            "subject": any((base / "surf" / f"{hemi}.white").exists() for hemi in ("lh", "rh")),
            "entries": entries,
            "shortcuts": self._browse_shortcuts(),
        }

    def _browse_shortcuts(self) -> list[dict]:
        out = [{"label": "Project", "path": str(self.project_root)}]
        demo = self.project_root / "data" / "demo"
        if demo.exists():
            out.append({"label": "Demo data", "path": str(demo)})
        try:
            home = Path.home()
            out.append({"label": "Home", "path": str(home)})
        except Exception:
            pass
        return out

    def load_paths(self, params: dict) -> dict:
        """Load datasets and/or a FreeSurfer subject into the running viewer.

        One operation for the picker and the ``ffs_viewer_load`` agent tool: every
        path is validated and then dispatched as the same validated ``LOAD`` /
        ``LOAD_SURFACES`` command the command bar uses.
        """
        self.ensure_session()
        assert self.session is not None
        paths = [str(item) for item in (params.get("paths") or []) if str(item).strip()]
        subject = params.get("subject")
        subject = str(subject) if subject else None
        if not paths and not subject:
            raise SidecarError("invalid", "load_paths needs paths or a subject directory")
        if len(paths) > 64:
            raise SidecarError("invalid", "too many files in one load (max 64)")
        origin = str(params.get("origin") or "ui")
        before = {layer.key for layer in self.session.state.layers.layers}
        for raw in paths:
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = self.project_root / path
            try:
                path = path.resolve()
            except OSError:
                raise SidecarError("not-found", f"cannot resolve {raw!r}") from None
            if not path.is_file():
                raise SidecarError("not-found", f"no such dataset: {path}", {"path": str(path)})
            self.execute(f"LOAD {_quote(path)}", origin)
        if subject:
            subject_path = Path(subject).expanduser()
            if not subject_path.is_absolute():
                subject_path = self.project_root / subject_path
            subject_path = subject_path.resolve()
            if not any((subject_path / "surf" / f"{hemi}.white").exists() for hemi in ("lh", "rh")):
                raise SidecarError(
                    "not-subject",
                    f"{subject_path} has no surf/lh.white or surf/rh.white",
                    {"path": str(subject_path)},
                )
            self.execute(f"LOAD_SURFACES {_quote(subject_path)} lh,rh", origin)
        if not len(self.session.state.viewports):
            for plane, vid in (("axial", "V1"), ("sagittal", "V2"), ("coronal", "V3")):
                self.execute(f"OPEN_VIEW {vid} image {plane}", origin)
            self.execute("OPEN_VIEW G1 graph", origin)
            self.execute("SET_VIEW_GRID G1 1", origin)
            if subject:
                self.execute("OPEN_VIEW S1 surface", origin)
        layers = [layer for layer in self.session.state.layers.layers if layer.key not in before]
        if layers:
            self.execute(f"SELECT_LAYER {layers[-1].key}", origin)
        self._await_resident()
        return {
            "state": self.snapshot(),
            "loaded": [layer.key for layer in layers],
            "subject": str(subject) if subject else None,
        }

    # -- sources: folders, catalog, subjects ---------------------------
    SOURCES_FILE = "sources.json"

    def _sources_data(self) -> dict:
        if self._sources is not None:
            return self._sources
        path = self.state_dir / self.SOURCES_FILE
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = {}
        folders = []
        for item in data.get("folders") or []:
            if isinstance(item, dict) and isinstance(item.get("path"), str):
                folders.append({"path": item["path"], "recursive": bool(item.get("recursive"))})
            elif isinstance(item, str):
                folders.append({"path": item, "recursive": False})
        subjects = [item for item in (data.get("subjects") or []) if isinstance(item, str)]
        self._sources = {"folders": folders, "subjects": subjects}
        return self._sources

    def _save_sources(self) -> None:
        data = self._sources_data()
        path = self.state_dir / self.SOURCES_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, path)

    def _catalog_payload(self) -> dict:
        assert self.session is not None
        entries = []
        for entry in self.session.catalog:
            entries.append({
                "path": str(entry.path),
                "name": entry.name,
                "kind": entry.kind.value,
                "shape": [int(v) for v in entry.shape],
                "nVolumes": int(entry.n_volumes),
                "tr": float(entry.tr),
                "labels": [str(item) for item in entry.labels],
                "summary": entry.summary,
                "bytes": int(entry.file_bytes),
            })
        order = {"anat": 0, "func": 1, "stats": 2, "mask": 3, "other": 4}
        entries.sort(key=lambda item: (order.get(item["kind"], 9), item["name"].lower()))
        return {
            "path": None if self.session.catalog_dir is None else str(self.session.catalog_dir),
            "recursive": bool(self.session.catalog_recursive),
            "files": [str(item) for item in self.session.file_list] if self.session.reading_files else None,
            "entries": entries,
        }

    def _sources_payload(self) -> dict:
        data = self._sources_data()
        folders = []
        for item in data["folders"]:
            folder = Path(item["path"])
            folders.append({
                "path": item["path"],
                "recursive": bool(item["recursive"]),
                "exists": folder.is_dir(),
                "name": folder.name or item["path"],
            })
        subjects = []
        for raw in data["subjects"]:
            subject = Path(raw)
            subjects.append({
                "path": raw,
                "exists": subject.is_dir(),
                "name": subject.name or raw,
                "valid": any(
                    (subject / "surf" / f"{hemi}.white").exists()
                    for hemi in ("lh", "rh")
                ),
            })
        return {"folders": folders, "subjects": subjects, "catalog": self._catalog_payload()}

    def sources(self, params: dict) -> dict:
        self.ensure_session()
        return self._sources_payload()

    def _resolve_dir(self, raw: str) -> Path:
        path = Path(str(raw)).expanduser()
        if not path.is_absolute():
            path = self.project_root / path
        try:
            path = path.resolve()
        except OSError:
            raise SidecarError("not-found", f"cannot resolve {raw!r}") from None
        if not path.is_dir():
            raise SidecarError("not-found", f"not a directory: {path}", {"path": str(path)})
        return path

    def add_folder(self, params: dict) -> dict:
        self.ensure_session()
        path = self._resolve_dir(str(params.get("path") or ""))
        recursive = bool(params.get("recursive", False))
        self.session.read_directory(path, recursive=recursive)
        data = self._sources_data()
        data["folders"] = [item for item in data["folders"] if Path(item["path"]) != path]
        data["folders"].append({"path": str(path), "recursive": recursive})
        self._save_sources()
        return {"sources": self._sources_payload(), "catalog": self._catalog_payload()}

    def remove_folder(self, params: dict) -> dict:
        self.ensure_session()
        raw = str(params.get("path") or "")
        path = Path(raw).expanduser().resolve()
        data = self._sources_data()
        data["folders"] = [item for item in data["folders"] if Path(item["path"]) != path]
        self._save_sources()
        if self.session.catalog_dir is not None and self.session.catalog_dir == path:
            self.session.catalog = []
            self.session.catalog_dir = None
        return {"sources": self._sources_payload(), "catalog": self._catalog_payload()}

    def read_folder(self, params: dict) -> dict:
        self.ensure_session()
        path = self._resolve_dir(str(params.get("path") or ""))
        data = self._sources_data()
        recursive = params.get("recursive")
        if recursive is None:
            recursive = next(
                (item["recursive"] for item in data["folders"] if Path(item["path"]) == path),
                False,
            )
        recursive = bool(recursive)
        self.session.read_directory(path, recursive=recursive)
        data["folders"] = [item for item in data["folders"] if Path(item["path"]) != path]
        data["folders"].append({"path": str(path), "recursive": recursive})
        self._save_sources()
        return {"sources": self._sources_payload(), "catalog": self._catalog_payload()}

    def add_files(self, params: dict) -> dict:
        self.ensure_session()
        paths = [str(item) for item in (params.get("paths") or []) if str(item).strip()]
        if not paths:
            raise SidecarError("invalid", "add_files needs paths")
        resolved = []
        for raw in paths:
            path = Path(raw).expanduser()
            if not path.is_absolute():
                path = self.project_root / path
            path = path.resolve()
            if not path.is_file():
                raise SidecarError("not-found", f"no such file: {path}", {"path": str(path)})
            resolved.append(str(path))
        self.session.read_files(resolved)
        return {"sources": self._sources_payload(), "catalog": self._catalog_payload()}

    def _resolve_file(self, raw: str) -> Path:
        path = Path(str(raw)).expanduser()
        if not path.is_absolute():
            path = self.project_root / path
        try:
            path = path.resolve()
        except OSError:
            raise SidecarError("not-found", f"cannot resolve {raw!r}") from None
        if not path.is_file():
            raise SidecarError("not-found", f"no such dataset: {path}", {"path": str(path)})
        return path

    def preview(self, params: dict) -> dict:
        self.ensure_session()
        path = self._resolve_file(str(params.get("path") or ""))
        self.session.preview(path)
        # The preview layer is unrecorded, so the bus does not bump the revision.
        # Bump it here or clients keep their cached slice/surface tokens and the
        # preview never paints.
        self.meta["commandCount"] += 1
        self._bump("display", "ui")
        return {"state": self.snapshot(), "preview": str(path)}

    def clear_preview(self, params: dict) -> dict:
        self.ensure_session()
        had = self.session.preview_path is not None
        self.session.preview(None)
        if had:
            self.meta["commandCount"] += 1
            self._bump("display", "ui")
        return {"state": self.snapshot()}

    def load_entry(self, params: dict) -> dict:
        self.ensure_session()
        path = self._resolve_file(str(params.get("path") or ""))
        origin = str(params.get("origin") or "ui")
        preview = self.session.preview_path
        if preview is not None and Path(preview) == path:
            key = self.session.commit_preview()
            if key is None:
                raise SidecarError("load-failed", f"could not commit preview for {path}")
            # Recording the preview does not itself advance the harness revision.
            self.meta["commandCount"] += 1
            self._bump("display", "ui")
        else:
            self.session.preview(None)
            self.execute(f"LOAD {_quote(path)}", origin)
            key = self.session.state.layers.layers[-1].key
        self.execute(f"SELECT_LAYER {key}", origin)
        self._await_resident()
        return {"state": self.snapshot(), "key": key}

    def add_subject(self, params: dict) -> dict:
        self.ensure_session()
        path = self._resolve_dir(str(params.get("path") or ""))
        if not any((path / "surf" / f"{hemi}.white").exists() for hemi in ("lh", "rh")):
            raise SidecarError(
                "not-subject",
                f"{path} has no surf/lh.white or surf/rh.white",
                {"path": str(path)},
            )
        self.execute(f"LOAD_SURFACES {_quote(path)} lh,rh", str(params.get("origin") or "ui"))
        if not any(vp.kind.value == "surface" for vp in self.session.state.viewports):
            self.execute("OPEN_VIEW S1 surface", str(params.get("origin") or "ui"))
        data = self._sources_data()
        if str(path) not in data["subjects"]:
            data["subjects"].append(str(path))
            self._save_sources()
        return {"state": self.snapshot(), "sources": self._sources_payload()}

    def remove_subject(self, params: dict) -> dict:
        self.ensure_session()
        raw = str(params.get("path") or "")
        path = Path(raw).expanduser().resolve()
        data = self._sources_data()
        data["subjects"] = [item for item in data["subjects"] if Path(item) != path]
        self._save_sources()
        return {"sources": self._sources_payload()}

    # -- workspace / persistence --------------------------------------
    def workspace(self, params: dict) -> dict:
        self.ensure_session()
        assert self.session is not None
        layout = params.get("layout")
        if layout is not None:
            if not isinstance(layout, dict):
                raise SidecarError("invalid", "workspace layout must be an object")
            self.meta["workspace"] = layout
            self.meta["revByCategory"].setdefault("layout", 0)
            self.meta["revByCategory"]["layout"] += 1
            self.meta["rev"] += 1
            persist.save_workspace(self.state_dir, layout)
        elif self.meta["workspace"] is None:
            saved = persist.load_workspace(self.state_dir)
            self.meta["workspace"] = saved or persist.default_workspace(self.session)
        return {"layout": self.meta["workspace"], "rev": int(self.meta["rev"])}

    def save(self, note: str | None) -> dict:
        self.ensure_session()
        assert self.session is not None
        if self.meta["workspace"] is None:
            self.meta["workspace"] = persist.default_workspace(self.session)
        result = persist.save_state(
            self.session,
            state_dir=self.state_dir,
            command_log=self.command_log,
            workspace=self.meta["workspace"],
            note=note,
        )
        self.meta["lastSavedAt"] = result["manifest"]["savedAt"]
        for category in CATEGORIES:
            self.meta["dirty"][category] = False
        self.meta["lastSaveRev"] = self.meta["commandCount"]
        self.meta["lastSaveAtRev"] = self.meta["rev"]
        return {"saved": True, **result}

    def restore(self) -> dict:
        self.session = None
        self.command_log = []
        self.meta = self._fresh_meta()
        self.ensure_session()
        result = persist.restore_state(self.session, self.state_dir)
        if result.get("restored"):
            self.command_log = result.pop("log", [])
            self.meta["workspace"] = result.get("workspace") or persist.default_workspace(self.session)
            self.meta["rev"] = 1
            self._await_resident()
        return {"state": self.snapshot(), **{k: v for k, v in result.items() if k != "log"}}

    def show(self, params: dict) -> dict:
        self.meta["showTarget"] = params.get("target")
        self.meta["showSeq"] = int(self.meta.get("showSeq", 0)) + 1
        self.meta["rev"] += 1
        self.meta["revByCategory"].setdefault("layout", 0)
        self.meta["revByCategory"]["layout"] += 1
        return {"showSeq": self.meta["showSeq"], "target": params.get("target")}

    def shutdown(self) -> dict:
        saved = None
        if self.session is not None and any(self.meta["dirty"].values()):
            try:
                saved = self.save("shutdown")
            except Exception:
                traceback.print_exc(file=sys.stderr)
        if self.session is not None:
            try:
                self.session.close()
            except Exception:
                pass
        return {"ok": True, "saved": saved is not None}

    # -- dispatch ------------------------------------------------------
    def handle(self, message: dict) -> dict:
        request_id = message.get("id")
        method = str(message.get("method") or "")
        params = message.get("params") or {}
        try:
            if method == "hello":
                result = self.hello()
            elif method == "open":
                result = self.open(params)
            elif method == "execute":
                result = self.execute(str(params.get("line", "")), str(params.get("origin") or "ui"))
            elif method == "execute_batch":
                result = self.execute_batch(list(params.get("lines") or []), str(params.get("origin") or "ui"))
            elif method == "state":
                result = self.snapshot()
            elif method == "render":
                result = self.render(
                    str(params.get("view") or ""),
                    params.get("outlineToken") if isinstance(params.get("outlineToken"), str) else None,
                )
            elif method == "pick":
                result = self.pick(params)
            elif method == "pan":
                result = self.pan(params)
            elif method == "zoom":
                result = self.zoom(params)
            elif method == "step":
                result = self.step(params)
            elif method == "surface":
                result = self.surface(params)
            elif method == "surface_pick":
                result = self.surface_pick(params)
            elif method == "series":
                result = self.series(params)
            elif method == "browse":
                result = self.browse(params)
            elif method == "load_paths":
                result = self.load_paths(params)
            elif method == "sources":
                result = self.sources(params)
            elif method == "add_folder":
                result = self.add_folder(params)
            elif method == "remove_folder":
                result = self.remove_folder(params)
            elif method == "read_folder":
                result = self.read_folder(params)
            elif method == "add_files":
                result = self.add_files(params)
            elif method == "preview":
                result = self.preview(params)
            elif method == "auto_range":
                result = self.auto_range(params)
            elif method == "colorbar":
                result = self.colorbar(params)
            elif method == "clear_preview":
                result = self.clear_preview(params)
            elif method == "load_entry":
                result = self.load_entry(params)
            elif method == "add_subject":
                result = self.add_subject(params)
            elif method == "remove_subject":
                result = self.remove_subject(params)
            elif method == "workspace":
                result = self.workspace(params)
            elif method == "save":
                result = self.save(params.get("note"))
            elif method == "restore":
                result = self.restore()
            elif method == "show":
                result = self.show(params)
            elif method == "commands":
                result = self.commands()
            elif method == "shutdown":
                result = self.shutdown()
            else:
                raise SidecarError("unknown-method", f"unknown method {method!r}")
            return {"id": request_id, "ok": True, "result": result}
        except SidecarError as exc:
            return _error(request_id, exc.code, str(exc), exc.details)
        except FileNotFoundError as exc:
            return _error(request_id, "missing-file", str(exc), {})
        except Exception as exc:  # noqa: BLE001 - the loop must stay alive
            traceback.print_exc(file=sys.stderr)
            return _error(
                request_id,
                "internal",
                str(exc),
                {"trace": traceback.format_exc(limit=4)[-2000:]},
            )


# -- helpers ------------------------------------------------------------------


def _hash(value) -> str:
    return hashlib.md5(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()[:16]


def _error(request_id, code: str, message: str, details: dict) -> dict:
    return {
        "id": request_id,
        "ok": False,
        "error": {"code": code, "message": message, "details": details or {}},
    }


def _quote(path) -> str:
    text = str(path)
    if not any(ch in text for ch in " \t'\""):
        return text
    return '"' + text.replace('"', '\\"') + '"'


def _crosshair_mm(session) -> list[float] | None:
    mm = session.state.crosshair_mm
    return None if mm is None else [float(v) for v in mm]


def _vp_signature(vp) -> list:
    fields = (
        "plane", "locked", "position", "zoom", "pan", "tilt", "solo", "tiles", "strip",
        "strip_step", "strip_zoom", "grid_n", "traces", "hidden", "shared_scale", "tint",
        "detrend", "scaling", "order", "matrix_order", "rois", "panel", "shape", "depth",
        "samples", "hemis", "split", "hinge", "equivolume", "depth_stat", "vertex_map",
        "folding", "profile_mode", "profile_score", "tube", "depth_source", "radius",
    )
    out = []
    for name in fields:
        value = getattr(vp, name)
        if isinstance(value, tuple):
            out.append(tuple(round(float(v), 6) for v in value) if all(_num(v) for v in value) else value)
        else:
            out.append(value)
    return out


def _num(value) -> bool:
    return isinstance(value, (int, float, np.integer, np.floating))


def _outline_payload(outlines, span) -> list[dict]:
    out = []
    rows, cols = max(1, int(span[0])), max(1, int(span[1]))
    for outline in outlines:
        segments = np.asarray(outline.segments, np.float32)
        if segments.size == 0:
            continue
        normalised = segments / np.array([rows, cols], np.float32)
        flat = normalised.reshape(-1).astype("<f4")
        out.append({
            "hemi": outline.hemi,
            "surface": outline.surface,
            "rgb": [float(c) for c in outline.rgb],
            "segments": base64.b64encode(flat.tobytes()).decode("ascii"),
            "count": int(segments.shape[0]),
        })
    return out


def _ffs_version() -> str:
    try:
        import fastfuncstuff

        return getattr(fastfuncstuff, "__version__", "unknown")
    except Exception:
        return "unknown"


def _category_counts() -> dict[str, int]:
    counts = {category: 0 for category in CATEGORIES}
    for name in ffs_commands.registered_names():
        counts[category_of(name)] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="FFS Harness viewer sidecar")
    parser.add_argument("--project-root", default=str(ROOT))
    parser.add_argument("--state-dir", default=str(ROOT / ".ffs-viewer"))
    parser.add_argument("--no-autosave", action="store_true")
    args = parser.parse_args(argv)
    sidecar = Sidecar(
        Path(args.project_root),
        Path(args.state_dir),
        autosave=not args.no_autosave,
    )
    _serve(sidecar)
    return 0


def _serve(sidecar: Sidecar) -> None:
    stdin = sys.stdin
    stdout = sys.stdout
    print(f"[ffs-viewer] sidecar {VERSION} ready", file=sys.stderr, flush=True)
    for raw in stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            message = json.loads(raw)
        except ValueError as exc:
            stdout.write(json.dumps(_error(None, "bad-json", str(exc), {})) + "\n")
            stdout.flush()
            continue
        if not isinstance(message, dict):
            stdout.write(json.dumps(_error(None, "bad-json", "message must be an object", {})) + "\n")
            stdout.flush()
            continue
        response = sidecar.handle(message)
        stdout.write(json.dumps(response, separators=(",", ":"), default=str) + "\n")
        stdout.flush()
        if message.get("method") == "shutdown":
            break


if __name__ == "__main__":
    raise SystemExit(main())
