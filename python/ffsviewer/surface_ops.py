"""Surface geometry, colouring and picking, all computed by FFS code.

The browser is a renderer: it receives world-space meshes in scanner mm and one RGBA
per vertex, draws them, and asks the sidecar to resolve every click back to a vertex
with ``fastfuncstuff.viewer.surface3d.pick``. Sampling is the original viewer's own
pipeline: ``surface.profiles.sample_depths`` (equivolume white→pial), reduced by
``surface3d.reduce_depth`` and coloured by ``surfacelayers.layer_rgba``, so a threshold
on a surface reads exactly as it does on a slice.
"""

from __future__ import annotations

import base64
import hashlib

import numpy as np

from fastfuncstuff.viewer import surface3d, surfacelayers
from fastfuncstuff.viewer.colormap import build_lut
from fastfuncstuff.surface import profiles as surface_profiles

#: Folding base from the original fragment shader: ``0.62 - contrast * fold``
#: with the surface window's default contrast (0.16). The browser then applies
#: the same view-space headlight the GLSL shader uses.
_FOLD_BASE = 0.62
_FOLD_GAIN = 0.16


def _hemis_for(vp, store) -> list[str]:
    requested = [h.strip() for h in str(vp.hemis).split(",") if h.strip()]
    return [h for h in requested if h in store.hemis]


def _positions(session, vp, shape: str | None = None) -> tuple[dict, dict, dict]:
    """World-space positions, faces and model matrices for the hemispheres drawn."""
    store = session.surfaces
    hemis = _hemis_for(vp, store)
    if not hemis:
        raise ValueError("this surface window names no loaded hemisphere")
    raw: dict[str, np.ndarray] = {}
    faces: dict[str, np.ndarray] = {}
    used_shape = shape or vp.shape
    for hemi in hemis:
        h = store.hemis[hemi]
        pos = surface3d.shape_positions(h, used_shape)
        if pos is None:
            if used_shape == "flat":
                raise ValueError(
                    f"{hemi} has no flat patch; load a subject with surf/?h.*.patch.3d "
                    "or choose inflated"
                )
            pos = surface3d.shape_positions(h, "mid")
            assert pos is not None
        raw[hemi] = np.asarray(pos, np.float32)
        faces[hemi] = surface3d.shape_faces(h, used_shape)
    offsets = surface3d.layout_offsets(raw, used_shape, faces)
    laid = {hemi: pos + np.asarray(offsets[hemi], np.float32) for hemi, pos in raw.items()}
    # The hinge pivots on the laid-out medial edge, not on the raw mesh origin:
    # the original window builds models from the same laid-out positions it draws.
    models = surface3d.hemisphere_models(laid, float(vp.split), float(vp.hinge))
    world: dict[str, np.ndarray] = {}
    for hemi, pos in laid.items():
        m = models[hemi]
        world[hemi] = np.asarray(pos @ m[:3, :3].T + m[:3, 3], np.float32)
    return world, faces, models


def mesh_revision(session, vp, shape: str | None = None) -> str:
    store = session.surfaces
    hemis = _hemis_for(vp, store)
    parts = [
        str(store.subject),
        shape or vp.shape,
        f"{float(vp.split):.3f}",
        f"{float(vp.hinge):.3f}",
        ",".join(hemis),
        ",".join(str(store.version.get(h, 0)) for h in hemis),
    ]
    return hashlib.md5("|".join(parts).encode()).hexdigest()[:16]


def _base_shade(session, hemi: str, h, vp) -> np.ndarray:
    n = h.n_vertices
    folding = np.asarray(surface3d.folding_values(h, vp.folding), np.float64)
    shade = np.clip(_FOLD_BASE - _FOLD_GAIN * folding, 0.0, 1.0)
    base = np.zeros((n, 4), np.uint8)
    base[:, :3] = np.clip(np.rint(shade * 255.0), 0, 255).astype(np.uint8)[:, None]
    base[:, 3] = 255
    kind = vp.vertex_map
    if kind:
        annotation = None
        if kind == "annot":
            annotation = session.surfaces.annotation(hemi, session.state.surface_annot)
        mapped = surface3d.vertex_colors(h, kind, annotation=annotation)
        if mapped is not None:
            base = surface3d.over(mapped, base)
    return base


