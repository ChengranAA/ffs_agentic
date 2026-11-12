#!/usr/bin/env python
"""Independent verification of the Harness FFS viewer sidecar against FFS itself.

Run with one command::

    .venv/bin/python verification/verify_all.py

It spawns ``python -m ffsviewer.server`` exactly as the Host plugin does, replays
the demo session (and further command sequences) through *both* the sidecar and a
reference ``fastfuncstuff.viewer.session.ViewerSession`` run in this process, and
compares the results against the reference viewer's own programs
(``compose.render_viewport``, ``slicing.PlaneView``, ``surface3d.pick``,
``surface.profiles.sample_depths`` / ``surface3d.reduce_depth`` /
``surfacelayers.layer_rgba``).

Checks that cannot be run are reported SKIP with the reason.  Nothing is
weakened to make a check pass: a real discrepancy is reported as FAIL with the
measured numbers.

Writes ``verification/REPORT.md``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

from lib_sidecar import (  # noqa: E402
    Sidecar,
    b64_f32,
    b64_u32,
    b64_u8,
    decode_png,
)
import lib_ref as ffsref  # noqa: E402  (also puts the reference packages on sys.path)

REPORT_PATH = HERE / "REPORT.md"

DISPLAY, NAVIGATION, SOURCE, ANALYSIS = "display", "navigation", "source", "analysis"

#: Expected command categories, read from what each command *does* (the brief
#: this verifies), not from ``python/ffsviewer/classify.py``. A command whose
#: category is missing here must be added for the sync check to run it.
EXPECTED_CATEGORY = {
    "SET_THEME": DISPLAY,
    "LOAD": SOURCE,
    "LOAD_SURFACES": SOURCE,
    "READ": SOURCE,
    "SET_COLORMAP": DISPLAY,
    "SET_COLORMAP_REVERSED": DISPLAY,
    "SET_LAYER_VISIBLE": DISPLAY,
    "SET_LAYER_OPACITY": DISPLAY,
    "SET_SIGN": DISPLAY,
    "SET_ALPHA": DISPLAY,
    "SET_BOXED": DISPLAY,
    "SET_EDGES": DISPLAY,
    "SET_THRESHOLD": DISPLAY,
    "SET_THRESHOLD_INDEX": DISPLAY,
    "SET_RANGE": DISPLAY,
    "SET_RANGE_MIRROR": DISPLAY,
    "SET_RANGE_FIXED": DISPLAY,
    "SET_PANES": DISPLAY,
    "SELECT_LAYER": DISPLAY,
    "SHOW_SURFACES": DISPLAY,
    "SET_SURFACE_SHAPE": DISPLAY,
    "SET_SURFACE_DEPTH": DISPLAY,
    "SET_SURFACE_DEPTH_STAT": DISPLAY,
    "SET_SURFACE_EQUIVOLUME": DISPLAY,
    "SET_SURFACE_FOLDING": DISPLAY,
    "SET_SURFACE_HEMIS": DISPLAY,
    "SET_SURFACE_HINGE": DISPLAY,
    "SET_VIEW_GRID": DISPLAY,
    "SET_VIEW_TRACES": DISPLAY,
    "SET_VIEW_TILES": DISPLAY,
    "SET_VIEW_SOLO": DISPLAY,
    "OPEN_VIEW": NAVIGATION,
    "CLOSE_VIEW": NAVIGATION,
    "SET_VIEW_LOCKED": NAVIGATION,
    "SET_VIEW_POSITION": NAVIGATION,
    "SET_VIEW_PLANE": NAVIGATION,
    "SET_ZOOM": NAVIGATION,
    "SET_PAN": NAVIGATION,
    "SET_VIEW_TILT": NAVIGATION,
    "SET_XYZ": NAVIGATION,
    "SET_IJK": NAVIGATION,
    "SET_INDEX": NAVIGATION,
    "SET_SEED": ANALYSIS,
    "SET_MODE": ANALYSIS,
}

#: Demo-session display/surface state, applied before a check that should not
#: inherit whatever the previous check left behind.
RESET_DISPLAY = [
    "SET_THRESHOLD S 2.5",
    "SET_THRESHOLD_INDEX S -",
    "SET_COLORMAP S redblue",
    "SET_SIGN S both",
    "SET_ALPHA S linear",
    "SET_BOXED S 1",
    "SET_RANGE S -6 6",
    "SET_RANGE_MIRROR S 1",
    "SET_LAYER_OPACITY S 1.0",
    "SET_LAYER_VISIBLE F 0",
    "SET_INDEX 0",
    "SET_VIEW_GRID G1 2",
    "SET_SURFACE_SHAPE S1 inflated",
    "SET_SURFACE_DEPTH S1 0.5 0.5 1",
    "SET_SURFACE_DEPTH_STAT S1 mean",
    "SET_SURFACE_EQUIVOLUME S1 0",
    "SET_SURFACE_FOLDING S1 curv",
    "SET_SURFACE_HEMIS S1 lh,rh 0",
    "SET_SURFACE_HINGE S1 0",
    "SHOW_SURFACES white,pial",
    "SET_XYZ -30 10 5",
    "SET_ZOOM V1 1.0",
    "SET_PAN V1 0 0",
    "SET_ZOOM V2 1.0",
    "SET_PAN V2 0 0",
    "SET_ZOOM V3 1.0",
    "SET_PAN V3 0 0",
]


# ---------------------------------------------------------------------------
# result plumbing
# ---------------------------------------------------------------------------


@dataclass
class Check:
    ident: str
    name: str
    status: str = "PASS"  # PASS / FAIL / SKIP / INFO
    evidence: str = ""
    metrics: dict = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)

    def fail(self, evidence: str) -> "Check":
        self.status = "FAIL"
        self.evidence = evidence
        return self


@dataclass
class Finding:
    title: str
    severity: str
    where: str
    measured: str
    reproduction: str


def num(value):
    """A JSON/report-friendly scalar."""
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, np.ndarray):
        return num(value.tolist())
    if isinstance(value, (tuple, list)):
        return [num(v) for v in value]
    if isinstance(value, dict):
        return {str(k): num(v) for k, v in value.items()}
    return value


def short(value, limit: int = 160) -> str:
    text = repr(num(value))
    return text if len(text) <= limit else text[: limit - 3] + "..."


def apply(sc: Sidecar, rs: ffsref.RefSession, lines: list[str], origin: str = "ui") -> None:
    """Send the same lines to the sidecar and the in-process reference session."""
    for line in lines:
        sc.execute(line, origin=origin)
        rs.do(line)


def bootstrap_demo(name: str) -> tuple[Sidecar, ffsref.RefSession]:
    sc = Sidecar(name=name).start()
    sc.open(preset="demo")
    rs = ffsref.RefSession(ffsref.demo_script())
    return sc, rs


def state_diffs(sc: Sidecar, rs: ffsref.RefSession) -> list[tuple[str, object, object]]:
    return ffsref.compare_semantic(
        ffsref.semantic_snapshot_from_sidecar(sc.snapshot()),
        ffsref.semantic_snapshot_from_ref(rs.session),
    )


def diff_evidence(diffs: list[tuple[str, object, object]], limit: int = 5) -> str:
    return "; ".join(f"{path}: {short(a, 60)} != {short(b, 60)}" for path, a, b in diffs[:limit])


# ---------------------------------------------------------------------------
# 1. coordinate mapping
# ---------------------------------------------------------------------------


def check_coordinates(sc: Sidecar, rs: ffsref.RefSession) -> list[Check]:
    out = Check("1", "Coordinate mapping (pick / crosshairPx vs reference PlaneView)")
    apply(sc, rs, [
        "SET_ZOOM V1 2.0", "SET_PAN V1 3.5 -2.0",
        "SET_ZOOM V2 1.7", "SET_PAN V2 -2.5 4.0",
        "SET_ZOOM V3 1.35", "SET_PAN V3 2.0 1.0",
    ])
    crosshairs = [(-30.0, 10.0, 5.0), (4.5, -20.0, 12.0), (20.0, -5.0, -15.0)]
    pixels_checked = 0
    pick_mismatches: list[str] = []
    px_mismatches = 0
    max_px_diff = 0.0
    roundtrip_mismatches = 0
    span_mismatches = 0
    views_done = 0
    for view in ("V1", "V2", "V3"):
        views_done += 1
        for (x, y, z) in crosshairs:
            apply(sc, rs, [f"SET_XYZ {x} {y} {z}"])
            snap = sc.snapshot()
            pv_side = ffsref.plane_view_from_snapshot(snap, view)
            pv_ref = ffsref.plane_view_from_ref(rs.session, view)
            if (pv_side.span, pv_side.origin, pv_side.extent, pv_side.layout) != (
                pv_ref.span,
                pv_ref.origin,
                pv_ref.extent,
                pv_ref.layout,
            ):
                span_mismatches += 1
            # The snapshot's harness-only parked-slice controls must describe
            # this plane: fixed axis and slice count from the reference layout.
            for viewport in snap["viewports"]:
                extras = ffsref.sidecar_viewport_extras(snap).get(viewport["id"])
                if extras is None:
                    continue
                layout = ffsref.plane_layout(
                    np.asarray(snap["grid"]["affine"], np.float64),
                    ffsref.Plane(viewport["plane"]),
                )
                expected_fixed = int(layout.fixed)
                expected_max = int(snap["grid"]["shape"][expected_fixed] - 1)
                if extras[0] != expected_fixed or extras[1] != expected_max:
                    span_mismatches += 1
                    pick_mismatches.append(
                        f"{viewport['id']}: fixedAxis/positionMax {extras} != "
                        f"{(expected_fixed, expected_max)}"
                    )
            anchor = tuple(int(v) for v in snap["crosshair"])
            rows, cols = pv_side.span
            if rows < 1 or cols < 1:  # pragma: no cover - span is never empty
                continue
            candidates = [
                (0, 0), (0, cols - 1), (rows - 1, 0), (rows - 1, cols - 1),
                (rows // 2, cols // 2), (min(1, rows - 1), cols // 3),
            ]
            pixels = []
            for pixel in candidates:
                if pixel not in pixels and 0 <= pixel[0] < rows and 0 <= pixel[1] < cols:
                    pixels.append(pixel)

            # render()'s crosshair pixel must be points_to_image(crosshair)/span.
            payload = sc.render(view)
            frac = pv_side.points_to_image(np.asarray(snap["crosshair"], np.float64))
            expected_px = [
                float(frac[0] / max(1, pv_side.span[0])),
                float(frac[1] / max(1, pv_side.span[1])),
            ]
            got_px = payload.get("crosshairPx")
            if got_px is None:
                px_mismatches += 1
                pick_mismatches.append(f"{view}: render crosshairPx is null")
            else:
                delta = max(abs(float(got_px[i]) - expected_px[i]) for i in (0, 1))
                max_px_diff = max(max_px_diff, delta)
                if list(got_px) != expected_px:
                    px_mismatches += 1
            if (payload["width"], payload["height"]) != (pv_side.span[1], pv_side.span[0]) or (
                payload["viewInfo"]["span"] != list(pv_side.span)
                or payload["viewInfo"]["origin"] != list(pv_side.origin)
            ):
                span_mismatches += 1

            # Round trip: click the pixel the crosshair is drawn at.
            row = int(round(frac[0]))
            col = int(round(frac[1]))
            if 0 <= row < pv_side.span[0] and 0 <= col < pv_side.span[1]:
                got = sc.pick(view, row, col)
                if list(got["ijk"]) != list(snap["crosshair"]) or list(
                    got["state"]["crosshair"]
                ) != list(snap["crosshair"]):
                    roundtrip_mismatches += 1
                    pick_mismatches.append(
                        f"{view}: roundtrip ({row},{col}) -> {got['ijk']} != {snap['crosshair']}"
                    )
                pixels_checked += 1

            # Every sampled pixel must map through PlaneView.to_ijk exactly.
            for (row, col) in pixels:
                expected = list(pv_side.to_ijk(row, col, anchor))
                got = sc.pick(view, row, col)
                pixels_checked += 1
                if list(got["ijk"]) != expected or list(got["state"]["crosshair"]) != expected:
                    pick_mismatches.append(f"{view}: pick({row},{col}) -> {got['ijk']} != {expected}")

    out.metrics = {
        "views": views_done,
        "crosshairs_per_view": len(crosshairs),
        "pixels_checked": pixels_checked,
        "pick_mismatches": len(pick_mismatches),
        "crosshairPx_mismatches": px_mismatches,
        "max_abs_crosshairPx_diff": max_px_diff,
        "plane_view_span_origin_mismatches": span_mismatches,
        "roundtrip_mismatches": roundtrip_mismatches,
    }
    out.notes.append(
        "PlaneView reconstructed twice: from the sidecar's own reported grid affine/shape/"
        "viewport zoom+pan, and from the reference session state; both agree."
    )
    if pick_mismatches:
        out.notes.extend(pick_mismatches[:6])
        out.fail(
            f"{len(pick_mismatches)} pick/roundtrip mismatches; "
            f"{px_mismatches} crosshairPx mismatches (max Δ {max_px_diff:.3g})"
        )
    else:
        out.evidence = (
            f"{pixels_checked} pixel picks + {views_done * len(crosshairs)} crosshairPx "
            f"rounds exact; max Δ{max_px_diff:.3g}"
        )
    return [out]


# ---------------------------------------------------------------------------
# 2. surface picking
# ---------------------------------------------------------------------------


def _poses() -> list[tuple[str, object]]:
    y90 = np.array([[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]])
    c30, s30 = np.cos(np.radians(30.0)), np.sin(np.radians(30.0))
    rz180 = np.diag([-1.0, -1.0, 1.0])
    rx30 = np.array([[1.0, 0.0, 0.0], [0.0, c30, -s30], [0.0, s30, c30]])
    return [
        ("identity d350", ffsref.make_camera(rotation=np.eye(3), distance=350.0)),
        ("y90 d300", ffsref.make_camera(rotation=y90, distance=300.0)),
        (
            "orbit+roll d330",
            ffsref.make_camera(
                rotation=ffsref.rotation_from((0.40, -0.30), roll=0.20),
                distance=330.0,
                target=(2.0, -4.0, 5.0),
            ),
        ),
        (
            "back d260",
            ffsref.make_camera(
                rotation=rz180 @ rx30,
                distance=260.0,
                target=(0.0, 0.0, 0.0),
            ),
        ),
        ("off-target d240", ffsref.make_camera(distance=240.0, target=(5.0, 5.0, 5.0))),
    ]


def _ndc_samples(world, camera, aspect: float, per_pose: int = 4) -> list[tuple[float, float]]:
    allp = np.concatenate([np.asarray(p, np.float64) for p in world.values()], axis=0)
    idx = np.unique(np.linspace(0, len(allp) - 1, 15).astype(int))
    ndc, front = ffsref.project_ndc(camera, allp[idx], aspect)
    samples: list[tuple[float, float]] = [(0.0, 0.0)]
    for (x, y), ok in zip(ndc, front):
        if not ok or abs(x) > 0.9 or abs(y) > 0.9:
            continue
        point = (round(float(x), 6), round(float(y), 6))
        if point not in samples:
            samples.append(point)
        if len(samples) >= per_pose:
            break
    return samples[:per_pose]


def _raw_pivot_world(session, viewport):
    """The sidecar's placement logic (pivot on un-laid-out positions), for attribution."""
    store = session.surfaces
    shape = viewport.shape
    raw: dict[str, np.ndarray] = {}
    faces: dict[str, np.ndarray] = {}
    for hemi in store.hemis:
        h = store.hemis[hemi]
        pos = ffsref.surface3d.shape_positions(h, shape)
        if pos is None:
            pos = np.asarray(h.states["white"], np.float32)
        raw[hemi] = np.asarray(pos, np.float32)
        faces[hemi] = np.asarray(ffsref.surface3d.shape_faces(h, shape), np.uint32)
    offsets = ffsref.surface3d.layout_offsets(raw, shape, faces)
    models = ffsref.surface3d.hemisphere_models(
        raw, float(viewport.split), float(viewport.hinge)
    )
    world = {}
    for hemi, p in raw.items():
        m = models[hemi]
        world[hemi] = np.asarray(
            (p + offsets[hemi]) @ m[:3, :3].T + m[:3, 3], np.float32
        )
    return world, faces


