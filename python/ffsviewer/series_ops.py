"""Graph-window data: the grid of voxel time courses around the crosshair.

Cell positions and trace selection mirror ``viewer/ui/gridgraph.py:refresh`` so a
Harness graph and the desktop graph show the same cells: offsets are taken in image
order around the crosshair and converted back with the FFS ``PlaneLayout``.
"""

from __future__ import annotations

import numpy as np

from fastfuncstuff.viewer import slicing
from fastfuncstuff.viewer.derive import detrend_trace


def _clip(text: str, limit: int = 28) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _entries(session, vp) -> list[dict]:
    out: list[dict] = []
    for layer in session.graph_layers():
        stem = layer.name.removesuffix(".gz").removesuffix(".nii")
        out.append({
            "ident": layer.key,
            "label": _clip(stem),
            "name": layer.name,
            "isTime": True,
            "kind": "layer",
        })
    st = session.state
    if st.grid is not None:
        for trace in session.mode_series(st.crosshair):
            ident = f"mode:{trace.ident}"
            out.append({
                "ident": ident,
                "label": _clip(trace.legend),
                "name": trace.label,
                "isTime": trace.x_label in ("", "TR", "s"),
                "kind": "mode",
            })
    return out


def series_payload(session, vp) -> dict:
    st = session.state
    entries = _entries(session, vp)
    if not entries:
        return {
            "view": vp.id,
            "gridN": int(vp.grid_n),
            "cells": [],
            "entries": [],
            "timeIndex": int(st.time_index),
            "maxTimeIndex": int(st.max_time_index()),
            "secondsPerPoint": None,
        }
    drawn = {
        e["ident"] for e in entries
        if e["ident"] not in set(vp.hidden)
        and (e["kind"] == "mode" or e["ident"] in {ly.key for ly in session.traces_for(vp)})
    }
    traced = [ly for ly in session.traces_for(vp) if ly.key in drawn]
    n = max(1, int(vp.grid_n))
    half = n // 2
    cells = []
    offsets: list[tuple[int, int]] = []
    ijk_list: list[tuple[int, int, int]] = []
    if st.grid is None:
        return {
            "view": vp.id,
            "gridN": n,
            "cells": [],
            "entries": entries,
            "timeIndex": int(st.time_index),
            "maxTimeIndex": int(st.max_time_index()),
            "secondsPerPoint": None,
        }
    layout = slicing.plane_layout(st.grid.affine, vp.plane)
    centre_row, centre_col = layout.to_image(st.crosshair, st.grid.shape)
    for dr in range(-half, -half + n):
        for dc in range(-half, -half + n):
            ijk = st.grid.clamp(
                layout.to_ijk(centre_row + dr, centre_col + dc, st.crosshair, st.grid.shape)
            )
            offsets.append((dr, dc))
            ijk_list.append(ijk)
    tints = session.overlay_colors(ijk_list) if vp.tint else None
    mode_cache: dict[tuple[int, int, int], list] = {}
    seconds = None
    for position, (ijk, (dr, dc)) in enumerate(zip(ijk_list, offsets, strict=True)):
        traces = []
        for layer in traced:
            values = session.timeseries(layer.key, ijk)
            if not values.size:
                continue
            values = detrend_trace(values, int(vp.detrend))
            if seconds is None:
                try:
                    tr = float(session.store.get(layer.key).info.tr)
                    seconds = tr if tr > 0 else None
                except Exception:
                    seconds = None
            traces.append({
                "key": layer.key,
                "label": layer.name,
                "short": _clip(layer.name.removesuffix(".gz").removesuffix(".nii")),
                "values": np.asarray(values, np.float32).round(6).tolist(),
                "x": None,
                "xLabel": "TR" if seconds else "",
            })
        modes = mode_cache.get(ijk)
        if modes is None:
            modes = []
            for trace in session.mode_series(ijk):
                ident = f"mode:{trace.ident}"
                if ident not in drawn or not trace.values.size:
                    continue
                values = detrend_trace(trace.values, int(vp.detrend))
                modes.append({
                    "key": ident,
                    "label": trace.label,
                    "short": _clip(trace.legend),
                    "values": np.asarray(values, np.float32).round(6).tolist(),
                    "x": None if trace.x is None else np.asarray(trace.x, np.float64).tolist(),
                    "xLabel": trace.x_label,
                })
            mode_cache[ijk] = modes
        traces.extend(modes)
        cells.append({
            "row": int(dr),
            "col": int(dc),
            "ijk": [int(v) for v in ijk],
            "centre": dr == 0 and dc == 0,
            "traces": traces,
            "tint": None if tints is None else tints[position],
        })
    return {
        "view": vp.id,
        "plane": vp.plane.value if hasattr(vp.plane, "value") else str(vp.plane),
        "gridN": n,
        "cells": cells,
        "entries": entries,
        "sharedScale": bool(vp.shared_scale),
        "timeIndex": int(st.time_index),
        "maxTimeIndex": int(st.max_time_index()),
        "secondsPerPoint": seconds,
    }