def _overlay_layer(session, vp):
    """The single volume overlay that can be drawn per fragment, or None.

    The CPU path colours each vertex; the browser fragment path needs the values
    themselves, so it only handles one non-label volume overlay with an empty
    vertex map. Anything more elaborate keeps the CPU colour path.
    """
    if getattr(session, "surface_layers", None):
        return None
    if vp.vertex_map:
        return None
    st = session.state
    layers = st.layers.visible_layers()
    base = st.layers.base
    overlays = [ly for ly in layers if base is None or ly.key != base.key]
    if len(overlays) != 1:
        return None
    layer = overlays[0]
    if layer.colour or layer.roi or layer.integer_labels:
        return None
    return layer


def _overlay_values(session, vp, hemi: str, layer) -> tuple[np.ndarray, np.ndarray]:
    """Per-vertex displayed values and threshold statistics for ``layer``."""
    h = session.surfaces.hemis[hemi]
    fractions = surface3d.depth_fractions(tuple(vp.depth), int(vp.samples))
    white = np.asarray(h.states["white"], np.float64)
    pial = np.asarray(h.states.get("pial", h.states["white"]), np.float64)
    areas = session.surfaces.vertex_areas(hemi) if vp.equivolume else (None, None)
    volume = session.volume(layer.key, session.layer_time(layer))
    values = surface_profiles.sample_depths(
        white, pial, volume, layer.affine, fractions,
        white_area=areas[0], pial_area=areas[1],
    )
    if layer.threshold_index is not None:
        stat_volume = session.volume(layer.key, layer.threshold_index)
        stat = surface_profiles.sample_depths(
            white, pial, stat_volume, layer.affine, fractions,
            white_area=areas[0], pial_area=areas[1],
        )
    else:
        stat = values
    reduced, stat_reduced = surface3d.reduce_depth(values, stat, vp.depth_stat)
    reduced = np.asarray(reduced, np.float32)
    stat_reduced = np.asarray(stat_reduced, np.float32)
    valid = np.isfinite(reduced) & np.isfinite(stat_reduced)
    return (
        np.nan_to_num(reduced, nan=0.0, posinf=0.0, neginf=0.0),
        np.nan_to_num(stat_reduced, nan=0.0, posinf=0.0, neginf=0.0),
        valid,
    )


def texture_layer(session, vp):
    """A volume overlay that can use the original per-fragment texture path."""
    layer = _overlay_layer(session, vp)
    if layer is None:
        return None
    if int(vp.samples) != 1 or layer.time_linked:
        return None
    if int(np.prod(layer.shape)) > 4_000_000:
        return None
    return layer


def texture_token(session, vp, layer, data_token: str = "") -> str:
    """Identity of a per-fragment volume texture, for client caching."""
    hemis = _hemis_for(vp, session.surfaces)
    try:
        generation = int(session.store.get(layer.key).generation)
    except Exception:
        generation = 0
    idx = int(session.state.time_index if layer.time_linked else layer.volume_index)
    parts = [
        layer.key, layer.path, str(generation), str(idx), str(layer.threshold_index),
        np.asarray(layer.affine, float).round(8).tobytes().hex(),
        layer.time_detrend, int(bool(layer.time_psc)),
        ",".join(hemis),
        ",".join(str(session.surfaces.version.get(h, 0)) for h in hemis),
        data_token,
    ]
    return hashlib.md5("|".join(str(p) for p in parts).encode()).hexdigest()[:16]