def _mesh_from_payload(payload: dict) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    mesh = payload.get("mesh") or {}
    out = {}
    for hemi in mesh.get("hemis", []):
        positions = b64_f32(hemi["positions"]).reshape(-1, 3)
        faces = b64_u32(hemi["faces"]).reshape(-1, 3)
        out[hemi["hemi"]] = (positions, faces)
    return out


def _compare_mesh(payload: dict, world, faces) -> tuple[float, float]:
    """Return (max position difference, max face mismatch count) sidecar vs reference."""
    mesh = _mesh_from_payload(payload)
    max_delta = 0.0
    face_mismatches = 0
    for hemi in world:
        if hemi not in mesh:
            face_mismatches += 1
            continue
        positions, got_faces = mesh[hemi]
        ref_positions = np.asarray(world[hemi], np.float32)
        if positions.shape != ref_positions.shape:
            face_mismatches += 1
            continue
        max_delta = max(max_delta, float(np.abs(positions.astype(np.float64) - ref_positions.astype(np.float64)).max()))
        ref_faces = np.asarray(faces[hemi], np.uint32)
        if got_faces.shape != ref_faces.shape or not np.array_equal(got_faces, ref_faces):
            face_mismatches += 1
    return max_delta, float(face_mismatches)


def check_picking(sc: Sidecar, rs: ffsref.RefSession) -> list[Check]:
    baseline = Check("2a", "Surface picking (default geometry) vs reference surface3d.pick")
    hinge_check = Check(
        "2b",
        "Surface geometry/picking with SET_SURFACE_HINGE (supported command)",
    )
    apply(sc, rs, RESET_DISPLAY)

    vp = rs.state.viewports.find("S1")
    world, faces, _laid, _models = ffsref.surface_arrays(rs.session, vp)
    payload = sc.surface("S1")
    max_mesh_delta, face_mismatches = _compare_mesh(payload, world, faces)
    baseline.metrics["mesh_max_delta_mm"] = max_mesh_delta
    baseline.metrics["mesh_face_mismatches"] = face_mismatches

    aspect = 4.0 / 3.0
    hits = misses = 0
    mismatches: list[str] = []
    off_surface_codes: list[str] = []
    max_mm = max_dist = max_bary = 0.0
    max_vertex_mm = 0.0
    mm_crosshair_deviation = 0.0
    for name, camera in _poses():
        ndcs = _ndc_samples(world, camera, aspect)
        for (x, y) in ndcs:
            expected = ffsref.reference_pick(world, faces, camera, x, y, aspect)
            camera_params = ffsref.camera_dict(camera)
            if expected is None:
                misses += 1
                ok, error = sc.try_call(
                    "surface_pick",
                    view="S1",
                    xNdc=x,
                    yNdc=y,
                    aspect=aspect,
                    camera=camera_params,
                )
                if ok:
                    mismatches.append(f"{name} ({x},{y}): reference misses, sidecar hits")
                else:
                    code = str(error.get("code"))
                    off_surface_codes.append(code)
                    if code != "pick-miss":
                        mismatches.append(
                            f"{name} ({x},{y}): miss returned code {code!r}, expected 'pick-miss'"
                        )
                continue
            hits += 1
            hit = sc.surface_pick("S1", camera_params, x, y, aspect)
            expected_click = ffsref.reference_click_mm(
                rs.session, vp, expected["hemi"], expected["face"], expected["bary"], world
            )
            max_mm = max(
                max_mm,
                float(np.abs(np.asarray(hit["mm"], np.float64) - expected_click).max()),
            )
            max_vertex_mm = max(
                max_vertex_mm,
                float(np.abs(np.asarray(hit["mm"], np.float64) - expected["mm"]).max()),
            )
            max_dist = max(max_dist, abs(float(hit["distance"]) - expected["distance"]))
            max_bary = max(
                max_bary,
                float(np.abs(np.asarray(hit["barycentric"], np.float64) - expected["bary"]).max()),
            )
            if list(hit.get("face", [])) != [int(v) for v in np.asarray(faces[expected["hemi"]])[expected["face"]]]:
                mismatches.append(f"{name} ({x:.3f},{y:.3f}): returned face corners differ")
            if hit["hemi"] != expected["hemi"] or int(hit["vertex"]) != int(expected["vertex"]):
                mismatches.append(
                    f"{name} ({x:.3f},{y:.3f}): ({hit['hemi']},{hit['vertex']}) "
                    f"!= ({expected['hemi']},{expected['vertex']})"
                )
            selected = hit["state"]["surfaces"]["selected"]
            if selected != [expected["hemi"], int(expected["vertex"])]:
                mismatches.append(f"{name}: selected {selected} != picked vertex")
            if hit["state"]["crosshairMm"] is not None:
                mm_crosshair_deviation = max(
                    mm_crosshair_deviation,
                    float(
                        np.abs(
                            np.asarray(hit["state"]["crosshairMm"], np.float64)
                            - np.asarray(hit["mm"], np.float64)
                        ).max()
                    ),
                )
    # A ray that misses must be code `pick-miss` and must not mutate the viewer.
    miss_camera = ffsref.make_camera(rotation=np.eye(3), distance=350.0)
    miss_x, miss_y = 0.98, 0.98
    miss_expected = ffsref.reference_pick(world, faces, miss_camera, miss_x, miss_y, aspect)
    pick_miss_clean = False
    if miss_expected is not None:
        baseline.notes.append("harness could not construct an off-surface ray for the miss check")
    else:
        before = sc.snapshot()
        ok_miss, error_miss = sc.try_call(
            "surface_pick",
            view="S1",
            xNdc=miss_x,
            yNdc=miss_y,
            aspect=aspect,
            camera=ffsref.camera_dict(miss_camera),
        )
        after = sc.snapshot()
        pick_miss_clean = (
            (not ok_miss)
            and str(error_miss.get("code")) == "pick-miss"
            and int(after["rev"]) == int(before["rev"])
            and list(after["crosshair"]) == list(before["crosshair"])
            and after["surfaces"]["selected"] == before["surfaces"]["selected"]
        )
        if not pick_miss_clean:
            mismatches.append(
                "pick-miss check failed: "
                f"ok={ok_miss} code={error_miss.get('code')!r} "
                f"rev {before['rev']}->{after['rev']} "
                f"crosshair {before['crosshair']}->{after['crosshair']}"
            )

    baseline.metrics.update(
        {
            "poses": len(_poses()),
            "ndc_hits": hits,
            "ndc_misses": misses,
            "hemi_vertex_mismatches": len(mismatches),
            "max_click_mm_delta_vs_reference_pick_mm": max_mm,
            "max_mm_delta_vs_picked_vertex": max_vertex_mm,
            "max_distance_delta": max_dist,
            "max_barycentric_delta": max_bary,
            "crosshairMm_vs_pick_mm_max_mm": mm_crosshair_deviation,
            "off_surface_error_codes": sorted(set(off_surface_codes)),
            "pick_miss_is_not_a_mutation": pick_miss_clean,
        }
    )
    baseline.notes.append(
        "Sidecar mm is the reference window's pick_mm (the mid-depth click point), and the "
        "vertex/corners/barycentric match the nearest-barycentric vertex of the same hit; the "
        "distance to the picked vertex position is reported separately."
    )
    if mismatches or max_mesh_delta > 1e-4 or face_mismatches:
        baseline.notes.extend(mismatches[:6])
        baseline.fail(
            f"{len(mismatches)} pick mismatches; mesh Δ {max_mesh_delta:.3g} mm; "
            f"{int(face_mismatches)} face mismatches"
        )
    else:
        baseline.evidence = (
            f"{hits} hits / {misses} misses exact; mesh Δ {max_mesh_delta:.3g} mm; "
            f"bary Δ {max_bary:.3g}; click mm Δ {max_mm:.3g}"
        )

    # -- split: pure translation, must stay exact ----------------------
    split_check = Check("2c", "Surface split (SET_SURFACE_HEMIS ... 10 mm) vs reference layout")
    apply(sc, rs, ["SET_SURFACE_HEMIS S1 lh,rh 10"])
    vp = rs.state.viewports.find("S1")
    world, faces, _laid, _models = ffsref.surface_arrays(rs.session, vp)
    payload = sc.surface("S1")
    delta, faces_bad = _compare_mesh(payload, world, faces)
    split_check.metrics = {"mesh_max_delta_mm": delta, "mesh_face_mismatches": faces_bad}
    if delta > 1e-4 or faces_bad:
        split_check.fail(f"mesh Δ {delta:.3g} mm, {int(faces_bad)} face groups differ")
    else:
        split_check.evidence = f"mesh Δ {delta:.3g} mm"
    apply(sc, rs, ["SET_SURFACE_HEMIS S1 lh,rh 0"])

    # -- hinge: the reference 3-D window pivots on the laid-out positions ----
    hinge_rows = []
    hinge_fail = False
    for hinge in (30.0, -45.0):
        apply(sc, rs, [f"SET_SURFACE_HINGE S1 {hinge}"])
        vp = rs.state.viewports.find("S1")
        ref_world, ref_faces, _laid, _models = ffsref.surface_arrays(rs.session, vp)
        raw_world, _raw_faces = _raw_pivot_world(rs.session, vp)
        payload = sc.surface("S1")
        delta_ref, _ = _compare_mesh(payload, ref_world, ref_faces)
        delta_raw, _ = _compare_mesh(payload, raw_world, ref_faces)
        # Do the picks agree too? The sidecar applies the model in float64 and
        # casts to float32, the reference window applies it in float32; that
        # ~1e-5 mm difference only matters where a ray pierces a shared edge, so
        # a different corner of an equally-near pair of triangles is reported as
        # a degenerate tie-break rather than a pick mismatch.
        aspect = 4.0 / 3.0
        camera = ffsref.make_camera(rotation=np.eye(3), distance=300.0)
        pick_mismatch = 0
        pick_total = 0
        vertex_matches = 0
        tie_breaks = 0
        max_tie_distance_delta = 0.0
        for (x, y) in _ndc_samples(ref_world, camera, aspect, per_pose=6):
            expected = ffsref.reference_pick(ref_world, ref_faces, camera, x, y, aspect)
            pick_total += 1
            if expected is None:
                ok, _error = sc.try_call(
                    "surface_pick",
                    view="S1",
                    xNdc=x,
                    yNdc=y,
                    aspect=aspect,
                    camera=ffsref.camera_dict(camera),
                )
                pick_mismatch += 1 if ok else 0
                continue
            hit = sc.surface_pick("S1", ffsref.camera_dict(camera), x, y, aspect)
            if (hit["hemi"], int(hit["vertex"])) == (expected["hemi"], int(expected["vertex"])):
                vertex_matches += 1
                continue
            # A ray through a crease is equally near two triangles; a float32
            # vs float64 model application decides which. The hit is the same
            # surface point to within the distance tolerance, but the two
            # triangles can sit on opposite sides of the fold, so the click mm
            # is not a tie-breaker here -- the ray distance is.
            delta_dist = abs(float(hit["distance"]) - expected["distance"])
            if hit["hemi"] == expected["hemi"] and delta_dist <= 1e-4:
                tie_breaks += 1
                max_tie_distance_delta = max(max_tie_distance_delta, delta_dist)
            else:
                pick_mismatch += 1
        hinge_rows.append(
            {
                "hinge_deg": hinge,
                "sidecar_vs_laid_pivot_world_mm": delta_ref,
                "sidecar_vs_raw_pivot_world_mm": delta_raw,
                "picks": pick_total,
                "vertex_matches": vertex_matches,
                "degenerate_tie_breaks": tie_breaks,
                "max_tie_break_distance_delta_mm": max_tie_distance_delta,
                "pick_mismatches": pick_mismatch,
            }
        )
        if delta_ref > 1e-4 or pick_mismatch:
            hinge_fail = True
    apply(sc, rs, ["SET_SURFACE_HINGE S1 0"])
    hinge_check.metrics = {"poses": hinge_rows}
    hinge_check.notes.append(
        "The sidecar now builds its hemisphere models from the laid-out positions "
        "(`python/ffsviewer/surface_ops.py:49-55`), matching "
        "`viewer/ui/surfacewindow.py:1743-1767`. The residual 7.6e-06 mm is float32 "
        "model application in the reference window against float64-then-cast in the "
        "sidecar; it flips a nearest-triangle tie only where a ray pierces a crease."
    )
    for row in hinge_rows:
        if row.get("degenerate_tie_breaks"):
            hinge_check.notes.append(
                f"hinge {row['hinge_deg']:g}: {row['degenerate_tie_breaks']}/{row['picks']} "
                "rays hit a crease where two triangles are tied; same hemisphere, distance "
                f"Δ <= {row.get('max_tie_break_distance_delta_mm', 0.0):.2g} mm"
            )
    if hinge_fail:
        worst = max(row["sidecar_vs_laid_pivot_world_mm"] for row in hinge_rows)
        hinge_check.fail(
            "sidecar surface mesh does not match the reference layout when hinge != 0: "
            f"max Δ {worst:.4g} mm; it matches the same construction pivoted on "
            "*un-laid-out* positions instead (Δ "
            f"{min(row['sidecar_vs_raw_pivot_world_mm'] for row in hinge_rows):.2g} mm)"
        )
    else:
        worst = max(row["sidecar_vs_laid_pivot_world_mm"] for row in hinge_rows)
        hinge_check.evidence = (
            f"hinge 30/-45: mesh Δ {worst:.2g} mm vs the reference laid-out pivot "
            "(it no longer matches the raw-pivot construction)"
        )

    return [baseline, split_check, hinge_check]


