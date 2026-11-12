"""JSON snapshot of the authoritative FFS viewer state."""

from __future__ import annotations

import dataclasses
from enum import Enum

import numpy as np

from .classify import CATEGORIES


def jsonable(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, (tuple, list)):
        return [jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): jsonable(v) for k, v in value.items()}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {f.name: jsonable(getattr(value, f.name)) for f in dataclasses.fields(value)}
    return value


def layer_record(layer) -> dict:
    keys = (
        "key", "name", "path", "shape", "n_volumes", "affine", "visible", "opacity",
        "colormap", "colormap_reversed", "range_lo", "range_hi", "range_mirror",
        "range_fixed", "threshold", "threshold_index", "threshold_follow", "threshold_p",
        "alpha_mode", "boxed", "edges", "sign_mode", "n_panes", "volume_index",
        "time_linked", "roi", "integer_labels", "source", "labels", "time_detrend",
        "time_psc", "resample", "colour", "follows",
    )
    out = {}
    for key in keys:
        out[_camel(key)] = jsonable(getattr(layer, key, None))
    return out


def viewport_record(vp) -> dict:
    out = {}
    for field in dataclasses.fields(vp):
        out[_camel(field.name)] = jsonable(getattr(vp, field.name))
    return out


def _plane(value):
    from fastfuncstuff.viewer.state import Plane

    return value if isinstance(value, Plane) else Plane(str(value))


def _camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(part[:1].upper() + part[1:] for part in rest)


def _resident(session, key: str) -> bool:
    try:
        return session.store.get(key).array is not None
    except Exception:
        return False


def build_snapshot(session, meta: dict) -> dict:
    st = session.state
    grid = None
    if st.grid is not None:
        grid = {
            "shape": [int(v) for v in st.grid.shape],
            "affine": np.asarray(st.grid.affine, float).round(8).tolist(),
            "voxelMm": float(np.linalg.norm(np.asarray(st.grid.affine)[:3, :3], axis=0).min()),
        }
    layers = [layer_record(layer) for layer in st.layers.layers]
    viewports = [viewport_record(vp) for vp in st.viewports]
    if st.grid is not None:
        from fastfuncstuff.viewer.slicing import plane_layout

        for viewport in viewports:
            try:
                plane = viewport["plane"]
                layout = plane_layout(st.grid.affine, _plane(plane))
                viewport["fixedAxis"] = int(layout.fixed)
                viewport["positionMax"] = int(st.grid.shape[layout.fixed] - 1)
            except Exception:
                viewport["fixedAxis"] = 2
                viewport["positionMax"] = int(st.grid.shape[2] - 1)
    try:
        readout = list(session.overlay_readout())
    except Exception as exc:  # a readout must never take the whole snapshot down
        readout = [f"readout unavailable: {exc}"]
    brick = None
    selected = st.selected
    if selected is None and len(st.layers):
        selected = st.layers.layers[-1].key
    if selected is not None and st.layers.find(selected) is not None:
        try:
            brick = session.brick_caption(selected)
        except Exception:
            brick = None
    loading = any(
        layer.n_volumes > 1 and not _resident(session, layer.key)
        for layer in st.layers.layers
    )
    surface_subject = None
    if session.surfaces.subject is not None:
        surface_subject = str(session.surfaces.subject)
    sources = []
    seen = set()
    for layer in st.layers.layers:
        if layer.source == "file" and layer.path not in seen:
            seen.add(layer.path)
            sources.append({"path": layer.path, "key": layer.key, "name": layer.name})
    return {
        "rev": int(meta["rev"]),
        "revByCategory": {c: int(meta["revByCategory"][c]) for c in CATEGORIES},
        "category": meta["category"],
        "origin": meta["origin"],
        "loading": bool(loading),
        "grid": grid,
        "crosshair": [int(v) for v in st.crosshair],
        "crosshairMm": None if st.crosshair_mm is None else [float(v) for v in st.crosshair_mm],
        "timeIndex": int(st.time_index),
        "maxTimeIndex": int(st.max_time_index()),
        "selected": selected,
        "inputKey": st.input_key,
        "theme": st.theme,
        "layers": layers,
        "viewports": viewports,
        "surfaces": {
            "subject": surface_subject,
            "shown": [str(s) for s in st.surfaces_shown],
            "outlineWidth": float(st.surface_outline_width),
            "loaded": sorted(session.surfaces.hemis),
            "flatAvailable": bool(session.surfaces.hemis) and all(
                bool(getattr(hemi, "patches", None))
                for hemi in session.surfaces.hemis.values()
            ),
            "versions": {
                hemi: int(session.surfaces.version.get(hemi, 0))
                for hemi in session.surfaces.hemis
            },
            "selected": None if st.surface_selected is None else list(st.surface_selected),
        },
        "readout": {"lines": readout, "brick": brick},
        "mode": {"name": session.mode.name},
        "sources": sources,
        "workspace": meta.get("workspace"),
        "showSeq": int(meta.get("showSeq", 0)),
        "showTarget": meta.get("showTarget"),
        "notice": meta.get("notice"),
        "commands": int(meta.get("commandCount", 0)),
        "dirty": {c: bool(meta["dirty"][c]) for c in CATEGORIES if c != "navigation"},
        "lastSavedAt": meta.get("lastSavedAt"),
        "stateDir": meta.get("stateDir"),
    }


def aspects_names(aspects) -> list[str]:
    try:
        return [member.name for member in type(aspects) if member.value and member & aspects]
    except Exception:
        return []
