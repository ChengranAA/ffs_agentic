"""Reference computations from the original FFS viewer, run in-process.

This module is deliberately built from the *reference* package
(``reference/fastfuncstuff``) only:

* ``ViewerSession`` + the FFS command bus replay the same command lines the
  sidecar is sent, giving an independent authoritative state;
* ``viewer.slicing.PlaneView`` reconstructs the crop/flip/zoom mapping;
* ``viewer.compose.render_viewport`` renders a plane;
* ``surface3d`` / ``surface.profiles`` / ``surfacelayers`` recompute surface
  geometry, per-vertex values and colours.

It also contains the independent copies of the small compositions the sidecar's
wrappers perform (world-space mesh placement, the surface-pick ray, the
depth-sampling pipeline), written from the reference viewer's own code paths
rather than imported from ``python/ffsviewer``.
"""

from __future__ import annotations

import dataclasses
import re
import sys
import time
from enum import Enum
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _candidate in (str(ROOT / "python"), str(ROOT / "reference" / "fastfuncstuff")):
    if _candidate not in sys.path:
        sys.path.insert(0, _candidate)

import numpy as np  # noqa: E402
import torch  # noqa: E402

from fastfuncstuff.surface import profiles as surface_profiles  # noqa: E402
from fastfuncstuff.viewer import commands as ffs_commands  # noqa: E402
from fastfuncstuff.viewer import compose, surface3d, surfacelayers  # noqa: E402
from fastfuncstuff.viewer.session import ViewerSession  # noqa: E402
from fastfuncstuff.viewer.slicing import PlaneView, plane_layout  # noqa: E402
from fastfuncstuff.viewer.state import Plane  # noqa: E402
from fastfuncstuff.viewer.viewports import Viewport as _Viewport  # noqa: E402

#: The authoritative FFS viewport fields. The sidecar snapshot legitimately
#: adds harness-only control fields on top (``fixedAxis``/``positionMax`` are
#: derived from the grid so the browser's parked-slice slider knows its range);
#: those are not FFS state and are verified separately against ``plane_layout``.
VIEWPORT_FIELDS = tuple(f.name for f in dataclasses.fields(_Viewport))

#: The demo session, as documented in docs/API.md and data/demo/README.md.
#: Both the sidecar and the reference run exactly these lines, so any
#: difference that shows up later comes from the command/state plumbing, not
#: from the two sessions being given different data.
def demo_script(root: Path = ROOT) -> list[str]:
    demo = root / "data" / "demo"
    subject = demo / "subject"
    return [
        "SET_THEME dark",
        f"LOAD {demo / 'anat.nii.gz'} A",
        f"LOAD {demo / 'func.nii.gz'} F",
        "SET_COLORMAP F hot",
        "SET_LAYER_VISIBLE F 0",
        f"LOAD {demo / 'stats.nii.gz'} S",
        "SET_COLORMAP S redblue",
        "SET_SIGN S both",
        "SET_ALPHA S linear",
        "SET_BOXED S 1",
        "SET_THRESHOLD S 2.5",
        "SET_RANGE S -6 6",
        "SET_RANGE_MIRROR S 1",
        "SELECT_LAYER S",
        f"LOAD_SURFACES {subject} lh,rh",
        "SHOW_SURFACES white,pial",
        "OPEN_VIEW V1 image axial",
        "OPEN_VIEW V2 image sagittal",
        "OPEN_VIEW V3 image coronal",
        "OPEN_VIEW S1 surface",
        "SET_SURFACE_SHAPE S1 inflated",
        "SET_SURFACE_DEPTH S1 0.5 0.5 1",
        "SET_SURFACE_FOLDING S1 curv",
        "OPEN_VIEW G1 graph",
        "SET_VIEW_GRID G1 2",
    ]