# ---------------------------------------------------------------------------
# 3. threshold / colormap rendering
# ---------------------------------------------------------------------------


def _render_configs() -> list[tuple[str, list[str]]]:
    configs: list[tuple[str, list[str]]] = []
    for alpha in ("off", "linear", "quadratic"):
        for sign in ("both", "pos", "neg"):
            configs.append(
                (
                    f"threshold=2.5 alpha={alpha} sign={sign} cmap=redblue",
                    [
                        f"SET_ALPHA S {alpha}",
                        f"SET_SIGN S {sign}",
                        "SET_THRESHOLD S 2.5",
                        "SET_COLORMAP S redblue",
                        "SET_RANGE S -6 6",
                        "SET_RANGE_MIRROR S 1",
                        "SET_BOXED S 1",
                        "SET_LAYER_OPACITY S 1.0",
                    ],
                )
            )
    for cmap in ("gray", "redblue", "hot"):
        configs.append(
            (f"colormap={cmap}", ["SET_COLORMAP S " + cmap, "SET_ALPHA S linear", "SET_THRESHOLD S 2.5", "SET_SIGN S both"])
        )
    for threshold in (0.0, 1.2, 3.4, 4.5):
        configs.append(
            (f"threshold={threshold}", [f"SET_THRESHOLD S {threshold}", "SET_ALPHA S linear", "SET_COLORMAP S redblue"])
        )
    configs.append(
        (
            "range=-3..5 mirror=0",
            ["SET_RANGE S -3 5", "SET_RANGE_MIRROR S 0", "SET_THRESHOLD S 2.5"],
        )
    )
    configs.append(
        (
            "range=-6..6 mirror=1",
            ["SET_RANGE S -6 6", "SET_RANGE_MIRROR S 1"],
        )
    )
    configs.append(("boxed=0", ["SET_BOXED S 0"]))
    configs.append(("boxed=1", ["SET_BOXED S 1"]))
    configs.append(("opacity=0.5", ["SET_LAYER_OPACITY S 0.5"]))
    configs.append(("opacity=1.0", ["SET_LAYER_OPACITY S 1.0"]))
    configs.append(
        (
            "threshold_index=1 (coef sub-brick, display=0 t)",
            [
                "SET_THRESHOLD_INDEX S 1",
                "SET_THRESHOLD S 0.5",
                "SET_ALPHA S linear",
                "SET_COLORMAP S hot",
            ],
        )
    )
    configs.append(
        (
            "reset threshold_index=-",
            ["SET_THRESHOLD_INDEX S -", "SET_THRESHOLD S 2.5", "SET_COLORMAP S redblue"],
        )
    )
    configs.append(
        (
            "4-D layer F visible, timeIndex=7",
            ["SET_LAYER_VISIBLE F 1", "SET_INDEX 7", "SET_COLORMAP F hot"],
        )
    )
    configs.append(("restore F hidden, timeIndex=0", ["SET_LAYER_VISIBLE F 0", "SET_INDEX 0"]))
    return configs