def overlay_token(session, vp, layer, data_token: str = "") -> str:
    """Identity of a per-fragment overlay's vertex data, for client caching."""
    hemis = _hemis_for(vp, session.surfaces)
    parts = [
        layer.key, layer.path, str(layer.volume_index), str(layer.threshold_index),
        f"{float(vp.depth[0]):.6f}", f"{float(vp.depth[1]):.6f}", str(int(vp.samples)),
        vp.depth_stat, "eq" if vp.equivolume else "lin",
        ",".join(hemis),
        ",".join(str(session.surfaces.version.get(h, 0)) for h in hemis),
        str(session.layer_time(layer)), data_token,
    ]
    return hashlib.md5("|".join(parts).encode()).hexdigest()[:16]


def vertex_colors(session, vp, hemi: str) -> tuple[np.ndarray, dict]:
    """``(rgba (V,4), layer note)`` for one hemisphere, as the 3-D window draws it."""
    store = session.surfaces
    h = store.hemis[hemi]
    base = _base_shade(session, hemi, h, vp)

    shown = session.surface_vertex_rgba(hemi)
    if shown is not None:
        rgba, layer = shown
        return surface3d.over(np.asarray(rgba, np.uint8), base), {
            "key": layer.key,
            "name": layer.name,
            "mode": "surface-layer",
        }

    st = session.state
    layers = st.layers.visible_layers()
    base_layer = st.layers.base
    overlays = [ly for ly in layers if base_layer is None or ly.key != base_layer.key]
    layer = overlays[-1] if overlays else None
    if layer is None or layer.colour:
        return base, {"mode": "folding"}
    if layer.roi:
        # Label identities are read nearest -- interpolating a region number invents
        # a region that no voxel holds (the rule viewer/compose.py states for slices).
        from fastfuncstuff.surface.sampling import VolumeSampler

        sampler = VolumeSampler(
            session.volume(layer.key, session.layer_time(layer)), layer.affine, mode="nearest"
        )
        sample_mm = 0.5 * (np.asarray(h.states["white"]) + np.asarray(h.states["pial"]))
        values = sampler(np.asarray(sample_mm, np.float64))
        palette = session.roi_palette(layer.key)
        if palette is None:
            return base, {"mode": "folding"}
        from fastfuncstuff.viewer.colormap import apply_label_colors

        import torch

        rgb, alpha = apply_label_colors(
            torch.as_tensor(np.asarray(values, np.float32)),
            palette,
        )
        rgba = np.zeros((h.n_vertices, 4), np.uint8)
        rgba[:, :3] = np.clip(np.rint(rgb.numpy() * 255), 0, 255).astype(np.uint8)
        rgba[:, 3] = np.clip(np.rint(alpha.numpy() * 255), 0, 255).astype(np.uint8)
        return surface3d.over(rgba, base), {"key": layer.key, "name": layer.name, "mode": "labels"}

    fractions = surface3d.depth_fractions(tuple(vp.depth), int(vp.samples))
    white = np.asarray(h.states["white"], np.float64)
    pial = np.asarray(h.states.get("pial", h.states["white"]), np.float64)
    areas = store.vertex_areas(hemi) if vp.equivolume else (None, None)
    volume = session.volume(layer.key, session.layer_time(layer))
    values = surface_profiles.sample_depths(
        white,
        pial,
        volume,
        layer.affine,
        fractions,
        white_area=areas[0],
        pial_area=areas[1],
    )
    if layer.threshold_index is not None:
        stat_volume = session.volume(layer.key, layer.threshold_index)
        stat = surface_profiles.sample_depths(
            white,
            pial,
            stat_volume,
            layer.affine,
            fractions,
            white_area=areas[0],
            pial_area=areas[1],
        )
    else:
        stat = values
    reduced, stat_reduced = surface3d.reduce_depth(values, stat, vp.depth_stat)
    rgba = surfacelayers.layer_rgba(layer, reduced, stat_reduced)
    return surface3d.over(rgba, base), {"key": layer.key, "name": layer.name, "mode": "volume"}


def _b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr).tobytes()).decode("ascii")