class RefSession:
    """A reference ``ViewerSession`` driven by the same command lines."""

    def __init__(self, script: list[str] | None = None, *, device: str = "cpu") -> None:
        self.session = ViewerSession(device=torch.device(device))
        self._started = time.monotonic()
        if script:
            self.run(script)
            self.wait_resident()

    # -- driving -------------------------------------------------------
    def do(self, line: str):
        return self.session.do(ffs_commands.parse_line(line))

    def run(self, lines: list[str]) -> None:
        for line in lines:
            self.do(line)

    def wait_resident(self, timeout: float = 120.0) -> None:
        """Block until every multi-volume layer's full array is resident.

        The sidecar's ``execute`` does the same before returning from a LOAD,
        so both sessions are compared when fully loaded.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            pending = []
            for layer in self.session.state.layers.layers:
                if layer.n_volumes <= 1:
                    continue
                try:
                    if self.session.store.get(layer.key).array is None:
                        pending.append(layer.key)
                except Exception:  # noqa: BLE001 - missing layer
                    pending.append(layer.key)
            if not pending:
                return
            time.sleep(0.02)
        raise TimeoutError(f"reference layers never became resident: {pending}")

    @property
    def state(self):
        return self.session.state

    def close(self) -> None:
        try:
            self.session.close()
        except Exception:  # noqa: BLE001 - best effort
            pass

    def __enter__(self) -> "RefSession":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


# -- JSON-ish normalisation -------------------------------------------


def plain(value):
    """Make reference values comparable to the sidecar's JSON snapshot."""
    if isinstance(value, np.ndarray):
        return np.round(np.asarray(value, np.float64), 8).tolist()
    if isinstance(value, np.generic):
        item = value.item()
        return round(float(item), 8) if isinstance(item, float) else item
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (tuple, list)):
        return [plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): plain(v) for k, v in value.items()}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: plain(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, float):
        return round(value, 8)
    return value


def camel_to_snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


#: Layer fields the sidecar's snapshot exposes (see python/ffsviewer/snapshot.py).
LAYER_FIELDS = (
    "key", "name", "path", "shape", "n_volumes", "affine", "visible", "opacity",
    "colormap", "colormap_reversed", "range_lo", "range_hi", "range_mirror",
    "range_fixed", "threshold", "threshold_index", "threshold_follow",
    "threshold_p", "alpha_mode", "boxed", "edges", "sign_mode", "n_panes",
    "volume_index", "time_linked", "roi", "integer_labels", "source", "labels",
    "time_detrend", "time_psc", "resample", "colour", "follows",
)