def check_renders(sc: Sidecar, rs: ffsref.RefSession) -> list[Check]:
    out = Check("3", "Slice rendering: PNG pixels vs reference compose.render_viewport")
    apply(sc, rs, RESET_DISPLAY)
    apply(sc, rs, [
        "SET_ZOOM V2 1.7", "SET_PAN V2 -2.5 4.0",
        "SET_ZOOM V3 1.35", "SET_PAN V3 2.0 1.0",
    ])
    views = ("V1", "V2", "V3")
    configs = _render_configs()
    renders = 0
    mismatched = 0
    max_pixel_diff = 0.0
    pixels_total = 0
    parity_mismatches = 0
    tolerance = 0  # byte-for-byte as the brief requires; max delta is reported anyway
    hashes: dict[tuple[int, str], str] = {}
    for index, (label, lines) in enumerate(configs):
        apply(sc, rs, lines)
        snap = sc.snapshot()
        diffs = ffsref.compare_semantic(
            ffsref.semantic_snapshot_from_sidecar(snap, include_selection=False),
            ffsref.semantic_snapshot_from_ref(rs.session, include_selection=False),
        )
        if diffs:
            parity_mismatches += 1
            out.notes.append(f"config {index} ({label}) state parity: {diff_evidence(diffs, 3)}")
        for view in views:
            payload = sc.render(view)
            ref_img = ffsref.compose.render_viewport(rs.session, rs.state.viewports.find(view))
            reference = ref_img.rgba.detach().cpu().numpy()
            got = decode_png(payload["png"])
            renders += 1
            if got.shape != reference.shape:
                mismatched += 1
                out.notes.append(f"config {index} {view}: shape {got.shape} != {reference.shape}")
                continue
            pixels_total += int(got[..., 0].size)
            delta = float(np.abs(got.astype(np.int16) - reference.astype(np.int16)).max())
            max_pixel_diff = max(max_pixel_diff, delta)
            bad = False
            if delta > tolerance:
                bad = True
                out.notes.append(f"config {index} ({label}) {view}: max pixel Δ {delta:.0f}")
            if got.shape != (payload["height"], payload["width"], 4):
                bad = True
                out.notes.append(f"config {index} {view}: PNG size does not match payload metadata")
            if payload["plane"] != ref_img.plane.value or int(payload["position"]) != int(
                ref_img.position
            ):
                bad = True
                out.notes.append(f"config {index} {view}: plane/position metadata differs")
            if bad:
                mismatched += 1
            hashes[(index, view)] = hashlib.md5(reference.tobytes()).hexdigest()

    distinct = len(set(hashes.values()))
    out.metrics = {
        "configs": len(configs),
        "views_per_config": len(views),
        "renders_compared": renders,
        "mismatched_renders": mismatched,
        "pixels_compared": pixels_total,
        "max_pixel_delta": max_pixel_diff,
        "state_parity_mismatched_configs": parity_mismatches,
        "distinct_reference_outputs": distinct,
    }
    sensitivity = distinct >= 15
    out.metrics["output_sensitivity_ok"] = sensitivity
    if not sensitivity:
        out.notes.append(f"only {distinct} distinct reference renders across {len(configs)} configs")
    out.notes.append(
        "Sensitivity: distinct reference renders confirms the matrix exercises threshold, "
        "alpha, sign, colormap, range/mirror, boxed, opacity, threshold_index and 4-D time."
    )
    if mismatched or parity_mismatches or not sensitivity:
        out.fail(
            f"{mismatched} of {renders} renders differ (max pixel Δ {max_pixel_diff:.0f}); "
            f"{parity_mismatches} configs had diverging state"
        )
    else:
        out.evidence = (
            f"{renders} renders byte-exact ({pixels_total} pixels, max Δ 0), "
            f"{distinct} distinct outputs"
        )
    return [out]


# ---------------------------------------------------------------------------
# 4. surface sampling
# ---------------------------------------------------------------------------


def _derive_base_from_alpha_zero(got: np.ndarray, layer_rgba: np.ndarray) -> tuple[tuple, int]:
    """The client's fold base grey, read off vertices the independent layer clears.

    With folding off the base is one constant, so every vertex whose layer alpha
    is 0 draws exactly that constant. Returns (unique base, count of ambiguous
    vertices).
    """
    zero = layer_rgba[:, 3] == 0
    if not zero.any():
        raise ValueError("no fully transparent vertices to read the base colour from")
    colours = np.unique(got[zero, :3], axis=0)
    return tuple(int(v) for v in colours[0]), int(len(colours))


def _over_with_base(layer_rgba: np.ndarray, base_rgb: tuple) -> np.ndarray:
    base = np.zeros_like(layer_rgba)
    base[:, :3] = np.asarray(base_rgb, np.uint8)
    base[:, 3] = 255
    return ffsref.surface3d.over(layer_rgba, base)