def surface_payload(
    session, vp, *, client_mesh_rev: str | None = None, colors: bool = True,
    shape: str | None = None, fragment: bool = False,
    client_overlay_token: str | None = None, data_token: str = '',
) -> tuple[dict, str]:
    store = session.surfaces
    if not store.hemis:
        raise ValueError("no surfaces loaded; LOAD_SURFACES <subject_dir> first")
    shape = shape or vp.shape
    hemis = _hemis_for(vp, store)
    rev = mesh_revision(session, vp, shape)
    # A colour/threshold change asks for the same geometry: computing positions,
    # layout and normals again cost more than the colours did.
    if client_mesh_rev == rev:
        world, faces = {}, {}
    else:
        world, faces, _models = _positions(session, vp, shape)
    payload: dict = {
        "view": vp.id,
        "meshRev": rev,
        "shape": shape,
        "hemis": list(hemis),
        "split": float(vp.split),
        "hinge": float(vp.hinge),
        "depth": [float(vp.depth[0]), float(vp.depth[1])],
        "samples": int(vp.samples),
        "depthStat": vp.depth_stat,
        "equivolume": bool(vp.equivolume),
        "crosshairMm": list(session.state.crosshair_mm) if session.state.crosshair_mm else None,
        "picking": {"model": "server"},
    }
    use_texture = texture_layer(session, vp) if fragment else None
    if client_mesh_rev != rev:
        hemis_out = []
        for hemi, pos in world.items():
            entry = {
                "hemi": hemi,
                "positions": _b64(pos.astype("<f4")),
                "faces": _b64(np.asarray(faces[hemi], "<u4")),
            }
            if use_texture is not None:
                h = store.hemis[hemi]
                entry["white"] = _b64(np.asarray(h.states["white"], np.float32))
                entry["pial"] = _b64(np.asarray(h.states.get("pial", h.states["white"]), np.float32))
                aw, ap = store.vertex_areas(hemi)
                entry["areas"] = _b64(np.stack([aw, ap], axis=1).astype(np.float32))
            hemis_out.append(entry)
        allp = np.concatenate(list(world.values()), axis=0)
        payload["mesh"] = {
            "hemis": hemis_out,
            "bounds": {"min": allp.min(axis=0).tolist(), "max": allp.max(axis=0).tolist()},
        }
    color_payload = []
    layer_note = {"mode": "folding"}
    if colors:
        overlay_layer = use_texture
        if overlay_layer is not None:
            token = texture_token(session, vp, overlay_layer, data_token)
            idx = int(session.state.time_index if overlay_layer.time_linked else overlay_layer.volume_index)
            value = surface3d.texture_data(
                np.asarray(session.shown_volume(overlay_layer.key, idx), np.float32)
            )
            stat = None
            if overlay_layer.threshold_index is not None and int(overlay_layer.threshold_index) != idx:
                stat = surface3d.texture_data(
                    np.asarray(session.volume(overlay_layer.key, int(overlay_layer.threshold_index)), np.float32)
                )
            frame = surface3d.texture_from_mm(overlay_layer.shape, np.asarray(overlay_layer.affine, np.float64))
            lut = build_lut(
                overlay_layer.colormap, 256, reverse=bool(overlay_layer.colormap_reversed)
            ).detach().cpu().numpy()
            lut_u8 = np.clip(np.rint(np.asarray(lut, np.float64) * 255.0), 0, 255).astype(np.uint8)
            fragment_payload = {
                "mode": "texture",
                "token": token,
                "lo": float(overlay_layer.range_lo if overlay_layer.range_lo is not None else 0.0),
                "hi": float(overlay_layer.range_hi if overlay_layer.range_hi is not None else 1.0),
                "threshold": float(overlay_layer.threshold or 0.0),
                "opacity": float(overlay_layer.opacity),
                "sign": {"both": 0, "pos": 1, "neg": 2}.get(
                    str(overlay_layer.sign_mode.value), 0
                ),
                "alpha": {"off": 0, "linear": 1, "quadratic": 2}.get(
                    str(overlay_layer.alpha_mode.value), 0
                ),
                "nPanes": int(overlay_layer.n_panes),
                "layerKey": overlay_layer.key,
                "lut": _b64(np.ascontiguousarray(lut_u8[:, :3])),
                "dims": [int(v) for v in overlay_layer.shape],
                "texFromMm": np.asarray(frame, float).tolist(),
                "statFromMm": None if stat is None else np.asarray(frame, float).tolist(),
                "depth": float(vp.depth[0]),
                "equivolume": bool(vp.equivolume),
                "hasStat": stat is not None,
            }
            if client_overlay_token != token:
                fragment_payload["value"] = _b64(value)
                if stat is not None:
                    fragment_payload["stat"] = _b64(stat)
            payload["fragment"] = fragment_payload
            for hemi in hemis:
                base = _base_shade(session, hemi, session.surfaces.hemis[hemi], vp)
                color_payload.append({"hemi": hemi, "rgba": _b64(base)})
            layer_note = {"mode": "fragment", "key": overlay_layer.key, "name": overlay_layer.name}
        else:
            for hemi in hemis:
                rgba, note = vertex_colors(session, vp, hemi)
                color_payload.append({"hemi": hemi, "rgba": _b64(np.asarray(rgba, np.uint8))})
                layer_note = note
    payload["colors"] = color_payload
    payload["layer"] = layer_note
    return payload, rev