def _clean_scalar(value):
    if isinstance(value, np.ndarray):
        return np.round(np.asarray(value, np.float64), 8).tolist()
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, float):
        return round(value, 8)
    if isinstance(value, (tuple, list)):
        return [_clean_scalar(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _clean_scalar(v) for k, v in value.items()}
    return value


def _sidecar_layers(snapshot: dict) -> dict:
    out = {}
    for layer in snapshot.get("layers", []):
        record = {}
        for camel in [
            "key", "name", "path", "shape", "nVolumes", "affine", "visible",
            "opacity", "colormap", "colormapReversed", "rangeLo", "rangeHi",
            "rangeMirror", "rangeFixed", "threshold", "thresholdIndex",
            "thresholdFollow", "thresholdP", "alphaMode", "boxed", "edges",
            "signMode", "nPanes", "volumeIndex", "timeLinked", "roi",
            "integerLabels", "source", "labels", "timeDetrend", "timePsc",
            "resample", "colour", "follows",
        ]:
            if camel in layer:
                record[camel_to_snake(camel)] = _clean_scalar(layer[camel])
        out[str(layer["key"])] = record
    return out


def _ref_layers(state) -> dict:
    out = {}
    for layer in state.layers.layers:
        out[layer.key] = {name: _clean_scalar(getattr(layer, name)) for name in LAYER_FIELDS}
    return out


def _sidecar_viewports(snapshot: dict) -> dict:
    out = {}
    for vp in snapshot.get("viewports", []):
        record = {}
        for camel, value in vp.items():
            name = camel_to_snake(camel)
            if name in VIEWPORT_FIELDS:
                record[name] = _clean_scalar(value)
        out[str(vp["id"])] = record
    return out


def sidecar_viewport_extras(snapshot: dict) -> dict:
    """Harness-only per-viewport fields: ``{view: (fixed_axis, position_max)}``."""
    out = {}
    for vp in snapshot.get("viewports", []):
        if "fixedAxis" in vp or "positionMax" in vp:
            out[str(vp["id"])] = (vp.get("fixedAxis"), vp.get("positionMax"))
    return out


def _ref_viewports(state) -> dict:
    out = {}
    for vp in state.viewports:
        out[vp.id] = {f.name: _clean_scalar(getattr(vp, f.name)) for f in dataclasses.fields(vp)}
    return out


def _sidecar_readout(snapshot: dict) -> dict:
    readout = snapshot.get("readout") or {}
    return {"lines": [str(s) for s in readout.get("lines", [])], "brick": readout.get("brick")}


def _ref_readout(session) -> dict:
    try:
        lines = [str(s) for s in session.overlay_readout()]
    except Exception as exc:  # noqa: BLE001 - mirror the sidecar's defensive wrapping
        lines = [f"readout unavailable: {exc}"]
    brick = None
    selected = session.state.selected
    if selected is not None and session.state.layers.find(selected) is not None:
        try:
            brick = session.brick_caption(selected)
        except Exception:  # noqa: BLE001
            brick = None
    return {"lines": lines, "brick": brick}


def _grid_sidecar(snapshot: dict):
    grid = snapshot.get("grid")
    if not grid:
        return None
    return {
        "shape": [int(v) for v in grid["shape"]],
        "affine": np.round(np.asarray(grid["affine"], np.float64), 8).tolist(),
    }


def _grid_ref(state):
    if state.grid is None:
        return None
    return {
        "shape": [int(v) for v in state.grid.shape],
        "affine": np.round(np.asarray(state.grid.affine, np.float64), 8).tolist(),
    }


def semantic_snapshot_from_sidecar(snapshot: dict, *, include_selection: bool = True) -> dict:
    """The parts of the sidecar snapshot every check compares, in snake_case.

    ``include_selection=False`` drops ``surfaces.selected``: a sidecar-side
    ``surface_pick`` sets it without replaying an equivalent command into the
    reference session, so it is verified by the dedicated picking/selection
    checks instead of by state projection.
    """
    loading = bool(snapshot.get("loading"))
    surfaces = snapshot.get("surfaces") or {}
    surface_record = {
        "subject": None if surfaces.get("subject") is None else str(surfaces.get("subject")),
        "shown": [str(s) for s in surfaces.get("shown", [])],
        "outlineWidth": round(float(surfaces.get("outlineWidth", 0.0)), 8),
        "loaded": sorted(str(s) for s in surfaces.get("loaded", [])),
    }
    if include_selection:
        surface_record["selected"] = (
            None
            if surfaces.get("selected") is None
            else [str(surfaces["selected"][0]), int(surfaces["selected"][1])]
        )
    return {
        "grid": _grid_sidecar(snapshot),
        "crosshair": [int(v) for v in snapshot.get("crosshair", [])],
        "crosshairMm": (
            None
            if snapshot.get("crosshairMm") is None
            else [round(float(v), 8) for v in snapshot["crosshairMm"]]
        ),
        "timeIndex": int(snapshot.get("timeIndex", 0)),
        "maxTimeIndex": int(snapshot.get("maxTimeIndex", 0)),
        "selected": snapshot.get("selected"),
        "inputKey": snapshot.get("inputKey"),
        "theme": snapshot.get("theme"),
        "loading": loading,
        "layers": _sidecar_layers(snapshot),
        "viewports": _sidecar_viewports(snapshot),
        "surfaces": surface_record,
        "mode": {"name": (snapshot.get("mode") or {}).get("name")},
        "readout": _sidecar_readout(snapshot),
        "sources": [
            {"path": str(e.get("path")), "key": str(e.get("key")), "name": str(e.get("name"))}
            for e in snapshot.get("sources", [])
        ],
    }


def semantic_snapshot_from_ref(session, *, include_selection: bool = True) -> dict:
    st = session.state
    try:
        loading = bool(
            any(
                layer.n_volumes > 1 and session.store.get(layer.key).array is None
                for layer in st.layers.layers
            )
        )
    except Exception:  # noqa: BLE001
        loading = False
    surfaces = {
        "subject": None if session.surfaces.subject is None else str(session.surfaces.subject),
        "shown": [str(s) for s in st.surfaces_shown],
        "outlineWidth": round(float(st.surface_outline_width), 8),
        "loaded": sorted(str(h) for h in session.surfaces.hemis),
    }
    if include_selection:
        surfaces["selected"] = (
            None
            if st.surface_selected is None
            else [str(st.surface_selected[0]), int(st.surface_selected[1])]
        )
    selected = st.selected
    if selected is None and len(st.layers):
        selected = st.layers.layers[-1].key
    sources = []
    seen = set()
    for layer in st.layers.layers:
        if layer.source == "file" and layer.path not in seen:
            seen.add(layer.path)
            sources.append({"path": str(layer.path), "key": str(layer.key), "name": str(layer.name)})
    return {
        "grid": _grid_ref(st),
        "crosshair": [int(v) for v in st.crosshair],
        "crosshairMm": (
            None if st.crosshair_mm is None else [round(float(v), 8) for v in st.crosshair_mm]
        ),
        "timeIndex": int(st.time_index),
        "maxTimeIndex": int(st.max_time_index()),
        "selected": selected,
        "inputKey": st.input_key,
        "theme": st.theme,
        "loading": loading,
        "layers": _ref_layers(st),
        "viewports": _ref_viewports(st),
        "surfaces": surfaces,
        "mode": {"name": session.mode.name},
        "readout": _ref_readout(session),
        "sources": sources,
    }


def compare_semantic(a: dict, b: dict) -> list[tuple[str, object, object]]:
    """Field-by-field diff of two semantic snapshots (``[]`` means identical)."""
    diffs: list[tuple[str, object, object]] = []

    def walk(path: str, left, right) -> None:
        if isinstance(left, dict) and isinstance(right, dict):
            for key in sorted(set(left) | set(right)):
                if key not in left:
                    diffs.append((f"{path}.{key}", "<absent>", right[key]))
                elif key not in right:
                    diffs.append((f"{path}.{key}", left[key], "<absent>"))
                else:
                    walk(f"{path}.{key}", left[key], right[key])
        elif isinstance(left, list) and isinstance(right, list):
            if len(left) != len(right):
                diffs.append((f"{path}.length", len(left), len(right)))
                return
            for i, (lvalue, rvalue) in enumerate(zip(left, right)):
                walk(f"{path}[{i}]", lvalue, rvalue)
        elif left != right:
            diffs.append((path, left, right))

    walk("", a, b)
    return diffs


# -- coordinate mapping -------------------------------------------------


def plane_view_from_state(state, viewport) -> PlaneView:
    """Reconstruct the reference ``PlaneView`` from an authoritative state."""
    return PlaneView(
        layout=plane_layout(state.grid.affine, viewport.plane),
        shape=tuple(int(v) for v in state.grid.shape),
        zoom=float(viewport.zoom),
        pan=(float(viewport.pan[0]), float(viewport.pan[1])),
    )


def plane_view_from_snapshot(snapshot: dict, view: str) -> PlaneView:
    """Reconstruct ``PlaneView`` from the *sidecar's own reported* state.

    Uses only the snapshot's grid affine/shape and the viewport's plane, zoom
    and pan, so it independently checks that the sidecar's click mapping equals
    what those reported numbers imply.
    """
    grid = snapshot.get("grid")
    if grid is None:
        raise ValueError("snapshot has no grid")
    viewport = next(v for v in snapshot["viewports"] if v["id"] == view)
    return PlaneView(
        layout=plane_layout(
            np.asarray(grid["affine"], np.float64),
            Plane(viewport["plane"]),
        ),
        shape=tuple(int(v) for v in grid["shape"]),
        zoom=float(viewport["zoom"]),
        pan=(float(viewport["pan"][0]), float(viewport["pan"][1])),
    )


def plane_view_from_ref(session, view: str) -> PlaneView:
    vp = session.state.viewports.find(view)
    if vp is None:
        raise KeyError(f"no reference viewport {view!r}")
    return plane_view_from_state(session.state, vp)


# -- surface geometry, picking, sampling --------------------------------


def surface_arrays(session, viewport):
    """Reference world-space geometry for one surface window.

    Mirrors the reference viewer's 3-D window: positions from
    ``surface3d.shape_positions``, the side-by-side layout from
    ``surface3d.layout_offsets``, and the per-hemisphere model from
    ``surface3d.hemisphere_models`` -- **pivoted on the laid-out positions**,
    exactly as ``viewer/ui/surfacewindow.py`` does (``_shape_arrays`` produces
    laid-out positions and ``_apply_layout`` passes those to
    ``hemisphere_models``). Hinge is forced to 0 for the flat shape, as that
    window does.

    Returns ``(world, faces, laid, models)``.
    """
    store = session.surfaces
    shape = viewport.shape
    raw: dict[str, np.ndarray] = {}
    faces: dict[str, np.ndarray] = {}
    for hemi in store.hemis:
        h = store.hemis[hemi]
        pos = surface3d.shape_positions(h, shape)
        if pos is None:
            pos = surface3d.shape_positions(h, "mid")
        if pos is None:  # pragma: no cover - demo always has white/pial
            raise ValueError(f"hemisphere {hemi} has no {shape!r} or 'mid' positions")
        raw[hemi] = np.asarray(pos, np.float32)
        faces[hemi] = np.asarray(surface3d.shape_faces(h, shape), np.uint32)
    offsets = surface3d.layout_offsets(raw, shape, faces)
    laid = {h: (raw[h] + offsets[h]).astype(np.float32) for h in raw}
    hinge = 0.0 if shape == "flat" else float(viewport.hinge)
    models = surface3d.hemisphere_models(laid, float(viewport.split), hinge)
    world = {}
    for hemi, p in laid.items():
        m = models[hemi]
        world[hemi] = np.asarray(
            p @ m[:3, :3].T.astype(np.float32) + m[:3, 3].astype(np.float32), np.float32
        )
    return world, faces, laid, models


def camera_dict(camera) -> dict:
    return {
        "rotation": np.asarray(camera.rotation, np.float64).reshape(3, 3).ravel().tolist(),
        "distance": float(camera.distance),
        "target": [float(v) for v in camera.target],
        "fovDeg": float(camera.fov_deg),
    }


def make_camera(
    *,
    rotation=None,
    distance: float = 350.0,
    target=(0.0, 0.0, 0.0),
    fov_deg: float = 30.0,
):
    cam = surface3d.Camera()
    if rotation is not None:
        cam.rotation = np.asarray(rotation, np.float64).reshape(3, 3)
    cam.distance = float(distance)
    cam.target = np.asarray(target, np.float64)
    cam.fov_deg = float(fov_deg)
    return cam


def rotation_from(orbit=(0.0, 0.0), roll: float = 0.0) -> np.ndarray:
    cam = surface3d.Camera()
    if any(orbit):
        cam.orbit(float(orbit[0]), float(orbit[1]))
    if roll:
        cam.roll(float(roll))
    return np.asarray(cam.rotation, np.float64)


def project_ndc(camera, points, aspect: float) -> tuple[np.ndarray, np.ndarray]:
    """World points to NDC (x, y) and a front-of-camera mask."""
    points = np.atleast_2d(np.asarray(points, np.float64))
    clip = np.c_[points, np.ones(len(points))] @ (camera.projection(aspect) @ camera.view()).T
    front = clip[:, 3] > 1e-6
    ndc = clip[:, :2] / np.where(front, clip[:, 3], 1.0)[:, None]
    return ndc, front


def reference_pick(world, faces, camera, x_ndc: float, y_ndc: float, aspect: float):
    """``surface3d.pick`` over every hemisphere, nearest hit wins.

    Returns ``{hemi, face, bary, distance, vertex, mm}`` or ``None``. The
    vertex is the face's corner with the largest barycentric weight -- the
    reference window's ``pick_vertex`` rule.
    """
    origin, direction = camera.ray(float(x_ndc), float(y_ndc), float(aspect))
    best = None
    for hemi, positions in world.items():
        found = surface3d.pick(origin, direction, positions, np.asarray(faces[hemi], np.int64))
        if found is None:
            continue
        face, bary, dist = found
        if best is None or dist < best["distance"]:
            corner = int(np.argmax(bary))
            vertex = int(np.asarray(faces[hemi])[face][corner])
            best = {
                "hemi": hemi,
                "face": int(face),
                "bary": np.asarray(bary, np.float64),
                "distance": float(dist),
                "vertex": vertex,
                "mm": np.asarray(positions[vertex], np.float64),
            }
    return best


def reference_click_mm(session, viewport, hemi: str, face: int, bary, world):
    """The reference 3-D window's ``pick_mm``: the click point at mid-depth.

    ``viewer/ui/surfacewindow.py:_hit`` interpolates the white/pial points at
    the sampled mid-depth by the hit's barycentric weights; reported for
    reference but not the sidecar's documented contract (which returns the
    picked vertex's mm position).
    """
    h = session.surfaces.hemis[hemi]
    faces = np.asarray(surface3d.shape_faces(h, viewport.shape), np.uint32).reshape(-1, 3)
    corners = faces[int(face)]
    d = np.full(3, 0.5 * (float(viewport.depth[0]) + float(viewport.depth[1])))
    if viewport.equivolume:
        aw, ap = session.surfaces.vertex_areas(hemi)
        d = surface3d.equivolume_fraction(d, np.asarray(aw)[corners], np.asarray(ap)[corners])
    d = np.asarray(d, np.float64)[:, None]
    white = np.asarray(h.states["white"], np.float64)[corners]
    pial = np.asarray(h.states["pial"], np.float64)[corners]
    point = (1.0 - d) * white + d * pial
    mm = np.asarray(bary, np.float64) @ point
    return np.asarray(mm, np.float64)


def surface_layer_rgba(session, viewport, hemi: str) -> np.ndarray:
    """Independent reference pipeline for one hemisphere's per-vertex colours.

    Written out from the reference viewer's documented path: cortical-depth
    samples (``surface.profiles.sample_depths``, equivolume on or off), reduced
    with ``surface3d.reduce_depth``, coloured with
    ``surfacelayers.layer_rgba``.  The layer chosen is the topmost visible
    layer above the base, which is what the 3-D window overlays.

    Returns ``(V, 4)`` uint8.
    """
    store = session.surfaces
    h = store.hemis[hemi]
    st = session.state
    visible = st.layers.visible_layers()
    base = st.layers.base
    overlays = [ly for ly in visible if base is None or ly.key != base.key]
    if not overlays:
        raise ValueError("no visible layer above the base to sample")
    layer = overlays[-1]
    if layer.colour or layer.roi:
        raise ValueError(f"layer {layer.key!r} is not a scalar volume layer")

    fractions = surface3d.depth_fractions(tuple(viewport.depth), int(viewport.samples))
    white = np.asarray(h.states["white"], np.float64)
    pial = np.asarray(h.states["pial"], np.float64)
    if viewport.equivolume:
        white_area, pial_area = store.vertex_areas(hemi)
        white_area = np.asarray(white_area, np.float64)
        pial_area = np.asarray(pial_area, np.float64)
    else:
        white_area = pial_area = None
    volume = session.volume(layer.key, session.layer_time(layer))
    values = surface_profiles.sample_depths(
        white,
        pial,
        volume,
        layer.affine,
        fractions,
        white_area=white_area,
        pial_area=pial_area,
    )
    if layer.threshold_index is not None:
        stat_volume = session.display_volume(layer.key, index=layer.threshold_index)
        stat = surface_profiles.sample_depths(
            white,
            pial,
            np.asarray(stat_volume),
            layer.affine,
            fractions,
            white_area=white_area,
            pial_area=pial_area,
        )
    else:
        stat = values
    reduced, stat_reduced = surface3d.reduce_depth(values, stat, viewport.depth_stat)
    return np.asarray(surfacelayers.layer_rgba(layer, reduced, stat_reduced), np.uint8)


def client_fold_base(session, viewport, hemi: str) -> np.ndarray:
    """The client renderer's folding base shade, as ``python/ffsviewer`` draws it.

    The sidecar sends unlit per-vertex colours and the browser applies lighting.
    Its base grey now matches the original GLSL shader's ``0.62 - contrast * fold``
    with the surface window's default contrast 0.16. Reported for information
    only: it is a renderer/appearance constant, outside the four sampling
    functions the surface check verifies.
    """
    h = session.surfaces.hemis[hemi]
    folding = surface3d.folding_values(h, viewport.folding)
    shade = np.clip(0.62 - 0.16 * np.asarray(folding, np.float64), 0.0, 1.0)
    base = np.zeros((h.n_vertices, 4), np.uint8)
    base[:, :3] = np.clip(np.rint(shade * 255.0), 0, 255).astype(np.uint8)[:, None]
    base[:, 3] = 255
    return base