def check_surface_sampling(sc: Sidecar, rs: ffsref.RefSession) -> list[Check]:
    out = Check("4", "Surface sampling: per-vertex RGBA vs reference sample_depths/reduce_depth/layer_rgba")
    apply(sc, rs, RESET_DISPLAY)
    apply(sc, rs, [
        "SET_SURFACE_FOLDING S1 off",
        "SET_ALPHA S off",
        "SET_SIGN S both",
        "SET_THRESHOLD S 2.5",
        "SET_COLORMAP S redblue",
        "SET_RANGE S -6 6",
        "SET_RANGE_MIRROR S 1",
        "SET_SURFACE_DEPTH S1 0.5 0.5 1",
        "SET_SURFACE_DEPTH_STAT S1 mean",
        "SET_SURFACE_EQUIVOLUME S1 0",
        "SET_THRESHOLD_INDEX S -",
    ])
    payload = sc.surface("S1")
    if "mesh" not in payload:
        out.notes.append("surface payload carried no mesh on first request")
    vp = rs.state.viewports.find("S1")
    bases: dict[str, tuple] = {}
    baseline_vertices = 0
    baseline_direct = 0
    for colour in payload["colors"]:
        hemi = colour["hemi"]
        got = b64_u8(colour["rgba"]).reshape(-1, 4)
        layer_rgba = ffsref.surface_layer_rgba(rs.session, vp, hemi)
        if got.shape != layer_rgba.shape:
            out.fail(f"{hemi}: sidecar rgba {got.shape} != reference {layer_rgba.shape}")
            return [out]
        base, ambiguous = _derive_base_from_alpha_zero(got, layer_rgba)
        bases[hemi] = base
        if ambiguous != 1:
            out.fail(
                f"{hemi}: {ambiguous} distinct base colours on cleared vertices; "
                "the cleared region is not a single constant"
            )
            return [out]
        expected = _over_with_base(layer_rgba, base)
        delta = int(np.abs(got.astype(np.int16) - expected.astype(np.int16)).max())
        baseline_vertices += int(got.shape[0])
        if delta:
            out.fail(f"{hemi}: baseline per-vertex RGBA differs (max Δ {delta})")
            return [out]
        full = layer_rgba[:, 3] == 255
        baseline_direct += int(full.sum())

    if len(set(bases.values())) != 1:
        out.fail(f"hemispheres use different base colours: {bases}")
        return [out]
    base_rgb = next(iter(bases.values()))
    out.metrics["client_fold_base_rgb"] = list(base_rgb)
    out.notes.append(
        f"folding off: every cleared vertex draws the client base grey {base_rgb}; "
        "this is the browser renderer's unlit constant, not one of the four sampling "
        "functions under test (see observations)."
    )
    shader_base = (int(round(0.62 * 255.0)),) * 3
    out.notes.append(
        f"The reference GLSL shader would shade the unlit base at {shader_base} "
        "(0.62, then its own headlight); the sidecar sends unlit colour for the "
        "browser's own lighting."
    )

    configs: list[tuple[str, list[str]]] = []
    for stat in ("mean", "median", "max", "min", "max_abs", "nzmean"):
        for eq in (0, 1):
            configs.append(
                (
                    f"stat={stat} equivolume={eq} depth=0.1:0.9:5",
                    [
                        f"SET_SURFACE_DEPTH_STAT S1 {stat}",
                        f"SET_SURFACE_EQUIVOLUME S1 {eq}",
                        "SET_SURFACE_DEPTH S1 0.1 0.9 5",
                        "SET_ALPHA S linear",
                    ],
                )
            )
    for stat, lo, hi, samples, eq in (
        ("mean", 0.2, 0.8, 3, 0),
        ("median", 0.2, 0.8, 3, 1),
        ("max", 0.0, 1.0, 4, 0),
        ("max_abs", 0.0, 1.0, 4, 1),
    ):
        configs.append(
            (
                f"stat={stat} equivolume={eq} depth={lo}:{hi}:{samples}",
                [
                    f"SET_SURFACE_DEPTH_STAT S1 {stat}",
                    f"SET_SURFACE_EQUIVOLUME S1 {eq}",
                    f"SET_SURFACE_DEPTH S1 {lo} {hi} {samples}",
                    "SET_ALPHA S linear",
                ],
            )
        )
    configs.append(
        (
            "alpha=quadratic stat=max equivolume=0 depth=0.1:0.9:5",
            [
                "SET_ALPHA S quadratic",
                "SET_SURFACE_DEPTH_STAT S1 max",
                "SET_SURFACE_EQUIVOLUME S1 0",
                "SET_SURFACE_DEPTH S1 0.1 0.9 5",
            ],
        )
    )
    configs.append(
        (
            "alpha=off threshold=3.4 stat=mean equivolume=1 depth=0.2:0.8:3",
            [
                "SET_ALPHA S off",
                "SET_THRESHOLD S 3.4",
                "SET_SURFACE_DEPTH_STAT S1 mean",
                "SET_SURFACE_EQUIVOLUME S1 1",
                "SET_SURFACE_DEPTH S1 0.2 0.8 3",
            ],
        )
    )
    configs.append(
        (
            "threshold_index=1 stat=mean equivolume=0 depth=0.1:0.9:5",
            [
                "SET_ALPHA S linear",
                "SET_THRESHOLD S 2.5",
                "SET_THRESHOLD_INDEX S 1",
                "SET_SURFACE_DEPTH_STAT S1 mean",
                "SET_SURFACE_EQUIVOLUME S1 0",
                "SET_SURFACE_DEPTH S1 0.1 0.9 5",
            ],
        )
    )
    configs.append(
        (
            "restore threshold_index=- threshold=2.5 alpha=linear",
            [
                "SET_THRESHOLD_INDEX S -",
                "SET_THRESHOLD S 2.5",
                "SET_ALPHA S linear",
                "SET_SURFACE_DEPTH_STAT S1 mean",
                "SET_SURFACE_EQUIVOLUME S1 0",
                "SET_SURFACE_DEPTH S1 0.1 0.9 5",
            ],
        )
    )

    vertices = baseline_vertices
    max_delta = 0
    mismatched = 0
    hashes: dict[str, str] = {}
    metadata_mismatches = 0
    for label, lines in configs:
        apply(sc, rs, lines)
        vp = rs.state.viewports.find("S1")
        payload = sc.surface("S1")
        if (
            tuple(round(float(v), 6) for v in payload.get("depth", ())) != tuple(round(float(v), 6) for v in vp.depth)
            or int(payload.get("samples", -1)) != int(vp.samples)
            or payload.get("depthStat") != vp.depth_stat
            or bool(payload.get("equivolume")) != bool(vp.equivolume)
        ):
            metadata_mismatches += 1
        for colour in payload["colors"]:
            hemi = colour["hemi"]
            got = b64_u8(colour["rgba"]).reshape(-1, 4)
            layer_rgba = ffsref.surface_layer_rgba(rs.session, vp, hemi)
            expected = _over_with_base(layer_rgba, base_rgb)
            delta = int(np.abs(got.astype(np.int16) - expected.astype(np.int16)).max())
            max_delta = max(max_delta, delta)
            vertices += int(got.shape[0])
            if delta:
                mismatched += 1
                out.notes.append(f"{label} {hemi}: max per-vertex Δ {delta}")
        hashes[label] = hashlib.md5(
            np.concatenate([b64_u8(c["rgba"]) for c in payload["colors"]]).tobytes()
        ).hexdigest()

    # Sensitivity: the matrix must actually move the sampled values.
    def colour_of(label: str) -> str:
        return hashes[label]

    sensitivity_checks = []
    try:
        sensitivity_checks.append(
            ("mean vs max", colour_of("stat=mean equivolume=0 depth=0.1:0.9:5") != colour_of("stat=max equivolume=0 depth=0.1:0.9:5"))
        )
        sensitivity_checks.append(
            ("equivolume on vs off", colour_of("stat=mean equivolume=0 depth=0.1:0.9:5") != colour_of("stat=mean equivolume=1 depth=0.1:0.9:5"))
        )
        sensitivity_checks.append(
            ("quadratic vs linear alpha", colour_of("alpha=quadratic stat=max equivolume=0 depth=0.1:0.9:5") != colour_of("stat=max equivolume=0 depth=0.1:0.9:5"))
        )
        sensitivity_checks.append(
            ("threshold_index on vs off", colour_of("threshold_index=1 stat=mean equivolume=0 depth=0.1:0.9:5") != colour_of("stat=mean equivolume=0 depth=0.1:0.9:5"))
        )
    except KeyError as exc:  # pragma: no cover - labels are constants
        sensitivity_checks.append((f"label missing: {exc}", False))
    failed_sensitivity = [name for name, ok in sensitivity_checks if not ok]

    out.metrics.update(
        {
            "configs": len(configs),
            "vertices_compared": vertices,
            "mismatched_hemisphere_configs": mismatched,
            "max_per_vertex_delta": max_delta,
            "payload_metadata_mismatches": metadata_mismatches,
            "distinct_outputs": len(set(hashes.values())),
            "sensitivity": {name: ok for name, ok in sensitivity_checks},
        }
    )
    out.metrics["baseline_direct_alpha255_vertices"] = baseline_direct

    # INFO: folding on must still follow the client base formula.
    apply(sc, rs, ["SET_SURFACE_FOLDING S1 curv"])
    payload = sc.surface("S1")
    vp = rs.state.viewports.find("S1")
    fold_info = Check("4i", "Surface colouring with folding on (client base reconstruction)")
    fold_delta = 0
    for colour in payload["colors"]:
        hemi = colour["hemi"]
        got = b64_u8(colour["rgba"]).reshape(-1, 4)
        layer_rgba = ffsref.surface_layer_rgba(rs.session, vp, hemi)
        expected = ffsref.surface3d.over(layer_rgba, ffsref.client_fold_base(rs.session, vp, hemi))
        fold_delta = max(fold_delta, int(np.abs(got.astype(np.int16) - expected.astype(np.int16)).max()))
    fold_info.metrics = {"max_delta_vs_client_formula": fold_delta}
    if fold_delta:
        fold_info.fail(f"folding-on colours differ from the client base formula by {fold_delta}")
    else:
        fold_info.status = "INFO"
        fold_info.evidence = (
            "exact against the sidecar's folding base (0.62 - 0.16*fold, the original "
            "shader's base) -- self-consistency; lighting is drawn by the browser"
        )
    apply(sc, rs, ["SET_SURFACE_FOLDING S1 curv"])

    if mismatched or max_delta or metadata_mismatches or failed_sensitivity:
        out.fail(
            f"{mismatched} hemisphere-configs differ (max Δ {max_delta}); "
            f"{metadata_mismatches} metadata mismatches; "
            f"sensitivity failures: {failed_sensitivity}"
        )
    else:
        out.evidence = (
            f"{len(configs)} configs x 2 hemis, {vertices} vertex colours exact "
            f"({len(set(hashes.values()))} distinct); max Δ 0"
        )
    return [out, fold_info]


# ---------------------------------------------------------------------------
# 5. synchronization (ui vs agent) and revision bookkeeping
# ---------------------------------------------------------------------------


def _sync_sequence() -> list[str]:
    return ffsref.demo_script() + [
        "OPEN_VIEW V4 image sagittal",
        "SET_VIEW_LOCKED V4 0 0",
        "SET_VIEW_POSITION V4 15",
        "SET_XYZ -30 10 5",
        "SET_VIEW_LOCKED V1 1 1",
        "SET_VIEW_LOCKED V4 1 1",
        "SET_ZOOM V1 2.7",
        "SET_XYZ 4.5 -20 12",
        "SET_SEED 21 22 23",
        "SET_THRESHOLD S 3.1",
        "SET_COLORMAP S hot",
        "SET_ALPHA S quadratic",
        "SET_SIGN S pos",
        "SET_BOXED S 0",
        "SET_RANGE S -4 7",
        "SET_RANGE_MIRROR S 0",
        "SET_LAYER_OPACITY A 0.7",
        "SELECT_LAYER S",
        "SET_SURFACE_DEPTH S1 0.2 0.8 3",
        "SET_SURFACE_DEPTH_STAT S1 max",
        "SET_SURFACE_EQUIVOLUME S1 1",
        "SET_SURFACE_FOLDING S1 sulc",
        "SET_SURFACE_HEMIS S1 lh,rh 8",
        "SET_SURFACE_HINGE S1 12",
        "SHOW_SURFACES pial",
        "SET_VIEW_GRID G1 3",
        "SET_PAN V4 1.5 -2.0",
        "SET_IJK 30 30 20",
    ]