def pick_surface(
    session,
    vp,
    *,
    x_ndc: float,
    y_ndc: float,
    aspect: float,
    camera: dict,
) -> dict:
    """Ray-pick a vertex with FFS's own Moller-Trumbore picker."""
    world, faces, _models = _positions(session, vp)
    cam = surface3d.Camera()
    rotation = np.asarray(camera.get("rotation", np.eye(3).ravel()), np.float64).reshape(3, 3)
    cam.rotation = rotation
    cam.distance = float(camera.get("distance", 350.0))
    cam.target = np.asarray(camera.get("target", [0.0, 0.0, 0.0]), np.float64)
    cam.fov_deg = float(camera.get("fovDeg", 30.0))
    origin, direction = cam.ray(float(x_ndc), float(y_ndc), float(aspect))
    best: tuple[float, str, int, np.ndarray, np.ndarray, np.ndarray] | None = None
    for hemi, positions in world.items():
        hit = surface3d.pick(origin, direction, positions, np.asarray(faces[hemi], np.int64))
        if hit is None:
            continue
        face, bary, dist = hit
        if best is None or dist < best[0]:
            corner = int(np.argmax(bary))
            corners = np.asarray(faces[hemi], np.int64)[face]
            vertex = int(corners[corner])
            # ``pick_mm`` in the original window: the scanner-mm point under the
            # cursor at the sampled cortical depth, not the displayed vertex
            # (layout offsets and split/hinge are display-only).
            h = session.surfaces.hemis[hemi]
            depth = 0.5 * (float(vp.depth[0]) + float(vp.depth[1]))
            d = np.full(3, depth)
            if vp.equivolume:
                white_area, pial_area = session.surfaces.vertex_areas(hemi)
                d = surface3d.equivolume_fraction(
                    d, white_area[corners], pial_area[corners]
                )
            white = np.asarray(h.states["white"][corners], np.float64)
            pial = np.asarray(h.states.get("pial", h.states["white"])[corners], np.float64)
            point = (1.0 - d[:, None]) * white + d[:, None] * pial
            mm = bary @ point
            best = (dist, hemi, vertex, mm, bary, corners)
    if best is None:
        raise ValueError("no surface under that point")
    dist, hemi, vertex, mm, bary, corners = best
    return {
        "hemi": hemi,
        "vertex": vertex,
        "mm": [float(mm[0]), float(mm[1]), float(mm[2])],
        "distance": float(dist),
        "barycentric": [float(x) for x in bary],
        "face": [int(v) for v in corners],
    }