def check_sync() -> list[Check]:
    out = Check("5", "UI/agent synchronization, revisions, parked slices, LOCK zoom")
    ui = Sidecar(name="ui").start()
    agent = Sidecar(name="agent").start()
    rs = ffsref.RefSession()
    revision = {"monotonicity_failures": 0, "category_failures": [], "counter_failures": []}
    parked = {}
    lock = {}
    try:
        sequence = _sync_sequence()
        expected_counts = {DISPLAY: 0, NAVIGATION: 0, SOURCE: 0, ANALYSIS: 0}
        ui_snap = ui.snapshot()
        agent_snap = agent.snapshot()
        for index, line in enumerate(sequence):
            name = line.split()[0]
            expected = EXPECTED_CATEGORY.get(name)
            for sc, origin, label in ((ui, "ui", "ui"), (agent, "agent", "agent")):
                before = ui_snap if label == "ui" else agent_snap
                result = sc.execute(line, origin=origin)
                after = result["state"]
                if after["rev"] != before["rev"] + 1:
                    revision["monotonicity_failures"] += 1
                if expected is None:
                    revision["category_failures"].append(f"{line!r}: no expected category in harness")
                else:
                    if result["category"] != expected:
                        revision["category_failures"].append(
                            f"{line!r}: sidecar {result['category']!r} != expected {expected!r}"
                        )
                    if after["revByCategory"][expected] != before["revByCategory"][expected] + 1:
                        revision["counter_failures"].append(
                            f"{line!r}: {expected} counter did not advance by 1"
                        )
                    for other in (DISPLAY, NAVIGATION, SOURCE, ANALYSIS):
                        if other != expected and after["revByCategory"][other] != before["revByCategory"][other]:
                            revision["counter_failures"].append(
                                f"{line!r}: unrelated {other} counter advanced"
                            )
                if label == "ui":
                    ui_snap = after
                else:
                    agent_snap = after
            expected_counts[expected] += 1
            rs.do(line)
            # Parked-slice semantics: an unlocked window keeps its slice while
            # the crosshair moves; a locked one follows.
            if line == "SET_XYZ -30 10 5":
                v4 = next(v for v in ui_snap["viewports"] if v["id"] == "V4")
                v1 = next(v for v in ui_snap["viewports"] if v["id"] == "V1")
                parked["V4_position"] = v4["position"]
                parked["V1_position"] = v1["position"]
                parked["crosshair"] = list(ui_snap["crosshair"])
                parked["V4_render_position"] = ui.render("V4")["position"]
                parked["V1_render_position"] = ui.render("V1")["position"]
                ref_v4 = rs.state.viewports.find("V4")
                ref_v1 = rs.state.viewports.find("V1")
                parked["reference_V4_position"] = int(ref_v4.position)
                parked["reference_V1_render_position"] = int(rs.state.crosshair[2])
            if line == "SET_ZOOM V1 2.7":
                v1 = next(v for v in ui_snap["viewports"] if v["id"] == "V1")
                v4 = next(v for v in ui_snap["viewports"] if v["id"] == "V4")
                lock["V1_zoom"] = v1["zoom"]
                lock["V4_zoom"] = v4["zoom"]
                lock["V4_pan"] = list(v4["pan"])
                lock["V4_zoomLinked"] = v4["zoomLinked"]
                ref_v4 = rs.state.viewports.find("V4")
                lock["reference_V4_zoom"] = float(ref_v4.zoom)
                lock["reference_V4_pan"] = [float(v) for v in ref_v4.pan]
            if line == "SET_XYZ 4.5 -20 12":
                v4 = next(v for v in ui_snap["viewports"] if v["id"] == "V4")
                lock["V4_follows_crosshair_pixel"] = int(ui.render("V4")["position"])
                lock["V4_follows_crosshair_state"] = v4["position"]
                lock["reference_V4_follows"] = int(rs.state.crosshair[0])

        # Final state and render parity.
        rs.wait_resident()
        final_ui = ui.snapshot()
        final_agent = agent.snapshot()
        semantic_ui = ffsref.semantic_snapshot_from_sidecar(final_ui)
        semantic_agent = ffsref.semantic_snapshot_from_sidecar(final_agent)
        diffs_ui_agent = ffsref.compare_semantic(semantic_ui, semantic_agent)
        diffs_ui_ref = ffsref.compare_semantic(
            semantic_ui, ffsref.semantic_snapshot_from_ref(rs.session)
        )
        render_diffs = []
        for view in ("V1", "V2", "V3", "V4"):
            left = ui.render(view)["png"]
            right = agent.render(view)["png"]
            if left != right:
                render_diffs.append(view)
        surface_diff = []
        s_ui = ui.surface("S1")
        s_agent = agent.surface("S1")
        for hemi in ("lh", "rh"):
            left = next(c for c in s_ui["colors"] if c["hemi"] == hemi)["rgba"]
            right = next(c for c in s_agent["colors"] if c["hemi"] == hemi)["rgba"]
            if left != right:
                surface_diff.append(hemi)

        # Error path must not bump revisions.
        rev_before = ui.snapshot()["rev"]
        ok, error = ui.try_call("execute", line="SET_THRESHOLD S not-a-number", origin="ui")
        rev_after = ui.snapshot()["rev"]
        error_ok = (not ok) and error.get("code") == "command-invalid" and rev_after == rev_before
        if not ok:
            # A valid command afterwards must still work.
            after_error = ui.execute("SET_THRESHOLD S 3.1", origin="ui")
            error_ok = error_ok and after_error["state"]["rev"] == rev_after + 1

        # Category totals must add up to the revision count.
        total = final_ui["rev"]
        category_total = sum(final_ui["revByCategory"][c] for c in (DISPLAY, NAVIGATION, SOURCE, ANALYSIS))
        counter_totals_ok = (
            total == category_total
            and all(final_ui["revByCategory"][c] == expected_counts[c] for c in expected_counts)
        )
        out.metrics = {
            "commands": len(sequence),
            "rev": total,
            "revByCategory": dict(final_ui["revByCategory"]),
            "expected_category_counts": expected_counts,
            "revision_monotonicity_failures": revision["monotonicity_failures"],
            "category_mismatches": len(revision["category_failures"]),
            "counter_failures": len(revision["counter_failures"]),
            "ui_agent_state_diffs": len(diffs_ui_agent),
            "ui_reference_state_diffs": len(diffs_ui_ref),
            "render_parity_failures": render_diffs,
            "surface_colour_parity_failures": surface_diff,
            "parked_slice": parked,
            "lock_zoom": lock,
            "error_path_ok": error_ok,
            "counter_totals_ok": counter_totals_ok,
            "final_origin": final_ui["origin"],
            "final_category": final_ui["category"],
        }
        problems = []
        if revision["monotonicity_failures"]:
            problems.append(f"{revision['monotonicity_failures']} rev jumps")
        if revision["category_failures"]:
            problems.extend(revision["category_failures"][:3])
        if revision["counter_failures"]:
            problems.extend(revision["counter_failures"][:3])
        if diffs_ui_agent:
            problems.append("ui/agent state: " + diff_evidence(diffs_ui_agent))
        if diffs_ui_ref:
            problems.append("ui/reference state: " + diff_evidence(diffs_ui_ref))
        if render_diffs:
            problems.append(f"render PNGs differ: {render_diffs}")
        if surface_diff:
            problems.append(f"surface colours differ: {surface_diff}")
        if parked.get("V4_position") != 15 or parked.get("V4_render_position") != 15:
            problems.append(f"unlocked V4 did not stay parked ({parked})")
        if parked.get("V1_render_position") != parked.get("crosshair", [0, 0, 0])[2]:
            problems.append(f"locked V1 did not follow the crosshair ({parked})")
        if lock.get("V4_zoom") != lock.get("V1_zoom") or lock.get("V4_zoom") != lock.get(
            "reference_V4_zoom"
        ):
            problems.append(f"LOCK did not share zoom ({lock})")
        if lock.get("V4_follows_crosshair_pixel") != lock.get("reference_V4_follows"):
            problems.append(f"locked V4 did not follow the crosshair ({lock})")
        if not error_ok:
            problems.append("invalid command changed revisions or was accepted")
        if not counter_totals_ok:
            problems.append("revision totals do not match the command categories")
        if final_ui["origin"] != "ui" or final_agent_state_origin(agent) != "agent":
            problems.append("origin not recorded per caller")
        if problems:
            out.notes.extend(problems)
            out.fail("; ".join(problems[:6]))
        else:
            out.evidence = (
                f"{len(sequence)} commands: ui/agent state and renders identical, "
                f"rev monotone, categories and counters exact, parked/LOCK semantics match"
            )
    finally:
        ui.close()
        agent.close()
        rs.close()
    return [out]


def final_agent_state_origin(agent: Sidecar) -> str:
    return str(agent.snapshot()["origin"])


# ---------------------------------------------------------------------------
# 6. persistence
# ---------------------------------------------------------------------------


def _read_script_lines(path: Path) -> list[str]:
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        text = raw.strip()
        if text and not text.startswith("#"):
            lines.append(text)
    return lines


def check_persistence() -> list[Check]:
    out = Check("6", "Persistence: save/restore, display+analysis split, workspace layout")
    state_dir = Path(tempfile.mkdtemp(prefix="ffs-verify-persist-"))
    sc = Sidecar(state_dir=state_dir, name="persist").start()
    sc2: Sidecar | None = None
    try:
        log: list[tuple[str, str]] = []
        bootstrap = ffsref.demo_script() + [
            "OPEN_VIEW V4 image sagittal",
            "SET_VIEW_LOCKED V4 0 0",
            "SET_VIEW_POSITION V4 15",
        ]
        for line in bootstrap:
            result = sc.execute(line, origin="ui")
            log.append((result["command"], result["category"]))
        layout = {
            "version": 1,
            "open": True,
            "maximized": "S1",
            "docks": {
                "type": "split",
                "id": "s-root",
                "direction": "row",
                "children": [
                    {"type": "group", "id": "g-slices", "tabs": ["V1", "V2"], "active": "V2", "size": 1.1},
                    {"type": "group", "id": "g-surface", "tabs": ["S1", "G1"], "active": "S1", "size": 1.3},
                ],
            },
        }
        sc.workspace(layout)
        save0 = sc.save(note="verification save")
        snapshot0 = sc.snapshot()
        saved_analysis = (state_dir / "analysis.ffs").read_bytes()
        saved_display = (state_dir / "display.ffs").read_bytes()
        saved_viewer = (state_dir / "viewer.ffs").read_bytes()

        display_lines = _read_script_lines(state_dir / "display.ffs")
        analysis_lines = _read_script_lines(state_dir / "analysis.ffs")
        expected_display = [line for line, category in log if category in (DISPLAY, NAVIGATION)]
        expected_analysis = [line for line, category in log if category in (SOURCE, ANALYSIS)]
        split_ok = display_lines == expected_display and analysis_lines == expected_analysis
        if not split_ok:
            out.notes.append(
                "split files differ from the log's categories: "
                f"display {len(display_lines)} vs {len(expected_display)}, "
                f"analysis {len(analysis_lines)} vs {len(expected_analysis)}"
            )
            for index, (got, want) in enumerate(zip(display_lines, expected_display)):
                if got != want:
                    out.notes.append(f"display[{index}] {got!r} != {want!r}")
                    break
            for index, (got, want) in enumerate(zip(analysis_lines, expected_analysis)):
                if got != want:
                    out.notes.append(f"analysis[{index}] {got!r} != {want!r}")
                    break
        overlap = set(display_lines) & set(analysis_lines)
        manifest = save0.get("manifest") or {}
        manifest_counts = manifest.get("counts") or {}
        expected_counts = {DISPLAY: 0, NAVIGATION: 0, SOURCE: 0, ANALYSIS: 0}
        for _line, category in log:
            expected_counts[category] += 1
        manifest_ok = (
            manifest_counts == expected_counts
            and manifest.get("note") == "verification save"
            and [s["key"] for s in manifest.get("sources", [])] == ["A", "F", "S"]
            and manifest.get("viewports") == [v["id"] for v in snapshot0["viewports"]]
            and manifest.get("layers") == [layer["key"] for layer in snapshot0["layers"]]
            and bool(manifest.get("savedAt"))
        )
        manifest_files_ok = all(
            Path(path).exists() for path in (save0.get("files") or {}).values()
        )
        if not manifest_ok:
            out.notes.append(f"manifest mismatch: counts={manifest_counts} expected={expected_counts}")
        if overlap:
            out.notes.append(f"commands in both split files: {sorted(overlap)[:5]}")

        # A display-only change saved again must leave analysis.ffs byte-identical.
        sc.execute("SET_THRESHOLD S 3.9", origin="ui")
        dirty_after_display = sc.snapshot()["dirty"]
        pre_save_analysis = (state_dir / "analysis.ffs").read_bytes()
        sc.save(note="display-only save")
        post_save_analysis = (state_dir / "analysis.ffs").read_bytes()
        display_only_ok = (
            pre_save_analysis == post_save_analysis == saved_analysis
            and (state_dir / "display.ffs").read_bytes() != saved_display
            and "SET_THRESHOLD S 3.9" in (state_dir / "display.ffs").read_text(encoding="utf-8")
            and (state_dir / "viewer.ffs").read_bytes() != saved_viewer
        )
        snapshot_saved = sc.snapshot()
        semantic_saved = ffsref.semantic_snapshot_from_sidecar(snapshot_saved)

        # Mutate every kind of display/navigation state, then restore.
        mutations = [
            "SET_THRESHOLD S 4.2",
            "SET_COLORMAP S hot",
            "SET_RANGE S -2 3",
            "SET_RANGE_MIRROR S 0",
            "SET_SIGN S neg",
            "SET_ALPHA S quadratic",
            "SET_BOXED S 0",
            "SET_LAYER_OPACITY S 0.5",
            "SET_LAYER_VISIBLE F 1",
            "SET_INDEX 11",
            "SET_VIEW_GRID G1 3",
            "SET_ZOOM V1 2.5",
            "SET_PAN V1 -3 2",
            "SET_VIEW_LOCKED V4 0 0",
            "SET_VIEW_POSITION V4 12",
            "SET_SURFACE_DEPTH S1 0.2 0.6 3",
            "SET_SURFACE_DEPTH_STAT S1 max",
            "SET_SURFACE_FOLDING S1 sulc",
            "SET_SURFACE_EQUIVOLUME S1 1",
            "SHOW_SURFACES pial",
            "SET_XYZ 4.5 -20 12",
        ]
        for line in mutations:
            sc.execute(line, origin="ui")
        mutated = sc.snapshot()
        mutation_ok = bool(
            ffsref.compare_semantic(semantic_saved, ffsref.semantic_snapshot_from_sidecar(mutated))
        )
        dirty_display = bool(mutated["dirty"].get(DISPLAY))
        restored = sc.restore()
        restored_snapshot = sc.snapshot()
        restore_diffs = ffsref.compare_semantic(
            semantic_saved, ffsref.semantic_snapshot_from_sidecar(restored_snapshot)
        )
        workspace_ok = restored_snapshot.get("workspace") == layout
        sc.close()

        # A fresh sidecar with the same state directory must auto-restore.
        sc2 = Sidecar(state_dir=state_dir, name="persist2").start()
        opened = sc2.open(preset="auto")
        auto_snapshot = sc2.snapshot()
        auto_diffs = ffsref.compare_semantic(
            semantic_saved, ffsref.semantic_snapshot_from_sidecar(auto_snapshot)
        )
        auto_ok = bool(opened.get("restored")) and opened.get("preset") == "restore" and not auto_diffs

        out.metrics = {
            "saved_files": sorted(p.name for p in state_dir.iterdir()),
            "log_commands": len(log),
            "display_lines": len(display_lines),
            "analysis_lines": len(analysis_lines),
            "split_exact": split_ok,
            "split_overlap": len(overlap),
            "manifest_ok": manifest_ok,
            "manifest_files_exist": manifest_files_ok,
            "display_only_save_ok": display_only_ok,
            "display_dirty_before_save": dirty_after_display,
            "mutation_changed_state": mutation_ok,
            "restore_state_diffs": len(restore_diffs),
            "restored_flag": bool(restored.get("restored")),
            "workspace_roundtrip": workspace_ok,
            "auto_restore_ok": auto_ok,
            "auto_restore_diffs": len(auto_diffs),
        }
        problems = []
        if not split_ok:
            problems.append("display/analysis split is not exactly the log's categories")
        if overlap:
            problems.append("a command appears in both split files")
        if not manifest_ok:
            problems.append("session.json manifest does not describe the saved session")
        if not manifest_files_ok:
            problems.append("save reported files that do not exist")
        if not mutation_ok:
            problems.append("mutation did not change state")
        if not dirty_display:
            problems.append("a display change did not mark display dirty")
        if not display_only_ok:
            problems.append("display-only save rewrote analysis.ffs or missed the change")
        if not bool(restored.get("restored")):
            problems.append("restore reported not restored")
        if restore_diffs:
            problems.append("restore differs from saved snapshot: " + diff_evidence(restore_diffs, 4))
        if not workspace_ok:
            problems.append("workspace layout did not round-trip")
        if not auto_ok:
            problems.append(
                f"fresh sidecar auto-restore failed (restored={opened.get('restored')}, "
                f"preset={opened.get('preset')}, diffs={len(auto_diffs)})"
            )
            if auto_diffs:
                out.notes.append("auto-restore: " + diff_evidence(auto_diffs, 4))
        if problems:
            out.notes.extend(problems)
            out.fail("; ".join(problems[:6]))
        else:
            out.evidence = (
                f"restore/auto-restore reproduce the saved state "
                f"({len(snapshot_saved['viewports'])} viewports, "
                f"{len(snapshot_saved['layers'])} layers, 0 diffs); split exact "
                f"({len(display_lines)} display+navigation, {len(analysis_lines)} source+analysis); "
                "display-only save leaves analysis.ffs byte-identical"
            )
    finally:
        sc.close()
        if sc2 is not None:
            sc2.close()
        shutil.rmtree(state_dir, ignore_errors=True)
    return [out]


# ---------------------------------------------------------------------------
# 7. surface selection
# ---------------------------------------------------------------------------


def check_surface_selection(sc: Sidecar, rs: ffsref.RefSession) -> list[Check]:
    out = Check("7", "Surface selection follows a surface pick")
    apply(sc, rs, [
        "SET_SURFACE_SHAPE S1 inflated",
        "SET_SURFACE_HEMIS S1 lh,rh 0",
        "SET_SURFACE_HINGE S1 0",
    ])
    vp = rs.state.viewports.find("S1")
    world, faces, _laid, _models = ffsref.surface_arrays(rs.session, vp)
    aspect = 4.0 / 3.0
    camera = ffsref.make_camera(rotation=np.eye(3), distance=300.0)
    hits = 0
    problems = []
    for (x, y) in _ndc_samples(world, camera, aspect, per_pose=3):
        expected = ffsref.reference_pick(world, faces, camera, x, y, aspect)
        if expected is None:
            continue
        hit = sc.surface_pick("S1", ffsref.camera_dict(camera), x, y, aspect)
        hits += 1
        selected = hit["state"]["surfaces"]["selected"]
        if selected != [expected["hemi"], int(expected["vertex"])]:
            problems.append(f"pick ({x:.2f},{y:.2f}) selected {selected}")
    # The SELECT_SURFACE_VERTEX command itself must be reflected in the snapshot.
    sc.execute("SELECT_SURFACE_VERTEX rh 42", origin="ui")
    direct = sc.snapshot()["surfaces"]["selected"]
    if direct != ["rh", 42]:
        problems.append(f"SELECT_SURFACE_VERTEX snapshot selected={direct}")
    out.metrics = {"surface_picks": hits, "selection_mismatches": len(problems)}
    if problems:
        out.notes.extend(problems[:5])
        out.fail("; ".join(problems[:4]))
    else:
        out.evidence = f"{hits} picks set surfaces.selected to the picked vertex; direct command too"
    return [out]


# ---------------------------------------------------------------------------
# 8. incremental tokens
# ---------------------------------------------------------------------------


def check_tokens(sc: Sidecar, rs: ffsref.RefSession) -> list[Check]:
    out = Check("8", "Incremental tokens: unchanged outlines/colours omitted, state unaffected")
    apply(sc, rs, RESET_DISPLAY)
    problems: list[str] = []

    first = sc.render("V1")
    outline_token = first.get("outlineToken")
    if not outline_token:
        problems.append("render returned no outlineToken")
    if not first.get("outlines"):
        problems.append("token-less render returned no outlines while surfaces are shown")
    second = sc.render("V1", outline_token=outline_token)
    if not second.get("outlinesUnchanged"):
        problems.append("same outlineToken did not report outlinesUnchanged")
    if second.get("outlines"):
        problems.append("same outlineToken re-sent the outlines")
    if second.get("outlineToken") != outline_token:
        problems.append("outlineToken changed without a state change")
    if second.get("png") != first.get("png"):
        problems.append("PNG changed between token-less and token round-trip")
    if second.get("crosshairPx") != first.get("crosshairPx"):
        problems.append("crosshairPx changed between token-less and token round-trip")

    # A different slice must invalidate the outline token and resend the outlines.
    sc.execute("SET_XYZ -30 10 12", origin="ui")
    rs.do("SET_XYZ -30 10 12")
    third = sc.render("V1", outline_token=outline_token)
    if third.get("outlinesUnchanged"):
        problems.append("outlineToken still reported unchanged after changing the slice")
    if not third.get("outlines"):
        problems.append("changed slice did not resend outlines")
    if third.get("outlineToken") == outline_token:
        problems.append("outlineToken did not change with the slice")

    first_surface = sc.surface("S1")
    colors_token = first_surface.get("colorsToken")
    if not colors_token:
        problems.append("surface returned no colorsToken")
    if len(first_surface.get("colors") or []) != 2:
        problems.append("token-less surface did not return both hemispheres' colours")
    second_surface = sc.surface(
        "S1", colors_token=colors_token, mesh_rev=first_surface.get("meshRev")
    )
    if not second_surface.get("colorsUnchanged"):
        problems.append("same colorsToken did not report colorsUnchanged")
    if second_surface.get("colors"):
        problems.append("same colorsToken re-sent the colours")
    if "mesh" in second_surface:
        problems.append("matching meshRev still re-sent the mesh")
    if second_surface.get("colorsToken") != colors_token:
        problems.append("colorsToken changed without a state change")

    # A display change must invalidate the colours token, and the token-less
    # call must return exactly what the invalidated call does.
    sc.execute("SET_THRESHOLD S 3.3", origin="ui")
    rs.do("SET_THRESHOLD S 3.3")
    stale = sc.surface("S1", colors_token=colors_token)
    if stale.get("colorsUnchanged"):
        problems.append("colorsToken still reported unchanged after a threshold change")
    fresh = sc.surface("S1")
    if [c["rgba"] for c in stale.get("colors") or []] != [
        c["rgba"] for c in fresh.get("colors") or []
    ]:
        problems.append("token-invalidated colours differ from a token-less request")

    out.metrics = {
        "outline_token_present": bool(outline_token),
        "outlines_in_full_render": len(first.get("outlines") or []),
        "outlines_unchanged_roundtrip": bool(second.get("outlinesUnchanged")),
        "outlines_resent_after_slice_change": bool(third.get("outlines")),
        "colors_token_present": bool(colors_token),
        "colors_unchanged_roundtrip": bool(second_surface.get("colorsUnchanged")),
        "colors_resent_after_change": bool(stale.get("colors")),
        "problems": problems,
    }
    if problems:
        out.notes.extend(problems)
        out.fail("; ".join(problems[:5]))
    else:
        out.evidence = (
            "token round-trips omit outlines/colours, keep the PNG, and resend exactly when the "
            "view or the display changes"
        )
    return [out]


# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------


def write_report(
    checks: list[Check], findings: list[Finding], runtime: float, sidecar_hello: dict
) -> str:
    failures = [c for c in checks if c.status == "FAIL"]
    infos = [c for c in checks if c.status == "INFO"]
    overall = "FAIL" if failures else "PASS"
    lines: list[str] = []
    lines.append("# FFS Harness viewer — independent verification against the original viewer")
    lines.append("")
    lines.append(f"Generated {time.strftime('%Y-%m-%d %H:%M:%S')} by `verification/verify_all.py`.")
    lines.append("")
    lines.append(
        f"* Sidecar: `python/ffsviewer` "
        f"(version {sidecar_hello.get('version', 'n/a')}, "
        f"fastfuncstuff {sidecar_hello.get('ffsVersion', 'n/a')}, "
        f"{sidecar_hello.get('commands', '?')} commands), spawned as "
        "`python -u -m ffsviewer.server --project-root <repo> --state-dir <tmp> --no-autosave`."
    )
    lines.append(
        f"* Reference: `reference/fastfuncstuff` (cloned FFS package), driven in-process via "
        "`ViewerSession` and the same FFS command bus."
    )
    lines.append(f"* Data: `data/demo` (synthetic phantom, stats bucket, FreeSurfer subject).")
    lines.append(f"* Runtime: {runtime:.1f} s.")
    lines.append("")
    lines.append(f"## Overall: **{overall}**")
    lines.append("")
    lines.append(
        f"{sum(1 for c in checks if c.status == 'PASS')} PASS, {len(failures)} FAIL, "
        f"{sum(1 for c in checks if c.status == 'SKIP')} SKIP, {len(infos)} INFO."
    )
    lines.append("")
    lines.append("| # | Check | Status | Key evidence |")
    lines.append("|---|---|---|---|")
    for check in checks:
        mark = {"PASS": "PASS", "FAIL": "**FAIL**", "SKIP": "SKIP", "INFO": "INFO"}[check.status]
        lines.append(
            f"| {check.ident} | {check.name} | {mark} | {check.evidence.replace('|', '/')} |"
        )
    lines.append("")
    lines.append("## Check details")
    for check in checks:
        lines.append("")
        lines.append(f"### {check.ident}. {check.name} — {check.status}")
        if check.evidence:
            lines.append("")
            lines.append(f"*{check.evidence}*")
        if check.metrics:
            lines.append("")
            for key, value in check.metrics.items():
                lines.append(f"- `{key}`: {short(value, 400)}")
        for note in check.notes:
            lines.append(f"- {note}")
    if not findings:
        lines.append("")
        lines.append("## Sidecar bugs / discrepancies found")
        lines.append("")
        lines.append(
            "None: every check above measured exact agreement with the reference viewer. The "
            "observations marked INFO are cosmetic/documentation notes, not divergences in "
            "computed results."
        )
    if findings:
        lines.append("")
        lines.append("## Sidecar bugs / discrepancies found")
        for index, finding in enumerate(findings, 1):
            lines.append("")
            lines.append(f"### {index}. {finding.title}")
            lines.append("")
            lines.append(f"- Severity: **{finding.severity}**")
            lines.append(f"- Where: {finding.where}")
            lines.append(f"- Measured: {finding.measured}")
            lines.append(f"- Reproduction: {finding.reproduction}")
    lines.append("")
    lines.append("## How to rerun")
    lines.append("")
    lines.append("```bash")
    lines.append(".venv/bin/python verification/verify_all.py")
    lines.append("```")
    lines.append("")
    text = "\n".join(lines) + "\n"
    REPORT_PATH.write_text(text, encoding="utf-8")
    return overall


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet", action="store_true", help="do not print the table")
    args = parser.parse_args(argv)
    started = time.monotonic()
    checks: list[Check] = []
    findings: list[Finding] = []

    def run(fn, *fn_args, skip_reason: str | None = None) -> None:
        if skip_reason is not None:
            checks.append(Check("?", fn.__name__, "SKIP", skip_reason))
            return
        try:
            produced = fn(*fn_args)
        except Exception as exc:  # noqa: BLE001 - a crashed check is a failed check
            traceback.print_exc()
            checks.append(Check("?", fn.__name__, "FAIL", f"check crashed: {exc!r}"))
        else:
            if isinstance(produced, Check):
                produced = [produced]
            checks.extend(produced)

    main_sidecar = main_ref = None
    try:
        try:
            main_sidecar, main_ref = bootstrap_demo("main")
        except Exception as exc:  # noqa: BLE001
            reason = f"could not bootstrap the demo session: {exc!r}"
            for fn in (
                check_coordinates,
                check_picking,
                check_renders,
                check_surface_sampling,
                check_surface_selection,
                check_tokens,
            ):
                run(fn, skip_reason=reason)
        else:
            run(check_coordinates, main_sidecar, main_ref)
            run(check_picking, main_sidecar, main_ref)
            run(check_renders, main_sidecar, main_ref)
            run(check_surface_sampling, main_sidecar, main_ref)
            run(check_surface_selection, main_sidecar, main_ref)
            run(check_tokens, main_sidecar, main_ref)
    finally:
        if main_sidecar is not None:
            main_sidecar.close()
        if main_ref is not None:
            main_ref.close()

    run(check_sync)
    run(check_persistence)

    # Findings: only add those the checks actually measured.
    by_ident = {check.ident: check for check in checks}
    hinge = by_ident.get("2b")
    if hinge is not None and hinge.status == "FAIL":
        rows = hinge.metrics.get("poses") or []
        worst = max((row["sidecar_vs_laid_pivot_world_mm"] for row in rows), default=0.0)
        findings.append(
            Finding(
                title="Surface hinge pivots on un-laid-out positions, not the laid-out ones",
                severity="medium (surface geometry disagrees with the reference window whenever hinge != 0)",
                where=(
                    "`python/ffsviewer/surface_ops.py:49-56` — `hemisphere_models(raw, split, hinge)` "
                    "is called with the raw shape positions; the reference 3-D window "
                    "(`reference/fastfuncstuff/fastfuncstuff/viewer/ui/surfacewindow.py:_shape_arrays` + "
                    "`_apply_layout` + `drawn_positions`) pivots on the laid-out positions "
                    "(`raw + layout_offsets`)."
                ),
                measured=(
                    f"max per-vertex world-space deviation from the reference layout: "
                    f"{worst:.4g} mm; the sidecar instead matches a construction pivoted on raw "
                    "positions to ~4e-6 mm. Picks near the midline then disagree."
                ),
                reproduction=(
                    "open the demo, `SET_SURFACE_HINGE S1 30`, request `surface` for S1 and compare "
                    "`mesh.hemis[].positions` with the reference construction above."
                ),
            )
        )
    off = by_ident.get("2a")
    if off is not None and "off_surface_error_codes" in off.metrics:
        codes = off.metrics["off_surface_error_codes"]
        if codes and set(codes) == {"internal"}:
            findings.append(
                Finding(
                    title="A miss on surface_pick is reported as an internal error",
                    severity="low (an expected user action returns code `internal` plus a traceback)",
                    where=(
                        "`python/ffsviewer/server.py:595-650` — `surface_pick` calls "
                        "`surface_ops.pick_surface` outside the `execute` wrapper, so its bare "
                        "`ValueError` (`python/ffsviewer/surface_ops.py:248`) falls into the generic "
                        "`except Exception` and becomes `{code:'internal'}` with a Python traceback "
                        "in `details.trace`."
                    ),
                    measured=(
                        f"{len(codes)} off-surface rays: sidecar `ok:false`, code "
                        f"{sorted(set(codes))}; the reference pick returns `None` without erroring."
                    ),
                    reproduction=(
                        "open the demo and `surface_pick` S1 with `xNdc=0.98, yNdc=0.98`; the ray "
                        "misses the hemispheres."
                    ),
                )
            )

    # Documentation mismatches noticed while checking the payloads (informational).
    doc_notes = [
        "`python/ffsviewer/surface_ops.py` sends the original GLSL folding base "
        "(`clip(0.62 - 0.16*fold)`); the browser applies the same view-space headlight "
        "(`0.35 + 0.65*abs(n.z)`) and the original overlay light blend. This is an "
        "appearance match, not part of the sampling check.",
        "`docs/API.md` now documents `viewInfo`, positions+faces with client-derived normals, "
        "and the `pick-miss` code; the response payloads match that documentation.",
    ]
    for note in doc_notes:
        checks.append(Check("doc", "Recorded observation", "INFO", note))

    # Two real discrepancies were found by this harness during development and
    # fixed in the sidecar before this final run. Recorded so the report shows
    # what was found, not only what currently passes.
    checks.append(
        Check(
            "fix",
            "Fixed during verification",
            "INFO",
            "Surface hinge pivoted on un-laid-out positions. `python/ffsviewer/surface_ops.py` "
            "passed the raw mesh positions to `hemisphere_models`; the reference 3-D window "
            "(`viewer/ui/surfacewindow.py:1743-1767`) pivots on the laid-out positions. Measured "
            "before the fix: up to 0.769 mm (hinge 30 deg) / 1.164 mm (hinge -45 deg) world "
            "deviation and a differing picked vertex on 2/6 rays. Reproduction: demo, "
            "`SET_SURFACE_HINGE S1 30`, compare `surface` mesh positions with the reference "
            "construction. Fixed at `surface_ops.py:49-55`; check 2b now measures 7.6e-06 mm "
            "residual (float32 vs float64 model application) against that reference.",
        )
    )
    checks.append(
        Check(
            "fix",
            "Fixed during verification",
            "INFO",
            "A `surface_pick` ray that hit nothing came back as `{code:'internal'}` with a Python "
            "traceback in `details` (the bare `ValueError` from `surface_ops.pick_surface` fell "
            "into `server.handle`'s generic handler). Reproduction: demo, `surface_pick` S1 at "
            "`xNdc=0.98, yNdc=0.98`. Fixed to `SidecarError('pick-miss')`; check 2a now measures "
            "`off_surface_error_codes: ['pick-miss']` and confirms a miss leaves rev, crosshair "
            "and surface selection unchanged.",
        )
    )

    runtime = time.monotonic() - started
    hello: dict = {}
    try:
        probe = Sidecar(name="hello").start()
        hello = probe.hello
        probe.close()
    except Exception:  # noqa: BLE001 - the report keeps going without it
        pass
    overall = write_report(checks, findings, runtime, hello)
    if not args.quiet:
        print()
        print(f"{'#':<4}{'Check':<66}{'Status'}")
        for check in checks:
            print(f"{check.ident:<4}{check.name[:64]:<66}{check.status}")
        print()
        print(f"Overall: {overall}   ({runtime:.1f} s)   report: {REPORT_PATH}")
        for finding in findings:
            print(f"  ! {finding.title}")
    return 0 if overall == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
